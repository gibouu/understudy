import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dls, reachability, reachSphere, solveIk, type Approach } from "@/lib/sim/ik";
import { SO101_GRASP_SITE, SO101_HELD_SITE, SO101_TIP_SITE, stageXml } from "@/lib/sim/so101";
import { loadSo101 } from "@/lib/sim/so101-disk";

let mujoco: MainModule;
let model: MjModel;
let data: MjData;

beforeAll(async () => {
  mujoco = await loadSo101();
  model = mujoco.MjModel.from_xml_string(stageXml(""));
  data = new mujoco.MjData(model);
}, 60_000);
afterAll(() => {
  data?.delete();
  model?.delete();
});

/** Where the tip site really is after setting q: forward kinematics, independent of the solver. */
function tipAt(q: number[]): { p: number[]; a: number[] } {
  const qpos = data.qpos as Float64Array;
  q.forEach((v, i) => (qpos[i] = v));
  mujoco.mj_kinematics(model, data);
  const s = 1; // baseframe is 0, gripperframe 1
  const m = Array.from((data.site_xmat as Float64Array).slice(9 * s, 9 * s + 9));
  return { p: Array.from((data.site_xpos as Float64Array).slice(3 * s, 3 * s + 3)), a: [m[0], m[3], m[6]] };
}

describe("IK on the SO-101 tip site", () => {
  // reachable by construction: straight down near the table, horizontal further out, wrist rolled over at the side
  const poses: { pos: [number, number, number]; approach: Approach }[] = [
    { pos: [0.25, 0, 0.05], approach: "top" },
    { pos: [0.2, 0.1, 0.03], approach: "top" },
    { pos: [0.2, -0.1, 0.03], approach: "top" },
    { pos: [0.15, 0, 0.02], approach: "top" },
    { pos: [0.3, 0, 0.02], approach: "top" },
    { pos: [0.2, 0.2, 0.03], approach: "top" },
    { pos: [0.3, 0, 0.1], approach: "front" },
    { pos: [0.35, 0, 0.2], approach: "front" },
    { pos: [0.25, 0, 0.25], approach: "front" },
    { pos: [0.05, 0.25, 0.08], approach: "side" },
  ];
  it("names the tip site the test reads", () => expect(SO101_TIP_SITE).toBe("gripperframe"));
  it.each(poses)("converges on $pos coming from $approach", ({ pos, approach }) => {
    const r = solveIk(mujoco, model, data, pos, approach);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.failure_class).toBeUndefined();
    const fk = tipAt(r.q);
    const err = Math.hypot(fk.p[0] - pos[0], fk.p[1] - pos[1], fk.p[2] - pos[2]);
    expect(err).toBeLessThan(0.002);
    const cos = fk.a[0] * r.axis[0] + fk.a[1] * r.axis[1] + fk.a[2] * r.axis[2];
    expect(cos).toBeGreaterThan(Math.cos((2 * Math.PI) / 180));
    const ranges = Array.from(model.jnt_range as Float64Array);
    r.q.forEach((v, i) => {
      expect(v).toBeGreaterThanOrEqual(ranges[2 * i] - 1e-9);
      expect(v).toBeLessThanOrEqual(ranges[2 * i + 1] + 1e-9);
    });
  });
  it("aims straight down for top and records no lost angle", () => {
    const r = solveIk(mujoco, model, data, [0.25, 0, 0.05], "top");
    expect(r.axis).toEqual([0, 0, -1]);
    expect(r.approach_deg).toBeCloseTo(0, 6);
  });
  it("projects an approach the wrist cannot take and records the angle", () => {
    // front (+x) at a target 45 degrees off the centreline: the arm can only point radially
    const r = solveIk(mujoco, model, data, [0.2, 0.2, 0.03], "front");
    expect(r.approach_deg).toBeGreaterThan(30);
    expect(r.approach_deg).toBeLessThan(60);
    // side at the centreline has nothing in the pitch plane: falls back to top, 90 degrees given up
    const c = solveIk(mujoco, model, data, [0.25, 0, 0.05], "side");
    expect(c.axis).toEqual([0, 0, -1]);
    expect(c.approach_deg).toBeCloseTo(90, 6);
  });
  it("accepts a small projection and calls a large one an embodiment limit", () => {
    const small = solveIk(mujoco, model, data, [0.3, 0.05, 0.1], "front");
    expect(small.approach_deg).toBeGreaterThan(5);
    expect(small.approach_deg).toBeLessThan(20);
    expect(small.ok).toBe(true);
    // the tip gets there, but pointing straight down instead of from the side
    const large = solveIk(mujoco, model, data, [0.25, 0, 0.05], "side");
    expect(large.approach_deg).toBeGreaterThan(20);
    expect(large.pos_err_mm).toBeLessThan(2);
    expect(large.ok).toBe(false);
    expect(large.failure_class).toBe("embodiment_limit");
  });
  it("flags straight down from high above the table, which the wrist cannot bend to", () => {
    expect(solveIk(mujoco, model, data, [0.2, 0, 0.1], "top").failure_class).toBe("embodiment_limit");
  });
  it("flags a target outside the arm's reach as an embodiment limit", () => {
    const r = solveIk(mujoco, model, data, [0.8, 0, 0.1], "top");
    expect(r.ok).toBe(false);
    expect(r.failure_class).toBe("embodiment_limit");
    const pre = reachability(mujoco, model, data, [
      { pos: [0.25, 0, 0.05], approach: "top" },
      { pos: [0.8, 0, 0.1], approach: "top" },
    ]);
    expect(pre.ok).toBe(false);
    expect(pre.failure_class).toBe("embodiment_limit");
    expect(pre.results.map((x) => x.ok)).toEqual([true, false]);
  });
  it.each([SO101_TIP_SITE, SO101_GRASP_SITE, SO101_HELD_SITE])("bounds how far %s can be from the pan joint, in every pose", (site) => {
    const sphere = reachSphere(mujoco, model, data, site);
    expect(sphere).not.toBeNull();
    const sid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, site);
    const qpos = data.qpos as Float64Array;
    let s = 11;
    const rng = () => (s = (s * 16807) % 2147483647) / 2147483647;
    let far = 0;
    for (let k = 0; k < 5000; k++) {
      for (let i = 0; i < 6; i++) qpos[i] = -3 + 6 * rng();
      mujoco.mj_kinematics(model, data);
      const p = data.site_xpos as Float64Array;
      far = Math.max(far, Math.hypot(p[3 * sid] - sphere!.pivot[0], p[3 * sid + 1] - sphere!.pivot[1], p[3 * sid + 2] - sphere!.pivot[2]));
    }
    expect(far).toBeLessThanOrEqual(sphere!.r + 1e-9);
    expect(far).toBeGreaterThan(0.9 * sphere!.r); // and not a loose one
  });
  it("measures the sphere where the held frame is now: a grasp moves it", () => {
    const sid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, SO101_HELD_SITE);
    const sp = model.site_pos as Float64Array;
    const saved = Array.from(sp.slice(3 * sid, 3 * sid + 3));
    const before = reachSphere(mujoco, model, data, SO101_HELD_SITE)!.r;
    try {
      sp[3 * sid + 2] -= 0.06;
      expect(reachSphere(mujoco, model, data, SO101_HELD_SITE)!.r).toBeGreaterThan(before + 0.01);
    } finally {
      sp.set(saved, 3 * sid);
    }
    expect(reachSphere(mujoco, model, data, SO101_HELD_SITE)!.r).toBeCloseTo(before, 12);
  });
  it("calls a target beyond the arm's full length out of reach, and says how far short it falls", () => {
    const { pivot, r: R } = reachSphere(mujoco, model, data)!;
    const target: [number, number, number] = [pivot[0] + R + 0.1, pivot[1], pivot[2]];
    const r = solveIk(mujoco, model, data, target, "front");
    expect(r.ok).toBe(false);
    expect(r.failure_class).toBe("embodiment_limit");
    expect(r.pos_err_mm).toBeGreaterThanOrEqual(100 - 1e-6);
    expect(r.pos_err_mm).toBeLessThan(100 + 0.1 * R * 1000);
  });
});

describe("damped least squares", () => {
  it("solves an identity system up to the damping", () => {
    const I = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? 1 : 0)));
    expect(dls(I, [1, 2, 3], 0).map((v) => +v.toFixed(9))).toEqual([1, 2, 3]);
    expect(dls(I, [1, 0, 0], 1)[0]).toBeCloseTo(0.5, 9);
  });
});
