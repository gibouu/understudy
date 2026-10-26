// A LoRA fine-tune on Nebius Token Factory itself (issue #97), on the repair dataset in bench/finetune/.
// Token Factory fine-tunes no NVIDIA model, so the base is a model on its list (docs/FINETUNE.md says
// which and why). Every step that can cost money asks for the numbers it needs and refuses without them:
// Token Factory publishes no fine-tuning price and the API key cannot read the balance.
//
//   node scripts/finetune-tf.mjs upload                       checks the files against manifest.json, uploads them
//   node scripts/finetune-tf.mjs create --usd-per-mtok P --balance-usd B [--epochs 3] [--dry-run]
//        estimates the cost (training tokens x epochs x P), refuses when B minus it would fall under
//        US$15 (the live demo's floor), reserves it on the bench ledger, creates the job
//   node scripts/finetune-tf.mjs status                       the job's state, steps, losses, checkpoints;
//        once it succeeds, charges the ledger for its trained tokens at P and keeps the last checkpoint
//
// State (file ids, job id, price, checkpoints, losses; no key) is kept in bench/results/finetune-tf.json.
// The key comes from UNDERSTUDY_ENV_FILE (default .env.local), as in every bench script.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI, { toFile } from "openai";
import { charge, guard } from "./bench-ledger.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = path.join(ROOT, "bench/results/finetune-tf.json");
const DATA = path.join(ROOT, "bench/finetune");
const SCRIPT = "finetune-tf";
export const BASE_MODEL = "Qwen/Qwen3-30B-A3B-Instruct-2507";
export const FLOOR_USD = 15;
/** LoRA settings: rank 16 and alpha 32 as on the AI Cloud route; a LoRA learning rate, not the full-tune default 1e-5 */
export const HYPER = { lora: true, lora_r: 16, lora_alpha: 32, lora_dropout: 0.05, learning_rate: 1e-4, batch_size: 8, warmup_ratio: 0.05, context_length: 8192, packing: true };

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

function client() {
  process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? path.join(ROOT, ".env.local"));
  if (!process.env.NEBIUS_API_KEY) throw new Error("NEBIUS_API_KEY missing from the env file");
  return new OpenAI({ baseURL: "https://api.tokenfactory.nebius.com/v1/", apiKey: process.env.NEBIUS_API_KEY, timeout: 120_000 });
}

async function main() {
  const manifest = JSON.parse(readFileSync(path.join(DATA, "manifest.json"), "utf8"));
  if (cmd === "upload") {
    const s = state();
    const tf = client();
    for (const name of ["train.jsonl", "val.jsonl"]) {
      const buf = readFileSync(path.join(DATA, name));
      if (sha256(buf) !== manifest.files[name].sha256) throw new Error(`${name} does not match manifest.json: rebuild the dataset`);
      const f = await tf.files.create({ file: await toFile(buf, name), purpose: "fine-tune" });
      s[name] = { id: f.id, sha256: manifest.files[name].sha256, lines: manifest.files[name].lines };
      console.log(`${name}: ${f.id} (${f.bytes} bytes)`);
    }
    save(s);
  } else if (cmd === "create") {
    const s = state();
    const dry = args.includes("--dry-run");
    if (!dry && (!s["train.jsonl"] || !s["val.jsonl"])) throw new Error("run upload first");
    if (s.job) throw new Error(`a job exists already (${s.job.id}): status, or remove it from ${STATE} on purpose`);
    const usdPerMtok = Number(opt("--usd-per-mtok"));
    if (!(usdPerMtok > 0)) throw new Error("--usd-per-mtok: Token Factory's training price per 1M tokens for this model, from the console; it is not published");
    const epochs = Number(opt("--epochs") ?? 3);
    const meta = readFileSync(path.join(DATA, "train.meta.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const est = estimate(meta, epochs, usdPerMtok);
    checkBudget(Number(opt("--balance-usd")), est.usd_est);
    const request = { model: BASE_MODEL, training_file: s["train.jsonl"]?.id ?? "<not uploaded>", validation_file: s["val.jsonl"]?.id ?? "<not uploaded>", hyperparameters: { ...HYPER, n_epochs: epochs }, seed: 42, suffix: "understudy-patcher" };
    console.log(JSON.stringify({ ...est, usd_per_mtok: usdPerMtok, request }, null, 2));
    if (dry) return;
    const reservation = guard(est.usd_est, { script: SCRIPT, capUsd: 100, meta: { model: BASE_MODEL, stage: "fine-tune", ...est } });
    let job;
    try {
      job = await client().fineTuning.jobs.create(request);
    } catch (e) {
      // nothing was trained: give the reservation back at no cost
      charge(SCRIPT, 0, { model: BASE_MODEL, stage: "fine-tune", failed: true, status: e?.status ?? null }, reservation);
      throw e;
    }
    s.job = { id: job.id, created_at: job.created_at, status: job.status, usd_per_mtok: usdPerMtok, epochs, reservation: reservation.id, ...est };
    save(s);
    console.log(`job ${job.id}: ${job.status}`);
  } else if (cmd === "status") {
    const s = state();
    if (!s.job) throw new Error("no job yet");
    const tf = client();
    const job = await tf.fineTuning.jobs.retrieve(s.job.id);
    Object.assign(s.job, { status: job.status, trained_tokens: job.trained_tokens ?? null, trained_steps: job.trained_steps ?? null, total_steps: job.total_steps ?? null, estimated_finish: job.estimated_finish ?? null, finished_at: job.finished_at ?? null, error: job.error ?? null });
    const checkpoints = (await tf.fineTuning.jobs.checkpoints.list(job.id)).data ?? [];
    s.checkpoints = checkpoints.map((c) => ({ id: c.id, step: c.step_number, model: c.fine_tuned_model_checkpoint, metrics: c.metrics }));
    if (["succeeded", "failed", "cancelled"].includes(job.status) && !s.job.charged) {
      // settle the reservation: trained tokens at the price given (0 for a job that trained nothing)
      const usd = ((job.trained_tokens ?? 0) / 1e6) * s.job.usd_per_mtok;
      charge(SCRIPT, usd, { model: BASE_MODEL, stage: "fine-tune", job: job.id, status: job.status, trained_tokens: job.trained_tokens ?? 0, usd_per_mtok: s.job.usd_per_mtok }, { id: s.job.reservation, script: SCRIPT, usd: s.job.usd_est });
      s.job.charged = usd;
    }
    save(s);
    console.log(JSON.stringify({ job: s.job, checkpoints: s.checkpoints.map((c) => ({ step: c.step, model: c.model, ...c.metrics })) }, null, 2));
  } else {
    console.log("usage: node scripts/finetune-tf.mjs upload | create --usd-per-mtok P --balance-usd B [--epochs N] [--dry-run] | status");
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
