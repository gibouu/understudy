/**
 * What the rehearsal records per passing rollout and what the LeRobot v2.1
 * writer consumes. Field names mirror Isaac-GR00T's demo dataset
 * `cube_to_bowl_5` (robot `so101_follower`, six floats per frame).
 */
import type { Mode, SignedBand } from "@/lib/spec/schema";

/** Joint order of the SO-101 follower as GR00T's demo names them. */
export const SO101_JOINTS = [
  "shoulder_pan.pos",
  "shoulder_lift.pos",
  "elbow_flex.pos",
  "wrist_flex.pos",
  "wrist_roll.pos",
  "gripper.pos",
] as const;

export type JointVector = [number, number, number, number, number, number];

export type EpisodeFrame = {
  /** seconds since episode start */
  t_s: number;
  /** measured joint positions */
  state: JointVector;
  /** commanded joint positions for the next step */
  action: JointVector;
};

export type EpisodeRecord = {
  episode_index: number;
  scenario_id: string;
  mode: Mode;
  pass: boolean;
  fps: number;
  /** one templated instruction per task, stored in tasks.jsonl */
  instruction: string;
  frames: EpisodeFrame[];
  /** rendered workspace camera frames, one per EpisodeFrame, 480x360 */
  video?: { width: number; height: number; frames: ImageBitmap[] | Blob[] };
};

export type ExportBundle = {
  robot_type: "so101_follower";
  codebase_version: "v2.1";
  episodes: EpisodeRecord[];
  /** the task spec, program, interview, report and ledger go next to lerobot/ */
  understudy: Record<string, unknown>;
};

export type QualityReport = {
  /** "N scripted, primitive-rendered episodes; a format-valid skeleton, not training data" */
  headline: string;
  /** sampled evidence per axis and mode: largest passing and smallest failing offset on each side */
  envelope_per_axis: Record<string, { sensed: SignedBand; blind: SignedBand }>;
  spec_coverage_by_source: Record<string, number>;
  degenerate_dimensions: string[];
  loader_validated: boolean;
};
