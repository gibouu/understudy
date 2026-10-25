import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_PROGRAMS, DEMO_SPEC } from "@/lib/sim/demo-spec";
import { environment, runToEnd } from "@/lib/sim/interpreter";
import { evaluate } from "@/lib/sim/predicates";
import { SO101_HOME, SO101_XML, stageXml } from "@/lib/sim/so101";
import { Predicate, Program } from "@/lib/spec/schema";

const env = environment(DEMO_SPEC);
let mujoco: MainModule;
let model: MjModel;
let data: MjData;

beforeAll(async () => {
  const { default: loadMujoco } = await import("@mujoco/mujoco");
  mujoco = await loadMujoco();
  const dir = path.join(process.cwd(), "assets", "so101");
  const vfs = new mujoco.MjVFS();
  vfs.addBuffer(SO101_XML, new Uint8Array(readFileSync(path.join(dir, SO101_XML))));
  for (const file of readdirSync(path.join(dir, "assets"))) vfs.addBuffer(file, new Uint8Array(readFileSync(path.join(dir, "assets", file))));
  model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { graspable: env.graspable }), vfs);
  data = new mujoco.MjData(model);
  vfs.delete();
}, 60_000);
afterAll(() => {
  data?.delete();
  model?.delete();
});

const check = (p: Omit<Predicate, never>, t = 0) => evaluate({ mujoco, model, data, spec: env.spec, names: env.names, t }, Predicate.parse(p));
const site = (name: string) => {
  const i = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, name);
  return Array.from((data.site_xpos as Float64Array).slice(3 * i, 3 * i + 3));
};
/** Hand-made state: the arm at home, the tube's free joint (qpos 6..12, qvel 6..11) where we say. */
function pose(xyz: number[], quat = [1, 0, 0, 0], vel = [0, 0, 0, 0, 0, 0]) {
  mujoco.mj_resetData(model, data);
  const q = data.qpos as Float64Array;
  SO101_HOME.forEach((v, i) => (q[i] = v));
  q.set([...xyz, ...quat], 6);
  (data.qvel as Float64Array).set(vel, 6);
  mujoco.mj_forward(model, data);
}
const tube = { object: "tube" };

describe("predicates on hand-made states", () => {
  it("inside_zone: seated on the pocket floor, not hanging at the mouth, not off-centre", () => {
    pose([0, 0, 0]);
    const floor = site("obj_rack_pocket_floor");
    const mouth = site("obj_rack_pocket");
    const inside = { kind: "inside_zone", ...tube, target: "rack" } as const;
    pose([floor[0], floor[1], floor[2] + 0.03]);
    expect(check(inside).ok).toBe(true);
    pose([mouth[0], mouth[1], mouth[2] + 0.002 + 0.03]);
    const hanging = check(inside);
    expect(hanging.ok).toBe(false);
    expect(hanging.measured).toBeCloseTo(34, 0); // mm above the floor
    pose([floor[0] + 0.006, floor[1], floor[2] + 0.03]); // a 17 mm tube 6 mm off in a 20 mm pocket cannot be there
    expect(check(inside).ok).toBe(false);
  });

  it("object_still: still versus drifting", () => {
    pose([0.2, -0.1, 0.03]);
    expect(check({ kind: "object_still", ...tube }).ok).toBe(true);
    pose([0.2, -0.1, 0.03], undefined, [0.02, 0, 0, 0, 0, 0]);
    const moving = check({ kind: "object_still", ...tube });
    expect(moving.ok).toBe(false);
    expect(moving.measured).toBeCloseTo(20, 5);
  });

  it("height_above and tilt_under", () => {
    pose([0.2, -0.1, 0.05]); // bottom 20 mm above the table
    expect(check({ kind: "height_above", ...tube, value: 15 }).ok).toBe(true);
    expect(check({ kind: "height_above", ...tube, value: 25 }).ok).toBe(false);
    const s = Math.sin(Math.PI / 12);
    pose([0.2, -0.1, 0.05], [Math.cos(Math.PI / 12), s, 0, 0]); // 30° about x
    expect(check({ kind: "tilt_under", ...tube, value: 31 }).ok).toBe(true);
    expect(check({ kind: "tilt_under", ...tube, value: 29 }).measured).toBeCloseTo(30, 3);
  });

  it("time_under", () => {
    expect(check({ kind: "time_under", value: 5 }, 4).ok).toBe(true);
    expect(check({ kind: "time_under", value: 5 }, 6).ok).toBe(false);
  });

  it("no_collision: the arm in the clear, then a scene object through the upper arm", () => {
    pose([0.2, -0.1, 0.03]);
    expect(check({ kind: "no_collision" }).ok).toBe(true);
    const b = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, "upper_arm");
    pose(Array.from((data.xpos as Float64Array).slice(3 * b, 3 * b + 3)));
    const hit = check({ kind: "no_collision" });
    expect(hit.ok).toBe(false);
    expect(hit.why).toContain("obj_tube");
  });

  it("contact_both_pads and gripper_within: open and away, then closed on the tube", () => {
    pose([0.2, -0.1, 0.03]);
    expect(check({ kind: "contact_both_pads", ...tube }).ok).toBe(false);
    expect(check({ kind: "gripper_within", ...tube, value: 5 }).ok).toBe(false);
    const pick = Program.parse({ spec_title: "", steps: [{ step_id: "s1", ops: DEMO_PROGRAMS.hold_until_seated.steps[0].ops.slice(0, 3) }] });
    mujoco.mj_resetData(model, data);
    expect(runToEnd({ mujoco, model, data }, env, pick, "sensed").pass).toBe(true);
    expect(check({ kind: "contact_both_pads", ...tube }).ok).toBe(true);
    // the grasp gate attaches with both jaws within 3 mm: a geometric grasp, not a squeeze
    const aperture = check({ kind: "gripper_within", ...tube, value: 5 });
    expect(aperture.ok, aperture.why).toBe(true);
  });
});
