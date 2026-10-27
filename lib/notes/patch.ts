/**
 * The patch loop's contract, as measured in docs/MEASUREMENTS.md section 8:
 * the patcher gets the task, the knobs with their bounds, one line per
 * earlier attempt, what happened to its last values (clamped, rejected) and
 * the failure note, and returns one patch. Super thinks only when it is
 * stuck: from the start it runs with thinking off, and switches to thinking
 * on (4k tokens) for the rest of the loop after a patch that changes nothing
 * (re-asked at once) or after its second failed patch. That escalation fixed
 * 94% of solvable failures within five patches, at US$0.0024 per fix. Super
 * VL, in Super's place since #137, cannot think within that budget, so with it
 * the stuck loop asks Ultra with thinking off (docs/MEASUREMENTS.md section 12).
 */
import { z } from "zod";
import type { Program, TaskSpec } from "@/lib/spec/schema";
import { DEFAULT_CLEARANCE_MM } from "@/lib/sim/scene";
import { knobLines, restingSurface, type Clamp, type Knob } from "./knobs";

export const MAX_PATCHES = 5;
/** thinking off: an answer is a few hundred tokens */
export const MAX_TOKENS_OFF = 800;
/** thinking on: the budget covers reasoning and answer */
export const MAX_TOKENS_ON = 4096;

export const PATCH_SYSTEM = `You edit a small robot program after a failed rehearsal in a physics simulator. The program is a list of moves and checks; the numbers of the step that failed are knobs with bounds. You get the task, the worlds it must pass in, the knobs with their current values, the earlier attempts, and the simulator's failure note: what it measured in the failed rollout. Propose one patch: the knob values to change for the next rollout, the change most likely to make it pass in every world. The checks the program makes are fixed and you cannot change them. Use only the listed knob names and keep numbers within bounds.
Return one JSON object only: {"set":{<knob>:<value>,...},"why":<one sentence citing the measurement behind the change>,"expect":<one sentence: what the next rollout should show>}`;

/** What Super returns; `set` is validated and clamped by applyPatch. */
export const PatchReply = z.object({
  set: z.record(z.string(), z.unknown()).default({}),
  why: z.string().default(""),
  expect: z.string().default(""),
});
export type PatchReply = z.infer<typeof PatchReply>;

/** One earlier patch and what its rehearsal showed, as the page sends it back. */
export const Attempt = z.object({
  set: z.record(z.string(), z.number()).default({}),
  thinking: z.boolean().default(false),
  clamps: z.array(z.object({ name: z.string(), requested: z.number(), applied: z.number() })).default([]),
  rejected: z.array(z.string()).default([]),
  /** outcomeLine() of the rehearsal after this patch */
  outcome: z.string().max(2000),
});
export type Attempt = z.infer<typeof Attempt>;

export type Escalation = "noop" | "two_failed";

/**
 * Patchers whose reasoning does not fit MAX_TOKENS_ON. Super VL, in Super's
 * place since #137, used all 4,096 tokens and returned no answer in 83% of its
 * thinking calls (docs/MEASUREMENTS.md section 12); with it, the stuck loop asks
 * Nemotron 3 Ultra with thinking off (89% fixed within five patches, against
 * 94% for Super escalating to its own thinking).
 */
export const NO_ROOM_TO_THINK: ReadonlySet<string> = new Set(["nvidia/Nemotron-3.5-Super-VL"]);

/** Who answers a stuck loop (app/api/notes/route.ts): the patcher itself, thinking, or Ultra in place of one that cannot think within the budget. */
export const stuckRole = (patcher: string): "super" | "ultra" => (NO_ROOM_TO_THINK.has(patcher) ? "ultra" : "super");

/**
 * Why the next patch thinks, or null while the cheap patcher still has a go. Once escalated, the
 * loop stays escalated: after a no-op (the route re-asks at once, so that patch already thought)
 * or after the cheap patcher's second failed patch.
 */
export function escalation(history: Attempt[]): Escalation | null {
  const first = history.findIndex((a) => a.thinking);
  if (first >= 0) return first >= 2 ? "two_failed" : "noop";
  return history.length >= 2 ? "two_failed" : null;
}

/** what happened to the last patch's values, so nothing is clamped silently */
function checkLine(last: Attempt | undefined): string | null {
  if (!last) return null;
  const parts = [...last.clamps.map((c: Clamp) => `${c.name} = ${c.requested} is outside its bounds and was clamped to ${c.applied}`), ...last.rejected.map((n) => `${n} was not applied (not a knob, or not a usable value)`)];
  return parts.length ? `Your last patch: ${parts.join("; ")}.` : null;
}

function task(spec: TaskSpec): string {
  const name = (id: string) => spec.objects.find((o) => o.id === id)?.name ?? id;
  const objects = spec.objects.map((o) => {
    const s = restingSurface(spec, o.id);
    const pocket = s.rim === undefined ? "" : `; a pocket ${o.pocket_clearance_mm ?? DEFAULT_CLEARANCE_MM} mm wider than what goes in, its floor at z = ${s.z} mm and its rim at z = ${s.rim} mm in its frame`;
    return `${o.id} (${o.name}): ${o.role} ${o.shape}, ${o.size_mm.join(" x ")} mm${pocket}`;
  });
  const steps = spec.steps.map((s) => `${s.id}: ${s.verb}${s.object === undefined ? "" : ` ${s.object}`}${s.target ? ` into the ${s.target.fixture} of ${s.target.frame} (${name(s.target.frame)})` : ""}`);
  return [`${spec.title}. ${spec.summary}`.trim(), `Objects (sizes along x, y, z; frames at their centres; z up):\n${objects.join("\n")}`, `Steps:\n${steps.join("\n")}`].join("\n");
}

export function patchPrompt(spec: TaskSpec, program: Program, knobs: Knob[], firstOutcome: string, history: Attempt[], note: string): string {
  const attempt = history.length + 1;
  const attempts = [`- attempt 0: the compiled program -> ${firstOutcome}`, ...history.map((a, i) => `- attempt ${i + 1}: set ${JSON.stringify(a.set)} -> ${a.outcome}`)];
  const check = checkLine(history.at(-1));
  return [
    `Task: ${task(spec)}`,
    "Worlds: the program is rehearsed on Earth (1 g) and in orbit (0 g, nothing falls) after every patch, and must pass in both.",
    `Knobs (current values):\n${knobLines(knobs)}`,
    `Attempts so far:\n${attempts.join("\n")}`,
    ...(check ? [check] : []),
    `Failure note from the last rehearsal (attempt ${attempt - 1}):\n${note}`,
    `Return patch ${attempt} of at most ${MAX_PATCHES}.`,
  ].join("\n\n");
}

/** What /api/notes returns for one patch. */
export type NotePatch = {
  /** the patched program, ready to rehearse */
  program: Program;
  /** knob -> value as applied */
  set: Record<string, number>;
  changes: { name: string; from: number; to: number }[];
  clamps: Clamp[];
  rejected: string[];
  /** nothing changed: the patcher had no better idea */
  noop: boolean;
  why: string;
  expect: string;
  /** what the simulator told the patcher */
  note: string;
  model: string;
  /** the loop is stuck, so the deeper patcher answered: Super thinking, or Ultra with thinking off in place of Super VL (app/api/notes/route.ts) */
  thinking: boolean;
  /** the model reasoned (thinking on); recordings and fixtures made before this field: `thinking`, which meant that then */
  thought?: boolean;
  escalation: Escalation | null;
  tokens: number;
  cost_usd: number;
};
