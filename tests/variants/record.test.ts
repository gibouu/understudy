/**
 * Records Super's suggestions for one task, and its answer to each of that
 * task's requests, into tests/fixtures/variants.json, and adds Nano's compile
 * of every variant (and of the task itself, when it has no recording yet) to
 * tests/fixtures/compile.json, so the variants replay end to end. The task is the ISS sample, or with VARIANTS_BASE=pour the stage's
 * pour; a re-record replaces that task's recordings and keeps every other.
 * Prints each variant's rehearsal on Earth and in orbit. Spends Token Factory
 * credits (about a cent), so it runs only with VARIANTS_RECORD=1. With
 * VARIANTS_KEEP_REPLIES=1 it keeps Super's recorded replies and compiles only
 * the variants that have no recording of their exact spec (a tenth of a cent):
 *
 *   VARIANTS_RECORD=1 [VARIANTS_BASE=pour] [VARIANTS_KEEP_REPLIES=1] node_modules/.bin/vitest run tests/variants/record.test.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { tokenFactory } from "@/lib/providers/tokenfactory";
import { loadEngine, rollout, type Engine } from "@/lib/showcase/rehearse";
import { POUR_PROGRAMS, POUR_SPEC } from "@/lib/sim/demo-spec";
import { TaskSpec, type Program } from "@/lib/spec/schema";
import type { StageResult } from "@/lib/spec/stage-result";
import { callModel } from "@/lib/providers/call";
import { variantsCall } from "@/lib/variants/ask";
import { costOf } from "@/lib/variants/cost";
import { MAX_VARIANTS, VariantReply } from "@/lib/variants/parse";
import { checkReply } from "@/lib/variants/validate";
import { issBase, postCompile } from "./harness";

const BASES = {
  iss: { load: issBase, requests: [undefined, "put it on a higher shelf", "pour it into the tray instead"] },
  pour: { load: async () => ({ spec: POUR_SPEC, program: POUR_PROGRAMS.pour }), requests: [undefined, "pour it into a bigger bowl", "pour it back"] },
};
const fixture = (name: string) => path.join(process.cwd(), "tests/fixtures", name);

describe.skipIf(process.env.VARIANTS_RECORD !== "1")("record the variants (live, Token Factory)", () => {
  let engine: Engine;
  beforeAll(async () => {
    engine = await loadEngine();
  }, 60_000);

  it("records Super's replies and Nano's compile of each variant", async () => {
    process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");
    const client = tokenFactory({ timeout: 25_000, maxRetries: 1 });
    if (!client) throw new Error("NEBIUS_API_KEY missing from the env file");
    const base = BASES[(process.env.VARIANTS_BASE ?? "iss") as keyof typeof BASES];
    if (!base) throw new Error(`VARIANTS_BASE is one of ${Object.keys(BASES).join(", ")}`);
    const { spec, program } = await base.load();
    const keep = process.env.VARIANTS_KEEP_REPLIES === "1";
    type Reply = { request: string | null; spec_title: string; result: StageResult<unknown> };
    const recordedReplies = JSON.parse(readFileSync(fixture("variants.json"), "utf8")) as Reply[];
    const recordedCompiles = JSON.parse(readFileSync(fixture("compile.json"), "utf8")) as { spec: unknown; result: StageResult<Program> }[];
    let usd = 0;
    // the task itself, when compile.json has no compile of its exact spec (the pour, #125): compiled once, then kept;
    // a failed compile is never recorded, so the next re-record tries again
    const isBase = (x: { spec: unknown }) => JSON.stringify(TaskSpec.parse(x.spec)) === JSON.stringify(spec);
    const baseCompile = recordedCompiles.some((x) => isBase(x) && x.result.status === "done") ? undefined : await postCompile(spec, undefined, false);
    if (baseCompile) {
      if (baseCompile.status !== "done") throw new Error(`"${spec.title}" did not compile: ${JSON.stringify(baseCompile)}`);
      usd += costOf(baseCompile.ledger).usd;
      console.log(`  "${spec.title}" compiled live | ${(["earth", "orbit"] as const).map((w) => { const x = rollout(engine, spec, baseCompile.value, w); return `${w} ${x.pass ? "pass" : `fail (${x.why})`}`; }).join(", ")}`);
    }
    const replies = [];
    const compiles: { spec: TaskSpec; result: unknown }[] = [];
    let first = 1;
    for (const request of base.requests) {
      let r: StageResult<VariantReply>;
      if (keep) {
        const kept = recordedReplies.find((x) => x.spec_title === spec.title && x.request === (request ?? null))?.result;
        if (kept?.status !== "done") throw new Error(`no recorded reply to ${request ?? "the suggestions"} for "${spec.title}"`);
        r = { ...kept, value: VariantReply.parse(kept.value) };
      } else {
        const call = variantsCall(spec, request);
        r = await callModel(client, { ...call, check: (reply) => { const problems = call.check!(reply); if (problems.length) console.log("  asked again:", problems); return problems; } });
        usd += costOf(r.status === "done" ? r.ledger : []).usd;
      }
      replies.push({ request: request ?? null, spec_title: spec.title, result: r });
      // numbered as the page numbers them (app/variants.tsx, reserve): suggestions take MAX_VARIANTS numbers, each line one, failed or not
      const numbered = first;
      first += request ? 1 : MAX_VARIANTS;
      if (r.status !== "done") {
        console.log(request ?? "(suggest)", r);
        continue;
      }
      const checked = checkReply(spec, r.value, numbered);
      console.log(request ?? "(suggest)", JSON.stringify(r.value), "\n  not yet:", JSON.stringify(checked.not_yet), "\n  warnings:", r.warnings);
      for (const v of checked.variants) {
        const exact = keep ? recordedCompiles.find((x) => JSON.stringify(TaskSpec.parse(x.spec)) === JSON.stringify(v.spec))?.result : undefined;
        const c = exact ?? (await postCompile(v.spec, program, false));
        if (!exact) usd += costOf(c.status === "done" ? c.ledger : []).usd;
        console.log(`  ${v.id} ${v.title}: ${exact ? "kept its recorded compile" : "compiled live"}`);
        compiles.push({ spec: v.spec, result: c });
        const outcome = c.status === "done" ? (["earth", "orbit"] as const).map((w) => { const x = rollout(engine, v.spec, c.value, w); return `${w} ${x.pass ? "pass" : `fail (${x.why})`}${x.liquid ? ` liquid ${JSON.stringify(x.liquid)}` : ""}`; }).join(", ") : c.status;
        console.log(`  ${v.id} ${v.title}: ${v.edits.map((e) => `${e.path} ${JSON.stringify(e.before)} -> ${JSON.stringify(e.after)}`).join("; ")} | ${outcome}`);
      }
    }
    console.log(`spent US$${usd.toFixed(5)}`);
    // this task's recordings replace its old ones where they were; the replay falls back on the first file entry
    const before = JSON.parse(readFileSync(fixture("variants.json"), "utf8")) as { spec_title: string }[];
    const at = before.findIndex((r) => r.spec_title === spec.title);
    const others = before.filter((r) => r.spec_title !== spec.title);
    const merged = at < 0 ? [...others, ...replies] : [...others.slice(0, at), ...replies, ...others.slice(at)];
    writeFileSync(fixture("variants.json"), `${JSON.stringify(merged, null, 1)}\n`);
    const recorded = JSON.parse(readFileSync(fixture("compile.json"), "utf8")) as { spec: unknown }[];
    // a re-record replaces every variant of this task where they were and keeps every other recording
    const mine = (r: { spec: unknown }) => TaskSpec.parse(r.spec).title.startsWith(`${spec.title}: `);
    const from = recorded.findIndex(mine);
    const kept: { spec: unknown; result?: unknown }[] = recorded.filter((r) => !mine(r) && !(baseCompile && isBase(r)));
    if (baseCompile) kept.push({ spec, result: baseCompile });
    const place = from < 0 ? kept.length : recorded.slice(0, from).filter((r) => kept.includes(r)).length;
    writeFileSync(fixture("compile.json"), `${JSON.stringify([...kept.slice(0, place), ...compiles, ...kept.slice(place)], null, 1)}\n`);
    expect(replies[0].result.status).toBe("done");
  }, 600_000);
});
