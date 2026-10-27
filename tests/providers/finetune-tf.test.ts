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
  const served: string[] = [];
  const registered: { name: string; base_model: string; source: string }[] = [];
  let loraGone = false;
  const endpoints: { id: string; name: string; routing_key: string; custom_weights_id: string }[] = [];
  let refuseDeletes = 0;
  let endpointCount = 0;
  let failEndpoint: "no" | "lost" | "refused" = "no";
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
        served.push(`${req.method} ${url.replace(/\?.*/, "")}`);
        // the routes try-serve and delete-lora use
        if (req.method === "POST" && url.endsWith("/chat/completions")) {
          const r = JSON.parse(body);
          if (String(r.model).startsWith("ft:")) return send(404, { error: { message: "model not found" } });
          return send(200, { id: "c", object: "chat.completion", created: 0, model: r.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"ok":true}' } }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
        }
        if (req.method === "POST" && url.endsWith("/v0/models")) {
          const r = JSON.parse(body);
          registered.push(r);
          // what Token Factory answered on 27 October; the other branch is the cookbook's documented answer
          if (loraGone) return send(410, { detail: "LoRA adapter deployment is no longer available" });
          return send(200, { name: `${r.name}-ab12`, status: "validating" });
        }
        if (req.method === "GET" && /\/v0\/models\/[^/]+$/.test(url)) return send(200, { name: url.split("/").at(-1), status: "active" });
        if (req.method === "DELETE" && /\/v1\/models\//.test(url)) return send(200, { deleted: true });
        // dedicated endpoints
        if (req.method === "GET" && url.endsWith("/v0/dedicated_endpoints")) return send(200, { object: "list", data: endpoints });
        if (req.method === "POST" && url.endsWith("/v0/dedicated_endpoints")) {
          const r = JSON.parse(body);
          if (failEndpoint === "refused") return send(422, { detail: "custom weights not enabled" });
          const ep = { id: `ep-${++endpointCount}`, name: r.name, routing_key: `dedicated/qwen-${endpointCount}`, custom_weights_id: r.custom_weights_id };
          endpoints.push(ep);
          return failEndpoint === "lost" ? send(502, { detail: "gateway" }) : send(201, { endpoint: ep });
        }
        if (req.method === "DELETE" && /\/v0\/dedicated_endpoints\//.test(url)) {
          const id = url.split("/").at(-1);
          const i = endpoints.findIndex((e) => e.id === id);
          if (i < 0) return send(404, { detail: "not found" });
          if (refuseDeletes-- > 0) return send(503, { detail: "busy" });
          endpoints.splice(i, 1);
          return send(200, { deleted: true });
        }
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
          return m[2] ? send(200, { object: "list", data: [{ id: "ckpt-1", step_number: 330, fine_tuned_model_checkpoint: `ft:${job.model}:ckpt-step-330`, metrics: { valid_loss: 0.2 }, result_files: ["file-ad-cfg", "file-ad-w"] }], has_more: false }) : send(200, job);
        }
        send(404, { error: { message: url } });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    env.FINETUNE_TF_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
  });
  // every watchdog the tests start is stopped at the end, whether or not it finished on its own
  const watchdogs: number[] = [];
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  afterAll(() => {
    for (const pid of watchdogs) {
      try {
        process.kill(-pid, "SIGTERM"); // its process group: the watchdog and, on a Mac, caffeinate
      } catch {
        // gone already
      }
    }
    server.close();
  });

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

  it("try-serve asks the tuned model by two routes, charges each call, and delete-lora removes what it registered", async () => {
    const ledgerBefore = ledger().length;
    // the LoRA registration polls every 5 "seconds" until active: 100 ms minutes make that a moment
    const fast = { ...env, FINETUNE_TF_MINUTE_MS: "100" };
    const tfFast = (...args: string[]) => run("node", ["scripts/finetune-tf.mjs", ...args], { env: fast, cwd: process.cwd() });
    await tfFast("try-serve");
    const serve = state().serve;
    expect(serve.checkpoint_id).toMatchObject({ ok: false });
    // registered from the job and its last checkpoint, on the base model, as the cookbook does
    expect(registered.at(-1)).toMatchObject({ base_model: "Qwen/Qwen3-30B-A3B-Instruct-2507", source: "ftjob-1:ckpt-1" });
    expect(serve.lora_model).toMatchObject({ status: 200, name: "understudy-patcher-ab12", final_status: "active" });
    expect(serve.lora_answer).toMatchObject({ ok: true, content: '{"ok":true}' });
    // both calls are on the ledger: the refused one at 0, the answered one at its estimate
    const calls = ledger().slice(ledgerBefore).filter((e) => !e.type && e.meta?.stage === "try-serve");
    expect(calls).toHaveLength(2);
    expect(calls[0].usd).toBe(0);
    expect(calls[1].usd).toBeGreaterThan(0);
    expect(calls[1].meta.estimated).toBe(true);
    await tf("delete-lora");
    expect(served).toContain("DELETE /v1/models/understudy-patcher-ab12");
    expect(state().serve.lora_deleted.status).toBe(200);
  }, 60_000);

  it("try-serve keeps a refused LoRA registration word for word, and asks nothing more", async () => {
    loraGone = true;
    const ledgerBefore = ledger().length;
    await tf("try-serve");
    const serve = state().serve;
    expect(serve.lora_model).toMatchObject({ status: 410, name: null, detail: '"LoRA adapter deployment is no longer available"' });
    expect(serve.lora_answer).toBeUndefined();
    // only the checkpoint-id call is on the ledger, at 0 (refused)
    const calls = ledger().slice(ledgerBefore).filter((e) => !e.type && e.meta?.stage === "try-serve");
    expect(calls.map((c) => c.usd)).toEqual([0]);
    loraGone = false;
  }, 60_000);

  it("a dedicated endpoint gets a deadline: its own watchdog deletes it, retrying, and charges the hours once", async () => {
    // one "minute" is 100 ms here, so a 10-minute endpoint lives one second
    const fast = { ...env, FINETUNE_TF_MINUTE_MS: "100" };
    const tfFast = (...args: string[]) => run("node", ["scripts/finetune-tf.mjs", ...args], { env: fast, cwd: process.cwd() });
    expect(await fails("endpoint-create", "--minutes", "10")).toMatch(/--custom-weights-id/);
    expect(await fails("endpoint-create", "--custom-weights-id", "w-1", "--minutes", "500")).toMatch(/10 to 180/);
    expect(await fails("endpoint-create", "--custom-weights-id", "w-1", "--minutes", "10", "--usd-per-gpu-hour", "0")).toMatch(/above 0/);
    refuseDeletes = 2;
    await tfFast("endpoint-create", "--custom-weights-id", "w-1", "--minutes", "10");
    const ep = state().endpoint;
    watchdogs.push(ep.watchdog_pid);
    expect(ep.routing_key).toBe("dedicated/qwen-1");
    expect(endpoints).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 4000));
    expect(endpoints).toHaveLength(0);
    expect(served.filter((x) => x === `DELETE /v0/dedicated_endpoints/${ep.id}`).length).toBe(3);
    expect(state().endpoint.deleted).toBeTruthy();
    expect(ledger().filter((e) => !e.type && e.settles === ep.reservation)).toHaveLength(1);
    expect(alive(ep.watchdog_pid)).toBe(false);
    // A deleted by hand, then B created before A's deadline: A's watchdog must leave B running and uncharged
    await tfFast("endpoint-create", "--custom-weights-id", "w-2", "--minutes", "20");
    const a = state().endpoint;
    watchdogs.push(a.watchdog_pid);
    await tfFast("endpoint-delete");
    await tfFast("endpoint-create", "--custom-weights-id", "w-3", "--minutes", "40");
    const b = state().endpoint;
    watchdogs.push(b.watchdog_pid);
    await new Promise((r) => setTimeout(r, 2500)); // past A's deadline (2 s), before B's (4 s)
    expect(endpoints.map((e) => e.id)).toEqual([b.id]);
    expect(state().endpoint).toMatchObject({ id: b.id });
    expect(state().endpoint.deleted).toBeUndefined();
    expect(ledger().filter((e) => !e.type && e.settles === a.reservation)).toHaveLength(1);
    expect(ledger().filter((e) => !e.type && e.settles === b.reservation)).toHaveLength(0);
    expect(alive(a.watchdog_pid)).toBe(false);
    // B deleted by hand too: at its deadline its watchdog stops without calling the API again
    await tfFast("endpoint-delete");
    expect(endpoints).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 2500)); // past B's deadline
    expect(alive(b.watchdog_pid)).toBe(false);
    expect(served.filter((x) => x === `DELETE /v0/dedicated_endpoints/${b.id}`)).toHaveLength(1);
  }, 60_000);

  it("an endpoint create: a refusal gives the reservation back, a lost answer waits for adopt", async () => {
    failEndpoint = "refused";
    expect(await fails("endpoint-create", "--custom-weights-id", "w-4", "--minutes", "10")).toMatch(/refused \(HTTP 422/);
    expect(state().endpoint_pending).toBeUndefined();
    expect(ledger().at(-1)).toMatchObject({ type: "release" });
    // a lost answer, adopted after the endpoint's lifetime (1 s here): its clock started at the request, so it goes at once
    const fast = { ...env, FINETUNE_TF_MINUTE_MS: "100" };
    failEndpoint = "lost";
    expect(await fails("endpoint-create", "--custom-weights-id", "w-4", "--minutes", "10")).toMatch(/endpoint-adopt/);
    failEndpoint = "no";
    expect(await fails("endpoint-create", "--custom-weights-id", "w-4", "--minutes", "10")).toMatch(/pending/);
    await new Promise((r) => setTimeout(r, 1500));
    await run("node", ["scripts/finetune-tf.mjs", "endpoint-adopt"], { env: fast, cwd: process.cwd() });
    const adopted = state().endpoint;
    watchdogs.push(adopted.watchdog_pid);
    expect(adopted.deadline).toBeLessThan(Date.now());
    await new Promise((r) => setTimeout(r, 1500));
    expect(endpoints).toHaveLength(0);
    // charged from the request: at least its 10 "minutes" (1 s here), in hours of 100 ms minutes
    const charged = ledger().find((e) => !e.type && e.settles === adopted.reservation);
    expect(charged.meta.hours).toBeGreaterThanOrEqual(10 / 60);
  }, 60_000);

  it("after a lost answer, blocks another create until adopt or release", async () => {
    unlinkSync(env.FINETUNE_TF_STATE);
    await tf("upload");
    failCreate = "lost-answer";
    expect(await fails("create", "--usd-per-mtok", "5", "--balance-usd", "60", "--allow-another-job")).toMatch(/adopt, or release --confirm-no-job/);
    expect(state().pending).toBeDefined();
    failCreate = "no";
    const before = jobs.length;
    expect(await fails("create", "--usd-per-mtok", "5", "--balance-usd", "60", "--allow-another-job")).toMatch(/a create is pending/);
    expect(jobs).toHaveLength(before);
    await tf("adopt");
    expect(state().job.id).toBe(`ftjob-${before}`);
    expect(state().pending).toBeUndefined();
    // a create that started nothing: released only on explicit confirmation (the adopted job has ended by then)
    jobs[before - 1].status = "succeeded";
    unlinkSync(env.FINETUNE_TF_STATE);
    await tf("upload");
    failCreate = "rejected";
    expect(await fails("create", "--usd-per-mtok", "5", "--balance-usd", "60", "--allow-another-job")).toMatch(/adopt, or release/);
    expect(jobs).toHaveLength(before);
    expect(await fails("adopt")).toMatch(/0 new jobs/);
    expect(await fails("release")).toMatch(/--confirm-no-job/);
    const reservation = state().pending.reservation;
    await tf("release", "--confirm-no-job");
    expect(ledger().some((e) => e.type === "release" && e.id === reservation)).toBe(true);
    expect(state().pending).toBeUndefined();
    failCreate = "no";
  }, 60_000);

  it("refuses a create while the account already has a live job on the model, from any checkout", async () => {
    unlinkSync(env.FINETUNE_TF_STATE);
    await tf("upload");
    jobs.push({ id: "ftjob-elsewhere", object: "fine_tuning.job", model: "Qwen/Qwen3-30B-A3B-Instruct-2507", training_file: "file-other", created_at: 1, status: "running", trained_tokens: null });
    const before = jobs.length;
    expect(await fails("create", "--usd-per-mtok", "5", "--balance-usd", "60")).toMatch(/already has a job .*ftjob-elsewhere running/);
    // a job that succeeded counts too: a second run is a deliberate choice
    jobs.at(-1)!.status = "succeeded";
    expect(await fails("create", "--usd-per-mtok", "5", "--balance-usd", "60")).toMatch(/--allow-another-job/);
    expect(jobs).toHaveLength(before);
    jobs.pop();
  }, 60_000);

  it("refuses an upload that is not the manifest's", async () => {
    unlinkSync(env.FINETUNE_TF_STATE);
    await tf("upload");
    const s = state();
    s["train.jsonl"].sha256 = "0".repeat(64);
    writeFileSync(env.FINETUNE_TF_STATE, JSON.stringify(s));
    expect(await fails("create", "--usd-per-mtok", "5", "--balance-usd", "60", "--allow-another-job")).toMatch(/run upload again/);
  }, 60_000);
});
