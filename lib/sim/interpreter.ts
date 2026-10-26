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
 * tilt turns the held object about its rim toward a frame (a pour); when the
 * spec holds liquid, `sim.liquid` carries it and the caller that steps MuJoCo
 * also advances the liquid (runToEnd does), so the checks can measure it.
 * follow traces a gesture step's path with the point between the pads and
 * checks each point was reached (lib/sim/gesture.ts); that is all a gesture
 * is checked for.
 */
import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import type { Mode, Predicate, Program, Scenario, TaskSpec } from "@/lib/spec/schema";
import { describeReach, pathMarkersXml, reachCheck, speedText, type Reach, type TraceSample } from "./gesture";
import { attach, detach, GRASP_TIMEOUT_S, graspIndex, holding, isAttached, type Grasp } from "./grasp";
import { solveIk, solvePose, type IkResult } from "./ik";
import { describeLiquid, planLiquid, type Liquid, type LiquidPlan, type LiquidWhere } from "./liquid";
import { toNumbers } from "./names";
import { evaluate } from "./predicates";
import { buildScene, footprintMm, heightMm, layoutMissingPoses, MM, perturb, type WorldPose } from "./scene";
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
  /** the liquid the spec's containers hold, or null */
  liquid: LiquidPlan | null;
  warnings: string[];
};

/** `liquid` is the spec's liquid (a Liquid built from env.liquid on this model), if it has any. */
export type Sim = { mujoco: MainModule; model: MjModel; data: MjData; liquid?: Liquid | null };

export type Rollout = {
  pass: boolean;
  failed_step_id?: string;
  /** index of the failing op within that step */
  failed_op?: number;
  failed_predicate?: Predicate;
  failure_class?: "embodiment_limit" | "spec_gap";
  why?: string;
  /** simulated seconds */
  t: number;
  log: string[];
  /** where each manipulated object was when the rollout ended: what a failure note reports */
  end?: ObjectState[];
  /** where the liquid was when the rollout ended, if the scene has any */
  liquid?: LiquidWhere;
  /** each gesture path the program followed: the only check a gesture has */
  followed?: Followed[];
};

/** `speed`: 1 at the clip's own pace, less when the arm followed slower (FOLLOW_JOINT_RAD_S) */
export type Followed = Reach & { step_id: string; speed: number };

export type ObjectState = {
  object: string;
  /** centre, world frame */
  xyz_mm: [number, number, number];
  speed_mm_s: number;
  held: boolean;
  /** inside_zone against the target of the last step that moves it, when it has one */
  seated?: { target: string; ok: boolean; why: string };
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
/** a pose IK places within this is reached (lib/sim/ik.ts REACH_POS_M) */
const IK_PRECISION_MM = 2;
/**
 * A gesture is played slower than the clip, never faster, when a joint would have to turn faster than this. At it
 * the arm keeps a measured wave within about a millimetre (docs/MEASUREMENTS.md section 11); at 2.9 rad/s, within 5.
 */
const FOLLOW_JOINT_RAD_S = 2;
/** a tilt is solved as a pose every TILT_KEY_S along its path, and played back joint-interpolated */
const TILT_KEY_S = 0.05;
/**
 * A 5-DoF arm keeps the rim's point and the tilt only by turning the pour a little about the vertical: that
 * part of the rotation error weighs this much, and a tilt pose further off than the limits is beyond the arm.
 */
const TILT_YAW_WEIGHT = 0.1;
const TILT_POS_MM = 5;
const TILT_DEG = 3;
const TILT_TURN_DEG = 30;
/** a held object tilted less than this counts as upright when a tilt starts */
const TILT_UPRIGHT_DEG = 3;
/** past this, a tilt found without a record cannot tell which rim the object turned over */
const TILT_GUESS_MAX_DEG = 150;
/** a held site further than this from the path of the kept tilt, or turned further from it, is no longer on it (a tilt turns up to ~11° aside) */
const TILT_PATH_MM = 15;
const TILT_PATH_DEG = 20;
/** the cosine ease of a tilt, as the measured pours used (docs/MEASUREMENTS.md section 5) */
const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : (1 - Math.cos(Math.PI * u)) / 2);

export function environment(spec: TaskSpec, scenario?: Scenario): Environment {
  const nominal = buildScene(spec);
  // the gesture paths, drawn on the stage; nothing touches them
  const markers = pathMarkersXml(spec.steps.flatMap((s) => (s.verb === "gesture" && s.gesture ? [s.gesture.path] : [])));
  if (!scenario) {
    const laid = layoutMissingPoses(spec).spec;
    const liquid = planLiquid(laid, nominal);
    return {
      worldbody: `${nominal.worldbody}\n${markers}`,
      graspable: nominal.manipulated,
      gravity_g: 1,
      spec: laid,
      names: nominal.names,
      beliefs: { sensed: nominal.frames, blind: nominal.frames },
      liquid,
      warnings: [...nominal.warnings, ...(liquid?.warnings ?? [])],
    };
  }
  const p = perturb(spec, scenario);
  const world = buildScene(p.spec, p.tilts);
  const liquid = planLiquid(p.spec, world);
  return {
    worldbody: `${world.worldbody}\n${markers}`,
    graspable: world.manipulated,
    gravity_g: p.gravity_g,
    spec: p.spec,
    names: world.names,
    beliefs: { sensed: world.frames, blind: nominal.frames },
    liquid,
    warnings: [...p.warnings, ...world.warnings, ...(liquid?.warnings ?? [])],
  };
}

/** `from: "here"` continues from the current state (a single op from /stage); a rollout starts from home. */
export function* run(sim: Sim, env: Environment, program: Program, mode: Mode, { from = "home" }: { from?: "home" | "here" } = {}): Generator<Tick, Rollout> {
  const { mujoco, model, data } = sim;
  const dt = (model.opt as { timestep: number }).timestep;
  const log: string[] = [];
  let t = 0;
  let opIndex: number | undefined;
  // what is held is the active weld, so it carries over between runs
  let held: Grasp | null = env.graspable.map((b) => graspIndex(mujoco, model, b)).find((g) => isAttached(data, g)) ?? null;
  const ctrl = data.ctrl as Float64Array;
  const world = () => ({ ...sim, spec: env.spec, names: env.names, t });
  const qvel = () => Array.from(toNumbers(data.qvel));
  const step = function* () {
    yield { held: held?.body ?? null };
    t += dt;
  };
  /** where the liquid is now, logged as it is returned */
  const liquidNow = (): Pick<Rollout, "liquid"> => {
    if (!sim.liquid) return {};
    const where = sim.liquid.where(data);
    const g = -toNumbers((model.opt as { gravity: unknown }).gravity)[2];
    log.push(`${t.toFixed(2)} ${describeLiquid(where, (id) => env.spec.objects.find((o) => o.id === id)?.name ?? id, g)}`);
    return { liquid: where };
  };
  const followed: Followed[] = [];
  const fail = (r: Omit<Rollout, "pass" | "t" | "log">): Rollout => {
    log.push(`fail: ${r.why}`);
    return { pass: false, ...(r.failed_step_id !== undefined && opIndex !== undefined ? { failed_op: opIndex } : {}), ...r, t, log, end: snapshot(sim, env, world(), held), ...liquidNow(), ...(followed.length ? { followed } : {}) };
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
    yield* settle();
  }

  /** wait until the arm has arrived, at most SETTLE_S */
  function* settle() {
    for (let s = 0; s < SETTLE_S; s += dt) {
      yield* step();
      if (Math.max(...qvel().slice(0, ARM).map(Math.abs)) < ARRIVED_RAD_S) break;
    }
  }

  // a tilt lasts as long as the grasp, across runs (a program continued from here), like the weld itself
  let tilted: Tilt | null = held && kept.get(data)?.body === held.body ? kept.get(data)! : null;
  const setTilted = (v: Tilt | null) => {
    tilted = v;
    if (v) kept.set(data, v);
    else kept.delete(data);
  };
  // half a pour anywhere in the spec (its verb without its block, its block on another verb, or into itself) has no
  // liquid to check: validateSpec calls it an error, and no rehearsal of that spec passes, whatever the program covers
  for (const x of env.spec.steps) {
    const half = halfPour(x);
    if (half) return fail({ failed_step_id: x.id, failure_class: "spec_gap", why: half });
  }

  if (from === "home") {
    // start from home, open, and let the scene settle; nothing stays welded from an earlier run
    if (held) detach(data, held);
    held = null;
    setTilted(null);
    ctrl.set([...SO101_HOME.slice(0, ARM), GRIPPER_OPEN]);
    yield* moveArm(SO101_HOME.slice(0, ARM));
  }

  const beliefs = env.beliefs[mode];
  for (const s of program.steps) {
    for (const [i, op] of s.ops.entries()) {
      opIndex = i;
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
              // top-down boxes are squared; side and front approaches roll the wrist so the jaws close across the
              // object, level, or keep a held object upright
              if (ik.ok && op.approach !== "top") {
                const sq = { mujoco, model, data: scratch };
                if (held) {
                  // the held object's up, in the held site's frame: the weld keeps it, scratch kinematics would not
                  const Rs = vec(data.site_xmat, mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, site), 9);
                  const Rb = vec(data.xmat, held.bodyId, 9);
                  const up = [0, 1, 2].map((c) => Rs[c] * Rb[2] + Rs[3 + c] * Rb[5] + Rs[6 + c] * Rb[8]) as Vec3;
                  ik = rollTo(sq, ik, target, op.approach, site, up, 0);
                }
                else if (env.spec.objects.some((x) => x.id === op.frame && x.shape !== "sphere")) {
                  // the side to close from: the one that leaves the wrist room to turn the way the program next tilts
                  const next = program.steps.slice(program.steps.indexOf(s)).flatMap((x) => (x === s ? x.ops.slice(i + 1) : x.ops)).find((x) => x.op === "tilt");
                  const goal = next?.op === "tilt" && next.toward && Object.hasOwn(beliefs, next.toward) ? beliefs[next.toward].xyz_m : undefined;
                  const d: Vec3 = goal ? [goal[0] - f.xyz_m[0], goal[1] - f.xyz_m[1], 0] : [0, 0, 0];
                  ik = rollTo(sq, ik, target, op.approach, site, "level", Math.hypot(d[0], d[1]) > 0.005 ? cross([0, 0, 1], unit(d)) : 0);
                }
              }
              if (ik.ok && op.approach === "top") {
                const sq = { mujoco, model, data: scratch };
                if (held) {
                  // turn the held box to the target frame's yaw: the jaws keep the angle they gripped it at
                  const o = env.spec.objects.find((x) => env.names[x.id] === held!.body);
                  if (o?.shape === "box") ik = squareTo(sq, ik, target, f.yaw_rad - (yawOf(data.xmat, held.bodyId) - closingYaw(sim, site)), quarterTurns(o.size_mm), site);
                } else {
                  const o = env.spec.objects.find((x) => x.id === op.frame);
                  // the jaws close across a box's narrower side, so a strip is pinched on its faces, not its edges
                  if (o?.shape === "box") ik = squareTo(sq, ik, target, f.yaw_rad + (quarterTurns(o.size_mm) || o.size_mm[0] < o.size_mm[1] ? 0 : Math.PI / 2), quarterTurns(o.size_mm), site);
                }
              }
            } finally {
              scratch.delete();
            }
            const at = `${op.frame} + (${op.offset_mm.join(", ")}) mm from ${op.approach}`;
            if (!ik.ok) return fail({ failed_step_id: s.step_id, failure_class: "embodiment_limit", why: `move_to ${at}: out of reach by ${ik.pos_err_mm.toFixed(1)} mm` });
            log.push(`${t.toFixed(2)} move_to ${at}${tilted ? `, turning the ${held?.body ?? "object"} back to the approach` : ""}`);
            setTilted(null); // the approach sets the gripper's orientation again
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
              setTilted(null);
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
            setTilted(null);
            ctrl[GRIPPER] = GRIPPER_OPEN;
            log.push(`${t.toFixed(2)} release${at}`);
            for (let w = 0; w < RELEASE_S; w += dt) yield* step();
            break;
          }
          case "tilt": {
            if (!held) return fail({ failed_step_id: s.step_id, why: "tilt: nothing is held" });
            const h = held;
            const site = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, SO101_HELD_SITE);
            const goalOf = (frame: string) => (frame === "world" ? [0, 0, 0] : Object.hasOwn(beliefs, frame) ? beliefs[frame].xyz_m : undefined);
            if (op.toward !== undefined && !goalOf(op.toward)) return fail({ failed_step_id: s.step_id, failure_class: "spec_gap", why: `tilt: no frame "${op.toward}"` });
            // poses from a fresh kinematics pass: a grasp just moved the held site onto the object
            const scratch = new mujoco.MjData(model);
            const keys: number[][] = [];
            let turned = 0;
            const n = Math.max(2, Math.ceil(op.seconds / TILT_KEY_S));
            let tl: Tilt | null = tilted;
            try {
              (scratch.qpos as Float64Array).set(data.qpos as Float64Array);
              mujoco.mj_kinematics(model, scratch);
              // the record is written as a tilt starts, so a run stopped half way leaves the right path and the
              // wrong angle: the angle is read off the object, the path kept if the held site still lies on it
              if (tl) {
                const now = (Math.acos(Math.max(-1, Math.min(1, vec(scratch.xmat, h.bodyId, 9)[8]))) * 180) / Math.PI;
                const R = rotation(tl.axis, (now * Math.PI) / 180);
                const rel = tl.site0.map((v, r) => v - tl!.pivot[r]);
                const on = [0, 1, 2].map((r) => tl!.pivot[r] + R[3 * r] * rel[0] + R[3 * r + 1] * rel[1] + R[3 * r + 2] * rel[2]);
                const off = Math.hypot(...on.map((v, r) => v - vec(scratch.site_xpos, site, 3)[r])) / MM;
                // and turned as the path has it at that angle: the same point leaning the other way is not on it
                const want = matmul(R, tl.rot0);
                const got = vec(scratch.site_xmat, site, 9);
                const trace = [0, 1, 2].reduce((sum, c) => sum + want[c] * got[c] + want[3 + c] * got[3 + c] + want[6 + c] * got[6 + c], 0);
                const turnedBy = (Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * 180) / Math.PI;
                if (off > TILT_PATH_MM || turnedBy > TILT_PATH_DEG) {
                  log.push(`${t.toFixed(2)} tilt: ${h.body} is ${off.toFixed(0)} mm and ${turnedBy.toFixed(0)}° off the path of its last tilt; starting from where it is`);
                  tl = null;
                } else {
                  // from where it is: a tilt ends a degree or two off, and one stopped half way much further
                  if (Math.abs(now - tl.deg) > TILT_UPRIGHT_DEG) log.push(`${t.toFixed(2)} tilt: ${h.body} stopped at ${now.toFixed(0)}° of a tilt to ${tl.deg}°; carrying on from there`);
                  tl = { ...tl, deg: now };
                }
              }
              if (!tl) {
                const o = env.spec.objects.find((x) => env.names[x.id] === h.body);
                if (!o) return fail({ failed_step_id: s.step_id, failure_class: "spec_gap", why: `tilt: ${h.body} is not in the spec` });
                const c0 = vec(scratch.xpos, h.bodyId, 3);
                const R0 = vec(scratch.xmat, h.bodyId, 9);
                // tipped with no tilt of this grasp to say how (knocked, or turned in another world): start from
                // where it is, about its rim on the side it leans to; upright: toward the frame's origin, with none
                // (or right above it) away from the robot
                const up: Vec3 = [R0[2], R0[5], R0[8]];
                const tipped = (Math.acos(Math.max(-1, Math.min(1, up[2]))) * 180) / Math.PI;
                const leaning = tipped > TILT_UPRIGHT_DEG;
                if (tipped > TILT_GUESS_MAX_DEG) {
                  // turned over about one rim looks the same as about another plus a turn: there is no rim to undo it about
                  return fail({ failed_step_id: s.step_id, why: `tilt: the ${h.body} is upside down (${tipped.toFixed(0)}°) and no tilt of this grasp says which rim it turned over` });
                }
                if (!leaning && op.deg === 0) {
                  log.push(`${t.toFixed(2)} tilt 0°: ${h.body} is already upright`);
                  break;
                }
                const goal = op.toward === undefined ? undefined : goalOf(op.toward)!;
                let d: Vec3 = leaning ? [up[0], up[1], 0] : goal ? [goal[0] - c0[0], goal[1] - c0[1], 0] : [0, 0, 0];
                if (Math.hypot(d[0], d[1]) < 0.005) d = [c0[0], c0[1], 0];
                d = unit(d);
                const axis = unit(cross([0, 0, 1], d));
                // the tilt it already has, undone: the side it leans to is found on the object as it stood upright
                // (past 90° the tipped frame's horizontal points to the opposite rim)
                const back = rotation(axis, leaning ? (-tipped * Math.PI) / 180 : 0);
                const Rup = matmul(back, R0);
                // the rim point on that side: where the line from the centre along d (in the object's frame) leaves the top face
                const [hx, hy] = footprintMm(o).map((v) => (v * MM) / 2);
                const hz = (heightMm(o) * MM) / 2;
                const dl = unit([Rup[0] * d[0] + Rup[3] * d[1], Rup[1] * d[0] + Rup[4] * d[1], 0]);
                const k = Math.min(Math.abs(dl[0]) > 1e-9 ? hx / Math.abs(dl[0]) : Infinity, Math.abs(dl[1]) > 1e-9 ? hy / Math.abs(dl[1]) : Infinity);
                const lip = [dl[0] * k, dl[1] * k, hz];
                const pivot: Vec3 = [0, 1, 2].map((r) => c0[r] + R0[3 * r] * lip[0] + R0[3 * r + 1] * lip[1] + R0[3 * r + 2] * lip[2]) as Vec3;
                // the held site's pose upright: undone about the pivot
                const now = vec(scratch.site_xpos, site, 3).map((v, r) => v - pivot[r]) as Vec3;
                const site0 = [0, 1, 2].map((r) => pivot[r] + back[3 * r] * now[0] + back[3 * r + 1] * now[1] + back[3 * r + 2] * now[2]) as Vec3;
                tl = { body: h.body, site0, rot0: matmul(back, vec(scratch.site_xmat, site, 9)), pivot, axis, deg: leaning ? tipped : 0, toward: leaning ? "the side it leans to" : (op.toward ?? "away from the robot"), frame: leaning ? undefined : op.toward };
                if (leaning) log.push(`${t.toFixed(2)} tilt: ${h.body} is already tipped ${tipped.toFixed(0)}°; carrying on from there, about its lower rim`);
              }
              // a tilt turns about the rim it started from: tipping toward somewhere else needs the object upright first
              if (op.deg > 0 && op.toward !== undefined && tl.deg > 0 && op.toward !== tl.frame) {
                const goal = goalOf(op.toward)!;
                const lean = cross(tl.axis, [0, 0, 1]);
                const to: Vec3 = [goal[0] - tl.pivot[0], goal[1] - tl.pivot[1], 0];
                if (tl.frame !== undefined || (Math.hypot(to[0], to[1]) > 0.005 && dot3(lean, unit(to)) < Math.cos(Math.PI / 4))) {
                  return fail({ failed_step_id: s.step_id, why: `tilt toward ${op.toward}: the ${h.body} is tipped toward ${tl.toward}; turn it upright first (tilt 0)` });
                }
              }
              const { site0, rot0, pivot, axis, deg: from, toward } = tl;
              // the held site's pose along the path, solved every TILT_KEY_S from where the arm is now
              let seed = Array.from(toNumbers(data.qpos)).slice(0, ARM);
              const roll = SO101_JOINT_NAMES.indexOf("wrist_roll");
              const rollJoint = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, "wrist_roll");
              let prev = from;
              for (let j = 0; j <= n; j++) {
                const deg = from + (op.deg - from) * ease(j / n);
                // seed the wrist roll with the part of this turn about its own axis: the solver then stays on the
                // roll instead of drifting into a pitch that flips the arm over further on
                (scratch.qpos as Float64Array).set(seed, 0);
                mujoco.mj_kinematics(model, scratch);
                seed = [...seed];
                seed[roll] += (((deg - prev) * Math.PI) / 180) * dot3(axis, vec(scratch.xaxis, rollJoint, 3) as Vec3);
                prev = deg;
                const R = rotation(axis, (deg * Math.PI) / 180);
                const rel = site0.map((v, r) => v - pivot[r]) as Vec3;
                const pos = [0, 1, 2].map((r) => pivot[r] + R[3 * r] * rel[0] + R[3 * r + 1] * rel[1] + R[3 * r + 2] * rel[2]) as Vec3;
                const r = solvePose(mujoco, model, scratch, SO101_HELD_SITE, pos, matmul(R, rot0), seed, { yaw: TILT_YAW_WEIGHT });
                turned = Math.max(turned, r.turned_deg);
                if (r.pos_err_mm > TILT_POS_MM || r.tilt_err_deg > TILT_DEG || r.turned_deg > TILT_TURN_DEG) {
                  return fail({
                    failed_step_id: s.step_id,
                    failure_class: "embodiment_limit",
                    why: `tilt ${op.deg}° toward ${toward}: the arm cannot hold the ${h.body} at ${deg.toFixed(0)}° about its rim (off by ${r.pos_err_mm.toFixed(0)} mm, ${r.tilt_err_deg.toFixed(0)}° in tilt, turned ${r.turned_deg.toFixed(0)}° aside)`,
                  });
                }
                keys.push(r.q);
                seed = r.q;
              }
            } finally {
              scratch.delete();
            }
            setTilted({ ...tl!, deg: op.deg }); // the path, should the run stop on the way
            for (let w = 0; w < op.seconds; w += dt) {
              const f = (w / op.seconds) * n;
              const j = Math.min(n - 1, Math.floor(f));
              for (let i = 0; i < ARM; i++) ctrl[i] = keys[j][i] + (keys[j + 1][i] - keys[j][i]) * (f - j);
              yield* step();
            }
            for (let i = 0; i < ARM; i++) ctrl[i] = keys[n][i];
            yield* settle();
            const R = vec(data.xmat, h.bodyId, 9);
            log.push(`${t.toFixed(2)} tilt ${h.body} to ${op.deg}° toward ${tl!.toward} over ${op.seconds} s: ${((Math.acos(Math.max(-1, Math.min(1, R[8]))) * 180) / Math.PI).toFixed(0)}° from upright, turned up to ${turned.toFixed(0)}° aside`);
            setTilted(op.deg === 0 ? null : { ...tl!, deg: op.deg });
            break;
          }
          case "follow": {
            const gestureStep = env.spec.steps.find((x) => x.id === s.step_id);
            const g = gestureStep?.verb === "gesture" ? gestureStep.gesture : undefined;
            if (!g) return fail({ failed_step_id: s.step_id, failure_class: "spec_gap", why: `follow: step ${s.step_id} is not a gesture with a path` });
            const path = g.path;
            if (path.length < 2) return fail({ failed_step_id: s.step_id, failure_class: "spec_gap", why: `follow: the gesture of step ${s.step_id} has no path yet (it is traced from the clip)` });
            // two points at one time would be a jump no speed cap can slow down
            if (path.some((p, k) => k > 0 && p.t_s <= path[k - 1].t_s)) return fail({ failed_step_id: s.step_id, failure_class: "spec_gap", why: `follow: the path of step ${s.step_id} does not move forward in time` });
            const site = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, SO101_GRASP_SITE);
            // every point solved before the arm moves: the first from a front approach, the rest from the one
            // before, keeping its tilt (yaw left free), so consecutive poses stay on one branch of the arm; where
            // that tilt cannot be kept at the point (low in the box), a front approach from the same seed is tried
            const keys: number[][] = [];
            let off = { i: 0, mm: 0 };
            const scratch = new mujoco.MjData(model);
            try {
              (scratch.qpos as Float64Array).set(data.qpos as Float64Array);
              const at = (k: number) => path[k].xyz_mm.map((v) => v * MM) as [number, number, number];
              const first = solveIk(mujoco, model, scratch, at(0), "front", undefined, SO101_GRASP_SITE);
              const rot0 = vec(scratch.site_xmat, site, 9);
              keys.push(first.q);
              off = { i: 0, mm: first.pos_err_mm };
              for (let k = 1; k < path.length; k++) {
                let r: { q: number[]; pos_err_mm: number } = solvePose(mujoco, model, scratch, SO101_GRASP_SITE, at(k), rot0, keys[k - 1], { yaw: 0 });
                if (r.pos_err_mm > IK_PRECISION_MM) {
                  const front = solveIk(mujoco, model, scratch, at(k), "front", keys[k - 1], SO101_GRASP_SITE);
                  if (front.pos_err_mm < r.pos_err_mm) r = front;
                }
                keys.push(r.q);
                if (r.pos_err_mm > off.mm) off = { i: k, mm: r.pos_err_mm };
              }
            } finally {
              scratch.delete();
            }
            // within the solver's own precision a pose is reached; a tighter tolerance is left to the trace to judge
            if (off.mm > Math.max(g.reach_mm, IK_PRECISION_MM)) {
              return fail({ failed_step_id: s.step_id, failure_class: "embodiment_limit", why: `follow: point ${off.i + 1} of ${path.length} is out of the arm's reach by ${off.mm.toFixed(1)} mm (the limit is ${g.reach_mm} mm)` });
            }
            // the speed each step between two points asks for, however short the step (time moves forward, checked above)
            const peak = Math.max(0, ...keys.slice(1).map((q, k) => Math.max(...q.map((v, j) => Math.abs(v - keys[k][j]))) / (path[k + 1].t_s - path[k].t_s)));
            const stretch = Math.max(1, peak / FOLLOW_JOINT_RAD_S);
            const timed = path.map((p) => ({ ...p, t_s: p.t_s * stretch }));
            log.push(`${t.toFixed(2)} follow ${path.length} points over ${timed.at(-1)!.t_s.toFixed(1)} s, ${stretch > 1 ? `at ${speedText(1 / stretch)}x the clip's speed: at its own a joint would turn at ${peak.toFixed(1)} rad/s, and the arm is held to ${FOLLOW_JOINT_RAD_S}` : `joints up to ${peak.toFixed(1)} rad/s`}`);
            yield* moveArm(keys[0]);
            const trace: TraceSample[] = [];
            const record = () => trace.push({ t_s: t, xyz_mm: vec(data.site_xpos, site, 3).map((v) => v / MM) as [number, number, number] });
            const start = t;
            // the joints interpolated between the points' poses, on the clip's timing (slowed down if it had to be)
            let j = 0;
            for (let w = 0; w < timed.at(-1)!.t_s; w += dt) {
              while (j < timed.length - 2 && timed[j + 1].t_s <= w) j++;
              const span = timed[j + 1].t_s - timed[j].t_s;
              const u = span > 0 ? Math.min(1, Math.max(0, (w - timed[j].t_s) / span)) : 1;
              for (let i = 0; i < ARM; i++) ctrl[i] = keys[j][i] + (keys[j + 1][i] - keys[j][i]) * u;
              yield* step();
              record();
            }
            for (let i = 0; i < ARM; i++) ctrl[i] = keys.at(-1)![i];
            for (let w = 0; w < SETTLE_S; w += dt) {
              yield* step();
              record();
              if (Math.max(...qvel().slice(0, ARM).map(Math.abs)) < ARRIVED_RAD_S) break;
            }
            const f: Followed = { step_id: s.step_id, speed: Number((1 / stretch).toPrecision(2)), ...reachCheck(timed, trace, g.reach_mm, start) };
            followed.push(f);
            log.push(`${t.toFixed(2)} follow: ${describeReach(f)}`);
            if (f.missed.length) return fail({ failed_step_id: s.step_id, failure_class: "embodiment_limit", why: `follow: ${describeReach(f)}` });
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
  return { pass: true, t, log, end: snapshot(sim, env, world(), held), ...liquidNow(), ...(followed.length ? { followed } : {}) };
}

/** Measured, never inferred: position, speed and seating of every manipulated object. A check that throws is left out. */
function snapshot(sim: Sim, env: Environment, w: Parameters<typeof evaluate>[0], held: Grasp | null): ObjectState[] {
  const { mujoco, model, data } = sim;
  const xpos = toNumbers(data.xpos);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return env.spec.objects
    .filter((o) => o.role === "manipulated" && Object.hasOwn(env.names, o.id))
    .flatMap((o): ObjectState[] => {
      try {
        const id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, env.names[o.id]);
        if (id < 0) return [];
        const target = env.spec.steps.findLast((s) => s.object === o.id && s.target && s.target.frame !== "world")?.target?.frame;
        const seated = target === undefined ? undefined : evaluate(w, { kind: "inside_zone", object: o.id, target });
        return [
          {
            object: o.id,
            xyz_mm: [0, 1, 2].map((k) => r1(xpos[3 * id + k] / MM)) as [number, number, number],
            speed_mm_s: r1(evaluate(w, { kind: "object_still", object: o.id }).measured ?? 0),
            held: held?.body === env.names[o.id],
            ...(target && seated ? { seated: { target, ok: seated.ok, why: seated.why } } : {}),
          },
        ];
      } catch {
        return [];
      }
    });
}

/** What is wrong with a step that is half a pour, or null: the run refuses it as validateSpec does. */
function halfPour(step: TaskSpec["steps"][number]): string | null {
  if (step.verb === "pour" && !step.pour) return `step ${step.id} pours but says neither into what nor how far it tilts`;
  if (step.pour && step.verb !== "pour") return `step ${step.id} is a ${step.verb} step with a pour block; only a pour step pours`;
  if (step.pour && step.pour.into === step.object) return `step ${step.id} pours the ${step.object} into itself`;
  return null;
}

/** Drain a run at full speed: what a test or a batch of rollouts does. */
export function runToEnd(sim: Sim, env: Environment, program: Program, mode: Mode, options?: { from?: "home" | "here" }): Rollout {
  const it = run(sim, env, program, mode, options);
  const dt = (sim.model.opt as { timestep: number }).timestep;
  for (let r = it.next(); ; r = it.next()) {
    if (r.done) return r.value;
    sim.mujoco.mj_step(sim.model, sim.data);
    sim.liquid?.advance(sim.model, sim.data, dt);
  }
}

type Vec3 = [number, number, number];
/**
 * A tilt under way: the held site's pose when the object was upright, the pivot (its rim on the side it tips
 * toward) and the horizontal axis it turns about; `deg` is how far it is turned now, `frame` the frame it was
 * tipped toward (none when it was found tipped), `toward` that in words.
 */
type Tilt = { body: string; site0: Vec3; rot0: number[]; pivot: Vec3; axis: Vec3; deg: number; toward: string; frame?: string };
/** the tilt under way per simulation state, kept between runs that continue from here; reset with the grasp */
const kept = new WeakMap<MjData, Tilt>();

/** The arm was driven by hand (the stage's sliders): no kept tilt describes it any more. */
export function forgetTilt(data: MjData) {
  kept.delete(data);
}
const vec = (field: unknown, i: number, n: number) => Array.from(toNumbers(field)).slice(n * i, n * i + n);
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(...a);
  return n > 1e-12 ? [a[0] / n, a[1] / n, a[2] / n] : [1, 0, 0];
};
const matmul = (a: number[], b: number[]) =>
  Array.from({ length: 9 }, (_, k) => {
    const i = Math.floor(k / 3);
    const j = k % 3;
    return a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
  });
/** row-major rotation by `rad` about the unit `axis` (Rodrigues) */
function rotation([x, y, z]: Vec3, rad: number): number[] {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const k = 1 - c;
  return [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
}

/** yaw of a body or site from a row-major xmat array */
const yawOf = (xmat: unknown, i: number) => {
  const m = toNumbers(xmat);
  return Math.atan2(m[9 * i + 3], m[9 * i]);
};

/** the direction the jaws close in, about z: the site's z axis, column 2 of its xmat */
function closingYaw(sim: Sim, site: string): number {
  const m = toNumbers(sim.data.site_xmat);
  const s = sim.mujoco.mj_name2id(sim.model, sim.mujoco.mjtObj.mjOBJ_SITE.value, site);
  return Math.atan2(m[9 * s + 5], m[9 * s + 2]);
}

/**
 * Turn the wrist roll for a side or front approach. "level": the jaws close horizontally (the closing axis, the
 * site's z, has no vertical part); of the two rolls that do it, the one with more room to turn about `tiltAxis`
 * (a world axis a later tilt turns about, or 0 for none) wins, else the one nearer the solver's. A vector
 * instead (a held object's up, in the site's frame): the roll that keeps it as close to vertical as it can.
 * Re-solved from the turned seed; the solver's own roll stands when that fails.
 */
function rollTo(sim: Sim, ik: IkResult, target: [number, number, number], approach: "side" | "front", site: string, aim: "level" | Vec3, tiltAxis: Vec3 | 0): IkResult {
  const { mujoco, model, data } = sim;
  const roll = SO101_JOINT_NAMES.indexOf("wrist_roll");
  const jnt = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, "wrist_roll");
  const [lo, hi] = vec(model.jnt_range, jnt, 2);
  const s = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, site);
  const qpos = data.qpos as Float64Array;
  const measure = (r: number) => {
    qpos[roll] = r;
    mujoco.mj_kinematics(model, data);
    const R = vec(data.site_xmat, s, 9);
    return aim === "level" ? R[8] : R[6] * aim[0] + R[7] * aim[1] + R[8] * aim[2];
  };
  // the measure is c + a cos(r) + b sin(r) in the roll: fit it from three samples
  const r0 = ik.q[roll];
  const m = [0, 1, 2].map((k) => measure(r0 + (2 * Math.PI * k) / 3));
  const c = (m[0] + m[1] + m[2]) / 3;
  const a = (2 / 3) * (m[0] + m[1] * Math.cos((2 * Math.PI) / 3) + m[2] * Math.cos((4 * Math.PI) / 3));
  const b = (2 / 3) * (m[1] * Math.sin((2 * Math.PI) / 3) + m[2] * Math.sin((4 * Math.PI) / 3));
  const phi = r0 + Math.atan2(b, a);
  const off = Math.acos(Math.max(-1, Math.min(1, -c / (Math.hypot(a, b) || 1))));
  const wrap = (r: number) => [r - 2 * Math.PI, r, r + 2 * Math.PI].filter((x) => x >= lo && x <= hi);
  let candidates = aim === "level" ? [...wrap(phi + off), ...wrap(phi - off)] : wrap(phi);
  if (candidates.length === 0) return ik;
  if (aim === "level" && tiltAxis) {
    // which way a tilt about tiltAxis turns the roll joint
    qpos[roll] = r0;
    mujoco.mj_kinematics(model, data);
    const way = Math.sign(dot3(tiltAxis, vec(data.xaxis, jnt, 3) as Vec3));
    const room = (r: number) => (way >= 0 ? hi - r : r - lo);
    candidates = candidates.sort((x, y) => room(y) - room(x));
  } else candidates = candidates.sort((x, y) => Math.abs(x - r0) - Math.abs(y - r0));
  for (const r of candidates) {
    const seed = [...ik.q];
    seed[roll] = r;
    const out = solveIk(mujoco, model, data, target, approach, seed, site);
    if (out.ok && Math.abs(out.q[roll] - r) < SQUARE_RAD * 3) return out;
  }
  return ik;
}

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** a square footprint looks the same every quarter turn; any other box every half turn */
const quarterTurns = (size_mm: number[]) => size_mm[0] === size_mm[1];

/**
 * Top-down onto a box: turn the wrist until the jaws close along `aim` (mod a quarter or half turn),
 * or they meet its corners and tip it. Roll about a vertical tool axis is free, so IK re-solved from
 * the turned seed keeps it.
 */
function squareTo(sim: Sim, ik: IkResult, target: [number, number, number], aim: number, quarter: boolean, site: string): IkResult {
  const { mujoco, model, data } = sim;
  const off = (a: number) => {
    const q = quarter ? Math.PI / 2 : Math.PI;
    return ((((aim - a) % q) + q + q / 2) % q) - q / 2;
  };
  const d = off(closingYaw(sim, site));
  for (const sign of [1, -1]) {
    const seed = [...ik.q];
    seed[ARM - 1] += sign * d;
    const r = solveIk(mujoco, model, data, target, "top", seed, site);
    if (r.ok && Math.abs(off(closingYaw(sim, site))) < SQUARE_RAD) return r;
  }
  return ik;
}
