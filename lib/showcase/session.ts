/**
 * A showcase recording: one clip run once through the live path (label, fit,
 * compile with recorded answers, rehearsal, and Notes patches), saved as public/showcase/<clip>.json by lib/showcase/record.ts.
 * /space plays it back with no model call: every Token Factory answer comes
 * from here, and the simulator re-runs each iteration's program in the
 * browser. `results` are the rehearsals measured in node when it was
 * recorded; the browser re-runs the same deterministic physics.
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
});
export type Iteration = z.infer<typeof Iteration>;

export const Session = z.object({
  version: z.literal(1),
  clip: z.object({ name: z.string(), duration_s: z.number(), sha256: z.string() }),
  hint: z.string(),
  recorded_at: z.string(),
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
