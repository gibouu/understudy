// The fine-tune's evaluation table (issue #97), from the patch loop's results for the ft-nano-* arms:
// fix rate of the solvable failures within 5 patches and on the first patch, Wilson 95% intervals,
// Newcombe's interval for the tuned model against the same weights without the adapter, and cost per
// fixed case. Token Factory arms cost what the ledger charged; the endpoint arms cost the endpoint's
// hours at the H100 price, shared between them by their number of calls.
//
//   node scripts/finetune-report.mjs [results.json] --endpoint-hours 1.6 [--usd-per-hour 4.5]
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const file = args.find((a) => a.endsWith(".json")) ?? "bench/results/finetune-eval.json";
const hours = opt("--endpoint-hours", NaN);
const perHour = opt("--usd-per-hour", 4.5);
const results = JSON.parse(readFileSync(file, "utf8"));

/** Wilson score interval, 95% (as tests/measure/patch-loop.test.ts) */
export function wilson(k, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
/** Newcombe's hybrid score interval for p1 - p2 */
export function newcombe(k1, n1, k2, n2) {
  const [p1, p2] = [k1 / n1, k2 / n2];
  const [l1, u1] = wilson(k1, n1);
  const [l2, u2] = wilson(k2, n2);
  const d = p1 - p2;
  return [d, d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2), d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)];
}

const pct = (x) => `${Math.round(100 * x)}%`;
const rate = (k, n) => {
  const [lo, hi] = wilson(k, n);
  return `${pct(k / n)} [${Math.round(100 * lo)} to ${Math.round(100 * hi)}] (${k} of ${n})`;
};
const stats = (runs) => {
  const need = runs.filter((r) => r.expert_pass && !r.iterations[0].pass);
  return { need, fixed: need.filter((r) => r.passed_at !== null), first: need.filter((r) => r.passed_at === 1), calls: runs.reduce((n, r) => n + r.calls, 0), usd: runs.reduce((n, r) => n + r.cost_usd, 0), stopped: runs.filter((r) => r.stopped).length };
};

const arms = Object.entries(results.arms).filter(([id]) => id.startsWith("ft-nano-"));
const s = Object.fromEntries(arms.map(([id, a]) => [id, stats(a.runs)]));
const endpointCalls = arms.filter(([, a]) => a.config.endpoint).reduce((n, [id]) => n + s[id].calls, 0);
console.log("| Patcher | Fixed within 5 patches | Fixed on the first patch | Cost per fixed case |");
console.log("|---|---|---|---|");
for (const [id, a] of arms) {
  const x = s[id];
  const usd = a.config.endpoint ? (hours * perHour * x.calls) / endpointCalls : x.usd;
  const per = x.fixed.length && Number.isFinite(usd) ? `US$${(usd / x.fixed.length).toFixed(4)}` : "-";
  console.log(`| ${a.config.label ?? id} | ${rate(x.fixed.length, x.need.length)} | ${pct(x.first.length / x.need.length)} | ${per} |${x.stopped ? ` ${x.stopped} runs stopped` : ""}`);
}
if (s["ft-nano-ft"] && s["ft-nano-base"]) {
  const [ft, base] = [s["ft-nano-ft"], s["ft-nano-base"]];
  const [d, lo, hi] = newcombe(ft.fixed.length, ft.need.length, base.fixed.length, base.need.length);
  const [d1, lo1, hi1] = newcombe(ft.first.length, ft.need.length, base.first.length, base.need.length);
  const pts = (x) => `${x >= 0 ? "+" : ""}${Math.round(100 * x)}`;
  console.log(`\nTuned against the same weights without the adapter: within 5 patches ${pts(d)} points [${pts(lo)} to ${pts(hi)}], first patch ${pts(d1)} [${pts(lo1)} to ${pts(hi1)}] (Newcombe 95%).`);
}
if (!Number.isFinite(hours)) console.log("\nEndpoint arms: pass --endpoint-hours (from the endpoint's creation to its deletion) for their cost.");
