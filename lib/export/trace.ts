/**
 * A rollout the stage played, as the export records it: the arm's joint positions and commands at every frame the
 * worker posted, resampled to the dataset's frame rate. What the 1-minute demo downloads from the rollouts it showed.
 */
import { SO101_JOINT_NAMES } from "@/lib/sim/so101";
import type { Frame, SimMeta } from "@/lib/sim/protocol";
import type { EpisodeFrame, JointVector } from "./types";

/** One posted frame of the arm: simulated seconds since reset, measured joints, commanded joints. */
export type TraceFrame = { t: number; state: JointVector; action: JointVector };

/** The arm's six joints read out of a frame, in SO101_JOINT_NAMES order (equal to the actuator order). */
export function armFrame(meta: SimMeta, frame: Frame): TraceFrame {
  const state = SO101_JOINT_NAMES.map((name) => {
    const j = meta.joints.find((x) => x.name === name);
    if (!j) throw new Error(`the model has no joint ${name}`);
    return frame.qpos[j.qposadr];
  }) as JointVector;
  const action = SO101_JOINT_NAMES.map((name) => {
    const a = meta.actuators.findIndex((x) => x.name === name);
    if (a < 0) throw new Error(`the model has no actuator ${name}`);
    return frame.ctrl[a];
  }) as JointVector;
  return { t: frame.t, state, action };
}

/** One rollout's frames (SimClient.run's onFrame), sampled every 1/fps simulated seconds: each sample is the last frame at or before its time. */
export function resample(run: TraceFrame[], fps: number): EpisodeFrame[] {
  if (run.length === 0) return [];
  const t0 = run[0].t;
  const out: EpisodeFrame[] = [];
  let i = 0;
  for (let k = 0; t0 + k / fps <= run[run.length - 1].t + 1e-9; k++) {
    const at = t0 + k / fps;
    while (i + 1 < run.length && run[i + 1].t <= at + 1e-9) i++;
    out.push({ t_s: k / fps, state: run[i].state, action: run[i].action });
  }
  return out;
}
