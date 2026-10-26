/**
 * Records tests/fixtures/notes.json from a live run of the patch loop on the
 * ISS sample (the program that lets go at the pocket mouth: it seats on Earth
 * and floats in orbit). Spends Token Factory credits (about a cent), so it
 * runs only with NOTES_RECORD=1:
 *
 *   NOTES_RECORD=1 UNDERSTUDY_ENV_FILE=/path/to/.env.local node_modules/.bin/vitest run tests/notes/record.test.ts
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { issSample, loadSim, patchLoop } from "./harness";

describe.skipIf(process.env.NOTES_RECORD !== "1")("record the patch loop (live, Token Factory)", () => {
  beforeAll(loadSim, 60_000);

  it("patches the orbit failure and saves every round", async () => {
    process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");
    if (!process.env.NEBIUS_API_KEY) throw new Error("NEBIUS_API_KEY missing from the env file");
    const ledger = (await import("../../scripts/bench-ledger.mjs")) as unknown as { charge: (script: string, usd: number, meta?: Record<string, unknown>) => void };
    const { spec, program } = await issSample();
    const { rounds, final } = await patchLoop(spec, program, "http://test/api/notes");
    for (const r of rounds) {
      if (r.result.status === "done") ledger.charge("notes-record", r.result.value.cost_usd, { attempt: r.attempt, model: r.result.value.model, thinking: r.result.value.thinking, tokens: r.result.value.tokens });
      console.log(r.attempt, r.result.status === "done" ? JSON.stringify({ set: r.result.value.set, thinking: r.result.value.thinking, why: r.result.value.why, cost: r.result.value.cost_usd }) : r.result);
    }
    console.log("final", final.map((r) => `${r.world}: ${r.rollout.pass ? "pass" : r.rollout.why}`).join("; "));
    writeFileSync(path.join(process.cwd(), "tests/fixtures/notes.json"), `${JSON.stringify(rounds.map(({ attempt, program, result }) => ({ program, attempt, result })), null, 1)}\n`);
    expect(final.every((r) => r.rollout.pass)).toBe(true);
  }, 600_000);
});
