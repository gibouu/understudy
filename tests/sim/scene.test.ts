import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TaskSpec, type Scenario } from "@/lib/spec/schema";
import { apply, buildScene, halfHeightMm, layoutMissingPoses, matToQuat, mjcfName, perturb, SceneError, standaloneXml, WALL_M, worldPoses } from "@/lib/sim/scene";
import { stageXml, SO101_XML } from "@/lib/sim/so101";

/** A free test tube above the table: the orbit demo for the gravity check. */
function demoTubeXml(): string {
  return `<body name="demo_tube" pos="0.25 -0.1 0.12">
      <freejoint name="demo_tube_free"/>
      <geom name="demo_tube_geom" type="cylinder" size="0.0085 0.05" rgba="0.93 0.52 0.2 1" friction="1 0.005 0.0001"/>
    </body>`;
}

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
    // the first free slot after the rack (y 100, disc radius of a 120 x 80 box) with a 40 mm gap, yaw-safe discs throughout
    const rackRadius = Math.hypot(120, 80) / 2;
    const saucerWidth = Math.hypot(140, 140);
    expect(build.frames.saucer.xyz_m[1]).toBeCloseTo((100 + rackRadius + 40 + saucerWidth / 2) / 1000, 6);
    expect(build.worldbody).toContain('name="obj_saucer_zone"');
  });
  it("converts yaw to radians and emits a quaternion", () => {
    expect(build.frames.rack.yaw_rad).toBeCloseTo((10 * Math.PI) / 180, 6);
    const [w, x, y, z] = build.frames.rack.quat;
    expect([w, x, y, z]).toEqual([expect.closeTo(Math.cos((5 * Math.PI) / 180), 6), expect.closeTo(0, 6), expect.closeTo(0, 6), expect.closeTo(Math.sin((5 * Math.PI) / 180), 6)]);
    expect(build.worldbody).toMatch(/<body name="obj_rack" pos="0.25 0.1 0.02" quat="0.996195 0 0 0.087156">/);
  });
  it("carries a parent's tilt into its children", () => {
    const chain = TaskSpec.parse({
      ...spec,
      objects: [
        ...spec.objects,
        { id: "tray", name: "tray", shape: "box", size_mm: [200, 200, 40], symmetry: "none", role: "surface", pose: { xyz_mm: [250, 0, 20] }, source: "vl#seg1" },
        { id: "cap", name: "cap", shape: "box", size_mm: [20, 20, 10], symmetry: "none", role: "obstacle", pose: { xyz_mm: [0, 0, 40], frame: "tray" }, source: "vl#seg1" },
      ],
    });
    const w = worldPoses(chain, { tray: { axis: "y", deg: 90 } }, { partial: true });
    expect(w.cap.xyz_mm[0]).toBeCloseTo(290, 6); // +z of the tray now points along +x
    // on its edge the tray stands 200 mm tall: raised 80 mm so it does not sink into the table, the cap with it
    expect(w.tray.xyz_mm[2]).toBeCloseTo(100, 6);
    expect(w.cap.xyz_mm[2]).toBeCloseTo(100, 6);
    const zAxis = apply(w.cap.R, [0, 0, 1]);
    expect(zAxis[0]).toBeCloseTo(1, 6);
    expect(matToQuat(w.cap.R)[2]).toBeCloseTo(Math.sin(Math.PI / 4), 6);
  });
  it.each([
    ["box", [60, 40, 30], "x", 5],
    ["box", [60, 40, 30], "y", -12],
    ["cylinder", [16, 16, 100], "y", 8],
    ["cylinder", [80, 80, 20], "x", 30],
    ["sphere", [30, 30, 30], "x", 20],
  ] as const)("raises a tilted %s %j (%s %d deg) until its lowest point is back on the table", (shape, size_mm, axis, deg) => {
    const one = TaskSpec.parse({
      ...spec,
      objects: [{ id: "thing", name: "thing", shape, size_mm, symmetry: "none", role: "obstacle", pose: { xyz_mm: [250, 0, size_mm[2] / 2], yaw_deg: 30 }, source: "vl#seg1" }],
      steps: [],
    });
    const lowest = (w: ReturnType<typeof worldPoses>) => w.thing.xyz_mm[2] - halfHeightMm(one.objects[0], w.thing.R);
    expect(lowest(worldPoses(one))).toBeCloseTo(0, 9);
    const tilted = worldPoses(one, { thing: { axis, deg } });
    expect(lowest(tilted)).toBeCloseTo(0, 9);
    if (shape !== "sphere") expect(tilted.thing.xyz_mm[2]).toBeGreaterThan(size_mm[2] / 2);
    // the same corner, found independently: every vertex of the box (or rim point of the cylinder), turned
    const pts: [number, number, number][] =
      shape === "box"
        ? [-1, 1].flatMap((i) => [-1, 1].flatMap((j) => [-1, 1].map((k): [number, number, number] => [(i * size_mm[0]) / 2, (j * size_mm[1]) / 2, (k * size_mm[2]) / 2])))
        : shape === "cylinder"
          ? Array.from({ length: 720 }, (_, n) => [-1, 1].map((k): [number, number, number] => [(size_mm[0] / 2) * Math.cos((n * Math.PI) / 360), (size_mm[0] / 2) * Math.sin((n * Math.PI) / 360), (k * size_mm[2]) / 2])).flat()
          : [];
    if (pts.length) expect(Math.min(...pts.map((p) => tilted.thing.xyz_mm[2] + apply(tilted.thing.R, p)[2]))).toBeCloseTo(0, 3);
  });
  it("lays out an unposed parent before resolving its posed child", () => {
    const orphan = TaskSpec.parse({
      ...spec,
      objects: [
        spec.objects[0],
        { id: "tray", name: "tray", shape: "box", size_mm: [200, 200, 40], symmetry: "none", role: "surface", source: "vl#seg1" },
        { id: "cap", name: "cap", shape: "box", size_mm: [20, 20, 10], symmetry: "none", role: "obstacle", pose: { xyz_mm: [0, 0, 25], frame: "tray" }, source: "vl#seg1" },
      ],
      steps: [spec.steps[0]],
    });
    const b = buildScene(orphan);
    expect(b.laidOut).toEqual(["tray"]);
    expect(b.frames.cap.xyz_m[2]).toBeCloseTo(0.02 + 0.025, 6);
  });
  it("reports cycles, unknown frames and duplicate ids as errors", () => {
    const cyc = structuredClone(spec);
    cyc.objects[0].pose = { xyz_mm: [0, 0, 0], yaw_deg: 0, frame: "rack" };
    cyc.objects[1].pose = { xyz_mm: [0, 0, 0], yaw_deg: 0, frame: "marker" };
    expect(() => buildScene(cyc)).toThrow(/cyclic/);
    const unk = structuredClone(spec);
    unk.objects[0].pose = { xyz_mm: [0, 0, 0], yaw_deg: 0, frame: "ghost" };
    expect(() => buildScene(unk)).toThrow(/unknown frame/);
    const dup = structuredClone(spec);
    dup.objects.push({ ...dup.objects[0] });
    expect(() => buildScene(dup)).toThrow(/twice/);
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
    const w = worldPoses(child, {}, { partial: true });
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
    expect(() => perturb(huge, { id: "x", name: "x", axis: "x_mm", offset: Number.MAX_VALUE, object: "marker", expected: "unknown", why: "", gravity_g: 1 })).toThrow(/non-finite/);
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
  it("treats a yawed box as the disc of its diagonal", () => {
    const yawed = TaskSpec.parse({
      ...spec,
      objects: [
        { id: "big", name: "big", shape: "box", size_mm: [200, 200, 40], symmetry: "none", role: "manipulated", pose: { xyz_mm: [250, 0, 20], yaw_deg: 45 }, source: "vl#seg1" },
        { id: "other", name: "other", shape: "box", size_mm: [200, 200, 40], symmetry: "none", role: "obstacle", source: "vl#seg1" },
      ],
      steps: [],
    });
    const y = layoutMissingPoses(yawed).spec.objects[1].pose!.xyz_mm[1];
    expect(Math.abs(y)).toBeGreaterThanOrEqual(Math.hypot(200, 200) + 40 - 1e-6); // two diagonal radii plus the gap
  });
  it("does not let a far-away object pull a new one below the layout start", () => {
    const far = TaskSpec.parse({
      ...spec,
      objects: [
        { id: "far", name: "far", shape: "box", size_mm: [40, 40, 40], symmetry: "none", role: "manipulated", pose: { xyz_mm: [250, -1000, 20] }, source: "vl#seg1" },
        { id: "new", name: "new", shape: "box", size_mm: [100, 100, 40], symmetry: "none", role: "obstacle", source: "vl#seg1" },
      ],
      steps: [],
    });
    expect(layoutMissingPoses(far).spec.objects[1].pose!.xyz_mm[1]).toBeGreaterThanOrEqual(-250);
  });
  it("runs out of room instead of spilling off the table", () => {
    const many = TaskSpec.parse({
      ...spec,
      objects: Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, name: `b${i}`, shape: "box" as const, size_mm: [200, 200, 40] as [number, number, number], symmetry: "none" as const, role: i === 0 ? ("manipulated" as const) : ("obstacle" as const), source: "vl#seg1" })),
      steps: [],
    });
    expect(() => layoutMissingPoses(many)).toThrow(/no room/);
  });
  it("reserves the children a laid-out parent makes resolvable before placing the next object", () => {
    const cubes = TaskSpec.parse({
      ...spec,
      objects: [
        { id: "parent", name: "parent", shape: "box", size_mm: [40, 40, 40], symmetry: "none", role: "manipulated", source: "vl#seg1" },
        { id: "child", name: "child", shape: "box", size_mm: [40, 40, 40], symmetry: "none", role: "obstacle", pose: { xyz_mm: [0, 96.5685425, 0], frame: "parent" }, source: "vl#seg1" },
        { id: "third", name: "third", shape: "box", size_mm: [40, 40, 40], symmetry: "none", role: "obstacle", source: "vl#seg1" },
      ],
      steps: [],
    });
    const b = buildScene(cubes);
    const dy = Math.abs(b.frames.third.xyz_m[1] - b.frames.child.xyz_m[1]) * 1000;
    expect(dy).toBeGreaterThanOrEqual(Math.hypot(40, 40) + 40 - 1e-6);
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
    id: `sc-${axis}`, name: axis, axis, offset, object, expected: "unknown", why: "", gravity_g: 1, ...extra,
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
    const level = structuredClone(t.spec);
    level.objects[1].pose!.yaw_deg = 0;
    expect(buildScene(level, t.tilts).frames.rack.quat).toEqual([expect.closeTo(Math.cos((2.5 * Math.PI) / 180), 6), expect.closeTo(0, 6), expect.closeTo(Math.sin((2.5 * Math.PI) / 180), 6), expect.closeTo(0, 6)]);
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

describe("gravity", () => {
  it("is set after the arm's include so it wins, per preset", () => {
    expect(stageXml("", { gravity_g: 0 })).toMatch(/<include file="so101.xml"\/>\s*<option gravity="0 0 0"\/>/);
    expect(stageXml("", { gravity_g: 1 })).toContain('<option gravity="0 0 -9.81"/>');
    expect(stageXml("")).toContain('<option gravity="0 0 -9.81"/>');
  });
  it("lets a free tube fall on Earth and hang in orbit", async () => {
    const { default: loadMujoco } = await import("@mujoco/mujoco");
    const mujoco = await loadMujoco();
    const heightAfter = (g: number) => {
      const model = mujoco.MjModel.from_xml_string(standaloneXml(demoTubeXml(), g));
      const data = new mujoco.MjData(model);
      try {
        for (let i = 0; i < 200; i++) mujoco.mj_step(model, data); // one simulated second
        const qpos = Array.from(data.qpos as ArrayLike<number>);
        return qpos[2]; // free joint: x y z, then the quaternion
      } finally {
        data.delete();
        model.delete();
      }
    };
    const earth = heightAfter(1);
    const orbit = heightAfter(0);
    expect(orbit).toBeCloseTo(0.12, 3); // where it started
    expect(earth).toBeLessThan(0.08); // fell to the floor
  }, 30_000);
  it("passes a scenario's gravity through perturb", () => {
    const r = perturb(spec, { id: "orbit", name: "orbit", axis: "x_mm", offset: 0, object: "rack", expected: "unknown", why: "", gravity_g: 0 });
    expect(r.gravity_g).toBe(0);
    expect(perturb(spec, { id: "e", name: "e", axis: "x_mm", offset: 0, object: "rack", expected: "unknown", why: "", gravity_g: 1 }).gravity_g).toBe(1);
  });
});
