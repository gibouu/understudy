/**
 * Record one sample clip for /space: the live path once, end to end, with
 * the routes the guided flow calls, and nothing else.
 *
 *   proxy      ffmpeg: 480 wide, 4 fps, H.264, no audio (the browser's VIDEO_PROXY)
 *   label      POST /api/label with the clip's line from lib/samples.ts (Super VL)
 *   fit        fitToBench, as the flow does; a clip it finds nothing to rehearse in
 *              (no insert or place step, or a gesture, whose path only the browser
 *              traces) stops here, as a LabelRecording; a gesture clip is finished later
 *              from that label and the fit the page made after tracing the hand (`traced`)
 *   compile    POST /api/compile; Nano's asks get the recorded answers
 *              (lib/showcase/answers.ts) and it recompiles, up to MAX_ROUNDS
 *   rehearse   every program on Earth and in orbit in node (lib/showcase/rehearse.ts)
 *   notes      POST /api/notes through notesHook(), while the last program fails in a
 *              world and not on a spec gap, up to MAX_PATCHES; each patch rehearsed again
 *
 * Every call is priced at list prices, and the run stops before any call
 * whose worst case (worstUsd), added to the worst cases of the calls before
 * it, would take the clip over `capUsd`.
 * lib/showcase/record.test.ts runs it.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import catalog from "@/tests/fixtures/models.json";
import type { Sample } from "@/lib/samples";
import { fitToBench, type Fit } from "@/lib/sim/fit";
import { MODELS, type ModelRole } from "@/lib/providers/tokenfactory";
import { applyChanges } from "@/lib/spec/apply";
import type { Program, ProgramOp, TaskSpec } from "@/lib/spec/schema";
import type { LedgerEntry, StageResult } from "@/lib/spec/stage-result";
import { knobsOf, type Applied } from "@/lib/notes/knobs";
import { outcomeLine } from "@/lib/notes/note";
import { MAX_PATCHES, type Attempt, type NotePatch } from "@/lib/notes/patch";
import { UNLOCK_ENV } from "@/lib/unlock/check";
import { answerFor, CLIP_ANSWERS, DEFAULT_ANSWERS, slotWords } from "./answers";
import { rehearseAll, rollouts, summary, type Engine } from "./rehearse";
import { LabelRecording, Session, type Answer, type Call, type Iteration, type Models, type Turn } from "./session";

/** The guided flow stops asking after this many rounds (app/flow.tsx). */
export const MAX_ROUNDS = 6;

/**
 * The calls one route can bill, as (prompt tokens, max_tokens) per call: a
 * generous prompt, and every attempt callModel can make (a second answer when
 * the first does not parse or fails its check), each sent twice where the
 * route lets the SDK retry once (compile, notes). Notes is #28's route: a
 * cheap patch (800 tokens) and, once stuck, a thinking one (4,096). A request
 * the SDK retries after a timeout may have been billed without its usage ever
 * arriving, so the cap holds the sum of these reservations, not the ledger's.
 * Not reserved: a retry answered 400 (callModel then sends once more without
 * its optional parameters), and prompts over 8,000 tokens (a fitted spec and
 * its program are about 3,000 characters).
 */
export const WORST_CALLS = {
  label: { role: "vl", calls: [[12_000, 3_000], [12_000, 3_000]] },
  compile: { role: "nano", calls: Array<[number, number]>(4).fill([8_000, 3_000]) },
  notes: { role: "super", calls: [...Array<[number, number]>(4).fill([8_000, 800]), ...Array<[number, number]>(4).fill([8_000, 4_096])] },
} as const satisfies Record<string, { role: ModelRole; calls: readonly (readonly [number, number])[] }>;

/** The most a route call can cost, reserved before it is made, at the list price of the model it will use (env overrides included). */
export function worstUsd(stage: keyof typeof WORST_CALLS, model: string = MODELS[WORST_CALLS[stage].role]): number {
  return sum(WORST_CALLS[stage].calls.map(([prompt_tokens, completion_tokens]) => priceOf({ model, prompt_tokens, completion_tokens, seconds: 0 })));
}

/**
 * The Notes stage's hook (#28). Called while the last iteration fails in a
 * world and not on a spec gap; returns the next iteration with the model
 * calls it made (they join the ledger and the cap), or null to stop.
 * notesHook() makes the one that calls /api/notes; without a hook the
 * recording stops after the interview and says so in `pending`.
 */
export type NotesHook = (last: Iteration, iterations: Iteration[], engine: Engine) => Promise<{ iteration: Iteration; calls: Call[] } | null>;

/**
 * A gesture clip finished from its label recording: node cannot run MediaPipe, so the page traced the
 * hand (lib/vision/trace.ts) against the recorded label, and hands in the label it traced and its fit.
 * No new label call: the trace belongs to that label's steps.
 */
export type Traced = { label: LabelRecording; traced: TaskSpec; fit: Fit; by: string };

export type RecordOptions = { root: string; sample: Sample; engine: Engine; capUsd: number; notes?: NotesHook; traced?: Traced; log?: (line: string) => void };

type Ask = Extract<ProgramOp, { op: "ask" }>;
const asksOf = (p: Program): Ask[] => p.steps.flatMap((s) => s.ops).filter((op): op is Ask => op.op === "ask");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round = (x: number, d = 6) => Number(x.toFixed(d));

type Price = { prompt: number; completion: number; cache_read: number | null };
const PRICES = new Map<string, Price>(
  catalog.models.map((m) => {
    const p = m.pricing as { prompt: string; completion: string; input_cache_read?: string | null };
    return [m.id, { prompt: Number(p.prompt), completion: Number(p.completion), cache_read: p.input_cache_read == null ? null : Number(p.input_cache_read) }];
  }),
);

/** USD at list prices, the formula of scripts/bench-ledger.mjs; a model with no price stops the recording rather than counting as free. */
export function priceOf(e: LedgerEntry): number {
  const p = PRICES.get(e.model);
  if (!p) throw new Error(`no list price for ${e.model} in tests/fixtures/models.json`);
  const cached = e.cached_tokens ?? 0;
  return (e.prompt_tokens - cached) * p.prompt + cached * (p.cache_read ?? p.prompt) + e.completion_tokens * p.completion;
}

const calls = (stage: Call["stage"], ledger: LedgerEntry[] = []): Call[] =>
  ledger.map((e) => ({ stage, model: e.model, prompt_tokens: e.prompt_tokens, completion_tokens: e.completion_tokens, cached_tokens: e.cached_tokens, seconds: round(e.seconds, 2), usd: round(priceOf(e), 8) }));

type Handler = (req: Request) => Promise<Response>;
/** Carries the unlock code when one is set here, so the spend guard (lib/unlock/check.ts) lets the recording go live. */
async function post<T>(handler: Handler, route: string, body: unknown): Promise<StageResult<T>> {
  const res = await handler(new Request(`http://localhost${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unlock: process.env[UNLOCK_ENV], ...(body as object) }) }));
  return (await res.json()) as StageResult<T>;
}

/** A replayed answer must never be recorded as a live one; `model: false` for a stage the route answers with no model (a gesture's program). */
function live<T>(r: StageResult<T>, stage: string, model = true): Extract<StageResult<T>, { status: "done" }> {
  if (r.status !== "done") throw new Error(`${stage}: ${r.status === "failed" ? r.message : r.status}`);
  if (r.warnings.some((w) => w.startsWith("replay"))) throw new Error(`${stage} answered from a replay fixture: is NEBIUS_API_KEY set?`);
  if (model && !r.ledger?.length) throw new Error(`${stage} made no model call`);
  return r;
}

const gesturesOnly = (spec: TaskSpec) => spec.steps.length > 0 && spec.steps.every((s) => s.verb === "gesture");
/** a step's place in the clip, which a trace must not move */
const windows = (spec: TaskSpec) => spec.steps.map(({ id, verb, t_start_s, t_end_s }) => ({ id, verb, t_start_s, t_end_s }));

/** The traced label and fit are the recorded label's, with paths: same clip, same steps, and the fit node makes of the traced label. */
function checkTraced(t: Traced, sha256: string, name: string) {
  if (t.label.clip.name !== name || t.label.clip.sha256 !== sha256) throw new Error(`traced: the label recording is not ${name}'s`);
  if (JSON.stringify(windows(t.traced)) !== JSON.stringify(windows(t.label.label.spec))) throw new Error("traced: the traced label's steps are not the recorded label's");
  if (JSON.stringify(fitToBench(t.traced).spec) !== JSON.stringify(t.fit.spec)) throw new Error("traced: the fit is not what node makes of the traced label");
  if (!gesturesOnly(t.fit.spec)) throw new Error("traced: only a gesture clip is finished from a trace");
}

function proxy(file: string): { video: string; duration_s: number } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "showcase-"));
  try {
    const out = path.join(dir, "proxy.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-an", "-vf", "fps=4,scale=480:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
    const duration_s = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());
    return { video: `data:video/mp4;base64,${readFileSync(out).toString("base64")}`, duration_s };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The still the gallery shows: a frame from the middle of the step the robot rehearses. */
export function poster(root: string, sample: Sample, session: Session, out: string) {
  const act = session.fit.spec.steps.at(-1);
  const t = act ? Math.min((act.t_start_s + act.t_end_s) / 2, session.clip.duration_s - 0.5) : session.clip.duration_s / 2;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", t.toFixed(2), "-i", path.join(root, "samples", `${sample.name}.mp4`), "-frames:v", "1", "-vf", "scale=960:-2", "-q:v", "5", out]);
}

const AXIS = { x_mm: "x offset", y_mm: "y offset", z_mm: "height", timeout_s: "wait" } as const;

/** A knob's change in words: "the height of the move to the plant pillow (s2 op 2): 50 → 10 mm". */
function knobWords(spec: TaskSpec, program: Program, c: Applied["changes"][number], clamps: Applied["clamps"]): string {
  const k = knobsOf(spec, program).find((x) => x.name === c.name);
  const op = k && program.steps[k.step].ops[k.op];
  const name = (id: string) => spec.objects.find((o) => o.id === id)?.name ?? id;
  const where = k ? ` (${program.steps[k.step].step_id} op ${k.op})` : "";
  const clamp = clamps.find((x) => x.name === c.name);
  const asked = clamp ? `, asked for ${clamp.requested} and held to its bound` : "";
  if (op?.op === "move_to") return `the ${AXIS[k!.field]} of the move to ${op.frame === "world" ? "a point from the robot base" : `the ${name(op.frame)}`}${where}: ${c.from} → ${c.to} mm${asked}`;
  if (op?.op === "wait_until") return `how long to wait for ${op.predicate.kind.replace(/_/g, " ")}${op.predicate.object ? ` of the ${name(op.predicate.object)}` : ""}${where}: ${c.from} → ${c.to} s${asked}`;
  return `${c.name}: ${c.from} → ${c.to}${asked}`;
}

/**
 * The Notes stage through /api/notes, as app/patch-loop.tsx drives it: the
 * last version's rollouts in every world, the outcome of the version the
 * patches start from, and every patch tried so far with what it showed; the
 * patched program is rehearsed again in node. It keeps that history, so it
 * is one hook per recording.
 */
export function notesHook(): NotesHook {
  const history: Attempt[] = [];
  let first: string | undefined;
  return async (last, iterations, engine) => {
    if (iterations.filter((x) => x.source === "notes").length !== history.length) throw new Error("a notesHook() records one clip's patches: make a new one per recording");
    const { POST: notesRoute } = await import("@/app/api/notes/route");
    const { spec, program } = last;
    const runs = rollouts(engine, spec, program);
    const start = first ?? outcomeLine(runs);
    const r = live(await post<NotePatch>(notesRoute as Handler, "/api/notes", { spec, program, runs, first: start, history }), `notes patch ${history.length + 1}`);
    first = start;
    const patch = r.value;
    const cost = calls("notes", r.ledger);
    const after = patch.noop ? runs : rollouts(engine, spec, patch.program);
    history.push({ set: patch.set, thinking: patch.thinking, clamps: patch.clamps, rejected: patch.rejected, outcome: outcomeLine(after) });
    const results = Object.fromEntries(after.map(({ world, rollout }) => [world, summary(rollout)])) as Iteration["results"];
    const iteration: Iteration = {
      source: "notes",
      program: patch.program,
      spec,
      changes: patch.changes.map((c) => knobWords(spec, program, c, patch.clamps)),
      why: patch.why || (patch.noop ? "Super changed nothing" : "Super gave no reason"),
      cost_usd: round(sum(cost.map((c) => c.usd))),
      seconds: round(sum(cost.map((c) => c.seconds)), 2),
      results,
      patch,
    };
    return { iteration, calls: cost };
  };
}

/** The models the routes call, as recorded with every clip: Nano and Super leave Token Factory serverless on 9 Nov 2026. */
export const recordedModels = (): Models => ({ vl: MODELS.vl, nano: MODELS.nano, super: MODELS.super });

export async function recordClip({ root, sample, engine, capUsd, notes, traced, log = () => {} }: RecordOptions): Promise<Session | LabelRecording> {
  const { POST: labelRoute } = await import("@/app/api/label/route");
  const { POST: compileRoute } = await import("@/app/api/compile/route");
  // with no key every route answers from its fixtures, some with no replay warning: never record those
  if (!process.env.NEBIUS_API_KEY) throw new Error("NEBIUS_API_KEY is not set: the routes would answer from their replay fixtures");
  if (!(capUsd > 0)) throw new Error(`the cap must be a positive number of US dollars, not ${capUsd}`);
  const ledger: Call[] = [];
  /** what the calls so far could have billed, seen or not */
  let reserved = 0;
  /** stop before a call whose worst case would take the clip over its cap */
  const guard = (next: string, worst: number) => {
    if (reserved + worst > capUsd) throw new Error(`US$${reserved.toFixed(4)} reserved so far; ${next} could cost up to US$${worst.toFixed(4)}, over the US$${capUsd} cap`);
    reserved += worst;
  };

  const file = path.join(root, "samples", `${sample.name}.mp4`);
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  let base: Pick<Session, "version" | "clip" | "hint" | "recorded_at" | "models" | "traced">;
  let labelled: Session["label"];
  let fit: Fit;
  if (traced) {
    checkTraced(traced, sha256, sample.name);
    const { label, ledger: before, clip, hint, recorded_at, models } = traced.label;
    ledger.push(...before);
    base = { version: 1, clip, hint, recorded_at, models, traced: traced.by };
    labelled = label;
    fit = { spec: traced.fit.spec, warnings: [...traced.fit.warnings] };
    log(`${sample.name}: the label recorded on ${recorded_at}, traced by ${traced.by}`);
  } else {
    guard("label", worstUsd("label"));
    const { video, duration_s } = proxy(file);
    log(`${sample.name}: proxy ${Math.round(video.length / 1024)} kB, ${duration_s.toFixed(1)} s`);
    const label = live(await post<TaskSpec>(labelRoute as Handler, "/api/label", { video, duration_s, hint: sample.hint, clip_sha256: sha256 }), "label");
    const labelCalls = calls("label", label.ledger);
    ledger.push(...labelCalls);
    log(`label: "${label.value.title}", ${label.value.objects.length} objects, ${label.value.steps.length} steps`);
    fit = fitToBench(label.value);
    base = { version: 1, clip: { name: sample.name, duration_s: round(duration_s, 3), sha256 }, hint: sample.hint, recorded_at: new Date().toISOString(), models: recordedModels() };
    labelled = { spec: label.value, warnings: label.warnings, cost_usd: round(sum(labelCalls.map((c) => c.usd))), seconds: round(sum(labelCalls.map((c) => c.seconds)), 2) };
  }
  if (fit.spec === labelled.spec) {
    log(`fit: ${fit.warnings.join("; ")}; recorded up to the label`);
    return LabelRecording.parse({ ...base, label: labelled, fit, stops: fit.warnings.at(-1) ?? "nothing to rehearse", ledger, total_usd: round(sum(ledger.map((c) => c.usd))) });
  }

  const answers = { ...DEFAULT_ANSWERS, ...CLIP_ANSWERS[sample.name] };
  const turns: Turn[] = [];
  const iterations: Iteration[] = [];
  let spec = fit.spec;
  let previous: Program | undefined;
  let given: Answer[] = [];
  let asked: Ask[] = [];
  for (let turn = 0; ; turn++) {
    guard(`compile ${turn}`, worstUsd("compile"));
    // a spec of gestures alone is compiled by the route itself (lib/sim/gesture.ts), with no model
    const r = live(await post<Program>(compileRoute as Handler, "/api/compile", { spec, previous }), `compile ${turn}`, !gesturesOnly(spec));
    const cost = calls("compile", r.ledger);
    ledger.push(...cost);
    const program = r.value;
    const asks = asksOf(program);
    const results = rehearseAll(engine, spec, program);
    iterations.push({
      source: turn === 0 ? "compile" : "interview",
      program,
      spec,
      changes: given.map((a) => `${slotWords(spec, a.slot)}: ${a.text}`),
      why: turn === 0 ? `Nano's first program for the fitted spec${asks.length ? `, with ${asks.length} open question${asks.length > 1 ? "s" : ""}` : ""}` : `answers to: ${asked.map((a) => a.question).join(" ")}`,
      cost_usd: round(sum(cost.map((c) => c.usd))),
      seconds: round(sum(cost.map((c) => c.seconds)), 2),
      results,
    });
    log(`compile ${turn}: ${asks.length} asks; earth ${results.earth.pass ? "pass" : "fail"}, orbit ${results.orbit.pass ? "pass" : "fail"}`);

    // the flow takes answers for MAX_ROUNDS rounds, then rehearses what it has
    const next = asks.length && turn < MAX_ROUNDS ? asks.flatMap((a) => answerFor(spec, a.slot, turn + 1, answers) ?? []) : [];
    turns.push({ program, warnings: r.warnings, asks: asks.map(({ slot, question, why }) => ({ slot, question, why })), answers: next });
    if (next.length === 0) break;
    const applied = applyChanges(spec, next.map((a) => a.change));
    if (applied.warnings.length) throw new Error(`answers did not apply: ${applied.warnings.join("; ")}`);
    previous = program;
    spec = applied.spec;
    given = next;
    asked = asks;
  }

  const fails = (it: Iteration) => [it.results.earth, it.results.orbit].some((x) => !x.pass) && [it.results.earth, it.results.orbit].every((x) => x.pass || x.failure_class !== "spec_gap");
  // the page has no Notes stage for a gesture: its path is its only check (app/rehearsal.tsx)
  for (let n = 0; notes && !gesturesOnly(spec) && n < MAX_PATCHES && fails(iterations.at(-1)!); n++) {
    guard(`notes patch ${n + 1}`, worstUsd("notes"));
    const patched = await notes(iterations.at(-1)!, iterations, engine);
    if (!patched) break;
    ledger.push(...patched.calls);
    iterations.push(patched.iteration);
    const { earth, orbit } = patched.iteration.results;
    log(`notes ${n + 1}: ${patched.iteration.changes.join("; ") || "no change"}; earth ${earth.pass ? "pass" : "fail"}, orbit ${orbit.pass ? "pass" : "fail"}`);
  }

  return Session.parse({
    ...base,
    label: labelled,
    fit,
    turns,
    iterations,
    pending: notes ? [] : ["Notes patches (#28): recorded without notesHook(), this recording stops after the interview."],
    ledger,
    total_usd: round(sum(ledger.map((c) => c.usd))),
  });
}
