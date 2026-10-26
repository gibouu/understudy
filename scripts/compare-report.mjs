// Nemotron against other models (issue #96): prints the tables of docs/MEASUREMENTS.md section 10 from the
// raw results, with no network and no spend.
//
//   node scripts/compare-report.mjs [--json bench/results/compare-summary.json]
//
// Reads bench/results/patch-loop.json (the Nemotron round-2 arms), compare-patch.json (the same loop with other
// patchers), compare-compile.json, label.json (Super VL) and compare-label.json (the other video model).
// Rates carry Wilson 95% intervals; the patching rates count only the solvable failures (the 180 runs whose
// naive program fails and whose expert program passes), as in section 8.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMPARATORS, COMPARE_CATALOGUE } from "./compare-models.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => (existsSync(path.join(ROOT, f)) ? JSON.parse(readFileSync(path.join(ROOT, f), "utf8")) : null);
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json") ? path.resolve(ROOT, argv[argv.indexOf("--json") + 1]) : null;
/** the compile route's own client timeout */
const ROUTE_TIMEOUT_S = 25;

function wilson(k, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const pctCI = (k, n) => {
  if (!n) return "-";
  const [lo, hi] = wilson(k, n);
  return `${Math.round((100 * k) / n)}% [${Math.round(100 * lo)} to ${Math.round(100 * hi)}] (${k} of ${n})`;
};
const pct = (k, n) => (n ? `${Math.round((100 * k) / n)}%` : "-");
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const usd = (x, d = 4) => (Number.isFinite(x) ? `US$${x.toFixed(d)}` : "-");
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const catalogue = JSON.parse(readFileSync(COMPARE_CATALOGUE, "utf8"));
const listPrice = (id) => {
  const m = catalogue.models.find((x) => x.id === id);
  return m ? `$${(Number(m.pricing.prompt) * 1e6).toFixed(2)} / $${(Number(m.pricing.completion) * 1e6).toFixed(2)}` : "-";
};
const SIZES = { "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": "30B, 3B active", "nvidia/nemotron-3-super-120b-a12b": "120B, 12B active", "nvidia/Nemotron-3-Ultra-550b-a55b": "550B, 55B active", "nvidia/Nemotron-3.5-Super-VL": "-" };
const nameOf = (id) => COMPARATORS[id]?.name ?? { "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": "Nemotron 3 Nano", "nvidia/nemotron-3-super-120b-a12b": "Nemotron 3 Super", "nvidia/Nemotron-3-Ultra-550b-a55b": "Nemotron 3 Ultra", "nvidia/Nemotron-3.5-Super-VL": "Nemotron 3.5 Super VL" }[id] ?? id;
const sizeOf = (id) => COMPARATORS[id]?.size ?? SIZES[id] ?? "-";
const out = { generated_at: new Date().toISOString(), models: {}, patch: [], compile: [], label: [] };
const lines = [];

// --- the models ----------------------------------------------------------------------------
const used = ["nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", "nvidia/nemotron-3-super-120b-a12b", "nvidia/Nemotron-3-Ultra-550b-a55b", "nvidia/Nemotron-3.5-Super-VL", ...Object.keys(COMPARATORS)];
lines.push("### Models (list prices per million tokens, in / out, from the catalogue listed on " + catalogue.fetched + ")\n");
lines.push(table(["Model", "Size (total, active)", "Price", "Stands in for", "Reasoning off"], used.map((id) => [nameOf(id), sizeOf(id), listPrice(id), COMPARATORS[id]?.stands_in_for ?? "-", COMPARATORS[id] ? (COMPARATORS[id].off_note ?? "enable_thinking false") : "enable_thinking false"])));
for (const id of used) out.models[id] = { name: nameOf(id), size: sizeOf(id), price: listPrice(id), ...(COMPARATORS[id] ?? {}) };

// --- patching -------------------------------------------------------------------------------
const nemo = read("bench/results/patch-loop.json");
const other = read("bench/results/compare-patch.json");
const allCalls = (r) => [
  ...(r.preflight ? [r.preflight.call] : []),
  ...r.iterations.flatMap((it) => {
    const p = it.patch_before;
    if (!p) return [];
    return [p.call, ...(p.retried_after_noop ? [p.retried_after_noop.call] : []), ...(p.escalated_after_noop ? [p.escalated_after_noop.call] : [])];
  }),
];
function patchRow(armId, arm) {
  const runs = arm.runs.filter((r) => r.probe !== "pour-liquid");
  const needFix = runs.filter((r) => r.expert_pass && !r.iterations[0].pass);
  const fixed = needFix.filter((r) => r.passed_at !== null);
  const first = needFix.filter((r) => r.passed_at !== null && r.passed_at <= 1);
  const calls = runs.flatMap(allCalls);
  const cost = runs.reduce((n, r) => n + r.cost_usd, 0);
  const model = arm.config.model;
  const row = {
    arm: armId,
    // the token budget is in the label: a model that cannot stop reasoning gets 4,096 where Super off gets 800
    patcher: arm.config.escalate_model
      ? `${nameOf(model)} off (${arm.config.maxTokens}), then ${nameOf(arm.config.escalate_model)} ${arm.config.escalate?.thinking ?? ""} (${arm.config.escalate?.maxTokens}) when stuck`
      : `${nameOf(model)}, ${COMPARATORS[model]?.always_reasons && arm.config.thinking === "off" ? "reasoning low" : `thinking ${arm.config.thinking}`} (${arm.config.maxTokens} tokens)`,
    seeds: arm.config.seeds?.length ?? 3,
    need_fix: needFix.length,
    fixed: fixed.length,
    first: first.length,
    cost_usd: cost,
    cost_per_fix: fixed.length ? cost / fixed.length : null,
    model_s_per_fix: fixed.length ? mean(fixed.map((r) => r.latency_ms / 1000)) : null,
    calls: calls.length,
    truncated: calls.filter((c) => c.finish === "length").length,
    unparsed: calls.filter((c) => c.ok && !c.json_ok).length,
    failed: calls.filter((c) => !c.ok).length,
    by_probe: Object.fromEntries(["insert", "place", "pour", "carry"].map((p) => {
      const nf = needFix.filter((r) => r.probe === p);
      return [p, `${nf.filter((r) => r.passed_at !== null).length}/${nf.length}`];
    })),
  };
  out.patch.push(row);
  return row;
}
const patchRows = [];
if (nemo) for (const a of ["r2-super-off", "r2-super-on", "r2-esc-on", "r2-esc-ultra"]) if (nemo.arms[a]) patchRows.push(patchRow(a, nemo.arms[a]));
/** an arm stopped by the cap or a withdrawn model is incomplete: listed, never compared */
const stoppedArms = other ? Object.entries(other.arms).filter(([, arm]) => arm.runs.some((r) => r.stopped)) : [];
if (other) for (const [a, arm] of Object.entries(other.arms)) if (!stoppedArms.some(([s]) => s === a)) patchRows.push(patchRow(a, arm));
if (patchRows.length) {
  lines.push("\n### Patching: the self-improvement loop of section 8 (round 2), the same 180 solvable failures, 6 seeds, at most 5 patches\n");
  lines.push(table(["Patcher", "Fixed within 5 patches", "Fixed on the first patch", "Cost per fixed case", "Model time per fixed case", "Answers cut off / unparseable / failed calls"], patchRows.map((r) => [r.patcher, pctCI(r.fixed, r.need_fix), pct(r.first, r.need_fix), r.cost_per_fix === null ? "-" : usd(r.cost_per_fix), r.model_s_per_fix === null ? "-" : `${Math.round(r.model_s_per_fix)} s`, `${r.truncated} / ${r.unparsed} / ${r.failed} of ${r.calls}`])));
  lines.push("\nBy task, fixed of solvable failures:\n");
  lines.push(table(["Patcher", "insert", "place", "pour", "carry"], patchRows.map((r) => [r.patcher, r.by_probe.insert, r.by_probe.place, r.by_probe.pour, r.by_probe.carry])));
  lines.push(`\nSpend on the loop: ${patchRows.map((r) => `${r.arm} ${usd(r.cost_usd, 2)}`).join(", ")}.`);
  for (const [a, arm] of stoppedArms) lines.push(`Left out, stopped before the end: ${a} (${arm.runs.filter((r) => r.stopped).length} of ${arm.runs.length} runs stopped: ${arm.runs.find((r) => r.stopped).stopped}).`);
}

// --- compiling ---------------------------------------------------------------------------------
const comp = read("bench/results/compare-compile.json");
if (comp) {
  // Nemotron first, then the others in the order they ran
  const rows = Object.values(comp.models).sort((a, b) => Number(b.model.startsWith("nvidia/")) - Number(a.model.startsWith("nvidia/"))).map((m) => {
    const runs = m.runs;
    const done = runs.filter((r) => r.status === "done");
    const deg = done.filter((r) => r.variant === "degraded");
    const degAll = runs.filter((r) => r.variant === "degraded");
    const truth = done.filter((r) => r.variant === "truth");
    const truthAll = runs.filter((r) => r.variant === "truth");
    const calls = runs.flatMap((r) => r.calls);
    const okCalls = calls.filter((c) => c.ok);
    const row = {
      model: m.model,
      compiles: runs.length,
      done: done.length,
      first_clean: done.filter((r) => r.first_answer_clean).length,
      problems_left: done.filter((r) => r.problems_left > 0).length,
      validate_errors: done.filter((r) => r.validate_errors > 0).length,
      asked_fit: deg.filter((r) => r.asked_fit).length,
      asked_success: deg.filter((r) => r.asked_success).length,
      degraded: degAll.length,
      route_added: deg.reduce((n, r) => n + r.added_asks.length, 0),
      /** every ask on a complete spec is unneeded; the route drops those about settled fields */
      truth_asks_written: mean(truth.map((r) => r.model_asks.length)),
      truth_asks_kept: mean(truth.map((r) => r.model_asks.length - r.dropped_asks)),
      truth_n: truthAll.length,
      dropped_per_compile: mean(done.map((r) => r.dropped_asks)),
      rehearsal_pass: truth.filter((r) => r.rehearsal?.pass).length,
      cost_per_compile: mean(runs.map((r) => r.calls.reduce((n, c) => n + c.cost_usd, 0))),
      seconds_per_compile: median(runs.map((r) => r.calls.reduce((n, c) => n + c.ms, 0) / 1000)),
      calls_over_route_timeout: okCalls.filter((c) => c.ms > ROUTE_TIMEOUT_S * 1000).length,
      calls: calls.length,
      failed_calls: calls.length - okCalls.length,
      reasoning_tokens: mean(okCalls.map((c) => c.reasoning_tokens ?? 0)),
    };
    out.compile.push(row);
    return row;
  });
  lines.push(`\n### Compiling: the product's compile route on the ten interview specs, fitted to the bench, ${comp.conditions.runs} runs each, complete and with five fields removed\n`);
  lines.push(table(
    ["Compiler", "Program back", "First answer clean", "Problems left after the repair round", "Asked for the missing fit itself", "Asked for the missing success check itself", "Asks written for a complete spec (mean)", "Rehearsal passes at 1 g (complete spec)", "Cost per compile", "Model time per compile (median)", `Calls over the route's ${ROUTE_TIMEOUT_S} s`],
    rows.map((r) => [nameOf(r.model), pct(r.done, r.compiles), pctCI(r.first_clean, r.compiles), `${r.problems_left} of ${r.done}`, pctCI(r.asked_fit, r.degraded), pctCI(r.asked_success, r.degraded), r.truth_asks_written.toFixed(1), `${r.rehearsal_pass} of ${r.truth_n}`, usd(r.cost_per_compile, 5), `${r.seconds_per_compile.toFixed(1)} s`, `${r.calls_over_route_timeout} of ${r.calls}`]),
  ));
}

// --- labelling ---------------------------------------------------------------------------------
const WRONG_SCENE = /battery|hard.?drive|disk|hdd|ssd/i;
function labelRow(file, model) {
  const runs = file.runs.filter((r) => r.clip === "iss" && "abcdefg".includes(r.condition));
  const ok = runs.filter((r) => r.ok);
  const names = (r) => (r.label?.objects ?? []).map((o) => String(o?.name ?? ""));
  const row = {
    model,
    labels: runs.length,
    parsed: runs.filter((r) => r.score?.parsed).length,
    accuracy: mean(runs.map((r) => r.score.score / 5)),
    seed_film: runs.filter((r) => r.score.object).length,
    wrong_scene: runs.filter((r) => names(r).some((n) => WRONG_SCENE.test(n))).length,
    verb: runs.filter((r) => r.score.verb).length,
    fixture: runs.filter((r) => r.score.fixture).length,
    steps: runs.filter((r) => r.score.steps).length,
    size: runs.filter((r) => r.score.size).length,
    cut_off: runs.filter((r) => r.finish === "length").length,
    // failed attempts are charged at their estimate (estimated_usd): a model that times out pays for it here too
    cost_per_label: mean(runs.map((r) => (r.cost_usd ?? 0) + (r.estimated_usd ?? 0))),
    failed_attempts: runs.reduce((n, r) => n + (r.attempts ?? 1) - (r.ok ? 1 : 0), 0),
    seconds_per_label: median(ok.map((r) => r.ms / 1000)),
    by_condition: Object.fromEntries([..."abcdefg"].map((c) => [c, mean(runs.filter((r) => r.condition === c).map((r) => r.score.score / 5))])),
  };
  out.label.push(row);
  return row;
}
const labelRows = [];
const nv = read("bench/results/label.json");
const cl = read("bench/results/compare-label.json");
if (nv) labelRows.push(labelRow(nv, nv.conditions.model));
if (cl) labelRows.push(labelRow(cl, cl.conditions.model));
if (labelRows.length) {
  lines.push("\n### Labelling: the ISS seed-film clip, seven input conditions, 5 runs each (35 labels), scored with the rubric of section 6\n");
  lines.push(table(
    ["Labeller", "Rubric score", "Names the seed film", "Calls the pillows batteries or drives", "Insert or pocket verb", "Pocket fixture", "Step count", "Size", "Cut off", "Cost per label", "Time per label (median)"],
    labelRows.map((r) => [nameOf(r.model), `${Math.round(100 * r.accuracy)}%`, `${r.seed_film} of ${r.labels}`, `${r.wrong_scene} of ${r.labels}`, `${r.verb}`, `${r.fixture}`, `${r.steps}`, `${r.size}`, `${r.cut_off}`, usd(r.cost_per_label), `${r.seconds_per_label.toFixed(1)} s`]),
  ));
  lines.push("\nRubric score by condition (a 4 fps, b 8 fps, c 2 fps, d keyframes, e hint, f thinking on, g 960 px):\n");
  lines.push(table(["Labeller", ..."abcdefg"], labelRows.map((r) => [nameOf(r.model), ...[..."abcdefg"].map((c) => `${Math.round(100 * r.by_condition[c])}%`)])));
}

console.log(lines.join("\n"));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2) + "\n");
