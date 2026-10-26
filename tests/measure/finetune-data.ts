/**
 * The fine-tune dataset (issue #97): every repair in bench/results/patch-loop.json turned into
 * chat examples, (task, world, knobs, attempts, simulator failure note) -> the patch the model
 * returned, with the simulator's verdict on that patch.
 *
 * The results file keeps knobs, patches, metrics and costs, not the prompts. The prompts are
 * rebuilt: each saved run is replayed in MuJoCo from its seed and knobs, which regenerates the
 * failure notes, and the same prompt builders as the live loop (patch-prompts.ts) assemble them.
 * A run joins the dataset only if the replay reproduces every saved iteration (knobs, pass,
 * score, failure class, metrics at their saved precision) and no number in its patches sits at
 * the saved precision (such a number may have been rounded on save, and the prompts that quote
 * it would then differ from what the model saw); the others are counted and left out.
 *
 * The split is by case (probe x gravity x disturbance), every seed of a case on one side, so no
 * held-out failure has a twin in training. Per task, about a third of the cases with solvable
 * failures are held out, chosen by a fixed hash of the case id at distinct gravities and
 * disturbances (heldOutCases), never by hand.
 */
import type { MainModule } from "@mujoco/mujoco";
import { createHash } from "node:crypto";
import { applyPatch, type CaseDef, caseGrid, type GravityId, type Knobs, type Metrics, type ProbeResult, PROBES, type ProbeId, type World } from "./patch-probes";
import { type Book, historyLine, PATCH_SYSTEM, patchCheckLine, patchPrompt, retryPrompt, type Rule } from "./patch-prompts";

// --- the parts of the results file the builder reads (written by patch-loop.test.ts) ---
type CallRec = { ok: boolean; json_ok: boolean; finish: string | null; prompt_tokens: number; completion_tokens: number; reasoning_tokens: number | null };
export type SavedPatch = {
  set: Record<string, unknown> | null;
  why: string | null;
  expect: string | null;
  changed: string[];
  rejected: string[];
  clamps?: { name: string; requested: number; applied: number }[];
  call: CallRec;
  patcher?: string;
  retried_after_noop?: SavedPatch;
  escalated_after_noop?: SavedPatch;
};
export type SavedIter = { iter: number; knobs: Knobs; pass: boolean; score: number; failure_class: string | null; metrics: Metrics; patch_before?: SavedPatch };
export type SavedRun = { arm: string; case_id: string; probe: ProbeId; gravity: GravityId; seed: number; expert_pass: boolean; preflight?: SavedPatch; iterations: SavedIter[]; passed_at: number | null; stopped: string | null };
type CallCfg = { role: string; thinking: "off" | "on"; maxTokens: number; label?: string };
export type SavedArm = {
  config: CallCfg & { model: string; escalate_model?: string; preflight: boolean; rules: boolean; derived?: boolean; retryNoop?: boolean; distil?: number; rulesFrom?: string; emptyRules?: boolean; clampNote?: boolean; escalate?: CallCfg; liquid?: boolean };
  runs: SavedRun[];
  playbook?: { rules: Rule[]; version?: number };
};
export type SavedResults = { arms: Record<string, SavedArm> };

/** one model call of the loop, rebuilt */
export type Example = {
  case_id: string;
  probe: ProbeId;
  gravity: GravityId;
  seed: number;
  arm: string;
  /** the patch number in its run, 1..5 */
  attempt: number;
  /** "patch"; "noop" for a call whose patch changed nothing and was replaced (escalation, retry) */
  kind: "patch" | "noop";
  patcher: string;
  model: string;
  system: string;
  user: string;
  /** the answer as a JSON object, the way the model was asked to return it */
  assistant: string;
  /** the next rollout's verdict on this patch */
  pass_after: boolean;
  score_before: number;
  score_after: number;
  /** the prompt tokens Token Factory counted for this call: equal prompts must show equal counts */
  prompt_tokens: number;
  /** the answer's tokens, reasoning excluded */
  answer_tokens: number;
};

export const MAX_PATCHES = 5;
/** the salt of the split hash: change it and the split changes */
export const SPLIT_SALT = "understudy-ft-v1";
const PROBE_ORDER: ProbeId[] = ["insert", "place", "pour", "carry"];

/** FNV-1a, 32 bits: a small fixed hash, the same in every runtime */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}

/**
 * The held-out cases: per task, round(n / 3) of its n cases with solvable failures, taken in
 * the order of the hash of the case id; first at distinct gravities and disturbances, then
 * relaxing the disturbance, then the gravity. `failing` lists the case ids with at least one
 * solvable failure in the saved runs (controls that always pass, and unsolvable cases, add
 * nothing to train or test).
 */
export function heldOutCases(failing: Set<string>, cases: CaseDef[] = caseGrid()): string[] {
  const out: string[] = [];
  for (const probe of PROBE_ORDER) {
    const ids = cases.filter((c) => c.probe === probe && failing.has(c.id)).sort((a, b) => fnv1a(`${SPLIT_SALT}:${a.id}`) - fnv1a(`${SPLIT_SALT}:${b.id}`));
    const k = Math.round(ids.length / 3);
    const mine: CaseDef[] = [];
    for (const strict of [2, 1, 0]) {
      for (const c of ids) {
        if (mine.length === k || mine.includes(c)) continue;
        if (strict >= 1 && mine.some((m) => m.world.gravity === c.world.gravity)) continue;
        if (strict >= 2 && mine.some((m) => m.disturbance === c.disturbance)) continue;
        mine.push(c);
      }
    }
    out.push(...mine.map((c) => c.id));
  }
  return out;
}

/** the saved file's rounding (patch-loop.test.ts roundNumbers), to compare a replay with it */
const round = (v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? (Math.abs(v) >= 1 ? Math.round(v * 1000) / 1000 : Number(v.toPrecision(4))) : v);
const asSaved = (o: unknown) => JSON.stringify(o, (_k, v) => round(v));

/** the playbook a run's prompts carried, as the live loop built it */
export function bookOf(results: SavedResults, armId: string): Book {
  const cfg = results.arms[armId].config;
  if (!cfg.rules) return null;
  const pb = results.arms[cfg.rulesFrom ?? armId]?.playbook;
  if (!pb) throw new Error(`arm ${armId}: its playbook (${cfg.rulesFrom ?? armId}) is not in the results file`);
  return { rules: pb.rules, version: pb.version ?? cfg.distil ?? 1, empty: cfg.emptyRules };
}

const answer = (p: SavedPatch) => JSON.stringify({ set: p.set, why: p.why, expect: p.expect });
/** the results file keeps why and expect up to 400 characters: an answer that long was probably cut */
const CUT = 400;
/** a call that produced a usable answer: it returned, parsed, had a set, and was saved whole */
const usable = (p: SavedPatch) => p.call.ok && p.call.json_ok && p.set !== null && (p.why ?? "").length < CUT && (p.expect ?? "").length < CUT;

/**
 * True when a saved number has as many digits as the save keeps (3 decimals at 1 and above, 4
 * significant digits below), so it may be a longer number rounded on save.
 */
export function mayBeRounded(v: unknown): boolean {
  if (typeof v !== "number" || !Number.isFinite(v) || Number.isInteger(v)) return false;
  return Math.abs(v) >= 1 ? Number(v.toFixed(2)) !== v : Number(v.toPrecision(3)) !== v;
}
const patchesOf = (run: SavedRun) =>
  [run.preflight, ...run.iterations.map((it) => it.patch_before)].flatMap((p) => (p ? [p, ...(p.escalated_after_noop ? [p.escalated_after_noop] : []), ...(p.retried_after_noop ? [p.retried_after_noop] : [])] : []));
/** every number anywhere in a value (a model may nest an object where a knob value belongs) */
const numbersIn = (v: unknown): number[] => (typeof v === "number" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(numbersIn) : []);
/**
 * A number longer than the save keeps whose extra digits round away (1.0004 saved as 1) cannot be
 * seen; it would also show at the precision limit nine times in ten, so none at the limit in the
 * whole file (the build's count) puts the chance of such a number near zero.
 */
const roundedOnSave = (run: SavedRun) => patchesOf(run).some((p) => numbersIn(p.set).some(mayBeRounded) || (p.clamps ?? []).some((c) => mayBeRounded(c.requested)));

/**
 * Rollouts are deterministic in (case, seed, knobs, note options), and the arms share many of them
 * (every arm starts each case and seed from the same naive program): a cache saves most of the
 * replay time, which is mostly the bead pours at under a second each.
 */
export type RolloutCache = Map<string, ProbeResult>;

/**
 * Replay one saved run and rebuild the prompt and answer of every patch call in it. Returns the
 * examples, or the first point where the replay departs from the saved run (then no examples).
 */
export function replayRun(mj: MainModule, results: SavedResults, run: SavedRun, maxPatches = MAX_PATCHES, cache: RolloutCache = new Map()): { examples: Example[]; mismatch: string | null } {
  const arm = results.arms[run.arm];
  const cfg = arm.config;
  const c = caseGrid().find((x) => x.id === run.case_id);
  if (!c) return { examples: [], mismatch: "case not in the grid" };
  const probe = PROBES[run.probe];
  const world: World = { ...c.world, seed: run.seed };
  const book = bookOf(results, run.arm);
  const modelOf = (patcher: string | undefined) => (cfg.escalate && patcher === `${cfg.escalate.role}-${cfg.escalate.thinking}` ? (cfg.escalate_model ?? cfg.model) : cfg.model);
  const base = `${cfg.role}-${cfg.thinking}`;
  if (roundedOnSave(run)) return { examples: [], mismatch: "a patch number at the saved precision" };
  const examples: Example[] = [];
  let knobs: Knobs = { ...probe.naive };
  if (run.preflight) knobs = applyPatch(probe, knobs, run.preflight.set).knobs;
  const history: string[] = [];
  for (let i = 0; i < run.iterations.length; i++) {
    const it = run.iterations[i];
    if (asSaved(knobs) !== asSaved(it.knobs)) return { examples: [], mismatch: `iteration ${i}: knobs` };
    const key = `${run.case_id}|${run.seed}|${cfg.derived ? 1 : 0}|${JSON.stringify(knobs)}`;
    const r = cache.get(key) ?? probe.run(mj, knobs, world, { derived: cfg.derived });
    cache.set(key, r);
    if (r.pass !== it.pass || round(r.score) !== it.score || r.failure_class !== it.failure_class) return { examples: [], mismatch: `iteration ${i}: verdict` };
    if (asSaved(r.metrics) !== asSaved(it.metrics)) return { examples: [], mismatch: `iteration ${i}: metrics` };
    if (r.pass) break;
    history.push(historyLine(i, knobs, it.patch_before?.set, r.note, cfg.preflight));
    const next = run.iterations[i + 1];
    if (!next) break;
    const p = next.patch_before;
    if (!p) return { examples: [], mismatch: `iteration ${i + 1}: no patch saved` };
    const prompt = patchPrompt(run.probe, world, knobs, history, r.note, i + 1, book, cfg.clampNote ? patchCheckLine(it.patch_before) : null, maxPatches);
    const ex = (user: string, q: SavedPatch, kind: Example["kind"], pass: boolean, scoreAfter: number): Example => ({
      case_id: run.case_id,
      probe: run.probe,
      gravity: run.gravity,
      seed: run.seed,
      arm: run.arm,
      attempt: i + 1,
      kind,
      patcher: q.patcher ?? base,
      model: modelOf(q.patcher),
      system: PATCH_SYSTEM,
      user,
      assistant: answer(q),
      pass_after: pass,
      score_before: it.score,
      score_after: scoreAfter,
      prompt_tokens: q.call.prompt_tokens,
      answer_tokens: q.call.completion_tokens - (q.call.reasoning_tokens ?? 0),
    });
    // a replaced no-op saw the same prompt (escalation) or the prompt before the retry note; its rollout would have repeated this one
    const inner = p.escalated_after_noop ?? p.retried_after_noop;
    if (inner && usable(inner)) examples.push(ex(prompt, inner, "noop", false, it.score));
    if (usable(p)) examples.push(ex(p.retried_after_noop ? retryPrompt(prompt, p.retried_after_noop.set) : prompt, p, "patch", next.pass, next.score));
    knobs = applyPatch(probe, knobs, p.set).knobs;
  }
  return { examples, mismatch: null };
}

/**
 * Which arms feed the dataset: Nemotron patchers only (a comparison arm of another vendor's model
 * never becomes training data), no liquid pour (its solver changed after those runs, so they do not
 * replay), and no prompt that carries a distilled playbook (the rules were distilled from Earth and
 * Mars repairs that include held-out cases). The matched controls, whose playbook section reads
 * "(none)", stay in.
 */
export function armIncluded(arm: SavedArm): string | null {
  const c = arm.config;
  const nemotron = (m: string) => /^nvidia\/.*nemotron/i.test(m);
  if (!nemotron(c.model) || (c.escalate_model && !nemotron(c.escalate_model))) return "not a Nemotron patcher";
  if (c.liquid) return "liquid pour (the solver changed after these runs)";
  if (c.rules && !c.emptyRules) return "prompt carries distilled rules";
  return null;
}

export type Built = {
  test_cases: string[];
  train: Example[];
  val: Example[];
  pairs: { prompt: Example; chosen: Example; rejected: Example }[];
  stats: Record<string, unknown>;
};

/** messages for supervised fine-tuning */
export const chat = (e: Example) => ({ messages: [{ role: "system", content: e.system }, { role: "user", content: e.user }, { role: "assistant", content: e.assistant }] });
/** a preference pair in the conversational format of TRL's DPO trainer */
export const pairLine = (p: Built["pairs"][number]) => ({
  prompt: [{ role: "system", content: p.prompt.system }, { role: "user", content: p.prompt.user }],
  chosen: [{ role: "assistant", content: p.chosen.assistant }],
  rejected: [{ role: "assistant", content: p.rejected.assistant }],
});
/** the metadata of an example, line-aligned with its chat line in the *.meta.jsonl files */
export const metaLine = (e: Example) => ({ case_id: e.case_id, seed: e.seed, arm: e.arm, attempt: e.attempt, patcher: e.patcher, model: e.model, pass_after: e.pass_after, score_before: e.score_before, score_after: e.score_after, prompt_tokens: e.prompt_tokens, answer_tokens: e.answer_tokens });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Build the datasets from the saved results. Supervised examples are the patches whose next
 * rollout passed (the repair), on training cases, de-duplicated on (prompt, answer); about 5% of
 * them, by a hash of the prompt, go to validation (a prompt is on one side only). Preference pairs
 * join, for one prompt, a patch that passed with one that did not.
 */
export function buildDataset(mj: MainModule, results: SavedResults, opts: { onRun?: (done: number, total: number) => void } = {}): Built {
  const failing = new Set<string>();
  for (const arm of Object.values(results.arms)) for (const r of arm.runs) if (r.expert_pass && r.iterations[0] && !r.iterations[0].pass) failing.add(r.case_id);
  const test = heldOutCases(failing);
  const testSet = new Set(test);
  const arms: Record<string, { included: boolean; reason: string | null; runs: number; replayed: number; mismatched: Record<string, number> }> = {};
  const all: Example[] = [];
  const repaired = new Set<string>();
  for (const arm of Object.values(results.arms)) if (!armIncluded(arm)) for (const r of arm.runs) if (r.passed_at) repaired.add(`${r.case_id}|${r.seed}`);
  const cache: RolloutCache = new Map();
  const todo = Object.entries(results.arms).flatMap(([id, arm]) => {
    const reason = armIncluded(arm);
    arms[id] = { included: !reason, reason, runs: arm.runs.length, replayed: 0, mismatched: {} };
    // a run with no patch has nothing to rebuild; a case and seed that no run repaired gives neither a repair nor a pair
    return reason ? [] : arm.runs.filter((r) => !testSet.has(r.case_id) && !r.stopped && r.iterations.length > 1 && repaired.has(`${r.case_id}|${r.seed}`));
  });
  let done = 0;
  for (const run of todo) {
    const { examples, mismatch } = replayRun(mj, results, run, MAX_PATCHES, cache);
    const a = arms[run.arm];
    if (mismatch) {
      const key = mismatch.replace(/^iteration \d+: /, "");
      a.mismatched[key] = (a.mismatched[key] ?? 0) + 1;
    } else {
      a.replayed++;
      all.push(...examples);
    }
    opts.onRun?.(++done, todo.length);
  }
  const fixes = all.filter((e) => e.kind === "patch" && e.pass_after);
  const seen = new Set<string>();
  const unique = fixes.filter((e) => {
    const k = sha(`${e.user}\u0000${e.assistant}`);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const isVal = (e: Example) => fnv1a(`${SPLIT_SALT}:val:${e.user}`) % 20 === 0;
  const train = unique.filter((e) => !isVal(e));
  const val = unique.filter(isVal);
  // preference pairs: same prompt, a passing patch against each distinct failing one (training prompts only)
  const byPrompt = new Map<string, Example[]>();
  for (const e of all) if (!isVal(e)) byPrompt.set(e.user, [...(byPrompt.get(e.user) ?? []), e]);
  const pairs: Built["pairs"] = [];
  for (const group of byPrompt.values()) {
    const good = group.filter((e) => e.kind === "patch" && e.pass_after);
    if (!good.length) continue;
    const goodAnswers = new Set(good.map((e) => e.assistant));
    const bad = [...new Map(group.filter((e) => !e.pass_after && !goodAnswers.has(e.assistant)).map((e) => [e.assistant, e])).values()];
    bad.forEach((b, i) => pairs.push({ prompt: b, chosen: good[i % good.length], rejected: b }));
  }
  // fidelity: one model, one rebuilt prompt, one token count; a spread means the rebuild misses something the model saw
  const tokens = new Map<string, number[]>();
  for (const e of all) {
    const k = `${e.model}\u0000${e.patcher}\u0000${e.user}`;
    tokens.set(k, [...(tokens.get(k) ?? []), e.prompt_tokens]);
  }
  const repeated = [...tokens.values()].filter((t) => t.length > 1);
  const quantiles = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return { median: s[Math.floor((s.length - 1) / 2)], max: s.at(-1), total: s.reduce((a, b) => a + b, 0) };
  };
  const count = (xs: Example[], key: (e: Example) => string) => xs.reduce<Record<string, number>>((m, e) => ((m[key(e)] = (m[key(e)] ?? 0) + 1), m), {});
  return {
    test_cases: test,
    train,
    val,
    pairs,
    stats: {
      arms,
      runs_to_replay: todo.length,
      runs_replayed: Object.values(arms).reduce((n, a) => n + a.replayed, 0),
      runs_mismatched: Object.values(arms).reduce((n, a) => n + Object.values(a.mismatched).reduce((x, y) => x + y, 0), 0),
      calls_rebuilt: all.length,
      fidelity: { prompts_seen_more_than_once: repeated.length, with_differing_token_counts: repeated.filter((t) => new Set(t).size > 1).length },
      fixing_patches: fixes.length,
      duplicates_dropped: fixes.length - unique.length,
      train_by_probe: count(train, (e) => e.probe),
      train_by_gravity: count(train, (e) => e.gravity),
      train_by_patcher: count(train, (e) => e.patcher),
      val_by_probe: count(val, (e) => e.probe),
      patch_numbers_checked: todo.reduce((n, r) => n + patchesOf(r).flatMap((p) => numbersIn(p.set)).filter((v) => !Number.isInteger(v)).length, 0),
      train_prompt_tokens: quantiles(train.map((e) => e.prompt_tokens)),
      train_answer_tokens: quantiles(train.map((e) => e.answer_tokens)),
    },
  };
}
