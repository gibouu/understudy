import { describe, expect, it } from "vitest";
import { TaskSpec, type Scenario } from "@/lib/spec/schema";
import { buildScene, layoutMissingPoses, perturb, standaloneXml, WALL_M } from "@/lib/sim/scene";

const spec = TaskSpec.parse({
  version: 1,
  title: "marker into rack",
  summary: "",
  objects: [
    { id: "marker", name: "marker", shape: "cylinder", size_mm: [15, 15, 140], symmetry: "axial", role: "manipulated", pose: { xyz_mm: [250, -100, 70] }, source: "vl#seg1" },
    { id: "rack", name: "rack", shape: "box", size_mm: [120, 80, 40], symmetry: "none", role: "fixture", pocket_clearance_mm: 3, pose: { xyz_mm: [250, 100, 20], yaw_deg: 10 }, source: "vl#seg1" },
    { id: "saucer", name: "saucer", shape: "cylinder", size_mm: [140, 140, 10], symmetry: "axial", role: "fixture", source: "vl#seg1" },
  ],
  steps: [
    { id: "s1", verb: "grasp", object: "marker", t_start_s: 0, t_end_s: 1, source: "vl#seg1" },
    { id: "s2", verb: "insert", object: "marker", target: { fixture: "pocket", frame: "rack" }, t_start_s: 1, t_end_s: 2, source: "vl#seg2" },
  ],
});

describe("buildScene", () => {
  const build = buildScene(spec);
  it("makes a free body with a cylinder geom for the manipulated object", () => {
    expect(build.worldbody).toContain('<body name="marker" pos="0.25 -0.1 0.07"');
    expect(build.worldbody).toContain('<freejoint name="marker_free"/>');
    expect(build.worldbody).toContain('type="cylinder" size="0.0075 0.07"');
  });
  it("builds the rack pocket from the marker footprint plus clearance", () => {
    expect(build.pockets.rack.inner_m[0]).toBeCloseTo(0.021, 6); // 15 + 2 * 3 mm
    expect(build.pockets.rack.depth_m).toBeCloseTo(0.04 - WALL_M, 6);
    // walls: (120 - 21) / 2 = 49.5 mm thick, half-size 24.75 mm
    expect(build.worldbody).toContain('name="rack_wall_xneg" type="box" pos="-0.03525 0 0" size="0.02475 0.04 0.02"');
    expect(build.worldbody).toContain('name="rack_pocket"');
    expect(build.worldbody).not.toContain('name="rack_free"');
  });
  it("lays out objects without a pose and says so", () => {
    expect(build.laidOut).toEqual(["saucer"]);
    expect(build.warnings[0]).toMatch(/saucer.*no pose/);
    expect(build.frames.saucer.xyz_m[2]).toBeCloseTo(0.005, 6); // resting on the table
    expect(build.worldbody).toContain('name="saucer_zone"');
  });
  it("converts yaw to radians in the body frame", () => {
    expect(build.frames.rack.euler_rad[2]).toBeCloseTo((10 * Math.PI) / 180, 6);
  });
});

describe("layoutMissingPoses", () => {
  it("does not touch objects that have a pose", () => {
    const { spec: out, laidOut } = layoutMissingPoses(spec);
    expect(laidOut).toEqual(["saucer"]);
    expect(out.objects[0].pose?.xyz_mm).toEqual([250, -100, 70]);
    expect(out.objects[2].sources.pose).toBe("default");
  });
});

describe("perturb", () => {
  const scenario = (axis: Scenario["axis"], offset: number, object = "rack", extra: Partial<Scenario> = {}): Scenario => ({
    id: `sc-${axis}`, name: axis, axis, offset, object, expected: "unknown", why: "", ...extra,
  });
  it("moves the rack along x", () => {
    const { spec: out } = perturb(spec, scenario("x_mm", 6));
    expect(out.objects[1].pose?.xyz_mm[0]).toBe(256);
    expect(spec.objects[1].pose?.xyz_mm[0]).toBe(250); // input untouched
  });
  it("changes the pocket clearance and clamps at zero", () => {
    expect(perturb(spec, scenario("clearance_mm", -2)).spec.objects[1].pocket_clearance_mm).toBe(1);
    const r = perturb(spec, scenario("clearance_mm", -9));
    expect(r.spec.objects[1].pocket_clearance_mm).toBe(0);
    expect(r.warnings.join()).toMatch(/clamped/);
  });
  it("records a tilt for the scene and warns about yaw on a symmetric object", () => {
    const t = perturb(spec, scenario("tilt_deg", 5, "rack", { tilt_axis: "y" }));
    expect(t.tilts.rack).toEqual({ axis: "y", deg: 5 });
    expect(buildScene(t.spec, t.tilts).frames.rack.euler_rad[1]).toBeCloseTo((5 * Math.PI) / 180, 6);
    const y = perturb(spec, scenario("yaw_deg", 20, "marker"));
    expect(y.warnings.join()).toMatch(/changes nothing/);
  });
  it("leaves the world alone for observation noise", () => {
    const r = perturb(spec, scenario("pose_noise_mm", 2));
    expect(r.spec.objects[1].pose?.xyz_mm).toEqual([250, 100, 20]);
    expect(r.warnings.join()).toMatch(/observation noise/);
  });
  it("throws on an unknown object", () => {
    expect(() => perturb(spec, scenario("x_mm", 1, "ghost"))).toThrow(/unknown object/);
  });
});

describe("the generated scene compiles in MuJoCo", () => {
  it("loads with the expected bodies and geoms", async () => {
    const { default: loadMujoco } = await import("@mujoco/mujoco");
    const mujoco = await loadMujoco();
    const build = buildScene(spec);
    const model = mujoco.MjModel.from_xml_string(standaloneXml(build.worldbody));
    try {
      expect(model.nbody).toBe(4); // world + marker + rack + saucer
      expect(model.ngeom).toBe(1 + 1 + 5 + 1); // floor, marker, rack walls + floor, saucer
      expect(model.nsite).toBe(3 + 2 + 1); // *_site x3, rack pocket + pocket floor, saucer zone
      expect(model.nq).toBe(7); // one free joint
    } finally {
      model.delete();
    }
  }, 30_000);
});
