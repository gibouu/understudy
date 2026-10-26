/**
 * Records tests/fixtures/variants.json (Super's suggestions for the ISS
 * sample, and its answer to each line in REQUESTS) and adds Nano's compile of
 * every variant to tests/fixtures/compile.json, so the variants replay end to
 * end. Prints each variant's rehearsal at 1 g and 0 g. Spends Token Factory
 * credits (about a cent), so it runs only with VARIANTS_RECORD=1:
 *
 *   VARIANTS_RECORD=1 node_modules/.bin/vitest run tests/variants/record.test.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { tokenFactory } from "@/lib/providers/tokenfactory";
import { TaskSpec } from "@/lib/spec/schema";
import { callModel } from "@/lib/providers/call";
import { variantsCall } from "@/lib/variants/ask";
import { costOf } from "@/lib/variants/cost";
import { checkReply } from "@/lib/variants/validate";
import { issBase, loadSim, postCompile, rollout } from "./harness";

const REQUESTS = [undefined, "put it on a higher shelf", "pour it into the tray instead"];
const fixture = (name: string) => path.join(process.cwd(), "tests/fixtures", name);

describe.skipIf(process.env.VARIANTS_RECORD !== "1")("record the variants (live, Token Factory)", () => {
  beforeAll(loadSim, 60_000);

  it("records Super's replies and Nano's compile of each variant", async () => {
    process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");
    const client = tokenFactory({ timeout: 25_000, maxRetries: 1 });
    if (!client) throw new Error("NEBIUS_API_KEY missing from the env file");
    const { spec, program } = await issBase();
    const replies = [];
    const compiles: { spec: TaskSpec; result: unknown }[] = [];
    let usd = 0;
    let first = 1;
    for (const request of REQUESTS) {
      const call = variantsCall(spec, request);
      const r = await callModel(client, { ...call, check: (reply) => { const problems = call.check!(reply); if (problems.length) console.log("  asked again:", problems); return problems; } });
      usd += costOf(r.status === "done" ? r.ledger : []).usd;
      replies.push({ request: request ?? null, spec_title: spec.title, result: r });
      if (r.status !== "done") {
        console.log(request ?? "(suggest)", r);
        continue;
      }
      // numbered as the page numbers them: suggestions first, then each request
      const checked = checkReply(spec, r.value, first);
      first += checked.variants.length;
      console.log(request ?? "(suggest)", JSON.stringify(r.value), "\n  not yet:", JSON.stringify(checked.not_yet), "\n  warnings:", r.warnings);
      for (const v of checked.variants) {
        const c = await postCompile(v.spec, program, false);
        usd += costOf(c.status === "done" ? c.ledger : []).usd;
        compiles.push({ spec: v.spec, result: c });
        const outcome = c.status === "done" ? [1, 0].map((g) => { const x = rollout(v.spec, c.value, g); return `${g} g ${x.pass ? "pass" : `fail (${x.why})`}`; }).join(", ") : c.status;
        console.log(`  ${v.id} ${v.title}: ${v.edits.map((e) => `${e.path} ${JSON.stringify(e.before)} -> ${JSON.stringify(e.after)}`).join("; ")} | ${outcome}`);
      }
    }
    console.log(`spent US$${usd.toFixed(5)}`);
    writeFileSync(fixture("variants.json"), `${JSON.stringify(replies, null, 1)}\n`);
    const recorded = JSON.parse(readFileSync(fixture("compile.json"), "utf8")) as { spec: unknown }[];
    // a re-record replaces every variant of this sample and keeps every other recording
    const kept = recorded.filter((r) => !TaskSpec.parse(r.spec).title.startsWith(`${spec.title}: `));
    writeFileSync(fixture("compile.json"), `${JSON.stringify([...kept, ...compiles], null, 1)}\n`);
    expect(replies[0].result.status).toBe("done");
  }, 600_000);
});
