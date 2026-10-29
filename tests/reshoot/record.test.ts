/**
 * Records tests/fixtures/reshoot.json from one live Ultra call on the ISS
 * sample: the program the page rehearses in replay, its rehearsal at 1 g and
 * 0 g, and the patch loop replayed from tests/fixtures/notes.json. Spends
 * Token Factory credits (about a cent), so it runs only with RESHOOT_RECORD=1:
 *
 *   RESHOOT_RECORD=1 UNDERSTUDY_ENV_FILE=/path/to/.env.local node_modules/.bin/vitest run tests/reshoot/record.test.ts
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Reshoot } from "@/lib/reshoot/reshoot";
import type { StageResult } from "@/lib/spec/stage-result";
import { issSample, loadSim } from "../notes/harness";
import { issEvidence } from "./harness";

describe.skipIf(process.env.RESHOOT_RECORD !== "1")("record the reshoot list (live, Token Factory)", () => {
  beforeAll(loadSim, 60_000);

  it("asks Ultra once and saves its answer", async () => {
    process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");
    if (!process.env.NEBIUS_API_KEY) throw new Error("NEBIUS_API_KEY missing from the env file");
    const ledger = (await import("../../scripts/bench-ledger.mjs")) as unknown as { charge: (script: string, usd: number, meta?: Record<string, unknown>) => void };
    const { spec, program } = await issSample();
    const body = await issEvidence(spec, program);
    const { POST } = await import("@/app/api/reshoot/route");
    const started = Date.now();
    const res = await POST(new Request("http://test/api/reshoot", { method: "POST", body: JSON.stringify(body) }));
    const result = (await res.json()) as StageResult<Reshoot>;
    const seconds = (Date.now() - started) / 1000;
    console.log(JSON.stringify({ seconds, result }, null, 1));
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    ledger.charge("reshoot-record", result.value.cost_usd, { model: result.value.model, tokens: result.value.tokens, seconds });
    writeFileSync(path.join(process.cwd(), "tests/fixtures/reshoot.json"), `${JSON.stringify([{ spec_title: spec.title, outcome: result.value.outcome, seconds, result }], null, 1)}\n`);
  }, 200_000);
});
