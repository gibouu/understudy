/**
 * Second look for the hands a far camera hides. Station and workshop cameras
 * sit metres from the work, so a hand is twenty pixels wide in the sampled
 * frame and the Hand Landmarker's palm detector (192 px input) never sees it.
 * The pose model still finds the arm, so for every wrist without a hand nearby
 * a square around it is cut out, the Hand Landmarker runs on that crop, and the
 * landmarks come back in full-frame coordinates. Pure geometry here; the
 * canvas work is in `mediapipe.ts`.
 */
import { POSE, torso } from "./select";
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
 * The wrists of `pose` that no detected hand sits near, by the rule
 * `matchHands` uses to give a wrist a hand (half a torso height, at least 0.05
 * frame heights). Those are the wrists worth a crop.
 */
export function missingWrists(pose: Point3[], hands: Point3[][], aspect: number): HandSide[] {
  const limit = Math.max(0.05, torso(pose, aspect).height / 2);
  const sides: HandSide[] = [];
  for (const side of ["left", "right"] as const) {
    const wrist = pose[side === "left" ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST];
    if (!wrist) continue;
    if (!hands.some((h) => h[0] && dist(h[0], wrist, aspect) <= limit)) sides.push(side);
  }
  return sides;
}

/**
 * Drop a hand whose wrist landmark lies within `minGap` frame heights of a hand
 * already kept: two crops that overlap see the same hand twice.
 */
export function dedupeHands<T extends { image: Point3[] }>(hands: T[], aspect: number, minGap = 0.02): T[] {
  const kept: T[] = [];
  for (const h of hands) {
    if (!h.image[0]) continue;
    if (kept.some((k) => dist(k.image[0], h.image[0], aspect) < minGap)) continue;
    kept.push(h);
  }
  return kept;
}
