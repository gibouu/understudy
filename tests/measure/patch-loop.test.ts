/**
 * The self-improvement loop, measured: the simulator is the reward signal,
 * the model is the policy editor.
 *
 * For each case (probe x gravity x disturbance x seed, tests/measure/patch-probes.ts)
 * iteration 0 runs the naive program; while it fails, a model reads the task,
 * the knobs with their bounds, the earlier attempts and the simulator's failure
 * note, and returns one JSON patch to the knobs (validated and clamped); the
 * probe runs again; at most 5 patches.
 *
 * Arms (PATCH_ARMS, comma separated, run in that order):
 *   super-off   Nemotron 3 Super, thinking off (the default patcher), every case
 *   super-on    Super with thinking on, 4,096-token budget, every case
 *   ultra       Nemotron 3 Ultra, thinking off, every case
 *   ultra-on    Ultra with thinking on, 4,096-token budget, every case
 *   ultra-on-16k  Ultra with thinking on, 16,000-token budget (4,096 truncates most of its pour answers)
 *   preflight   Moon and orbit cases; before iteration 0 Super sees the task and
 *               the world (no failure yet) and may patch; then the super-off loop
 *   playbook    as preflight, with rules that Super distilled from the super-off
 *               runs on Earth and Mars in the prompt from iteration 0 onward
 *   playbook2   as playbook, the rules distilled from the repairs described in words
 *   super-off-rep  a second super-off run, for run-to-run spread
 *   super-off-derived  super-off with one line of arithmetic added to each note (ablation)
 *   super-off-retry    super-off where a patch that changes nothing is sent back once (ablation)
 *
 * The live part spends Token Factory credits and runs only with BENCH_LIVE=1:
 *
 *   BENCH_LIVE=1 UNDERSTUDY_ENV_FILE=/path/to/.env.local PATCH_ARMS=super-off \
 *     node_modules/.bin/vitest run tests/measure/patch-loop.test.ts --reporter=verbose
 *
 * Every paid call goes through scripts/bench-ledger.mjs (guard before, charge
 * after; this script's cap PATCH_CAP_USD, default 30, under the global cap).
 * Results merge into bench/results/patch-loop.json by arm: knobs, patches,
 * metrics, tokens, cost and latency per iteration; no prompts, no key. The
 * summary tables print at the end of every live run, over every arm in the file.
 * Without BENCH_LIVE a cheap unit test of the probes runs (no network).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fmt, loadMujoco, mdTable } from "./gravity-harness";
import { applyPatch, type CaseDef, caseGrid, describeWorld, type GravityId, knobLines, type Knobs, liquidCaseGrid, type Metrics, PROBES, type ProbeId, type World } from "./patch-probes";

const ROOT = process.cwd();
/** PATCH_OUT names another bench/results/patch-*.json, for smoke runs */
const OUT = path.join(ROOT, "bench/results", process.env.PATCH_OUT ?? "patch-loop.json");
const MAX_PATCHES = Number(process.env.PATCH_MAX_ITERS ?? 5);
const SEEDS = (process.env.PATCH_SEEDS ?? "1,2,3").split(",").map(Number);
const CONCURRENCY = Number(process.env.PATCH_CONCURRENCY ?? 6);
const CAP_USD = Number(process.env.PATCH_CAP_USD ?? 30);
/** ledger script name; round 2 runs as patch-loop-r2 with its own cap */
const SCRIPT = process.env.PATCH_SCRIPT ?? "patch-loop";
const GRAVITY_ORDER: GravityId[] = ["earth", "mars", "moon", "orbit"];
const PROBE_ORDER: ProbeId[] = ["insert", "place", "pour", "carry"];

// --- the patcher's prompts ----------------------------------------------------------
const PATCH_SYSTEM = `You edit a small robot program after a failed rehearsal in a physics simulator. The program is a set of knobs with bounds. You get the task, the world, the knobs with their current values, the earlier attempts, and the simulator's failure note: what it measured in the failed rollout. Propose one patch: the knob values to change for the next rollout, the change most likely to make it pass. The success check is fixed and you cannot change it. Use only the listed knob names; keep numbers within bounds; booleans true or false; enum values exactly as listed.
Return one JSON object only: {"set":{<knob>:<value>,...},"why":<one sentence citing the measurement behind the change>,"expect":<one sentence: what the next rollout should show>}`;

const PREFLIGHT_SYSTEM = `You set up a small robot program before its first rehearsal in a physics simulator. The program is a set of knobs with bounds, currently at their defaults. You get the task, the world and the knobs. If the defaults are likely to fail in this world, propose one patch: the knob values to change before the first rollout; otherwise return an empty set. Use only the listed knob names; keep numbers within bounds; booleans true or false; enum values exactly as listed.
Return one JSON object only: {"set":{<knob>:<value>,...},"why":<one sentence>,"expect":<one sentence: what the first rollout should show>}`;

const PLAYBOOK_SYSTEM = `You maintain a playbook for a robot that rehearses short manipulation programs in a physics simulator under different gravities. You get repairs that worked: a program failed, a patch to its knobs made it pass. Write at most 8 general rules that a programmer could apply before the first rehearsal of these tasks in another world (another gravity, another disturbance). Each rule must be supported by the repairs: give the evidence (which probes and worlds, how many repairs). Prefer rules stated in physical terms (what to do when gravity is lower or absent, when the vehicle accelerates, when the object is offset) over rules that only restate one case.
Return one JSON object only: {"rules":[{"rule":string,"evidence":string}]}`;

const PLAYBOOK_SYSTEM_V3 = `${PLAYBOOK_SYSTEM.split("\nReturn one JSON object only")[0]} Tag each rule with the one task it was learned on (insert, place, pour or carry), or "all" only when repairs on two or more tasks support it: a tagged rule is shown only for its task. All the repairs come from Earth 1 g and Mars 0.379 g; say in each rule what it assumes about gravity.
Return one JSON object only: {"rules":[{"task":"insert"|"place"|"pour"|"carry"|"all","rule":string,"evidence":string}]}`;

type Rule = { rule: string; evidence: string; task?: string };
/** v1/v2: every rule for every task; v3: only the rules tagged with this task or "all", with the gravity range they come from */
const rulesBlock = (rules: Rule[], probe: ProbeId, version: number) => {
  if (version < 3) return `Playbook (rules learned from earlier repairs on Earth and Mars):\n${rules.map((r, i) => `${i + 1}. ${r.rule}`).join("\n")}`;
  const mine = rules.filter((r) => r.task === probe || r.task === "all");
  return mine.length ? `Playbook for this task (rules learned from repairs at Earth 1 g and Mars 0.379 g only; untested in other gravities):\n${mine.map((r, i) => `${i + 1}. ${r.rule}`).join("\n")}` : null;
};

/** the factual one-liner of a note used in the attempt history */
const outcomeLine = (note: string) => note.split("\n").find((l) => /^(Checks?|Count):/.test(l)) ?? note.split("\n").at(-1) ?? "";

type Book = { rules: Rule[]; version: number } | null;
const bookLines = (book: Book, probe: ProbeId) => {
  const b = book ? rulesBlock(book.rules, probe, book.version) : null;
  return b ? [b] : [];
};

/** what happened to the last patch's values, for the next prompt (round 2: no more silent clamping) */
function patchCheckLine(p: PatchRec | undefined): string | null {
  if (!p) return null;
  const parts = [
    ...(p.clamps ?? []).map((c) => `${c.name} = ${c.requested} is outside its bounds and was clamped to ${c.applied}`),
    ...p.rejected.map((n) => `${n} was not applied (not a knob, or not a usable value)`),
  ];
  return parts.length ? `Your last patch: ${parts.join("; ")}.` : null;
}

function patchPrompt(probeId: ProbeId, world: World, knobs: Knobs, history: string[], note: string, attempt: number, book: Book, check: string | null): string {
  const probe = PROBES[probeId];
  return [
    `Task: ${probe.task}`,
    `World: ${describeWorld(world)}.`,
    ...bookLines(book, probeId),
    `Knobs (current values):\n${knobLines(probe, knobs)}`,
    `Attempts so far:\n${history.join("\n")}`,
    ...(check ? [check] : []),
    `Failure note from the last rollout (attempt ${attempt - 1}):\n${note}`,
    `Return patch ${attempt} of at most ${MAX_PATCHES}.`,
  ].join("\n\n");
}

function preflightPrompt(probeId: ProbeId, world: World, knobs: Knobs, book: Book): string {
  const probe = PROBES[probeId];
  return [`Task: ${probe.task}`, `World: ${describeWorld(world)}.`, ...bookLines(book, probeId), `Knobs (defaults):\n${knobLines(probe, knobs)}`, "No rollout has run yet. Return the patch to apply before the first rollout (an empty set keeps the defaults)."].join("\n\n");
}

// --- types of the results file --------------------------------------------------------
type CallRec = { ok: boolean; ms: number; prompt_tokens: number; completion_tokens: number; reasoning_tokens: number | null; cost_usd: number; finish: string | null; json_ok: boolean; empty: boolean; error?: string; attempts: number };
type PatchRec = {
  set: Record<string, unknown> | null;
  why: string | null;
  expect: string | null;
  changed: string[];
  clamped: string[];
  rejected: string[];
  clamps?: { name: string; requested: number; applied: number }[];
  call: CallRec;
  /** which patcher wrote it (escalation arms) */
  patcher?: string;
  retried_after_noop?: PatchRec;
  /** escalation: the base patcher's no-op patch, replaced by the escalated patcher's */
  escalated_after_noop?: PatchRec;
};
type IterRec = { iter: number; knobs: Knobs; pass: boolean; score: number; failure_class: string | null; metrics: Metrics; patch_before?: PatchRec };
type RunRec = {
  arm: string;
  case_id: string;
  probe: ProbeId;
  gravity: GravityId;
  disturbance: string;
  seed: number;
  expert_pass: boolean;
  preflight?: PatchRec;
  iterations: IterRec[];
  passed_at: number | null;
  stopped: string | null;
  calls: number;
  cost_usd: number;
  tokens: number;
  latency_ms: number;
  /** escalation arms: the first patch written by the escalated patcher */
  escalated_at?: number | null;
};
type ArmRec = { config: Record<string, unknown>; started: string; finished: string | null; runs: RunRec[]; playbook?: { rules: Rule[]; call: CallRec; from_runs: number; version?: number } };
type ResultsFile = { measurement: string; generated_at: string; reproduce: string; conditions: Record<string, unknown>; arms: Record<string, ArmRec>; example_notes: Record<string, string>; summary?: unknown };

// --- the non-live unit test -----------------------------------------------------------
describe("patch probes (no network)", () => {
  it("validates patches, fails the naive programs where the physics says so, passes the expert ones", async () => {
    const mj = await loadMujoco();
    const insert = PROBES.insert;
    const p = applyPatch(insert, insert.naive, { release_height_mm: 99, hold_until_seated: "true", offset_correction_mm: "-4", bogus: 1, release_speed_mm_s: "fast" });
    expect(p.knobs.release_height_mm).toBe(40);
    expect(p.clamped).toEqual(["release_height_mm"]);
    expect(p.knobs.hold_until_seated).toBe(true);
    expect(p.knobs.offset_correction_mm).toBe(-4);
    expect(p.rejected.sort()).toEqual(["bogus", "release_speed_mm_s"]);
    expect(applyPatch(PROBES.pour, PROBES.pour.naive, { strategy: "Report infeasible" }).knobs.strategy).toBe("report-infeasible");
    expect(applyPatch(insert, insert.naive, null).changed).toEqual([]);

    const w = (gravity: GravityId, extra: Partial<World> = {}): World => ({ gravity, seed: 1, ...extra });
    const knobNames = Object.values(PROBES).flatMap((pr) => pr.knobs.map((k) => k.name));
    const check = (probeId: ProbeId, world: World) => {
      const pr = PROBES[probeId];
      const naive = pr.run(mj, pr.naive, world);
      const expert = pr.run(mj, pr.expert(world), world);
      for (const n of knobNames) expect(naive.note).not.toContain(n); // facts, not advice
      return { naive, expert };
    };
    // a 4 mm offset puts the tube on the rim at every gravity; the corrected, held insert seats
    for (const g of ["earth", "moon", "orbit"] as GravityId[]) {
      const r = check("insert", w(g, { offset_mm: 4 }));
      expect(r.naive.pass).toBe(false);
      expect(r.naive.note).toMatch(/[34]\.\d mm from the pocket centre along x/);
      expect(r.expert.pass).toBe(true);
    }
    // in orbit the tube let go at the slot mouth floats there
    const orbitInsert = check("insert", w("orbit"));
    expect(orbitInsert.naive.metrics.lowest_above_floor_mm as number).toBeGreaterThan(29);
    // a 0.2 g burst topples a free-standing tube; waiting it out does not
    const place = check("place", w("earth", { frame_g: 0.2 }));
    expect(place.naive.failure_class).toBe("toppled");
    expect(place.expert.pass).toBe(true);
    // the pour's infeasibility report is right only in orbit (no simulation needed)
    const report = { ...PROBES.pour.naive, strategy: "report-infeasible" };
    expect(PROBES.pour.run(mj, report, w("orbit")).pass).toBe(true);
    expect(PROBES.pour.run(mj, report, w("earth")).pass).toBe(false);
    // grid: every case is named once
    const ids = caseGrid().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 30_000);
});

// --- the live loop ----------------------------------------------------------------------
describe.skipIf(process.env.BENCH_LIVE !== "1")("patch loop (live, Token Factory)", () => {
  it(
    "runs the arms",
    async () => {
      process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");
      const KEY = process.env.NEBIUS_API_KEY;
      if (!KEY) throw new Error("NEBIUS_API_KEY missing from the env file");
      const redact = (s: unknown) => String(s).split(KEY).join("<redacted>");
      const tf = await import("@/lib/providers/tokenfactory");
      const ledger = (await import("../../scripts/bench-ledger.mjs")) as {
        guard: (est: number, o?: { script?: string; capUsd?: number }) => number;
        charge: (script: string, usd: number, meta?: Record<string, unknown>) => void;
        spent: (script?: string) => number;
        BudgetError: new (m: string) => Error;
      };
      const client = tf.tokenFactory({ timeout: 240_000, maxRetries: 0 });
      if (!client) throw new Error("no Token Factory client");
      const catalog = JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/models.json"), "utf8")) as { fetched: string; models: { id: string; pricing: { prompt: string; completion: string; input_cache_read: string | null } }[] };
      const price = (model: string) => {
        const m = catalog.models.find((x) => x.id === model);
        return m ? { prompt: Number(m.pricing.prompt), completion: Number(m.pricing.completion), cache: m.pricing.input_cache_read == null ? null : Number(m.pricing.input_cache_read) } : null;
      };
      const mj = await loadMujoco();
      const spentBefore = ledger.spent(SCRIPT);
      let inflight = 0;
      let budgetStop: string | null = null;

      type Role = "super" | "ultra";
      type CallCfg = { role: Role; thinking: "off" | "on"; maxTokens: number };
      async function call(cfg: CallCfg, system: string, user: string, meta: Record<string, unknown>): Promise<{ rec: CallRec; parsed: Record<string, unknown> | null }> {
        const model = tf.MODELS[cfg.role];
        const p = price(model) ?? { prompt: 0, completion: 0, cache: null };
        const worst = Math.ceil((system.length + user.length) / 3) * p.prompt + cfg.maxTokens * p.completion;
        const rec: CallRec = { ok: false, ms: 0, prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: null, cost_usd: 0, finish: null, json_ok: false, empty: true, attempts: 0 };
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (budgetStop) throw new ledger.BudgetError(budgetStop);
          try {
            ledger.guard(worst + inflight, { script: SCRIPT, capUsd: CAP_USD });
          } catch (e) {
            budgetStop = redact((e as Error).message);
            throw e;
          }
          inflight += worst;
          rec.attempts = attempt;
          const t0 = performance.now();
          try {
            const params: Record<string, unknown> = {
              model,
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              max_tokens: cfg.maxTokens,
              response_format: { type: "json_object" },
            };
            if (cfg.thinking === "off") Object.assign(params, tf.thinkingOff());
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const res = (await client!.chat.completions.create(params as any)) as any;
            const u = tf.usageOf(res);
            const cached = u.cached_tokens ?? 0;
            const cost = (u.prompt_tokens - cached) * p.prompt + cached * (p.cache ?? p.prompt) + u.completion_tokens * p.completion;
            ledger.charge(SCRIPT, cost, { model, thinking: cfg.thinking, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, reasoning_tokens: u.reasoning_tokens ?? null, ...meta });
            const text: string = res.choices?.[0]?.message?.content ?? "";
            Object.assign(rec, {
              ok: true,
              ms: Math.round(performance.now() - t0),
              prompt_tokens: u.prompt_tokens,
              completion_tokens: u.completion_tokens,
              reasoning_tokens: u.reasoning_tokens ?? null,
              cost_usd: cost,
              finish: res.choices?.[0]?.finish_reason ?? null,
              empty: text.trim() === "",
            });
            const parsed = parseJson(text);
            rec.json_ok = parsed !== null;
            return { rec, parsed };
          } catch (err) {
            const e = err as { status?: number; message?: string };
            rec.ms = Math.round(performance.now() - t0);
            rec.error = `${e?.status ?? "?"} ${redact(e?.message ?? err)}`.slice(0, 300);
            const retriable = e?.status === undefined || e.status === 429 || e.status >= 500;
            if (!retriable || attempt === 3) return { rec, parsed: null };
            await new Promise((r) => setTimeout(r, 2000 * attempt));
          } finally {
            inflight -= worst;
          }
        }
        return { rec, parsed: null };
      }

      const toPatch = (probeId: ProbeId, knobs: Knobs, parsed: Record<string, unknown> | null, rec: CallRec): { patch: PatchRec; knobs: Knobs } => {
        const set = parsed && typeof parsed.set === "object" && parsed.set !== null && !Array.isArray(parsed.set) ? (parsed.set as Record<string, unknown>) : null;
        const chk = applyPatch(PROBES[probeId], knobs, set);
        const s = (v: unknown) => (typeof v === "string" ? v.slice(0, 400) : null);
        return { patch: { set, why: s(parsed?.why), expect: s(parsed?.expect), changed: chk.changed, clamped: chk.clamped, rejected: chk.rejected, ...(chk.clamps.length ? { clamps: chk.clamps } : {}), call: rec }, knobs: chk.knobs };
      };

      /** derived: notes with the arithmetic line (NoteOptions); retryNoop: a patch that changes nothing is sent back once */
      /**
       * round 2: clampNote tells the patcher when a value was clamped or rejected; escalate switches
       * to a stronger patcher for the rest of the run after a no-op patch (re-asked at once) or after
       * the base patcher's second failed patch; rulesFrom reuses another arm's playbook; distil 3 tags
       * rules by task; liquid runs the pour-liquid cases instead of the bead grid
       */
      type ArmCfg = CallCfg & {
        preflight: boolean;
        rules: boolean;
        gravities: GravityId[];
        derived?: boolean;
        retryNoop?: boolean;
        distil?: 1 | 2 | 3;
        rulesFrom?: string;
        clampNote?: boolean;
        escalate?: CallCfg & { label: string };
        label?: string;
        liquid?: boolean;
      };
      const SUPER_OFF: CallCfg = { role: "super", thinking: "off", maxTokens: 800 };
      const SUPER_ON: CallCfg = { role: "super", thinking: "on", maxTokens: 4096 };
      const ESC_ON = { ...SUPER_ON, label: "super-on" };
      const ESC_ULTRA = { role: "ultra" as const, thinking: "off" as const, maxTokens: 800, label: "ultra-off" };
      const R2 = { preflight: false, rules: false, gravities: GRAVITY_ORDER, clampNote: true };
      const R2_MO = { preflight: true, rules: true, gravities: ["moon", "orbit"] as GravityId[], clampNote: true };
      const ARMS: Record<string, ArmCfg> = {
        "super-off": { role: "super", thinking: "off", maxTokens: 800, preflight: false, rules: false, gravities: GRAVITY_ORDER },
        "super-off-rep": { role: "super", thinking: "off", maxTokens: 800, preflight: false, rules: false, gravities: GRAVITY_ORDER },
        "super-on": { role: "super", thinking: "on", maxTokens: 4096, preflight: false, rules: false, gravities: GRAVITY_ORDER },
        ultra: { role: "ultra", thinking: "off", maxTokens: 800, preflight: false, rules: false, gravities: GRAVITY_ORDER },
        "ultra-on": { role: "ultra", thinking: "on", maxTokens: 4096, preflight: false, rules: false, gravities: GRAVITY_ORDER },
        "ultra-on-16k": { role: "ultra", thinking: "on", maxTokens: 16000, preflight: false, rules: false, gravities: GRAVITY_ORDER },
        preflight: { role: "super", thinking: "off", maxTokens: 800, preflight: true, rules: false, gravities: ["moon", "orbit"] },
        playbook: { role: "super", thinking: "off", maxTokens: 800, preflight: true, rules: true, gravities: ["moon", "orbit"] },
        playbook2: { role: "super", thinking: "off", maxTokens: 800, preflight: true, rules: true, gravities: ["moon", "orbit"], distil: 2 },
        "super-off-derived": { role: "super", thinking: "off", maxTokens: 800, preflight: false, rules: false, gravities: GRAVITY_ORDER, derived: true },
        "super-off-retry": { role: "super", thinking: "off", maxTokens: 800, preflight: false, rules: false, gravities: GRAVITY_ORDER, retryNoop: true },
        // round 2 (clamping reported to the patcher)
        "r2-super-off": { ...SUPER_OFF, ...R2, label: "super-off" },
        "r2-super-on": { ...SUPER_ON, ...R2, label: "super-on" },
        "r2-esc-on": { ...SUPER_OFF, ...R2, escalate: ESC_ON, label: "super-off -> super-on" },
        "r2-esc-ultra": { ...SUPER_OFF, ...R2, escalate: ESC_ULTRA, label: "super-off -> ultra-off" },
        "r2-playbook2-on": { ...SUPER_ON, ...R2_MO, rulesFrom: "playbook2", label: "super-on" },
        "r2-playbook3": { ...SUPER_OFF, ...R2_MO, distil: 3, label: "super-off" },
        "r2-playbook3-on": { ...SUPER_ON, ...R2_MO, distil: 3, rulesFrom: "r2-playbook3", label: "super-on" },
        "r2-playbook3-esc": { ...SUPER_OFF, ...R2_MO, distil: 3, rulesFrom: "r2-playbook3", escalate: ESC_ON, label: "super-off -> super-on" },
        "r2-liquid-super-off": { ...SUPER_OFF, ...R2, liquid: true, label: "super-off" },
        "r2-liquid-super-on": { ...SUPER_ON, ...R2, liquid: true, label: "super-on" },
      };

      const file: ResultsFile = existsSync(OUT)
        ? JSON.parse(readFileSync(OUT, "utf8"))
        : {
            measurement: "patch-loop",
            generated_at: "",
            reproduce: "BENCH_LIVE=1 UNDERSTUDY_ENV_FILE=<path to .env.local> PATCH_ARMS=super-off,super-on,ultra,preflight,playbook node_modules/.bin/vitest run tests/measure/patch-loop.test.ts --reporter=verbose",
            conditions: {},
            arms: {},
            example_notes: {},
          };
      file.reproduce =
        "round 1: BENCH_LIVE=1 UNDERSTUDY_ENV_FILE=<path to .env.local> PATCH_ARMS=super-off,super-off-rep,super-on,ultra,ultra-on,ultra-on-16k,preflight,playbook,playbook2,super-off-derived,super-off-retry node_modules/.bin/vitest run tests/measure/patch-loop.test.ts --reporter=verbose; round 2: the same with PATCH_SCRIPT=patch-loop-r2 PATCH_SEEDS=1,2,3,4,5,6 PATCH_ARMS=r2-playbook3,r2-super-off,r2-super-on,r2-esc-on,r2-esc-ultra,r2-playbook2-on,r2-playbook3-on,r2-playbook3-esc,r2-liquid-super-off,r2-liquid-super-on (arms can run one per process; they merge by arm)";
      file.conditions = {
        engine: "MuJoCo WebAssembly (@mujoco/mujoco) in Node, timestep 2 ms; probes in tests/measure/patch-probes.ts on tests/measure/gravity-harness.ts",
        models: tf.MODELS,
        base_url: tf.TOKEN_FACTORY_BASE_URL,
        prices: `list prices from tests/fixtures/models.json (fetched ${catalog.fetched})`,
        request: "chat.completions, response_format json_object, temperature left at the model default (not sent), no streaming; thinking off = chat_template_kwargs.enable_thinking false; thinking on = default reasoning with max_tokens 4096 covering reasoning and answer; up to 2 retries on network errors, 429 and 5xx",
        loop: `iteration 0 = the probe's naive program; on a fail the patcher gets the task, the world line, the knobs with bounds and meaning, one line per earlier attempt (knobs or patch, and the check line of its note) and the last failure note; its "set" is validated and clamped (patch-probes.ts applyPatch); at most ${MAX_PATCHES} patches; a failed or unparseable call counts as a patch that changes nothing`,
        world_line: "the patcher is told the gravity; hand-off velocity, offsets and vehicle bursts reach it only through measurements in the failure note",
        expert_check: "each case/seed also runs a hand-written expert program; a case whose expert fails is reported as unsolvable with these knobs",
        seeds: "per arm, in each arm's config",
        round_2: "arms named r2-*: the next patch prompt says when a requested value was clamped to a bound or rejected; escalation arms switch patcher after a no-op patch (re-asked at once) or after the base patcher's second failed patch; ledger script patch-loop-r2 with its own cap",
        liquid: "pour-liquid: lib/sim/fluid.ts position-based liquid, 600 particles at 4 mm (38 mL), one-way coupled to the MuJoCo cups via lib/sim/fluid-mujoco.ts, 60 frames/s with the solver's defaults",
        concurrency: CONCURRENCY,
        cap_usd: CAP_USD,
      };
      const mineArms = new Set<string>();
      /** take the arms other processes have written since this one started */
      const refresh = () => {
        if (!existsSync(OUT)) return;
        const disk = JSON.parse(readFileSync(OUT, "utf8")) as ResultsFile;
        for (const [id, arm] of Object.entries(disk.arms)) if (!mineArms.has(id)) file.arms[id] = arm;
      };
      /** merge this process's arms into whatever is on disk now, so arms can run in parallel processes */
      const save = () => {
        refresh();
        file.generated_at = new Date().toISOString();
        file.summary = summarise(file);
        let body = serialise(file);
        if (body.includes(KEY)) body = redact(body);
        writeFileSync(OUT, body);
      };

      const only = (c: CaseDef) => !process.env.PATCH_ONLY || process.env.PATCH_ONLY.split(",").some((s) => c.id.includes(s));
      const cases = caseGrid().filter(only);
      const liquidCases = liquidCaseGrid().filter(only);
      // example notes: the naive failure of one case per probe
      for (const id of ["insert/orbit/offset-6mm+handoff5", "place/moon/frame0.05g", "pour/earth/target+30mm", "carry/moon/cup"]) {
        const c = caseGrid().find((x) => x.id === id)!;
        const pr = PROBES[c.probe];
        file.example_notes[id] = pr.run(mj, pr.naive, { ...c.world, seed: 1 }).note;
      }

      async function runCase(armId: string, cfg: ArmCfg, c: CaseDef, seed: number, book: Book): Promise<RunRec> {
        const world: World = { ...c.world, seed };
        const probe = PROBES[c.probe];
        const run: RunRec = { arm: armId, case_id: c.id, probe: c.probe, gravity: c.world.gravity, disturbance: c.disturbance, seed, expert_pass: probe.run(mj, probe.expert(world), world).pass, iterations: [], passed_at: null, stopped: null, calls: 0, cost_usd: 0, tokens: 0, latency_ms: 0 };
        const account = (r: CallRec) => {
          run.calls++;
          run.cost_usd += r.cost_usd;
          run.tokens += r.prompt_tokens + r.completion_tokens;
          run.latency_ms += r.ms;
        };
        const meta = (iter: number) => ({ arm: armId, case: c.id, seed, iter });
        let knobs: Knobs = { ...probe.naive };
        try {
          if (cfg.preflight) {
            const { rec, parsed } = await call(cfg, PREFLIGHT_SYSTEM, preflightPrompt(c.probe, world, knobs, book), meta(-1));
            account(rec);
            const out = toPatch(c.probe, knobs, parsed, rec);
            run.preflight = out.patch;
            knobs = out.knobs;
          }
          const history: string[] = [];
          let pending: PatchRec | undefined;
          let escalated = false;
          let basePatches = 0;
          const label = (p: CallCfg) => `${p.role}-${p.thinking}`;
          for (let iter = 0; iter <= MAX_PATCHES; iter++) {
            const r = probe.run(mj, knobs, world, { derived: cfg.derived });
            run.iterations.push({ iter, knobs: { ...knobs }, pass: r.pass, score: r.score, failure_class: r.failure_class, metrics: r.metrics, ...(pending ? { patch_before: pending } : {}) });
            if (r.pass) {
              run.passed_at = iter;
              break;
            }
            history.push(iter === 0 ? `- attempt 0${cfg.preflight ? " (after your set-up patch)" : ""}: ${JSON.stringify(knobs)} -> FAIL. ${outcomeLine(r.note)}` : `- attempt ${iter}: set ${JSON.stringify(pending?.set ?? {})} -> FAIL. ${outcomeLine(r.note)}`);
            if (iter === MAX_PATCHES) break;
            const prompt = patchPrompt(c.probe, world, knobs, history, r.note, iter + 1, book, cfg.clampNote ? patchCheckLine(pending) : null);
            const who: CallCfg = escalated && cfg.escalate ? cfg.escalate : cfg;
            const { rec, parsed } = await call(who, PATCH_SYSTEM, prompt, { ...meta(iter + 1), patcher: label(who) });
            account(rec);
            let out = toPatch(c.probe, knobs, parsed, rec);
            out.patch.patcher = label(who);
            if (cfg.escalate && !escalated) {
              basePatches++;
              if (!out.patch.changed.length) {
                // a no-op from the base patcher: ask the escalated one at once, and keep it
                escalated = true;
                run.escalated_at = iter + 1;
                const up = await call(cfg.escalate, PATCH_SYSTEM, prompt, { ...meta(iter + 1), patcher: label(cfg.escalate), escalation: "noop" });
                account(up.rec);
                const second = toPatch(c.probe, knobs, up.parsed, up.rec);
                out = { knobs: second.knobs, patch: { ...second.patch, patcher: label(cfg.escalate), escalated_after_noop: out.patch } };
              } else if (basePatches >= 2) {
                escalated = true;
                run.escalated_at = iter + 2;
              }
            }
            if (cfg.retryNoop && !out.patch.changed.length) {
              const again = await call(cfg, PATCH_SYSTEM, `${prompt}\n\nYour patch ${JSON.stringify(out.patch.set ?? {})} changes no knob value: the next rollout would repeat the last one exactly. Propose a different change.`, { ...meta(iter + 1), retry: true });
              account(again.rec);
              const second = toPatch(c.probe, knobs, again.parsed, again.rec);
              out = { knobs: second.knobs, patch: { ...second.patch, retried_after_noop: out.patch } };
            }
            pending = out.patch;
            knobs = out.knobs;
          }
        } catch (e) {
          if (!(e instanceof ledger.BudgetError)) throw e;
          run.stopped = redact((e as Error).message);
        }
        return run;
      }

      async function pool<T>(items: (() => Promise<T>)[], n: number): Promise<T[]> {
        const out: T[] = new Array(items.length);
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(n, items.length) }, async () => {
            while (next < items.length) {
              const i = next++;
              out[i] = await items[i]();
            }
          }),
        );
        return out;
      }

      /**
       * v1 lists each repair by case id with the knobs before the last patch and that patch;
       * v2 describes the world and the disturbance in words and gives the knobs that changed
       * from the defaults to the passing program (v1's terse ids led Super to read
       * "frame0.05g" as a gravity).
       */
      async function distil(version: 1 | 2 | 3): Promise<NonNullable<ArmRec["playbook"]>> {
        const base = file.arms["super-off"];
        if (!base) throw new Error("the playbook needs the super-off arm in bench/results/patch-loop.json first");
        const fixes = base.runs.filter((r) => (r.gravity === "earth" || r.gravity === "mars") && r.passed_at !== null && r.passed_at > 0);
        const caseOf = (id: string) => caseGrid().find((c) => c.id === id)!;
        const lines2 = fixes.map((r) => {
          const c = caseOf(r.case_id);
          const final = r.iterations[r.passed_at!].knobs;
          const naive = PROBES[r.probe].naive;
          const diff = Object.fromEntries(Object.entries(final).filter(([k, v]) => v !== naive[k]));
          return `- ${r.probe}; ${describeWorld({ ...c.world, seed: r.seed })}; ${disturbanceWords(c.world)}: the defaults failed (${r.iterations[0].failure_class}); passed after ${r.passed_at} patch${r.passed_at === 1 ? "" : "es"} with ${JSON.stringify(diff)} changed from the defaults.`;
        });
        const lines = version >= 2 ? lines2 : fixes.map((r) => {
          const before = r.iterations[r.passed_at! - 1];
          const last = r.iterations[r.passed_at!];
          return `- ${r.case_id} (seed ${r.seed}): failed with ${JSON.stringify(before.knobs)} (${before.failure_class}); passed after set ${JSON.stringify(last.patch_before?.set ?? {})}${r.passed_at! > 1 ? ` (${r.passed_at} patches in all; earlier ones: ${r.iterations
            .slice(1, r.passed_at!)
            .map((it) => JSON.stringify(it.patch_before?.set ?? {}))
            .join(", ")})` : ""}`;
        });
        const user = [`Probes and their knobs:\n${PROBE_ORDER.map((p) => `${p}: ${PROBES[p].task}\n${knobLines(PROBES[p], PROBES[p].naive)}`).join("\n\n")}`, `Repairs that worked (${fixes.length}), Earth 1 g and Mars 0.379 g:\n${lines.join("\n")}`].join("\n\n");
        const arm = version === 3 ? "r2-playbook3" : version === 2 ? "playbook2" : "playbook";
        const system = version === 3 ? PLAYBOOK_SYSTEM_V3 : PLAYBOOK_SYSTEM;
        let res = await call({ role: "super", thinking: "on", maxTokens: 8000 }, system, user, { arm, stage: "distil" });
        if (!Array.isArray(res.parsed?.rules)) res = await call({ role: "super", thinking: "off", maxTokens: 2000 }, system, user, { arm, stage: "distil-retry" });
        const tasks = ["insert", "place", "pour", "carry", "all"];
        const rules: Rule[] = (Array.isArray(res.parsed?.rules) ? (res.parsed!.rules as unknown[]) : [])
          .slice(0, 8)
          .map((r) => {
            if (typeof r !== "object" || r === null) return { rule: String(r), evidence: "" };
            const o = r as { rule?: unknown; evidence?: unknown; task?: unknown };
            const task = String(o.task ?? "").toLowerCase();
            return { rule: String(o.rule ?? ""), evidence: String(o.evidence ?? ""), ...(version === 3 ? { task: tasks.includes(task) ? task : "all" } : {}) };
          })
          .filter((r) => r.rule.trim());
        if (!rules.length) throw new Error("the playbook call returned no rules");
        return { rules, call: res.rec, from_runs: fixes.length, version };
      }

      const arms = (process.env.PATCH_ARMS ?? "super-off").split(",").map((s) => s.trim()).filter(Boolean);
      for (const armId of arms) {
        const cfg = ARMS[armId];
        if (!cfg) throw new Error(`unknown arm ${armId}`);
        if (budgetStop) break;
        const started = performance.now();
        let playbook: ArmRec["playbook"] | undefined;
        refresh();
        if (cfg.rules) {
          const from = cfg.rulesFrom ?? armId;
          playbook = file.arms[from]?.playbook && process.env.PATCH_REDISTIL !== "1" ? file.arms[from].playbook : await distil(cfg.distil ?? 1);
        }
        const book: Book = playbook ? { rules: playbook.rules, version: playbook.version ?? cfg.distil ?? 1 } : null;
        const mine = (cfg.liquid ? liquidCases : cases).filter((c) => cfg.gravities.includes(c.world.gravity));
        const jobs = mine.flatMap((c) => SEEDS.map((seed) => () => runCase(armId, cfg, c, seed, book)));
        console.log(`\n== arm ${armId}: ${jobs.length} case runs (${mine.length} cases x ${SEEDS.length} seeds), ledger for ${SCRIPT} at $${ledger.spent(SCRIPT).toFixed(4)}`);
        const arm: ArmRec = { config: { ...cfg, model: tf.MODELS[cfg.role], ...(cfg.escalate ? { escalate_model: tf.MODELS[cfg.escalate.role] } : {}), seeds: SEEDS, ledger_script: SCRIPT }, started: new Date().toISOString(), finished: null, runs: [], ...(playbook ? { playbook } : {}) };
        let done = 0;
        arm.runs = await pool(
          jobs.map((job) => async () => {
            const r = await job();
            done++;
            if (done % 12 === 0 || done === jobs.length) console.log(`  ${armId}: ${done}/${jobs.length} runs, $${ledger.spent(SCRIPT).toFixed(4)} on the ledger for ${SCRIPT}`);
            return r;
          }),
          CONCURRENCY,
        );
        arm.finished = new Date().toISOString();
        arm.config.wall_s = Math.round((performance.now() - started) / 1000);
        file.arms[armId] = arm;
        mineArms.add(armId);
        save();
        console.log(`  arm ${armId} done in ${arm.config.wall_s} s`);
      }
      save();
      console.log(report(file));
      console.log(`\nspent this run $${(ledger.spent(SCRIPT) - spentBefore).toFixed(4)}; ${SCRIPT} on the ledger $${ledger.spent(SCRIPT).toFixed(4)} of its $${CAP_USD} cap; ledger total $${ledger.spent().toFixed(4)}${budgetStop ? `\nSTOPPED: ${budgetStop}` : ""}`);
    },
    8 * 3600_000,
  );
});

// --- helpers --------------------------------------------------------------------------
/** numbers to 4 significant digits (3 decimals at 1 and above); keeps the file a few MB */
const roundNumbers = (_k: string, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? (Math.abs(v) >= 1 ? Math.round(v * 1000) / 1000 : Number(v.toPrecision(4))) : v);

/** pretty at the top, one line per run */
function serialise(file: ResultsFile): string {
  const runs: Record<string, RunRec[]> = {};
  const slim = { ...file, arms: Object.fromEntries(Object.entries(file.arms).map(([id, arm]) => ((runs[id] = arm.runs), [id, { ...arm, runs: `@@runs:${id}@@` }]))) };
  let body = JSON.stringify(slim, roundNumbers, 2);
  for (const [id, rs] of Object.entries(runs)) {
    const lines = rs.map((r) => `        ${JSON.stringify(r, roundNumbers)}`).join(",\n");
    body = body.replace(`"@@runs:${id}@@"`, () => (rs.length ? `[\n${lines}\n      ]` : "[]")); // a function: "$" in the text stays literal
  }
  return body + "\n";
}
/** a case's disturbance in words, for the playbook distillation (post hoc, so it may name what the loop only measured) */
function disturbanceWords(w: Omit<World, "seed">): string {
  const parts = [
    w.object ? `object: ${w.object === "cup" ? "the open cup of beads" : "the tube in its rack"}` : "",
    w.offset_mm ? `the tube arrives ${w.offset_mm > 0 ? "+" : ""}${w.offset_mm} mm off the pocket centre along x` : "",
    w.handoff_mm_s ? `hand-off velocity ${w.handoff_mm_s} mm/s at the default hand speed` : "",
    w.frame_g ? `the vehicle accelerates at ${w.frame_g} g (${(w.frame_g * 9.81).toFixed(2)} m/s²) along +x for about 1.5 s from the start of the step` : "",
    w.target_shift_mm ? `the target cup sits ${w.target_shift_mm} mm farther than nominal` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "no disturbance";
}
/** strip think blocks and fences, then parse the first balanced JSON object (as scripts/bench-session.mjs) */
function parseJson(text: string): Record<string, unknown> | null {
  let s = (text ?? "").trimStart();
  while (s.startsWith("<think>")) {
    const end = s.indexOf("</think>");
    if (end < 0) return null;
    s = s.slice(end + 8).trimStart();
  }
  s = s.replace(/^```(?:json)?\s*/i, "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        try {
          const v = JSON.parse(s.slice(start, i + 1));
          return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// --- summary ---------------------------------------------------------------------------
const pct = (k: number, n: number) => (n ? `${Math.round((100 * k) / n)}% (${k}/${n})` : "-");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function curve(runs: RunRec[]) {
  return Array.from({ length: MAX_PATCHES + 1 }, (_, k) => runs.filter((r) => r.passed_at !== null && r.passed_at <= k).length);
}
const allCalls = (r: RunRec) => [
  ...(r.preflight ? [r.preflight.call] : []),
  ...r.iterations.flatMap((it) => {
    const p = it.patch_before;
    if (!p) return [];
    return [p.call, ...(p.retried_after_noop ? [p.retried_after_noop.call] : []), ...(p.escalated_after_noop ? [p.escalated_after_noop.call] : [])];
  }),
];

/** Wilson score interval, 95% */
function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [NaN, NaN];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const pctCI = (k: number, n: number) => {
  if (!n) return "-";
  const [lo, hi] = wilson(k, n);
  return `${Math.round((100 * k) / n)}% [${Math.round(100 * lo)}-${Math.round(100 * hi)}] (${k}/${n})`;
};
const allPatches = (r: RunRec) => r.iterations.flatMap((it) => (it.patch_before ? [{ it, p: it.patch_before }] : []));

function armStats(runs: RunRec[]) {
  const solvable = runs.filter((r) => r.expert_pass);
  const needFix = solvable.filter((r) => r.iterations[0] && !r.iterations[0].pass);
  const fixed = needFix.filter((r) => r.passed_at !== null);
  const calls = runs.flatMap(allCalls);
  const patches = runs.flatMap(allPatches);
  // a patch makes things worse when the next rollout scores lower than the one it was meant to fix
  const worse = runs.flatMap((r) => r.iterations.slice(1).filter((it, i) => it.score < r.iterations[i].score - 0.05));
  const cost = runs.reduce((n, r) => n + r.cost_usd, 0);
  return {
    runs: runs.length,
    solvable: solvable.length,
    need_fix: needFix.length,
    fixed: fixed.length,
    curve_all: curve(runs),
    curve_need_fix: curve(needFix),
    mean_patches_to_pass: mean(fixed.map((r) => r.passed_at!)),
    never: needFix.length - fixed.length,
    unsolvable_runs: runs.length - solvable.length,
    unsolvable_passed: runs.filter((r) => !r.expert_pass && r.passed_at !== null).length,
    calls: calls.length,
    failed_calls: calls.filter((c) => !c.ok).length,
    unparsed: calls.filter((c) => c.ok && !c.json_ok).length,
    empty: calls.filter((c) => c.ok && c.empty).length,
    no_change_patches: patches.filter(({ p }) => !p.changed.length).length,
    clamped_patches: patches.filter(({ p }) => p.clamped.length).length,
    rejected_patches: patches.filter(({ p }) => p.rejected.length).length,
    knobs_per_patch: mean(patches.map(({ p }) => p.changed.length)),
    worse_patches: worse.length,
    patches: patches.length,
    cost_usd: cost,
    cost_per_fixed_usd: fixed.length ? cost / fixed.length : null,
    prompt_tokens: calls.reduce((n, c) => n + c.prompt_tokens, 0),
    completion_tokens: calls.reduce((n, c) => n + c.completion_tokens, 0),
    reasoning_tokens: calls.reduce((n, c) => n + (c.reasoning_tokens ?? 0), 0),
    latency_mean_s: mean(calls.filter((c) => c.ok).map((c) => c.ms / 1000)),
    latency_p90_s: (() => {
      const xs = calls.filter((c) => c.ok).map((c) => c.ms / 1000).sort((a, b) => a - b);
      return xs.length ? xs[Math.floor(0.9 * (xs.length - 1))] : NaN;
    })(),
  };
}

function summarise(file: ResultsFile) {
  const out: Record<string, unknown> = {};
  for (const [id, arm] of Object.entries(file.arms)) {
    const runs = arm.runs;
    out[id] = {
      overall: armStats(runs),
      by_gravity: Object.fromEntries(GRAVITY_ORDER.map((g) => [g, armStats(runs.filter((r) => r.gravity === g))])),
      by_probe: Object.fromEntries([...PROBE_ORDER, "pour-liquid" as const].filter((p) => runs.some((r) => r.probe === p)).map((p) => [p, armStats(runs.filter((r) => r.probe === p))])),
    };
  }
  return out;
}

function report(file: ResultsFile): string {
  const lines: string[] = [];
  const head = ["", "runs", ...Array.from({ length: MAX_PATCHES + 1 }, (_, k) => `after ${k}`), "mean patches to pass", "never"];
  const row = (label: string, runs: RunRec[], onlyNeedFix = false) => {
    const s = armStats(runs);
    const base = onlyNeedFix ? s.need_fix : s.runs;
    const c = onlyNeedFix ? s.curve_need_fix : s.curve_all;
    return [label, String(base), ...c.map((k) => pct(k, base)), fmt(s.mean_patches_to_pass, 2), `${s.never}${s.unsolvable_runs ? ` (+${s.unsolvable_runs} unsolvable)` : ""}`];
  };
  for (const [id, arm] of Object.entries(file.arms)) {
    const runs = arm.runs;
    lines.push(`\n### Learning curve, arm ${id} (${arm.config.model}, thinking ${arm.config.thinking}${arm.config.preflight ? ", set-up patch before iteration 0" : ""}${arm.config.rules ? ", playbook in the prompt" : ""}): pass rate after iteration k, cumulative`);
    lines.push(
      mdTable(head, [
        row("all runs", runs),
        row("runs that fail at iteration 0 (solvable)", runs.filter((r) => r.expert_pass), true),
        ...GRAVITY_ORDER.filter((g) => runs.some((r) => r.gravity === g)).map((g) => row(`gravity ${g}`, runs.filter((r) => r.gravity === g))),
        ...PROBE_ORDER.filter((p) => runs.some((r) => r.probe === p)).map((p) => row(`probe ${p}`, runs.filter((r) => r.probe === p))),
      ]),
    );
    const s = armStats(runs);
    lines.push(
      `\n${id}: cost $${s.cost_usd.toFixed(4)} for ${s.runs} runs; ${s.fixed} of ${s.need_fix} solvable failing runs fixed, $${s.cost_per_fixed_usd === null ? "-" : s.cost_per_fixed_usd.toFixed(5)} per fixed run; ${s.calls} calls (${s.failed_calls} failed, ${s.unparsed} unparseable, ${s.empty} empty), ${s.patches} patches (${s.no_change_patches} changed nothing, ${s.clamped_patches} clamped, ${s.rejected_patches} with rejected fields, ${fmt(s.knobs_per_patch, 2)} knobs changed per patch, ${s.worse_patches} made the next rollout score lower); latency mean ${fmt(s.latency_mean_s, 1)} s, p90 ${fmt(s.latency_p90_s, 1)} s; tokens ${s.prompt_tokens} in / ${s.completion_tokens} out (${s.reasoning_tokens} reasoning)`,
    );
    const never = runs.filter((r) => r.expert_pass && !r.iterations[0]?.pass && r.passed_at === null);
    if (never.length) lines.push(`never converged (solvable): ${[...new Set(never.map((r) => r.case_id))].map((id2) => `${id2} x${never.filter((r) => r.case_id === id2).length}`).join(", ")}`);
  }
  // patcher comparison on the cases every compared arm ran
  const full = Object.keys(file.arms).filter((a) => {
    const g = new Set(file.arms[a].runs.map((r) => r.gravity));
    return g.size === 4 && file.arms[a].runs.every((r) => r.probe !== "pour-liquid") && !file.arms[a].config.preflight;
  });
  if (full.length > 1) {
    lines.push("\n### Patcher comparison (bead grid, runs that fail at iteration 0 and are solvable; fix rates with Wilson 95% intervals)");
    lines.push(
      mdTable(
        ["arm", "patcher", "seeds", "fixed by 5 patches", "after 1 patch", "after 2", "mean patches to pass", "patches by the escalated model", "worse patches", "cost", "cost per fixed run", "mean latency per call", "model time per fixed run"],
        full.map((a) => {
          const arm = file.arms[a];
          const s = armStats(arm.runs);
          const c = s.curve_need_fix;
          const patches = arm.runs.flatMap(allPatches);
          const esc = arm.config.escalate ? `${patches.filter(({ p }) => p.patcher && p.patcher !== `${arm.config.role}-${arm.config.thinking}`).length}/${patches.length}` : "-";
          const fixedRuns = arm.runs.filter((r) => r.expert_pass && !r.iterations[0].pass && r.passed_at !== null);
          const label = String(arm.config.label ?? `${arm.config.role}-${arm.config.thinking}${arm.config.maxTokens === 16000 ? " 16k" : ""}`);
          return [a, label, String((arm.config.seeds as number[] | undefined)?.length ?? 3), pctCI(s.fixed, s.need_fix), pctCI(c[1], s.need_fix), pct(c[2], s.need_fix), fmt(s.mean_patches_to_pass, 2), esc, `${s.worse_patches}/${s.patches}`, `$${s.cost_usd.toFixed(4)}`, s.cost_per_fixed_usd === null ? "-" : `$${s.cost_per_fixed_usd.toFixed(5)}`, `${fmt(s.latency_mean_s, 1)} s`, `${fmt(mean(fixedRuns.map((r) => r.latency_ms / 1000)), 1)} s`];
        }),
      ),
    );
  }
  // playbook comparison on Moon and orbit
  const pbOrder = ["super-off", "preflight", "playbook", "playbook2", "super-on", "r2-super-off", "r2-playbook3", "r2-super-on", "r2-playbook2-on", "r2-playbook3-on", "r2-esc-on", "r2-playbook3-esc"];
  const pb = pbOrder.filter((a) => file.arms[a]);
  if (pb.length > 1) {
    const mo = (a: string) => file.arms[a].runs.filter((r) => (r.gravity === "moon" || r.gravity === "orbit") && r.probe !== "pour-liquid");
    lines.push("\n### Playbook comparison (Moon and orbit cases, solvable runs; the rules come from Earth and Mars repairs of the round-1 super-off arm)");
    for (const a of ["playbook", "playbook2", "r2-playbook3"]) {
      const book = file.arms[a]?.playbook;
      if (book) lines.push(`Rules of ${a} (distilled by Super from ${book.from_runs} Earth and Mars repairs):\n${book.rules.map((r, i) => `${i + 1}. ${r.task ? `[${r.task}] ` : ""}${r.rule}\n   evidence: ${r.evidence}`).join("\n")}`);
    }
    lines.push(
      mdTable(
        ["arm", "patcher", "rules", "seeds", "runs", "pass at iteration 0", "after 1", "after 2", "after 5 (95% CI)", "mean iterations, never = 6", "orbit pour reported infeasible", "cost"],
        pb.map((a) => {
          const arm = file.arms[a];
          const runs = mo(a).filter((r) => r.expert_pass);
          const c = curve(runs);
          const rules = arm.config.rules ? (a.includes("playbook3") ? "v3 tagged" : a.includes("playbook2") ? "v2" : "v1") : arm.config.preflight ? "none (set-up patch)" : "none (naive start)";
          const orbitPour = runs.filter((r) => r.probe === "pour" && r.gravity === "orbit");
          const label = String(arm.config.label ?? `${arm.config.role}-${arm.config.thinking}`);
          return [a, label, rules, String((arm.config.seeds as number[] | undefined)?.length ?? 3), String(runs.length), pct(c[0], runs.length), pct(c[1], runs.length), pct(c[2], runs.length), pctCI(c[MAX_PATCHES], runs.length), fmt(mean(runs.map((r) => r.passed_at ?? MAX_PATCHES + 1)), 2), `${orbitPour.filter((r) => r.passed_at !== null).length}/${orbitPour.length}`, `$${mo(a).reduce((n, r) => n + r.cost_usd, 0).toFixed(4)}`];
        }),
      ),
    );
    lines.push(
      mdTable(
        ["arm", ...PROBE_ORDER.map((p) => `${p}: at 0 / by 5`)],
        pb.map((a) => [
          a,
          ...PROBE_ORDER.map((p) => {
            const runs = mo(a).filter((r) => r.expert_pass && r.probe === p);
            const c = curve(runs);
            return `${c[0]} / ${c[MAX_PATCHES]} of ${runs.length}`;
          }),
        ]),
      ),
    );
  }
  // the liquid pour
  const liq = Object.keys(file.arms).filter((a) => file.arms[a].runs.some((r) => r.probe === "pour-liquid"));
  if (liq.length) {
    lines.push("\n### Liquid pour (lib/sim/fluid.ts, 600 particles at 4 mm) against the bead pour, same knobs, cups and check");
    const rowsOf = (a: string, probe: ProbeId) => file.arms[a].runs.filter((r) => r.probe === probe);
    const beadArm = (label: string) => ["r2-super-off", "r2-super-on"].find((b) => file.arms[b] && String(file.arms[b].config.label) === label);
    lines.push(
      mdTable(
        ["arm", "medium", "runs", "pass at iteration 0", "after 1", "after 2", "after 5 (95% CI)", "mean patches to pass", "orbit reported infeasible", "cost"],
        liq.flatMap((a) => {
          const label = String(file.arms[a].config.label);
          const out: string[][] = [];
          for (const [arm, probe, medium] of [[a, "pour-liquid", "liquid"], [beadArm(label), "pour", "beads"]] as [string | undefined, ProbeId, string][]) {
            if (!arm) continue;
            const runs = rowsOf(arm, probe);
            const c = curve(runs);
            const orbit = runs.filter((r) => r.gravity === "orbit");
            out.push([`${arm} (${label})`, medium, String(runs.length), pct(c[0], runs.length), pct(c[1], runs.length), pct(c[2], runs.length), pctCI(c[MAX_PATCHES], runs.length), fmt(mean(runs.filter((r) => r.passed_at !== null).map((r) => r.passed_at!)), 2), `${orbit.filter((r) => r.passed_at !== null).length}/${orbit.length}`, `$${runs.reduce((n, r) => n + r.cost_usd, 0).toFixed(4)}`]);
          }
          return out;
        }),
      ),
    );
    lines.push(
      mdTable(
        ["case", "naive: % of the water in the target (seeds)", ...liq.map((a) => `${a}: passed at patch (per seed)`)],
        liquidCaseGrid().map((c) => {
          const naive = file.arms[liq[0]].runs.filter((r) => r.case_id === c.id).map((r) => fmt(Number(r.iterations[0].metrics.in_target_pct ?? 0), 0));
          return [c.id, naive.join(" / "), ...liq.map((a) => file.arms[a].runs.filter((r) => r.case_id === c.id).map((r) => (r.passed_at === null ? "x" : String(r.passed_at))).join(" "))];
        }),
      ),
    );
  }
  // infeasibility at 0 g
  lines.push("\n### Pour in orbit: does the patcher report the task infeasible? (and false reports elsewhere)");
  lines.push(
    mdTable(
      ["arm", "orbit pour runs", "reported infeasible (pass)", "first at patch (mean)", "pour runs on Earth, Mars, Moon that ever chose report-infeasible"],
      Object.entries(file.arms).map(([a, arm]) => {
        const orbit = arm.runs.filter((r) => r.probe === "pour" && r.gravity === "orbit");
        const ok = orbit.filter((r) => r.passed_at !== null);
        const surf = arm.runs.filter((r) => r.probe === "pour" && r.gravity !== "orbit");
        const falseRep = surf.filter((r) => r.iterations.some((it) => it.knobs.strategy === "report-infeasible"));
        return [a, String(orbit.length), pct(ok.length, orbit.length), fmt(mean(ok.map((r) => r.passed_at!)), 2), pct(falseRep.length, surf.length)];
      }),
    ),
  );
  return lines.join("\n");
}
