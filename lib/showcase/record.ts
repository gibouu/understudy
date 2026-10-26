/**
 * Record one sample clip for /space: the live path once, end to end, with
 * the routes the guided flow calls, and nothing else.
 *
 *   proxy      ffmpeg: 480 wide, 4 fps, H.264, no audio (the browser's VIDEO_PROXY)
 *   label      POST /api/label with the clip's line from lib/samples.ts (Super VL)
 *   fit        fitToBench, as the flow does
 *   compile    POST /api/compile; Nano's asks get the recorded answers
 *              (lib/showcase/answers.ts) and it recompiles, up to MAX_ROUNDS
 *   rehearse   every program on Earth and in orbit in node (lib/showcase/rehearse.ts)
 *   notes      the `notes` hook, while the last program fails somewhere (#28)
 *
 * Every call is priced at list prices, and the run stops before any call
 * whose worst case (worstUsd) would take the clip over `capUsd`.
 * lib/showcase/record.test.ts runs it.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import catalog from "@/tests/fixtures/models.json";
import type { Sample } from "@/lib/samples";
import { fitToBench } from "@/lib/sim/fit";
import { MODELS, type ModelRole } from "@/lib/providers/tokenfactory";
import { applyChanges } from "@/lib/spec/apply";
import type { Program, ProgramOp, TaskSpec } from "@/lib/spec/schema";
import type { LedgerEntry, StageResult } from "@/lib/spec/stage-result";
import { answerFor, CLIP_ANSWERS, DEFAULT_ANSWERS, slotWords } from "./answers";
import { rehearseAll, type Engine } from "./rehearse";
import { Session, type Answer, type Call, type Iteration, type Turn } from "./session";

/** The guided flow stops asking after this many rounds (app/flow.tsx). */
export const MAX_ROUNDS = 6;
/** Notes patches per clip, as the patch loop allows (#28). */
export const MAX_PATCHES = 5;

/**
 * The calls one route can bill, as (prompt tokens, max_tokens) per call: a
 * generous prompt, and every attempt callModel can make (a second answer when
 * the first does not parse or fails its check; compile also allows one SDK
 * retry). Notes is #28's route: a cheap patch (800 tokens) and, once stuck, a
 * thinking one (4,096), each of which may be asked again.
 */
export const WORST_CALLS = {
  label: { role: "vl", calls: [[12_000, 3_000], [12_000, 3_000]] },
  compile: { role: "nano", calls: [[8_000, 3_000], [8_000, 3_000], [8_000, 3_000]] },
  notes: { role: "super", calls: [[8_000, 800], [8_000, 800], [8_000, 4_096], [8_000, 4_096]] },
} as const satisfies Record<string, { role: ModelRole; calls: readonly (readonly [number, number])[] }>;

/** The most a route call can cost, reserved before it is made, at the list price of the model it will use (env overrides included). */
export function worstUsd(stage: keyof typeof WORST_CALLS, model: string = MODELS[WORST_CALLS[stage].role]): number {
  return sum(WORST_CALLS[stage].calls.map(([prompt_tokens, completion_tokens]) => priceOf({ model, prompt_tokens, completion_tokens, seconds: 0 })));
}

/**
 * The Notes stage's hook (#28). Called while the last iteration fails in a
 * world and not on a spec gap; returns the next iteration with the model
 * calls it made (they join the ledger and the cap), or null to stop.
 * Once /api/notes is on main, wire it here: post { spec, program, runs,
 * first, history } to app/api/notes/route.ts as app/patch-loop.tsx does,
 * rehearse the patched program with rehearseAll, and return
 * { source: "notes", changes: each knob's from -> to in words, why: the
 * patch's why, cost_usd: its cost }. Until then recordings stop after the
 * interview and say so in `pending`.
 */
export type NotesHook = (last: Iteration, iterations: Iteration[], engine: Engine) => Promise<{ iteration: Iteration; calls: Call[] } | null>;

export type RecordOptions = { root: string; sample: Sample; engine: Engine; capUsd: number; notes?: NotesHook; log?: (line: string) => void };

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
async function post<T>(handler: Handler, route: string, body: unknown): Promise<StageResult<T>> {
  const res = await handler(new Request(`http://localhost${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return (await res.json()) as StageResult<T>;
}

/** A replayed answer must never be recorded as a live one. */
function live<T>(r: StageResult<T>, stage: string): Extract<StageResult<T>, { status: "done" }> {
  if (r.status !== "done") throw new Error(`${stage}: ${r.status === "failed" ? r.message : r.status}`);
  if (r.warnings.some((w) => w.startsWith("replay"))) throw new Error(`${stage} answered from a replay fixture: is NEBIUS_API_KEY set?`);
  if (!r.ledger?.length) throw new Error(`${stage} made no model call`);
  return r;
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

export async function recordClip({ root, sample, engine, capUsd, notes, log = () => {} }: RecordOptions): Promise<Session> {
  const { POST: labelRoute } = await import("@/app/api/label/route");
  const { POST: compileRoute } = await import("@/app/api/compile/route");
  // with no key every route answers from its fixtures, some with no replay warning: never record those
  if (!process.env.NEBIUS_API_KEY) throw new Error("NEBIUS_API_KEY is not set: the routes would answer from their replay fixtures");
  if (!(capUsd > 0)) throw new Error(`the cap must be a positive number of US dollars, not ${capUsd}`);
  const ledger: Call[] = [];
  /** stop before a call whose worst case would take the clip over its cap */
  const guard = (next: string, worst: number) => {
    const spent = sum(ledger.map((c) => c.usd));
    if (spent + worst > capUsd) throw new Error(`US$${spent.toFixed(4)} spent; ${next} could cost up to US$${worst.toFixed(4)}, over the US$${capUsd} cap`);
  };

  guard("label", worstUsd("label"));
  const file = path.join(root, "samples", `${sample.name}.mp4`);
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  const { video, duration_s } = proxy(file);
  log(`${sample.name}: proxy ${Math.round(video.length / 1024)} kB, ${duration_s.toFixed(1)} s`);

  const label = live(await post<TaskSpec>(labelRoute as Handler, "/api/label", { video, duration_s, hint: sample.hint, clip_sha256: sha256 }), "label");
  const labelCalls = calls("label", label.ledger);
  ledger.push(...labelCalls);
  log(`label: "${label.value.title}", ${label.value.objects.length} objects, ${label.value.steps.length} steps`);

  const fit = fitToBench(label.value);
  if (fit.spec === label.value) throw new Error(`fit: ${fit.warnings.join("; ")}`);

  const answers = { ...DEFAULT_ANSWERS, ...CLIP_ANSWERS[sample.name] };
  const turns: Turn[] = [];
  const iterations: Iteration[] = [];
  let spec = fit.spec;
  let previous: Program | undefined;
  let given: Answer[] = [];
  let asked: Ask[] = [];
  for (let turn = 0; ; turn++) {
    guard(`compile ${turn}`, worstUsd("compile"));
    const r = live(await post<Program>(compileRoute as Handler, "/api/compile", { spec, previous }), `compile ${turn}`);
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
  for (let n = 0; notes && n < MAX_PATCHES && fails(iterations.at(-1)!); n++) {
    guard(`notes patch ${n + 1}`, worstUsd("notes"));
    const patched = await notes(iterations.at(-1)!, iterations, engine);
    if (!patched) break;
    ledger.push(...patched.calls);
    iterations.push(patched.iteration);
  }

  return Session.parse({
    version: 1,
    clip: { name: sample.name, duration_s: round(duration_s, 3), sha256 },
    hint: sample.hint,
    recorded_at: new Date().toISOString(),
    label: { spec: label.value, warnings: label.warnings, cost_usd: round(sum(labelCalls.map((c) => c.usd))), seconds: round(sum(labelCalls.map((c) => c.seconds)), 2) },
    fit,
    turns,
    iterations,
    pending: notes ? [] : ["Notes patches (#28): until /api/notes is on main, this recording stops after the interview."],
    ledger,
    total_usd: round(sum(ledger.map((c) => c.usd))),
  });
}
