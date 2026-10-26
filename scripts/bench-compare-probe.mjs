// Which non-NVIDIA models on Token Factory can stand in for Nano, Super, Ultra and Super VL (issue #96):
// lists the catalogue live, then probes, for a few candidates, how reasoning is switched off and on, and
// which vision models really read a video.
//
//   UNDERSTUDY_ENV_FILE=/path/to/.env.local node scripts/bench-compare-probe.mjs [--out bench/results/compare-probe.json]
//
// 1. GET /v1/models?verbose=true, saved as tests/fixtures/models-compare.json (prices for the ledger).
// 2. Reasoning switch: one short arithmetic question in JSON mode per model and variant (default; enable_thinking
//    false; for gpt-oss reasoning_effort low and high); records reasoning tokens, finish and whether the answer parses.
// 3. Video: the first 6 s of the ISS clip as a 480-wide, 4 fps H.264 data URI in a video_url part (as the Label
//    route sends it), asking how long the clip is and what the person does. A model that reads the video spends
//    about a thousand prompt tokens on it and gives a duration near 6 s; one that drops the part does neither.
// Every billed call is guarded and charged to bench/results/ledger.jsonl (script compare-probe).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BudgetError, charge, costOf, guard, loadPrices, spent } from "./bench-ledger.mjs";
import { COMPARE_CAP_USD, COMPARE_CATALOGUE, COMPARE_SCRIPTS, ENABLE_THINKING_OFF } from "./compare-models.mjs";

const SCRIPT = "compare-probe";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");
const KEY = process.env.NEBIUS_API_KEY;
if (!KEY) throw new Error("NEBIUS_API_KEY missing from the env file");
const redact = (s) => String(s).split(KEY).join("<redacted>");
const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : [])));
const OUT = path.resolve(ROOT, args.out ?? "bench/results/compare-probe.json");
/** --sections reasoning,video (default both); a partial run keeps the other section of the existing file */
const SECTIONS = String(args.sections ?? "reasoning,video").split(",");

const { MODELS, TOKEN_FACTORY_BASE_URL, tokenFactory, usageOf } = await import(path.join(ROOT, "lib/providers/tokenfactory.ts"));
const client = tokenFactory({ timeout: 180_000, maxRetries: 0 });

// --- 1. the catalogue, live --------------------------------------------------------------
const res = await fetch(`${TOKEN_FACTORY_BASE_URL}models?verbose=true`, { headers: { Authorization: `Bearer ${KEY}` } });
if (!res.ok) throw new Error(`GET /models: HTTP ${res.status}`);
const listed = await res.json();
const models = listed.data ?? listed.models ?? listed;
const catalogue = { fetched: new Date().toISOString().slice(0, 10), source: "GET https://api.tokenfactory.nebius.com/v1/models?verbose=true", models };
writeFileSync(COMPARE_CATALOGUE, JSON.stringify(catalogue, null, 2) + "\n");
console.log(`${models.length} models listed; saved ${path.relative(ROOT, COMPARE_CATALOGUE)}`);

const TEXT = ["Qwen/Qwen3-30B-A3B-Instruct-2507", "openai/gpt-oss-120b", "Qwen/Qwen3.5-397B-A17B", "zai-org/GLM-5.3", "deepseek-ai/DeepSeek-V4-Pro", "meta-models/muse-spark-open"];
/** switches tried beyond the default and enable_thinking false, per model (the families differ) */
const MORE_VARIANTS = {
  "openai/gpt-oss-120b": [["reasoning_effort low", { reasoning_effort: "low" }], ["reasoning_effort high", { reasoning_effort: "high" }]],
  "zai-org/GLM-5.3": [["thinking disabled", { extra_body: { thinking: { type: "disabled" } } }], ["reasoning_effort none", { reasoning_effort: "none" }], ["reasoning_effort low", { reasoning_effort: "low" }]],
  "deepseek-ai/DeepSeek-V4-Pro": [["chat_template thinking true", { extra_body: { chat_template_kwargs: { thinking: true } } }], ["thinking enabled", { extra_body: { thinking: { type: "enabled" } } }], ["reasoning_effort high", { reasoning_effort: "high" }]],
  "meta-models/muse-spark-open": [["reasoning_effort none", { reasoning_effort: "none" }], ["reasoning_effort low", { reasoning_effort: "low" }]],
};
const VIDEO = [MODELS.vl, "meta-models/muse-spark-open", "MiniMaxAI/MiniMax-M3.1-Flash", "openbmb/MiniCPM-V-4_5", "moonshotai/Kimi-K2.6", "moonshotai/Kimi-K3", "Qwen/Qwen3.8-27B", "Qwen/Qwen3.5-397B-A17B", "zai-org/GLM-5.3-Flash", "deepseek-ai/DeepSeek-V4.1-Flash-1017"];
const PRICES = loadPrices([...TEXT, ...VIDEO], COMPARE_CATALOGUE);

async function call(model, params, estTokens, meta) {
  const p = PRICES[model];
  const worst = estTokens * p.prompt + params.max_tokens * p.completion;
  const reservation = guard(worst, { script: SCRIPT, capUsd: COMPARE_CAP_USD, capScripts: COMPARE_SCRIPTS, meta: { model, ...meta } });
  const t0 = performance.now();
  try {
    const r = await client.chat.completions.create({ model, ...params });
    const u = usageOf(r);
    const cost = costOf(PRICES, model, u);
    charge(SCRIPT, cost, { model, ...meta, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, reasoning_tokens: u.reasoning_tokens ?? null }, reservation);
    const msg = r.choices?.[0]?.message ?? {};
    return { ok: true, ms: Math.round(performance.now() - t0), prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, reasoning_tokens: u.reasoning_tokens ?? null, reasoning_chars: String(msg.reasoning_content ?? msg.reasoning ?? "").length, finish: r.choices?.[0]?.finish_reason ?? null, text: String(msg.content ?? ""), cost_usd: cost };
  } catch (err) {
    charge(SCRIPT, worst, { model, ...meta, estimated: true, failed: true, status: err?.status ?? null }, reservation);
    return { ok: false, ms: Math.round(performance.now() - t0), status: err?.status ?? null, error: redact(err?.message ?? err).slice(0, 300), cost_usd: worst };
  }
}
const parse = (text) => {
  const s = String(text).replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  try {
    return a >= 0 && b > a ? JSON.parse(s.slice(a, b + 1)) : null;
  } catch {
    return null;
  }
};

const before = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
const out = { measurement: "compare-probe", date: new Date().toISOString(), reproduce: "UNDERSTUDY_ENV_FILE=<path to .env.local> node scripts/bench-compare-probe.mjs [--sections reasoning,video]", catalogue: { fetched: catalogue.fetched, count: models.length, file: path.relative(ROOT, COMPARE_CATALOGUE) }, reasoning: SECTIONS.includes("reasoning") ? [] : (before?.reasoning ?? []), video: SECTIONS.includes("video") ? [] : (before?.video ?? []), spend_usd: 0 };
try {
  // --- 2. how reasoning is switched ------------------------------------------------------------
  const QUESTION = 'A tube 17 mm wide must go into a pocket 20 mm wide whose centre is 4.1 mm from the tube along +x. How far, in mm, must the tube move along x? Return one JSON object only: {"dx_mm": number}.';
  for (const model of SECTIONS.includes("reasoning") ? TEXT : []) {
    const variants = [
      ["default", {}],
      ["enable_thinking false", ENABLE_THINKING_OFF],
      ...(MORE_VARIANTS[model] ?? []),
    ];
    for (const [name, extra] of variants) {
      const r = await call(model, { messages: [{ role: "user", content: QUESTION }], max_tokens: 3000, response_format: { type: "json_object" }, ...extra }, 200, { probe: "reasoning", variant: name });
      const v = parse(r.text);
      out.reasoning.push({ model, variant: name, ...r, text: undefined, answer: v?.dx_mm ?? null, json_ok: v !== null });
      console.log(`${model.padEnd(36)} ${name.padEnd(22)} ${r.ok ? `in ${r.prompt_tokens} out ${r.completion_tokens} reasoning ${r.reasoning_tokens ?? "-"} (${r.reasoning_chars} chars) ${r.finish} ${r.ms} ms answer ${v?.dx_mm}` : `FAILED ${r.status} ${r.error}`}`);
    }
  }

  // --- 3. who reads a video ----------------------------------------------------------------------
  if (SECTIONS.includes("video")) {
  const dir = path.join(os.tmpdir(), "understudy-bench");
  mkdirSync(dir, { recursive: true });
  const clip = path.join(dir, "iss-first6s-480w-4fps.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", path.join(ROOT, "samples/iss-veggie-seed-film.mp4"), "-t", "6", "-an", "-vf", "scale=480:-2,fps=4", "-c:v", "libx264", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart", clip]);
  const uri = `data:video/mp4;base64,${readFileSync(clip).toString("base64")}`;
  const ASK = 'Watch the video. Return one JSON object only: {"duration_s": <how long the video is, in seconds>, "frames_differ": <true if the picture changes during the video>, "what": <one sentence: what the person does>}.';
  for (const model of SECTIONS.includes("video") ? VIDEO : []) {
    const r = await call(model, { messages: [{ role: "user", content: [{ type: "text", text: ASK }, { type: "video_url", video_url: { url: uri } }] }], max_tokens: 2000, response_format: { type: "json_object" }, ...ENABLE_THINKING_OFF }, 3000, { probe: "video" });
    const v = parse(r.text);
    out.video.push({ model, ...r, text: undefined, duration_s: v?.duration_s ?? null, frames_differ: v?.frames_differ ?? null, what: typeof v?.what === "string" ? v.what.slice(0, 200) : null });
    console.log(`${model.padEnd(40)} ${r.ok ? `in ${r.prompt_tokens} out ${r.completion_tokens} ${r.finish} ${r.ms} ms; duration ${v?.duration_s}; "${String(v?.what ?? "").slice(0, 90)}"` : `FAILED ${r.status} ${r.error}`}`);
  }
  }
} catch (err) {
  if (!(err instanceof BudgetError)) throw err;
  out.stopped = err.message;
}
/** every probe call in the file, this run's and the kept section's */
out.spend_usd = Number([...out.reasoning, ...out.video].reduce((n, r) => n + (r.cost_usd ?? 0), 0).toFixed(6));
let body = JSON.stringify(out, null, 2) + "\n";
if (body.includes(KEY)) body = redact(body);
writeFileSync(OUT, body);
console.log(`\nwrote ${path.relative(ROOT, OUT)}; spent $${out.spend_usd.toFixed(4)}; ledger total $${spent().toFixed(4)}`);
