/**
 * scripts/finetune-tf.mjs against a local stand-in for Token Factory's files and fine-tuning API: the
 * guards that keep a paid job from being started twice, charged twice, charged at zero by mistake, or
 * trained on data that is not the manifest's. No network, no spend.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
type Job = { id: string; object: string; model: string; training_file: string; created_at: number; status: string; trained_tokens: number | null };

describe("Token Factory fine-tune job script (local stand-in)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "finetune-tf-"));
  const env = { ...process.env, UNDERSTUDY_ENV_FILE: path.join(dir, "env"), BENCH_LEDGER_PATH: path.join(dir, "ledger.jsonl"), FINETUNE_TF_STATE: path.join(dir, "state.json"), FINETUNE_TF_BASE_URL: "" };
  const jobs: Job[] = [];
  let failCreate: "no" | "lost-answer" | "rejected" = "no";
  let server: http.Server;

  beforeAll(async () => {
    writeFileSync(env.UNDERSTUDY_ENV_FILE, "NEBIUS_API_KEY=test-key-not-real-0000\n");
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const send = (code: number, o: unknown) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(o));
        };
        const url = req.url ?? "";
        if (req.method === "POST" && url.endsWith("/files")) return send(200, { id: `file-${body.includes("val.jsonl") ? "val" : "train"}`, object: "file", bytes: body.length, created_at: 1, filename: "x", purpose: "fine-tune" });
        if (req.method === "POST" && url.endsWith("/fine_tuning/jobs")) {
          const r = JSON.parse(body);
          if (failCreate === "rejected") return send(500, { error: { message: "boom" } });
          const job: Job = { id: `ftjob-${jobs.length + 1}`, object: "fine_tuning.job", model: r.model, training_file: r.training_file, created_at: Math.floor(Date.now() / 1000), status: "queued", trained_tokens: null };
          jobs.push(job);
          return failCreate === "lost-answer" ? send(502, { error: { message: "gateway" } }) : send(200, job);
        }
        if (req.method === "GET" && /\/fine_tuning\/jobs\?/.test(url)) return send(200, { object: "list", data: [...jobs].reverse(), has_more: false });
        const m = /\/fine_tuning\/jobs\/([^/?]+)(\/checkpoints)?/.exec(url);
        if (req.method === "GET" && m) {
          const job = jobs.find((j) => j.id === m[1]);
          if (!job) return send(404, { error: { message: "no job" } });
          return m[2] ? send(200, { object: "list", data: [{ id: "ckpt-1", step_number: 330, fine_tuned_model_checkpoint: `ft:${job.model}:ckpt-step-330`, metrics: { valid_loss: 0.2 } }], has_more: false }) : send(200, job);
        }
        send(404, { error: { message: url } });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    env.FINETUNE_TF_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
  });
  afterAll(() => server.close());

  const tf = (...args: string[]) => run("node", ["scripts/finetune-tf.mjs", ...args], { env, cwd: process.cwd() });
  const fails = async (...args: string[]) => {
    try {
      await tf(...args);
    } catch (e) {
      return String((e as { stderr?: string }).stderr);
    }
    throw new Error(`expected finetune-tf ${args.join(" ")} to fail`);
  };
  const ledger = () => (existsSync(env.BENCH_LEDGER_PATH) ? readFileSync(env.BENCH_LEDGER_PATH, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const state = () => JSON.parse(readFileSync(env.FINETUNE_TF_STATE, "utf8"));

  it("refuses without a price or a balance, and under the US$15 floor", async () => {
    expect(await fails("create", "--balance-usd", "60", "--dry-run")).toMatch(/--usd-per-mtok/);
    expect(await fails("create", "--usd-per-mtok", "5", "--dry-run")).toMatch(/--balance-usd/);
    expect(await fails("create", "--usd-per-mtok", "5", "--balance-usd", "25", "--dry-run")).toMatch(/under the US\$15 floor/);
    expect(ledger()).toEqual([]);
  }, 60_000);

  it("starts one job, charges its estimate at once, refuses a second, and adjusts once", async () => {
    await tf("upload");
    expect(state()["train.jsonl"].id).toBe("file-train");
    await tf("create", "--usd-per-mtok", "5", "--balance-usd", "60");
    const s = state();
    expect(s.job.id).toBe("ftjob-1");
    expect(s.pending).toBeUndefined();
    // the estimate is charged and settles the reservation: nothing is left open for --settle-stale
    const estimateCharge = ledger().filter((e) => !e.type && e.settles === s.job.reservation);
    expect(estimateCharge).toHaveLength(1);
    expect(estimateCharge[0].usd).toBeCloseTo(s.job.usd_est, 6);
    expect(await fails("create", "--usd-per-mtok", "5", "--balance-usd", "60")).toMatch(/a job exists already/);
    expect(await fails("upload")).toMatch(/pending or exists/);
    expect(jobs).toHaveLength(1);
    // a lock held by another shell stops create
    writeFileSync(`${env.FINETUNE_TF_STATE}.lock`, "123\n");
    expect(await fails("create", "--usd-per-mtok", "5", "--balance-usd", "60")).toMatch(/another finetune-tf command is running/);
    unlinkSync(`${env.FINETUNE_TF_STATE}.lock`);
    // the job trained more than estimated: the difference is charged once, however often status runs
    jobs[0].status = "succeeded";
    jobs[0].trained_tokens = 6_000_000;
    await tf("status");
    await tf("status");
    const adjustments = ledger().filter((e) => !e.type && e.settles === "adjust-ftjob-1");
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].usd).toBeCloseTo(30 - s.job.usd_est, 6);
    expect(state().job.usd_actual).toBe(30);
    expect(state().checkpoints[0].model).toMatch(/^ft:Qwen\/Qwen3-30B-A3B-Instruct-2507:/);
  }, 60_000);

  it("after a lost answer, blocks another create until adopt or release", async () => {
    unlinkSync(env.FINETUNE_TF_STATE);
    await tf("upload");
    failCreate = "lost-answer";
    expect(await fails("create", "--usd-per-mtok", "5", "--balance-usd", "60")).toMatch(/adopt, or release --confirm-no-job/);
    expect(state().pending).toBeDefined();
    failCreate = "no";
    const before = jobs.length;
    expect(await fails("create", "--usd-per-mtok", "5", "--balance-usd", "60")).toMatch(/a create is pending/);
    expect(jobs).toHaveLength(before);
    await tf("adopt");
    expect(state().job.id).toBe(`ftjob-${before}`);
    expect(state().pending).toBeUndefined();
    // a create that started nothing: released only on explicit confirmation
    unlinkSync(env.FINETUNE_TF_STATE);
    await tf("upload");
    failCreate = "rejected";
    expect(await fails("create", "--usd-per-mtok", "5", "--balance-usd", "60")).toMatch(/adopt, or release/);
    expect(jobs).toHaveLength(before);
    expect(await fails("adopt")).toMatch(/0 new jobs/);
    expect(await fails("release")).toMatch(/--confirm-no-job/);
    const reservation = state().pending.reservation;
    await tf("release", "--confirm-no-job");
    expect(ledger().some((e) => e.type === "release" && e.id === reservation)).toBe(true);
    expect(state().pending).toBeUndefined();
    failCreate = "no";
  }, 60_000);

  it("refuses an upload that is not the manifest's", async () => {
    unlinkSync(env.FINETUNE_TF_STATE);
    await tf("upload");
    const s = state();
    s["train.jsonl"].sha256 = "0".repeat(64);
    writeFileSync(env.FINETUNE_TF_STATE, JSON.stringify(s));
    expect(await fails("create", "--usd-per-mtok", "5", "--balance-usd", "60")).toMatch(/run upload again/);
  }, 60_000);
});
