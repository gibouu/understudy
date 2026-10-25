/**
 * Pure functions that turn raw MediaPipe detections into one person's tokens:
 * pick the person, keep tracking them, give them their own hands, and fill or
 * flag the gaps where a hand went missing. No browser APIs, so all of it is
 * unit-tested on landmark fixtures.
 *
 * Distances are measured in frame heights: x is multiplied by the aspect ratio
 * (width / height) so a normalized step means the same on both axes.
 */
import type { HandGap, HandSide, HandTokens, Point3, PoseTokens, TokenFrame } from "./types";

export const POSE = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
} as const;

/** A hand as the Hand Landmarker returns it, before it is matched to a person. */
export type DetectedHand = Omit<HandTokens, "interpolated">;

/** A hand found on a wrist crop, attached to the person and the wrist the crop was made for. */
export type CropHand = { person: number; side: HandSide; hand: DetectedHand };

type Point2 = { x: number; y: number };

const mid = (a: Point3, b: Point3): Point2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: Point2, b: Point2, aspect: number) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

/** Torso quadrilateral (shoulders and hips): area, centre and hip midpoint, in frame-height units. */
export function torso(image: Point3[], aspect: number) {
  const quad = [POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER, POSE.RIGHT_HIP, POSE.LEFT_HIP].map(
    (i) => image[i],
  );
  let twice = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    twice += a.x * aspect * b.y - b.x * aspect * a.y;
  }
  const shoulders = mid(image[POSE.LEFT_SHOULDER], image[POSE.RIGHT_SHOULDER]);
  const hip = mid(image[POSE.LEFT_HIP], image[POSE.RIGHT_HIP]);
  return {
    area: Math.abs(twice) / 2,
    centre: { x: (shoulders.x + hip.x) / 2, y: (shoulders.y + hip.y) / 2 },
    hip,
    /** shoulder midpoint to hip midpoint */
    height: dist(shoulders, hip, aspect),
  };
}

/**
 * First pick: among torsos at least half the size of the largest, the one whose
 * centre is nearest the frame centre. A bystander close to the camera but at
 * the edge loses to the person the phone was pointed at.
 */
export function pickPerson(poses: Point3[][], aspect: number): number | null {
  if (poses.length === 0) return null;
  const torsos = poses.map((p) => torso(p, aspect));
  const largest = Math.max(...torsos.map((t) => t.area));
  const centre = { x: 0.5, y: 0.5 };
  let best: number | null = null;
  let bestDist = Infinity;
  for (const [i, t] of torsos.entries()) {
    if (t.area < largest / 2) continue;
    const d = dist(t.centre, centre, aspect);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

export type TrackState = {
  /** hip midpoint of the tracked person in the last frame they were seen */
  hip: Point2 | null;
  /** consecutive samples without them */
  missed: number;
};

export const TRACK_START: TrackState = { hip: null, missed: 0 };

export type TrackOptions = {
  aspect: number;
  /** largest hip move between two samples still counted as the same person, frame heights */
  maxJump?: number;
  /** samples without the person before a fresh pick */
  maxMissed?: number;
};

/**
 * Keep following the same person by hip position. MediaPipe does not keep its
 * detection order between frames, so the index alone means nothing. After
 * `maxMissed` samples without them, start over with `pickPerson`.
 */
export function trackPerson(
  poses: Point3[][],
  state: TrackState,
  { aspect, maxJump = 0.15, maxMissed = 10 }: TrackOptions,
): { index: number | null; state: TrackState } {
  let index: number | null = null;
  if (state.hip === null || state.missed > maxMissed) {
    index = pickPerson(poses, aspect);
  } else {
    let bestDist = maxJump;
    for (const [i, p] of poses.entries()) {
      const d = dist(torso(p, aspect).hip, state.hip, aspect);
      if (d <= bestDist) {
        bestDist = d;
        index = i;
      }
    }
  }
  if (index === null) {
    return { index, state: { hip: state.hip, missed: state.missed + 1 } };
  }
  return { index, state: { hip: torso(poses[index], aspect).hip, missed: 0 } };
}

/**
 * Give the selected person their own hands. Every detected hand belongs to the
 * nearest wrist of any detected person, so a neighbour's hand reaching across
 * is not taken. Then the selected person's two wrists take one hand each,
 * within half a torso height (at least 0.05 frame heights): of all the
 * one-to-one assignments, the one that matches the most hands, then the one
 * with the shortest total distance (two wrists, so trying them all is cheap).
 * Handedness labels are not used: they assume a mirrored selfie image.
 */
export function matchHands(
  poses: Point3[][],
  selected: number,
  hands: Point3[][],
  aspect: number,
): { left: number | null; right: number | null } {
  const wrists = poses.flatMap((p, person) => [
    { person, side: "left" as HandSide, at: p[POSE.LEFT_WRIST] },
    { person, side: "right" as HandSide, at: p[POSE.RIGHT_WRIST] },
  ]);
  const limit = Math.max(0.05, torso(poses[selected], aspect).height / 2);
  const own: { hand: number; left: number; right: number }[] = [];
  hands.forEach((hand, h) => {
    let owner = -1;
    let ownerDist = Infinity;
    for (const w of wrists) {
      const d = dist(hand[0], w.at, aspect);
      if (d < ownerDist) {
        ownerDist = d;
        owner = w.person;
      }
    }
    if (owner !== selected) return;
    own.push({
      hand: h,
      left: dist(hand[0], poses[selected][POSE.LEFT_WRIST], aspect),
      right: dist(hand[0], poses[selected][POSE.RIGHT_WRIST], aspect),
    });
  });
  let best = { left: null as number | null, right: null as number | null, count: 0, total: 0 };
  const leftOptions = [null, ...own.filter((o) => o.left <= limit)];
  const rightOptions = [null, ...own.filter((o) => o.right <= limit)];
  for (const l of leftOptions) {
    for (const r of rightOptions) {
      if (l && r && l.hand === r.hand) continue;
      const count = (l ? 1 : 0) + (r ? 1 : 0);
      const total = (l?.left ?? 0) + (r?.right ?? 0);
      if (count > best.count || (count === best.count && total < best.total)) {
        best = { left: l?.hand ?? null, right: r?.hand ?? null, count, total };
      }
    }
  }
  return { left: best.left, right: best.right };
}

/**
 * One sampled frame for a person already chosen (`person` indexes `poses`, or
 * null when nobody is): match their hands from the full frame, then fill a
 * wrist still empty with the crop find made for that person and that wrist,
 * never another's. A crop find never replaces a full-frame hand.
 */
export function assembleFrame(
  t_s: number,
  poses: PoseTokens[],
  hands: DetectedHand[],
  person: number | null,
  aspect: number,
  cropHands: CropHand[] = [],
): TokenFrame {
  const frame: TokenFrame = {
    t_s,
    person_index: person,
    pose: person === null ? null : poses[person],
    left_hand: null,
    right_hand: null,
  };
  if (person === null) return frame;
  const m = matchHands(
    poses.map((p) => p.image),
    person,
    hands.map((h) => h.image),
    aspect,
  );
  if (m.left !== null) frame.left_hand = { ...hands[m.left], interpolated: false };
  if (m.right !== null) frame.right_hand = { ...hands[m.right], interpolated: false };
  for (const c of cropHands) {
    if (c.person !== person) continue;
    const key = c.side === "left" ? "left_hand" : "right_hand";
    if (frame[key] === null) frame[key] = { ...c.hand, cropped: true, interpolated: false };
  }
  return frame;
}

/** One sampled frame from raw detections: track the person, then `assembleFrame`. */
export function selectFrame(
  t_s: number,
  poses: PoseTokens[],
  hands: DetectedHand[],
  state: TrackState,
  aspect: number,
  cropHands: CropHand[] = [],
): { frame: TokenFrame; state: TrackState } {
  const tracked = trackPerson(
    poses.map((p) => p.image),
    state,
    { aspect },
  );
  return { frame: assembleFrame(t_s, poses, hands, tracked.index, aspect, cropHands), state: tracked.state };
}

const HAND_KEY = { left: "left_hand", right: "right_hand" } as const;

const lerp3 = (a: Point3, b: Point3, k: number): Point3 => ({
  x: a.x + (b.x - a.x) * k,
  y: a.y + (b.y - a.y) * k,
  z: a.z + (b.z - a.z) * k,
});

/**
 * Fill short hand gaps and flag long ones. A gap's length is the time between
 * the two frames that saw the hand on either side of it (or the first or last
 * unseen frame at the clip's ends). Inner gaps up to `maxGap_s` are linearly
 * interpolated landmark by landmark; anything longer, and any gap at the ends
 * longer than `maxGap_s`, is returned as a `HandGap`. Returns new frames; the
 * input is not modified.
 */
export function fillHandGaps(
  frames: TokenFrame[],
  maxGap_s = 0.5,
): { frames: TokenFrame[]; gaps: HandGap[] } {
  const out = frames.map((f) => ({ ...f }));
  const gaps: HandGap[] = [];
  const eps = 1e-9;
  for (const side of ["left", "right"] as const) {
    const key = HAND_KEY[side];
    let i = 0;
    while (i < out.length) {
      if (out[i][key] !== null) {
        i++;
        continue;
      }
      const start = i;
      while (i < out.length && out[i][key] === null) i++;
      const end = i - 1;
      const before = start > 0 ? out[start - 1] : null;
      const after = i < out.length ? out[i] : null;
      const span = (after ?? out[end]).t_s - (before ?? out[start]).t_s;
      if (before && after && span <= maxGap_s + eps) {
        const a = before[key]!;
        const b = after[key]!;
        for (let j = start; j <= end; j++) {
          const k = (out[j].t_s - before.t_s) / span;
          out[j][key] = {
            image: a.image.map((p, n) => lerp3(p, b.image[n], k)),
            world: a.world.map((p, n) => lerp3(p, b.world[n], k)),
            score: 0,
            interpolated: true,
          };
        }
      } else if (span > maxGap_s + eps) {
        gaps.push({ side, start_s: out[start].t_s, end_s: out[end].t_s });
      }
    }
  }
  gaps.sort((a, b) => a.start_s - b.start_s);
  return { frames: out, gaps };
}

/**
 * Speed of the person's wrist at frame `i`, metres per second, from the pose
 * world landmarks (hip-centred, so body sway is mostly removed). Null when
 * either frame lacks the person.
 */
export function wristSpeed(frames: TokenFrame[], i: number, side: HandSide): number | null {
  if (i < 1 || i >= frames.length) return null;
  const a = frames[i - 1];
  const b = frames[i];
  if (!a.pose || !b.pose) return null;
  const dt = b.t_s - a.t_s;
  if (dt <= 0) return null;
  const w = side === "left" ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST;
  const p = a.pose.world[w];
  const q = b.pose.world[w];
  return Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) / dt;
}
