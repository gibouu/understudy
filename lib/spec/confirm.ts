/**
 * The question after the label (#158): the person confirms the model's sentence, or rewrites it and the clip is
 * watched again with their line as the hint. When what they did does not fit one arm (two hands working together, or
 * a task on their own body), the page says so plainly and offers the label's one-arm version as a rewrite.
 */
import type { TaskSpec } from "./schema";

/** The hint field's limit, which a rewrite becomes (app/flow.tsx, /api/label). */
export const LINE_MAX = 200;

/** The label's account of the clip, as one sentence the person confirms or rewrites. */
export const sentenceOf = (spec: Pick<TaskSpec, "title" | "summary">): string => spec.summary.trim() || spec.title.trim();

/** True when the person's version needs what one arm does not have. */
export const beyondOneArm = (spec: Pick<TaskSpec, "hands" | "on_body">): boolean => spec.hands === 2 || spec.on_body === true;

/** What does not fit one arm, in plain words; empty when the task does. */
export function scopeNotes(spec: Pick<TaskSpec, "hands" | "on_body">): string[] {
  const notes: string[] = [];
  if (spec.hands === 2) notes.push("Two hands work together here, and the SO-101 is one arm: it cannot pass or catch between two hands.");
  if (spec.on_body) notes.push("This is done on the person's own body. An arm would do it to someone else, and the rehearsal has no person in it to touch.");
  if (notes.length) notes.push("The rehearsal today is one arm moving rigid objects: a pick and place, or following the hand's path. It has no throw, no catch and no contact with a person.");
  return notes;
}

/** The label's one-arm version, offered as a rewrite when the task does not fit one arm. */
export function oneArmLine(spec: Pick<TaskSpec, "hands" | "on_body" | "one_arm">): string | undefined {
  const line = spec.one_arm?.trim();
  return line && beyondOneArm(spec) ? line.slice(0, LINE_MAX) : undefined;
}
