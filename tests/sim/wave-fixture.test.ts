import type { MainModule } from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import { BOX_Y_MM, BOX_Z_MM, scalePath } from "@/lib/sim/gesture";
import { environment, runToEnd } from "@/lib/sim/interpreter";
import { stageXml } from "@/lib/sim/so101";
import { loadSo101 } from "@/lib/sim/so101-disk";
import { Program, TaskSpec } from "@/lib/spec/schema";
import { armLength, busierHand, handSamples } from "@/lib/vision/hand";
import type { TokenFrame } from "@/lib/vision/types";
import wave from "../fixtures/vision/wave.json";

let mujoco: MainModule;

beforeAll(async () => {
  mujoco = await loadSo101();
}, 60_000);

/** The recorded landmarks (tests/fixtures/vision/wave.json) as Watch tokens. */
function frames(): TokenFrame[] {
  return (wave.frames as number[][]).map((row) => {
    const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
    const visibility = new Array<number>(33).fill(0);
    wave.landmarks.forEach((id, k) => {
      world[id] = { x: row[1 + 4 * k], y: row[2 + 4 * k], z: row[3 + 4 * k] };
      visibility[id] = row[4 + 4 * k];
    });
    return { t_s: row[0], person_index: 0, pose: { image: world, world, visibility }, left_hand: null, right_hand: null };
  });
}

describe("the NASA wave clip (samples/iss-wave.mp4), as MediaPipe measured it", () => {
  const f = frames();
  // the window of the labelled gesture step (tests/fixtures/label.json)
  const [t0, t1] = [1, 3.2];
  const side = busierHand(f, t0, t1);
  const samples = handSamples(f, "right", t0, t1);
  const arm = armLength(f, "right", t0, t1);
  const scaled = scalePath(samples, arm);

  it("follows the waving hand, the right, seen in every frame, on an arm about half a metre long", () => {
    expect(side).toBe("right");
    expect(samples).toHaveLength(66);
    expect(arm).toBeCloseTo(0.48, 2);
    expect(scaled.path).toHaveLength(66);
    const span = (k: 1 | 2) => Math.max(...scaled.path.map((p) => p.xyz_mm[k])) - Math.min(...scaled.path.map((p) => p.xyz_mm[k]));
    console.log(`wave path: ${span(1).toFixed(0)} x ${span(2).toFixed(0)} mm, ${scaled.mm_per_m} mm/m, fit ${scaled.fit}, ${scaled.warnings.join("; ")}`);
    // the hand comes down at the end of the wave: the path fills the box's height and keeps its shape
    expect(span(1)).toBeGreaterThan(60);
    expect(span(1)).toBeLessThanOrEqual(BOX_Y_MM[1] - BOX_Y_MM[0]);
    expect(span(2)).toBeLessThanOrEqual(BOX_Z_MM[1] - BOX_Z_MM[0] + 1e-6);
  });

  it.each([1, 0])("is followed point by point within 5 mm at %s g, slower than the clip if it must be", (g) => {
    const spec = TaskSpec.parse({ version: 1, title: "wave", summary: "", objects: [], steps: [{ id: "s1", verb: "gesture", gesture: { hand: "right", path: scaled.path }, t_start_s: t0, t_end_s: t1 }] });
    const env = environment(spec);
    const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: g }));
    const data = new mujoco.MjData(model);
    try {
      const r = runToEnd({ mujoco, model, data }, env, Program.parse({ spec_title: "wave", steps: [{ step_id: "s1", ops: [{ op: "follow" }] }] }), "sensed");
      expect(r.pass, r.log.join("\n")).toBe(true);
      const followed = r.followed![0];
      expect(followed).toMatchObject({ points: 66, reached: 66, missed: [], reach_mm: 5 });
      expect(followed.speed).toBeGreaterThan(0.2);
      expect(followed.worst_mm).toBeLessThan(5);
      console.log(`wave at ${g} g: speed ${followed.speed}, worst ${followed.worst_mm} mm, late ${followed.late_s} s; ${r.log.find((l) => l.includes(" follow 66"))}`);
    } finally {
      data.delete();
      model.delete();
    }
  }, 120_000);
});
