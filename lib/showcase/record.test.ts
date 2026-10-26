/**
 * The /space recordings, checked and made.
 *
 * Without SHOWCASE_RECORD (CI, `pnpm test`): every public/showcase/<clip>.json
 * parses, belongs to a clip in lib/samples.ts, and each iteration's program,
 * rehearsed again in node, passes and fails where the recording says. The
 * browser runs the same deterministic physics, so this is what /space shows.
 * No network.
 *
 * With SHOWCASE_RECORD the live path runs once per named clip and rewrites
 * its JSON and poster. It spends Token Factory credits, at most
 * SHOWCASE_CAP_USD per clip (default 1):
 *
 *   SHOWCASE_RECORD=iss-veggie-seed-film UNDERSTUDY_ENV_FILE=.env.local \
 *     node_modules/.bin/vitest run lib/showcase/record.test.ts
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SAMPLES } from "@/lib/samples";
import { TaskSpec } from "@/lib/spec/schema";
import { answerFor, DEFAULT_ANSWERS } from "./answers";
import { loadEngine, rehearseAll, type Engine } from "./rehearse";
import { Session } from "./session";

const ROOT = process.cwd();
const DIR = path.join(ROOT, "public", "showcase");
const RECORD = (process.env.SHOWCASE_RECORD ?? "").split(",").filter(Boolean);
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")) : [];

let engine: Engine;
beforeAll(async () => {
  engine = await loadEngine(ROOT);
}, 60_000);

describe.runIf(RECORD.length > 0)("record the showcase (live, spends credits)", () => {
  it.each(RECORD)("%s", async (name) => {
    const sample = SAMPLES.find((s) => s.name === name);
    if (!sample) throw new Error(`${name} is not in lib/samples.ts`);
    process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");
    if (!process.env.NEBIUS_API_KEY) throw new Error("NEBIUS_API_KEY missing from the env file");
    const { poster, recordClip } = await import("./record");
    const session = await recordClip({ root: ROOT, sample, engine, capUsd: Number(process.env.SHOWCASE_CAP_USD ?? 1), log: (l) => console.log(l) });
    writeFileSync(path.join(DIR, `${name}.json`), JSON.stringify(session, null, 1) + "\n");
    poster(ROOT, sample, session, path.join(DIR, `${name}.jpg`));
    console.log(`${name}: ${session.iterations.length} iterations, ${session.ledger.length} calls, US$${session.total_usd.toFixed(4)}`);
  }, 300_000);
});

describe("the showcase recordings", () => {
  it.each(files)("%s replays: same clip, same results in node", (file) => {
    const session = Session.parse(JSON.parse(readFileSync(path.join(DIR, file), "utf8")));
    expect(SAMPLES.map((s) => s.name)).toContain(session.clip.name);
    expect(file).toBe(`${session.clip.name}.json`);
    expect(existsSync(path.join(DIR, `${session.clip.name}.jpg`))).toBe(true);
    expect(session.total_usd).toBeCloseTo(session.ledger.reduce((a, c) => a + c.usd, 0), 6);
    // the interview's programs are the compile turns' programs
    const compiled = session.iterations.filter((it) => it.source === "compile" || it.source === "interview");
    expect(compiled.map((it) => it.program)).toEqual(session.turns.map((t) => t.program));
    for (const [i, it] of session.iterations.entries()) {
      const again = rehearseAll(engine, it.spec, it.program);
      for (const world of ["earth", "orbit"] as const) {
        const { pass, failed_step_id, failed_op } = it.results[world];
        expect({ iteration: i, world, pass: again[world].pass, failed_step_id: again[world].failed_step_id, failed_op: again[world].failed_op }).toEqual({ iteration: i, world, pass, failed_step_id, failed_op });
      }
    }
  }, 60_000);
});

describe("the recorded answers", () => {
  const spec = TaskSpec.parse({
    version: 1,
    title: "block into holder",
    summary: "",
    objects: [
      { id: "block", name: "block", shape: "box", size_mm: [20, 20, 30], symmetry: "none", role: "manipulated" },
      { id: "holder", name: "holder", shape: "box", size_mm: [60, 60, 20], symmetry: "none", role: "fixture" },
    ],
    steps: [{ id: "s2", verb: "insert", object: "block", target: { fixture: "pocket", frame: "holder" }, t_start_s: 0, t_end_s: 1 }],
  });

  it("answers clearance, tolerance and success through the flow's forms", () => {
    expect(answerFor(spec, "objects[holder].pocket_clearance_mm", 1, DEFAULT_ANSWERS)?.change).toEqual({ path: "objects[holder].pocket_clearance_mm", value: DEFAULT_ANSWERS.clearance_mm, source: "interview#1" });
    expect(answerFor(spec, "steps[s2].tolerances.yaw_deg", 2, DEFAULT_ANSWERS)?.text).toBe(`${DEFAULT_ANSWERS.tolerance_deg} °`);
    const success = answerFor(spec, "steps[s2].success", 1, DEFAULT_ANSWERS);
    expect(success?.text).toBe("the block ends up in the holder and stays there");
    expect(success?.change.value).toEqual([
      { kind: "inside_zone", object: "block", target: "holder" },
      { kind: "object_still", object: "block" },
    ]);
  });

  it("leaves what it has no answer for unanswered", () => {
    expect(answerFor(spec, "steps[s2].via_points", 1, DEFAULT_ANSWERS)).toBeNull();
    expect(answerFor(spec, "steps[s2].timeout_s", 1, DEFAULT_ANSWERS)).toBeNull();
  });
});
