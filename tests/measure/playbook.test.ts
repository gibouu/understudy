/**
 * Does the playbook (#56) make the first compile of a NASA showcase clip pass more often? The product's
 * own compile route (app/api/compile/route.ts POST, unchanged) on each manipulation clip's answered spec
 * (the spec of its interview iteration, every question answered as recorded), its program rehearsed
 * at once at 1 g and 0 g (lib/showcase/rehearse.ts, the browser's physics in node), no Notes patch.
 * "First try" is that program passing in both worlds.
 *
 * Arms, the same calls in each (one compile, plus the route's own repair round when an answer is unusable):
 * - off: no playbook, the request from before it;
 * - loo: the playbook on with the rules learned on the other clips only (leave one out), as the next clip
 *   would get them; the route keeps those of the clip's kind of task;
 * - control: the loo request with the rules taken out of the playbook section ("(no rules)"), the matched
 *   control of docs/MEASUREMENTS.md section 8: same instructions, nothing to apply;
 * - own: every rule on by default, the clip's own included: whether the compiler applies a rule at all,
 *   not a carry-over.
 * A clip whose loo set is empty for its kind of task (dev-clip, the only zone clip) runs off and own only.
 *
 *   BENCH_LIVE=1 UNDERSTUDY_ENV_FILE=.env.local PLAYBOOK_RUNS=8 node_modules/.bin/vitest run tests/measure/playbook.test.ts --reporter=verbose
 *
 * Every call is guarded and charged on the bench ledger under "playbook" with a US$0.25 cap. Results go to
 * bench/results/playbook.json (counts per arm and clip, the rules each program cited; no prompts, no key).
 * PLAYBOOK_RECORD=1 also writes the own arm's first answer for the pipette clip, and a compile of its fitted
 * spec with the same rules, into tests/fixtures/compile.json, so the switch replays on /try.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadEngine, rehearse } from "@/lib/showcase/rehearse";
import { Session } from "@/lib/showcase/session";
import { DEFAULT_ON, matchRules, PLAYBOOK, playbookSection } from "@/lib/spec/playbook";
import { Program, type TaskSpec } from "@/lib/spec/schema";
import type { StageResult } from "@/lib/spec/stage-result";

const ROOT = process.cwd();
const RUNS = Number(process.env.PLAYBOOK_RUNS ?? 4);
const CONCURRENCY = 3;
const SCRIPT = "playbook";
const CAP_USD = 0.25;
const CLIPS = ["iss-glovebox-pipette", "iss-veggie-seed-film", "iss-fluid-bag-foam", "iss-veggie-seed-film-2", "dev-clip"] as const;
type Arm = "off" | "loo" | "control" | "own";

const session = (clip: string) => Session.parse(JSON.parse(readFileSync(path.join(ROOT, "public", "showcase", `${clip}.json`), "utf8")));
const answered = (clip: string) => {
  const s = session(clip);
  return (s.iterations.find((it) => it.source === "interview") ?? s.iterations[0]).spec;
};
const loo = (clip: string) => DEFAULT_ON.filter((id) => PLAYBOOK.find((r) => r.id === id)!.evidence.clip !== clip);

describe("the playbook's matched comparison, without the network", () => {
  it("leaves each clip's own rules out of its loo set, and gives dev-clip none", () => {
    expect(matchRules(answered("iss-glovebox-pipette"), loo("iss-glovebox-pipette")).map((r) => r.id)).toEqual(["pocket-wait-still-orbit", "pocket-release-above-floor"]);
    expect(matchRules(answered("iss-veggie-seed-film"), loo("iss-veggie-seed-film")).map((r) => r.id)).toEqual(["pocket-lift-reach"]);
    expect(matchRules(answered("dev-clip"), loo("dev-clip"))).toEqual([]);
  });
});

describe.skipIf(process.env.BENCH_LIVE !== "1")("the playbook against a matched control (live, Token Factory)", () => {
  it(
    "compiles each clip's answered spec in each arm and rehearses it at 1 g and 0 g",
    async () => {
      process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");
      const KEY = process.env.NEBIUS_API_KEY;
      if (!KEY) throw new Error("NEBIUS_API_KEY missing from the env file");
      type Reservation = { id: string };
      const ledger = (await import("../../scripts/bench-ledger.mjs")) as unknown as {
        guard: (est: number, o?: { script?: string; capUsd?: number; capScripts?: string[]; meta?: Record<string, unknown> }) => Reservation;
        charge: (script: string, usd: number, meta?: Record<string, unknown>, reservation?: Reservation) => void;
        spent: (script?: string) => number;
        loadPrices: (models: string[]) => Record<string, { prompt: number; completion: number; cache_read: number | null }>;
        costOf: (prices: unknown, model: string, u: { prompt_tokens: number; completion_tokens: number }) => number;
      };
      type TF = typeof import("@/lib/providers/tokenfactory");
      const tfReal = await vi.importActual<TF>("@/lib/providers/tokenfactory");
      const PRICES = ledger.loadPrices([tfReal.MODELS.nano]);
      const engine = await loadEngine();
      /** the arm of the compile under way: the control's playbook section is emptied on its way out */
      const scope = new AsyncLocalStorage<{ arm: Arm; rules: string; usd: number; calls: number }>();
      let stop: string | null = null;

      vi.doMock("@/lib/providers/tokenfactory", async () => {
        const real = await vi.importActual<TF>("@/lib/providers/tokenfactory");
        return { ...real, tokenFactory: () => wrapped(real) };
      });
      const wrapped = (real: TF) => {
        const client = real.tokenFactory({ timeout: 60_000, maxRetries: 0 })!;
        const create = client.chat.completions.create.bind(client.chat.completions);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client.chat.completions as any).create = async (body: any) => {
          if (stop) throw new Error(stop);
          const s = scope.getStore()!;
          const params =
            s.arm === "control"
              ? { ...body, messages: body.messages.map((m: { role: string; content: string }) => (m.role === "user" && m.content.includes(s.rules) ? { ...m, content: m.content.replace(s.rules, playbookSection([])) } : m)) }
              : body;
          if (s.arm === "control" && !params.messages.some((m: { content: string }) => m.content.includes("(no rules)"))) throw new Error("the control's playbook section was not emptied");
          const p = PRICES[body.model];
          const worst = (Math.ceil(JSON.stringify(params.messages).length / 3) + 100) * p.prompt + params.max_tokens * p.completion;
          let reservation: Reservation;
          try {
            reservation = ledger.guard(worst, { script: SCRIPT, capUsd: CAP_USD, capScripts: [SCRIPT], meta: { model: body.model, arm: s.arm } });
          } catch (e) {
            stop = (e as Error).message.split(KEY).join("<redacted>");
            throw e;
          }
          try {
            const res = await create(params);
            const u = real.usageOf(res);
            const usd = ledger.costOf(PRICES, body.model, u);
            ledger.charge(SCRIPT, usd, { model: body.model, arm: s.arm, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens }, reservation);
            s.usd += usd;
            s.calls++;
            return res;
          } catch (err) {
            ledger.charge(SCRIPT, worst, { model: body.model, arm: s.arm, estimated: true, failed: true }, reservation);
            s.usd += worst;
            s.calls++;
            throw err;
          }
        };
        return client;
      };
      vi.resetModules();
      const { POST } = await import("@/app/api/compile/route");
      const compile = async (spec: TaskSpec, playbook?: { rules: string[] }): Promise<StageResult<Program>> =>
        (await POST(new Request("http://localhost/api/compile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(playbook ? { spec, playbook } : { spec }) }))).json();

      type Job = { clip: string; arm: Arm; run: number };
      const jobs: Job[] = [];
      for (const clip of CLIPS) {
        const arms: Arm[] = matchRules(answered(clip), loo(clip)).length ? ["off", "loo", "control", "own"] : ["off", "own"];
        for (let run = 1; run <= RUNS; run++) for (const arm of arms) jobs.push({ clip, arm, run });
      }
      type Row = Job & { ok: boolean; earth: boolean; orbit: boolean; why?: string; cited: string[]; calls: number; usd: number };
      const rows: Row[] = [];
      const firstOwn = new Map<string, unknown>();
      let next = 0;
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
          while (next < jobs.length && !stop) {
            const job = jobs[next++];
            const spec = answered(job.clip);
            const ids = job.arm === "own" ? [...DEFAULT_ON] : loo(job.clip);
            const rules = matchRules(spec, ids);
            const store = { arm: job.arm, rules: playbookSection(rules), usd: 0, calls: 0 };
            const r = await scope.run(store, () => compile(spec, job.arm === "off" ? undefined : { rules: ids }));
            if (r.status !== "done") {
              rows.push({ ...job, ok: false, earth: false, orbit: false, why: r.status === "failed" ? r.message : r.status, cited: [], calls: store.calls, usd: store.usd });
              continue;
            }
            if (job.arm === "own" && job.clip === "iss-glovebox-pipette" && !firstOwn.has("answered")) firstOwn.set("answered", { spec, playbook: rules.map((x) => x.id), result: r });
            const program = Program.parse(r.value);
            const earth = rehearse(engine, spec, program, "earth");
            const orbit = rehearse(engine, spec, program, "orbit");
            rows.push({ ...job, ok: true, earth: earth.pass, orbit: orbit.pass, why: earth.pass ? orbit.why : earth.why, cited: program.playbook ?? [], calls: store.calls, usd: store.usd });
            console.log(`${job.clip} ${job.arm} #${job.run}: 1 g ${earth.pass ? "pass" : `fail (${earth.why})`}, 0 g ${orbit.pass ? "pass" : `fail (${orbit.why})`}${program.playbook ? `; cites ${program.playbook.join(", ") || "none"}` : ""}`);
          }
        }),
      );
      if (stop) console.log(`STOPPED: ${stop}`);

      const summary: Record<string, Record<string, { runs: number; both: number; earth: number; orbit: number; compiled: number; cited: Record<string, number>; usd: number }>> = {};
      for (const row of rows) {
        const s = ((summary[row.clip] ??= {})[row.arm] ??= { runs: 0, both: 0, earth: 0, orbit: 0, compiled: 0, cited: {}, usd: 0 });
        s.runs++;
        s.compiled += row.ok ? 1 : 0;
        s.both += row.earth && row.orbit ? 1 : 0;
        s.earth += row.earth ? 1 : 0;
        s.orbit += row.orbit ? 1 : 0;
        s.usd = Math.round((s.usd + row.usd) * 1e6) / 1e6;
        for (const c of row.cited) s.cited[c] = (s.cited[c] ?? 0) + 1;
      }
      console.log(JSON.stringify(summary, null, 1));
      writeFileSync(
        path.join(ROOT, "bench/results/playbook.json"),
        `${JSON.stringify(
          {
            measurement: "playbook",
            generated_at: new Date().toISOString(),
            reproduce: "BENCH_LIVE=1 UNDERSTUDY_ENV_FILE=<path to .env.local> PLAYBOOK_RUNS=8 node_modules/.bin/vitest run tests/measure/playbook.test.ts --reporter=verbose",
            conditions: {
              route: "app/api/compile/route.ts POST, unchanged; its client (vi.doMock of tokenFactory) guards and charges each call on the bench ledger, 60 s timeout, no SDK retry",
              model: tfReal.MODELS.nano,
              specs: "each clip's interview iteration spec in public/showcase/<clip>.json (every question answered as recorded)",
              rehearsal: "lib/showcase/rehearse.ts at 1 g and 0 g, nominal scene, no Notes patch; first try = passes in both",
              arms: "off: no playbook; loo: the default-on rules learned on the other clips; control: the loo request with its rules replaced by '(no rules)'; own: every default-on rule, the clip's own included",
              runs: RUNS,
            },
            summary,
            rows: rows.map(({ clip, arm, run, ok, earth, orbit, why, cited, calls, usd }) => ({ clip, arm, run, ok, earth, orbit, why, cited, calls, usd })),
          },
          null,
          1,
        )}\n`,
      );

      if (process.env.PLAYBOOK_RECORD === "1") {
        const file = path.join(ROOT, "tests/fixtures/compile.json");
        const recorded = JSON.parse(readFileSync(file, "utf8")) as { spec: unknown; playbook?: string[] }[];
        const fitted = session("iss-glovebox-pipette").iterations[0].spec;
        const ids = matchRules(fitted, DEFAULT_ON).map((x) => x.id);
        const store = { arm: "own" as Arm, rules: "", usd: 0, calls: 0 };
        const first = await scope.run(store, () => compile(fitted, { rules: ids }));
        if (first.status !== "done") throw new Error(`the fitted pipette spec did not compile with the playbook: ${JSON.stringify(first)}`);
        const fresh = [{ spec: fitted, playbook: ids, result: first }, firstOwn.get("answered")].filter(Boolean) as { spec: unknown; playbook: string[] }[];
        const key = (x: { spec: unknown; playbook?: string[] }) => JSON.stringify([x.spec, x.playbook]);
        const kept = recorded.filter((x) => !fresh.some((f) => key(f) === key(x)));
        // before the last recording, which tests/unlock/routes.test.ts reads as compiles.at(-1)
        writeFileSync(file, `${JSON.stringify([...kept.slice(0, -1), ...fresh, ...kept.slice(-1)], null, 1)}\n`);
        console.log(`recorded ${fresh.length} compiles with the playbook into tests/fixtures/compile.json`);
      }
      console.log(`${SCRIPT} on the ledger: $${ledger.spent(SCRIPT).toFixed(4)}`);
      expect(rows.length).toBeGreaterThan(0);
    },
    1_800_000,
  );
});
