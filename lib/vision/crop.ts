/**
 * Second look for the hands a far camera hides. Station and workshop cameras
 * sit metres from the work, so a hand is twenty pixels wide in the sampled
 * frame and the Hand Landmarker's palm detector (192 px input) never sees it.
 * The pose model still finds the arm, so for every wrist without a hand nearby
 * a square around it is cut out, the Hand Landmarker runs on that crop, and the
 * landmarks come back in full-frame coordinates. Pure geometry here; the
 * canvas work is in `mediapipe.ts`.
 */
import { matchHands, POSE, torso } from "./select";
import type { HandSide, Point3 } from "./types";

/** A square window in the sampled frame, pixels. */
export type Crop = { x0: number; y0: number; side: number };

/** Smallest crop worth running the model on. */
export const MIN_CROP_PX = 64;
/** Crop side in forearm lengths (a hand with spread fingers is about two; the extra forgives a wrist a few pixels off). */
export const CROP_FOREARMS = 4;
/** Fallback crop centre when the pose's finger points are not visible: this far past the wrist along the forearm. */
export const CROP_SHIFT = 0.35;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * The window around one hand, or null when the wrist or the elbow is not
 * visible enough or the arm has no length. Centred on the hand: the pose
 * model's own pinky, index and thumb points when they are visible, else a
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
  if (!(forearm > 0) || !Number.isFinite(forearm)) return null;
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

/**
 * Whether a hand found on the crop for wrist `side` of `pose` can be that
 * wrist's hand, and how far its wrist landmark is from it (frame heights):
 * within `matchHands`' reach (half a torso height, at least 0.05) and strictly
 * nearer to this wrist than to the person's other wrist. A crop that re-detects
 * the hand already sitting on the other wrist (a jittered copy) fails here,
 * whatever the duplicate threshold says, so it cannot steal this wrist.
 * Returns null when the hand is not acceptable.
 */
export function cropHandReach(hand: Point3[], pose: Point3[], side: HandSide, aspect: number): number | null {
  const own = pose[side === "left" ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST];
  const other = pose[side === "left" ? POSE.RIGHT_WRIST : POSE.LEFT_WRIST];
  if (!hand[0] || !own) return null;
  const limit = Math.max(0.05, torso(pose, aspect).height / 2);
  const d = dist(hand[0], own, aspect);
  if (d > limit) return null;
  if (other && !(d < dist(hand[0], other, aspect))) return null;
  return d;
}

/** Below this mean landmark distance (frame heights, about a pixel at 540 px) two detections are one hand whatever their span. */
export const SAME_HAND_FLOOR = 0.002;

/**
 * Two detections are the same hand when their landmarks lie on top of each
 * other: the mean landmark distance is under a fifth of the hand's own span.
 * Two touching hands share a wrist position but not their fingers, so they
 * stay, at any scale: the floor is a pixel, not a fixed fraction of the frame.
 */
export function sameHand(a: Point3[], b: Point3[], aspect: number): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let mean = 0;
  let span = 0;
  for (let i = 0; i < a.length; i++) {
    mean += dist(a[i], b[i], aspect);
    span = Math.max(span, dist(a[0], a[i], aspect));
  }
  mean /= a.length;
  return mean < Math.max(SAME_HAND_FLOOR, 0.2 * span);
}

/**
 * Add a crop-found hand unless it is the same hand as one already in the list
 * (two overlapping crops see it twice). Called as crops run, so a duplicate
 * never gets to decide which wrists of the next person still need a crop.
 * Returns true when the hand was added.
 */
export function addHand<T extends { image: Point3[]; cropped?: boolean }>(hands: T[], hand: T, aspect: number): boolean {
  if (hand.image.length === 0) return false;
  if (hand.cropped && hands.some((k) => sameHand(k.image, hand.image, aspect))) return false;
  hands.push(hand);
  return true;
}

/**
 * The same rule over a whole list: full-frame detections are always kept, a
 * crop-found hand only when it is not a copy of one already kept.
 */
export function dedupeHands<T extends { image: Point3[]; cropped?: boolean }>(hands: T[], aspect: number): T[] {
  const kept: T[] = [];
  for (const h of hands) if (!h.cropped) kept.push(h);
  for (const h of hands) if (h.cropped) addHand(kept, h, aspect);
  return kept;
}
