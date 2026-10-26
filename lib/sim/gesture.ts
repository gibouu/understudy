/**
 * A gesture as the arm does it: the path of the person's hand scaled into a
 * plane in front of the SO-101, and the check that the arm reached each point
 * of it.
 * Pure (no MuJoCo, no browser), so the scaling and the check are unit-tested.
 *
 * Frames. The robot stands where the camera stood, facing the person (world +x
 * toward them). The hand is read in the person's frontal plane, as MediaPipe's
 * pose world landmarks give it (metres from the hip centre, x to the image's
 * right, y down), and drawn in the vertical plane x = PLANE_X_MM: the image's
 * right is the robot's right (world -y) and the image's up is world up. The arm
 * moves where the person's hand appears in the clip, as a mirror image does.
 *
 * Scale. The person's arm (shoulder to elbow to wrist, measured on the same
 * landmarks) maps onto the SO-101's (ARM_MM); a path that is still larger than
 * the plane's box is shrunk to fit it. The path is centred in the box. Both
 * factors are reported, never applied silently. A [1, 2, 1] average over
 * neighbouring samples takes off the landmarks' frame-to-frame jitter; at
 * 30 fps it keeps 90% of a wave that turns back three times a second.
 *
 * The check. A point is reached when the point between the pads comes within
 * `reach_mm` of it after the point before it was reached and at most MAX_LAG_S
 * after its own time: in order, and a little behind, as a servo follows. How
 * far behind is reported; the arm may also follow slower than the clip (the
 * interpreter says by how much), and the times are then the slowed ones.
 */
import type { PathPoint, Program, TaskSpec } from "@/lib/spec/schema";

type Vec3 = [number, number, number];

/** A hand sample in the person's frontal plane: metres, x to the image's right, y down. */
export type HandSample = { t_s: number; x_m: number; y_m: number };

/**
 * The plane the path is drawn in and the box it must fit, mm, world frame. Every corner, the bottom centre and a
 * circle filling the box are followed within reach_mm at 1 g and 0 g (tests/sim/follow.test.ts); below z = 200 mm
 * the arm cannot keep the gripper level in this plane (at z = 150 it falls 75 mm short).
 */
export const PLANE_X_MM = 220;
export const BOX_Y_MM = [-120, 120] as const;
export const BOX_Z_MM = [200, 330] as const;
/** The SO-101's arm, shoulder lift axis to wrist flex axis (upper arm 116 mm, lower arm 135 mm in assets/so101/so101.xml). */
export const ARM_MM = 250;
/** A path shorter than this, or with fewer samples, is not a gesture the arm can follow. */
const MIN_SPAN_S = 0.5;
/** 20 s at 30 fps: a longer path is cut, and said so. */
export const MAX_POINTS = 600;
/** A hand that moved less than this either way (m) is held still: the landmarks jitter by about 1 cm. */
const MIN_MOVE_M = 0.02;

export type Scaled = {
  path: PathPoint[];
  /** mm of path per metre of hand travel: the arm-length ratio times `fit` */
  mm_per_m: number;
  /** the extra shrink the box needed, 1 when none */
  fit: number;
  warnings: string[];
};

/** to 0.1, and never -0 */
const r1 = (x: number) => Math.round(x * 10) / 10 || 0;

/**
 * The hand samples of one gesture as a path for the arm. `armM` is the person's arm length in metres, or
 * null when it could not be measured: the path then fills the box. Samples must be in time order.
 */
export function scalePath(samples: HandSample[], armM: number | null): Scaled {
  const warnings: string[] = [];
  const empty = (why: string): Scaled => ({ path: [], mm_per_m: 0, fit: 1, warnings: [...warnings, why] });
  // times from the first sample, to the millisecond, and moving forward: a repeated or earlier sample (or one that
  // rounds onto the one before) is not a measurement of where the hand went next
  let s: HandSample[] = [];
  const t0 = samples.find((p) => Number.isFinite(p.t_s) && Number.isFinite(p.x_m) && Number.isFinite(p.y_m))?.t_s ?? 0;
  for (const p of samples) {
    if (!(Number.isFinite(p.t_s) && Number.isFinite(p.x_m) && Number.isFinite(p.y_m))) continue;
    const t_s = Math.round((p.t_s - t0) * 1000) / 1000;
    if (s.length === 0 || t_s > s.at(-1)!.t_s) s.push({ ...p, t_s });
  }
  if (s.length < 2 || s.at(-1)!.t_s - s[0].t_s < MIN_SPAN_S) return empty(`the hand was seen for under ${MIN_SPAN_S} s: no path to follow`);
  if (s.length > MAX_POINTS) {
    warnings.push(`the hand's path has ${s.length} samples; the first ${MAX_POINTS} (${r1(s[MAX_POINTS - 1].t_s - s[0].t_s)} s) are kept`);
    s = s.slice(0, MAX_POINTS);
  }
  const smooth = s.map((p, i) => {
    if (i === 0 || i === s.length - 1) return p;
    return { t_s: p.t_s, x_m: (s[i - 1].x_m + 2 * p.x_m + s[i + 1].x_m) / 4, y_m: (s[i - 1].y_m + 2 * p.y_m + s[i + 1].y_m) / 4 };
  });
  const xs = smooth.map((p) => p.x_m);
  const ys = smooth.map((p) => p.y_m);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const boxW = BOX_Y_MM[1] - BOX_Y_MM[0];
  const boxH = BOX_Z_MM[1] - BOX_Z_MM[0];
  const wide = x1 - x0;
  const tall = y1 - y0;
  if (Math.max(wide, tall) < MIN_MOVE_M) return empty(`the hand moved under ${MIN_MOVE_M * 100} cm: no path to follow`);
  let mm_per_m: number;
  if (armM !== null && armM > 0) mm_per_m = ARM_MM / armM;
  else {
    // no arm to measure the person by: the path fills the box
    mm_per_m = Math.min(wide > 0 ? boxW / wide : Infinity, tall > 0 ? boxH / tall : Infinity);
    warnings.push("the person's arm length could not be measured; the path is scaled to fill the arm's reach");
  }
  const fit = Math.min(1, wide * mm_per_m > boxW ? boxW / (wide * mm_per_m) : 1, tall * mm_per_m > boxH ? boxH / (tall * mm_per_m) : 1);
  if (fit < 1) warnings.push(`the hand's path is larger than the arm's reach; scaled down a further ${Math.round((1 - fit) * 100)}%`);
  const k = mm_per_m * fit;
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const [cY, cZ] = [(BOX_Y_MM[0] + BOX_Y_MM[1]) / 2, (BOX_Z_MM[0] + BOX_Z_MM[1]) / 2];
  const path = smooth.map((p) => ({
    t_s: p.t_s,
    xyz_mm: [PLANE_X_MM, r1(cY - (p.x_m - cx) * k), r1(cZ - (p.y_m - cy) * k)] as Vec3,
  }));
  return { path, mm_per_m: r1(k), fit: Math.round(fit * 1000) / 1000, warnings };
}

/** Where the point between the pads was, sampled as the arm moved. */
export type TraceSample = { t_s: number; xyz_mm: Vec3 };

export type Reach = {
  points: number;
  reached: number;
  reach_mm: number;
  /** indexes of the points never reached */
  missed: number[];
  /** the largest distance by which a point was reached or missed, mm */
  worst_mm: number;
  /** how far behind the path's own timing the arm first came within reach of a point, at most, s */
  late_s: number;
};

/**
 * A point may be reached this long after the path's own time for it: a position servo trails a moving target (by
 * 0.01 to 0.03 s at the joint-speed cap, docs/MEASUREMENTS.md section 11). Shorter than a wave's swing, so an arm
 * half a swing behind does not pass.
 */
export const MAX_LAG_S = 0.25;

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Point by point, in order: a point is reached when the trace (in time order) comes within `reach_mm` of it no
 * earlier than the moment the point before it was reached (and the time of the point before it) and no later than
 * MAX_LAG_S after its own time; late by when it first does. A missed point does not move the search on, so one miss
 * does not carry over to the next. `worst_mm` is the closest the trace came in a point's window, the worst over
 * all points; a window with no observation counts the one nearest in time. `start_s` is the trace time the path's
 * t_s = 0 stands for.
 */
export function reachCheck(path: PathPoint[], trace: TraceSample[], reach_mm: number, start_s = 0): Reach {
  let worst = 0;
  let late = 0;
  /** the sample the last reached point was reached at: a later point is never reached before it */
  let cursor = 0;
  let k0 = 0;
  const missed: number[] = [];
  path.forEach((p, i) => {
    const due = start_s + p.t_s;
    const from = start_s + (i > 0 ? path[i - 1].t_s : 0) - 1e-9;
    while (k0 < trace.length && trace[k0].t_s < from) k0++;
    let best = Infinity;
    let first = -1;
    for (let k = Math.max(k0, cursor); k < trace.length && trace[k].t_s <= due + MAX_LAG_S + 1e-9; k++) {
      const d = dist(trace[k].xyz_mm, p.xyz_mm);
      best = Math.min(best, d);
      if (first < 0 && d <= reach_mm) first = k;
    }
    if (first < 0) missed.push(i);
    else {
      cursor = first;
      late = Math.max(late, trace[first].t_s - due);
    }
    if (!Number.isFinite(best) && trace.length > 0) {
      const near = trace.reduce((a, b) => (Math.abs(b.t_s - due) < Math.abs(a.t_s - due) ? b : a));
      best = dist(near.xyz_mm, p.xyz_mm);
    }
    if (Number.isFinite(best)) worst = Math.max(worst, best);
  });
  return { points: path.length, reached: path.length - missed.length, reach_mm, missed, worst_mm: r1(worst), late_s: Math.round(late * 100) / 100 };
}

/** A speed factor (1 = the clip's own pace) in a few digits that never read as 0: 0.70, 0.072, 0.000072. */
export const speedText = (x: number) => (x >= 0.1 ? x.toFixed(2) : x.toPrecision(2));

/** The check in words, for the log and the page: what was reached, how close, how late, and how much slower than the clip. */
export function describeReach(r: Reach & { speed?: number }): string {
  const slower = r.speed !== undefined && r.speed < 0.995 ? ` at ${speedText(r.speed)}x the clip's speed` : "";
  const late = r.late_s >= 0.05 ? `, up to ${r.late_s.toFixed(2)} s behind` : "";
  if (r.missed.length === 0) return `reached all ${r.points} points of the path within ${r.reach_mm} mm${slower} (the farthest ${r.worst_mm} mm off${late})`;
  const which = r.missed.length <= 5 ? ` (${r.missed.map((i) => i + 1).join(", ")})` : "";
  return `missed ${r.missed.length} of ${r.points} points${which}${slower}: the farthest was ${r.worst_mm} mm off, the limit ${r.reach_mm} mm`;
}

/** At most this many markers per path on the stage: enough to see its shape. */
const MAX_MARKERS = 60;

/** Visual-only spheres along each gesture path (no contacts, no mass): the path the arm is asked to follow. */
export function pathMarkersXml(paths: PathPoint[][]): string {
  const out: string[] = [];
  paths.forEach((path, n) => {
    const every = Math.max(1, Math.ceil(path.length / MAX_MARKERS));
    path.forEach((p, i) => {
      if (i % every !== 0 && i !== path.length - 1) return;
      const pos = p.xyz_mm.map((v) => (v / 1000).toFixed(4)).join(" ");
      out.push(`<geom name="gesture_${n}_${i}" type="sphere" size="0.004" pos="${pos}" rgba="0.85 0.35 0.12 0.55" contype="0" conaffinity="0" group="2"/>`);
    });
  });
  return out.join("\n");
}

/** The program of a spec whose every step is a gesture: each follows its own path. Nothing is left to guess, so no model writes it; null for any other spec. */
export function gestureProgram(spec: TaskSpec): Program | null {
  if (spec.steps.length === 0 || spec.steps.some((s) => s.verb !== "gesture")) return null;
  return { spec_title: spec.title, steps: spec.steps.map((s) => ({ step_id: s.id, ops: [{ op: "follow" }] })), warnings: [] };
}
