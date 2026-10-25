import { describe, expect, it } from "vitest";
import { CROP_FOREARMS, CROP_SHIFT, cropOrder, cropPlan, hull, MIN_CROP_PX, MIN_FOREARM_PX, missingWrists, pickCropHands, sameHand, uncrop, wristCrop, wristsClose, type Crop, type PickContext } from "@/lib/vision/crop";
import { POSE, selectFrame, TRACK_START, type CropHand } from "@/lib/vision/select";
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
  it("is skipped for a forearm under MIN_FOREARM_PX: the hand would be too small to find or to tell apart", () => {
    // forearm hypot(1.92, 1.08) = 2.2 px
    const tiny = pose({ leftElbow: { x: 0.01, y: 0.01, z: 0 }, leftWrist: { x: 0.012, y: 0.012, z: 0 } });
    expect(wristCrop(tiny, "left", W, H)).toBeNull();
  });
  it("never shrinks below the minimum and never leaves the frame", () => {
    // forearm hypot(11.52, 6.48) = 13.2 px, just above MIN_FOREARM_PX; four forearms is under MIN_CROP_PX
    const tiny = pose({ leftElbow: { x: 0.01, y: 0.01, z: 0 }, leftWrist: { x: 0.022, y: 0.022, z: 0 } });
    expect(Math.hypot(0.012 * W, 0.012 * H)).toBeGreaterThan(MIN_FOREARM_PX);
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
  it("maps the crop's centre back to the point the crop was aimed at, computed independently", () => {
    // forearm straight down, 54 px: the aim is the wrist plus CROP_SHIFT forearms further down
    const p = pose({ leftElbow: { x: 0.5, y: 0.5, z: 0 }, leftWrist: { x: 0.5, y: 0.6, z: 0 } });
    const c = wristCrop(p, "left", W, H)!;
    const centre = uncrop({ x: 0.5, y: 0.5, z: 0 }, c, W, H);
    expect(centre.x).toBeCloseTo(0.5, 2);
    expect(centre.y).toBeCloseTo(0.6 + (CROP_SHIFT * 54) / H, 2);
  });
});

describe("missingWrists", () => {
  const p = pose({ leftElbow: { x: 0.5, y: 0.5, z: 0 }, leftWrist: { x: 0.5, y: 0.6, z: 0 } });
  const poses = [p.image];
  it("names both wrists when no hand is near either", () => {
    expect(missingWrists(poses, 0, [], ASPECT)).toEqual(["left", "right"]);
  });
  it("skips a wrist that already has a hand within half a torso height", () => {
    const near = hand({ x: 0.505, y: 0.61, z: 0 }).image;
    expect(missingWrists(poses, 0, [near], ASPECT)).toEqual(["right"]);
  });
  it("still names a wrist whose nearest hand is too far to be its own", () => {
    const far = hand({ x: 0.1, y: 0.1, z: 0 }).image;
    expect(missingWrists(poses, 0, [far], ASPECT)).toEqual(["left", "right"]);
  });
  it("still names the second wrist when one hand sits near both wrists", () => {
    // wrists 0.02 apart, one hand between them: matchHands gives it to one wrist only
    const close = pose({ leftElbow: { x: 0.49, y: 0.5, z: 0 }, leftWrist: { x: 0.49, y: 0.6, z: 0 }, rightElbow: { x: 0.51, y: 0.5, z: 0 }, rightWrist: { x: 0.51, y: 0.6, z: 0 } });
    const between = hand({ x: 0.5, y: 0.6, z: 0 }).image;
    expect(missingWrists([close.image], 0, [between], ASPECT)).toHaveLength(1);
  });
  it("does not count a neighbour's hand that reaches near our wrist", () => {
    const neighbour = pose({ leftElbow: { x: 0.3, y: 0.5, z: 0 }, leftWrist: { x: 0.5, y: 0.61, z: 0 }, rightElbow: { x: 0.2, y: 0.5, z: 0 }, rightWrist: { x: 0.2, y: 0.6, z: 0 } });
    // the hand is nearer the neighbour's left wrist than ours, so it is theirs
    const theirs = hand({ x: 0.5, y: 0.612, z: 0 }).image;
    expect(missingWrists([p.image, neighbour.image], 0, [theirs], ASPECT)).toEqual(["left", "right"]);
  });
});

/** A hand with the fingers fanned out `angle` radians from straight down, span `span` frame heights (0.1 by default). */
function fanned(wrist: Point3, angle: number, span = 0.1) {
  const image: Point3[] = [wrist];
  for (let i = 1; i <= 20; i++) {
    const r = span * (i / 20);
    const a = angle + ((i % 5) - 2) * 0.15;
    image.push({ x: wrist.x + (r * Math.sin(a)) / ASPECT, y: wrist.y + r * Math.cos(a), z: 0 });
  }
  return image;
}

const shift = (h: Point3[], dx_px: number, dy_px: number) => h.map((q) => ({ ...q, x: q.x + dx_px / W, y: q.y + dy_px / H }));

describe("sameHand", () => {
  it("calls two detections of one hand the same when every landmark lies on top of the other", () => {
    const a = fanned({ x: 0.5, y: 0.5, z: 0 }, 0);
    expect(sameHand(a, shift(a, 1, -1), ASPECT)).toBe(true);
  });
  it("keeps two hands whose wrists almost coincide but whose fingers point apart", () => {
    const a = fanned({ x: 0.5, y: 0.6, z: 0 }, 0.6);
    const b = fanned({ x: 0.51, y: 0.6, z: 0 }, -0.6);
    expect(sameHand(a, b, ASPECT)).toBe(false);
  });
  it("is false for different landmark counts or an empty hand", () => {
    const a = fanned({ x: 0.5, y: 0.5, z: 0 }, 0);
    expect(sameHand(a, a.slice(0, 10), ASPECT)).toBe(false);
    expect(sameHand([], [], ASPECT)).toBe(false);
  });
});

describe("hull", () => {
  it("is the square covering both crops, inside the frame", () => {
    const c = hull({ x0: 100, y0: 100, side: 80 }, { x0: 150, y0: 120, side: 80 }, W, H);
    expect(c.side).toBe(130);
    expect(c.x0).toBeLessThanOrEqual(100);
    expect(c.x0 + c.side).toBeGreaterThanOrEqual(230);
    expect(c.y0).toBeLessThanOrEqual(100);
    expect(c.y0 + c.side).toBeGreaterThanOrEqual(200);
  });
  it("is capped by the frame and kept inside it", () => {
    const c = hull({ x0: 0, y0: 0, side: 500 }, { x0: 400, y0: 40, side: 500 }, W, H);
    expect(c.side).toBe(H);
    expect(c.y0).toBe(0);
    expect(c.x0 + c.side).toBeLessThanOrEqual(W);
  });
});

// forearms 54 px long, straight down
const apart = pose({ leftElbow: { x: 0.4, y: 0.5, z: 0 }, leftWrist: { x: 0.4, y: 0.6, z: 0 }, rightElbow: { x: 0.6, y: 0.5, z: 0 }, rightWrist: { x: 0.6, y: 0.6, z: 0 } });
// wrists 9.6 px apart, well under 1.5 forearms
const close = pose({ leftElbow: { x: 0.5, y: 0.5, z: 0 }, leftWrist: { x: 0.5, y: 0.6, z: 0 }, rightElbow: { x: 0.51, y: 0.5, z: 0 }, rightWrist: { x: 0.51, y: 0.6, z: 0 } });
// wrists on the same point
const crossed = pose({ leftElbow: { x: 0.45, y: 0.5, z: 0 }, leftWrist: { x: 0.5, y: 0.6, z: 0 }, rightElbow: { x: 0.55, y: 0.5, z: 0 }, rightWrist: { x: 0.5, y: 0.6, z: 0 } });

describe("wristsClose and cropPlan", () => {
  it("tells close wrists from wrists apart", () => {
    expect(wristsClose(apart.image, W, H)).toBe(false);
    expect(wristsClose(close.image, W, H)).toBe(true);
    expect(wristsClose(crossed.image, W, H)).toBe(true);
  });
  it("gives two missing wrists apart a window each", () => {
    const plan = cropPlan(apart, ["left", "right"], W, H);
    expect(plan.close).toBe(false);
    expect(plan.windows.map((w) => w.sides)).toEqual([["left"], ["right"]]);
  });
  it("gives two missing close wrists one shared window covering both", () => {
    const plan = cropPlan(close, ["left", "right"], W, H);
    expect(plan.close).toBe(true);
    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0].sides).toEqual(["left", "right"]);
    const l = wristCrop(close, "left", W, H)!;
    const r = wristCrop(close, "right", W, H)!;
    const w = plan.windows[0].win;
    expect(w.x0).toBeLessThanOrEqual(Math.min(l.x0, r.x0));
    expect(w.x0 + w.side).toBeGreaterThanOrEqual(Math.max(l.x0 + l.side, r.x0 + r.side));
  });
  it("gives one missing wrist its own window, close or not", () => {
    expect(cropPlan(close, ["right"], W, H).windows.map((w) => w.sides)).toEqual([["right"]]);
  });
});

/** A picker context for one person alone in frame, nothing placed yet. */
const ctx = (p: { image: Point3[] }, sides: PickContext["sides"], over: Partial<PickContext> = {}): PickContext => ({
  poses: [p.image],
  person: 0,
  sides,
  aspect: ASPECT,
  close: wristsClose(p.image, W, H),
  taken: [],
  held: [],
  ...over,
});

describe("pickCropHands", () => {
  it("with close wrists and one hand held, sets aside the detection most like the held hand, even past sameHand's cutoff", () => {
    // a 22 px hand held on the left wrist; the right wrist's crop sees it again 5 px off (past sameHand's 4.3 px
    // cutoff, the case that used to attach) and the right hand, 7.2 px from the held one in landmark terms. The
    // rule is relative, so it holds while the jitter stays under the gap between the two real hands; beyond that
    // no position-based rule can tell them apart.
    const held = fanned({ x: 0.5, y: 0.6, z: 0 }, 0.6, 0.04);
    const copy = shift(held, 5, 0);
    expect(sameHand(held, copy, ASPECT)).toBe(false);
    const right = fanned({ x: 0.51, y: 0.6, z: 0 }, -0.6, 0.04);
    expect(pickCropHands([copy, right], ctx(close, ["right"], { held: [held], taken: [held] }))).toEqual({ right: 1 });
    expect(pickCropHands([right, copy], ctx(close, ["right"], { held: [held], taken: [held] }))).toEqual({ right: 0 });
  });
  it("with close wrists and one hand held, attaches nothing from a crop that found a single hand", () => {
    const held = fanned({ x: 0.5, y: 0.6, z: 0 }, 0.6, 0.04);
    const right = fanned({ x: 0.51, y: 0.6, z: 0 }, -0.6, 0.04);
    expect(pickCropHands([shift(held, 5, 0)], ctx(close, ["right"], { held: [held], taken: [held] }))).toEqual({});
    expect(pickCropHands([right], ctx(close, ["right"], { held: [held], taken: [held] }))).toEqual({});
  });
  it("gives a shared window's two distinct hands one wrist each when the wrists coincide", () => {
    const a = fanned({ x: 0.5, y: 0.6, z: 0 }, 0.6, 0.04);
    const b = fanned({ x: 0.5, y: 0.6, z: 0 }, -0.6, 0.04);
    const picks = pickCropHands([a, b], ctx(crossed, ["left", "right"]));
    expect(new Set([picks.left, picks.right])).toEqual(new Set([0, 1]));
  });
  it("never gives one detection to both wrists", () => {
    const only = fanned({ x: 0.5, y: 0.6, z: 0 }, 0, 0.04);
    expect(Object.keys(pickCropHands([only], ctx(crossed, ["left", "right"])))).toHaveLength(1);
  });
  it("keeps the nearer-wrist rule for wrists apart: a hand by the left wrist never goes to the right one", () => {
    const left = fanned({ x: 0.4, y: 0.6, z: 0 }, 0);
    expect(pickCropHands([left], ctx(apart, ["right"]))).toEqual({});
    expect(pickCropHands([left], ctx(apart, ["left"]))).toEqual({ left: 0 });
  });
  it("takes the nearest of several acceptable hands and rejects one beyond reach", () => {
    const near = fanned({ x: 0.6, y: 0.61, z: 0 }, 0);
    const nearer = fanned({ x: 0.6, y: 0.605, z: 0 }, 0.3);
    const far = fanned({ x: 0.6, y: 0.95, z: 0 }, 0);
    expect(pickCropHands([near, far, nearer], ctx(apart, ["right"]))).toEqual({ right: 2 });
    expect(pickCropHands([far], ctx(apart, ["right"]))).toEqual({});
  });
  it("leaves a neighbour's hand to the neighbour, as matchHands would", () => {
    // our right wrist at (0.6, 0.6); the neighbour's left wrist at (0.6, 0.61); the hand sits at (0.6, 0.612)
    const neighbour = pose({ leftElbow: { x: 0.6, y: 0.7, z: 0 }, leftWrist: { x: 0.6, y: 0.61, z: 0 }, rightElbow: { x: 0.8, y: 0.7, z: 0 }, rightWrist: { x: 0.8, y: 0.6, z: 0 } });
    const theirs = fanned({ x: 0.6, y: 0.612, z: 0 }, 0);
    const c = ctx(apart, ["right"], { poses: [apart.image, neighbour.image] });
    expect(pickCropHands([theirs], c)).toEqual({});
    // the same hand with nobody else in frame is ours
    expect(pickCropHands([theirs], ctx(apart, ["right"]))).toEqual({ right: 0 });
  });
  it("refuses a hand already placed this frame, by anyone", () => {
    const placed = fanned({ x: 0.6, y: 0.61, z: 0 }, 0);
    expect(pickCropHands([shift(placed, 1, 0)], ctx(apart, ["right"], { taken: [placed] }))).toEqual({});
  });
});

describe("cropOrder", () => {
  const at = (x: number) => {
    const p = pose({ leftElbow: { x, y: 0.5, z: 0 }, leftWrist: { x, y: 0.6, z: 0 }, rightElbow: { x: x + 0.05, y: 0.5, z: 0 }, rightWrist: { x: x + 0.05, y: 0.6, z: 0 } });
    for (const i of [POSE.LEFT_SHOULDER, POSE.LEFT_HIP]) p.image[i] = { ...p.image[i], x };
    for (const i of [POSE.RIGHT_SHOULDER, POSE.RIGHT_HIP]) p.image[i] = { ...p.image[i], x: x + 0.1 };
    return p.image;
  };
  const three = [at(0.05), at(0.75), at(0.45)];
  it("puts the person nearest the tracked hip first", () => {
    expect(cropOrder(three, ASPECT, { x: 0.5, y: 0.6 })[0]).toBe(2);
    expect(cropOrder(three, ASPECT, { x: 0.1, y: 0.6 })[0]).toBe(0);
  });
  it("before tracking starts, puts the person pickPerson would choose first", () => {
    expect(cropOrder(three, ASPECT, null)[0]).toBe(2);
    expect([...cropOrder(three, ASPECT, null)].sort()).toEqual([0, 1, 2]);
  });
});

describe("selectFrame with crop finds", () => {
  const toks = (p: { image: Point3[]; visibility: number[] }) => ({ image: p.image, world: p.image, visibility: p.visibility });
  const found = (wrist: Point3) => ({ image: fanned(wrist, 0), world: [], score: 0.8, cropped: true });
  it("fills an empty wrist of the tracked person with the find made for that person and wrist only", () => {
    const other = pose({ leftElbow: { x: 0.1, y: 0.5, z: 0 }, leftWrist: { x: 0.1, y: 0.6, z: 0 }, rightElbow: { x: 0.2, y: 0.5, z: 0 }, rightWrist: { x: 0.2, y: 0.6, z: 0 } });
    // shift the other person's torso away from the centre so the presenter (apart) is picked
    for (const i of [POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER, POSE.LEFT_HIP, POSE.RIGHT_HIP]) other.image[i] = { ...other.image[i], x: other.image[i].x - 0.5 };
    const crops: CropHand[] = [
      { person: 1, side: "left", hand: found({ x: 0.1, y: 0.6, z: 0 }) },
      { person: 0, side: "right", hand: found({ x: 0.6, y: 0.6, z: 0 }) },
    ];
    const { frame } = selectFrame(0, [toks(apart), toks(other)], [], TRACK_START, ASPECT, crops);
    expect(frame.person_index).toBe(0);
    expect(frame.left_hand).toBeNull();
    expect(frame.right_hand?.cropped).toBe(true);
    expect(frame.right_hand?.image[0]).toEqual({ x: 0.6, y: 0.6, z: 0 });
  });
  it("follows the tracked person's index, not the first pose", () => {
    const other = pose({ leftElbow: { x: 0.1, y: 0.5, z: 0 }, leftWrist: { x: 0.1, y: 0.6, z: 0 }, rightElbow: { x: 0.2, y: 0.5, z: 0 }, rightWrist: { x: 0.2, y: 0.6, z: 0 } });
    for (const i of [POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER, POSE.LEFT_HIP, POSE.RIGHT_HIP]) other.image[i] = { ...other.image[i], x: other.image[i].x - 0.5 };
    const crops: CropHand[] = [
      { person: 0, side: "right", hand: found({ x: 0.1, y: 0.6, z: 0 }) },
      { person: 1, side: "left", hand: found({ x: 0.4, y: 0.6, z: 0 }) },
    ];
    // the presenter is now at index 1
    const { frame } = selectFrame(0, [toks(other), toks(apart)], [], TRACK_START, ASPECT, crops);
    expect(frame.person_index).toBe(1);
    expect(frame.left_hand?.image[0]).toEqual({ x: 0.4, y: 0.6, z: 0 });
    expect(frame.right_hand).toBeNull();
  });
  it("never replaces a hand the full frame found", () => {
    const full = { image: fanned({ x: 0.6, y: 0.6, z: 0 }, 0.2), world: [], score: 0.9 };
    const crops: CropHand[] = [{ person: 0, side: "right", hand: found({ x: 0.6, y: 0.61, z: 0 }) }];
    const { frame } = selectFrame(0, [toks(apart)], [full], TRACK_START, ASPECT, crops);
    expect(frame.right_hand?.cropped).toBeUndefined();
    expect(frame.right_hand?.image).toBe(full.image);
  });
});
