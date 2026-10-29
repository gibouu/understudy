/**
 * The contact op: a held object applied along a path on a fixed surface (a stand-in), force-limited.
 *
 *   1. to a stand-off STANDOFF_MM out along the surface normal at the path's first point, at the arm's usual speed;
 *   2. in along the normal, at APPROACH_MM_S, and at NEAR_MM_S from SLOW_MM out, until MuJoCo reports a contact
 *      between the held object and the surface pushing at least TOUCH_N (or PRESS_MAX_MM past where the surface
 *      should be with nothing touched: the surface is not where the program was told it is);
 *   3. along the path at PATH_MM_S, with the commanded depth along the normal moved each physics step by the error
 *      between the contact force and a target (TARGET_SHARE of the step's limit): a force loop on position
 *      actuators, the only actuators the SO-101 has; and the commanded point shifted across the path by the
 *      measured distance from the contact to it, integrated (SIDE_GAIN_S). Both loops read the simulator's contact
 *      force and position: a real arm would need a force sensor and a way to see where it touches;
 *   4. off along the normal at the last point, at NEAR_MM_S until SLOW_MM out, then back to the stand-off.
 *
 * Everything that is checked is read from MuJoCo every physics step, never from what was commanded: the normal force
 * of each contact between the held object's geoms and the surface's (mj_contactForce, in the contact frame, so its
 * first component is the normal force), where those contacts are (the force-weighted mean of their positions), any
 * contact between the arm itself and the surface, and how fast the held object's contact point moves along the
 * normal within NEAR_MM of the surface. MuJoCo's contacts are soft: the force is the solver's, from a penetration
 * of a fraction of a millimetre, not a measured force on skin (docs/LIMITATIONS.md).
 *
 * The step passes when the force never went over the step's limit, the arm itself never touched the surface, and
 * coverage_pc of the path's samples (lib/sim/surface.ts) had a contact within reach_mm of them.
 *
 * Nothing here names a task: the surface is a spec object id, its shape a primitive.
 */
import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import type { Step, TaskSpec } from "@/lib/spec/schema";
import type { Grasp } from "./grasp";
import { solvePose } from "./ik";
import { decodeName, toNumbers } from "./names";
import type { WorldPose } from "./scene";
import { NAME_PREFIX } from "./scene";
import { SO101_HELD_SITE } from "./so101";
import { contactMarkersXml, dot, quatToMat, rot, rotT, samplePath, support, type Sample, type Vec3 } from "./surface";

/** Out along the normal, mm, where the approach starts and the retreat ends. */
export const STANDOFF_MM = 30;
/**
 * Within NEAR_MM of the surface (mm) the arm moves at NEAR_MM_S, measured. It slows from SLOW_MM out on the way in and
 * keeps that speed until SLOW_MM out on the way back, as measured or as commanded, whichever is nearer: a position
 * actuator lags its command, so slowing only at NEAR_MM would cross it still fast.
 */
export const NEAR_MM = 15;
export const SLOW_MM = 25;
export const APPROACH_MM_S = 40;
export const NEAR_MM_S = 8;
/** Along the path. */
export const PATH_MM_S = 15;
/** The approach gives up this far past where the surface should be, mm. */
export const PRESS_MAX_MM = 6;
/** A contact counts as touching from this normal force, N. */
export const TOUCH_N = 0.05;
/** The force loop aims at this share of the step's limit. */
export const TARGET_SHARE = 0.5;
/** mm the commanded depth moves per second per newton of force error: about a tenth of a second to settle at 0.6 N/mm. */
const GAIN_MM_S_N = 15;
/**
 * Across the path the commanded point is shifted by the measured distance from the contact to the path, integrated
 * at SIDE_GAIN_S per second, at most SIDE_MAX_MM either way: the position actuators leave the held object a few mm
 * off its target under the contact's own push, and a contact patch is not where the primitive's support point is.
 */
const SIDE_GAIN_S = 4;
const SIDE_MAX_MM = 6;
/** Seconds the arm stays on the path's last point before it retreats. */
const DWELL_S = 0.4;
/** Force readings are smoothed over about this many physics steps before the loop uses them. */
const SMOOTH = 4;
/** Path keys are solved every KEY_MM, at the surface and LIN_MM out, and the depth between them taken as linear. */
const KEY_MM = 2;
const LIN_MM = 2;
/** The approach and retreat lines are solved every LINE_MM along the normal. */
const LINE_MM = 2;
/** a pose IK places within these is reached (as for move_to and tilt) */
const IK_POS_MM = 2;
const IK_TILT_DEG = 3;
const YAW_WEIGHT = 0;
const MM = 0.001;

export type Contacted = {
  step_id: string;
  surface: string;
  /** path samples, SAMPLE_MM apart, and how many had a contact within reach_mm */
  samples: number;
  covered: number;
  /** the share of the path's length (on the surface where MuJoCo has it) whose samples had a contact within reach_mm */
  coverage: number;
  coverage_required: number;
  reach_mm: number;
  force_limit_n: number;
  force_target_n: number;
  /** the largest total normal force of the held object on the surface in any physics step of the op */
  peak_force_n: number;
  /** mean of that force over the steps in contact while following the path */
  mean_force_n: number;
  /** simulated seconds with the held object on the surface (at least TOUCH_N) */
  contact_s: number;
  /** simulated seconds spent following the path */
  follow_s: number;
  /** the fastest the held object's contact point moved along the normal within NEAR_MM of the surface, measured */
  approach_peak_mm_s: number;
  retreat_peak_mm_s: number;
  /** the furthest and the mean distance, mm, from a contact while following to the nearest sample of the path */
  off_path_max_mm: number;
  off_path_mean_mm: number;
  /** the held object's axis from the surface normal at the first point, degrees, as gripped */
  grip_tilt_deg: number;
  /** a body of the arm that touched the surface, if one did */
  arm_touched?: string;
};

export type ContactWorld<T> = {
  mujoco: MainModule;
  model: MjModel;
  data: MjData;
  spec: TaskSpec;
  names: Record<string, string>;
  /** the object frames the program is given (sensed or blind) */
  beliefs: Record<string, WorldPose>;
  held: Grasp;
  ctrl: () => Float64Array;
  /** one physics step */
  step: () => Generator<T, void>;
  now: () => number;
  log: (line: string) => void;
};

export type ContactOutcome = { contacted?: Contacted; fail?: { why: string; failure_class?: "embodiment_limit" | "spec_gap" } };

const ARM = 5;
/** the interpreter's move: joint speed (rad/s), the shortest move (s), arrived below this joint speed (rad/s) or after SETTLE_S */
const JOINT_SPEED = 1.0;
const MIN_MOVE_S = 0.4;
const ARRIVED_RAD_S = 0.05;
const SETTLE_S = 1;

/** What the contact op does for `step`, whose verb is apply and whose contact block names the surface and the path. */
export function* applyAlong<T>(w: ContactWorld<T>, step: Step): Generator<T, ContactOutcome> {
  const { mujoco, model, data } = w;
  const c = step.contact;
  if (step.verb !== "apply" || !c) return { fail: { failure_class: "spec_gap", why: `contact: step ${step.id} is not an apply step with a contact block` } };
  if (c.path.length < 2) return { fail: { failure_class: "spec_gap", why: `contact: the contact path of step ${step.id} has fewer than two points` } };
  const surface = w.spec.objects.find((o) => o.id === c.surface);
  if (!surface || !Object.hasOwn(w.names, c.surface) || !Object.hasOwn(w.beliefs, c.surface)) return { fail: { failure_class: "spec_gap", why: `contact: no surface "${c.surface}" in the scene` } };
  if (surface.role === "manipulated") return { fail: { failure_class: "spec_gap", why: `contact: "${c.surface}" moves; a contact step presses only on an object that does not` } };
  const heldObj = w.spec.objects.find((o) => w.names[o.id] === w.held.body);
  if (!heldObj) return { fail: { failure_class: "spec_gap", why: `contact: ${w.held.body} is not in the spec` } };
  if (heldObj.id !== step.object) return { fail: { why: `contact: step ${step.id} applies the ${step.object}, and the arm holds the ${heldObj.id}` } };

  // the path where the program believes the surface is
  const f = w.beliefs[c.surface];
  let samples: Sample[];
  try {
    samples = samplePath(surface, c.path, f.xyz_m as Vec3, quatToMat(f.quat));
  } catch (err) {
    return { fail: { failure_class: "spec_gap", why: `contact: ${(err as Error).message}` } };
  }

  // indices, before any view: a lookup allocates, which can grow the wasm heap and detach a view taken before it
  const siteId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, SO101_HELD_SITE);
  const surfaceBody = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, w.names[c.surface]);
  const geomBody = Array.from(toNumbers(model.geom_bodyid));
  const names = Array.from(toNumbers(model.names));
  const bodyAdr = Array.from(toNumbers(model.name_bodyadr));
  const isScene = (b: number) => b === 0 || decodeName(names, bodyAdr[b]).startsWith(NAME_PREFIX);
  // the path where the surface really is, from MuJoCo's own pose of it: what coverage is checked against, so a
  // program told the wrong pose (blind) is judged on the real surface, not on the one it aimed at
  const truth = samplePath(surface, c.path, Array.from(toNumbers(data.xpos)).slice(3 * surfaceBody, 3 * surfaceBody + 3) as Vec3, Array.from(toNumbers(data.xmat)).slice(9 * surfaceBody, 9 * surfaceBody + 9));
  // each sample weighs the length of path it stands for (half of each piece next to it), so coverage is a share of
  // the path's length, whatever its points' spacing or repeats
  const weight = truth.map((x, k) => ((truth[Math.min(truth.length - 1, k + 1)].s_m - x.s_m) + (x.s_m - truth[Math.max(0, k - 1)].s_m)) / 2);
  const totalWeight = weight.reduce((a, b) => a + b, 0);
  const heldGeoms = new Set(w.held.objectGeoms);
  const vec = (field: unknown, i: number, n: number) => Array.from(toNumbers(field)).slice(n * i, n * i + n);

  // where the held object meets a surface of normal n, from the held site, with the grip it has now
  const centre0 = vec(data.xpos, w.held.bodyId, 3) as Vec3;
  const Rh0 = vec(data.xmat, w.held.bodyId, 9);
  const site0 = vec(data.site_xpos, siteId, 3) as Vec3;
  const rot0 = vec(data.site_xmat, siteId, 9);
  // the point of the held object that meets each sample, in the held object's own frame: a fixed point on it, so
  // where it is can be read off the object's measured pose at every step
  const tipLocal: Vec3[] = samples.map(({ normal }) => {
    const p = support(heldObj, centre0, Rh0, [-normal[0], -normal[1], -normal[2]]);
    return rotT(Rh0, [p[0] - centre0[0], p[1] - centre0[1], p[2] - centre0[2]]);
  });
  // across the path at each sample, in the surface's tangent plane: the normal crossed with the path's direction
  const sides: Vec3[] = samples.map((x, k) => {
    const a = samples[Math.max(0, k - 1)].point;
    const b = samples[Math.min(samples.length - 1, k + 1)].point;
    const t: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const n = x.normal;
    const v: Vec3 = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
    const l = Math.hypot(...v);
    return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
  });
  const siteAt = (k: number, depth_m: number, side_m = 0): Vec3 => {
    const { point, normal } = samples[k];
    const r = rot(Rh0, tipLocal[k]);
    // the held site's offset from the object's centre, as gripped
    return [0, 1, 2].map((i) => point[i] + normal[i] * depth_m + sides[k][i] * side_m - r[i] - (centre0[i] - site0[i])) as Vec3;
  };

  // every pose solved before the arm moves: the approach and retreat lines along the normal, the path at the
  // surface and LIN_MM out; each from the one before, keeping the grip's orientation (the compass heading left
  // nearly free: a 5-DoF arm cannot keep it and a point at once)
  const lineDepths: number[] = [];
  for (let d = -PRESS_MAX_MM; d < STANDOFF_MM; d += LINE_MM) lineDepths.push(d * MM);
  lineDepths.push(STANDOFF_MM * MM);
  const keyIdx: number[] = [];
  for (let k = 0; k < samples.length; k++) if (k === 0 || samples[k].s_m - samples[keyIdx.at(-1)!].s_m >= KEY_MM * MM - 1e-9 || k === samples.length - 1) keyIdx.push(k);
  const scratch = new mujoco.MjData(model);
  let first: number[][] = [];
  let last: number[][] = [];
  const at0: number[][] = [];
  const atLin: number[][] = [];
  const atSide: number[][] = [];
  try {
    (scratch.qpos as Float64Array).set(data.qpos as Float64Array);
    let seed = Array.from(toNumbers(data.qpos)).slice(0, ARM);
    const solve = (target: Vec3, what: string) => {
      const r = solvePose(mujoco, model, scratch, SO101_HELD_SITE, target, rot0, seed, { yaw: YAW_WEIGHT });
      if (r.pos_err_mm > IK_POS_MM || r.tilt_err_deg > IK_TILT_DEG) throw new Reach(`${what} is beyond the arm (off by ${r.pos_err_mm.toFixed(1)} mm, ${r.tilt_err_deg.toFixed(1)}° in tilt)`);
      seed = r.q;
      return r.q;
    };
    const line = (k: number, what: string) => {
      const out: number[][] = [];
      // solved from the surface outward, then listed inward-first as the depths are
      const order = lineDepths.map((d, i) => ({ d, i })).sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
      const q: number[][] = new Array(lineDepths.length);
      for (const { d, i } of order) q[i] = solve(siteAt(k, d), `${what}, ${(d / MM).toFixed(0)} mm out along the normal`);
      out.push(...q);
      return out;
    };
    first = line(0, "the path's first point");
    seed = first[lineDepths.findIndex((d) => Math.abs(d) < 1e-9)];
    for (const k of keyIdx) {
      at0.push(solve(siteAt(k, 0), `path point ${k + 1} of ${samples.length}`));
      atLin.push(solve(siteAt(k, LIN_MM * MM), `path point ${k + 1} of ${samples.length}, ${LIN_MM} mm out`));
      seed = at0.at(-1)!;
      atSide.push(solve(siteAt(k, 0, LIN_MM * MM), `path point ${k + 1} of ${samples.length}, ${LIN_MM} mm to its side`));
      seed = at0.at(-1)!;
    }
    last = line(samples.length - 1, "the path's last point");
  } catch (err) {
    if (err instanceof Reach) return { fail: { failure_class: "embodiment_limit", why: `contact: ${err.message}` } };
    throw err;
  } finally {
    scratch.delete();
  }
  /** joints for a depth along one line, interpolated between the solved depths */
  const onLine = (keys: number[][], depth_m: number) => {
    const d = Math.max(lineDepths[0], Math.min(lineDepths.at(-1)!, depth_m));
    let j = 0;
    while (j < lineDepths.length - 2 && lineDepths[j + 1] < d) j++;
    const u = (d - lineDepths[j]) / (lineDepths[j + 1] - lineDepths[j]);
    return keys[j].map((v, i) => v + (keys[j + 1][i] - v) * u);
  };
  /** joints at arc length s along the path, a depth and a shift across it: between keys, and linear in both */
  const onPath = (s_m: number, depth_m: number, side_m: number) => {
    let j = 0;
    while (j < keyIdx.length - 2 && samples[keyIdx[j + 1]].s_m < s_m) j++;
    const a = samples[keyIdx[j]].s_m;
    const b = samples[keyIdx[j + 1]].s_m;
    const u = b > a ? Math.max(0, Math.min(1, (s_m - a) / (b - a))) : 1;
    const q0 = at0[j].map((v, i) => v + (at0[j + 1][i] - v) * u);
    const q1 = atLin[j].map((v, i) => v + (atLin[j + 1][i] - v) * u);
    const q2 = atSide[j].map((v, i) => v + (atSide[j + 1][i] - v) * u);
    return q0.map((v, i) => v + ((q1[i] - v) * depth_m + (q2[i] - v) * side_m) / (LIN_MM * MM));
  };
  /** the sample nearest arc length s */
  const sampleAt = (s_m: number) => {
    let k = 0;
    while (k < samples.length - 1 && samples[k + 1].s_m <= s_m) k++;
    return k + 1 < samples.length && samples[k + 1].s_m - s_m < s_m - samples[k].s_m ? k + 1 : k;
  };
  const command = (q: number[]) => {
    for (let i = 0; i < ARM; i++) w.ctrl()[i] = q[i];
  };

  // what MuJoCo says, every physics step
  const force = new mujoco.DoubleBuffer(6);
  // freed however the op ends, a run stopped half way included (the generator's return runs this finally)
  try {
    type Contacts = { get: (i: number) => { geom1: number; geom2: number; pos: unknown; delete?: () => void } | undefined; delete?: () => void };
    let peak = 0;
    let contact_s = 0;
    let following = false;
    let offMax = 0;
    let offSum = 0;
    let offN = 0;
    let armTouched: string | undefined;
    /** where the held object touched the surface in the last physics step, force-weighted, or null */
    let lastAt: Vec3 | null = null;
    const covered = new Array<boolean>(samples.length).fill(false);
    const dt = (model.opt as { timestep: number }).timestep;
    const read = () => {
      let total = 0;
      const at: Vec3 = [0, 0, 0];
      // the contact list read afresh every step: a handle kept from before is the list of the step it was taken at
      // and each copy it hands out freed: thousands of steps of them otherwise fill the wasm heap
      const contacts = data.contact as unknown as Contacts;
      try {
        for (let i = 0; i < (data.ncon as number); i++) {
          const k = contacts.get(i);
          if (!k) continue;
          try {
            const [g1, g2] = [k.geom1, k.geom2];
            const [b1, b2] = [geomBody[g1], geomBody[g2]];
            if (b1 !== surfaceBody && b2 !== surfaceBody) continue;
            const other = b1 === surfaceBody ? g2 : g1;
            if (heldGeoms.has(other)) {
              mujoco.mj_contactForce(model, data, i, force);
              const fn = toNumbers(force.GetView())[0];
              if (fn > 0) {
                const p = toNumbers(k.pos);
                for (let r = 0; r < 3; r++) at[r] += fn * p[r];
                total += fn;
              }
            } else if (!isScene(geomBody[other]) && armTouched === undefined) armTouched = decodeName(names, bodyAdr[geomBody[other]]);
          } finally {
            k.delete?.();
          }
        }
      } finally {
        contacts.delete?.();
      }
      peak = Math.max(peak, total);
      lastAt = null;
      if (total >= TOUCH_N) {
        contact_s += dt;
        const p = at.map((v) => v / total) as Vec3;
        lastAt = p;
        const reach = c.reach_mm * MM;
        let nearest = Infinity;
        for (let j = 0; j < truth.length; j++) {
          const q = truth[j].point;
          const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
          nearest = Math.min(nearest, d);
          if (d <= reach) covered[j] = true;
        }
        if (following) {
          offMax = Math.max(offMax, nearest);
          offSum += nearest;
          offN++;
        }
      }
      return total;
    };
    /** how far the held object's contact point is out from the surface at sample k, along its normal, measured */
    const tipAt = (k: number): Vec3 => {
      const c0 = vec(data.xpos, w.held.bodyId, 3);
      const t = rot(vec(data.xmat, w.held.bodyId, 9), tipLocal[k]);
      return [c0[0] + t[0], c0[1] + t[1], c0[2] + t[2]];
    };
    // against the surface where MuJoCo has it, so a program told the wrong pose is slowed and judged by the real one
    const gapAt = (k: number) => {
      const n = truth[k].normal;
      const tip = tipAt(k);
      const q = truth[k].point;
      return dot(n, [tip[0] - q[0], tip[1] - q[1], tip[2] - q[2]]);
    };
    function* tick() {
      yield* w.step();
      return read();
    }
    const armSpeed = () => Math.max(...Array.from(toNumbers(data.qvel)).slice(0, ARM).map(Math.abs));
    /** wait until the arm has arrived, at most SETTLE_S, measuring every step */
    function* settleHere() {
      for (let t = 0; t < SETTLE_S; t += dt) {
        yield* tick();
        if (armSpeed() < ARRIVED_RAD_S) break;
      }
    }
    /** the interpreter's move (joints ramped at JOINT_SPEED, then settled), measuring every step: it may touch the surface on the way */
    let approachPeak = 0;
    function* moveTo(q: number[]) {
      const from = Array.from(w.ctrl().slice(0, ARM));
      const span = Math.max(MIN_MOVE_S, Math.max(...q.map((v, i) => Math.abs(v - from[i]))) / JOINT_SPEED);
      // the approach speed is measured on this move too: a stand-off that ends nearer the real surface than NEAR_MM counts
      let g0 = gapAt(0);
      const watch = () => {
        const g = gapAt(0);
        if (g > 0 && g <= NEAR_MM * MM) approachPeak = Math.max(approachPeak, (g0 - g) / dt);
        g0 = g;
      };
      for (let t = 0; t < span; t += dt) {
        command(from.map((v, i) => v + (q[i] - v) * (t / span)));
        yield* tick();
        watch();
      }
      command(q);
      for (let t = 0; t < SETTLE_S; t += dt) {
        yield* tick();
        watch();
        if (armSpeed() < ARRIVED_RAD_S) break;
      }
    }

    // how the grip holds the object against the first normal: its own z axis, a box's or a cylinder's height
    const n0 = samples[0].normal;
    const gripTilt = (Math.acos(Math.min(1, Math.abs(Rh0[2] * n0[0] + Rh0[5] * n0[1] + Rh0[8] * n0[2]))) * 180) / Math.PI;
    const limit = c.force_n;
    const target = TARGET_SHARE * limit;
    const t0 = w.now();
    w.log(`${t0.toFixed(2)} contact: ${heldObj.id} onto ${c.surface} along ${(samples.at(-1)!.s_m / MM).toFixed(0)} mm of path (${samples.length} samples), force limit ${limit} N (aiming at ${target.toFixed(2)} N)`);

    // 1. the stand-off, at the usual speed; nothing should touch the surface on the way
    yield* moveTo(onLine(first, STANDOFF_MM * MM));

    // 2. in along the normal, slower near the surface, until it touches
    let depth = STANDOFF_MM * MM;
    let gap = gapAt(0);
    let F = 0;
    while (F < TOUCH_N) {
      if (depth <= -PRESS_MAX_MM * MM) {
        return { fail: { why: `contact: nothing touched ${c.surface} ${PRESS_MAX_MM} mm past where its surface should be: it is not where the program was told it is` } };
      }
      // slow from where the held object is measured to be within NEAR_MM of the surface, or is told it is
      depth -= (Math.min(depth, gap) > SLOW_MM * MM ? APPROACH_MM_S : NEAR_MM_S) * MM * dt;
      command(onLine(first, depth));
      F = yield* tick();
      const g = gapAt(0);
      if (g > 0 && g <= NEAR_MM * MM) approachPeak = Math.max(approachPeak, (gap - g) / dt);
      gap = g;
    }
    w.log(`${w.now().toFixed(2)} contact: touched ${c.surface} ${((t0 - w.now()) * -1).toFixed(2)} s after starting, ${(depth / MM).toFixed(1)} mm from where its surface should be`);

    // 3. along the path, the depth moved by the force error each physics step
    const length = samples.at(-1)!.s_m;
    const tf = w.now();
    following = true;
    let s = 0;
    let smooth = F;
    let sum = 0;
    let inContact = 0;
    let side = 0;
    let dwell = 0;
    // the depth is carried over from the approach line onto the path's: both put the contact at the same point; at
    // the end the arm stays DWELL_S on the last point, the loops still running, as the contact trails the command
    while (s < length || dwell < DWELL_S) {
      if (s < length) s = Math.min(length, s + PATH_MM_S * MM * dt);
      else dwell += dt;
      const err = smooth - target;
      const rate = Math.max(-NEAR_MM_S, Math.min(NEAR_MM_S, GAIN_MM_S_N * err));
      depth = Math.max(-PRESS_MAX_MM * MM, Math.min(NEAR_MM * MM, depth + rate * MM * dt));
      // across the path: where the contact is measured to be against the path's point at s, integrated
      if (lastAt) {
        const k = sampleAt(s);
        const q = samples[k].point;
        const off = dot(sides[k], [q[0] - lastAt[0], q[1] - lastAt[1], q[2] - lastAt[2]]);
        side = Math.max(-SIDE_MAX_MM * MM, Math.min(SIDE_MAX_MM * MM, side + SIDE_GAIN_S * off * dt));
      }
      command(onPath(s, depth, side));
      F = yield* tick();
      smooth += (F - smooth) / SMOOTH;
      if (F >= TOUCH_N) {
        sum += F;
        inContact++;
      }
    }
    const follow_s = w.now() - tf;
    following = false;

    // 4. off along the normal at the last point, slower near the surface, still shifted across the path as it ended
    let retreatPeak = 0;
    const k = samples.length - 1;
    gap = gapAt(k);
    const across = at0.at(-1)!.map((v, i) => (atSide.at(-1)![i] - v) / (LIN_MM * MM));
    // the path's last pose is the last line's at the same depth and shift: no jump between them
    while (depth < STANDOFF_MM * MM) {
      depth = Math.min(STANDOFF_MM * MM, depth + (Math.min(depth, gap) < SLOW_MM * MM ? NEAR_MM_S : APPROACH_MM_S) * MM * dt);
      command(onLine(last, depth).map((v, i) => v + across[i] * side));
      yield* tick();
      const g = gapAt(k);
      if (g > 0 && g <= NEAR_MM * MM) retreatPeak = Math.max(retreatPeak, (g - gap) / dt);
      gap = g;
    }
    yield* settleHere();

    const n = covered.filter(Boolean).length;
    const contacted: Contacted = {
      step_id: step.id,
      surface: c.surface,
      samples: samples.length,
      covered: n,
      coverage: totalWeight > 0 ? weight.reduce((a, x, j) => a + (covered[j] ? x : 0), 0) / totalWeight : n / samples.length,
      coverage_required: c.coverage_pc / 100,
      reach_mm: c.reach_mm,
      force_limit_n: limit,
      force_target_n: target,
      peak_force_n: peak,
      mean_force_n: inContact ? sum / inContact : 0,
      contact_s,
      follow_s,
      approach_peak_mm_s: approachPeak / MM,
      retreat_peak_mm_s: retreatPeak / MM,
      off_path_max_mm: offMax / MM,
      off_path_mean_mm: offN ? offSum / offN / MM : 0,
      grip_tilt_deg: gripTilt,
      ...(armTouched ? { arm_touched: armTouched } : {}),
    };
    w.log(`${w.now().toFixed(2)} contact: ${describeContact(contacted)}`);
    if (armTouched) return { contacted, fail: { why: `contact: the arm's ${armTouched} touched ${c.surface}; only the held ${heldObj.id} may` } };
    if (peak > limit) return { contacted, fail: { why: `contact: pushed on ${c.surface} with up to ${peak.toFixed(2)} N, over the ${limit} N limit` } };
    if (contacted.coverage < contacted.coverage_required) return { contacted, fail: { why: `contact: covered ${(100 * contacted.coverage).toFixed(0)}% of the path within ${c.reach_mm} mm, wanted ${c.coverage_pc}%` } };
    return { contacted };
  } finally {
    force.delete();
  }
}

class Reach extends Error {}

/**
 * The contact paths of a spec drawn on its surfaces where they stand (`frames`), for the stage: an empty string
 * when it has none, so the scene of every other spec is built exactly as before. A path that cannot be sampled is
 * left out here; the contact op reports it.
 */
export function contactMarkers(spec: TaskSpec, frames: Record<string, WorldPose>): string {
  const paths: Sample[][] = [];
  for (const s of spec.steps) {
    const c = s.verb === "apply" ? s.contact : undefined;
    const o = c && spec.objects.find((x) => x.id === c.surface);
    if (!c || !o || !Object.hasOwn(frames, c.surface) || c.path.length < 2) continue;
    try {
      paths.push(samplePath(o, c.path, frames[c.surface].xyz_m as Vec3, quatToMat(frames[c.surface].quat)));
    } catch {
      continue;
    }
  }
  return paths.length ? `\n${contactMarkersXml(paths)}` : "";
}

/** One line for the log and the notes: what the contact did, measured. */
export function describeContact(c: Contacted): string {
  return [
    `${c.covered} of ${c.samples} path samples had a contact within ${c.reach_mm} mm (${(100 * c.coverage).toFixed(0)}% of its length)`,
    `peak force ${c.peak_force_n.toFixed(2)} N against a ${c.force_limit_n} N limit (mean ${c.mean_force_n.toFixed(2)} N while following, aiming at ${c.force_target_n.toFixed(2)} N)`,
    `${c.contact_s.toFixed(2)} s in contact over ${c.follow_s.toFixed(2)} s of path`,
    `contacts up to ${c.off_path_max_mm.toFixed(1)} mm off the path (mean ${c.off_path_mean_mm.toFixed(1)}), the held object ${c.grip_tilt_deg.toFixed(1)}° off the normal`,
    `approach and retreat within ${NEAR_MM} mm at up to ${c.approach_peak_mm_s.toFixed(1)} and ${c.retreat_peak_mm_s.toFixed(1)} mm/s`,
    ...(c.arm_touched ? [`the arm's ${c.arm_touched} touched the surface`] : []),
  ].join("; ");
}
