/**
 * Inverse kinematics for the SO-101 tip site: five constraints (tip position
 * plus the approach axis) over the five arm joints, damped least squares on
 * `mj_jacSite`, clamped to the joint ranges. The arm has no yaw at the wrist,
 * so an approach axis outside the plane the arm pitches in is projected onto
 * that plane and the angle it gave up is recorded. Pure over a scratch MjData:
 * the worker calls it and the unit tests call it in Node.
 */
import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import type { APPROACHES } from "@/lib/spec/schema";
import { decodeName, toNumbers } from "./names";
import { SO101_JOINT_NAMES, SO101_TIP_SITE } from "./so101";

export type Approach = (typeof APPROACHES)[number];
type Vec3 = [number, number, number];

/** The five arm joints IK moves; the gripper is left as it is. */
export const IK_JOINTS = SO101_JOINT_NAMES.slice(0, 5);
/** Converged when the tip is this close (m) and the axis this close (rad). */
const POS_TOL_M = 0.001;
const AXIS_TOL_RAD = (1 * Math.PI) / 180;
/** Reachable when the best solution is within these. */
const REACH_POS_M = 0.002;
const REACH_AXIS_RAD = (2 * Math.PI) / 180;
/** An approach the pitch plane bends further than this is not the approach asked for. */
const MAX_APPROACH_DEG = 20;
/** Metres of tip error worth one unit of axis error: 1 rad of axis counts like 5 cm. */
const AXIS_WEIGHT = 0.05;
const DAMPING = 0.01;
const MAX_STEP_RAD = 0.2;
const MAX_ITERS = 200;
/**
 * Seeds after the caller's, home first, to get out of joint-limit corners: a
 * grid over lift, elbow, wrist and roll (a horizontal approach often needs the
 * wrist rolled over). Radians, IK_JOINTS order; pan is replaced by the angle
 * facing the target.
 */
const SEEDS = [[0, -1.3, 1.2, 0.6, 0]].concat(
  [0, -2.6, 2.6].flatMap((roll) =>
    [-1.2, -0.4, 0.4].flatMap((lift) => [1.3, 0.4, -0.5].flatMap((elbow) => [1.2, 0.3, -0.6].map((wrist) => [0, lift, elbow, wrist, roll]))),
  ),
);
/** A descent whose weighted error moves less than this per iteration has stalled. */
const STALL = 1e-7;

export type IkResult = {
  /** IK_JOINTS order, radians, within the joint ranges */
  q: number[];
  ok: boolean;
  pos_err_mm: number;
  /** the axis IK aimed for: the asked approach projected onto the arm's pitch plane */
  axis: Vec3;
  /** degrees between the asked approach and `axis` (0 for `top`); over 20 is an embodiment limit */
  approach_deg: number;
  /** degrees between `axis` and the reached tool axis */
  axis_err_deg: number;
  iterations: number;
  failure_class?: "embodiment_limit";
};

/** The tool axis the gripper points along: world down for top, +x for front, away from the centreline for side. */
export function approachVector(approach: Approach, target: Vec3): Vec3 {
  if (approach === "front") return [1, 0, 0];
  if (approach === "side") return [0, target[1] < 0 ? -1 : 1, 0];
  return [0, 0, -1];
}

/**
 * Solve for `site` (the tip unless given) at `target` (world metres) coming in along `approach`.
 * `data` is scratch: its arm qpos is overwritten; other joints (gripper, free
 * bodies) are read as they are. `seed` (IK_JOINTS order) is tried first;
 * without one, the arm's pose in `data`.
 */
export function solveIk(
  mujoco: MainModule,
  model: MjModel,
  data: MjData,
  target: Vec3,
  approach: Approach,
  seed?: number[],
  site: string = SO101_TIP_SITE,
): IkResult {
  const arm = armIndex(model, site);
  const qpos = toNumbers(data.qpos);
  seed ??= arm.qposadr.map((adr) => qpos[adr]);
  setArm(data, arm.qposadr, seed);
  mujoco.mj_kinematics(model, data);
  const pan = panAnchor(data, arm.panJoint);
  const axis = projectOntoPitchPlane(approachVector(approach, target), target, pan);
  // positive pan swings the arm towards -y: start every default seed facing the target
  const facing = -Math.atan2(target[1] - pan[1], target[0] - pan[0]);
  const seeds = SEEDS.map((s) => [facing, ...s.slice(1)]);
  let best: IkResult | null = null;
  for (const s of [seed, ...seeds]) {
    const r = descend(mujoco, model, data, arm, target, axis.v, s);
    const res: IkResult = { ...r, axis: axis.v, approach_deg: axis.deg };
    if (!best || score(res) < score(best)) best = res;
    if (best.ok) break;
  }
  const out = best!;
  if (out.approach_deg > MAX_APPROACH_DEG) out.ok = false;
  if (!out.ok) out.failure_class = "embodiment_limit";
  setArm(data, arm.qposadr, out.q);
  mujoco.mj_kinematics(model, data);
  return out;
}

/** The per-scenario pre-check: every target the program visits, solved; any miss is an embodiment limit. */
export function reachability(
  mujoco: MainModule,
  model: MjModel,
  data: MjData,
  targets: { pos: Vec3; approach: Approach }[],
): { ok: boolean; failure_class?: "embodiment_limit"; results: IkResult[] } {
  let seed: number[] | undefined;
  const results = targets.map((t) => {
    const r = solveIk(mujoco, model, data, t.pos, t.approach, seed);
    if (r.ok) seed = r.q; // consecutive targets are usually close
    return r;
  });
  const ok = results.every((r) => r.ok);
  return ok ? { ok, results } : { ok, failure_class: "embodiment_limit", results };
}

/** `tilt_err_deg`: the rotation still missing about horizontal axes; `turned_deg`: about the vertical. */
export type PoseResult = { q: number[]; pos_err_mm: number; tilt_err_deg: number; turned_deg: number };

/** Orientation counts like this many metres per radian in solvePose: 1 rad like 10 cm. */
const ROT_WEIGHT = 0.1;

/**
 * `site` at `target` with rotation `rot` (row-major, world): six constraints over five joints, met in the
 * least-squares sense. `yaw` (0 to 1) weights the part of the rotation error about the vertical: a 5-DoF arm
 * can keep a point and a tilt only by giving up a little of the compass heading. Seeded with `seed`; `data`
 * is scratch, as in solveIk.
 */
export function solvePose(
  mujoco: MainModule,
  model: MjModel,
  data: MjData,
  site: string,
  target: Vec3,
  rot: number[],
  seed: number[],
  { yaw = 1 }: { yaw?: number } = {},
): PoseResult {
  const arm = armIndex(model, site);
  const nv = model.nv as number;
  const q = seed.map((v, i) => clamp(v, arm.range[i]));
  const jacp = new mujoco.DoubleBuffer(3 * nv);
  const jacr = new mujoco.DoubleBuffer(3 * nv);
  const weigh = (v: Vec3): Vec3 => [ROT_WEIGHT * v[0], ROT_WEIGHT * v[1], ROT_WEIGHT * yaw * v[2]];
  let posErr = Infinity;
  let er: Vec3 = [Infinity, Infinity, Infinity];
  let last = Infinity;
  try {
    for (let it = 0; it <= MAX_ITERS; it++) {
      setArm(data, arm.qposadr, q);
      mujoco.mj_kinematics(model, data);
      mujoco.mj_comPos(model, data);
      const pos = toNumbers(data.site_xpos);
      const mat = toNumbers(data.site_xmat);
      const ep = sub(target, [pos[3 * arm.site], pos[3 * arm.site + 1], pos[3 * arm.site + 2]]);
      er = rotationError(rot, Array.from({ length: 9 }, (_, k) => mat[9 * arm.site + k]));
      posErr = norm(ep);
      const ew = weigh(er);
      const err = posErr + norm(ew);
      if ((posErr < POS_TOL_M && norm(er) < AXIS_TOL_RAD) || it === MAX_ITERS || Math.abs(last - err) < STALL) break;
      last = err;
      mujoco.mj_jacSite(model, data, jacp, jacr, arm.site);
      const Jp = toNumbers(jacp.GetView());
      const Jr = toNumbers(jacr.GetView());
      const J: number[][] = Array.from({ length: 6 }, () => new Array(5).fill(0));
      for (let c = 0; c < 5; c++) {
        const d = arm.dofadr[c];
        const w = weigh([Jr[d], Jr[nv + d], Jr[2 * nv + d]]);
        for (let r = 0; r < 3; r++) {
          J[r][c] = Jp[r * nv + d];
          J[3 + r][c] = w[r];
        }
      }
      const dq = dls(J, [...ep, ...ew], DAMPING);
      const step = Math.hypot(...dq);
      const k = step > MAX_STEP_RAD ? MAX_STEP_RAD / step : 1;
      for (let c = 0; c < 5; c++) q[c] = clamp(q[c] + k * dq[c], arm.range[c]);
    }
  } finally {
    jacp.delete();
    jacr.delete();
  }
  const deg = (rad: number) => (rad * 180) / Math.PI;
  return { q, pos_err_mm: posErr * 1000, tilt_err_deg: deg(Math.hypot(er[0], er[1])), turned_deg: deg(Math.abs(er[2])) };
}

/** The rotation vector (axis times angle, world frame) that turns `current` into `target`; both row-major. */
function rotationError(target: number[], current: number[]): Vec3 {
  // E = target * current^T
  const E = Array.from({ length: 9 }, (_, k) => {
    const i = Math.floor(k / 3);
    const j = k % 3;
    return target[3 * i] * current[3 * j] + target[3 * i + 1] * current[3 * j + 1] + target[3 * i + 2] * current[3 * j + 2];
  });
  const v: Vec3 = [E[7] - E[5], E[2] - E[6], E[3] - E[1]];
  const s = norm(v) / 2;
  const c = clamp((E[0] + E[4] + E[8] - 1) / 2, [-1, 1]);
  const angle = Math.atan2(s, c);
  if (s > 1e-9) return scale(v, angle / (2 * s));
  if (c > 0) return [0, 0, 0];
  // a half turn: the axis is the column of E + I with the largest norm
  const cols = [0, 1, 2].map((j): Vec3 => [E[j] + (j === 0 ? 1 : 0), E[3 + j] + (j === 1 ? 1 : 0), E[6 + j] + (j === 2 ? 1 : 0)]);
  const best = cols.reduce((a, b) => (norm(b) > norm(a) ? b : a));
  return scale(best, Math.PI / norm(best));
}

type ArmIndex = { qposadr: number[]; dofadr: number[]; range: [number, number][]; panJoint: number; site: number };

function armIndex(model: MjModel, siteName: string): ArmIndex {
  const names = toNumbers(model.names);
  const jntName = toNumbers(model.name_jntadr);
  const siteAdr = toNumbers(model.name_siteadr);
  const qposadr = toNumbers(model.jnt_qposadr);
  const dofadr = toNumbers(model.jnt_dofadr);
  const range = toNumbers(model.jnt_range);
  const joint = (n: string) => {
    for (let j = 0; j < (model.njnt as number); j++) if (decodeName(names, jntName[j]) === n) return j;
    throw new Error(`no joint named ${n}`);
  };
  const ids = IK_JOINTS.map(joint);
  let site = -1;
  for (let s = 0; s < (model.nsite as number); s++) if (decodeName(names, siteAdr[s]) === siteName) site = s;
  if (site < 0) throw new Error(`no site named ${siteName}`);
  return {
    qposadr: ids.map((j) => qposadr[j]),
    dofadr: ids.map((j) => dofadr[j]),
    range: ids.map((j) => [range[2 * j], range[2 * j + 1]]),
    panJoint: ids[0],
    site,
  };
}

function descend(mujoco: MainModule, model: MjModel, data: MjData, arm: ArmIndex, target: Vec3, axis: Vec3, seed: number[]) {
  const nv = model.nv as number;
  const q = seed.map((v, i) => clamp(v, arm.range[i]));
  const jacp = new mujoco.DoubleBuffer(3 * nv);
  const jacr = new mujoco.DoubleBuffer(3 * nv);
  let posErr = Infinity;
  let axisErr = Infinity;
  let last = Infinity;
  let it = 0;
  try {
    for (; it <= MAX_ITERS; it++) {
      setArm(data, arm.qposadr, q);
      mujoco.mj_kinematics(model, data);
      mujoco.mj_comPos(model, data); // mj_jac reads cdof and subtree_com
      const { p, a } = tipPose(data, arm.site);
      const ep = sub(target, p);
      const ea = sub(axis, a);
      posErr = norm(ep);
      axisErr = Math.acos(clamp(dot(a, axis), [-1, 1]));
      if ((posErr < POS_TOL_M && axisErr < AXIS_TOL_RAD) || it === MAX_ITERS) break;
      const err = posErr + AXIS_WEIGHT * axisErr;
      if (Math.abs(last - err) < STALL) break;
      last = err;

      mujoco.mj_jacSite(model, data, jacp, jacr, arm.site);
      const Jp = toNumbers(jacp.GetView());
      const Jr = toNumbers(jacr.GetView());
      // rows 0-2: tip position; rows 3-5: d(axis)/dq = omega x a = -[a]x omega, weighted
      const J: number[][] = Array.from({ length: 6 }, () => new Array(5).fill(0));
      for (let c = 0; c < 5; c++) {
        const d = arm.dofadr[c];
        const w: Vec3 = [Jr[d], Jr[nv + d], Jr[2 * nv + d]];
        const da = cross(w, a);
        for (let r = 0; r < 3; r++) {
          J[r][c] = Jp[r * nv + d];
          J[3 + r][c] = AXIS_WEIGHT * da[r];
        }
      }
      const e = [...ep, ...ea.map((v) => AXIS_WEIGHT * v)];
      const dq = dls(J, e, DAMPING);
      const step = Math.hypot(...dq);
      const k = step > MAX_STEP_RAD ? MAX_STEP_RAD / step : 1;
      for (let c = 0; c < 5; c++) q[c] = clamp(q[c] + k * dq[c], arm.range[c]);
    }
  } finally {
    jacp.delete();
    jacr.delete();
  }
  return {
    q,
    ok: posErr < REACH_POS_M && axisErr < REACH_AXIS_RAD,
    pos_err_mm: posErr * 1000,
    axis_err_deg: (axisErr * 180) / Math.PI,
    iterations: it,
  };
}

/** dq = (JᵀJ + λ²I)⁻¹ Jᵀ e, a 5x5 solve. */
export function dls(J: number[][], e: number[], lambda: number): number[] {
  const n = J[0].length;
  const A = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => J.reduce((s, row) => s + row[i] * row[j], 0) + (i === j ? lambda * lambda : 0)),
  );
  const b = Array.from({ length: n }, (_, i) => J.reduce((s, row, r) => s + row[i] * e[r], 0));
  // Gaussian elimination with partial pivoting; A is symmetric positive definite thanks to the damping
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/** The arm pitches in the vertical plane through the pan axis and the target; keep the approach's part in it. */
function projectOntoPitchPlane(v: Vec3, target: Vec3, pan: [number, number]): { v: Vec3; deg: number } {
  const rx = target[0] - pan[0];
  const ry = target[1] - pan[1];
  const r = Math.hypot(rx, ry);
  const n: Vec3 = r > 1e-6 ? [-ry / r, rx / r, 0] : [0, 1, 0]; // plane normal
  const p = sub(v, scale(n, dot(v, n)));
  const len = norm(p);
  // shortcut: an approach square to the plane (side at y = 0) has no part in it; fall back to top
  const out: Vec3 = len > 1e-3 ? scale(p, 1 / len) : [0, 0, -1];
  return { v: out, deg: (Math.acos(clamp(dot(v, out), [-1, 1])) * 180) / Math.PI };
}

function panAnchor(data: MjData, panJoint: number): [number, number] {
  const x = toNumbers(data.xanchor);
  return [x[3 * panJoint], x[3 * panJoint + 1]];
}

/** Tip position and tool axis: the site's local x, column 0 of the row-major xmat. */
function tipPose(data: MjData, site: number): { p: Vec3; a: Vec3 } {
  const pos = toNumbers(data.site_xpos);
  const mat = toNumbers(data.site_xmat);
  const m = 9 * site;
  return { p: [pos[3 * site], pos[3 * site + 1], pos[3 * site + 2]], a: [mat[m], mat[m + 3], mat[m + 6]] };
}

function setArm(data: MjData, qposadr: number[], q: number[]) {
  const qpos = data.qpos as unknown;
  qposadr.forEach((adr, i) => {
    if (ArrayBuffer.isView(qpos)) (qpos as unknown as Float64Array)[adr] = q[i];
    else (qpos as { set: (i: number, v: number) => boolean }).set(adr, q[i]);
  });
}

const score = (r: { pos_err_mm: number; axis_err_deg: number }) => r.pos_err_mm + r.axis_err_deg;
const clamp = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.sqrt(dot(a, a));
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
