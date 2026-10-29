// Shared spend ledger for the Token Factory experiment scripts.
//
//   import { guard, charge, BudgetError, loadPrices, costOf } from "./bench-ledger.mjs";
//   const PRICES = loadPrices([model, ...]);                       // throws if a model has no list price
//   const r = guard(worstCaseUsd, { script: "bench-x", capUsd: 5 }); // reserves, or throws BudgetError
//   try { res = await call(); } catch (e) {
//     charge("bench-x", worstCaseUsd, { estimated: true, failed: true }, r);  // a failed call costs its estimate
//     throw e;
//   }
//   charge("bench-x", costOf(PRICES, model, usage), { model }, r);  // settles the reservation at the real cost
//
// The ledger is bench/results/ledger.jsonl (or BENCH_LEDGER_PATH), one JSON object per line:
//   charge   {"t", "script", "usd", "meta", "settles"?: <reservation id>}   (lines without "type" are charges)
//   reserve  {"t", "type": "reserve", "id", "script", "usd", "meta"}
//   release  {"t", "type": "release", "id"}                                  (the call was never sent)
// spent() sums the charges; pending() sums the reservations not yet settled or released; the caps
// apply to spent + pending, so concurrent callers cannot all pass on the same last dollar. A
// reservation that is never settled (a process killed mid-call) keeps counting against the cap
// until `node scripts/bench-ledger.mjs --settle-stale <minutes>` charges it at its estimate.
//
// guard() and reserve() run their check-and-append inside a cross-process lock: an exclusive-create
// lock file next to the ledger (withFileLock: fs.openSync(path, "wx") with an owner token inside), retried
// for up to 30 s, taken over when it is older than 10 s (critical sections take milliseconds; an old lock
// means its holder died; that removal and release both happen under a short gate, checked just before).
// Every line is appended under it, on a line of its own even after a torn tail. A
// charge() without a reservation settles the oldest open reservation of the same script, so callers
// written against the first version of this file (guard, then charge) still settle what they reserved.
//
// The global cap is BENCH_CAP_USD (default 90). guard(est, { script, capUsd, capScripts }) also caps
// the exposure of `capScripts` (default [script]) at capUsd. Prices are list prices, so the ledger is
// an estimate of the bill, not the bill. Never put prompts, outputs or keys in meta.
//
//   node scripts/bench-ledger.mjs                       spend and open reservations per script
//   node scripts/bench-ledger.mjs --seed                adds the bench-session line if it is missing
//   node scripts/bench-ledger.mjs --settle-stale 30     charges reservations older than 30 min at their estimate
//   node scripts/bench-ledger.mjs --self-check          concurrency test on a temporary ledger (no network)
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LEDGER = path.resolve(process.env.BENCH_LEDGER_PATH ?? path.join(ROOT, "bench/results/ledger.jsonl"));
export const CAP_USD = Number(process.env.BENCH_CAP_USD ?? 90);
const LOCK = `${LEDGER}.lock`;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 30_000;
/** float slack, so 0.5 + 5 x 0.1 still fits under a cap of 1 */
const EPS = 1e-9;

export class BudgetError extends Error {}

// --- Lock -------------------------------------------------------------------------
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let lockSeq = 0;
/** the first token of a lock file: who holds it */
const ownerOf = (file) => {
  try {
    return readFileSync(file, "utf8").split(/\s/)[0];
  } catch {
    return null;
  }
};
/**
 * Run `fn` holding `${lock}.gate`, the short lock under which a lock file may be removed. New holders only ever
 * create the lock file (O_EXCL, when it is absent), and the only removals, release and stale takeover, happen under
 * the gate with their check just before: so nothing can replace the lock between the check and the removal. A gate
 * is never removed by anyone but its holder: guessing that one is abandoned is the race the gate exists to close. A
 * process that dies inside its few-microsecond section leaves it behind; after LOCK_WAIT_MS the waiter gives up
 * (release leaves its lock to go stale, a takeover finds the lock still busy) and the error names the file to remove.
 */
function withGate(lock, fn, deadline = Date.now() + LOCK_WAIT_MS) {
  const gate = `${lock}.gate`;
  for (;;) {
    try {
      closeSync(openSync(gate, "wx"));
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      if (Date.now() > deadline) return undefined; // give up: the lock is left as it is
      sleepMs(1 + Math.floor(Math.random() * 3));
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(gate);
    } catch {
      // already gone
    }
  }
}

/**
 * Run `fn` holding the exclusive lock file `lock` (created with O_EXCL, an owner token inside). Waits up to
 * `waitMs`. A lock older than `staleMs` belonged to a process that died and is removed, and release removes the
 * lock only while it holds our own token; both under withGate, checked just before the removal. Synchronous on
 * purpose: the sections it guards are too.
 */
export function withFileLock(lock, fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  mkdirSync(path.dirname(lock), { recursive: true });
  const token = `${process.pid}-${Date.now().toString(36)}-${(lockSeq++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    let fd;
    try {
      fd = openSync(lock, "wx");
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs)
          withGate(
            lock,
            () => {
              // checked again under the gate: only a stale lock is removed, and nothing can replace it meanwhile
              if (Date.now() - statSync(lock).mtimeMs > staleMs) unlinkSync(lock);
            },
            deadline,
          );
      } catch {
        // the holder released it between our two calls: try again
      }
      if (Date.now() > deadline) throw new Error(`lock ${lock} busy for ${waitMs / 1000} s${existsSync(`${lock}.gate`) ? ` (and ${lock}.gate is held: if no bench script is running, a crashed one left it; remove both)` : ""}`);
      sleepMs(2 + Math.floor(Math.random() * 8));
      continue;
    }
    try {
      writeSync(fd, `${token} ${new Date().toISOString()}\n`);
    } finally {
      closeSync(fd);
    }
    try {
      return fn();
    } finally {
      // ours only while it holds our token: one taken over as stale belongs to someone else now
      withGate(lock, () => {
        if (ownerOf(lock) === token) unlinkSync(lock);
      });
    }
  }
}
const withLock = (fn) => withFileLock(LOCK, fn);

/**
 * Append one JSON line to the ledger (under the lock). A crash can leave a partial last line; the new entry then
 * starts on a line of its own, so the torn line is skipped alone instead of taking the new entry with it.
 */
function appendEntry(entry) {
  let torn = false;
  try {
    const st = statSync(LEDGER);
    if (st.size > 0) {
      const fd = openSync(LEDGER, "r");
      try {
        const b = Buffer.alloc(1);
        readSync(fd, b, 0, 1, st.size - 1);
        torn = b[0] !== 10;
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    // no ledger yet
  }
  appendFileSync(LEDGER, (torn ? "\n" : "") + JSON.stringify(entry) + "\n");
}

// --- State: read the ledger incrementally (it is append-only) ---------------------------
const state = { ino: null, size: 0, total: 0, charged: new Map(), open: new Map(), closed: new Set() };
function resetState() {
  Object.assign(state, { ino: null, size: 0, total: 0, charged: new Map(), open: new Map(), closed: new Set() });
}
function applyLine(line) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return; // a torn line is skipped, never fatal
  }
  const type = e.type ?? "charge";
  if (type === "charge") {
    const usd = Number(e.usd);
    if (Number.isFinite(usd)) {
      state.total += usd;
      state.charged.set(e.script, (state.charged.get(e.script) ?? 0) + usd);
    }
    if (e.settles) {
      state.open.delete(e.settles);
      state.closed.add(e.settles);
    }
  } else if (type === "reserve") {
    const usd = Number(e.usd);
    if (e.id && Number.isFinite(usd) && !state.closed.has(e.id)) state.open.set(e.id, { script: e.script, usd, t: e.t });
  } else if (type === "release") {
    state.open.delete(e.id);
    state.closed.add(e.id);
  }
}
function refresh() {
  let st;
  try {
    st = statSync(LEDGER);
  } catch {
    resetState();
    return;
  }
  if (st.ino !== state.ino || st.size < state.size) {
    resetState();
    state.ino = st.ino;
  }
  if (st.size === state.size) return;
  const fd = openSync(LEDGER, "r");
  try {
    const buf = Buffer.alloc(st.size - state.size);
    const n = readSync(fd, buf, 0, buf.length, state.size);
    const end = buf.subarray(0, n).lastIndexOf(10);
    if (end < 0) return; // only a partial line so far
    for (const line of buf.subarray(0, end + 1).toString("utf8").split("\n")) if (line.trim()) applyLine(line);
    state.size += end + 1;
  } finally {
    closeSync(fd);
  }
}

/** Every charge line of the ledger (reservations and releases left out). */
export function entries() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        const e = JSON.parse(l);
        return (e.type ?? "charge") === "charge" && Number.isFinite(Number(e.usd)) ? [e] : [];
      } catch {
        return [];
      }
    });
}

/** USD charged so far, in total or for one script. */
export function spent(script) {
  refresh();
  return script === undefined ? state.total : (state.charged.get(script) ?? 0);
}
/** USD reserved by calls still in flight (or whose process died), in total or for one script. */
export function pending(script) {
  refresh();
  let n = 0;
  for (const r of state.open.values()) if (script === undefined || r.script === script) n += r.usd;
  return n;
}
/** What the caps are checked against: charged plus reserved. */
export const exposure = (script) => spent(script) + pending(script);

let seq = 0;
/**
 * Atomically check that `estimate` fits under the global cap (and under capUsd for capScripts, default
 * [script]) counting open reservations, then reserve it. Returns the reservation to pass to charge().
 * `estimate` should be the worst case (prompt estimate at the prompt price plus max_tokens at the
 * completion price).
 */
export function reserve(estimate, { script, capUsd, capScripts, meta } = {}) {
  const est = Number(estimate);
  if (!Number.isFinite(est) || est < 0) throw new Error(`reserve: bad estimate ${estimate}`);
  return withLock(() => {
    refresh();
    const total = exposure();
    if (total + est > CAP_USD + EPS) throw new BudgetError(`ledger at $${total.toFixed(4)} (charged plus reserved); the next call (up to $${est.toFixed(4)}) would pass the global cap $${CAP_USD}`);
    if (capUsd !== undefined) {
      const group = capScripts ?? [script];
      const mine = group.reduce((n, s) => n + exposure(s), 0);
      if (mine + est > Number(capUsd) + EPS) throw new BudgetError(`${group.join(" + ")} at $${mine.toFixed(4)} (charged plus reserved); the next call (up to $${est.toFixed(4)}) would pass the cap $${capUsd}`);
    }
    const id = `${process.pid}-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    appendEntry({ t: new Date().toISOString(), type: "reserve", id, script: script ?? null, usd: Number(est.toFixed(8)), ...(meta ? { meta } : {}) });
    refresh();
    return { id, script: script ?? null, usd: est };
  });
}

/** Same as reserve(); kept under its first name. Throws BudgetError when the call does not fit. */
export const guard = reserve;

/**
 * Record what a call cost and settle its reservation. For a call that failed or timed out, charge the
 * reserved estimate and set meta.estimated (the server may have done the work). Without a reservation,
 * the oldest open reservation of the same script is settled.
 */
export function charge(script, usd, meta = {}, reservation) {
  const amount = Number(usd);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`charge: bad amount ${usd}`);
  withLock(() => {
    refresh();
    let settles = reservation?.id ?? null;
    if (!settles) for (const [id, r] of state.open) if (r.script === script || r.script === null) { settles = id; break; }
    if (amount === 0 && !settles && !meta.keep) return;
    appendEntry({ t: new Date().toISOString(), script: String(script), usd: Number(amount.toFixed(8)), meta, ...(settles ? { settles } : {}) });
    refresh();
  });
}

/** Drop a reservation whose call was never sent. */
export function release(reservation) {
  if (!reservation?.id) return;
  withLock(() => {
    appendEntry({ t: new Date().toISOString(), type: "release", id: reservation.id });
    refresh();
  });
}

// --- Prices ---------------------------------------------------------------------------
/**
 * List prices (USD per token) from tests/fixtures/models.json for the given model ids. Refuses
 * (throws) when one of them is missing, not a number, or not above zero, because its calls would be charged $0.
 */
export function loadPrices(models, file = path.join(ROOT, "tests/fixtures/models.json")) {
  const catalog = JSON.parse(readFileSync(file, "utf8"));
  const prices = {};
  const missing = [];
  for (const id of new Set(models)) {
    const m = catalog.models?.find((x) => x.id === id);
    const p = m && { prompt: Number(m.pricing?.prompt), completion: Number(m.pricing?.completion), cache_read: m.pricing?.input_cache_read == null ? null : Number(m.pricing.input_cache_read) };
    // a price of 0 (or null, read as 0) or below would authorise and record its calls at $0
    const priced = (x) => Number.isFinite(x) && x > 0;
    if (!p || m.pricing?.prompt == null || m.pricing?.completion == null || !priced(p.prompt) || !priced(p.completion) || (p.cache_read !== null && !priced(p.cache_read))) missing.push(id);
    else prices[id] = p;
  }
  if (missing.length) throw new Error(`no positive list price for ${missing.join(", ")} in ${path.relative(ROOT, file)} (fetched ${catalog.fetched ?? "?"}): refusing to run, its calls would be charged $0. Refresh the catalogue or fix the model id.`);
  prices.fetched = catalog.fetched;
  return prices;
}
/** USD of one call at list prices; throws for a model loadPrices() did not return. */
export function costOf(prices, model, u) {
  const p = prices[model];
  if (!p) throw new Error(`costOf: no price for ${model}`);
  const cached = u.cached_tokens ?? 0;
  return (u.prompt_tokens - cached) * p.prompt + cached * (p.cache_read ?? p.prompt) + u.completion_tokens * p.completion;
}

// --- Self-check: concurrent reservations near the cap, on a temporary ledger -----------------
async function selfCheck() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bench-ledger-check-"));
  const me = fileURLToPath(import.meta.url);
  const go = path.join(dir, "go");
  /** n child processes, each waiting for the go file, then reserve(est) and maybe charge; returns how many reserved */
  async function race(ledger, cap, n, est, then) {
    const child = `
      const fs = require("node:fs");
      while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      import(${JSON.stringify(me)}).then((L) => {
        try {
          const r = L.reserve(${est}, { script: "check" });
          ${then === "settle" ? 'L.charge("check", 0.04, { model: "x" }, r);' : then === "fail" ? `L.charge("check", ${est}, { estimated: true, failed: true }, r);` : then === "legacy" ? 'L.charge("check", 0.04, { model: "x" });' : ""}
          console.log("ok");
        } catch (e) { console.log(e instanceof L.BudgetError ? "refused" : "error " + e.message); }
      });`;
    if (existsSync(go)) rmSync(go);
    const procs = Array.from({ length: n }, () => {
      const p = spawn(process.execPath, ["-e", child], { env: { ...process.env, BENCH_LEDGER_PATH: ledger, BENCH_CAP_USD: String(cap) } });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      return new Promise((res) => p.on("close", () => res(out.trim())));
    });
    await new Promise((r) => setTimeout(r, 400)); // let every child reach the barrier
    writeFileSync(go, "");
    const outs = await Promise.all(procs);
    const bad = outs.filter((o) => o !== "ok" && o !== "refused");
    if (bad.length) throw new Error(`child failed: ${bad[0]}`);
    return outs.filter((o) => o === "ok").length;
  }
  /** read a temporary ledger with a fresh copy of this module (its LEDGER is fixed at import) */
  const totals = async (ledger, cap) => {
    const out = await new Promise((res) => {
      const p = spawn(process.execPath, ["-e", `import(${JSON.stringify(me)}).then((L) => console.log(JSON.stringify({ spent: L.spent(), pending: L.pending() })))`], { env: { ...process.env, BENCH_LEDGER_PATH: ledger, BENCH_CAP_USD: String(cap) } });
      let s = "";
      p.stdout.on("data", (d) => (s += d));
      p.on("close", () => res(s));
    });
    return JSON.parse(out);
  };
  const results = [];
  const check = (name, got, want) => {
    results.push({ name, got, want, pass: got === want });
    console.log(`${got === want ? "PASS" : "FAIL"}  ${name}: ${got} (want ${want})`);
  };

  // 1. Codex's case: $0.01 left, five concurrent guard(0.01): exactly one may pass
  const l1 = path.join(dir, "l1.jsonl");
  writeFileSync(l1, JSON.stringify({ t: "x", script: "seed", usd: 0.99 }) + "\n");
  check("$0.01 left, 5 concurrent reserve($0.01)", await race(l1, 1, 5, 0.01, "none"), 1);

  // 2. $0.50 left, 12 concurrent reserve($0.10) that never settle: 5 pass, 7 refused
  const l2 = path.join(dir, "l2.jsonl");
  writeFileSync(l2, JSON.stringify({ t: "x", script: "seed", usd: 0.5 }) + "\n");
  check("$0.50 left, 12 concurrent reserve($0.10)", await race(l2, 1, 12, 0.1, "none"), 5);
  const t2 = await totals(l2, 1);
  check("  pending after the race ($)", Number(t2.pending.toFixed(4)), 0.5);

  // 3. same, but each call settles at a real cost of $0.04: reservations are released as calls finish,
  //    so more fit; the final charged + pending never passes the cap
  const l3 = path.join(dir, "l3.jsonl");
  writeFileSync(l3, JSON.stringify({ t: "x", script: "seed", usd: 0.5 }) + "\n");
  const ok3 = await race(l3, 1, 12, 0.1, "settle");
  const t3 = await totals(l3, 1);
  check("  settled race: charged + pending <= cap", t3.spent + t3.pending <= 1 + EPS, true);
  check("  settled race: nothing left pending", Number(t3.pending.toFixed(4)), 0);
  check("  settled race: charged = 0.5 + 0.04 x passed", Number(t3.spent.toFixed(4)), Number((0.5 + 0.04 * ok3).toFixed(4)));
  console.log(`      (${ok3} of 12 passed with settlement)`);

  // 4. failed calls are charged at their estimate: 5 pass, $1.00 charged, nothing pending
  const l4 = path.join(dir, "l4.jsonl");
  writeFileSync(l4, JSON.stringify({ t: "x", script: "seed", usd: 0.5 }) + "\n");
  check("failed calls charged at estimate: passed", await race(l4, 1, 12, 0.1, "fail"), 5);
  const t4 = await totals(l4, 1);
  check("  charged ($)", Number(t4.spent.toFixed(4)), 1);
  check("  pending ($)", Number(t4.pending.toFixed(4)), 0);

  // 5. legacy pattern (guard, then charge without the reservation) settles FIFO by script
  const l5 = path.join(dir, "l5.jsonl");
  writeFileSync(l5, JSON.stringify({ t: "x", script: "seed", usd: 0.5 }) + "\n");
  await race(l5, 1, 6, 0.1, "legacy");
  const t5 = await totals(l5, 1);
  check("legacy guard+charge: nothing left pending", Number(t5.pending.toFixed(4)), 0);

  // 6. missing prices refuse
  let refused = false;
  try {
    loadPrices(["nvidia/not-a-model"]);
  } catch (e) {
    refused = /refusing to run/.test(e.message);
  }
  check("missing price refuses", refused, true);

  // 7. zero, null and negative prices refuse too: their calls would pass any cap at $0
  for (const [label, pricing] of [
    ["zero", { prompt: "0", completion: "0.000001" }],
    ["null", { prompt: null, completion: "0.000001" }],
    ["negative", { prompt: "0.000001", completion: "-0.000001" }],
    ["zero cache read", { prompt: "0.000001", completion: "0.000001", input_cache_read: "0" }],
  ]) {
    const cat = path.join(dir, `prices-${label.replace(/ /g, "-")}.json`);
    writeFileSync(cat, JSON.stringify({ fetched: "x", models: [{ id: "m", pricing }] }));
    let no = false;
    try {
      loadPrices(["m"], cat);
    } catch (e) {
      no = /refusing to run/.test(e.message);
    }
    check(`${label} price refuses`, no, true);
  }

  // 8. a crash left a torn last line: the next reservation must not be swallowed by it
  const l8 = path.join(dir, "l8.jsonl");
  writeFileSync(l8, JSON.stringify({ t: "x", script: "seed", usd: 0.5 }) + "\n" + '{"t":"x","type":"reserve","id":"torn","usd":');
  check("torn tail, 12 concurrent reserve($0.10)", await race(l8, 1, 12, 0.1, "none"), 5);
  const t8 = await totals(l8, 1);
  check("  pending after the race ($)", Number(t8.pending.toFixed(4)), 0.5);

  // 9. a stale lock (its holder died) is taken over, and the race behind it still counts exactly
  const l9 = path.join(dir, "l9.jsonl");
  writeFileSync(l9, JSON.stringify({ t: "x", script: "seed", usd: 0.5 }) + "\n");
  writeFileSync(`${l9}.lock`, "dead-owner 2000-01-01T00:00:00Z\n");
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${l9}.lock`, old, old);
  check("stale lock, 12 concurrent reserve($0.10)", await race(l9, 1, 12, 0.1, "none"), 5);
  check("  no lock left behind", existsSync(`${l9}.lock`), false);

  // 10. a fresh lock is never removed by a waiter, and release leaves a lock that is not its own
  const fresh = path.join(dir, "fresh.lock");
  writeFileSync(fresh, "someone-else 2000-01-01T00:00:00Z\n");
  let busy = false;
  try {
    withFileLock(fresh, () => {}, { waitMs: 200 });
  } catch (e) {
    busy = /busy/.test(e.message);
  }
  check("a fresh lock makes a waiter give up", busy, true);
  check("  and is still the other owner's", readFileSync(fresh, "utf8").startsWith("someone-else "), true);
  const mine = path.join(dir, "mine.lock");
  withFileLock(mine, () => writeFileSync(mine, "new-owner x\n")); // as if taken over while we held it
  check("release leaves a lock that holds another token", existsSync(mine) && readFileSync(mine, "utf8").startsWith("new-owner "), true);

  rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.pass).length;
  console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}

// --- CLI -------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-check")) {
    await selfCheck();
  } else {
    if (argv.includes("--seed") && !entries().some((e) => e.script === "bench-session")) {
      charge("bench-session", 0.29, { note: "seeded: spend of scripts/bench-session.mjs runs before the ledger existed (owner's figure, list prices)" });
    }
    const stale = argv.indexOf("--settle-stale");
    if (stale >= 0) {
      const minutes = Number(argv[stale + 1]);
      if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("--settle-stale needs a number of minutes");
      refresh();
      const old = [...state.open].filter(([, r]) => Date.now() - Date.parse(r.t) > minutes * 60_000);
      for (const [id, r] of old) charge(r.script ?? "unknown", r.usd, { estimated: true, reason: `reservation open for more than ${minutes} min` }, { id });
      console.log(`settled ${old.length} stale reservation(s) at their estimate`);
    }
    refresh();
    const scripts = new Set([...state.charged.keys(), ...[...state.open.values()].map((r) => r.script)]);
    for (const s of [...scripts].sort((a, b) => spent(b) - spent(a))) {
      const p = pending(s);
      console.log(`${String(s).padEnd(24)} $${spent(s).toFixed(4)}${p ? `  (+ $${p.toFixed(4)} reserved)` : ""}`);
    }
    console.log(`${"total".padEnd(24)} $${spent().toFixed(4)} charged + $${pending().toFixed(4)} reserved of $${CAP_USD}`);
  }
}
