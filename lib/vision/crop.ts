/**
 * Second look for the hands a far camera hides. Station and workshop cameras
 * sit metres from the work, so a hand is twenty pixels wide in the sampled
 * frame and the Hand Landmarker's palm detector (192 px input) never sees it.
 * The pose model still finds the arm, so for every wrist the full frame left
 * without a hand a square around it is cut out, the Hand Landmarker runs on
 * that crop, and the landmarks come back in full-frame coordinates.
 *
 * A crop is made for one person's one wrist (or both, when they are close),
 * and what it finds is attached to that wrist only: it never joins the pool of
 * full-frame hands, so it cannot steal another wrist. A find must also be the
 * person's own by the frame-wide nearest-wrist rule, and the crop budget goes
 * to the tracked person first. Pure geometry here; the canvas work is in
 * `mediapipe.ts`.
 */
import { matchHands, pickPerson, POSE, torso } from "./select";
import type { HandSide, Point3 } from "./types";

/** A square window in the sampled frame, pixels. */
export type Crop = { x0: number; y0: number; side: number };

/** Smallest crop worth running the model on. */
export const MIN_CROP_PX = 64;
/** Crop side in forearm lengths (a hand with spread fingers is about two; the extra forgives a wrist a few pixels off). */
export const CROP_FOREARMS = 4;
/** Fallback crop centre when the pose's finger points are not visible: this far past the wrist along the forearm. */
export const CROP_SHIFT = 0.35;
/**
 * No crop below this forearm length: the hand would be under about eight pixels,
 * which the palm detector cannot find even upscaled, and positions that small
 * cannot tell two hands apart.
 */
export const MIN_FOREARM_PX = 12;
/** A person's wrists closer than this many forearms share one crop. */
export const JOINT_FOREARMS = 1.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * The window around one hand, or null when the wrist or the elbow is not
 * visible enough or the forearm is shorter than `MIN_FOREARM_PX`. Centred on
 * the hand: the pose model's own pinky, index and thumb points when they are visible, else a
 * point past the wrist along the forearm. `CROP_FOREARMS` forearms wide, at
 * least `MIN_CROP_PX`, never larger than the frame, kept inside it.
 */
export function wristCrop(
  pose: { image: Point3[]; visibility: number[] },
  side: HandSide,
  width: number,
  height: number,
  minVisibility = 0.5,
): Crop | null {
  const wi = side === "left" ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST;
  const ei = side === "left" ? POSE.LEFT_ELBOW : POSE.RIGHT_ELBOW;
  const wrist = pose.image[wi];
  const elbow = pose.image[ei];
  if (!wrist || !elbow) return null;
  if ((pose.visibility[wi] ?? 0) < minVisibility || (pose.visibility[ei] ?? 0) < minVisibility) return null;
  const fx = (wrist.x - elbow.x) * width;
  const fy = (wrist.y - elbow.y) * height;
  const forearm = Math.hypot(fx, fy);
  if (!Number.isFinite(forearm) || forearm < MIN_FOREARM_PX) return null;
  const side_px = Math.round(clamp(CROP_FOREARMS * forearm, MIN_CROP_PX, Math.min(width, height)));
  const fingers = (side === "left" ? [POSE.LEFT_PINKY, POSE.LEFT_INDEX, POSE.LEFT_THUMB] : [POSE.RIGHT_PINKY, POSE.RIGHT_INDEX, POSE.RIGHT_THUMB])
    .filter((i) => pose.image[i] && (pose.visibility[i] ?? 0) >= minVisibility)
    .map((i) => pose.image[i]);
  let cx: number;
  let cy: number;
  if (fingers.length > 0) {
    const pts = [wrist, ...fingers];
    cx = (pts.reduce((a, p) => a + p.x, 0) / pts.length) * width;
    cy = (pts.reduce((a, p) => a + p.y, 0) / pts.length) * height;
  } else {
    cx = wrist.x * width + (fx / forearm) * CROP_SHIFT * forearm;
    cy = wrist.y * height + (fy / forearm) * CROP_SHIFT * forearm;
  }
  return {
    x0: Math.round(clamp(cx - side_px / 2, 0, width - side_px)),
    y0: Math.round(clamp(cy - side_px / 2, 0, height - side_px)),
    side: side_px,
  };
}

/** A landmark detected on `crop`, back in full-frame normalized coordinates. */
export function uncrop(p: Point3, crop: Crop, width: number, height: number): Point3 {
  return {
    x: (crop.x0 + p.x * crop.side) / width,
    y: (crop.y0 + p.y * crop.side) / height,
    // z shares x's scale in MediaPipe's normalized landmarks
    z: (p.z * crop.side) / width,
  };
}

const dist = (a: Point3, b: Point3, aspect: number) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

/**
 * The wrists of person `selected` that `matchHands` leaves without a hand:
 * the same ownership rule (a hand belongs to the nearest wrist of anyone in
 * frame) and the same one-to-one assignment, so a hand that sits near both
 * wrists still leaves the other wrist missing, and a neighbour's hand reaching
 * across never counts as ours. Those are the wrists worth a crop.
 */
export function missingWrists(poses: Point3[][], selected: number, hands: Point3[][], aspect: number): HandSide[] {
  const m = matchHands(poses, selected, hands, aspect);
  const sides: HandSide[] = [];
  if (m.left === null) sides.push("left");
  if (m.right === null) sides.push("right");
  return sides;
}

/** Below this mean landmark distance (frame heights, about a pixel at 540 px) two detections are one hand whatever their span. */
export const SAME_HAND_FLOOR = 0.002;

/** Mean distance between corresponding landmarks of two hands, frame heights; Infinity when they cannot be compared. */
export function landmarkDistance(a: Point3[], b: Point3[], aspect: number): number {
  if (a.length === 0 || a.length !== b.length) return Infinity;
  let mean = 0;
  for (let i = 0; i < a.length; i++) mean += dist(a[i], b[i], aspect);
  return mean / a.length;
}

/**
 * Two detections are the same hand when their landmarks lie on top of each
 * other: the mean landmark distance is under a fifth of the hand's own span.
 * Two touching hands share a wrist position but not their fingers, so they
 * stay apart.
 */
export function sameHand(a: Point3[], b: Point3[], aspect: number): boolean {
  const mean = landmarkDistance(a, b, aspect);
  if (!Number.isFinite(mean)) return false;
  let span = 0;
  for (const q of a) span = Math.max(span, dist(a[0], q, aspect));
  return mean < Math.max(SAME_HAND_FLOOR, 0.2 * span);
}

/** The square that covers two crops, kept inside the frame. */
export function hull(a: Crop, b: Crop, width: number, height: number): Crop {
  const x0 = Math.min(a.x0, b.x0);
  const y0 = Math.min(a.y0, b.y0);
  const x1 = Math.max(a.x0 + a.side, b.x0 + b.side);
  const y1 = Math.max(a.y0 + a.side, b.y0 + b.side);
  const side = Math.min(Math.max(x1 - x0, y1 - y0), Math.min(width, height));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return {
    x0: Math.round(clamp(cx - side / 2, 0, width - side)),
    y0: Math.round(clamp(cy - side / 2, 0, height - side)),
    side,
  };
}

const wristOf = (pose: Point3[], side: HandSide) => pose[side === "left" ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST];
const elbowOf = (pose: Point3[], side: HandSide) => pose[side === "left" ? POSE.LEFT_ELBOW : POSE.RIGHT_ELBOW];
const otherSide = (side: HandSide): HandSide => (side === "left" ? "right" : "left");

/**
 * True when the person's two wrists are closer than `JOINT_FOREARMS` of their
 * shorter forearm: hands that close cannot be told apart by which wrist they
 * sit nearer, so one crop looks at both and the picker does not use that rule.
 */
export function wristsClose(pose: Point3[], width: number, height: number): boolean {
  const px = (a: Point3, b: Point3) => Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
  const l = wristOf(pose, "left");
  const r = wristOf(pose, "right");
  const le = elbowOf(pose, "left");
  const re = elbowOf(pose, "right");
  if (!l || !r || !le || !re) return false;
  const forearm = Math.min(px(l, le), px(r, re));
  if (!(forearm > 0)) return true;
  return px(l, r) < JOINT_FOREARMS * forearm;
}

/** The crops to run for one person: which window, for which of their wrists. */
export type CropPlan = { close: boolean; windows: { win: Crop; sides: HandSide[] }[] };

/**
 * Plan the crops for the `missing` wrists of `pose`. Two missing wrists that
 * are close share one window (one inference never returns the same hand
 * twice, so the two hands found there are distinct); otherwise one window per
 * missing wrist.
 */
export function cropPlan(
  pose: { image: Point3[]; visibility: number[] },
  missing: HandSide[],
  width: number,
  height: number,
): CropPlan {
  const close = wristsClose(pose.image, width, height);
  const wins = new Map<HandSide, Crop>();
  for (const side of missing) {
    const win = wristCrop(pose, side, width, height);
    if (win) wins.set(side, win);
  }
  const l = wins.get("left");
  const r = wins.get("right");
  if (close && l && r) return { close, windows: [{ win: hull(l, r, width, height), sides: ["left", "right"] }] };
  return { close, windows: [...wins.entries()].map(([side, win]) => ({ win, sides: [side] })) };
}

/** What the picker needs to know about the frame around one crop. */
export type PickContext = {
  /** every pose in the frame, image landmarks */
  poses: Point3[][];
  /** index into `poses` of the person the crop was made for */
  person: number;
  /** the wrists the crop was made for */
  sides: HandSide[];
  aspect: number;
  /** the person's wrists are close (`wristsClose`) */
  close: boolean;
  /** every hand already placed this frame: full-frame detections and earlier crop finds */
  taken: Point3[][];
  /** the person's own full-frame hands, on the wrists not in `sides` */
  held: Point3[][];
};

/**
 * Which of a crop's detections belong to which of `ctx.sides`. A detection can
 * go to a wrist when:
 * - its wrist landmark is within `matchHands`' reach of that wrist (half a
 *   torso height, at least 0.05 frame heights);
 * - its nearest wrist among everyone in the frame is this person's, as in
 *   `matchHands` (a neighbour's hand stays the neighbour's);
 * - it is nearer this wrist than the person's other wrist, unless the wrists
 *   are close and that test means nothing;
 * - it is not the same hand as one already placed this frame.
 * When the wrists are close and one of them already holds a hand, the crop
 * sees that hand too: the detection most like it is set aside, and a crop with
 * a single detection attaches nothing, since there is no telling which hand
 * it saw. Then the one-to-one assignment that places the most hands, then the
 * shortest total distance. Returns the detection index per side.
 */
export function pickCropHands(candidates: Point3[][], ctx: PickContext): Partial<Record<HandSide, number>> {
  const { poses, person, sides, aspect, close, taken, held } = ctx;
  const pose = poses[person];
  let pool = candidates.map((_, i) => i);
  if (close && held.length > 0) {
    if (candidates.length < 2) return {};
    let copy = -1;
    let nearest = Infinity;
    for (const i of pool) {
      const d = Math.min(...held.map((h) => landmarkDistance(h, candidates[i], aspect)));
      if (d < nearest) {
        nearest = d;
        copy = i;
      }
    }
    pool = pool.filter((i) => i !== copy);
  }
  const limit = Math.max(0.05, torso(pose, aspect).height / 2);
  const own = [wristOf(pose, "left"), wristOf(pose, "right")].filter((w): w is Point3 => Boolean(w));
  const others = poses.flatMap((p, k) =>
    k === person ? [] : [wristOf(p, "left"), wristOf(p, "right")].filter((w): w is Point3 => Boolean(w)),
  );
  const reach = (i: number, side: HandSide): number | null => {
    const c = candidates[i];
    const w = wristOf(pose, side);
    if (!c?.[0] || !w) return null;
    const d = dist(c[0], w, aspect);
    if (d > limit) return null;
    const mine = Math.min(...own.map((x) => dist(c[0], x, aspect)));
    if (others.some((x) => dist(c[0], x, aspect) <= mine)) return null;
    if (!close) {
      const o = wristOf(pose, otherSide(side));
      if (o && !(d < dist(c[0], o, aspect))) return null;
    }
    if (taken.some((e) => sameHand(e, c, aspect))) return null;
    return d;
  };
  const options = sides.map((side) => [
    null,
    ...pool.flatMap((i) => {
      const d = reach(i, side);
      return d === null ? [] : [{ i, d }];
    }),
  ]);
  let best: { picks: (number | null)[]; count: number; total: number } = { picks: sides.map(() => null), count: 0, total: 0 };
  const walk = (k: number, picks: (number | null)[], count: number, total: number) => {
    if (k === sides.length) {
      if (count > best.count || (count === best.count && total < best.total)) best = { picks: [...picks], count, total };
      return;
    }
    for (const o of options[k]) {
      if (o && picks.includes(o.i)) continue;
      picks.push(o ? o.i : null);
      walk(k + 1, picks, count + (o ? 1 : 0), total + (o ? o.d : 0));
      picks.pop();
    }
  };
  walk(0, [], 0, 0);
  const out: Partial<Record<HandSide, number>> = {};
  sides.forEach((side, k) => {
    const pick = best.picks[k];
    if (pick !== null && pick !== undefined) out[side] = pick;
  });
  return out;
}

/**
 * The order in which people get crops, so the cap goes to the person who
 * matters first: nearest the page's tracked hip (`focus`, from the previous
 * frame), or, before tracking starts, the person `pickPerson` would choose,
 * then everyone else in detection order.
 */
export function cropOrder(poses: Point3[][], aspect: number, focus: { x: number; y: number } | null): number[] {
  const idx = poses.map((_, i) => i);
  if (focus) {
    const d = idx.map((i) => {
      const hip = torso(poses[i], aspect).hip;
      return Math.hypot((hip.x - focus.x) * aspect, hip.y - focus.y);
    });
    return idx.sort((a, b) => d[a] - d[b] || a - b);
  }
  const first = pickPerson(poses, aspect);
  return first === null ? idx : [first, ...idx.filter((i) => i !== first)];
}
