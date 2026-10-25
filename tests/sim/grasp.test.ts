import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_SPEC } from "@/lib/sim/demo-spec";
import { attach, detach, graspIndex, holding, isAttached, type Grasp } from "@/lib/sim/grasp";
import { solveIk } from "@/lib/sim/ik";
import { buildScene } from "@/lib/sim/scene";
import { GRIPPER_CLOSED, GRIPPER_OPEN, SO101_GRASP_SITE, SO101_HOME, SO101_XML, stageXml } from "@/lib/sim/so101";

const build = buildScene(DEMO_SPEC);
const TUBE = build.names.tube;
/** grip 17 mm below the tube's top: the jaws stay above the rack when the tube is seated */
const GRIP_FROM_BOTTOM_M = 0.043;

let mujoco: MainModule;
let model: MjModel;
let data: MjData;
let grasp: Grasp;

beforeAll(async () => {
  const { default: loadMujoco } = await import("@mujoco/mujoco");
  mujoco = await loadMujoco();
  const dir = path.join(process.cwd(), "assets", "so101");
  const vfs = new mujoco.MjVFS();
  vfs.addBuffer(SO101_XML, new Uint8Array(readFileSync(path.join(dir, SO101_XML))));
  for (const file of readdirSync(path.join(dir, "assets"))) vfs.addBuffer(file, new Uint8Array(readFileSync(path.join(dir, "assets", file))));
  model = mujoco.MjModel.from_xml_string(stageXml(build.worldbody, { graspable: build.manipulated }), vfs);
  data = new mujoco.MjData(model);
  vfs.delete();
  grasp = graspIndex(mujoco, model, TUBE);
}, 60_000);
afterAll(() => {
  data?.delete();
  model?.delete();
});

const vec = (field: unknown, i: number, n = 3) => Array.from((field as Float64Array).slice(n * i, n * i + n));
const tubePos = () => vec(data.xpos, grasp.bodyId);
const ctrl = () => Array.from(data.ctrl as Float64Array);
/** the tube's position in the gripper body's frame */
const inGripper = () => {
  const p = tubePos();
  const o = vec(data.xpos, grasp.gripper);
  const R = vec(data.xmat, grasp.gripper, 9);
  const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  return [0, 1, 2].map((c) => R[c] * d[0] + R[3 + c] * d[1] + R[6 + c] * d[2]);
};

/** Ramp the actuators from where they are to `to` over `ramp` s, then hold until `total` s; `each` may stop early. */
function drive(to: number[], ramp: number, total = ramp + 0.5, each?: () => boolean) {
  const from = ctrl();
  const dt = model.opt.timestep;
  for (let t = 0; t < total; t += dt) {
    const u = Math.min(1, t / ramp);
    (data.ctrl as Float64Array).set(from.map((f, i) => f + (to[i] - f) * u));
    mujoco.mj_step(model, data);
    if (each?.()) return true;
  }
  return false;
}

function armTo(target: number[], gripper: number, ramp = 1) {
  const r = solveIk(mujoco, model, scratch(), target as [number, number, number], "top", undefined, SO101_GRASP_SITE);
  expect(r.ok, JSON.stringify({ target, err: r.pos_err_mm })).toBe(true);
  drive([...r.q, gripper], ramp);
}

/** IK must not touch the live state, as in the worker */
function scratch() {
  const s = new mujoco.MjData(model);
  (s.qpos as Float64Array).set(data.qpos as Float64Array);
  scratches.push(s);
  return s;
}
const scratches: MjData[] = [];
afterAll(() => scratches.forEach((s) => s.delete()));

describe("grasp and release", () => {
  it.each([1, 0])("picks the tube up, carries it with the gripper and releases it at the slot mouth at %s g", (g) => {
    mujoco.mj_resetData(model, data);
    (model.opt.gravity as Float64Array)[2] = -9.81;
    drive([...SO101_HOME.slice(0, 5), GRIPPER_OPEN], 0.5, 1.5);
    const start = tubePos();
    const bottom = start[2] - 0.03;
    const grip = [start[0], start[1], bottom + GRIP_FROM_BOTTOM_M];

    armTo([grip[0], grip[1], grip[2] + 0.035], GRIPPER_OPEN, 1.5);
    armTo(grip, GRIPPER_OPEN);
    expect(isAttached(data, grasp)).toBe(false);
    const touched = drive([...ctrl().slice(0, 5), GRIPPER_CLOSED], 0.3, 1.5, () => holding(mujoco, model, data, grasp));
    expect(touched).toBe(true);
    const jaw = attach(model, data, grasp);
    expect(isAttached(data, grasp)).toBe(true);
    const offset = inGripper();

    const pocket = vec(data.site_xpos, mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, `${build.names.rack}_pocket`));
    armTo([grip[0], grip[1], grip[2] + 0.035], jaw);
    const lifted = tubePos();
    (model.opt.gravity as Float64Array)[2] = -9.81 * g; // grasped at 1 g so the tube stood still; the carry and release run at g
    expect(lifted[2] - start[2]).toBeGreaterThan(0.03);
    // tube bottom 2 mm above the opening
    const over = [pocket[0], pocket[1], pocket[2] + 0.002 + GRIP_FROM_BOTTOM_M];
    armTo(over, jaw, 2);
    // the tube rode with the gripper: same place in the gripper's frame within 2 mm
    const drift = inGripper().map((v, i) => v - offset[i]);
    expect(Math.hypot(...drift)).toBeLessThan(0.002);
    const held = tubePos();

    detach(data, grasp);
    drive([...ctrl().slice(0, 5), GRIPPER_OPEN], 0.3, 1.5);
    expect(isAttached(data, grasp)).toBe(false);
    const floor = vec(data.site_xpos, mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, `${build.names.rack}_pocket_floor`));
    const end = tubePos();
    if (g === 1) {
      expect(held[2] - end[2]).toBeGreaterThan(0.025); // fell
      expect(Math.hypot(end[0] - floor[0], end[1] - floor[1])).toBeLessThan(0.005); // inside the 20 mm pocket
      expect(end[2]).toBeCloseTo(floor[2] + 0.03, 2); // standing on the pocket floor
    } else {
      // released with the gripper's (near zero) velocity and no push: it hangs at the mouth, not seated
      expect(Math.hypot(...end.map((v, i) => v - held[i]))).toBeLessThan(0.01);
      expect(end[2] - (floor[2] + 0.03)).toBeGreaterThan(0.02);
    }
  }, 60_000);
});
