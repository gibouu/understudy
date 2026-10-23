/**
 * Four synthetic episodes of a scripted reach, grasp, carry and release, in
 * SO-101 joint space (radians). Used by the export tests and by the demo's
 * replay mode; deterministic, no randomness.
 */
import type { EpisodeFrame, EpisodeRecord, JointVector } from "@/lib/export/types";
import type { Mode } from "@/lib/spec/schema";

export const SYNTHETIC_INSTRUCTION = "move the object into the target zone";

/** Joint-space keyframes: [t_s, shoulder_pan, shoulder_lift, elbow_flex, wrist_flex, wrist_roll, gripper]. */
const KEYFRAMES: [number, ...JointVector][] = [
  [0.0, 0.0, -1.2, 1.4, 0.6, 0.0, 0.2], // home, gripper closed
  [0.8, 0.35, -0.6, 0.9, 0.9, 0.1, 1.0], // above the object, gripper open
  [1.4, 0.35, -0.3, 0.8, 1.1, 0.1, 1.0], // down to the object
  [1.8, 0.35, -0.3, 0.8, 1.1, 0.1, 0.3], // grasp
  [2.4, 0.1, -0.7, 1.0, 0.8, 0.4, 0.3], // lift and carry
  [3.0, -0.3, -0.4, 0.8, 1.0, 0.6, 0.3], // over the target
  [3.4, -0.3, -0.4, 0.8, 1.0, 0.6, 1.0], // release
  [4.0, 0.0, -1.2, 1.4, 0.6, 0.0, 0.2], // home
];

const smoothstep = (u: number) => u * u * (3 - 2 * u);

/** Joint vector at time t, smoothstep between keyframes; pan and roll shifted by the scenario. */
function pose(t: number, panOffset: number, rollOffset: number): JointVector {
  const last = KEYFRAMES[KEYFRAMES.length - 1];
  const k = KEYFRAMES.findIndex((kf, i) => i > 0 && t <= kf[0]);
  const [t0, ...a] = k <= 0 ? last : KEYFRAMES[k - 1];
  const [t1, ...b] = k <= 0 ? last : KEYFRAMES[k];
  const u = t1 > t0 ? smoothstep(Math.min(1, Math.max(0, (t - t0) / (t1 - t0)))) : 1;
  const q = a.map((v, j) => v + (b[j] - v) * u) as JointVector;
  // the offsets apply while the arm is away from home
  const away = Math.sin((Math.PI * Math.min(t, last[0])) / last[0]);
  q[0] += panOffset * away;
  q[4] += rollOffset * away;
  return q;
}

const SCENARIOS: { scenario_id: string; mode: Mode; pass: boolean; pan: number; roll: number }[] = [
  { scenario_id: "nominal", mode: "sensed", pass: true, pan: 0, roll: 0 },
  { scenario_id: "x_mm+8", mode: "sensed", pass: true, pan: 0.04, roll: 0 },
  { scenario_id: "x_mm+8", mode: "blind", pass: false, pan: 0.0, roll: 0 },
  { scenario_id: "yaw_deg+15", mode: "blind", pass: true, pan: 0, roll: 0.26 },
];

export function syntheticEpisodes({ fps = 15, seconds = 4 } = {}): EpisodeRecord[] {
  const n = Math.round(seconds * fps);
  return SCENARIOS.map((s, episode_index) => {
    const frames: EpisodeFrame[] = Array.from({ length: n }, (_, i) => ({
      t_s: i / fps,
      state: pose(i / fps, s.pan, s.roll),
      action: pose((i + 1) / fps, s.pan, s.roll),
    }));
    return {
      episode_index,
      scenario_id: s.scenario_id,
      mode: s.mode,
      pass: s.pass,
      fps,
      instruction: SYNTHETIC_INSTRUCTION,
      frames,
    };
  });
}
