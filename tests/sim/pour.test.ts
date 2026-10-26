import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MainModule, MjVFS } from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import { DEMO_SPEC, POUR_PROGRAMS, POUR_SPEC } from "@/lib/sim/demo-spec";
import { environment, runToEnd, type Environment } from "@/lib/sim/interpreter";
import { Liquid, MAX_PARTICLES, planLiquid } from "@/lib/sim/liquid";
import { buildScene, CONTAINER_WALL_M, SceneError } from "@/lib/sim/scene";
import { park, SO101_XML, stageXml } from "@/lib/sim/so101";
import { PREDICATE_OPERANDS, Predicate, Program, ProgramOp, TaskSpec } from "@/lib/spec/schema";
import { lintProgram, validateSpec } from "@/lib/spec/validate";
import { formFor, withRequiredAsks } from "@/lib/spec/answer";

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

/**
 * Build the world, park the arm, fill the liquid, run the program, as the worker does; `after_s` keeps stepping
 * once the program is done. Returns the rollout and where the liquid is at the end.
 */
function pour(program: Program, gravity_g: number, { spec = POUR_SPEC, seed = 1, after_s = 0 }: { spec?: TaskSpec; seed?: number; after_s?: number } = {}) {
  const env: Environment = environment(spec);
  const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g, graspable: env.graspable }), vfs);
  const data = new mujoco.MjData(model);
  try {
    park(mujoco, model, data);
    const liquid = env.liquid ? new Liquid(mujoco, model, data, env.liquid, { gravity_g, seed }) : null;
    const r = runToEnd({ mujoco, model, data, liquid }, env, program, "sensed");
    const dt = (model.opt as { timestep: number }).timestep;
    for (let s = 0; s < after_s; s += dt) {
      mujoco.mj_step(model, data);
      liquid?.advance(model, data, dt);
    }
    return { r, where: liquid?.where(data) ?? null, particles: liquid?.count ?? 0 };
  } finally {
    data.delete();
    model.delete();
  }
}
const ops = (...list: unknown[]) => Program.parse({ spec_title: POUR_SPEC.title, steps: [{ step_id: "s1", ops: list }] });
const grip = [
  { op: "move_to", frame: "cup", offset_mm: [0, 0, 50], approach: "front" },
  { op: "move_to", frame: "cup", offset_mm: [0, 0, 0], approach: "front" },
  { op: "grasp", object: "cup", aperture_mm: 48 },
];

describe("the pour step in the spec", () => {
  it("parses a pour step and the liquid a container holds", () => {
    const s = POUR_SPEC.steps[0];
    expect(s.verb).toBe("pour");
    expect(s.pour).toEqual({ into: "bowl", tilt_deg: 120, tilt_s: 1.5 });
    expect(POUR_SPEC.objects.find((o) => o.id === "cup")?.liquid_ml).toBe(38);
    expect(validateSpec(POUR_SPEC).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("refuses a tilt of nothing or past upside down, and liquid that is not there", () => {
    const step = (pour: unknown) => TaskSpec.safeParse({ ...POUR_SPEC, steps: [{ ...POUR_SPEC.steps[0], pour }] }).success;
    expect(step({ into: "bowl", tilt_deg: 0 })).toBe(false);
    expect(step({ into: "bowl", tilt_deg: 181 })).toBe(false);
    expect(step({ into: "bowl", tilt_deg: 90 })).toBe(true);
    expect(TaskSpec.safeParse({ ...POUR_SPEC, objects: [{ ...POUR_SPEC.objects[1], liquid_ml: 0 }] }).success).toBe(false);
  });

  it("reports a pour into an object the spec does not have", () => {
    const bad = TaskSpec.parse({ ...POUR_SPEC, steps: [{ ...POUR_SPEC.steps[0], pour: { into: "vat", tilt_deg: 90 } }] });
    expect(validateSpec(bad).find((i) => i.path === "steps[0].pour.into")?.severity).toBe("error");
  });

  it("is additive: a spec without it parses as before", () => {
    expect(DEMO_SPEC.steps.every((s) => s.pour === undefined)).toBe(true);
    expect(DEMO_SPEC.objects.every((o) => o.liquid_ml === undefined)).toBe(true);
  });
});

describe("the tilt op and the liquid check", () => {
  it("parses a tilt, a second by default, and a liquid_inside check that needs a target and a share", () => {
    expect(ProgramOp.parse({ op: "tilt", deg: 120, toward: "bowl" })).toEqual({ op: "tilt", deg: 120, toward: "bowl", seconds: 1 });
    expect(ProgramOp.safeParse({ op: "tilt", deg: 200 }).success).toBe(false);
    expect(PREDICATE_OPERANDS.liquid_inside).toMatchObject({ object: false, target: true, value: true });
    expect(Predicate.safeParse({ kind: "liquid_inside", target: "bowl" }).success).toBe(false);
    expect(Predicate.safeParse({ kind: "liquid_inside", target: "bowl", value: 90 }).success).toBe(true);
  });

  it("asks what counts as a pour, in shares of the liquid, when the spec does not say", () => {
    const open = TaskSpec.parse({ ...POUR_SPEC, steps: [{ ...POUR_SPEC.steps[0], success: [] }] });
    const form = formFor(open, "steps[s1].success");
    expect(form.kind).toBe("success");
    if (form.kind === "success") expect(form.options.map((o) => o.predicates)).toEqual([90, 75, 50].map((value) => [{ kind: "liquid_inside", target: "bowl", value }]));
    const { program, added } = withRequiredAsks(open, POUR_PROGRAMS.pour);
    expect(added).toEqual(["steps[s1].success"]);
    expect(program.steps[0].ops[0]).toMatchObject({ op: "ask", slot: "steps[s1].success" });
    expect(withRequiredAsks(POUR_SPEC, POUR_PROGRAMS.pour).added).toEqual([]);
  });

  it("lints a pour that never tilts toward where it pours, or leaves the container tipped", () => {
    expect(lintProgram(POUR_PROGRAMS.pour, POUR_SPEC)).toEqual([]);
    expect(lintProgram(ops(...grip, { op: "tilt", deg: 120, toward: "block" }, { op: "tilt", deg: 0 }), POUR_SPEC)).toEqual(['steps[0] (pour): never tilts the cup toward "bowl"']);
    expect(lintProgram(ops(...grip, { op: "tilt", deg: 120, toward: "bowl" }), POUR_SPEC)[0]).toContain("leaves the cup tipped");
    expect(lintProgram(ops(...grip, { op: "tilt", deg: 120, toward: "vat" }, { op: "tilt", deg: 0 }), POUR_SPEC)).toContain('steps[0].ops[3].toward: tilt toward unknown frame "vat"');
  });
});

describe("containers and their liquid", () => {
  it("builds what a pour uses as open boxes with an inside the liquid is measured in", () => {
    const scene = buildScene(POUR_SPEC);
    expect(Object.keys(scene.containers).sort()).toEqual(["bowl", "cup"]);
    const t = CONTAINER_WALL_M;
    expect(scene.containers.cup.inner_m[0]).toBeCloseTo(0.048 - 2 * t, 9);
    expect(scene.containers.cup.depth_m).toBeCloseTo(0.054 - t, 9);
    for (const part of ["wall_xneg", "wall_xpos", "wall_yneg", "wall_ypos", "floor"]) expect(scene.worldbody).toContain(`obj_cup_${part}`);
    expect(scene.worldbody).toContain("obj_bowl_inside");
    expect(scene.worldbody).toContain('<geom name="obj_block_geom"'); // the block is no container
  });

  it("refuses a container too small to hold liquid", () => {
    const tiny = TaskSpec.parse({ ...POUR_SPEC, objects: POUR_SPEC.objects.map((o) => (o.id === "cup" ? { ...o, size_mm: [20, 20, 54] } : o)) });
    expect(() => buildScene(tiny)).toThrow(SceneError);
  });

  it("plans the liquid: what the spec says, half full when it says nothing, and never past the particle budget", () => {
    const scene = buildScene(POUR_SPEC);
    const plan = planLiquid(POUR_SPEC, scene)!;
    expect(plan.fills).toEqual([{ id: "cup", ml: expect.closeTo(38, 0), particles: 594 }]);
    expect(plan.containers).toEqual({ cup: "obj_cup_inside", bowl: "obj_bowl_inside" });

    const silent = TaskSpec.parse({ ...POUR_SPEC, objects: POUR_SPEC.objects.map(({ liquid_ml, ...o }) => (void liquid_ml, o)) });
    const half = planLiquid(silent, buildScene(silent))!;
    expect(half.fills[0].id).toBe("cup");
    expect(half.warnings[0]).toContain("half way");

    const big = TaskSpec.parse({ ...POUR_SPEC, objects: POUR_SPEC.objects.map((o) => (o.id === "cup" ? { ...o, liquid_ml: 50 } : o)) });
    const capped = planLiquid(big, buildScene(big))!;
    expect(capped.fills[0].particles).toBe(MAX_PARTICLES);
    expect(capped.warnings.join(" ")).toContain("only 77% of the 50 mL is simulated");

    expect(planLiquid(DEMO_SPEC, buildScene(DEMO_SPEC))).toBeNull();
  });

  it("fills the pour's source even when the spec only says what something else holds", () => {
    const spec = TaskSpec.parse({ ...POUR_SPEC, objects: POUR_SPEC.objects.map((o) => (o.id === "cup" ? { ...o, liquid_ml: undefined } : o.id === "bowl" ? { ...o, liquid_ml: 20 } : o)) });
    const plan = planLiquid(spec, buildScene(spec))!;
    expect(plan.fills.map((f) => f.id).sort()).toEqual(["bowl", "cup"]);
    expect(plan.warnings.join(" ")).toContain('"cup" holds');
  });

  it("counts what a container holds in whole particles, so a tall narrow one is not overfilled", () => {
    const spec = TaskSpec.parse({ ...POUR_SPEC, objects: POUR_SPEC.objects.map((o) => (o.id === "cup" ? { ...o, size_mm: [27.9, 27.9, 124], pose: { xyz_mm: [300, 0, 108] } } : o)) });
    const plan = planLiquid(spec, buildScene(spec))!;
    // 19.9 mm inside: 4 x 4 particles a layer (by volume it would hold 38 mL), 30 layers; 80% of them at most
    expect(plan.fills[0].particles).toBe(Math.floor(0.8 * 4 * 4 * 30));
    expect(plan.warnings.join(" ")).toContain("holds 25 mL at most; 38 mL was asked");
  });
});

describe("the interpreter's tilt and the check, in the simulator", () => {
  it("measures the share inside a container: all of it in the cup before anything moves", () => {
    const { r, where } = pour(ops({ op: "assert", predicate: { kind: "liquid_inside", target: "bowl", value: 1 } }), 1);
    expect(r.pass).toBe(false);
    expect(r.failed_predicate?.kind).toBe("liquid_inside");
    expect(r.why).toContain("0% of the liquid is inside bowl");
    expect(where!.containers.cup).toBe(1);
  }, 60_000);

  it("keeps an object id such as __proto__ an ordinary key", () => {
    const rename = (id: string) => (id === "cup" ? "__proto__" : id);
    const spec = TaskSpec.parse({
      ...POUR_SPEC,
      objects: POUR_SPEC.objects.map((o) => ({ ...o, id: rename(o.id) })),
      steps: POUR_SPEC.steps.map((st) => ({ ...st, object: rename(st.object) })),
    });
    const { where, particles } = pour(Program.parse({ spec_title: "", steps: [{ step_id: "s1", ops: [] }] }), 1, { spec });
    expect(particles).toBe(594);
    expect(Object.hasOwn(where!.containers, "__proto__")).toBe(true);
    expect(where!.containers["__proto__"]).toBe(1);
  }, 60_000);

  it("turns a liquid check without liquid, or on something that is not a container, into a spec gap", () => {
    const check = Program.parse({ spec_title: "", steps: [{ step_id: "s1", ops: [{ op: "assert", predicate: { kind: "liquid_inside", target: "pillow", value: 50 } }] }] });
    const dry = pour(check, 1, { spec: DEMO_SPEC });
    expect(dry.r.failure_class).toBe("spec_gap");
    expect(dry.r.why).toContain("no liquid in the scene");
    const block = pour(ops({ op: "assert", predicate: { kind: "liquid_inside", target: "block", value: 50 } }), 1);
    expect(block.r.failure_class).toBe("spec_gap");
    expect(block.r.why).toContain("not an open container");
  }, 60_000);

  it("refuses to tilt what is not held, toward a frame that does not exist; turning back an upright cup does nothing", () => {
    expect(pour(ops({ op: "tilt", deg: 90, toward: "bowl" }), 1).r.why).toBe("tilt: nothing is held");
    const ghost = pour(ops(...grip, { op: "tilt", deg: 90, toward: "vat" }), 1).r;
    expect(ghost.failure_class).toBe("spec_gap");
    expect(ghost.why).toContain('no frame "vat"');
    const back = pour(ops(...grip, { op: "tilt", deg: 0 }), 1).r;
    expect(back.pass, back.log.join("\n")).toBe(true);
    expect(back.log.some((l) => l.includes("already upright"))).toBe(true);
  }, 120_000);

  it("turns back a cup a program left tipped, in a later run that continues from there", () => {
    const env = environment(POUR_SPEC);
    const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: 0, graspable: env.graspable }), vfs);
    const data = new mujoco.MjData(model);
    try {
      park(mujoco, model, data);
      const liquid = new Liquid(mujoco, model, data, env.liquid!, { gravity_g: 0 });
      const sim = { mujoco, model, data, liquid };
      const first = runToEnd(sim, env, ops(...grip, { op: "tilt", deg: 100, toward: "bowl", seconds: 1 }), "sensed");
      expect(first.pass, first.log.join("\n")).toBe(true);
      const back = runToEnd(sim, env, ops({ op: "tilt", deg: 0, seconds: 1 }, { op: "assert", predicate: { kind: "tilt_under", object: "cup", value: 8 } }), "sensed", { from: "here" });
      expect(back.pass, back.log.join("\n")).toBe(true);
      expect(back.log.some((l) => l.includes("already tipped"))).toBe(true);
    } finally {
      data.delete();
      model.delete();
    }
  }, 60_000);

  it("refuses to tip a tipped cup toward somewhere else, and carries on toward the same place", () => {
    const other = pour(ops(...grip, { op: "tilt", deg: 60, toward: "bowl" }, { op: "tilt", deg: 90, toward: "block" }), 0).r;
    expect(other.pass).toBe(false);
    expect(other.why).toContain("turn it upright first");
    const same = pour(ops(...grip, { op: "tilt", deg: 60, toward: "bowl" }, { op: "tilt", deg: 110, toward: "bowl" }, { op: "tilt", deg: 0 }), 0).r;
    expect(same.pass, same.log.join("\n")).toBe(true);
  }, 120_000);

  it("carries a cup gripped from the front upright, the wrist rolled to keep it so", () => {
    const carry = ops(...grip, { op: "move_to", frame: "cup", offset_mm: [0, 0, 40], approach: "front" }, { op: "move_to", frame: "bowl", offset_mm: [0, -60, 80], approach: "front" }, { op: "assert", predicate: { kind: "tilt_under", object: "cup", value: 10 } });
    const { r, where } = pour(carry, 1);
    expect(r.pass, r.log.join("\n")).toBe(true);
    expect(where!.containers.cup).toBeGreaterThanOrEqual(0.95);
  }, 60_000);

  it("pours on Earth: grasp, tilt toward the bowl about the rim, wait for the water, turn back, let go", () => {
    const { r, where, particles } = pour(POUR_PROGRAMS.pour, 1);
    expect(particles).toBe(594);
    expect(r.pass, r.log.join("\n")).toBe(true);
    expect(where!.containers.bowl).toBeGreaterThanOrEqual(0.9);
    expect(where!.containers.cup).toBeLessThan(0.02);
    // the cup really turned over the rim, and came back
    const tilt = r.log.find((l) => l.includes("tilt obj_cup to 120°"))!;
    expect(Number(tilt.match(/: (\d+)° from upright/)![1])).toBeGreaterThanOrEqual(115);
    expect(r.liquid?.containers.bowl).toBe(where!.containers.bowl);
  }, 60_000);

  it("in orbit, a slow pour does not fall: the water stays in the cup and the program says so", () => {
    const { r, where } = pour(POUR_PROGRAMS.slow_pour, 0);
    expect(r.pass).toBe(false);
    expect(r.failed_predicate?.kind).toBe("liquid_inside");
    expect(where!.containers.cup).toBeGreaterThanOrEqual(0.95);
    expect(r.log.at(-1)).toContain("in the cup");
  }, 60_000);

  it("in orbit, turning the cup over in one second throws the water into the bowl", () => {
    // Measured with the arm, seeds 1 to 6: 81 to 96% lands in the bowl, so the 90% bar of the hinge-mounted
    // measurement (3 of 6 seeds) is met in 1 or 2 of 6; three seeds here keep the test short.
    for (const seed of [1, 2, 3]) {
      const { r, where } = pour(POUR_PROGRAMS.flip_in_1_s, 0, { seed, after_s: 2 });
      expect(where!.containers.bowl, `seed ${seed}: ${r.log.join("\n")}`).toBeGreaterThanOrEqual(0.75);
      expect(where!.containers.cup).toBeLessThan(0.1);
    }
  }, 180_000);
});
