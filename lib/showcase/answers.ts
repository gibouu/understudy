/**
 * The answers the recorder gives to Nano's questions, standing in for the
 * person who did the task, through the same forms the guided flow shows
 * (lib/spec/answer.ts): a number for a measured field, a choice of checks
 * for a step's success. Per clip, so they are data about one clip, not code
 * about one task; a clip with no entry gets the defaults.
 */
import { formFor } from "@/lib/spec/answer";
import { parsePath } from "@/lib/spec/apply";
import type { TaskSpec } from "@/lib/spec/schema";
import type { Answer } from "./session";

export type Answers = {
  /** how much wider a pocket is than what goes in */
  clearance_mm: number;
  /** how far off along one axis still counts */
  tolerance_mm: number;
  tolerance_deg: number;
  /** which of formFor's success options, in its order (0: ends up in the target and stays there) */
  success: number;
};

export const DEFAULT_ANSWERS: Answers = { clearance_mm: 10, tolerance_mm: 5, tolerance_deg: 10, success: 0 };

/** Pocket clearance and tolerances as Cam answered them for the ISS clip in tests/fixtures/compile.json. */
export const CLIP_ANSWERS: Record<string, Partial<Answers>> = {
  "iss-veggie-seed-film": { clearance_mm: 10, tolerance_mm: 5, success: 0 },
};

/** A slot in words: `objects[obj2].pocket_clearance_mm` -> "the pocket clearance of the plant pillow". */
export function slotWords(spec: TaskSpec, slot: string): string {
  const [list, id, field, sub] = parsePath(slot);
  const name = (x: string) => spec.objects.find((o) => o.id === x)?.name ?? x;
  if (list === "objects" && field === "pocket_clearance_mm") return `the pocket clearance of the ${name(id)}`;
  const step = list === "steps" ? spec.steps.find((s) => s.id === id) : undefined;
  const what = step ? (step.object === undefined ? step.verb : `${step.verb} the ${name(step.object)}`) : `step ${id}`;
  if (field === "success") return `when "${what}" counts as done`;
  if (field === "tolerances" && sub) return `how far off "${what}" may land (${sub.replace(/_(mm|deg)$/, "")})`;
  return slot;
}

/** The answer to one ask, or null when its form takes none of these answers. `turn` is the interview turn (1-based). */
export function answerFor(spec: TaskSpec, slot: string, turn: number, answers: Answers): Answer | null {
  const form = formFor(spec, slot);
  const source = `interview#${turn}`;
  if (form.kind === "success") {
    const option = form.options[Math.min(answers.success, form.options.length - 1)];
    return { slot, text: option.label, change: { path: slot, value: option.predicates, source } };
  }
  if (form.kind !== "number") return null;
  const value = /pocket_clearance_mm$/.test(slot) ? answers.clearance_mm : /\.tolerances\.\w+_mm$/.test(slot) ? answers.tolerance_mm : /\.tolerances\.\w+_deg$/.test(slot) ? answers.tolerance_deg : null;
  if (value === null) return null;
  return { slot, text: `${value} ${form.unit}`, change: { path: slot, value, source } };
}
