// Shared spend ledger for the Token Factory experiment scripts.
//
//   import { charge, spent, guard } from "./bench-ledger.mjs";
//   guard(worstCaseUsdOfNextCall);              // throws BudgetError past the global cap
//   charge("bench-label", usd, { model, stage }); // one line per billed call
//
// The ledger is bench/results/ledger.jsonl, one JSON object per line:
//   {"t": ISO time, "script": string, "usd": number, "meta": {...}}
// Lines are appended with O_APPEND in one write each, so several scripts can
// charge at the same time. The global cap is BENCH_CAP_USD (default 90) and
// covers every script; guard(est, { script, capUsd }) also enforces a cap on
// one script's own lines. Prices are list prices, so the ledger is an estimate
// of the bill, not the bill. Never put prompts, outputs or keys in meta.
//
//   node scripts/bench-ledger.mjs            prints the total and the split per script
//   node scripts/bench-ledger.mjs --seed     adds the bench-session line if it is missing
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LEDGER = path.join(ROOT, "bench/results/ledger.jsonl");
export const CAP_USD = Number(process.env.BENCH_CAP_USD ?? 90);

export class BudgetError extends Error {}

/** Every line of the ledger; a torn or unreadable line is skipped, never fatal. */
export function entries() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        const e = JSON.parse(l);
        return Number.isFinite(Number(e.usd)) ? [e] : [];
      } catch {
        return [];
      }
    });
}

/** Total USD on the ledger, or only one script's lines when `script` is given. */
export function spent(script) {
  return entries()
    .filter((e) => script === undefined || e.script === script)
    .reduce((n, e) => n + Number(e.usd), 0);
}

/** Append one charge. Zero-cost lines are skipped unless meta.keep is set. */
export function charge(script, usd, meta = {}) {
  const amount = Number(usd);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`charge: bad amount ${usd}`);
  if (amount === 0 && !meta.keep) return;
  mkdirSync(path.dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, JSON.stringify({ t: new Date().toISOString(), script: String(script), usd: Number(amount.toFixed(8)), meta }) + "\n");
}

/**
 * Throw before a call that could push the ledger past the global cap, or past
 * `capUsd` for `script` when both are given. `nextUsdEstimate` should be the
 * worst case (max_tokens at the completion price).
 */
export function guard(nextUsdEstimate, { script, capUsd } = {}) {
  const est = Math.max(0, Number(nextUsdEstimate) || 0);
  const total = spent();
  if (total + est > CAP_USD) throw new BudgetError(`ledger at $${total.toFixed(4)}; the next call (up to $${est.toFixed(4)}) would pass the global cap $${CAP_USD}`);
  if (script !== undefined && capUsd !== undefined) {
    const mine = spent(script);
    if (mine + est > capUsd) throw new BudgetError(`${script} at $${mine.toFixed(4)}; the next call (up to $${est.toFixed(4)}) would pass its cap $${capUsd}`);
  }
  return total;
}

// --- CLI -------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--seed") && !entries().some((e) => e.script === "bench-session")) {
    charge("bench-session", 0.29, { note: "seeded: spend of scripts/bench-session.mjs runs before the ledger existed (owner's figure, list prices)" });
  }
  const by = {};
  for (const e of entries()) by[e.script] = (by[e.script] ?? 0) + Number(e.usd);
  for (const [s, usd] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`${s.padEnd(24)} $${usd.toFixed(4)}`);
  console.log(`${"total".padEnd(24)} $${spent().toFixed(4)} of $${CAP_USD}`);
}
