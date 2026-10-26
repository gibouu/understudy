import { describe, expect, it } from "vitest";
import { POSE } from "@/lib/vision/select";
import type { Point3, TokenFrame } from "@/lib/vision/types";
import { armLength, busierHand, handGaps, handSamples, MIN_VISIBILITY, travel } from "@/lib/vision/hand";

const P = (x: number, y: number, z = 0): Point3 => ({ x, y, z });

/** A frame whose pose has the given world landmarks (the rest at the hip centre), all seen unless listed in `hidden`. */
function frame(t_s: number, world: Partial<Record<number, Point3>>, hidden: number[] = []): TokenFrame {
  const w = Array.from({ length: 33 }, (_, i) => world[i] ?? P(0, 0));
  return {
    t_s,
    person_index: 0,
    pose: { image: w.map(() => P(0.5, 0.5)), world: w, visibility: w.map((_, i) => (hidden.includes(i) ? MIN_VISIBILITY / 2 : 0.99)) },
    left_hand: null,
    right_hand: null,
  };
}

/** The right arm: shoulder at (-0.2, -0.5), elbow 0.3 m below it, the wrist 0.25 m from the elbow, swinging; the left hangs still. */
function waving(t_s: number, swing: number, hidden: number[] = []): TokenFrame {
  const w = P(-0.2 + 0.25 * Math.sin(swing), -0.2 - 0.25 * Math.cos(swing));
  return frame(
    t_s,
    {
      [POSE.RIGHT_SHOULDER]: P(-0.2, -0.5),
      [POSE.RIGHT_ELBOW]: P(-0.2, -0.2),
      [POSE.RIGHT_WRIST]: w,
      [POSE.RIGHT_INDEX]: P(w.x, w.y - 0.09),
      [POSE.RIGHT_PINKY]: P(w.x + 0.03, w.y - 0.06),
      [POSE.LEFT_SHOULDER]: P(0.2, -0.5),
      [POSE.LEFT_ELBOW]: P(0.2, -0.2),
      [POSE.LEFT_WRIST]: P(0.2, 0.05),
      [POSE.LEFT_INDEX]: P(0.2, 0.14),
      [POSE.LEFT_PINKY]: P(0.22, 0.12),
    },
    hidden,
  );
}

const frames = Array.from({ length: 30 }, (_, k) => waving(k / 10, 0.6 * Math.sin(2 * Math.PI * 2 * (k / 10))));

describe("the hand's path in a gesture", () => {
  it("reads the hand's centre (wrist, index, pinky) from the pose world landmarks within the window, only where all three were seen", () => {
    const withHole = frames.map((f, k) => (k === 5 ? waving(f.t_s, 0, [POSE.RIGHT_INDEX]) : f));
    const s = handSamples(withHole, "right", 0.3, 1.0);
    expect(s.map((x) => x.t_s)).toEqual([0.3, 0.4, 0.6, 0.7, 0.8, 0.9, 1.0].map((t) => expect.closeTo(t, 6)));
    const w = frames[3].pose!.world[POSE.RIGHT_WRIST];
    expect(s[0]).toEqual({ t_s: frames[3].t_s, x_m: expect.closeTo(w.x + 0.01, 9), y_m: expect.closeTo(w.y - 0.05, 9) });
  });

  it("measures the arm as shoulder to elbow to wrist, the median over the frames that saw all three", () => {
    expect(armLength(frames, "right", 0, 3)).toBeCloseTo(0.55, 6);
    // a frame with a misplaced elbow does not move the median
    const odd = [...frames.slice(0, 5), frame(0.5, { [POSE.RIGHT_SHOULDER]: P(-0.2, -0.5), [POSE.RIGHT_ELBOW]: P(-0.9, -0.2), [POSE.RIGHT_WRIST]: P(-0.2, 0) })];
    expect(armLength(odd, "right", 0, 3)).toBeCloseTo(0.55, 6);
    // with the elbow never seen there is no arm to measure
    expect(armLength(frames.map((f) => waving(f.t_s, 0, [POSE.RIGHT_ELBOW])), "right", 0, 3)).toBeNull();
  });

  it("picks the hand that moved, and none when no wrist was seen twice", () => {
    expect(busierHand(frames, 0, 3)).toBe("right");
    expect(travel(handSamples(frames, "left", 0, 3))).toBe(0);
    const unseen = frames.map((f) => waving(f.t_s, 0, [POSE.LEFT_WRIST, POSE.RIGHT_PINKY]));
    expect(busierHand(unseen, 0, 3)).toBeNull();
    expect(busierHand([], 0, 3)).toBeNull();
  });

  it("reports the stretches the hand went unseen for longer than half a second, ends included", () => {
    const s = handSamples(frames.filter((f) => f.t_s < 0.85 || f.t_s > 1.65), "right", 0, 3);
    expect(handGaps(s, 0, 3)).toEqual([{ start_s: expect.closeTo(0.8, 6), end_s: expect.closeTo(1.7, 6) }]);
    expect(handGaps(s.slice(0, 3), 0, 3)).toEqual([{ start_s: expect.closeTo(0.2, 6), end_s: 3 }]);
  });
});
