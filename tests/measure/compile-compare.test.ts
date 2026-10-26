/**
 * Compiling, Nemotron Nano against other models (issue #96). The product's own compile route
 * (app/api/compile/route.ts: its prompt, its ready-made moves, its one repair round, its post-processing)
 * with another model in Nano's place, on the ten interview specs of bench/specs/interview, each fitted to
 * the robot's bench first as the app does (lib/sim/fit.ts): each ground truth (complete, nothing to ask)
 * and its degraded copy (bench/specs/interview/degraded; of the five fields removed there, the route can
 * ask about two: the fit, a pocket's clearance or a zone's tolerance band, and the success check).
 *
 * The route's provider module is changed for the bench only (vi.doMock of tokenFactory): MODELS.nano names
 * the model compared, and every call is
 * guarded and charged on the bench ledger; and the timeout is 240 s with no SDK retry instead of the route's
 * 25 s with one, so a slow model is measured on what it writes (each call's seconds are kept, and the share
 * over 25 s reported). Where the route sends enable_thinking false, a comparator gets its own least-reasoning
 * setting instead (scripts/compare-models.mjs `off`), as Nano gets enable_thinking false.
 *
 * Per compile: did a program come back; how many model calls (one = the first answer parsed, matched the
 * schema and passed the lint); problems left after the repair round; the asks the model wrote itself (before
 * the route drops asks about settled or unanswerable fields and adds the two the rehearsal needs); for a
 * ground-truth spec, whether the program passes its rehearsal at 1 g in MuJoCo (sensed mode).
 *
 *   BENCH_LIVE=1 UNDERSTUDY_ENV_FILE=.env.local COMPILE_MODELS=nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B,Qwen/Qwen3-30B-A3B-Instruct-2507 \
 *     COMPILE_RUNS=3 COMPILE_CONCURRENCY=3 node_modules/.bin/vitest run tests/measure/compile-compare.test.ts --reporter=verbose
 *
 * Results merge into bench/results/compare-compile.json by model (no prompts, no outputs beyond the asks'
 * slots, no key). Without BENCH_LIVE only the no-network check below runs.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MainModule, MjVFS } from "@mujoco/mujoco";
import { describe, expect, it, vi } from "vitest";
import { fitToBench } from "@/lib/sim/fit";
import { environment, runToEnd } from "@/lib/sim/interpreter";
import { SO101_XML, stageXml } from "@/lib/sim/so101";
import { canonicalSlot, valueAt } from "@/lib/spec/apply";
import { Program, TaskSpec } from "@/lib/spec/schema";
import { validateProgram } from "@/lib/spec/validate";

const ROOT = process.cwd();
const SPEC_DIR = path.join(ROOT, "bench/specs/interview");
const OUT = path.join(ROOT, "bench/results", process.env.COMPILE_OUT ?? "compare-compile.json");
const RUNS = Number(process.env.COMPILE_RUNS ?? 3);
const CONCURRENCY = Number(process.env.COMPILE_CONCURRENCY ?? 3);
const SCRIPT = "compare-compile";

type Variant = "truth" | "degraded";
type Case = { name: string; variant: Variant; spec: TaskSpec; fit?: string; success?: string };

function cases(): Case[] {
  const names = readdirSync(SPEC_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  return names.flatMap((name) => {
    const truth = TaskSpec.parse(JSON.parse(readFileSync(path.join(SPEC_DIR, `${name}.json`), "utf8")));
    const d = JSON.parse(readFileSync(path.join(SPEC_DIR, "degraded", `${name}.json`), "utf8")) as { removed: { field: string; path: string }[]; spec: unknown };
    const at = (field: string) => d.removed.find((r) => r.field === field)?.path;
    return [
      { name, variant: "truth" as const, spec: fitToBench(truth).spec },
      { name, variant: "degraded" as const, spec: fitToBench(TaskSpec.parse(d.spec)).spec, fit: at("fit"), success: at("success") },
    ];
  });
}

/**
 * The asks the model wrote: the final program's asks minus those the route made (added for the rehearsal, or
 * made from a check it could not evaluate, lib/spec/normalize.ts), plus those it dropped.
 */
function modelAsks(program: Program, warnings: string[]) {
  const added = warnings.flatMap((w) => w.match(/^added an ask for (\S+): the rehearsal needs it/)?.[1] ?? []);
  const fromBadChecks = warnings.flatMap((w) => {
    const id = w.match(/^step "([^"]*)": predicate .* cannot be evaluated; turned into an ask$/)?.[1];
    return id === undefined ? [] : [`steps[${id}].success`];
  });
  const dropped = warnings.flatMap((w) => w.match(/^dropped an ask for (\S+?)(?::| \()/)?.[1] ?? []);
  // the route's own asks may have been kept or dropped (a made-up success ask on a step that has one is settled)
  const slots = [...program.steps.flatMap((s) => s.ops).flatMap((op) => (op.op === "ask" ? [op.slot] : [])), ...dropped];
  for (const a of [...added, ...fromBadChecks]) {
    const i = slots.indexOf(a);
    if (i >= 0) slots.splice(i, 1);
  }
  return { slots, dropped, added, from_bad_checks: fromBadChecks };
}

/** Did the model itself ask for a removed field (a zone's band counts on any of its axes)? */
const covers = (spec: TaskSpec, slots: string[], field: string | undefined) => Boolean(field) && slots.some((s) => canonicalSlot(spec, s) === field || canonicalSlot(spec, s).startsWith(`${field}.`));

async function loadSim(): Promise<{ mujoco: MainModule; vfs: MjVFS }> {
  const { default: loadMujoco } = await import("@mujoco/mujoco");
  const mujoco = await loadMujoco();
  const dir = path.join(ROOT, "assets", "so101");
  const vfs = new mujoco.MjVFS();
  vfs.addBuffer(SO101_XML, new Uint8Array(readFileSync(path.join(dir, SO101_XML))));
  for (const file of readdirSync(path.join(dir, "assets"))) vfs.addBuffer(file, new Uint8Array(readFileSync(path.join(dir, "assets", file))));
  return { mujoco, vfs };
}

function rehearse(sim: { mujoco: MainModule; vfs: MjVFS }, spec: TaskSpec, program: Program) {
  const env = environment(spec);
  const model = sim.mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: env.gravity_g, graspable: env.graspable }), sim.vfs);
  const data = new sim.mujoco.MjData(model);
  try {
    const r = runToEnd({ mujoco: sim.mujoco, model, data }, env, program, "sensed");
    return { pass: r.pass, failure_class: r.failure_class ?? null, failed_step_id: r.failed_step_id ?? null, why: r.why?.slice(0, 200) ?? null };
  } finally {
    data.delete();
    model.delete();
  }
}

describe("compile comparison (no network)", () => {
  it("reads the spec set, finds the removed fields, and counts the model's own asks", async () => {
    const all = cases();
    expect(all).toHaveLength(20);
    const missing = (spec: TaskSpec, p: string) => {
      const v = valueAt(spec, p);
      return v === undefined || (Array.isArray(v) && !v.length) || (typeof v === "object" && v !== null && !Object.keys(v).length);
    };
    for (const c of all.filter((x) => x.variant === "degraded")) {
      expect(c.fit).toMatch(/pocket_clearance_mm$|tolerances$/);
      expect(c.success).toMatch(/^steps\[s2\]\.success$/);
      // still missing after the bench fit, and present in the fitted truth
      expect(missing(c.spec, c.fit!) && missing(c.spec, c.success!)).toBe(true);
      const truth = all.find((x) => x.name === c.name && x.variant === "truth")!.spec;
      expect(missing(truth, c.fit!) || missing(truth, c.success!)).toBe(false);
    }
    // every fitted truth spec builds next to the arm
    const sim = await loadSim();
    for (const c of all.filter((x) => x.variant === "truth")) {
      const env = environment(c.spec);
      const model = sim.mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: 1, graspable: env.graspable }), sim.vfs);
      model.delete();
    }
    const program = Program.parse({
      spec_title: "t",
      steps: [{ step_id: "s2", ops: [{ op: "ask", slot: "steps[s2].success", question: "q" }, { op: "ask", slot: "steps[s2].tolerances.x_mm", question: "q" }, { op: "release" }] }],
    });
    const asks = modelAsks(program, ["added an ask for steps[s2].success: the rehearsal needs it", 'dropped an ask for objects[cup].size_mm ("how wide?"): not something the person who did the task can answer']);
    expect(asks.slots.sort()).toEqual(["objects[cup].size_mm", "steps[s2].tolerances.x_mm"]);
    // an ask the route made from a check it could not evaluate is not the model's
    const bad = modelAsks(program, ['step "s2": predicate "is_seated" cannot be evaluated; turned into an ask']);
    expect(bad.slots).toEqual(["steps[s2].tolerances.x_mm"]);
    // also when the route then dropped it as settled
    const settledProgram = Program.parse({ spec_title: "t", steps: [{ step_id: "s2", ops: [{ op: "release" }] }] });
    expect(modelAsks(settledProgram, ['step "s2": predicate "is_seated" cannot be evaluated; turned into an ask', "dropped an ask for steps[s2].success: the spec already sets it"]).slots).toEqual([]);
    const zone = all.find((c) => c.variant === "degraded" && c.fit?.endsWith("tolerances"))!;
    expect(covers(zone.spec, asks.slots, zone.fit)).toBe(true);
    expect(covers(zone.spec, asks.slots, zone.success)).toBe(false);
  }, 60_000);
});

describe.skipIf(process.env.BENCH_LIVE !== "1")("compile comparison (live, Token Factory)", () => {
  it(
    "compiles the spec set with each model",
    async () => {
      process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");
      const KEY = process.env.NEBIUS_API_KEY;
      if (!KEY) throw new Error("NEBIUS_API_KEY missing from the env file");
      const redact = (s: unknown) => String(s).split(KEY).join("<redacted>");
      type Reservation = { id: string; script: string | null; usd: number };
      const ledger = (await import("../../scripts/bench-ledger.mjs")) as unknown as {
        guard: (est: number, o?: { script?: string; capUsd?: number; capScripts?: string[]; meta?: Record<string, unknown> }) => Reservation;
        charge: (script: string, usd: number, meta?: Record<string, unknown>, reservation?: Reservation) => void;
        spent: (script?: string) => number;
        loadPrices: (models: string[], file?: string) => Record<string, { prompt: number; completion: number; cache_read: number | null }>;
        costOf: (prices: unknown, model: string, u: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number }) => number;
        BudgetError: new (m: string) => Error;
      };
      const cmp = (await import("../../scripts/compare-models.mjs")) as unknown as {
        COMPARATORS: Record<string, { short: string; off: Record<string, unknown> }>;
        COMPARE_CATALOGUE: string;
        COMPARE_SCRIPTS: string[];
        COMPARE_CAP_USD: number;
      };
      type TF = typeof import("@/lib/providers/tokenfactory");
      const tfReal = await vi.importActual<TF>("@/lib/providers/tokenfactory");
      const models = (process.env.COMPILE_MODELS ?? tfReal.MODELS.nano).split(",").map((s) => s.trim()).filter(Boolean);
      const PRICES = { ...ledger.loadPrices(models.filter((m) => !cmp.COMPARATORS[m])), ...ledger.loadPrices(models.filter((m) => cmp.COMPARATORS[m]), cmp.COMPARE_CATALOGUE) };
      const sim = await loadSim();
      /** COMPILE_ONLY: a few spec names, for a smoke run */
      const all = cases().filter((c) => !process.env.COMPILE_ONLY || process.env.COMPILE_ONLY.split(",").includes(c.name));

      type CallRec = { model: string; ms: number; prompt_tokens: number; completion_tokens: number; reasoning_tokens: number | null; finish: string | null; cost_usd: number; ok: boolean; status?: number | null };
      const scope = new AsyncLocalStorage<CallRec[]>();
      let budgetStop: string | null = null;

      /** the real module, with the compared model as nano and a client that has the ledger around every call and the comparator's own reasoning switch */
      let current = tfReal.MODELS.nano as string;
      vi.doMock("@/lib/providers/tokenfactory", async () => {
        const real = await vi.importActual<TF>("@/lib/providers/tokenfactory");
        return {
          ...real,
          MODELS: {
            ...real.MODELS,
            get nano() {
              return current;
            },
          },
          tokenFactory: () => wrapped(real),
        };
      });
      const wrapped = (real: TF) => {
        const client = real.tokenFactory({ timeout: 240_000, maxRetries: 0 })!;
        const create = client.chat.completions.create.bind(client.chat.completions);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client.chat.completions as any).create = async (body: any) => {
          const model: string = body.model;
          const c = cmp.COMPARATORS[model];
          // the route's enable_thinking false gives way to the comparator's own switch
          const params = c && body.extra_body ? { ...body, extra_body: undefined, ...c.off } : body;
          const p = PRICES[model];
          const chars = JSON.stringify(params.messages).length;
          const worst = (Math.ceil(chars / 3) + 100) * p.prompt + params.max_tokens * p.completion;
          const calls = scope.getStore();
          const meta = { model, stage: "compile" };
          let reservation: Reservation;
          try {
            reservation = ledger.guard(worst, { script: SCRIPT, capUsd: cmp.COMPARE_CAP_USD, capScripts: cmp.COMPARE_SCRIPTS, meta });
          } catch (e) {
            budgetStop = redact((e as Error).message);
            throw e;
          }
          const t0 = performance.now();
          try {
            const res = await create(params);
            const u = real.usageOf(res);
            const cost = ledger.costOf(PRICES, model, u);
            ledger.charge(SCRIPT, cost, { ...meta, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, reasoning_tokens: u.reasoning_tokens ?? null }, reservation);
            calls?.push({ model, ok: true, ms: Math.round(performance.now() - t0), prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, reasoning_tokens: u.reasoning_tokens ?? null, finish: res.choices?.[0]?.finish_reason ?? null, cost_usd: cost });
            return res;
          } catch (err) {
            const status = (err as { status?: number }).status ?? null;
            // the server may have done the work: a failed call costs its reserved worst case
            ledger.charge(SCRIPT, worst, { ...meta, estimated: true, failed: true, status }, reservation);
            // a model the host no longer serves fails every call alike: stop after this one
            if (status === 404) budgetStop = `${model}: HTTP 404, not served by Token Factory any more`;
            calls?.push({ model, ok: false, ms: Math.round(performance.now() - t0), prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: null, finish: null, cost_usd: worst, status });
            throw err;
          }
        };
        return client;
      };

      const file = existsSync(OUT)
        ? JSON.parse(readFileSync(OUT, "utf8"))
        : { measurement: "compare-compile", generated_at: "", reproduce: "", conditions: {}, models: {} };
      file.reproduce = "BENCH_LIVE=1 UNDERSTUDY_ENV_FILE=<path to .env.local> COMPILE_MODELS=<model ids> COMPILE_RUNS=3 COMPILE_CONCURRENCY=3 node_modules/.bin/vitest run tests/measure/compile-compare.test.ts --reporter=verbose (processes one after another; each merges its models into the file)";
      file.conditions = {
        route: "app/api/compile/route.ts POST, unchanged, with MODELS.nano set to the model compared; its client (vi.doMock of tokenFactory) guards and charges each call on the bench ledger, times out at 240 s with no SDK retry (the route: 25 s, one retry), and for a comparator replaces enable_thinking false with the model's own least-reasoning setting (scripts/compare-models.mjs)",
        specs: "bench/specs/interview: 10 ground-truth specs and their degraded copies (bench/specs/interview/degraded), each through lib/sim/fit.ts fitToBench first, as the app compiles them",
        runs: RUNS,
        concurrency: CONCURRENCY,
        rehearsal: "ground-truth programs only: lib/sim/interpreter.ts runToEnd at 1 g, sensed mode, nominal scene",
        model_asks: "the final program's asks minus those the route added ('added an ask for'), plus those it dropped ('dropped an ask for')",
        prices: "Nano from tests/fixtures/models.json, comparators from tests/fixtures/models-compare.json; a failed call is charged at its reserved worst case",
      };

      for (const model of models) {
        if (budgetStop) break;
        current = model;
        vi.resetModules();
        const tf = await import("@/lib/providers/tokenfactory");
        const { POST } = await import("@/app/api/compile/route");
        if (tf.MODELS.nano !== model) throw new Error(`the route would call ${tf.MODELS.nano}, not ${model}`);
        const jobs = all.flatMap((c) => Array.from({ length: RUNS }, (_, r) => ({ c, run: r + 1 })));
        console.log(`\n== ${model}: ${jobs.length} compiles; ${SCRIPT} on the ledger at $${ledger.spent(SCRIPT).toFixed(4)}`);
        const started = performance.now();
        const runs: unknown[] = new Array(jobs.length);
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
            while (next < jobs.length && !budgetStop) {
              const k = next++;
              const { c, run } = jobs[k];
              const calls: CallRec[] = [];
              const t0 = performance.now();
              const res = await scope.run(calls, () => POST(new Request("http://bench/api/compile", { method: "POST", body: JSON.stringify({ spec: c.spec }) })));
              const body = (await res.json()) as { status: string; value?: unknown; warnings?: string[]; message?: string };
              const rec: Record<string, unknown> = { spec: c.name, variant: c.variant, run, status: body.status, wall_s: Number(((performance.now() - t0) / 1000).toFixed(2)), calls };
              if (body.status === "done") {
                const program = Program.parse(body.value);
                const warnings = body.warnings ?? [];
                const asks = modelAsks(program, warnings);
                const lintLeft = warnings.filter((w) => /^nano: /.test(w));
                Object.assign(rec, {
                  // one call in all: a failed repair call means the first answer was not clean either
                  first_answer_clean: calls.length === 1 && calls[0].ok,
                  problems_left: lintLeft.length,
                  validate_errors: validateProgram(program, c.spec).filter((i) => i.severity === "error").length,
                  bad_predicates: asks.from_bad_checks.length,
                  model_asks: asks.slots,
                  dropped_asks: asks.dropped.length,
                  added_asks: asks.added,
                  warnings: warnings.map((w) => w.slice(0, 200)),
                  ...(c.variant === "degraded" ? { asked_fit: covers(c.spec, asks.slots, c.fit), asked_success: covers(c.spec, asks.slots, c.success) } : {}),
                });
                if (c.variant === "truth") {
                  try {
                    rec.rehearsal = rehearse(sim, c.spec, program);
                  } catch (e) {
                    rec.rehearsal = { pass: false, error: String((e as Error).message).slice(0, 200) };
                  }
                }
              } else rec.message = redact(body.message ?? "").slice(0, 300);
              runs[k] = rec;
              const r = rec as { status: string; first_answer_clean?: boolean; model_asks?: string[]; rehearsal?: { pass: boolean } };
              console.log(`  ${c.name.padEnd(24)} ${c.variant.padEnd(8)} run ${run}: ${r.status} calls ${calls.length} (${[...new Set(calls.map((x) => x.model))].join(",")}) ${r.first_answer_clean ? "clean" : ""} asks [${(r.model_asks ?? []).join(" ")}]${r.rehearsal ? ` rehearsal ${r.rehearsal.pass ? "PASS" : "fail"}` : ""} ${(rec.wall_s as number).toFixed(1)} s`);
            }
          }),
        );
        // merge into what is on disk now (another model may have been written since this process started)
        const disk = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : file;
        disk.models = { ...disk.models, [model]: { model, finished: new Date().toISOString(), wall_s: Math.round((performance.now() - started) / 1000), stopped: budgetStop, runs: runs.filter(Boolean) } };
        Object.assign(disk, { generated_at: new Date().toISOString(), reproduce: file.reproduce, conditions: file.conditions });
        let body = JSON.stringify(disk, null, 1) + "\n";
        if (body.includes(KEY)) body = redact(body);
        const tmp = `${OUT}.${process.pid}.tmp`;
        writeFileSync(tmp, body);
        renameSync(tmp, OUT);
      }
      console.log(`\n${SCRIPT} on the ledger $${ledger.spent(SCRIPT).toFixed(4)}; ledger total $${ledger.spent().toFixed(4)}${budgetStop ? `\nSTOPPED: ${budgetStop}` : ""}`);
      vi.doUnmock("@/lib/providers/tokenfactory");
    },
    6 * 3600_000,
  );
});
