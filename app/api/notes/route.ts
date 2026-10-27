/**
 * POST /api/notes {spec, program, runs, first, history}: one patch for a
 * program that failed its rehearsal. `runs` are the last rollouts, one per
 * gravity; `first` is outcomeLine() of the compiled program's rehearsal;
 * `history` the patches tried so far with what each rehearsal showed. The
 * simulator's measurements become a failure note (lib/notes/note.ts), Super
 * returns knob values (lib/notes/knobs.ts), and the route validates, clamps
 * and applies them. Thinking stays off until the loop is stuck (a patch that
 * changes nothing, re-asked at once, or two failed patches), as measured in
 * docs/MEASUREMENTS.md section 8. `unlock` or `sample_token` lets it go live
 * (lib/unlock/check.ts). Replay (no key, ?replay=1, or no way past the spend
 * guard) answers from tests/fixtures/notes.json: the recording for the same
 * program and attempt.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import recordings from "@/tests/fixtures/notes.json";
import { callModel } from "@/lib/providers/call";
import { priced } from "@/lib/providers/price";
import { MODELS, tokenFactory, wantsReplay } from "@/lib/providers/tokenfactory";
import { applyPatch, knobsOf } from "@/lib/notes/knobs";
import { failureNote, type WorldRun } from "@/lib/notes/note";
import { Attempt, escalation, MAX_PATCHES, MAX_TOKENS_OFF, MAX_TOKENS_ON, PATCH_SYSTEM, PatchReply, patchPrompt, type NotePatch } from "@/lib/notes/patch";
import { GRAVITIES, Predicate, Program, TaskSpec, Vec3mm } from "@/lib/spec/schema";
import { done, failed, type LedgerEntry, type StageResult } from "@/lib/spec/stage-result";
import { lintProgram } from "@/lib/spec/validate";
import { explain, liveGate } from "@/lib/unlock/check";

// a thinking call takes up to ~40 s, and a no-op re-asks once
export const maxDuration = 180;

const RolloutIn = z.object({
  pass: z.boolean(),
  t: z.number(),
  log: z.array(z.string().max(400)).max(500),
  failed_step_id: z.string().max(100).optional(),
  failed_op: z.number().int().nonnegative().optional(),
  failed_predicate: Predicate.optional(),
  failure_class: z.enum(["embodiment_limit", "spec_gap"]).optional(),
  why: z.string().max(500).optional(),
  end: z
    .array(z.object({ object: z.string(), xyz_mm: Vec3mm, speed_mm_s: z.number(), held: z.boolean(), seated: z.object({ target: z.string(), ok: z.boolean(), why: z.string().max(500) }).optional() }))
    .max(20)
    .optional(),
});
const Body = z.object({
  spec: TaskSpec,
  program: Program,
  runs: z.array(z.object({ world: z.enum(Object.keys(GRAVITIES) as [keyof typeof GRAVITIES]), rollout: RolloutIn })).min(1).max(3),
  first: z.string().max(2000),
  history: z.array(Attempt).max(MAX_PATCHES).default([]),
});

type Recording = { program: unknown; attempt: number; result: StageResult<NotePatch> };

function replay(program: Program, attempt: number): StageResult<NotePatch> {
  const key = JSON.stringify(program);
  const same = (recordings as Recording[]).filter((r) => JSON.stringify(Program.parse(r.program)) === key);
  const hit = (same.find((r) => r.attempt === attempt) ?? same.at(-1))?.result;
  if (hit?.status !== "done") return hit ?? failed("no recorded patch for this program", false);
  return done(hit.value, [...hit.warnings, "replay: recorded patch"], hit.ledger);
}

export async function POST(req: Request): Promise<NextResponse<StageResult<NotePatch>>> {
  const body = await req.json().catch(() => null);
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json(failed(`invalid request: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, false), { status: 400 });
  const { spec, program, first, history } = parsed.data;
  const runs = parsed.data.runs as WorldRun[];
  if (runs.every((r) => r.rollout.pass)) return NextResponse.json(failed("every world passed: nothing to patch", false), { status: 400 });
  if (history.length >= MAX_PATCHES) return NextResponse.json(failed(`${MAX_PATCHES} patches already tried`, false), { status: 400 });
  if (wantsReplay(req)) return NextResponse.json(replay(program, history.length));
  const gate = await liveGate("notes", body);
  if (!gate.live) return NextResponse.json(explain(replay(program, history.length), gate));
  const client = tokenFactory({ timeout: 60_000, maxRetries: 1 });
  if (!client) return NextResponse.json(replay(program, history.length));

  // the patch edits the step that failed; a world that failed nowhere in particular opens every step
  const failing = runs.filter((r) => !r.rollout.pass).map((r) => r.rollout.failed_step_id);
  const steps = failing.every((id) => id !== undefined) ? new Set(failing as string[]) : undefined;
  const knobs = knobsOf(spec, program, steps);
  if (knobs.length === 0) return NextResponse.json(failed("the step that failed has no numbers to tune", false));
  const note = failureNote(spec, program, runs);
  const user = patchPrompt(spec, program, knobs, first, history, note);
  // one ledger for every call of this patch, the unusable answers too: each was billed
  const ledger: LedgerEntry[] = [];
  const ask = (thinking: boolean) => callModel(client, { role: "super", system: PATCH_SYSTEM, user, maxTokens: thinking ? MAX_TOKENS_ON : MAX_TOKENS_OFF, schema: PatchReply, thinking, ledger });

  let why = escalation(history);
  let r = await ask(why !== null);
  const warnings: string[] = r.status === "done" ? [...r.warnings] : [];
  let applied = r.status === "done" ? applyPatch(spec, program, r.value.set, steps) : null;
  if (why === null && (r.status !== "done" || applied!.noop)) {
    // stuck on the first try: the thinking patcher answers this one, and the rest of the loop
    warnings.push(r.status === "done" ? "the patch changed nothing: asked again with thinking on" : `the patcher failed (${r.status === "failed" ? r.message : r.status}): asked again with thinking on`);
    why = "noop";
    r = await ask(true);
    if (r.status === "done") {
      warnings.push(...r.warnings);
      applied = applyPatch(spec, program, r.value.set, steps);
    }
  }
  const costs = priced(ledger);
  const spent = costs.reduce((n, e) => n + (e.usd ?? 0), 0);
  if (r.status !== "done" || !applied) {
    const message = r.status === "failed" ? r.message : "the patch could not be applied";
    return NextResponse.json(failed(`${message} (${costs.length} call${costs.length === 1 ? "" : "s"}, $${spent.toFixed(4)})`, r.status === "failed" ? r.retryable : false));
  }

  const before = new Set(lintProgram(program, spec));
  for (const p of lintProgram(applied.program, spec)) if (!before.has(p)) warnings.push(`the patched program: ${p}`);
  const value: NotePatch = {
    program: applied.program,
    set: applied.set,
    changes: applied.changes,
    clamps: applied.clamps,
    rejected: applied.rejected,
    noop: applied.noop,
    why: r.value.why.slice(0, 400),
    expect: r.value.expect.slice(0, 400),
    note,
    model: MODELS.super,
    thinking: why !== null,
    escalation: why,
    tokens: costs.reduce((n, e) => n + e.prompt_tokens + e.completion_tokens, 0),
    cost_usd: spent,
  };
  return NextResponse.json(done(value, warnings, costs));
}
