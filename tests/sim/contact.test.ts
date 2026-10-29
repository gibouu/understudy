/**
 * The contact op (lib/sim/contact.ts) on a person stand-in, measured: a band of seeds at 1 g and 0 g, a hand-written
 * program, the numbers pinned as docs/MEASUREMENTS.md section 19 reports them. `CONTACT_PRINT=1` prints the table.
 *
 * The stand-ins are primitives with a size and nothing else: a box lying on the table (a forearm's size) and a
 * sphere on the table (a head's size). The applicator is a 16 x 70 mm cylinder standing on a block, gripped from the
 * front. Each seed moves the stand-in by up to 15 mm in x and y, 5 mm in z and 15° in yaw, and the applicator's block
 * by up to 5 mm in x and y; the program is told the true poses (sensed).
 */
import type { MainModule } from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import type { Contacted } from "@/lib/sim/contact";
import { environment, runToEnd, type Rollout } from "@/lib/sim/interpreter";
import { park, stageXml } from "@/lib/sim/so101";
import { loadSo101 } from "@/lib/sim/so101-disk";
import { onSurface, samplePath, support, type Vec3 } from "@/lib/sim/surface";
import { CompiledOp, CONTACT_FORCE_N, Program, ProgramOp, TaskSpec } from "@/lib/spec/schema";
import { lintProgram, validateSpec } from "@/lib/spec/validate";

let mujoco: MainModule;

beforeAll(async () => {
  mujoco = await loadSo101();
}, 60_000);

type StandIn = { shape: "box" | "sphere"; size_mm: [number, number, number]; xyz_mm: [number, number, number]; path: [number, number, number][] };
/** a box 70 x 200 x 50 mm, the path an S of three points across its top face */
const BOX: StandIn = { shape: "box", size_mm: [70, 200, 50], xyz_mm: [320, 70, 25], path: [[-10, -60, 25], [10, 0, 25], [-10, 60, 25]] };
/** a sphere 160 mm across, the path an arc over its top, each point moved onto the sphere (27° from its top at the ends) */
const SPHERE: StandIn = { shape: "sphere", size_mm: [160, 160, 160], xyz_mm: [320, 70, 80], path: [[-20, -40, 80], [0, 0, 80], [-20, 40, 80]] };

function contactSpec(standIn: StandIn, shift = { x: 0, y: 0, z: 0, yaw: 0, sx: 0, sy: 0 }) {
  const [x, y, z] = standIn.xyz_mm;
  return TaskSpec.parse({
    version: 1,
    title: "apply along a surface",
    summary: "Pick up the applicator and apply it along a path on the stand-in, gently.",
    objects: [
      { id: "block", name: "block", shape: "box", size_mm: [40, 40, 60], symmetry: "none", role: "surface", pose: { xyz_mm: [300 + shift.sx, -70 + shift.sy, 30] } },
      { id: "applicator", name: "applicator", shape: "cylinder", size_mm: [16, 16, 70], symmetry: "axial", role: "manipulated", pose: { xyz_mm: [300 + shift.sx, -70 + shift.sy, 95] } },
      { id: "standin", name: "stand-in", shape: standIn.shape, size_mm: standIn.size_mm, symmetry: standIn.shape === "sphere" ? "full" : "none", role: "surface", pose: { xyz_mm: [x + shift.x, y + shift.y, z + shift.z], yaw_deg: shift.yaw } },
    ],
    steps: [{ id: "s1", verb: "apply", object: "applicator", contact: { surface: "standin", path: standIn.path }, t_start_s: 0, t_end_s: 10 }],
  });
}

/** Grip the applicator from the front 15 mm above its centre, lift it, apply it, put it back on its block, let go. */
const PROGRAM = Program.parse({
  spec_title: "apply along a surface",
  steps: [
    {
      step_id: "s1",
      ops: [
        { op: "move_to", frame: "applicator", offset_mm: [0, 0, 15], approach: "front" },
        { op: "grasp", object: "applicator", aperture_mm: 16 },
        { op: "move_to", frame: "applicator", offset_mm: [0, 0, 60], approach: "front" },
        { op: "contact" },
        { op: "move_to", frame: "applicator", offset_mm: [0, 0, 60], approach: "front" },
        { op: "move_to", frame: "applicator", offset_mm: [0, 0, 1], approach: "front" },
        { op: "release" },
      ],
    },
  ],
});

function rollout(spec: TaskSpec, gravity_g: number): Rollout {
  const env = environment(spec);
  const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g, graspable: env.graspable }));
  const data = new mujoco.MjData(model);
  try {
    park(mujoco, model, data);
    return runToEnd({ mujoco, model, data }, env, PROGRAM, "sensed");
  } finally {
    data.delete();
    model.delete();
  }
}

/** mulberry32: the band's draws, reproducible from the seed */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shiftOf = (seed: number) => {
  const r = rng(seed);
  const u = (h: number) => (2 * r() - 1) * h;
  return { x: u(15), y: u(15), z: u(5), yaw: u(15), sx: u(5), sy: u(5) };
};

/** Wilson score interval, 95% */
function wilson(k: number, n: number, z = 1.96): [number, number] {
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

type Cell = { standIn: string; g: number; runs: { seed: number; r: Rollout; c?: Contacted }[] };
function band(name: string, standIn: StandIn, g: number): Cell {
  return { standIn: name, g, runs: SEEDS.map((seed) => { const r = rollout(contactSpec(standIn, shiftOf(seed)), g); return { seed, r, c: r.contacted?.[0] }; }) };
}
function summary(cell: Cell) {
  const n = cell.runs.length;
  const k = cell.runs.filter((x) => x.r.pass).length;
  const cs = cell.runs.flatMap((x) => (x.c ? [x.c] : []));
  const [lo, hi] = wilson(k, n);
  const min = (f: (c: Contacted) => number) => Math.min(...cs.map(f));
  const max = (f: (c: Contacted) => number) => Math.max(...cs.map(f));
  const mean = (f: (c: Contacted) => number) => cs.reduce((a, c) => a + f(c), 0) / cs.length;
  return {
    n,
    pass: k,
    wilson: [lo, hi],
    measured: cs.length,
    coverage_min: min((c) => c.coverage),
    coverage_mean: mean((c) => c.coverage),
    peak_max_n: max((c) => c.peak_force_n),
    peak_mean_n: mean((c) => c.peak_force_n),
    mean_force_n: mean((c) => c.mean_force_n),
    contact_s_min: min((c) => c.contact_s),
    contact_s_mean: mean((c) => c.contact_s),
    follow_s_mean: mean((c) => c.follow_s),
    approach_max_mm_s: max((c) => c.approach_peak_mm_s),
    retreat_max_mm_s: max((c) => c.retreat_peak_mm_s),
    arm_touched: cs.filter((c) => c.arm_touched).length,
    failures: cell.runs.filter((x) => !x.r.pass).map((x) => `seed ${x.seed}: ${x.r.why}`),
  };
}

describe("the geometry of a contact path (lib/sim/surface.ts)", () => {
  const box = { shape: "box" as const, size_mm: [70, 200, 50] as [number, number, number] };
  it("moves a point onto the nearest face of a box, with that face's normal", () => {
    expect(onSurface(box, [10, 0, 30])).toEqual({ point: [10, 0, 25], normal: [0, 0, 1] });
    expect(onSurface(box, [10, 0, 20])).toEqual({ point: [10, 0, 25], normal: [0, 0, 1] });
    expect(onSurface(box, [40, 0, 0])).toEqual({ point: [35, 0, 0], normal: [1, 0, 0] });
  });
  it("moves a point onto a sphere along its radius, and onto a cylinder's side or cap", () => {
    const s = onSurface({ shape: "sphere", size_mm: [100, 100, 100] }, [0, 30, 40]);
    expect(s.point.map((v) => Number(v.toFixed(6)))).toEqual([0, 30, 40]);
    expect(s.normal.map((v) => Number(v.toFixed(6)))).toEqual([0, 0.6, 0.8]);
    const cyl = { shape: "cylinder" as const, size_mm: [40, 40, 100] as [number, number, number] };
    expect(onSurface(cyl, [30, 0, 0])).toEqual({ point: [20, 0, 0], normal: [1, 0, 0] });
    expect(onSurface(cyl, [5, 0, 60])).toEqual({ point: [5, 0, 50], normal: [0, 0, 1] });
  });
  it("cuts a path into samples 1 mm apart on the surface, in the world", () => {
    const R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const samples = samplePath(box, [[0, -10, 25], [0, 10, 25]], [0.3, 0, 0.025], R);
    // halved until each piece is within 1 mm: 20 mm in 32 pieces
    expect(samples).toHaveLength(33);
    expect(samples.at(-1)!.s_m).toBeCloseTo(0.02, 9);
    expect(samples[0].point.map((v) => Number(v.toFixed(6)))).toEqual([0.3, -0.01, 0.05]);
  });
  it("cuts after projecting: a path drawn near a sphere's centre is sampled as densely as the curve it traces", () => {
    const R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const sphere = { shape: "sphere" as const, size_mm: SPHERE.size_mm };
    const full = samplePath(sphere, SPHERE.path, [0.32, 0.07, 0.08], R);
    const small = samplePath(sphere, SPHERE.path.map((p) => p.map((v) => v / 100) as Vec3), [0.32, 0.07, 0.08], R);
    expect(small.length).toBeGreaterThanOrEqual(full.length - 2);
    expect(small.at(-1)!.s_m).toBeCloseTo(full.at(-1)!.s_m, 3);
    for (const x of [full, small]) for (let k = 1; k < x.length; k++) expect(x[k].s_m - x[k - 1].s_m).toBeLessThanOrEqual(0.001 + 1e-9);
  });
  it("finds the point of a held primitive that meets a surface: an upright cylinder's cap, a tipped one's rim", () => {
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const cyl = { shape: "cylinder" as const, size_mm: [16, 16, 70] as [number, number, number] };
    expect(support(cyl, [0, 0, 0.1], I, [0, 0, -1]).map((v) => Number(v.toFixed(6)))).toEqual([0, 0, 0.065]);
    // tipped 0.2 rad about y: the rim on the +x side of its own frame is lowest
    const c = Math.cos(0.2);
    const sn = Math.sin(0.2);
    const tipped = [c, 0, sn, 0, 1, 0, -sn, 0, c] as number[];
    const p = support(cyl, [0, 0, 0.1], tipped, [0, 0, -1]) as Vec3;
    expect(p[0]).toBeCloseTo(0.008 * c - 0.035 * sn, 6);
    expect(p[2]).toBeCloseTo(0.1 - 0.008 * sn - 0.035 * c, 6);
  });
});

describe("the apply step and the contact op in the spec", () => {
  it("parses an apply step with its contact block and defaults, and the contact op", () => {
    const s = contactSpec(BOX).steps[0];
    expect(s.verb).toBe("apply");
    expect(s.contact).toMatchObject({ surface: "standin", force_n: CONTACT_FORCE_N, reach_mm: 3, coverage_pc: 90 });
    expect(ProgramOp.parse({ op: "contact" })).toEqual({ op: "contact" });
    // the live compile cannot emit it: the prompt does not offer it (no model call verified one)
    expect(CompiledOp.safeParse({ op: "contact" }).success).toBe(false);
    expect(validateSpec(contactSpec(BOX)).filter((i) => i.severity === "error")).toEqual([]);
    expect(lintProgram(PROGRAM, contactSpec(BOX))).toEqual([]);
  });
  it("refuses half a contact step, a surface that moves or is missing, and a path of one point", () => {
    const spec = contactSpec(BOX);
    const errors = (steps: unknown[]) => validateSpec(TaskSpec.parse({ ...spec, steps })).filter((i) => i.severity === "error").map((i) => i.code);
    const step = spec.steps[0];
    const { contact: _, ...bare } = step;
    void _;
    expect(errors([bare])).toEqual(["contact_without_block"]);
    expect(errors([{ ...step, verb: "move" }])).toEqual(["contact_block_on_other_verb"]);
    expect(errors([{ ...step, contact: { ...step.contact, surface: "applicator" } }])).toEqual(["contact_surface_moves"]);
    expect(errors([{ ...step, contact: { ...step.contact, surface: "nowhere" } }])).toEqual(["unknown_frame"]);
    expect(errors([{ ...step, contact: { ...step.contact, path: [[0, 0, 25]] } }])).toEqual(["contact_without_path"]);
    expect(TaskSpec.safeParse({ ...spec, steps: [{ ...step, contact: { ...step.contact, force_n: 0 } }] }).success).toBe(false);
  });
  it("lints an apply step that never makes contact, and a contact op in another step", () => {
    const spec = contactSpec(BOX);
    const without = Program.parse({ ...PROGRAM, steps: [{ step_id: "s1", ops: PROGRAM.steps[0].ops.filter((op) => op.op !== "contact") }] });
    expect(lintProgram(without, spec)).toEqual(['steps[0] (apply): never makes contact along its path; add {"op":"contact"} once the applicator is held']);
    const moved = TaskSpec.parse({ ...spec, steps: [{ id: "s1", verb: "move", object: "applicator", t_start_s: 0, t_end_s: 1 }] });
    expect(lintProgram(PROGRAM, moved)).toContain("steps[0] (move): contact applies along an apply step's contact path, and this step is not one");
  });
  it("fails an apply step the program never makes contact for, whatever else it does", () => {
    const empty = Program.parse({ spec_title: PROGRAM.spec_title, steps: [{ step_id: "s1", ops: [] }] });
    const env = environment(contactSpec(BOX));
    const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: 1, graspable: env.graspable }));
    const data = new mujoco.MjData(model);
    try {
      park(mujoco, model, data);
      const r = runToEnd({ mujoco, model, data }, env, empty, "sensed");
      expect(r.pass).toBe(false);
      expect(r.why).toContain("never made contact");
    } finally {
      data.delete();
      model.delete();
    }
  });
  it("measures the move to the stand-off too: a stand-in in the way of it fails the step", () => {
    // a tall box the arm sweeps through on its way out to the path (found by the second-model review)
    const tall: StandIn = { shape: "box", size_mm: [70, 200, 180], xyz_mm: [320, 110, 90], path: [[-10, 60, 90], [10, 0, 90], [-10, -60, 90]] };
    const r = rollout(contactSpec(tall), 1);
    expect(r.pass).toBe(false);
    const c = r.contacted![0];
    expect(c.peak_force_n > c.force_limit_n || c.arm_touched !== undefined).toBe(true);
  }, 60_000);
  it("judges coverage on the surface where it really is: told a pose 5 mm off (blind), the path is not covered", () => {
    const spec = contactSpec(BOX);
    const env = environment(spec, { id: "x5", name: "x5", axis: "x_mm", offset: 5, object: "standin", gravity_g: 1, expected: "unknown", why: "" });
    const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: 1, graspable: env.graspable }));
    const data = new mujoco.MjData(model);
    try {
      park(mujoco, model, data);
      const r = runToEnd({ mujoco, model, data }, env, PROGRAM, "blind");
      expect(r.pass).toBe(false);
      expect(r.contacted![0].coverage).toBeLessThan(0.9);
    } finally {
      data.delete();
      model.delete();
    }
  }, 60_000);
  it("slows down near the surface where it really is: told it is 10 mm lower (blind), the approach is still slow within 15 mm", () => {
    const env = environment(contactSpec(BOX), { id: "z10", name: "z10", axis: "z_mm", offset: 10, object: "standin", gravity_g: 1, expected: "unknown", why: "" });
    const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: 1, graspable: env.graspable }));
    const data = new mujoco.MjData(model);
    try {
      park(mujoco, model, data);
      const r = runToEnd({ mujoco, model, data }, env, PROGRAM, "blind");
      expect(r.contacted![0].approach_peak_mm_s).toBeLessThan(12);
    } finally {
      data.delete();
      model.delete();
    }
  }, 60_000);
  it("counts each contact where it is: two rims astride an open stand-in do not cover the empty path between them", () => {
    // found by the second-model review: a stand-in built as an open box, an applicator wider than its opening
    const base = contactSpec({ ...BOX, size_mm: [24, 200, 50], path: [[0, -40, 25], [0, 40, 25]] });
    const spec = TaskSpec.parse({
      ...base,
      objects: base.objects.map((o) => (o.id === "standin" ? { ...o, liquid_ml: 1 } : o.id === "applicator" ? { ...o, size_mm: [28, 28, 70] } : o)),
      steps: base.steps.map((s) => ({ ...s, contact: { ...s.contact!, force_n: 10 } })),
    });
    const r = rollout(spec, 1);
    expect(r.pass).toBe(false);
    expect(r.contacted![0].coverage).toBeLessThan(0.9);
  }, 60_000);
  it("is additive: a scene with no apply step is built exactly as before", () => {
    const spec = TaskSpec.parse({ ...contactSpec(BOX), steps: [{ id: "s1", verb: "grasp", object: "applicator", t_start_s: 0, t_end_s: 1 }] });
    expect(environment(spec).worldbody).not.toContain("contact_");
    expect(environment(contactSpec(BOX)).worldbody).toContain('name="contact_0_0"');
  });
});

describe("the contact op, measured on a band of seeds (docs/MEASUREMENTS.md section 19)", () => {
  const cells: Record<string, ReturnType<typeof summary>> = {};
  it.each([
    ["box", BOX, 1],
    ["box", BOX, 0],
    ["sphere", SPHERE, 1],
    ["sphere", SPHERE, 0],
  ] as const)("the %s stand-in at %s g", (name, standIn, g) => {
    const s = summary(band(name, standIn, g));
    cells[`${name} ${g} g`] = s;
    if (process.env.CONTACT_PRINT) console.log(`${name} ${g} g`, JSON.stringify(s, null, 1));
    // every run measured, and none ever let the arm itself touch the stand-in or pushed past the limit unreported
    expect(s.measured).toBe(s.n);
    expect(s.arm_touched).toBe(0);
    expect(PINNED[`${name} ${g} g`], JSON.stringify(s)).toEqual(pinned(s));
  }, 120_000);
});

/** What section 19 reports, rounded as it reports it. */
const pinned = (s: ReturnType<typeof summary>) => ({
  pass: s.pass,
  wilson_pc: s.wilson.map((x) => Math.round(100 * x)),
  coverage_min_pc: Math.round(100 * s.coverage_min),
  peak_max_n: Number(s.peak_max_n.toFixed(2)),
  contact_s_mean: Number(s.contact_s_mean.toFixed(1)),
  approach_max_mm_s: Math.round(s.approach_max_mm_s),
  retreat_max_mm_s: Math.round(s.retreat_max_mm_s),
});
/**
 * Measured on 29 October 2026, not tuned to: on the sphere the force loop holds the mean near its 1 N target but the
 * peak goes over the 2 N limit on every seed (2.28 to 2.41 N), so the curved stand-in fails 0 of 20 at both gravities.
 * (Before the path was cut after projection, its samples sat closer together and 17 and 20 of 20 passed: the margin
 * on a curved surface is that thin.)
 */
const PINNED: Record<string, ReturnType<typeof pinned>> = {
  "box 1 g": { pass: 20, wilson_pc: [84, 100], coverage_min_pc: 100, peak_max_n: 1.23, contact_s_mean: 9, approach_max_mm_s: 8, retreat_max_mm_s: 12 },
  "box 0 g": { pass: 20, wilson_pc: [84, 100], coverage_min_pc: 100, peak_max_n: 1.22, contact_s_mean: 9, approach_max_mm_s: 8, retreat_max_mm_s: 12 },
  "sphere 1 g": { pass: 0, wilson_pc: [0, 16], coverage_min_pc: 94, peak_max_n: 2.41, contact_s_mean: 6, approach_max_mm_s: 13, retreat_max_mm_s: 10 },
  "sphere 0 g": { pass: 0, wilson_pc: [0, 16], coverage_min_pc: 94, peak_max_n: 2.41, contact_s_mean: 6, approach_max_mm_s: 14, retreat_max_mm_s: 10 },
};
