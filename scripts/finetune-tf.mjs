// A LoRA fine-tune on Nebius Token Factory itself (issue #97), on the repair dataset in bench/finetune/.
// Token Factory fine-tunes no NVIDIA model, so the base is a model on its list (docs/FINETUNE.md says
// which and why). Every step that can cost money asks for the numbers it needs and refuses without them:
// Token Factory publishes no fine-tuning price and the API key cannot read the balance.
//
//   node scripts/finetune-tf.mjs upload                       checks the files against manifest.json, uploads them
//   node scripts/finetune-tf.mjs create --usd-per-mtok P --balance-usd B [--epochs 3] [--dry-run]
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
//        the adapter registered as a LoRA model through /v0/models, the route of Token Factory's cookbook
//        AddLora.ipynb) and keeps what each one said
//
// A create that fails leaves the job "pending": no other create runs until adopt or release says what
// happened, so a lost answer can never lead to a second paid job, and nothing is released by guesswork.
// State (file ids, job id, price, checkpoints, losses; no key) is kept in bench/results/finetune-tf.json.
// The key comes from UNDERSTUDY_ENV_FILE (default .env.local), as in every bench script.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import OpenAI, { toFile } from "openai";
import { charge, entries, guard, release } from "./bench-ledger.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// overridable for the tests only (tests/providers/finetune-tf.test.ts runs this script against a local mock)
const STATE = process.env.FINETUNE_TF_STATE ?? path.join(ROOT, "bench/results/finetune-tf.json");
const BASE_URL = process.env.FINETUNE_TF_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1/";
const DATA = path.join(ROOT, "bench/finetune");
const SCRIPT = "finetune-tf";
export const BASE_MODEL = "Qwen/Qwen3-30B-A3B-Instruct-2507";
export const FLOOR_USD = 15;
/**
 * LoRA settings: rank 16 and alpha 32 as on the AI Cloud route. Token Factory wants at least 131,072 tokens
 * a batch (batch size x context length; a 422 said so), so at the shortest context, 8,192, the batch is
 * 16 packed sequences: about 7 steps an epoch for our 0.9M tokens. Hence 5 epochs (about 35 steps) and a
 * LoRA learning rate of 2e-4, not the full-tune default 1e-5.
 */
export const HYPER = { lora: true, lora_r: 16, lora_alpha: 32, lora_dropout: 0.05, learning_rate: 2e-4, batch_size: 16, warmup_ratio: 0.05, context_length: 8192, packing: true };
export const EPOCHS = 5;

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const state = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { base_model: BASE_MODEL });
const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * One create or settle at a time: an exclusive lock file next to the state, so two shells cannot both
 * pass the "no job yet" check and pay twice, or settle the same job twice.
 */
async function locked(fn) {
  const lock = `${STATE}.lock`;
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
  if (balanceUsd - usdEst < floor) throw new Error(`the estimate US$${usdEst.toFixed(2)} would leave US$${(balanceUsd - usdEst).toFixed(2)}, under the US$${floor} floor the live demo needs`);
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
    await locked(async () => {
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
      checkBudget(Number(opt("--balance-usd")), est.usd_est);
      const request = { model: BASE_MODEL, training_file: s["train.jsonl"]?.id ?? "<not uploaded>", validation_file: s["val.jsonl"]?.id ?? "<not uploaded>", hyperparameters: { ...HYPER, n_epochs: epochs }, seed: 42, suffix: "understudy-patcher" };
      console.log(JSON.stringify({ ...est, usd_per_mtok: usdPerMtok, request }, null, 2));
      if (dry) return;
      // everything that can fail without spending comes first: the key, the job list
      const tf = client();
      const before = [...new Set(((await tf.fineTuning.jobs.list({ limit: 100 })).data ?? []).map((j) => j.id))];
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
    });
  } else if (cmd === "adopt") {
    await locked(async () => {
      const s = state();
      if (!s.pending) throw new Error("nothing pending");
      const listed = (await client().fineTuning.jobs.list({ limit: 100 })).data ?? [];
      const mine = listed.filter((j) => !s.pending.before.includes(j.id) && j.training_file === s.pending.training_file);
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
    const s = state();
    if (s.job?.status !== "succeeded") throw new Error("the job has not succeeded");
    const tf = client();
    const last = [...(s.checkpoints ?? [])].sort((a, b) => b.step - a.step)[0];
    if (!last) throw new Error("no checkpoint listed: run status");
    const ask = async (model) => {
      try {
        const r = await tf.chat.completions.create({ model, messages: [{ role: "user", content: 'Answer with {"ok":true} only.' }], max_tokens: 10 });
        return { ok: true, model, content: r.choices?.[0]?.message?.content ?? "", usage: r.usage ?? null };
      } catch (e) {
        return { ok: false, model, error: String(e?.message ?? e).slice(0, 300) };
      }
    };
    s.serve = { checkpoint: last.model, tried_at: new Date().toISOString() };
    // 1. the checkpoint id as a serverless model
    s.serve.checkpoint_id = await ask(last.model);
    // 2. the adapter as a LoRA model: download the checkpoint's files, zip them, upload, register
    try {
      const files = {};
      for (const id of (await tf.fineTuning.jobs.checkpoints.list(s.job.id)).data.find((c) => c.id === last.id)?.result_files ?? []) {
        const meta = await tf.files.retrieve(id);
        files[path.basename(meta.filename)] = new Uint8Array(await (await tf.files.content(id)).arrayBuffer());
      }
      if (!files["adapter_config.json"]) throw new Error(`no adapter_config.json among ${Object.keys(files).join(", ")}`);
      const zip = zipSync(files);
      const form = new FormData();
      form.append("file", new Blob([zip]), "adapter.zip");
      const auth = { Authorization: `Bearer ${process.env.NEBIUS_API_KEY}` };
      const root = BASE_URL.replace(/\/v1\/?$/, "");
      const up = await fetch(`${root}/v0/models/upload`, { method: "POST", headers: auth, body: form });
      const upBody = await up.json().catch(() => ({}));
      s.serve.lora_upload = { status: up.status, id: upBody.id ?? null, detail: upBody.detail ? String(JSON.stringify(upBody.detail)).slice(0, 300) : null };
      if (up.ok && upBody.id) {
        const mk = await fetch(`${root}/v0/models`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ source: upBody.id, base_model: BASE_MODEL, name: "understudy-patcher", description: "LoRA of the patch-loop repairs (issue #97)" }) });
        const mkBody = await mk.json().catch(() => ({}));
        s.serve.lora_model = { status: mk.status, name: mkBody.name ?? null, detail: mkBody.detail ? String(JSON.stringify(mkBody.detail)).slice(0, 300) : null };
        if (mk.ok && mkBody.name) s.serve.lora_answer = await ask(mkBody.name);
      }
    } catch (e) {
      s.serve.lora_error = String(e?.message ?? e).slice(0, 300);
    }
    save(s);
    console.log(JSON.stringify(s.serve, null, 2));
  } else if (cmd === "status") {
    const s = state();
    if (!s.job) throw new Error(s.pending ? "a create is pending: adopt or release first" : "no job yet");
    const tf = client();
    const job = await tf.fineTuning.jobs.retrieve(s.job.id);
    Object.assign(s.job, { status: job.status, trained_tokens: job.trained_tokens ?? null, trained_steps: job.trained_steps ?? null, total_steps: job.total_steps ?? null, estimated_finish: job.estimated_finish ?? null, finished_at: job.finished_at ?? null, error: job.error ?? null });
    const checkpoints = (await tf.fineTuning.jobs.checkpoints.list(job.id)).data ?? [];
    s.checkpoints = checkpoints.map((c) => ({ id: c.id, step: c.step_number, model: c.fine_tuned_model_checkpoint, metrics: c.metrics }));
    await locked(async () => {
      if (["succeeded", "failed", "cancelled"].includes(job.status)) {
        // the estimate was charged at the start; what the job trained beyond it is charged once, under its own id
        const usd = ((job.trained_tokens ?? 0) / 1e6) * s.job.usd_per_mtok;
        s.job.usd_actual = usd;
        const over = usd - s.job.usd_est;
        const adjustment = `adjust-${job.id}`;
        if (over > 0 && !settled(adjustment)) charge(SCRIPT, over, { model: BASE_MODEL, stage: "fine-tune", job: job.id, adjustment: true, trained_tokens: job.trained_tokens, keep: true }, { id: adjustment });
      }
      save(s);
    });
    console.log(JSON.stringify({ job: s.job, checkpoints: s.checkpoints.map((c) => ({ step: c.step, model: c.model, ...c.metrics })) }, null, 2));
  } else {
    console.log("usage: node scripts/finetune-tf.mjs upload | create --usd-per-mtok P --balance-usd B [--epochs N] [--dry-run] | adopt | release --confirm-no-job | status");
    process.exitCode = 1;
  }
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
