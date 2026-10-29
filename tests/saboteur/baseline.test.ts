/**
 * The scoreboard's baseline (issue #55): "retarget and replay" built from each NASA recording's label as the fit laid
 * it out (`fit.spec`), with no model and no answers, scored like every version: on the last version's spec, the
 * twelve the grid replays for it, blind and sensed at 1 g and 0 g. The numbers are recomputed and printed:
 *
 *   node_modules/.bin/vitest run tests/saboteur/baseline.test.ts --silent=false
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { baselineProgram } from "@/lib/saboteur/baseline";
import { replayPlan } from "@/lib/saboteur/replay";
import { SCORE_WORLDS, scoredSpec, scoreRollouts, tally } from "@/lib/saboteur/scoreboard";
import { loadEngine, type Engine } from "@/lib/showcase/rehearse";
import { Session } from "@/lib/showcase/session";
import { runBatch } from "@/lib/sim/batch";
import { DEMO_SPEC } from "@/lib/sim/demo-spec";
import { Program, TaskSpec } from "@/lib/spec/schema";
import { validateProgram } from "@/lib/spec/validate";

const session = (name: string) => Session.parse(JSON.parse(readFileSync(path.join(process.cwd(), "public/showcase", `${name}.json`), "utf8")));

describe("baselineProgram", () => {
  it("takes the object and lets it go where each step puts it, with no wait and no check", () => {
    const b = baselineProgram(DEMO_SPEC, DEMO_SPEC);
    if (!("program" in b)) throw new Error(b.why);
    expect(Program.safeParse(b.program).success).toBe(true);
    expect(validateProgram(b.program, DEMO_SPEC)).toEqual([]);
    const ops = b.program.steps.flatMap((s) => s.ops.map((o) => o.op));
    expect(ops).not.toContain("ask");
    expect(ops).not.toContain("wait_until");
    expect(ops).not.toContain("assert");
    expect(ops.filter((o) => o === "grasp")).toHaveLength(1);
    expect(ops.at(-1)).toBe("release");
    // deterministic
    expect(baselineProgram(DEMO_SPEC, DEMO_SPEC)).toEqual(b);
  });

  it("gives the reason where the rules do not reach: a place the label gives nowhere to go", () => {
    const spec = TaskSpec.parse({ ...DEMO_SPEC, steps: DEMO_SPEC.steps.map((s) => (s.target ? { ...s, verb: "place", target: undefined } : s)) });
    expect(baselineProgram(spec, DEMO_SPEC)).toEqual({ why: expect.stringContaining("nowhere to go") });
  });

  it("grips a container to pour from the front once, even after a reach for it", () => {
    const steps = [
      { id: "s1", verb: "reach", object: "film", t_start_s: 0, t_end_s: 1, source: "vl#seg1" },
      { id: "s2", verb: "pour", object: "film", pour: { into: "pillow", tilt_deg: 120 }, t_start_s: 1, t_end_s: 3, source: "vl#seg1" },
    ];
    const spec = TaskSpec.parse({ ...DEMO_SPEC, steps });
    const b = baselineProgram(spec, spec);
    if (!("program" in b)) throw new Error(b.why);
    const ops = b.program.steps.flatMap((s) => s.ops);
    expect(ops.filter((o) => o.op === "grasp")).toHaveLength(1);
    expect(ops.find((o) => o.op === "move_to")).toMatchObject({ approach: "front" });
  });

  it("opens the hand in the person's own release step, not at the end of the carry", () => {
    const steps = [
      { id: "s1", verb: "grasp", object: "film", t_start_s: 0, t_end_s: 1, source: "vl#seg1" },
      { id: "s2", verb: "move", object: "film", target: { fixture: "pocket", frame: "pillow" }, t_start_s: 1, t_end_s: 2, source: "vl#seg1" },
      { id: "s3", verb: "release", object: "film", t_start_s: 2, t_end_s: 3, source: "vl#seg1" },
    ];
    const spec = TaskSpec.parse({ ...DEMO_SPEC, steps });
    const b = baselineProgram(spec, spec);
    if (!("program" in b)) throw new Error(b.why);
    expect(b.program.steps.map((s) => s.ops.filter((o) => o.op === "release").length)).toEqual([0, 0, 1]);
  });

  it("gives the reason when the scored spec lost a frame the label's steps use", () => {
    const scored = TaskSpec.parse({ ...DEMO_SPEC, objects: DEMO_SPEC.objects.map((o, i) => (i === 0 ? { ...o, id: "renamed" } : o)), steps: [] });
    expect(baselineProgram(DEMO_SPEC, scored)).toEqual({ why: expect.stringContaining("the scored spec has no") });
  });
});

describe("the baseline on the NASA samples, headless", () => {
  let engine: Engine;
  beforeAll(async () => {
    engine = await loadEngine();
  }, 60_000);

  const SAMPLES = ["iss-veggie-seed-film", "iss-veggie-seed-film-2", "iss-glovebox-pipette", "iss-fluid-bag-foam", "dev-clip"];

  it.each(SAMPLES)("%s: retarget and replay on the same twelve, blind and sensed, at 1 g and 0 g", async (name) => {
    const s = session(name);
    const spec = scoredSpec(s);
    const plan = replayPlan(spec);
    if (plan.status !== "done") throw new Error(`no plan for ${name}`);
    const b = baselineProgram(s.fit.spec, spec);
    if (!("program" in b)) {
      console.info(`${name}: no baseline: ${b.why}`);
      return;
    }
    const line: string[] = [];
    for (const world of SCORE_WORLDS) {
      const out = await runBatch(engine.mujoco, (xml) => engine.mujoco.MjModel.from_xml_string(xml), spec, b.program, scoreRollouts(plan.value.scenarios, world));
      const t = tally(out, plan.value.scenarios.length);
      expect(t.errors, out.find((r) => r.error)?.error).toBe(0);
      line.push(`${world} blind ${t.blind}/12 sensed ${t.sensed}/12 (${t.blind + t.sensed}/24)`);
      if (world === "orbit") line.push(`first orbit failure: ${out.find((r) => !r.rollout?.pass)?.rollout?.why ?? "none"}`);
      else line.push(`first earth failure: ${out.find((r) => !r.rollout?.pass)?.rollout?.why ?? "none"}`);
    }
    console.info(`${name} baseline: ${line.join("; ")}`);
  }, 180_000);
});
