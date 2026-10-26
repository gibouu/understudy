import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MainModule, MjVFS } from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import { BOX_Y_MM, BOX_Z_MM, scalePath } from "@/lib/sim/gesture";
import { environment, runToEnd } from "@/lib/sim/interpreter";
import { SO101_XML, stageXml } from "@/lib/sim/so101";
import { Program, TaskSpec } from "@/lib/spec/schema";
import { armLength, busierHand, handSamples } from "@/lib/vision/hand";
import type { TokenFrame } from "@/lib/vision/types";
import wave from "../fixtures/vision/wave.json";

let mujoco: MainModule;
let vfs: MjVFS;

beforeAll(async () => {
  const { default: loadMujoco } = await import("@mujoco/mujoco");
  mujoco = await loadMujoco();
  const dir = path.join(process.cwd(), "assets", "so101");
  vfs = new mujoco.MjVFS();
  vfs.addBuffer(SO101_XML, new Uint8Array(readFileSync(path.join(dir, SO101_XML))));
  for (const file of readdirSync(path.join(dir, "assets"))) vfs.addBuffer(file, new Uint8Array(readFileSync(path.join(dir, "assets", file))));
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
  const side = busierHand(f, 0, 8);
  const samples = handSamples(f, "right", 0, 8);
  const scaled = scalePath(samples, armLength(f, "right", 0, 8));

  it("follows the waving hand, the right, seen in every frame, on an arm about half a metre long", () => {
    expect(side).toBe("right");
    expect(samples).toHaveLength(240);
    expect(armLength(f, "right", 0, 8)).toBeCloseTo(0.49, 2);
    expect(scaled.warnings).toEqual([]);
    expect(scaled.path).toHaveLength(240);
    const span = (k: 1 | 2) => Math.max(...scaled.path.map((p) => p.xyz_mm[k])) - Math.min(...scaled.path.map((p) => p.xyz_mm[k]));
    // a palm wave: 44 mm across and 56 mm high on the robot, inside the box
    expect(span(1)).toBeGreaterThan(30);
    expect(span(1)).toBeLessThan(BOX_Y_MM[1] - BOX_Y_MM[0]);
    expect(span(2)).toBeLessThan(BOX_Z_MM[1] - BOX_Z_MM[0]);
  });

  it.each([1, 0])("is followed point by point within 5 mm at %s g, a little slower than the clip", (g) => {
    const spec = TaskSpec.parse({ version: 1, title: "wave", summary: "", objects: [], steps: [{ id: "s1", verb: "gesture", gesture: { hand: "right", path: scaled.path }, t_start_s: 0, t_end_s: 8 }] });
    const env = environment(spec);
    const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: g }), vfs);
    const data = new mujoco.MjData(model);
    try {
      const r = runToEnd({ mujoco, model, data }, env, Program.parse({ spec_title: "wave", steps: [{ step_id: "s1", ops: [{ op: "follow" }] }] }), "sensed");
      expect(r.pass, r.log.join("\n")).toBe(true);
      const followed = r.followed![0];
      expect(followed).toMatchObject({ points: 240, reached: 240, missed: [], reach_mm: 5 });
      expect(followed.speed).toBeGreaterThan(0.5);
      expect(followed.speed).toBeLessThan(1);
      expect(followed.worst_mm).toBeLessThan(5);
      console.log(`wave at ${g} g: speed ${followed.speed}, worst ${followed.worst_mm} mm, late ${followed.late_s} s; ${r.log.find((l) => l.includes(" follow 240"))}`);
    } finally {
      data.delete();
      model.delete();
    }
  }, 120_000);
});
