// A LoRA fine-tune on Nebius Token Factory itself (issue #97), on the repair dataset in bench/finetune/.
// Token Factory fine-tunes no NVIDIA model, so the base is a model on its list (docs/FINETUNE.md says
// which and why). Every step that can cost money asks for the numbers it needs and refuses without them:
// Token Factory publishes no fine-tuning price and the API key cannot read the balance.
//
// Every command takes --model M, the base model (default Qwen/Qwen3-30B-A3B-Instruct-2507). Each base has its
// own state file and lock, so jobs on several bases can run side by side, one job per base.
//
//   node scripts/finetune-tf.mjs upload                       checks the files against manifest.json, uploads them
//   node scripts/finetune-tf.mjs create --usd-per-mtok P --balance-usd B [--epochs 5] [--dry-run] [--allow-another-job]
//        estimates the cost (training tokens x epochs x P), refuses when B minus it would fall under
//        US$15 (the live demo's floor), marks the job pending, reserves the estimate, creates the job and
//        charges the estimate at once (so no long-open reservation is left for --settle-stale)
//   node scripts/finetune-tf.mjs status                       the job's state, steps, losses, checkpoints;
//        once it ends, charges what it trained beyond the estimate, if anything (once)
//   node scripts/finetune-tf.mjs adopt                        after a create whose answer was lost: takes the
//        one new job on the uploaded training file and charges the estimate
//   node scripts/finetune-tf.mjs release --confirm-no-job     after a create that started nothing (checked in
//        the console): gives the reservation back and clears the pending mark
//   node scripts/finetune-tf.mjs try-serve                    once the job succeeded: asks the tuned model for one
//        tiny answer by two routes that need no dedicated endpoint (the checkpoint id on the serverless API, and
//        the checkpoint registered as a serverless LoRA model through POST /v0/models, the route of Token
//        Factory's cookbook fine_tune_llama.ipynb) and keeps what each one said; each call goes on the ledger at
//        an estimated price
//   node scripts/finetune-tf.mjs delete-lora                  removes the LoRA model try-serve registered (DELETE
//        /v1/models/<name>, as the cookbook does), once the evaluation is done
//   node scripts/finetune-tf.mjs endpoint-create --custom-weights-id W --minutes M [--usd-per-gpu-hour 5.6]
//        a dedicated endpoint serving the tuned weights (needs Support's custom-weights switch), one H200 in
//        us-central1 (the only offer for this model), reserves M minutes at the GPU-hour price on the ledger and
//        starts a watchdog that deletes it at the deadline (retrying until it is gone) and charges the hours run
//   node scripts/finetune-tf.mjs endpoint-delete              deletes it now and charges the hours run
//   node scripts/finetune-tf.mjs endpoint-adopt | endpoint-release --confirm-no-endpoint   after a lost answer
//
// A create that fails leaves the job "pending": no other create runs until adopt or release says what
// happened, so a lost answer can never lead to a second paid job, and nothing is released by guesswork.
// State (file ids, job id, price, checkpoints, losses; no key) is kept in bench/results/finetune-tf.json for the
// default base, and in bench/results/finetune-tf-<base, as a slug>.json for any other.
// The key comes from UNDERSTUDY_ENV_FILE (default .env.local), as in every bench script.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI, { toFile } from "openai";
import { charge, entries, guard, release } from "./bench-ledger.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
export const DEFAULT_MODEL = "Qwen/Qwen3-30B-A3B-Instruct-2507";
const BASE_MODEL = opt("--model") ?? DEFAULT_MODEL;
/**
 * A base model's identity, whatever the spelling: Token Factory names one model several ways (its cookbook
 * fine-tunes meta-llama/Llama-3.1-8B-Instruct and serves meta-llama/Meta-Llama-3.1-8B-Instruct), so the
 * organisation, the case and a "Meta-" prefix are dropped, and the rest kept as a file-name part:
 * Qwen/Qwen3-14B -> qwen3-14b, both Llama spellings -> llama-3-1-8b-instruct.
 */
export const canon = (model) =>
  String(model)
    .split("/")
    .pop()
    .toLowerCase()
    .replace(/^meta-(?=llama)/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
// overridable for the tests only (tests/providers/finetune-tf.test.ts runs this script against a local mock)
const DEFAULT_STATE = process.env.FINETUNE_TF_STATE ?? path.join(ROOT, "bench/results/finetune-tf.json");
// the default base keeps the file it always had; every other base gets its own, so its job, lock and guards are its own
const STATE = canon(BASE_MODEL) === canon(DEFAULT_MODEL) ? DEFAULT_STATE : DEFAULT_STATE.replace(/\.json$/, `-${canon(BASE_MODEL)}.json`);
const BASE_URL = process.env.FINETUNE_TF_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1/";
const DATA = path.join(ROOT, "bench/finetune");
const SCRIPT = "finetune-tf";
export const FLOOR_USD = 15;
/** a minute, in ms; the tests shrink it so the watchdog's deadline comes in a moment */
const MINUTE_MS = Number(process.env.FINETUNE_TF_MINUTE_MS ?? 60_000);
/** where an endpoint's watchdog writes; the tests point it into their temp dir, away from a real endpoint's log */
const WATCHDOG_LOG = process.env.FINETUNE_TF_WATCHDOG_LOG || path.join(process.env.TMPDIR ?? os.tmpdir(), "understudy-ft-endpoint-watchdog.log");
/**
 * For the tests only: the process whose end stops a watchdog at once, deleting nothing, so a watchdog
 * pointed at a test's mock server never outlives the test run (#157). Unset, a watchdog runs to its deadline.
 */
const OWNER = Number(process.env.FINETUNE_TF_WATCHDOG_OWNER) || 0;
const ownerGone = () => {
  if (!OWNER) return false;
  try {
    process.kill(OWNER, 0);
    return false;
  } catch (e) {
    return e.code !== "EPERM";
  }
};
const ownerGoneNote = () => console.log(`${new Date().toISOString()} the process that started this watchdog (${OWNER}) is gone; the watchdog stops`);
/**
 * LoRA settings: rank 16 and alpha 32 as on the AI Cloud route. Token Factory wants at least 131,072 tokens
 * a batch (batch size x context length; a 422 said so), so at the shortest context, 8,192, the batch is
 * 16 packed sequences: about 7 steps an epoch for our 0.9M tokens. Hence 5 epochs (about 35 steps) and a
 * LoRA learning rate of 2e-4, not the full-tune default 1e-5.
 */
export const HYPER = { lora: true, lora_r: 16, lora_alpha: 32, lora_dropout: 0.05, learning_rate: 2e-4, batch_size: 16, warmup_ratio: 0.05, context_length: 8192, packing: true };
export const EPOCHS = 5;

const state = () => {
  if (!existsSync(STATE)) return { base_model: BASE_MODEL };
  const s = JSON.parse(readFileSync(STATE, "utf8"));
  if (s.base_model !== BASE_MODEL) throw new Error(`${STATE} is the state of ${s.base_model}, not of ${BASE_MODEL}: use that spelling`);
  return s;
};
/** write a temporary file and rename it over: a reader sees the old state or the new one, never a half-written file */
const save = (s) => {
  const tmp = `${STATE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, STATE);
};
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * One create or settle at a time: an exclusive lock file next to the state, so two shells cannot both
 * pass the "no job yet" check and pay twice, or settle the same job twice.
 */
async function locked(fn, lock = `${STATE}.lock`) {
  let fd;
  try {
    fd = openSync(lock, "wx");
  } catch {
    throw new Error(`${lock} exists: another finetune-tf command is running (remove the file only if none is)`);
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
/** as locked(), waiting up to 2 minutes for the lock: the watchdog must not give up on a busy moment */
async function lockedWait(fn) {
  for (let i = 0; ; i++) {
    try {
      return await locked(fn);
    } catch (e) {
      if (!String(e?.message).includes("another finetune-tf command is running") || i >= 240) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
/**
 * What the other bases' jobs will still take from the balance: the estimate of every one that is pending or not
 * known to have ended (Token Factory takes a job's cost from the balance as it trains, so a balance read in the
 * console does not show it yet). A state not refreshed by status errs high, which only makes the floor stricter.
 */
function othersUnbilled() {
  const dir = path.dirname(DEFAULT_STATE);
  const stem = path.basename(DEFAULT_STATE, ".json");
  const out = [];
  for (const f of readdirSync(dir)) {
    const file = path.join(dir, f);
    if (file === STATE || !(f === `${stem}.json` || (f.startsWith(`${stem}-`) && f.endsWith(".json")))) continue;
    const o = JSON.parse(readFileSync(file, "utf8"));
    if (o.pending) out.push({ model: o.base_model, usd: o.pending.usd_est, what: "pending" });
    else if (o.job && !["succeeded", "failed", "cancelled"].includes(o.job.status)) out.push({ model: o.base_model, usd: o.job.usd_est, what: o.job.status });
  }
  return out;
}

/** the ledger already holds a charge that settles this reservation */
const settled = (id) => entries().some((e) => e.settles === id);

/**
 * The cost before any spend: billed prompt and answer tokens of the training set (the meta file keeps
 * them, as Token Factory counted them for Nemotron; another tokenizer differs by a few percent, hence
 * the 10% margin) times the epochs times the price.
 */
export function estimate(meta, epochs, usdPerMtok) {
  const tokens = meta.reduce((n, m) => n + m.prompt_tokens + m.answer_tokens, 0);
  const trained = Math.ceil(tokens * epochs * 1.1);
  return { tokens_per_epoch: tokens, trained_tokens_est: trained, usd_est: (trained / 1e6) * usdPerMtok };
}

/** refuse a job whose estimate would take the balance under the floor */
export function checkBudget(balanceUsd, usdEst, floor = FLOOR_USD) {
  if (!(balanceUsd > 0)) throw new Error("--balance-usd: the Token Factory balance, read in the console (Billing); the API cannot read it");
  if (balanceUsd - usdEst < floor) throw new Error(`the estimate US$${usdEst.toFixed(2)} (with the other bases' jobs not billed yet) would leave US$${(balanceUsd - usdEst).toFixed(2)}, under the US$${floor} floor the live demo needs`);
}

/** no SDK retries: a retried create whose first answer was lost could start a second paid job */
function client() {
  process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? path.join(ROOT, ".env.local"));
  if (!process.env.NEBIUS_API_KEY) throw new Error("NEBIUS_API_KEY missing from the env file");
  return new OpenAI({ baseURL: BASE_URL, apiKey: process.env.NEBIUS_API_KEY, timeout: 120_000, maxRetries: 0 });
}

async function main() {
  const manifest = JSON.parse(readFileSync(path.join(DATA, "manifest.json"), "utf8"));
  if (cmd === "upload") {
    await locked(async () => {
      const s = state();
      if (s.job || s.pending) throw new Error("a job is pending or exists: uploading again would orphan it");
      const tf = client();
      for (const name of ["train.jsonl", "val.jsonl"]) {
        const buf = readFileSync(path.join(DATA, name));
        if (sha256(buf) !== manifest.files[name].sha256) throw new Error(`${name} does not match manifest.json: rebuild the dataset`);
        const f = await tf.files.create({ file: await toFile(buf, name), purpose: "fine-tune" });
        s[name] = { id: f.id, sha256: manifest.files[name].sha256, lines: manifest.files[name].lines };
        console.log(`${name}: ${f.id} (${f.bytes} bytes)`);
      }
      save(s);
    });
  } else if (cmd === "create") {
    // creates on every base take one shared lock as well as their own: the floor below counts the other bases'
    // jobs, so two creates must not both count before either has marked its own
    await locked(() => locked(async () => {
      const s = state();
      const dry = args.includes("--dry-run");
      if (!dry && (!s["train.jsonl"] || !s["val.jsonl"])) throw new Error("run upload first");
      for (const name of ["train.jsonl", "val.jsonl"]) {
        if (s[name] && s[name].sha256 !== manifest.files[name].sha256) throw new Error(`the uploaded ${name} is not the one in manifest.json: run upload again`);
      }
      if (s.job) throw new Error(`a job exists already (${s.job.id}): status, or remove it from ${STATE} on purpose`);
      if (s.pending) throw new Error("a create is pending (its answer was lost): run adopt, or release --confirm-no-job once the console shows no job");
      const usdPerMtok = Number(opt("--usd-per-mtok"));
      if (!(usdPerMtok > 0)) throw new Error("--usd-per-mtok: Token Factory's training price per 1M tokens for this model, from the console; it is not published");
      const epochs = Number(opt("--epochs") ?? EPOCHS);
      const meta = readFileSync(path.join(DATA, "train.meta.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const est = estimate(meta, epochs, usdPerMtok);
      // the balance is shared by every base: the other bases' jobs not billed yet count against the floor too
      const others = othersUnbilled();
      if (others.length) console.log(`other jobs not billed yet: ${others.map((o) => `${o.model} ${o.what} US$${o.usd.toFixed(2)}`).join(", ")}`);
      checkBudget(Number(opt("--balance-usd")), est.usd_est + others.reduce((n, o) => n + o.usd, 0));
      const request = { model: BASE_MODEL, training_file: s["train.jsonl"]?.id ?? "<not uploaded>", validation_file: s["val.jsonl"]?.id ?? "<not uploaded>", hyperparameters: { ...HYPER, n_epochs: epochs }, seed: 42, suffix: "understudy-patcher" };
      console.log(JSON.stringify({ ...est, usd_per_mtok: usdPerMtok, request }, null, 2));
      if (dry) return;
      // everything that can fail without spending comes first: the key, the job list
      const tf = client();
      const listed = (await tf.fineTuning.jobs.list({ limit: 100 })).data ?? [];
      // the job list is shared by every checkout and shell using this key: a job on this model that did not fail
      // (queued, running or succeeded) is enough, unless a second training run is meant (--allow-another-job)
      const live = listed.filter((j) => canon(j.model) === canon(BASE_MODEL) && !["failed", "cancelled"].includes(j.status));
      if (live.length && !args.includes("--allow-another-job")) throw new Error(`Token Factory already has a job on ${BASE_MODEL} (${live.map((j) => `${j.id} ${j.status}`).join(", ")}): track that one, or pass --allow-another-job for a second run`);
      const before = listed.map((j) => j.id);
      const reservation = guard(est.usd_est, { script: SCRIPT, capUsd: 100, meta: { model: BASE_MODEL, stage: "fine-tune", ...est } });
      // the mark is on disk before the paid request: a crash or a lost answer leaves it, and it blocks another create
      s.pending = { reservation: reservation.id, training_file: request.training_file, before, usd_per_mtok: usdPerMtok, epochs, ...est, at: new Date().toISOString() };
      save(s);
      let job;
      try {
        job = await tf.fineTuning.jobs.create(request);
      } catch (e) {
        s.pending.error = String(e?.message ?? e).slice(0, 600);
        save(s);
        throw new Error(`create failed (${s.pending.error}); a job may still have started. Check, then run adopt, or release --confirm-no-job`);
      }
      start(s, job);
    }), `${DEFAULT_STATE}.create.lock`);
  } else if (cmd === "adopt") {
    await locked(async () => {
      const s = state();
      if (!s.pending) throw new Error("nothing pending");
      const listed = (await client().fineTuning.jobs.list({ limit: 100 })).data ?? [];
      const mine = listed.filter((j) => !s.pending.before.includes(j.id) && j.training_file === s.pending.training_file && canon(j.model) === canon(BASE_MODEL));
      if (mine.length !== 1) throw new Error(`${mine.length} new jobs on ${s.pending.training_file}: adopt needs exactly one; check the console`);
      start(s, mine[0]);
    });
  } else if (cmd === "release") {
    if (!args.includes("--confirm-no-job")) throw new Error("release gives the reservation back: only with --confirm-no-job, after checking that the console shows no job");
    await locked(async () => {
      const s = state();
      if (!s.pending) throw new Error("nothing pending");
      release({ id: s.pending.reservation });
      delete s.pending;
      save(s);
      console.log("released");
    });
  } else if (cmd === "try-serve") {
    await locked(async () => {
      const s = state();
      if (s.job?.status !== "succeeded") throw new Error("the job has not succeeded");
      const tf = client();
      const last = [...(s.checkpoints ?? [])].sort((a, b) => b.step - a.step)[0];
      if (!last) throw new Error("no checkpoint listed: run status");
      // a served LoRA's price is not published: each tiny call is charged an estimate at ten times the base model's
      // list price (US$0.10 and US$0.30 per 1M), marked as estimated
      const EST = { prompt: 1e-6, completion: 3e-6 };
      const ask = async (model) => {
        const worst = 100 * EST.prompt + 10 * EST.completion;
        const reservation = guard(worst, { script: SCRIPT, capUsd: 100, meta: { model, stage: "try-serve" } });
        try {
          const r = await tf.chat.completions.create({ model, messages: [{ role: "user", content: 'Answer with {"ok":true} only.' }], max_tokens: 10 });
          const u = r.usage ?? { prompt_tokens: 100, completion_tokens: 10 };
          charge(SCRIPT, u.prompt_tokens * EST.prompt + u.completion_tokens * EST.completion, { model, stage: "try-serve", estimated: true, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens }, reservation);
          return { ok: true, model, content: r.choices?.[0]?.message?.content ?? "", usage: r.usage ?? null };
        } catch (e) {
          // a refused model did no work; anything else may have, and costs the estimate
          charge(SCRIPT, e?.status >= 400 && e?.status < 500 ? 0 : worst, { model, stage: "try-serve", failed: true, status: e?.status ?? null }, reservation);
          return { ok: false, model, error: String(e?.message ?? e).slice(0, 300) };
        }
      };
      // an earlier attempt stays on record
      if (s.serve) s.serve_history = [...(s.serve_history ?? []), s.serve];
      s.serve = { checkpoint: last.model, tried_at: new Date().toISOString() };
      // 1. the checkpoint id as a serverless model
      s.serve.checkpoint_id = await ask(last.model);
      // the evidence docs/FINETUNE.md cites: what serverless serves today, and whether this key may list the model
      // artifacts a dedicated endpoint's custom weights come from (free GETs, each with a timeout)
      const evidence = async (route) => {
        try {
          const r = await fetch(`${API_ROOT}${route}`, { headers: auth(), signal: AbortSignal.timeout(30_000) });
          return { status: r.status, body: await r.json().catch(() => null) };
        } catch (e) {
          return { status: null, error: String(e?.message ?? e).slice(0, 200) };
        }
      };
      const models = await evidence("/v1/models");
      s.serve.serverless_models = { status: models.status, ids: Array.isArray(models.body?.data) ? models.body.data.map((m) => m.id) : null };
      const artifacts = await evidence("/v0/model_artifacts");
      s.serve.model_artifacts = { status: artifacts.status, detail: artifacts.body?.detail ? String(JSON.stringify(artifacts.body.detail)).slice(0, 300) : null };
      // 2. the checkpoint registered as a serverless LoRA model: POST /v0/models with the source "<job>:<checkpoint>",
      // then wait for it to turn active (the cookbook's post-training/fine-tuning-1/fine_tune_llama.ipynb, step 9)
      try {
        // every request has a timeout and the wait a deadline: a stalled answer must not hold the lock for ever
        const mk = await fetch(`${API_ROOT}/v0/models`, { method: "POST", signal: AbortSignal.timeout(120_000), headers: { ...auth(), "Content-Type": "application/json" }, body: JSON.stringify({ name: "understudy-patcher", base_model: BASE_MODEL, source: `${s.job.id}:${last.id}`, description: "LoRA of the patch-loop repairs (issue #97)" }) });
        const mkBody = await mk.json().catch(() => ({}));
        s.serve.lora_model = { status: mk.status, name: mkBody.name ?? null, detail: mkBody.detail ? String(JSON.stringify(mkBody.detail)).slice(0, 300) : null };
        // on disk before the wait: whatever happens next, delete-lora knows the name
        save(s);
        if (mk.ok && mkBody.name) {
          let info = {};
          const until = Date.now() + 10 * MINUTE_MS;
          while (Date.now() < until && !["active", "error"].includes(info.status)) {
            await new Promise((r) => setTimeout(r, MINUTE_MS / 12));
            info = await fetch(`${API_ROOT}/v0/models/${encodeURIComponent(mkBody.name)}`, { headers: auth(), signal: AbortSignal.timeout(30_000) })
              .then((r) => r.json())
              .catch(() => ({}));
          }
          s.serve.lora_model.final_status = info.status ?? null;
          if (info.status === "active") s.serve.lora_answer = await ask(mkBody.name);
        }
      } catch (e) {
        s.serve.lora_error = String(e?.message ?? e).slice(0, 300);
      }
      save(s);
      console.log(JSON.stringify(s.serve, null, 2));
    });
  } else if (cmd === "delete-lora") {
    await locked(async () => {
      const s = state();
      const name = s.serve?.lora_model?.name;
      if (!name) throw new Error("try-serve registered no LoRA model");
      client();
      const res = await fetch(`${BASE_URL.replace(/\/v1\/?$/, "")}/v1/models/${encodeURIComponent(name)}`, { method: "DELETE", headers: { Authorization: `Bearer ${process.env.NEBIUS_API_KEY}` } });
      s.serve.lora_deleted = { status: res.status, at: new Date().toISOString() };
      save(s);
      if (!res.ok && res.status !== 404) throw new Error(`delete ${name}: HTTP ${res.status}`);
      console.log(`${name} deleted (HTTP ${res.status})`);
    });
  } else if (cmd === "endpoint-create") {
    // the dedicated-endpoint offer (one H200 in us-central1) was checked for the default base only
    if (BASE_MODEL !== DEFAULT_MODEL) throw new Error(`endpoint-create knows the dedicated-endpoint offer for ${DEFAULT_MODEL} only`);
    await locked(async () => {
      const s = state();
      if (s.endpoint && !s.endpoint.deleted) throw new Error(`endpoint ${s.endpoint.id} exists: endpoint-delete first`);
      if (s.endpoint_pending) throw new Error("an endpoint create is pending (its answer was lost): endpoint-adopt, or endpoint-release --confirm-no-endpoint once the console shows none");
      const weights = opt("--custom-weights-id");
      const minutes = Number(opt("--minutes"));
      const perHour = Number(opt("--usd-per-gpu-hour") ?? 5.6);
      if (!weights) throw new Error("--custom-weights-id: the tuned weights, once Support has switched custom weights on");
      if (!(minutes >= 10 && minutes <= 180)) throw new Error("--minutes: the endpoint's lifetime, 10 to 180; the watchdog deletes it then");
      if (!(perHour > 0)) throw new Error("--usd-per-gpu-hour: the endpoint's price, above 0 (the console says US$5.6 for an H200)");
      client();
      const reservation = guard((minutes / 60) * perHour, { script: SCRIPT, capUsd: 100, meta: { stage: "endpoint", minutes, usd_per_gpu_hour: perHour } });
      const name = `understudy-patcher-eval-${Date.now()}`;
      // the mark is on disk before the paid request, as for the job: a lost answer blocks another endpoint
      s.endpoint_pending = { name, reservation: reservation.id, minutes, usd_per_gpu_hour: perHour, at: new Date().toISOString() };
      save(s);
      const body = { name, model_name: BASE_MODEL, flavor_name: "base", gpu_type: "gpu-h200-sxm", region: "us-central1", gpu_count: 1, custom_weights_id: weights, scaling: { min_replicas: 1, max_replicas: 1 } };
      const res = await fetch(`${API_ROOT}/v0/dedicated_endpoints`, { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch((e) => ({ ok: false, status: String(e), text: async () => "" }));
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        // only a refusal (4xx) proves nothing was created; anything else stays pending for a person to settle
        if (typeof res.status === "number" && res.status >= 400 && res.status < 500) {
          release(reservation);
          delete s.endpoint_pending;
          save(s);
          throw new Error(`endpoint create refused (HTTP ${res.status}: ${detail})`);
        }
        s.endpoint_pending.error = `${res.status} ${detail}`.slice(0, 300);
        save(s);
        throw new Error(`endpoint create failed (${res.status}); one may still have started: endpoint-adopt, or endpoint-release --confirm-no-endpoint`);
      }
      await startEndpoint(s, (await res.json()).endpoint);
    });
  } else if (cmd === "endpoint-adopt") {
    await locked(async () => {
      const s = state();
      if (!s.endpoint_pending) throw new Error("no endpoint create pending");
      client();
      const listed = (await (await fetch(`${API_ROOT}/v0/dedicated_endpoints`, { headers: auth() })).json()).data ?? [];
      const ep = listed.find((e) => e.name === s.endpoint_pending.name);
      if (!ep) throw new Error(`no endpoint named ${s.endpoint_pending.name}: check the console`);
      await startEndpoint(s, ep);
    });
  } else if (cmd === "endpoint-release") {
    if (!args.includes("--confirm-no-endpoint")) throw new Error("endpoint-release gives the reservation back: only with --confirm-no-endpoint, after checking the console shows no endpoint");
    await locked(async () => {
      const s = state();
      if (!s.endpoint_pending) throw new Error("no endpoint create pending");
      release({ id: s.endpoint_pending.reservation });
      delete s.endpoint_pending;
      save(s);
      console.log("released");
    });
  } else if (cmd === "endpoint-watchdog") {
    // everything it needs comes in its arguments: it acts on its own endpoint only, whatever the state file says later
    const [id, reservation, created, deadline, perHour] = args.slice(1);
    while (Date.now() < Number(deadline)) {
      if (ownerGone()) return ownerGoneNote();
      await new Promise((r) => setTimeout(r, Math.min(OWNER ? 250 : 20_000, Math.max(50, Number(deadline) - Date.now()))));
    }
    if (ownerGone()) return ownerGoneNote();
    // deleted by hand already: nothing to do (the state still names it, marked deleted, and its charge is settled);
    // a state it cannot read is no reason to skip the delete
    let now = null;
    try {
      now = state();
    } catch {
      now = null;
    }
    if (now?.endpoint?.id === id && now.endpoint.deleted && settled(reservation)) return console.log(`${new Date().toISOString()} endpoint ${id} was deleted by hand; the watchdog stops`);
    client();
    if (!(await deleteEndpoint(id))) {
      process.exitCode = 1;
      return;
    }
    await settleEndpoint({ id, reservation, created: Number(created), usd_per_gpu_hour: Number(perHour) });
  } else if (cmd === "endpoint-delete") {
    const s = state();
    if (!s.endpoint || s.endpoint.deleted) return console.log("no live endpoint");
    client();
    if (!(await deleteEndpoint(s.endpoint.id))) throw new Error(`could not delete endpoint ${s.endpoint.id}: delete it in the console`);
    await settleEndpoint(s.endpoint);
  } else if (cmd === "status") {
    const s = state();
    if (!s.job) throw new Error(s.pending ? "a create is pending: adopt or release first" : "no job yet");
    const tf = client();
    const job = await tf.fineTuning.jobs.retrieve(s.job.id);
    const checkpoints = ((await tf.fineTuning.jobs.checkpoints.list(job.id)).data ?? []).map((c) => ({ id: c.id, step: c.step_number, model: c.fine_tuned_model_checkpoint, metrics: c.metrics }));
    // the job's own events (submitted, datasets processed, training started and completed), kept as the record
    const events = ((await tf.fineTuning.jobs.listEvents(job.id, { limit: 100 }).catch(() => ({ data: [] }))).data ?? []).map((e) => ({ at: new Date(e.created_at * 1000).toISOString(), level: e.level, message: e.message }));
    // re-read under the lock: what other commands wrote meanwhile (an endpoint, try-serve) stays
    const now = await lockedWait(async () => {
      const cur = state();
      Object.assign(cur.job, { status: job.status, trained_tokens: job.trained_tokens ?? null, trained_steps: job.trained_steps ?? null, total_steps: job.total_steps ?? null, estimated_finish: job.estimated_finish ?? null, finished_at: job.finished_at ?? null, error: job.error ?? null });
      cur.checkpoints = checkpoints;
      if (events.length) cur.events = events.sort((a, b) => a.at.localeCompare(b.at));
      if (["succeeded", "failed", "cancelled"].includes(job.status)) {
        // the estimate was charged at the start; what the job trained beyond it is charged once, under its own id
        const usd = ((job.trained_tokens ?? 0) / 1e6) * cur.job.usd_per_mtok;
        cur.job.usd_actual = usd;
        const over = usd - cur.job.usd_est;
        const adjustment = `adjust-${job.id}`;
        if (over > 0 && !settled(adjustment)) charge(SCRIPT, over, { model: BASE_MODEL, stage: "fine-tune", job: job.id, adjustment: true, trained_tokens: job.trained_tokens, keep: true }, { id: adjustment });
      }
      save(cur);
      return cur;
    });
    console.log(JSON.stringify({ job: now.job, checkpoints: now.checkpoints.map((c) => ({ step: c.step, model: c.model, ...c.metrics })) }, null, 2));
  } else {
    console.log("usage: node scripts/finetune-tf.mjs <command> [--model M], the command one of: upload | create --usd-per-mtok P --balance-usd B [--epochs N] [--dry-run] [--allow-another-job] | adopt | release --confirm-no-job | status | try-serve | delete-lora | endpoint-create --custom-weights-id W --minutes M | endpoint-delete | endpoint-adopt | endpoint-release --confirm-no-endpoint");
    process.exitCode = 1;
  }
}

const API_ROOT = BASE_URL.replace(/\/v1\/?$/, "");
const auth = () => ({ Authorization: `Bearer ${process.env.NEBIUS_API_KEY}` });

/** an endpoint exists: record it, start its watchdog, or delete it at once if the watchdog cannot start */
async function startEndpoint(s, ep) {
  const p = s.endpoint_pending;
  // its clock starts when it was asked for, not when it is adopted: an adopted endpoint past its lifetime goes at once
  const created = Date.parse(p.at);
  s.endpoint = { id: ep.id, name: p.name, routing_key: ep.routing_key, created, deadline: created + p.minutes * MINUTE_MS, usd_per_gpu_hour: p.usd_per_gpu_hour, reservation: p.reservation };
  delete s.endpoint_pending;
  save(s);
  let child = null;
  try {
    let out = "ignore";
    try {
      out = openSync(WATCHDOG_LOG, "a");
    } catch {
      // no log is no reason to leave an endpoint without its watchdog
    }
    const argv = [fileURLToPath(import.meta.url), "endpoint-watchdog", ep.id, p.reservation, String(created), String(s.endpoint.deadline), String(p.usd_per_gpu_hour)];
    // absolute paths: a PATH without /usr/bin must not leave a paid endpoint without its watchdog
    const awake = process.platform === "darwin" && existsSync("/usr/bin/caffeinate");
    child = awake ? spawn("/usr/bin/caffeinate", ["-i", process.execPath, ...argv], { detached: true, stdio: ["ignore", out, out], env: process.env }) : spawn(process.execPath, argv, { detached: true, stdio: ["ignore", out, out], env: process.env });
    const started = await new Promise((r) => {
      child.once("spawn", () => r(true));
      child.once("error", () => r(false));
    });
    if (!started) child = null;
  } catch {
    child = null;
  }
  if (!child) {
    if (!(await deleteEndpoint(ep.id))) throw new Error(`the watchdog could not start and endpoint ${ep.id} could not be deleted: delete it in the console now (its reservation stays open)`);
    await settleEndpoint(s.endpoint, true);
    throw new Error(`the watchdog could not start, so endpoint ${ep.id} was deleted at once`);
  }
  child.unref();
  // its process group (detached: the watchdog and, on a Mac, caffeinate): what to stop if it must be stopped by hand
  s.endpoint.watchdog_pid = child.pid;
  save(s);
  console.log(`endpoint ${ep.id}, routing key ${ep.routing_key}; the watchdog (process group ${child.pid}) deletes it at ${new Date(s.endpoint.deadline).toISOString()}`);
}

/**
 * Delete an endpoint, retrying every 30 s until Token Factory says it is gone (true), or until the deletes have
 * failed for 6 hours (false: an outage that long needs a person, so the watchdog stops instead of retrying
 * for ever, and says so; the endpoint's reservation then stays open on the ledger).
 */
const GIVE_UP_MINUTES = 360;
async function deleteEndpoint(id) {
  const until = Date.now() + GIVE_UP_MINUTES * MINUTE_MS;
  for (;;) {
    const res = await fetch(`${API_ROOT}/v0/dedicated_endpoints/${id}`, { method: "DELETE", headers: auth() }).catch((e) => ({ ok: false, status: String(e) }));
    if (res.ok || res.status === 404) return true;
    if (Date.now() > until) {
      console.log(`${new Date().toISOString()} GAVE UP deleting endpoint ${id} after ${GIVE_UP_MINUTES} minutes of failures (last: ${res.status}): delete it by hand in the console`);
      return false;
    }
    if (ownerGone()) {
      ownerGoneNote();
      return false;
    }
    // 30 s, in the scaled minute the tests use: the line states the real wait
    const wait = (30 * MINUTE_MS) / 60;
    console.log(`${new Date().toISOString()} delete ${id}: HTTP ${res.status}, retrying in ${Number((wait / 1000).toFixed(3))} s`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** charge an endpoint's hours once (its own reservation), and mark it deleted if the state still names it */
async function settleEndpoint(ep, lockHeld = false) {
  const work = async () => {
    const hours = (Date.now() - ep.created) / 3.6e6 / (MINUTE_MS / 60_000);
    const usd = hours * ep.usd_per_gpu_hour;
    if (!settled(ep.reservation)) charge(SCRIPT, usd, { stage: "endpoint", endpoint: ep.id, hours: Number(hours.toFixed(3)), usd_per_gpu_hour: ep.usd_per_gpu_hour }, { id: ep.reservation });
    const now = state();
    if (now.endpoint?.id === ep.id && !now.endpoint.deleted) {
      Object.assign(now.endpoint, { deleted: new Date().toISOString(), hours, usd });
      save(now);
    }
    console.log(`${new Date().toISOString()} endpoint ${ep.id} deleted after ${hours.toFixed(2)} h, US$${usd.toFixed(2)}`);
  };
  return lockHeld ? work() : lockedWait(work);
}

/** a job has started: record it, charge the estimate (settles the reservation), clear the pending mark */
function start(s, job) {
  const p = s.pending;
  if (!settled(p.reservation)) charge(SCRIPT, p.usd_est, { model: BASE_MODEL, stage: "fine-tune", job: job.id, estimated: true }, { id: p.reservation });
  s.job = { id: job.id, created_at: job.created_at, status: job.status, usd_per_mtok: p.usd_per_mtok, epochs: p.epochs, reservation: p.reservation, tokens_per_epoch: p.tokens_per_epoch, trained_tokens_est: p.trained_tokens_est, usd_est: p.usd_est };
  delete s.pending;
  save(s);
  console.log(`job ${job.id}: ${job.status}; US$${p.usd_est.toFixed(2)} charged on the ledger as its estimate`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
