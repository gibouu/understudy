import { describe, expect, it } from "vitest";
import {
  fillHandGaps,
  matchHands,
  pickPerson,
  selectFrame,
  TRACK_START,
  trackPerson,
  wristSpeed,
  type DetectedHand,
} from "@/lib/vision/select";
import type { Point3, PoseTokens, TokenFrame } from "@/lib/vision/types";
import twoPeople from "../fixtures/vision/two-people.json";
import hands from "../fixtures/vision/hands.json";
import handGaps from "../fixtures/vision/hand-gaps.json";

const gapFrames = handGaps.frames as TokenFrame[];

describe("pickPerson", () => {
  it("takes the centred presenter over a larger bystander at the edge and a small figure at the centre", () => {
    const first = twoPeople.frames[0];
    expect(pickPerson(first.poses, twoPeople.aspect)).toBe(first.presenter);
  });
  it("returns null with nobody in frame", () => {
    expect(pickPerson([], twoPeople.aspect)).toBeNull();
  });
});

describe("trackPerson", () => {
  it("follows the presenter by hip position while detection order changes", () => {
    let state = TRACK_START;
    const picked: (number | null)[] = [];
    for (const f of twoPeople.frames) {
      const next = trackPerson(f.poses, state, { aspect: twoPeople.aspect });
      picked.push(next.index);
      state = next.state;
    }
    expect(picked).toEqual(twoPeople.frames.map((f) => f.presenter));
  });

  it("does not jump to someone else when the presenter is missed", () => {
    const f = twoPeople.frames[5];
    const tracked = trackPerson(f.poses, TRACK_START, { aspect: twoPeople.aspect });
    const missed = trackPerson(twoPeople.frames[6].poses, tracked.state, { aspect: twoPeople.aspect });
    expect(missed.index).toBeNull();
    expect(missed.state).toEqual({ hip: tracked.state.hip, missed: 1 });
  });

  it("starts over after too many misses", () => {
    const stale = { hip: { x: 0.9, y: 0.9 }, missed: 11 };
    const f = twoPeople.frames[0];
    expect(trackPerson(f.poses, stale, { aspect: twoPeople.aspect }).index).toBe(f.presenter);
  });
});

describe("matchHands", () => {
  it("gives the presenter their own hands and leaves the neighbour's and stray hands out", () => {
    expect(matchHands(hands.poses, 0, hands.hands, hands.aspect)).toEqual(hands.expected);
  });

  it("leaves a wrist empty rather than take the neighbour's nearby hand", () => {
    const withoutOwnLeft = hands.hands.filter((_, i) => i !== 0);
    expect(matchHands(hands.poses, 0, withoutOwnLeft, hands.aspect)).toEqual({ left: null, right: 0 });
  });

  it("chooses the assignment that keeps both hands over the greedy nearest pair", () => {
    // Wrists 0.1 apart; h0 is nearest the left wrist but also within reach of the
    // right one, h1 only reaches the left one. Greedy gives {left: 0, right: null}.
    const pose = hands.poses[0].map((p: Point3) => ({ ...p }));
    pose[11] = { x: 0.55, y: 0.4, z: 0 };
    pose[12] = { x: 0.45, y: 0.4, z: 0 };
    pose[23] = { x: 0.54, y: 0.6, z: 0 };
    pose[24] = { x: 0.46, y: 0.6, z: 0 };
    pose[15] = { x: 0.45, y: 0.6, z: 0 };
    pose[16] = { x: 0.55, y: 0.6, z: 0 };
    const at = (x: number) => [{ x, y: 0.6, z: 0 }];
    expect(matchHands([pose], 0, [at(0.49), at(0.38)], 1)).toEqual({ left: 1, right: 0 });
  });

  it("measures distance in frame heights, not raw normalized x", () => {
    // A hand 0.06 to the side in normalized x is 0.107 frame heights away at 16:9
    // (over the 0.1 limit for a 0.2-high torso) but only 0.06 at 1:1.
    const pose = hands.poses[0].map((p: Point3) => ({ ...p }));
    pose[11] = { x: 0.45, y: 0.45, z: 0 };
    pose[12] = { x: 0.35, y: 0.45, z: 0 };
    pose[23] = { x: 0.44, y: 0.65, z: 0 };
    pose[24] = { x: 0.36, y: 0.65, z: 0 };
    pose[15] = { x: 0.5, y: 0.6, z: 0 };
    pose[16] = { x: 0.2, y: 0.6, z: 0 };
    const hand = hands.hands[0].map((p: Point3) => ({ ...p, x: p.x - 0.522 + 0.56, y: p.y - 0.618 + 0.6 }));
    expect(matchHands([pose], 0, [hand], 16 / 9).left).toBeNull();
    expect(matchHands([pose], 0, [hand], 1).left).toBe(0);
  });
});

describe("selectFrame", () => {
  it("builds a token frame with the tracked person and matched hands", () => {
    const toPose = (image: Point3[]): PoseTokens => ({
      image,
      world: image,
      visibility: image.map(() => 1),
    });
    const toHand = (image: Point3[]): DetectedHand => ({ image, world: image, score: 0.8 });
    const { frame, state } = selectFrame(
      1.2,
      hands.poses.map(toPose),
      hands.hands.map(toHand),
      TRACK_START,
      hands.aspect,
    );
    expect(frame.t_s).toBe(1.2);
    expect(frame.person_index).toBe(0);
    expect(frame.left_hand?.image).toEqual(hands.hands[0]);
    expect(frame.left_hand?.interpolated).toBe(false);
    expect(frame.right_hand?.image).toEqual(hands.hands[1]);
    expect(state.missed).toBe(0);
  });
});

describe("fillHandGaps", () => {
  const { frames, gaps } = fillHandGaps(gapFrames);
  const at = (t: number) => frames.find((f) => Math.abs(f.t_s - t) < 1e-6)!;

  it("interpolates a gap of 0.5 s between the frames that saw the hand", () => {
    for (const t of [0.4, 0.5, 0.6, 0.7]) {
      const left = at(t).left_hand;
      expect(left?.interpolated).toBe(true);
      expect(left?.score).toBe(0);
      expect(left?.image[0].x).toBeCloseTo(0.2 + 0.1 * t, 6);
      expect(left?.world[0].x).toBeCloseTo((0.2 + 0.1 * t) / 10, 6);
    }
  });

  it("flags longer gaps, including one at the start, and leaves short end gaps alone", () => {
    expect(gaps).toEqual([
      { side: "right", start_s: 0, end_s: 0.6 },
      { side: "left", start_s: 1.1, end_s: 1.9 },
    ]);
    expect(at(1.5).left_hand).toBeNull();
    expect(at(0.3).right_hand).toBeNull();
    expect(at(2.4).right_hand).toBeNull();
  });

  it("does not modify its input", () => {
    expect(gapFrames[4].left_hand).toBeNull();
  });
});

describe("wristSpeed", () => {
  it("is distance over time between consecutive frames, from world landmarks", () => {
    const base = gapFrames[0];
    const moved: TokenFrame = {
      ...base,
      t_s: base.t_s + 0.1,
      pose: {
        ...base.pose!,
        world: base.pose!.world.map((p, i) => (i === 15 ? { ...p, x: p.x + 0.03, y: p.y + 0.04 } : p)),
      },
    };
    expect(wristSpeed([base, moved], 1, "left")).toBeCloseTo(0.5, 6);
    expect(wristSpeed([base, moved], 1, "right")).toBeCloseTo(0, 6);
    expect(wristSpeed([base, moved], 0, "left")).toBeNull();
    expect(wristSpeed([base, { ...moved, pose: null }], 1, "left")).toBeNull();
  });
});
