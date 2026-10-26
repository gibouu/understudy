/**
 * One hand's path from the Watch tokens, for a gesture: where the centre of
 * the person's hand was in their frontal plane, frame by frame, and how long
 * that arm is, which sets the path's scale (lib/sim/gesture.ts). Both come
 * from the pose world landmarks (metres from the hip centre, x to the image's
 * right, y down). The hand's centre is the mean of the pose model's wrist,
 * index and pinky landmarks: in a wave the hand turns about the wrist, so its
 * centre travels further than the wrist does, and three landmarks jitter less
 * than one. Pure, so it is unit-tested on landmark fixtures.
 */
import type { HandSample } from "@/lib/sim/gesture";
import { POSE } from "./select";
import type { HandSide, Point3, TokenFrame } from "./types";

/** A landmark below this visibility is not trusted as a measurement. */
export const MIN_VISIBILITY = 0.5;
/** An unseen stretch longer than this is reported: the arm goes straight across it. */
const GAP_S = 0.5;

const JOINTS = {
  left: { shoulder: POSE.LEFT_SHOULDER, elbow: POSE.LEFT_ELBOW, hand: [POSE.LEFT_WRIST, POSE.LEFT_INDEX, POSE.LEFT_PINKY] },
  right: { shoulder: POSE.RIGHT_SHOULDER, elbow: POSE.RIGHT_ELBOW, hand: [POSE.RIGHT_WRIST, POSE.RIGHT_INDEX, POSE.RIGHT_PINKY] },
} as const;

const inWindow = (f: TokenFrame, t0: number, t1: number) => f.t_s >= t0 - 1e-9 && f.t_s <= t1 + 1e-9;
const seen = (f: TokenFrame, i: number) => f.pose !== null && f.pose.world.length > i && (f.pose.visibility[i] ?? 0) >= MIN_VISIBILITY;
const d3 = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The hand's centre between t0 and t1 (clip seconds), only in frames where the pose model saw all three of its landmarks. */
export function handSamples(frames: TokenFrame[], side: HandSide, t0: number, t1: number): HandSample[] {
  const ids = JOINTS[side].hand;
  return frames
    .filter((f) => inWindow(f, t0, t1) && ids.every((i) => seen(f, i)))
    .map((f) => {
      const w = f.pose!.world;
      return { t_s: f.t_s, x_m: ids.reduce((s, i) => s + w[i].x, 0) / ids.length, y_m: ids.reduce((s, i) => s + w[i].y, 0) / ids.length };
    });
}

/** Stretches longer than GAP_S where the hand was not seen, between samples or at the window's ends. */
export function handGaps(samples: HandSample[], t0: number, t1: number): { start_s: number; end_s: number }[] {
  const ts = [t0, ...samples.map((s) => s.t_s), t1];
  const out: { start_s: number; end_s: number }[] = [];
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > GAP_S + 1e-9) out.push({ start_s: ts[i - 1], end_s: ts[i] });
  return out;
}

/** Shoulder to elbow to wrist, metres: the median over the frames that saw all three, or null under three such frames. */
export function armLength(frames: TokenFrame[], side: HandSide, t0: number, t1: number): number | null {
  const j = JOINTS[side];
  const wrist = j.hand[0];
  const lengths = frames
    .filter((f) => inWindow(f, t0, t1) && seen(f, j.shoulder) && seen(f, j.elbow) && seen(f, wrist))
    .map((f) => d3(f.pose!.world[j.shoulder], f.pose!.world[j.elbow]) + d3(f.pose!.world[j.elbow], f.pose!.world[wrist]))
    .sort((a, b) => a - b);
  if (lengths.length < 3) return null;
  return lengths[Math.floor(lengths.length / 2)];
}

/** How far the hand travelled in its frontal plane, metres. */
export function travel(samples: HandSample[]): number {
  let sum = 0;
  for (let i = 1; i < samples.length; i++) sum += Math.hypot(samples[i].x_m - samples[i - 1].x_m, samples[i].y_m - samples[i - 1].y_m);
  return sum;
}

/** The hand that travelled further between t0 and t1, or null when neither was seen twice. */
export function busierHand(frames: TokenFrame[], t0: number, t1: number): HandSide | null {
  const [l, r] = (["left", "right"] as const).map((side) => handSamples(frames, side, t0, t1));
  if (l.length < 2 && r.length < 2) return null;
  return travel(r) >= travel(l) ? "right" : "left";
}

/**
 * The clip times to decode for some windows (clip seconds, which are the track's own timestamps): the centres of a
 * 1/fps grid from 0, (k + 0.5) / fps, that fall in a window and before `end`. A frame is found by its start time,
 * so asking at a start rounded down would return the frame before it; one grid for every window means overlapping
 * windows ask for the same frames. Sorted, no repeats.
 */
export function sampleTimes(windows: [number, number][], end: number, fps: number): number[] {
  const out = new Set<number>();
  for (const [t0, t1] of windows) {
    for (let k = Math.max(0, Math.ceil(t0 * fps - 0.5 - 1e-9)); (k + 0.5) / fps <= t1 + 1e-9 && (k + 0.5) / fps < end; k++) out.add(Math.round(((k + 0.5) / fps) * 10000) / 10000);
  }
  return [...out].sort((a, b) => a - b);
}
