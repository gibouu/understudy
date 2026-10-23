import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TaskSpec, type Scenario } from "@/lib/spec/schema";
import { buildScene, layoutMissingPoses, mjcfName, perturb, SceneError, standaloneXml, WALL_M, worldPoses } from "@/lib/sim/scene";
import { stageXml, SO101_XML } from "@/lib/sim/so101";

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

describe("mjcfName", () => {
  it("is namespaced and injective", () => {
    expect(mjcfName("rack")).toBe("obj_rack");
    expect(mjcfName("a_b")).toBe("obj_a__b");
    expect(mjcfName("a b")).toBe("obj_a_20_b");
    expect(mjcfName("a_20_b")).toBe("obj_a__20__b");
    expect(new Set(["a b", "a_b", "a_20_b", "a-b", "base"].map(mjcfName)).size).toBe(5);
  });
});

describe("buildScene", () => {
  const build = buildScene(spec);
  it("makes a free body with a cylinder geom for the manipulated object", () => {
    expect(build.names.marker).toBe("obj_marker");
    expect(build.worldbody).toContain('<body name="obj_marker" pos="0.25 -0.1 0.07"');
    expect(build.worldbody).toContain('<freejoint name="obj_marker_free"/>');
    expect(build.worldbody).toContain('type="cylinder" size="0.0075 0.07"');
  });
  it("builds the rack pocket from the marker footprint plus the clearance, once", () => {
    expect(build.pockets.rack.inner_m[0]).toBeCloseTo(0.018, 6); // 15 + 3 mm
    expect(build.pockets.rack.depth_m).toBeCloseTo(0.04 - WALL_M, 6);
    // walls: (120 - 18) / 2 = 51 mm thick, half-size 25.5 mm, centred at 9 + 25.5 mm
    expect(build.worldbody).toContain('name="obj_rack_wall_xneg" type="box" pos="-0.0345 0 0" size="0.0255 0.04 0.02"');
    expect(build.worldbody).toContain('name="obj_rack_pocket"');
    expect(build.worldbody).not.toContain('name="obj_rack_free"');
  });
  it("lays out objects without a pose next to what is already placed, and says so", () => {
    expect(build.laidOut).toEqual(["saucer"]);
    expect(build.warnings[0]).toMatch(/saucer.*no pose/);
    expect(build.frames.saucer.xyz_m[2]).toBeCloseTo(0.005, 6); // resting on the table
    // the first free 140 mm slot after the marker (y -100) and the rack (y 100, 120 mm wide) with 40 mm gaps
    expect(build.frames.saucer.xyz_m[1]).toBeCloseTo(0.27, 6);
    expect(build.worldbody).toContain('name="obj_saucer_zone"');
  });
  it("converts yaw to radians in the body frame", () => {
    expect(build.frames.rack.euler_rad[2]).toBeCloseTo((10 * Math.PI) / 180, 6);
  });
  it("composes pose chains into world poses", () => {
    const child = TaskSpec.parse({
      ...spec,
      objects: [
        ...spec.objects,
        { id: "lid", name: "lid", shape: "box", size_mm: [30, 30, 5], symmetry: "none", role: "obstacle", pose: { xyz_mm: [30, 0, 10], yaw_deg: 5, frame: "rack2" }, source: "vl#seg1" },
        { id: "rack2", name: "rack2", shape: "box", size_mm: [120, 80, 40], symmetry: "none", role: "fixture", pose: { xyz_mm: [250, 100, 20], yaw_deg: 90 }, source: "vl#seg1" },
      ],
    });
    const w = worldPoses(child);
    expect(w.lid.xyz_mm[0]).toBeCloseTo(250, 6);
    expect(w.lid.xyz_mm[1]).toBeCloseTo(130, 6);
    expect(w.lid.xyz_mm[2]).toBeCloseTo(30, 6);
    expect(w.lid.yaw_deg).toBeCloseTo(95, 6);
    expect(buildScene(child).frames.lid.xyz_m[1]).toBeCloseTo(0.13, 6);
  });
  it("refuses geometry that cannot exist", () => {
    const tiny = structuredClone(spec);
    tiny.objects[1].size_mm = [20, 20, 40];
    expect(() => buildScene(tiny)).toThrow(SceneError);
    expect(() => buildScene(tiny)).toThrow(/too small/);
    const shallow = structuredClone(spec);
    shallow.objects[1].size_mm = [120, 80, 1];
    expect(() => buildScene(shallow)).toThrow(/too shallow/);
    const huge = structuredClone(spec);
    huge.objects[0].pose = { xyz_mm: [Number.MAX_VALUE, 0, 0], yaw_deg: 0, frame: "world" };
    expect(() => perturb(huge, { id: "x", name: "x", axis: "x_mm", offset: Number.MAX_VALUE, object: "marker", expected: "unknown", why: "" })).toThrow(/non-finite/);
  });
  it("keeps special ids in its registries", () => {
    const odd = TaskSpec.parse({ ...spec, objects: [{ ...spec.objects[0], id: "__proto__" }, spec.objects[1]], steps: [{ ...spec.steps[0], object: "__proto__" }, { ...spec.steps[1], object: "__proto__" }] });
    const b = buildScene(odd);
    expect(Object.keys(b.frames)).toEqual(["__proto__", "rack"]);
    expect(Object.entries(b.names)).toEqual([["__proto__", mjcfName("__proto__")], ["rack", "obj_rack"]]);
    expect(JSON.stringify(b.names)).toContain('"__proto__":"obj_____proto____"');
  });
});

describe("layoutMissingPoses", () => {
  it("does not touch objects that have a pose", () => {
    const { spec: out, laidOut } = layoutMissingPoses(spec);
    expect(laidOut).toEqual(["saucer"]);
    expect(out.objects[0].pose?.xyz_mm).toEqual([250, -100, 70]);
    expect(out.objects[2].sources.pose).toBe("default");
  });
  it("never places a new object inside a placed one", () => {
    const crowded = TaskSpec.parse({
      ...spec,
      objects: [
        { id: "box1", name: "box1", shape: "box", size_mm: [40, 40, 40], symmetry: "none", role: "manipulated", pose: { xyz_mm: [250, 0, 20] }, source: "vl#seg1" },
        { id: "box2", name: "box2", shape: "box", size_mm: [40, 40, 40], symmetry: "none", role: "obstacle", source: "vl#seg1" },
      ],
      steps: [],
    });
    const { spec: out } = layoutMissingPoses(crowded);
    const y = out.objects[1].pose!.xyz_mm[1];
    expect(Math.abs(y - 0)).toBeGreaterThanOrEqual(40 + 40); // footprints plus the gap apart
  });
});

describe("perturb", () => {
  const scenario = (axis: Scenario["axis"], offset: number, object = "rack", extra: Partial<Scenario> = {}): Scenario => ({
    id: `sc-${axis}`, name: axis, axis, offset, object, expected: "unknown", why: "", ...extra,
  });
  it("moves the rack along world x", () => {
    const r = perturb(spec, scenario("x_mm", 6));
    expect(r.applied).toBe(true);
    expect(r.spec.objects[1].pose?.xyz_mm[0]).toBe(256);
    expect(spec.objects[1].pose?.xyz_mm[0]).toBe(250); // input untouched
  });
  it("converts a world offset into a yawed parent frame", () => {
    const child = TaskSpec.parse({
      ...spec,
      objects: [...spec.objects, { id: "lid", name: "lid", shape: "box", size_mm: [30, 30, 5], symmetry: "none", role: "obstacle", pose: { xyz_mm: [0, 0, 0], yaw_deg: 0, frame: "rack2" }, source: "vl#seg1" }, { id: "rack2", name: "rack2", shape: "box", size_mm: [120, 80, 40], symmetry: "none", role: "fixture", pose: { xyz_mm: [250, 100, 20], yaw_deg: 90 }, source: "vl#seg1" }],
    });
    const r = perturb(child, scenario("x_mm", 10, "lid"));
    const lid = r.spec.objects.find((o) => o.id === "lid")!;
    expect(lid.pose!.xyz_mm[0]).toBeCloseTo(0, 6);
    expect(lid.pose!.xyz_mm[1]).toBeCloseTo(-10, 6); // +x in the world is -y in a frame yawed by 90 degrees
    expect(worldPoses(r.spec).lid.xyz_mm[0]).toBeCloseTo(260, 6);
  });
  it("changes the pocket clearance, clamps at zero, and refuses it on a non-pocket", () => {
    expect(perturb(spec, scenario("clearance_mm", -2)).spec.objects[1].pocket_clearance_mm).toBe(1);
    const r = perturb(spec, scenario("clearance_mm", -9));
    expect(r.spec.objects[1].pocket_clearance_mm).toBe(0);
    expect(r.warnings.join()).toMatch(/clamped/);
    const na = perturb(spec, scenario("clearance_mm", 2, "saucer"));
    expect(na.applied).toBe(false);
    expect(na.warnings.join()).toMatch(/not one/);
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
    expect(r.applied).toBe(false);
    expect(r.spec.objects[1].pose?.xyz_mm).toEqual([250, 100, 20]);
    expect(r.warnings.join()).toMatch(/observation noise/);
  });
  it("throws on an unknown object", () => {
    expect(() => perturb(spec, scenario("x_mm", 1, "ghost"))).toThrow(/unknown object/);
  });
});

describe("the generated scene compiles in MuJoCo", () => {
  it("loads standalone with the expected bodies and geoms", async () => {
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
  it("loads the full stage next to the arm even with ids that match arm bodies", async () => {
    const { default: loadMujoco } = await import("@mujoco/mujoco");
    const mujoco = await loadMujoco();
    const dir = path.join(process.cwd(), "assets", "so101");
    const vfs = new mujoco.MjVFS();
    vfs.addBuffer(SO101_XML, new Uint8Array(readFileSync(path.join(dir, SO101_XML))));
    for (const file of readdirSync(path.join(dir, "assets"))) vfs.addBuffer(file, new Uint8Array(readFileSync(path.join(dir, "assets", file))));
    const clash = TaskSpec.parse({
      ...spec,
      objects: [{ ...spec.objects[0], id: "gripper" }, { ...spec.objects[1], id: "base" }, { ...spec.objects[2], id: "a b" }, { ...spec.objects[2], id: "a_b" }],
      steps: [{ ...spec.steps[0], object: "gripper" }, { ...spec.steps[1], object: "gripper", target: { fixture: "pocket", frame: "base" } }],
    });
    const build = buildScene(clash);
    const model = mujoco.MjModel.from_xml_string(stageXml(build.worldbody), vfs);
    try {
      expect(model.nbody).toBeGreaterThan(8 + 4); // the arm's bodies plus ours
      expect(model.nq).toBe(6 + 7); // six arm joints plus one free joint
    } finally {
      model.delete();
      vfs.delete();
    }
  }, 60_000);
});
