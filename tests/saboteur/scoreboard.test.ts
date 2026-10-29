/**
 * The progress scoreboard (issue #55) measured in node, as the /space page
 * runs it in the browser: for each NASA recording, every version of its
 * program (public/showcase/<clip>.json `iterations`) on the last version's
 * spec, the twelve scenarios the grid replays for that spec
 * (lib/saboteur/replay.ts: the model's recorded twelve, else the twelve built
 * from the spec), each blind and sensed at 1 g and 0 g through the headless
 * batch (lib/sim/batch.ts). No model call. The numbers are recomputed on
 * every run (not pinned: they follow the interpreter) and printed:
 *
 *   node_modules/.bin/vitest run tests/saboteur/scoreboard.test.ts --silent=false
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { replayPlan } from "@/lib/saboteur/replay";
import { SCORE_WORLDS, scoredSpec, scoreRollouts, tally, type Tally } from "@/lib/saboteur/scoreboard";
import { loadEngine, type Engine } from "@/lib/showcase/rehearse";
import { Session } from "@/lib/showcase/session";
import { runBatch, type BatchResult } from "@/lib/sim/batch";

const session = (name: string) => Session.parse(JSON.parse(readFileSync(path.join(process.cwd(), "public/showcase", `${name}.json`), "utf8")));

describe("the scoreboard's count", () => {
  it("counts passes per mode; a rollout that could not be set up, or is still running, is never a pass", () => {
    const rollout = (pass: boolean) => ({ pass, t: 1 }) as NonNullable<BatchResult["rollout"]>;
    const r = (mode: "blind" | "sensed", x: Partial<BatchResult>): BatchResult => ({ index: 0, gravity_g: 0, mode, ms: 1, ...x });
    const t = tally([r("blind", { rollout: rollout(true) }), r("sensed", { rollout: rollout(true) }), r("sensed", { rollout: rollout(false) }), r("blind", { error: "no world" }), undefined], 12);
    expect(t).toEqual({ blind: 1, sensed: 1, errors: 1, scenarios: 12 });
  });

  it("scores every version on the last version's spec, with twelve scenarios blind and sensed per world", () => {
    const s = session("iss-veggie-seed-film");
    expect(scoredSpec(s)).toBe(s.iterations.at(-1)!.spec);
    const plan = replayPlan(scoredSpec(s));
    if (plan.status !== "done") throw new Error("no plan");
    for (const world of SCORE_WORLDS) {
      const rs = scoreRollouts(plan.value.scenarios, world);
      expect(rs).toHaveLength(24);
      expect(new Set(rs.map((x) => x.gravity_g))).toEqual(new Set([world === "earth" ? 1 : 0]));
      expect(rs.filter((x) => x.mode === "blind")).toHaveLength(12);
    }
  });
});

describe("the scoreboard on the NASA samples, headless", () => {
  let engine: Engine;
  beforeAll(async () => {
    engine = await loadEngine();
  }, 60_000);

  const SAMPLES = ["iss-veggie-seed-film", "iss-veggie-seed-film-2", "iss-glovebox-pipette", "iss-fluid-bag-foam", "dev-clip"];

  it.each(SAMPLES)("%s: every version on the same twelve, blind and sensed, at 1 g and 0 g", async (name) => {
    const s = session(name);
    const spec = scoredSpec(s);
    const plan = replayPlan(spec);
    if (plan.status !== "done") throw new Error(`no plan for ${name}`);
    const { scenarios, source } = plan.value;
    expect(scenarios).toHaveLength(12);
    const passes: boolean[][] = [];
    const lines = [`${name}: ${source === "model" ? "the model's recorded twelve" : "twelve built from the spec"}, on the last version's spec`];
    for (const [i, it] of s.iterations.entries()) {
      const t: Partial<Record<(typeof SCORE_WORLDS)[number], Tally>> = {};
      for (const world of SCORE_WORLDS) {
        const out = await runBatch(engine.mujoco, (xml) => engine.mujoco.MjModel.from_xml_string(xml), spec, it.program, scoreRollouts(scenarios, world));
        t[world] = tally(out, scenarios.length);
        passes.push(out.map((r) => r.rollout?.pass ?? false));
        expect(t[world]!.errors, out.find((r) => r.error)?.error).toBe(0);
      }
      lines.push(`  ${i}. ${it.source}: earth blind ${t.earth!.blind}/12 sensed ${t.earth!.sensed}/12 (${t.earth!.blind + t.earth!.sensed}/24); orbit blind ${t.orbit!.blind}/12 sensed ${t.orbit!.sensed}/12 (${t.orbit!.blind + t.orbit!.sensed}/24); US$${it.cost_usd}`);
    }
    console.info(lines.join("\n"));
    // recomputed, never pinned: a change to the interpreter moves them. What must hold is that the same version on the
    // same twelve scores the same, rollout by rollout (the page re-runs exactly this in the browser)
    const again = await runBatch(engine.mujoco, (xml) => engine.mujoco.MjModel.from_xml_string(xml), spec, s.iterations.at(-1)!.program, scoreRollouts(scenarios, "orbit"));
    expect(again.map((r) => r.rollout?.pass ?? false)).toEqual(passes.at(-1));
  }, 180_000);
});
