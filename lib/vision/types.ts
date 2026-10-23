/**
 * What the Watch stage keeps per sampled frame. Everything later in the
 * pipeline (anchor, keyframes, via-points, the `pose#segN` sources in the spec)
 * reads these tokens, never the video again.
 *
 * Image coordinates: x and y in [0, 1] of the sampled frame's width and height,
 * z a relative depth on the same scale as x (MediaPipe's normalized landmarks).
 * World coordinates: metres; origin at the hip centre for a pose, at the
 * hand's geometric centre for a hand.
 */
export type Point3 = { x: number; y: number; z: number };

/** The 33 MediaPipe pose landmarks of one person. */
export type PoseTokens = {
  image: Point3[];
  world: Point3[];
  /** 0..1 per landmark, MediaPipe's visibility estimate */
  visibility: number[];
};

/** The 21 MediaPipe hand landmarks of one hand; landmark 0 is the wrist. */
export type HandTokens = {
  image: Point3[];
  world: Point3[];
  /** handedness score of the detection; 0 when interpolated */
  score: number;
  /** true when filled in across a short gap rather than detected */
  interpolated: boolean;
};

export type TokenFrame = {
  /** media time of the sampled frame, seconds */
  t_s: number;
  /** index of the selected person among this frame's pose detections; null when nobody was selected */
  person_index: number | null;
  pose: PoseTokens | null;
  /** the person's own left hand, matched to pose wrist 15 */
  left_hand: HandTokens | null;
  /** the person's own right hand, matched to pose wrist 16 */
  right_hand: HandTokens | null;
};

export type HandSide = "left" | "right";

/** A stretch where a hand was unseen for longer than the interpolation limit. */
export type HandGap = { side: HandSide; start_s: number; end_s: number };

export type WatchTokens = {
  frames: TokenFrame[];
  gaps: HandGap[];
  /** nominal sampling rate */
  fps: number;
  /** sampled frame size in pixels */
  width: number;
  height: number;
  duration_s: number;
};
