/**
 * Records the patching model's twelve scenarios for each NASA sample's spec
 * (the spec of its recording's last iteration, the one /try rehearses once
 * the recorded answers are given) into tests/fixtures/saboteur.json, so
 * /api/saboteur replays them. A re-record replaces those samples' entries
 * and keeps any other. Spends Token Factory credits (about a cent a sample),
 * so it runs only with SABOTEUR_RECORD=1:
 *
 *   SABOTEUR_RECORD=1 node_modules/.bin/vitest run tests/saboteur/record.test.ts --silent=false
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tokenFactory } from "@/lib/providers/tokenfactory";
import { askSaboteur, planOf } from "@/lib/saboteur/ask";
import { Session } from "@/lib/showcase/session";
import type { LedgerEntry, StageResult } from "@/lib/spec/stage-result";
import { costOf } from "@/lib/variants/cost";

const SAMPLES = ["iss-veggie-seed-film", "iss-veggie-seed-film-2", "iss-glovebox-pipette", "iss-fluid-bag-foam", "dev-clip"];
const FIXTURE = path.join(process.cwd(), "tests/fixtures/saboteur.json");

describe.skipIf(process.env.SABOTEUR_RECORD !== "1")("record the saboteur (live, Token Factory)", () => {
  it("records the model's twelve for each sample", async () => {
    process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");
    const client = tokenFactory({ timeout: 60_000, maxRetries: 1 });
    if (!client) throw new Error("NEBIUS_API_KEY missing from the env file");
    type Recording = { spec_title: string; recorded_at: string; result: StageResult<unknown> };
    const kept = JSON.parse(readFileSync(FIXTURE, "utf8")) as Recording[];
    const out: Recording[] = [];
    const billed: LedgerEntry[] = [];
    for (const name of SAMPLES) {
      const s = Session.parse(JSON.parse(readFileSync(path.join(process.cwd(), "public/showcase", `${name}.json`), "utf8")));
      const spec = s.iterations.at(-1)!.spec;
      const ledger: LedgerEntry[] = [];
      const result = await askSaboteur(client, spec, ledger);
      billed.push(...ledger);
      const plan = planOf(spec, result);
      console.info(`${name}: ${result.status}, ${ledger.length} call(s), plan from the ${plan.status === "done" ? plan.value.source : "nowhere"}${plan.status === "done" ? `; ${plan.warnings.join("; ")}` : ""}`);
      if (result.status === "done") out.push({ spec_title: spec.title, recorded_at: new Date().toISOString(), result: { ...result, ledger } });
    }
    const titles = new Set(out.map((r) => r.spec_title));
    writeFileSync(FIXTURE, `${JSON.stringify([...kept.filter((r) => !titles.has(r.spec_title)), ...out], null, 2)}\n`);
    const cost = costOf(billed);
    console.info(`${cost.calls} calls, US$${cost.usd.toFixed(4)}${cost.unpriced ? `, ${cost.unpriced} unpriced` : ""}`);
    expect(out.length).toBeGreaterThan(0);
  }, 600_000);
});
