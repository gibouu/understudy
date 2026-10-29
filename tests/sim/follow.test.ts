import type { MainModule } from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import { BOX_Y_MM, BOX_Z_MM, PLANE_X_MM, scalePath, type HandSample } from "@/lib/sim/gesture";
import { environment, runToEnd } from "@/lib/sim/interpreter";
import { stageXml } from "@/lib/sim/so101";
import { loadSo101 } from "@/lib/sim/so101-disk";
import { Program, TaskSpec, type PathPoint } from "@/lib/spec/schema";

let mujoco: MainModule;

beforeAll(async () => {
  mujoco = await loadSo101();
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
  const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g, graspable: env.graspable }));
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
    expect(rollout(gestureSpec(back), FOLLOW, 1).why).toMatch(/does not move forward in time/);
    // two points at one time: a jump no speed cap could slow down
    const same = swing();
    same[5] = { ...same[5], t_s: same[4].t_s };
    const r = rollout(gestureSpec(same), FOLLOW, 1);
    expect(r.failure_class).toBe("spec_gap");
    expect(r.why).toMatch(/does not move forward in time/);
    const elsewhere = Program.parse({ spec_title: "", steps: [{ step_id: "s9", ops: [{ op: "follow" }] }] });
    expect(rollout(gestureSpec(swing()), elsewhere, 1).why).toMatch(/not a gesture with a path/);
  }, 120_000);

  it("holds the joints to the cap even when points are under a physics step apart", () => {
    // 20 points a millisecond apart, 5 mm each: no MuJoCo step is that short, and the arm still turns at most 2 rad/s
    const path: PathPoint[] = Array.from({ length: 20 }, (_, k) => ({ t_s: k / 1000, xyz_mm: [220, -50 + 5 * k, 240] }));
    const r = rollout(gestureSpec(path), FOLLOW, 1);
    expect(r.pass, r.log.join("\n")).toBe(true);
    expect(r.followed![0].speed).toBeLessThan(0.1);
    expect(r.followed![0].speed).toBeGreaterThan(0);
    expect(r.log.join("\n")).toMatch(/the arm is held to 2/);
    expect(r.log.join("\n")).not.toMatch(/0\.00x/);
  }, 120_000);

  /** a path through `corners` (y, z in mm, in the plane), a point every 5 mm, 0.05 s apart */
  function through(corners: [number, number][]): PathPoint[] {
    const out: PathPoint[] = [];
    corners.slice(1).forEach(([y1, z1], i) => {
      const [y0, z0] = corners[i];
      const n = Math.max(1, Math.ceil(Math.hypot(y1 - y0, z1 - z0) / 5));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) out.push({ t_s: out.length * 0.05, xyz_mm: [PLANE_X_MM, y0 + ((y1 - y0) * k) / n, z0 + ((z1 - z0) * k) / n] });
    });
    return out;
  }
  const [y0, y1] = BOX_Y_MM;
  const [z0, z1] = BOX_Z_MM;
  const mid = (z0 + z1) / 2;

  it.each([1, 0])("reaches every corner of the box and its bottom centre at %s g", (g) => {
    const path = through([[0, z0], [y0, z0], [y0, z1], [y1, z1], [y1, z0], [0, z0], [0, mid]]);
    const r = rollout(gestureSpec(path), FOLLOW, g);
    expect(r.pass, r.log.join("\n")).toBe(true);
    expect(r.followed![0].missed).toEqual([]);
  }, 180_000);

  it.each([1, 0])("follows a circle that fills the box at %s g", (g) => {
    // a hand going round once, with no arm to scale by: the path fills the box
    const samples: HandSample[] = Array.from({ length: 91 }, (_, k) => ({ t_s: k / 30, x_m: 0.2 * Math.cos((2 * Math.PI * k) / 90), y_m: 0.2 * Math.sin((2 * Math.PI * k) / 90) }));
    const path = scalePath(samples, null).path;
    expect(Math.min(...path.map((p) => p.xyz_mm[2]))).toBeCloseTo(z0, 0);
    const r = rollout(gestureSpec(path), FOLLOW, g);
    expect(r.pass, r.log.join("\n")).toBe(true);
  }, 180_000);

  it("draws the path on the stage as markers that touch nothing", () => {
    const env = environment(gestureSpec(swing()));
    expect(env.worldbody.match(/<geom name="gesture_0_/g)).toHaveLength(41);
    expect(env.graspable).toEqual([]);
  });
});
