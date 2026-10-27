/**
 * A showcase recording: one clip run once through the live path (label, fit,
 * compile with recorded answers, rehearsal, and Notes patches), saved as public/showcase/<clip>.json by lib/showcase/record.ts.
 * /space plays it back with no model call: every Token Factory answer comes
 * from here, and the simulator re-runs each iteration's program in the
 * browser. `results` are the rehearsals measured in node when it was
 * recorded; the browser re-runs the same deterministic physics. /try plays
 * the same file when a sample is picked (app/recorded.ts).
 *
 * A clip node cannot fit to the bench (no insert or place step, or a gesture
 * whose hand path is traced in the browser) is kept as a LabelRecording in
 * public/showcase/<clip>.label.json: what Super VL saw, which /try shows at
 * once; /space never reads it.
 */
import { z } from "zod";
import { Program, SpecChange, TaskSpec } from "@/lib/spec/schema";

/** One model call, priced at the list prices in tests/fixtures/models.json. */
export const Call = z.object({
  stage: z.enum(["label", "compile", "notes", "playbook"]),
  model: z.string(),
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  cached_tokens: z.number().optional(),
  seconds: z.number(),
  usd: z.number(),
});
export type Call = z.infer<typeof Call>;

/** What the simulator measured for one program in one world. */
export const Run = z.object({
  pass: z.boolean(),
  failed_step_id: z.string().optional(),
  failed_op: z.number().optional(),
  failure_class: z.enum(["embodiment_limit", "spec_gap"]).optional(),
  why: z.string().optional(),
  /** simulated seconds */
  t: z.number(),
});
export type Run = z.infer<typeof Run>;

/** A Notes patch as /api/notes returned it (lib/notes/patch.ts NotePatch), so /api/notes can answer it again at once. */
export const Patch = z.object({
  program: Program,
  set: z.record(z.string(), z.number()),
  changes: z.array(z.object({ name: z.string(), from: z.number(), to: z.number() })),
  clamps: z.array(z.object({ name: z.string(), requested: z.number(), applied: z.number() })),
  rejected: z.array(z.string()),
  noop: z.boolean(),
  why: z.string(),
  expect: z.string(),
  note: z.string(),
  model: z.string(),
  thinking: z.boolean(),
  escalation: z.enum(["noop", "two_failed"]).nullable(),
  tokens: z.number(),
  cost_usd: z.number(),
});
export type Patch = z.infer<typeof Patch>;

/** The model each route was set to call when the clip was recorded (MODELS in lib/providers/tokenfactory.ts). */
export const Models = z.object({ vl: z.string(), nano: z.string(), super: z.string() });
export type Models = z.infer<typeof Models>;

export const Ask = z.object({ slot: z.string(), question: z.string(), why: z.string().default("") });

/** The answer given for one ask, as the change it made to the spec. */
export const Answer = z.object({
  slot: z.string(),
  /** what the person would have typed or picked */
  text: z.string(),
  change: SpecChange,
});
export type Answer = z.infer<typeof Answer>;

/** One compile: the program Nano returned, its open questions and the answers given to them (none on the last turn). */
export const Turn = z.object({
  program: Program,
  warnings: z.array(z.string()),
  asks: z.array(Ask),
  answers: z.array(Answer),
});
export type Turn = z.infer<typeof Turn>;

/**
 * One version of the program and how it came about: the first compile, a
 * recompile after interview answers, a Notes patch (#28), or rules from a
 * playbook. `changes` are said in words; `why` is the reason in one line.
 */
export const Iteration = z.object({
  source: z.enum(["compile", "interview", "notes", "playbook"]),
  program: Program,
  /** the spec this program is rehearsed against (answers change it) */
  spec: TaskSpec,
  changes: z.array(z.string()),
  why: z.string(),
  /** this iteration's model calls */
  cost_usd: z.number(),
  seconds: z.number(),
  results: z.object({ earth: Run, orbit: Run }),
  /**
   * A Notes iteration's patch, as the route returned it. The 26 Oct recording of
   * iss-veggie-seed-film had it filled in on 27 Oct from its own iterations (the
   * knobs that changed, Super's reason, the call's tokens; thinking was off), with
   * no `note` or `expect`.
   */
  patch: Patch.optional(),
});
export type Iteration = z.infer<typeof Iteration>;

export const Session = z.object({
  version: z.literal(1),
  clip: z.object({ name: z.string(), duration_s: z.number(), sha256: z.string() }),
  hint: z.string(),
  recorded_at: z.string(),
  models: Models.optional(),
  /** a gesture clip: where its hand path was traced (node cannot run MediaPipe), e.g. "MediaPipe in Chrome 152 on 27 Oct 2026" */
  traced: z.string().optional(),
  /** what Super VL saw, before the fit */
  label: z.object({ spec: TaskSpec, warnings: z.array(z.string()), cost_usd: z.number(), seconds: z.number() }),
  /** the spec fitted to the SO-101's bench, and everything the fit changed or left out */
  fit: z.object({ spec: TaskSpec, warnings: z.array(z.string()) }),
  turns: z.array(Turn).min(1),
  iterations: z.array(Iteration).min(1),
  /** set when a recording ran without the Notes stage (#28): the story stops after the interview */
  pending: z.array(z.string()).default([]),
  /**
   * How this recording was chosen among several runs of its clip, said on its page. Written by
   * hand after choosing; the recorder never writes it, so a new recording starts without the claim.
   */
  selection: z.object({ runs: z.number().int().positive(), kept: z.string(), others: z.string().optional() }).optional(),
  ledger: z.array(Call),
  total_usd: z.number(),
});
export type Session = z.infer<typeof Session>;

/** A clip recorded up to its label: the fit found nothing node can rehearse (`stops` says why). */
export const LabelRecording = z.object({
  version: z.literal(1),
  clip: Session.shape.clip,
  hint: z.string(),
  recorded_at: z.string(),
  models: Models,
  label: Session.shape.label,
  fit: Session.shape.fit,
  stops: z.string(),
  ledger: z.array(Call),
  total_usd: z.number(),
});
export type LabelRecording = z.infer<typeof LabelRecording>;
