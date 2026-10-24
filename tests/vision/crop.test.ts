import { describe, expect, it } from "vitest";
import { CROP_FOREARMS, dedupeHands, MIN_CROP_PX, missingWrists, uncrop, wristCrop, type Crop } from "@/lib/vision/crop";
import { POSE } from "@/lib/vision/select";
import type { Point3 } from "@/lib/vision/types";

const W = 960;
const H = 540;
const ASPECT = W / H;

/** A pose with a torso and one arm per side; everything else parked off at the origin. */
function pose(opts: { leftElbow: Point3; leftWrist: Point3; rightElbow?: Point3; rightWrist?: Point3; visibility?: number; leftFingers?: Point3[] }) {
  const image: Point3[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  const visibility = Array.from({ length: 33 }, () => opts.visibility ?? 0.9);
  // finger points hidden unless the test places them, so the forearm fallback is what is measured
  for (const i of [POSE.LEFT_PINKY, POSE.LEFT_INDEX, POSE.LEFT_THUMB, POSE.RIGHT_PINKY, POSE.RIGHT_INDEX, POSE.RIGHT_THUMB]) visibility[i] = 0;
  if (opts.leftFingers) {
    [POSE.LEFT_PINKY, POSE.LEFT_INDEX, POSE.LEFT_THUMB].forEach((i, k) => {
      image[i] = opts.leftFingers![k];
      visibility[i] = 0.9;
    });
  }
  image[POSE.LEFT_SHOULDER] = { x: 0.6, y: 0.3, z: 0 };
  image[POSE.RIGHT_SHOULDER] = { x: 0.7, y: 0.3, z: 0 };
  image[POSE.LEFT_HIP] = { x: 0.6, y: 0.6, z: 0 };
  image[POSE.RIGHT_HIP] = { x: 0.7, y: 0.6, z: 0 };
  image[POSE.LEFT_ELBOW] = opts.leftElbow;
  image[POSE.LEFT_WRIST] = opts.leftWrist;
  image[POSE.RIGHT_ELBOW] = opts.rightElbow ?? { x: 0.75, y: 0.45, z: 0 };
  image[POSE.RIGHT_WRIST] = opts.rightWrist ?? { x: 0.8, y: 0.55, z: 0 };
  return { image, visibility };
}

const hand = (wrist: Point3) => ({ image: [wrist, ...Array.from({ length: 20 }, () => wrist)], world: [], score: 0.9 });

describe("wristCrop", () => {
  it("is a square CROP_FOREARMS forearms wide, centred a third of a forearm past the wrist when no finger point is visible", () => {
    // forearm: elbow (480, 270) to wrist (480, 324) px, straight down, 54 px long
    const p = pose({ leftElbow: { x: 0.5, y: 0.5, z: 0 }, leftWrist: { x: 0.5, y: 0.6, z: 0 } });
    const c = wristCrop(p, "left", W, H)!;
    expect(c.side).toBe(Math.round(CROP_FOREARMS * 54));
    expect(c.x0 + c.side / 2).toBeCloseTo(480, 0);
    expect(c.y0 + c.side / 2).toBeCloseTo(324 + 0.35 * 54, 0);
  });
  it("is centred on the wrist and the visible finger points when the pose has them", () => {
    const p = pose({
      leftElbow: { x: 0.5, y: 0.5, z: 0 },
      leftWrist: { x: 0.5, y: 0.6, z: 0 },
      leftFingers: [{ x: 0.52, y: 0.66, z: 0 }, { x: 0.54, y: 0.66, z: 0 }, { x: 0.56, y: 0.62, z: 0 }],
    });
    const c = wristCrop(p, "left", W, H)!;
    expect(c.x0 + c.side / 2).toBeCloseTo(((0.5 + 0.52 + 0.54 + 0.56) / 4) * W, 0);
    expect(c.y0 + c.side / 2).toBeCloseTo(((0.6 + 0.66 + 0.66 + 0.62) / 4) * H, 0);
  });
  it("never shrinks below the minimum and never leaves the frame", () => {
    const tiny = pose({ leftElbow: { x: 0.01, y: 0.01, z: 0 }, leftWrist: { x: 0.012, y: 0.012, z: 0 } });
    const c = wristCrop(tiny, "left", W, H)!;
    expect(c.side).toBe(MIN_CROP_PX);
    expect(c.x0).toBe(0);
    expect(c.y0).toBe(0);
    const edge = pose({ leftElbow: { x: 0.9, y: 0.9, z: 0 }, leftWrist: { x: 0.99, y: 0.99, z: 0 } });
    const e = wristCrop(edge, "left", W, H)!;
    expect(e.x0 + e.side).toBeLessThanOrEqual(W);
    expect(e.y0 + e.side).toBeLessThanOrEqual(H);
  });
  it("is capped by the frame's short side", () => {
    const huge = pose({ leftElbow: { x: 0.1, y: 0.1, z: 0 }, leftWrist: { x: 0.9, y: 0.9, z: 0 } });
    expect(wristCrop(huge, "left", W, H)!.side).toBe(H);
  });
  it("returns null for a hidden wrist or elbow, or an arm with no length", () => {
    const hidden = pose({ leftElbow: { x: 0.5, y: 0.5, z: 0 }, leftWrist: { x: 0.5, y: 0.6, z: 0 }, visibility: 0.2 });
    expect(wristCrop(hidden, "left", W, H)).toBeNull();
    const flat = pose({ leftElbow: { x: 0.5, y: 0.5, z: 0 }, leftWrist: { x: 0.5, y: 0.5, z: 0 } });
    expect(wristCrop(flat, "left", W, H)).toBeNull();
    expect(wristCrop({ image: [], visibility: [] }, "right", W, H)).toBeNull();
  });
});

describe("uncrop", () => {
  it("maps crop coordinates back into the frame, z on x's scale", () => {
    const crop: Crop = { x0: 100, y0: 50, side: 200 };
    const p = uncrop({ x: 0.5, y: 0.25, z: 0.1 }, crop, W, H);
    expect(p.x).toBeCloseTo(200 / W);
    expect(p.y).toBeCloseTo(100 / H);
    expect(p.z).toBeCloseTo((0.1 * 200) / W);
  });
  it("round-trips a wrist crop: the crop's centre is where the crop was aimed", () => {
    const p = pose({ leftElbow: { x: 0.5, y: 0.5, z: 0 }, leftWrist: { x: 0.5, y: 0.6, z: 0 } });
    const c = wristCrop(p, "left", W, H)!;
    const centre = uncrop({ x: 0.5, y: 0.5, z: 0 }, c, W, H);
    expect(centre.x * W).toBeCloseTo(c.x0 + c.side / 2, 5);
    expect(centre.y * H).toBeCloseTo(c.y0 + c.side / 2, 5);
  });
});

describe("missingWrists", () => {
  const p = pose({ leftElbow: { x: 0.5, y: 0.5, z: 0 }, leftWrist: { x: 0.5, y: 0.6, z: 0 } });
  it("names both wrists when no hand is near either", () => {
    expect(missingWrists(p.image, [], ASPECT)).toEqual(["left", "right"]);
  });
  it("skips a wrist that already has a hand within half a torso height", () => {
    const near = hand({ x: 0.505, y: 0.61, z: 0 }).image;
    expect(missingWrists(p.image, [near], ASPECT)).toEqual(["right"]);
  });
  it("still names a wrist whose nearest hand is too far to be its own", () => {
    const far = hand({ x: 0.1, y: 0.1, z: 0 }).image;
    expect(missingWrists(p.image, [far], ASPECT)).toEqual(["left", "right"]);
  });
});

describe("dedupeHands", () => {
  it("keeps the first of two detections of the same hand and both of two distinct hands", () => {
    const a = hand({ x: 0.5, y: 0.5, z: 0 });
    const aAgain = { ...hand({ x: 0.502, y: 0.501, z: 0 }), score: 0.1 };
    const b = hand({ x: 0.8, y: 0.5, z: 0 });
    const kept = dedupeHands([a, aAgain, b], ASPECT);
    expect(kept).toEqual([a, b]);
  });
  it("drops a hand with no landmarks", () => {
    expect(dedupeHands([{ image: [] }, hand({ x: 0.5, y: 0.5, z: 0 })], ASPECT)).toHaveLength(1);
  });
});
