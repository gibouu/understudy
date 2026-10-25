/**
 * Set up a world from a task spec, then run a compiled Program in it.
 *
 *   environment(spec, scenario?)  the MJCF pieces, the gravity and what the
 *                                 program is told about object poses: in
 *                                 sensed mode the true (perturbed) poses, in
 *                                 blind mode the nominal ones
 *   run(sim, env, program, mode)  a generator: it sets the actuators and
 *                                 yields once per physics step, the caller
 *                                 steps (mj_step) between yields, so a test
 *                                 drains it at full speed and the worker
 *                                 paces it in real time
 *
 * Nothing here names a task: objects are spec ids, targets are frames.
 * move_to aims the point between the pads, or once something is held the
 * held object's centre (heldframe), so a program says where the object goes.
 */
import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import type { Mode, Predicate, Program, Scenario, TaskSpec } from "@/lib/spec/schema";
import { attach, detach, GRASP_TIMEOUT_S, graspIndex, holding, isAttached, type Grasp } from "./grasp";
import { solveIk, type IkResult } from "./ik";
import { toNumbers } from "./names";
import { evaluate } from "./predicates";
import { buildScene, layoutMissingPoses, MM, perturb, type WorldPose } from "./scene";
import { GRIPPER_CLOSED, GRIPPER_OPEN, SO101_GRASP_SITE, SO101_HELD_SITE, SO101_HOME, SO101_JOINT_NAMES } from "./so101";

export type Environment = {
  /** for stageXml */
  worldbody: string;
  graspable: string[];
  gravity_g: number;
  /** the spec as built (laid out, perturbed): what the predicates measure against */
  spec: TaskSpec;
  names: Record<string, string>;
  /** object frames the program is given, per mode */
  beliefs: Record<Mode, Record<string, WorldPose>>;
  warnings: string[];
};

export type Sim = { mujoco: MainModule; model: MjModel; data: MjData };

export type Rollout = {
  pass: boolean;
  failed_step_id?: string;
  failed_predicate?: Predicate;
  failure_class?: "embodiment_limit" | "spec_gap";
  why?: string;
  /** simulated seconds */
  t: number;
  log: string[];
};

/** A step's yield: the object welded to the gripper, if any, for the renderer. */
export type Tick = { held: string | null };

const ARM = 5;
const GRIPPER = SO101_JOINT_NAMES.indexOf("gripper");
/** joint speed of a move, rad/s, and the shortest move */
const JOINT_SPEED = 1.0;
const MIN_MOVE_S = 0.4;
/** a move has arrived once the arm is slower than this, or after SETTLE_S */
const ARRIVED_RAD_S = 0.05;
const SETTLE_S = 1;
const RELEASE_S = 0.3;
const CLOSE_RAD_S = 0.6;
const SQUARE_RAD = (3 * Math.PI) / 180;

export function environment(spec: TaskSpec, scenario?: Scenario): Environment {
  const nominal = buildScene(spec);
  if (!scenario) {
    return {
      worldbody: nominal.worldbody,
      graspable: nominal.manipulated,
      gravity_g: 1,
      spec: layoutMissingPoses(spec).spec,
      names: nominal.names,
      beliefs: { sensed: nominal.frames, blind: nominal.frames },
      warnings: nominal.warnings,
    };
  }
  const p = perturb(spec, scenario);
  const world = buildScene(p.spec, p.tilts);
  return {
    worldbody: world.worldbody,
    graspable: world.manipulated,
    gravity_g: p.gravity_g,
    spec: p.spec,
    names: world.names,
    beliefs: { sensed: world.frames, blind: nominal.frames },
    warnings: [...p.warnings, ...world.warnings],
  };
}

/** `from: "here"` continues from the current state (a single op from /stage); a rollout starts from home. */
export function* run(sim: Sim, env: Environment, program: Program, mode: Mode, { from = "home" }: { from?: "home" | "here" } = {}): Generator<Tick, Rollout> {
  const { mujoco, model, data } = sim;
  const dt = (model.opt as { timestep: number }).timestep;
  const log: string[] = [];
  let t = 0;
  // what is held is the active weld, so it carries over between runs
  let held: Grasp | null = env.graspable.map((b) => graspIndex(mujoco, model, b)).find((g) => isAttached(data, g)) ?? null;
  const ctrl = data.ctrl as Float64Array;
  const qvel = () => Array.from(toNumbers(data.qvel));
  const step = function* () {
    yield { held: held?.body ?? null };
    t += dt;
  };
  const fail = (r: Omit<Rollout, "pass" | "t" | "log">): Rollout => {
    log.push(`fail: ${r.why}`);
    return { pass: false, ...r, t, log };
  };

  /** ramp the arm joints to q, then wait until it has arrived */
  function* moveArm(q: number[]) {
    const from = Array.from(ctrl.slice(0, ARM));
    const span = Math.max(MIN_MOVE_S, Math.max(...q.map((v, i) => Math.abs(v - from[i]))) / JOINT_SPEED);
    for (let s = 0; s < span; s += dt) {
      const u = s / span;
      for (let i = 0; i < ARM; i++) ctrl[i] = from[i] + (q[i] - from[i]) * u;
      yield* step();
    }
    for (let i = 0; i < ARM; i++) ctrl[i] = q[i];
    for (let s = 0; s < SETTLE_S; s += dt) {
      yield* step();
      if (Math.max(...qvel().slice(0, ARM).map(Math.abs)) < ARRIVED_RAD_S) break;
    }
  }

  if (from === "home") {
    // start from home, open, and let the scene settle; nothing stays welded from an earlier run
    if (held) detach(data, held);
    held = null;
    ctrl.set([...SO101_HOME.slice(0, ARM), GRIPPER_OPEN]);
    yield* moveArm(SO101_HOME.slice(0, ARM));
  }

  const beliefs = env.beliefs[mode];
  const world = () => ({ ...sim, spec: env.spec, names: env.names, t });
  for (const s of program.steps) {
    for (const op of s.ops) {
      // a compiled program may name an object the scene lacks: predicates throw, and that is a spec gap, not a crash
      try {
        switch (op.op) {
          case "move_to": {
            const f = op.frame === "world" ? { xyz_m: [0, 0, 0], yaw_rad: 0 } : Object.hasOwn(beliefs, op.frame) ? beliefs[op.frame] : undefined;
            if (!f) return fail({ failed_step_id: s.step_id, failure_class: "spec_gap", why: `move_to: no frame "${op.frame}"` });
            const [x, y, z] = op.offset_mm.map((v) => v * MM);
            const c = Math.cos(f.yaw_rad);
            const sn = Math.sin(f.yaw_rad);
            const target: [number, number, number] = [f.xyz_m[0] + c * x - sn * y, f.xyz_m[1] + sn * x + c * y, f.xyz_m[2] + z];
            const scratch = new mujoco.MjData(model);
            let ik;
            try {
              (scratch.qpos as Float64Array).set(data.qpos as Float64Array);
              const site = held ? SO101_HELD_SITE : SO101_GRASP_SITE;
              ik = solveIk(mujoco, model, scratch, target, op.approach, undefined, site);
              const o = env.spec.objects.find((x) => x.id === op.frame);
              // shortcut: only top-down onto a box is squared; side and front approaches keep the solver's roll
              if (ik.ok && !held && op.approach === "top" && o?.shape === "box") ik = squareTo({ mujoco, model, data: scratch }, ik, target, f.yaw_rad, site);
            } finally {
              scratch.delete();
            }
            const at = `${op.frame} + (${op.offset_mm.join(", ")}) mm from ${op.approach}`;
            if (!ik.ok) return fail({ failed_step_id: s.step_id, failure_class: "embodiment_limit", why: `move_to ${at}: out of reach by ${ik.pos_err_mm.toFixed(1)} mm` });
            log.push(`${t.toFixed(2)} move_to ${at}`);
            yield* moveArm(ik.q);
            break;
          }
          case "grasp": {
            const name = Object.hasOwn(env.names, op.object) ? env.names[op.object] : undefined;
            if (!name || !env.graspable.includes(name)) return fail({ failed_step_id: s.step_id, failure_class: "spec_gap", why: `grasp: "${op.object}" is not a graspable object` });
            if (held) return fail({ failed_step_id: s.step_id, why: `grasp: already holding ${held.body}` });
            const g = graspIndex(mujoco, model, name);
            // close at CLOSE_RAD_S: a jaw slammed shut knocks the object over, and in orbit nothing holds it down
            const open = ctrl[GRIPPER];
            let ok = false;
            for (let w = 0; w < GRASP_TIMEOUT_S && !ok; w += dt) {
              ctrl[GRIPPER] = Math.max(GRIPPER_CLOSED, open - CLOSE_RAD_S * w);
              yield* step();
              ok = holding(mujoco, model, data, g);
            }
            if (ok) {
              ctrl[GRIPPER] = attach(model, data, g); // hold, don't squeeze against the weld
              held = g;
            } else ctrl[GRIPPER] = Math.max(open, GRIPPER_OPEN); // reopen, so a retry can close again
            // a miss is not a failure by itself: the object stays free, and the program's checks find out
            log.push(`${t.toFixed(2)} grasp ${op.object}: ${ok ? "held" : "missed"}`);
            break;
          }
          case "release": {
            let at = "";
            if (held) {
              const p = Array.from(toNumbers(data.xpos)).slice(3 * held.bodyId, 3 * held.bodyId + 3);
              at = ` ${held.body} at (${p.map((v) => (v / MM).toFixed(1)).join(", ")}) mm`;
              detach(data, held);
            }
            held = null;
            ctrl[GRIPPER] = GRIPPER_OPEN;
            log.push(`${t.toFixed(2)} release${at}`);
            for (let w = 0; w < RELEASE_S; w += dt) yield* step();
            break;
          }
          case "wait_until": {
            let c = evaluate(world(), op.predicate);
            for (let w = 0; !c.ok && w < op.timeout_s; w += dt) {
              yield* step();
              c = evaluate(world(), op.predicate);
            }
            log.push(`${t.toFixed(2)} wait_until ${op.predicate.kind}: ${c.why}`);
            if (!c.ok) return fail({ failed_step_id: s.step_id, failed_predicate: op.predicate, why: `timed out after ${op.timeout_s} s: ${c.why}` });
            break;
          }
          case "assert": {
            const c = evaluate(world(), op.predicate);
            log.push(`${t.toFixed(2)} assert ${op.predicate.kind}: ${c.why}`);
            if (!c.ok) return fail({ failed_step_id: s.step_id, failed_predicate: op.predicate, why: c.why });
            break;
          }
          case "ask":
            return fail({ failed_step_id: s.step_id, failure_class: "spec_gap", why: `unanswered: ${op.question}` });
        }
      } catch (err) {
        return fail({ failed_step_id: s.step_id, failure_class: "spec_gap", why: `${op.op}: ${(err as Error).message}` });
      }
    }
  }
  return { pass: true, t, log };
}

/** Drain a run at full speed: what a test or a batch of rollouts does. */
export function runToEnd(sim: Sim, env: Environment, program: Program, mode: Mode, options?: { from?: "home" | "here" }): Rollout {
  const it = run(sim, env, program, mode, options);
  for (let r = it.next(); ; r = it.next()) {
    if (r.done) return r.value;
    sim.mujoco.mj_step(sim.model, sim.data);
  }
}

/**
 * Top-down onto a box: turn the wrist so the jaws close square to its faces, or they meet its corners and tip it.
 * Roll about a vertical tool axis is free, so IK re-solved from the turned seed keeps it.
 */
function squareTo(sim: Sim, ik: IkResult, target: [number, number, number], yaw: number, site: string): IkResult {
  const { mujoco, model, data } = sim;
  const s = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, site);
  // the jaws close along the site's z axis: column 2 of its row-major xmat
  const closing = () => {
    const m = toNumbers(data.site_xmat);
    return Math.atan2(m[9 * s + 5], m[9 * s + 2]);
  };
  const off = (a: number) => {
    const q = Math.PI / 2;
    return ((((yaw - a) % q) + q + q / 2) % q) - q / 2;
  };
  const d = off(closing());
  for (const sign of [1, -1]) {
    const seed = [...ik.q];
    seed[ARM - 1] += sign * d;
    const r = solveIk(mujoco, model, data, target, "top", seed, site);
    if (r.ok && Math.abs(off(closing())) < SQUARE_RAD) return r;
  }
  return ik;
}
