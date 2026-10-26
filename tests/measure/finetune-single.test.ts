/**
 * One patch on the held-out repair prompts (issue #97). bench/finetune/val.jsonl holds 55 prompts of the
 * training cases that no training step sees; each is a failed rollout that some patcher repaired with one
 * patch. A model gets the same prompt, its patch is applied to the same program (val.meta.jsonl: case,
 * seed, knobs) and rolled out in MuJoCo: the share that pass is its one-patch repair rate. The recorded
 * repair passes every time (checked first, no network), so each prompt has a fix within reach.
 *
 *   BENCH_LIVE=1 UNDERSTUDY_ENV_FILE=.env.local SINGLE_MODELS=nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B,Qwen/Qwen3-30B-A3B-Instruct-2507 \
 *     node_modules/.bin/vitest run tests/measure/finetune-single.test.ts --reporter=verbose
 *
 * Nemotron models get enable_thinking false (as the patcher), a comparator its own least-reasoning setting
 * (scripts/compare-models.mjs). A model in SINGLE_PER_HOUR (a tuned model on a dedicated endpoint, billed
 * by the hour) is charged 0 per call. Results merge by model into bench/results/finetune-single.json;
 * every call goes to the bench ledger (script finetune-eval) and the call log.
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMujoco } from "./gravity-harness";
import { applyPatch, caseGrid, type Knobs, PROBES, type ProbeId, type World } from "./patch-probes";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "bench/results/finetune-single.json");
const SCRIPT = "finetune-eval";
type Meta = { case_id: string; seed: number; knobs: Knobs; patcher: string };
type Chat = { messages: { role: string; content: string }[] };

const read = () => {
  const lines = (f: string) => readFileSync(path.join(ROOT, "bench/finetune", f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const chats = lines("val.jsonl") as Chat[];
  const metas = lines("val.meta.jsonl") as Meta[];
  if (chats.length !== metas.length) throw new Error("val.jsonl and val.meta.jsonl differ in length");
  return chats.map((c, i) => ({ chat: c, meta: metas[i] }));
};

/** roll out a patch on the state a prompt describes */
export function rollout(mj: Awaited<ReturnType<typeof loadMujoco>>, meta: Meta, set: unknown) {
  const c = caseGrid().find((x) => x.id === meta.case_id);
  if (!c) throw new Error(`no case ${meta.case_id}`);
  const probe = PROBES[c.probe as ProbeId];
  const world: World = { ...c.world, seed: meta.seed };
  const chk = applyPatch(probe, meta.knobs, set);
  const r = probe.run(mj, chk.knobs, world);
  return { pass: r.pass, score: r.score, changed: chk.changed };
}

/** the first balanced JSON object in a reply, after any think block (as the patch loop's parser) */
function parseJson(text: string): Record<string, unknown> | null {
  let s = (text ?? "").trimStart();
  while (s.startsWith("<think>")) {
    const end = s.indexOf("</think>");
    if (end < 0) return null;
    s = s.slice(end + 8).trimStart();
  }
  const start = s.indexOf("{");
  if (start < 0) return null;
  for (let end = s.lastIndexOf("}"); end > start; end = s.lastIndexOf("}", end - 1)) {
    try {
      const v = JSON.parse(s.slice(start, end + 1));
      return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
    } catch {
      // a shorter span may parse
    }
  }
  return null;
}

/** Wilson score interval, 95% */
const wilson = (k: number, n: number, z = 1.96) => {
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
};

describe("one patch on the held-out repair prompts (no network)", () => {
  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
    "the recorded repair of every held-out prompt passes again (the state rebuilds from the meta)",
    async () => {
      const mj = await loadMujoco();
      for (const { chat, meta } of read()) {
        const answer = JSON.parse(chat.messages.at(-1)!.content) as { set: unknown };
        expect(rollout(mj, meta, answer.set).pass, `${meta.case_id} seed ${meta.seed}`).toBe(true);
      }
    },
    300_000,
  );
});

describe.skipIf(process.env.BENCH_LIVE !== "1")("one patch on the held-out repair prompts (live)", () => {
  it(
    "asks each model for one patch per prompt and rolls it out",
    async () => {
      process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");
      const KEY = process.env.NEBIUS_API_KEY;
      if (!KEY) throw new Error("NEBIUS_API_KEY missing from the env file");
      const tf = await import("@/lib/providers/tokenfactory");
      const ledger = (await import("../../scripts/bench-ledger.mjs")) as unknown as {
        guard: (est: number, o?: { script?: string; capUsd?: number }) => { id: string; script: string | null; usd: number };
        charge: (script: string, usd: number, meta?: Record<string, unknown>, reservation?: unknown) => void;
        loadPrices: (models: string[], file?: string) => Record<string, { prompt: number; completion: number; cache_read: number | null }>;
      };
      const calls = (await import("../../scripts/call-log.mjs")) as unknown as {
        logCall: (script: string, o: Record<string, unknown>) => string | null;
        logVerdict: (script: string, id: string | null, v: Record<string, unknown>) => void;
      };
      const cmp = (await import("../../scripts/compare-models.mjs")) as unknown as { COMPARATORS: Record<string, { off: Record<string, unknown> }>; COMPARE_CATALOGUE: string };
      const models = (process.env.SINGLE_MODELS ?? tf.MODELS.nano).split(",").map((s) => s.trim()).filter(Boolean);
      const perHour = new Set((process.env.SINGLE_PER_HOUR ?? "").split(",").map((s) => s.trim()).filter(Boolean));
      const cap = Number(process.env.SINGLE_CAP_USD ?? 2);
      const priced = models.filter((m) => !perHour.has(m));
      const PRICES = { ...ledger.loadPrices(priced.filter((m) => !cmp.COMPARATORS[m])), ...(priced.some((m) => cmp.COMPARATORS[m]) ? ledger.loadPrices(priced.filter((m) => cmp.COMPARATORS[m]), cmp.COMPARE_CATALOGUE) : {}) };
      const client = tf.tokenFactory({ timeout: 240_000, maxRetries: 1 })!;
      const mj = await loadMujoco();
      const items = read();
      const mine: Record<string, unknown> = {};
      for (const model of models) {
        const p = PRICES[model] ?? { prompt: 0, completion: 0, cache_read: 0 };
        const rows = [];
        for (const [i, { chat, meta }] of items.entries()) {
          const params: Record<string, unknown> = { model, messages: chat.messages.slice(0, -1), max_tokens: 800, response_format: { type: "json_object" } };
          Object.assign(params, cmp.COMPARATORS[model] ? cmp.COMPARATORS[model].off : model.startsWith("nvidia/") ? tf.thinkingOff() : {});
          const worst = perHour.has(model) ? 0 : 2000 * p.prompt + 800 * p.completion;
          const reservation = ledger.guard(worst, { script: SCRIPT, capUsd: cap });
          const t0 = performance.now();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const res: any = await client.chat.completions.create(params as any);
          const u = tf.usageOf(res);
          const usd = perHour.has(model) ? 0 : u.prompt_tokens * p.prompt + u.completion_tokens * p.completion;
          ledger.charge(SCRIPT, usd, { model, stage: "single", item: i, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, ...(perHour.has(model) ? { per_hour: true } : {}) }, reservation);
          const id = calls.logCall(SCRIPT, { stage: "single-patch", params, res, usage: u, cost_usd: usd, meta: { case: meta.case_id, seed: meta.seed, item: i } });
          const parsed = parseJson(res.choices?.[0]?.message?.content ?? "");
          const set = parsed && typeof parsed.set === "object" && parsed.set !== null && !Array.isArray(parsed.set) ? parsed.set : null;
          const r = set ? rollout(mj, meta, set) : { pass: false, score: 0, changed: [] as string[] };
          calls.logVerdict(SCRIPT, id, { pass: r.pass, score_after: r.score, changed: r.changed });
          rows.push({ item: i, case_id: meta.case_id, seed: meta.seed, set, pass: r.pass, score: r.score, changed: r.changed, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, usd, ms: Math.round(performance.now() - t0) });
        }
        const k = rows.filter((r) => r.pass).length;
        const [lo, hi] = wilson(k, rows.length);
        const usd = rows.reduce((n, r) => n + r.usd, 0);
        mine[model] = { per_hour: perHour.has(model), passed: k, of: rows.length, wilson95: [lo, hi], usd, unparsed: rows.filter((r) => !r.set).length, rows };
        console.log(`${model}: ${k} of ${rows.length} pass with one patch, ${Math.round((100 * k) / rows.length)}% [${Math.round(100 * lo)} to ${Math.round(100 * hi)}], US$${usd.toFixed(4)}`);
      }
      // one writer at a time: re-read under the lock, merge this run's models, rename over (as the patch loop)
      const lock = `${OUT}.lock`;
      const fd = openSync(lock, "wx");
      try {
        writeSync(fd, `${process.pid}\n`);
        const file = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { measurement: "finetune-single", models: {} };
        Object.assign(file.models, mine);
        file.generated_at = new Date().toISOString();
        const body = (JSON.stringify(file, null, 1) + "\n").split(KEY).join("<redacted>");
        const tmp = `${OUT}.${process.pid}.tmp`;
        writeFileSync(tmp, body);
        renameSync(tmp, OUT);
      } finally {
        closeSync(fd);
        unlinkSync(lock);
      }
    },
    3600_000,
  );
});
