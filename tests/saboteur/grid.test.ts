/**
 * The saboteur's twelve (lib/saboteur): the checks on a model's scenarios,
 * the twelve built from the spec with no model, the per-axis budget, and the
 * route in replay. Then the grid itself, in node, on the NASA samples: each
 * recording's last program (the one that passed on Earth and in orbit), its
 * twelve scenarios blind and sensed at 1 g and 0 g through the headless batch
 * (lib/sim/batch.ts), the budget printed per axis:
 *
 *   node_modules/.bin/vitest run tests/saboteur/grid.test.ts --silent=false
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/saboteur/route";
import recordings from "@/tests/fixtures/saboteur.json";
import { fromSpec, normalizeReply, planOf, SaboteurReply, type SaboteurPlan } from "@/lib/saboteur/ask";
import { bandText, budgetOf, fallbackScenarios, focusOf, forGrid, SCENARIO_COUNT, scenarioProblems, type Cell } from "@/lib/saboteur/grid";
import { loadEngine, type Engine } from "@/lib/showcase/rehearse";
import { Session } from "@/lib/showcase/session";
import { runBatch, type BatchRollout } from "@/lib/sim/batch";
import { DEMO_SPEC, POUR_SPEC } from "@/lib/sim/demo-spec";
import { GRAVITIES, MODES, Scenario, TaskSpec, type Program } from "@/lib/spec/schema";
import type { StageResult } from "@/lib/spec/stage-result";

/** The samples that rehearse a manipulation (iss-wave is a gesture). */
const SAMPLES = ["iss-veggie-seed-film", "iss-veggie-seed-film-2", "iss-glovebox-pipette", "iss-fluid-bag-foam", "dev-clip"];

function lastPassing(name: string): { spec: TaskSpec; program: Program } {
  const s = Session.parse(JSON.parse(readFileSync(path.join(process.cwd(), "public/showcase", `${name}.json`), "utf8")));
  const last = s.iterations.at(-1)!;
  return { spec: last.spec, program: last.program };
}

const sc = (o: Partial<Scenario>) => Scenario.parse({ id: "s", name: "s", axis: "x_mm", offset: 1, object: "pillow", expected: "unknown", ...o });

describe("the saboteur's twelve", () => {
  it.each([["demo", DEMO_SPEC] as const, ...SAMPLES.map((n) => [n, lastPassing(n).spec] as const)])("builds exactly twelve the grid can run for %s, with no model", (_, spec) => {
    const twelve = forGrid(fallbackScenarios(spec));
    expect(twelve).toHaveLength(SCENARIO_COUNT);
    expect(scenarioProblems(spec, twelve)).toEqual([]);
    // the yaw of a symmetric object changes nothing: never asked for
    for (const s of twelve) if (s.axis === "yaw_deg") expect(spec.objects.find((o) => o.id === s.object)?.symmetry).toBe("none");
  });

  it("stays inside its own checks on odd specs: a near-zero clearance, a wide zone", () => {
    const withPillow = (pillow: Record<string, unknown>, step: Record<string, unknown> = {}) =>
      TaskSpec.parse({ ...DEMO_SPEC, objects: DEMO_SPEC.objects.map((o) => (o.id === "pillow" ? { ...o, ...pillow } : o)), steps: DEMO_SPEC.steps.map((s) => (s.id === "s2" ? { ...s, ...step } : s)) });
    for (const spec of [
      withPillow({ pocket_clearance_mm: 0.1 }),
      withPillow({ pocket_clearance_mm: 150, size_mm: [250, 250, 20] }),
      withPillow({ pocket_clearance_mm: 0.4 }),
      withPillow({ pocket_clearance_mm: 0.5 }),
      withPillow({ size_mm: [140, 140, 20] }, { verb: "place", target: { fixture: "zone", frame: "pillow" } }),
    ]) {
      const twelve = forGrid(fallbackScenarios(spec));
      expect(twelve).toHaveLength(SCENARIO_COUNT);
      expect(scenarioProblems(spec, twelve)).toEqual([]);
    }
  });

  it("refuses a clearance on something the simulator does not build as a pocket", () => {
    const surface = TaskSpec.parse({ ...DEMO_SPEC, objects: DEMO_SPEC.objects.map((o) => (o.id === "pillow" ? { ...o, role: "surface" as const } : o)) });
    const twelve = forGrid(fallbackScenarios(surface));
    expect(twelve.some((s) => s.axis === "clearance_mm")).toBe(false);
    expect(scenarioProblems(surface, [...twelve.slice(0, 11), sc({ id: "narrow", axis: "clearance_mm", offset: -1 })]).join("; ")).toMatch(/changes nothing|pocket/);
  });

  it("aims at the step that puts the object somewhere, not a reach toward it", () => {
    const reachFirst = TaskSpec.parse({ ...DEMO_SPEC, steps: [{ id: "s0", verb: "reach", object: "film", target: { fixture: "zone", frame: "pillow" }, t_start_s: 0, t_end_s: 1 }, ...DEMO_SPEC.steps] });
    expect(focusOf(reachFirst)).toMatchObject({ step_id: "s2", fixture: "pocket" });
  });

  it("refuses a pocket widened past its fixture: the world could not be built", () => {
    const twelve = forGrid(fallbackScenarios(DEMO_SPEC));
    const wide = [...twelve.slice(0, 11), sc({ id: "wide", axis: "clearance_mm", offset: 60 })];
    expect(scenarioProblems(DEMO_SPEC, wide).join("; ")).toContain("cannot be built");
  });

  it("aims a pour at what it pours into, whatever frame its target names", () => {
    const pour = { ...POUR_SPEC, steps: POUR_SPEC.steps.map((s) => (s.pour ? { ...s, target: s.target ? { ...s.target, frame: "world" } : undefined } : s)) };
    const into = POUR_SPEC.steps.find((s) => s.pour)!.pour!.into;
    expect(focusOf(pour)?.target.id).toBe(into);
  });

  it("finds the tightest constraint: half a pocket's clearance, or a stated tolerance", () => {
    expect(focusOf(DEMO_SPEC)).toMatchObject({ object: { id: "film" }, target: { id: "pillow" }, fixture: "pocket", band_mm: 2.5 });
    const told = { ...DEMO_SPEC, steps: DEMO_SPEC.steps.map((s) => (s.id === "s2" ? { ...s, tolerances: { x_mm: 1.5 } } : s)) };
    expect(focusOf(told)?.band_mm).toBe(1.5);
    // a stated 0 mm is the tightest of all (shown as 0.01 mm; the fallback still steps at least 1 mm)
    const zero = { ...DEMO_SPEC, steps: DEMO_SPEC.steps.map((s) => (s.id === "s2" ? { ...s, tolerances: { x_mm: 0 } } : s)) };
    expect(focusOf(zero)?.band_mm).toBe(0.01);
    expect(forGrid(fallbackScenarios(zero))).toHaveLength(SCENARIO_COUNT);
    // a stated tolerance looser than the pocket does not widen the band: the geometry is the tighter constraint
    const loose = { ...DEMO_SPEC, steps: DEMO_SPEC.steps.map((s) => (s.id === "s2" ? { ...s, tolerances: { x_mm: 20, y_mm: 20 } } : s)) };
    expect(focusOf(loose)).toMatchObject({ band_mm: 2.5, band_from: "half the pocket's 5 mm clearance" });
    // no pocket is built on a surface: its room and the stated tolerance decide
    const surface = { ...loose, objects: loose.objects.map((o) => (o.id === "pillow" ? { ...o, role: "surface" as const } : o)), steps: loose.steps.map((s) => (s.id === "s2" ? { ...s, tolerances: { x_mm: 10, y_mm: 10 } } : s)) };
    expect(focusOf(surface)?.band_mm).toBe(10);
    // a zone's room is compared before any floor: 0.25 mm of room beats a stated 0.8 mm
    const tight = TaskSpec.parse({
      ...DEMO_SPEC,
      objects: DEMO_SPEC.objects.map((o) => (o.id === "film" ? { ...o, size_mm: [20, 20, 40] } : { ...o, size_mm: [20.5, 20.5, 30] })),
      steps: DEMO_SPEC.steps.map((s) => (s.id === "s2" ? { ...s, verb: "place" as const, target: { fixture: "zone" as const, frame: "pillow" }, tolerances: { x_mm: 0.8 } } : s)),
    });
    expect(focusOf(tight)?.band_mm).toBeLessThan(0.8);
    // a pour keeps its stated tolerance: the held container does not go inside the other
    const pourStep = POUR_SPEC.steps.find((s) => s.pour)!;
    const pour = { ...POUR_SPEC, steps: POUR_SPEC.steps.map((s) => (s === pourStep ? { ...s, tolerances: { x_mm: 10 } } : s)) };
    expect(focusOf(pour)).toMatchObject({ fixture: "pour", band_mm: 10 });
    // with no stated tolerance, half the receiver's opening inside its walls (POUR_SPEC's 68 mm bowl: 60 mm inside)
    const open = { ...POUR_SPEC, steps: POUR_SPEC.steps.map((s) => (s === pourStep ? { ...s, tolerances: { x_mm: 32 } } : s)) };
    expect(focusOf(open)?.band_mm).toBe(30);
  });

  it("refuses a tilt of a sphere nothing is posed on or aimed at: it changes nothing physical", () => {
    const ball = TaskSpec.parse({
      ...DEMO_SPEC,
      objects: [...DEMO_SPEC.objects, { id: "ball", name: "ball", shape: "sphere", size_mm: [30, 30, 30], symmetry: "full", role: "obstacle", pose: { xyz_mm: [250, 0, 15] } }],
    });
    const twelve = forGrid(fallbackScenarios(ball));
    expect(scenarioProblems(ball, [...twelve.slice(0, 11), sc({ id: "tilt", axis: "tilt_deg", offset: 10, object: "ball", tilt_axis: "x" })]).join("; ")).toContain("changes nothing physical");
    const claimed = TaskSpec.parse({ ...ball, objects: ball.objects.map((o) => (o.id === "ball" ? { ...o, symmetry: "none" as const } : o)) });
    expect(scenarioProblems(claimed, [...twelve.slice(0, 11), sc({ id: "tilt", axis: "tilt_deg", offset: 10, object: "ball", tilt_axis: "x" })]).join("; ")).toContain("changes nothing physical");
  });

  it("says what is wrong with a model's scenarios", () => {
    const good = forGrid(fallbackScenarios(DEMO_SPEC));
    expect(scenarioProblems(DEMO_SPEC, good.slice(0, 5)).join("; ")).toContain("exactly 12");
    const cylinder = { ...DEMO_SPEC, objects: DEMO_SPEC.objects.map((o) => (o.id === "pillow" ? { ...o, shape: "cylinder" as const, symmetry: "axial" as const } : o)) };
    const yawed = [...good.slice(0, 11), sc({ id: "yaw", axis: "yaw_deg", offset: 10 })];
    expect(scenarioProblems(cylinder, yawed).join("; ")).toContain("symmetry");
    const ghost = [...good.slice(0, 11), sc({ id: "ghost", object: "ghost" })];
    expect(scenarioProblems(DEMO_SPEC, ghost).join("; ")).toContain('no object "ghost"');
    const noise = [...good.slice(0, 11), sc({ id: "noise", axis: "pose_noise_mm" })];
    expect(scenarioProblems(DEMO_SPEC, noise).join("; ")).toContain("changes nothing in the world");
    const closed = [...good.slice(0, 11), sc({ id: "closed", axis: "clearance_mm", offset: -5 })];
    expect(scenarioProblems(DEMO_SPEC, closed).join("; ")).toContain("close the pocket");
  });

  it("keeps a model's twelve when they pass, and builds them from the spec when they do not", () => {
    const twelve = forGrid(fallbackScenarios(DEMO_SPEC)).map((s) => ({ ...s, expected: "fail" as const }));
    const kept = planOf(DEMO_SPEC, { status: "done", value: { scenarios: twelve }, warnings: [] });
    expect(kept.status === "done" && kept.value.source).toBe("model");
    const short = planOf(DEMO_SPEC, { status: "done", value: { scenarios: twelve.slice(0, 5) }, warnings: [] });
    expect(short.status === "done" && short.value.source).toBe("spec");
    expect(short.status === "done" && short.value.scenarios).toHaveLength(12);
    const down = planOf(DEMO_SPEC, { status: "failed", message: "super: 503", retryable: true });
    expect(down.status === "done" && down.value.source).toBe("spec");
  });

  it("reads near-misses: a bare list, an offset as text, a gravity the model should not set", () => {
    const { data } = normalizeReply([{ id: "a", axis: "x_mm", offset: "2", object: "pillow", gravity_g: 0 }]);
    const r = SaboteurReply.parse(data);
    expect(r.scenarios[0]).toMatchObject({ name: "a", offset: 2, expected: "unknown", gravity_g: 1 });
  });

  it("reads the budget off the cells: contiguous passes from zero on each side, the first failure", () => {
    const cell = (offset: number, mode: "blind" | "sensed", pass: boolean): Cell => ({ scenario: sc({ offset }), mode, pass });
    const [b] = budgetOf([cell(1, "blind", true), cell(2, "blind", true), cell(4, "blind", false), cell(-2, "blind", true), cell(1, "sensed", true), cell(2, "sensed", false), cell(4, "sensed", true)]);
    expect(b.blind).toEqual({ pass_pos: 2, fail_pos: 4, pass_neg: -2, fail_neg: null });
    // a pass beyond a failure does not widen the band
    expect(b.sensed).toEqual({ pass_pos: 1, fail_pos: 2, pass_neg: null, fail_neg: null });
    expect(bandText(b.blind, "mm")).toBe("survives ±2 mm, fails at +4 mm");
  });

  it("answers in replay with twelve, from a recording or from the spec", async () => {
    for (const name of SAMPLES) {
      const { spec } = lastPassing(name);
      const res = await POST(new Request("http://test/api/saboteur?replay=1", { method: "POST", body: JSON.stringify({ spec }) }));
      const r = (await res.json()) as StageResult<SaboteurPlan>;
      expect(r.status, name).toBe("done");
      if (r.status !== "done") continue;
      expect(r.value.scenarios).toHaveLength(12);
      const recorded = (recordings as { spec_title: string }[]).some((x) => x.spec_title === spec.title);
      expect(r.value.source, name).toBe(recorded ? "model" : "spec");
      expect(r.warnings[0]).toMatch(/^replay/);
    }
  });
});

describe("the grid on the NASA samples, headless", () => {
  let engine: Engine;
  beforeAll(async () => {
    engine = await loadEngine();
  }, 60_000);

  it.each(SAMPLES.flatMap((n) => [[n, "model"], [n, "spec"]] as const))("%s, the %s's twelve: blind and sensed, at 1 g and 0 g", async (name, source) => {
    const { spec, program } = lastPassing(name);
    let plan: StageResult<SaboteurPlan>;
    if (source === "spec") plan = fromSpec(spec, []);
    else {
      const res = await POST(new Request("http://test/api/saboteur?replay=1", { method: "POST", body: JSON.stringify({ spec }) }));
      plan = (await res.json()) as StageResult<SaboteurPlan>;
    }
    if (plan.status !== "done") throw new Error("no plan");
    if (plan.value.source !== source) return; // no recording of the model's for this sample
    const lines: string[] = [`${name} (${source === "model" ? "the model's recorded twelve" : "twelve built from the spec"}; band ${plan.value.focus.band_mm} mm, ${plan.value.focus.band_from})`];
    for (const [world, gravity_g] of [["earth", GRAVITIES.earth], ["orbit", GRAVITIES.orbit]] as const) {
      const rollouts: BatchRollout[] = plan.value.scenarios.flatMap((scenario) => MODES.map((mode) => ({ scenario, mode, gravity_g })));
      const started = performance.now();
      const out = await runBatch(engine.mujoco, (xml) => engine.mujoco.MjModel.from_xml_string(xml), spec, program, rollouts);
      const s = (performance.now() - started) / 1000;
      expect(out.every((r) => r.rollout), out.find((r) => r.error)?.error).toBe(true);
      const cells: Cell[] = out.map((r, i) => ({ scenario: rollouts[i].scenario!, mode: r.mode, pass: r.rollout!.pass }));
      const passes = (mode: string) => cells.filter((c) => c.mode === mode && c.pass).length;
      lines.push(`  ${world}: blind ${passes("blind")}/12, sensed ${passes("sensed")}/12, ${s.toFixed(2)} s for 24 rollouts`);
      for (const b of budgetOf(cells)) lines.push(`    ${b.object} ${b.axis}${b.tilt_axis ? ` about ${b.tilt_axis}` : ""} [${b.tested.join(", ")}]: blind ${bandText(b.blind, b.unit)}; sensed ${bandText(b.sensed, b.unit)}`);
    }
    console.info(lines.join("\n"));
  }, 120_000);
});
