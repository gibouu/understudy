import { describe, expect, it } from "vitest";
import { armFrame, resample, type TraceFrame } from "@/lib/export/trace";
import type { JointVector } from "@/lib/export/types";
import type { Frame, SimMeta } from "@/lib/sim/protocol";
import { SO101_JOINT_NAMES } from "@/lib/sim/so101";

const at = (t: number, v: number): TraceFrame => ({ t, state: Array(6).fill(v) as JointVector, action: Array(6).fill(-v) as JointVector });

describe("resample", () => {
  it("samples every 1/fps simulated seconds, the last frame at or before each time", () => {
    const trace = [0, 0.02, 0.05, 0.07, 0.1, 0.13, 0.2].map((t) => at(t, t));
    const out = resample(trace, 10);
    expect(out.map((f) => f.t_s)).toEqual([0, 0.1, 0.2]);
    expect(out.map((f) => f.state[0])).toEqual([0, 0.1, 0.2]);
    expect(out[1].action[0]).toBe(-0.1);
  });

  it("starts the episode at the rollout's first frame", () => {
    const trace = [at(0.035, 1), at(0.07, 2), at(0.135, 3), at(0.17, 4)];
    const out = resample(trace, 10);
    expect(out.map((f) => f.t_s)).toEqual([0, 0.1]);
    expect(out.map((f) => f.state[0])).toEqual([1, 3]);
  });

  it("returns nothing for an empty trace", () => {
    expect(resample([], 15)).toEqual([]);
  });
});

describe("armFrame", () => {
  it("reads the six joints by name from qpos and the commands by actuator name", () => {
    // objects' free joints come first here, and the actuators are listed backwards: both are looked up by name
    const meta = {
      joints: [{ name: "obj1", qposadr: 0, range: [0, 0] }, ...SO101_JOINT_NAMES.map((name, i) => ({ name, qposadr: 7 + i, range: [-3, 3] }))],
      actuators: [...SO101_JOINT_NAMES].reverse().map((name) => ({ name, ctrlrange: [-3, 3] })),
    } as unknown as SimMeta;
    const qpos = new Float64Array(13).map((_, i) => i);
    const ctrl = new Float64Array([50, 40, 30, 20, 10, 0]);
    const f = armFrame(meta, { t: 1.5, qpos, ctrl } as unknown as Frame);
    expect(f.t).toBe(1.5);
    expect(f.state).toEqual([7, 8, 9, 10, 11, 12]);
    expect(f.action).toEqual([0, 10, 20, 30, 40, 50]);
  });
});
