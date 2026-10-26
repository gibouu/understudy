import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MainModule, MjVFS } from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import { scalePath, type HandSample } from "@/lib/sim/gesture";
import { environment, runToEnd } from "@/lib/sim/interpreter";
import { SO101_XML, stageXml } from "@/lib/sim/so101";
import { Program, TaskSpec, type PathPoint } from "@/lib/spec/schema";

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

/** A wrist swinging side to side twice a second, 12 cm either way on a 0.6 m arm, for 4 s: a wave, as measured. */
function swing(): PathPoint[] {
  const samples: HandSample[] = Array.from({ length: 41 }, (_, k) => {
    const t = k / 10;
    return { t_s: t, x_m: 0.12 * Math.sin(2 * Math.PI * 2 * t), y_m: -0.4 - 0.03 * Math.abs(Math.cos(2 * Math.PI * 2 * t)) };
  });
  return scalePath(samples, 0.6).path;
}

function gestureSpec(path: PathPoint[], reach_mm = 5) {
  return TaskSpec.parse({
    version: 1,
    title: "a gesture",
    summary: "",
    objects: [],
    steps: [{ id: "s1", verb: "gesture", gesture: { hand: "right", path, reach_mm }, t_start_s: 0, t_end_s: 4 }],
  });
}

const FOLLOW = Program.parse({ spec_title: "a gesture", steps: [{ step_id: "s1", ops: [{ op: "follow" }] }] });

function rollout(spec: TaskSpec, program: Program, gravity_g: number) {
  const env = environment(spec);
  const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g, graspable: env.graspable }), vfs);
  const data = new mujoco.MjData(model);
  try {
    return runToEnd({ mujoco, model, data }, env, program, "sensed");
  } finally {
    data.delete();
    model.delete();
  }
}

describe("follow: a gesture path traced by the arm", () => {
  it.each([1, 0])("reaches every point of a wave at %s g", (g) => {
    const path = swing();
    const r = rollout(gestureSpec(path), FOLLOW, g);
    expect(r.pass, r.log.join("\n")).toBe(true);
    expect(r.followed).toHaveLength(1);
    expect(r.followed![0]).toMatchObject({ step_id: "s1", points: path.length, reached: path.length, missed: [], reach_mm: 5 });
    expect(r.followed![0].worst_mm).toBeLessThanOrEqual(5);
    // twice a second, 60 mm either way, asks more of the joints than the arm is held to: it follows slower, and says so
    expect(r.followed![0].speed).toBeLessThan(1);
    expect(r.log.join("\n")).toMatch(/at 0\.\d\dx the clip's speed: at its own a joint would turn at [\d.]+ rad\/s, and the arm is held to 2/);
    expect(r.log.join("\n")).toMatch(/follow: reached all 41 points of the path within 5 mm at 0\.\d\dx the clip's speed/);
  }, 120_000);

  it("fails as an embodiment limit, before moving, when a point is out of reach", () => {
    const path = swing().map((p, k) => (k === 10 ? { ...p, xyz_mm: [600, 0, 600] as [number, number, number] } : p));
    const r = rollout(gestureSpec(path), FOLLOW, 1);
    expect(r.pass).toBe(false);
    expect(r.failure_class).toBe("embodiment_limit");
    expect(r.why).toMatch(/point 11 of 41 is out of the arm's reach/);
  }, 120_000);

  it("fails as an embodiment limit when a tolerance is tighter than the arm keeps, naming what it missed", () => {
    const r = rollout(gestureSpec(swing(), 0.05), FOLLOW, 1);
    expect(r.pass).toBe(false);
    expect(r.failure_class).toBe("embodiment_limit");
    expect(r.why).toMatch(/follow: missed \d+ of 41 points/);
    expect(r.followed![0].missed.length).toBeGreaterThan(0);
  }, 120_000);

  it("is a spec gap with no path, outside a gesture step, or with a path that goes back in time", () => {
    const none = rollout(gestureSpec([]), FOLLOW, 1);
    expect(none.failure_class).toBe("spec_gap");
    expect(none.why).toMatch(/has no path yet/);
    const back = swing();
    [back[3], back[4]] = [back[4], back[3]];
    expect(rollout(gestureSpec(back), FOLLOW, 1).why).toMatch(/goes back in time/);
    const elsewhere = Program.parse({ spec_title: "", steps: [{ step_id: "s9", ops: [{ op: "follow" }] }] });
    expect(rollout(gestureSpec(swing()), elsewhere, 1).why).toMatch(/not a gesture with a path/);
  }, 120_000);

  it("draws the path on the stage as markers that touch nothing", () => {
    const env = environment(gestureSpec(swing()));
    expect(env.worldbody.match(/<geom name="gesture_0_/g)).toHaveLength(41);
    expect(env.graspable).toEqual([]);
  });
});
