/**
 * A question a variant's own program asks (#110), answered on its card: the
 * answers go into that variant's spec as interview answers, and the variant
 * is compiled again from the program that asked.
 */
import { answerChange, type Ask } from "@/lib/spec/answer";
import { applyChanges, parsePath, valueAt } from "@/lib/spec/apply";
import type { SpecChange, TaskSpec } from "@/lib/spec/schema";
import type { Variant } from "./validate";

/** The next interview turn of a spec: one past the last `interview#<turn>` in its provenance. */
export function nextTurn(spec: TaskSpec): number {
  const all = [...spec.objects, ...spec.steps].flatMap((x) => [x.source, ...Object.values(x.sources ?? {})]);
  return 1 + Math.max(0, ...all.map((src) => Number(/^interview#(\d+)$/.exec(String(src))?.[1] ?? 0)));
}

/**
 * A variant with the person's answers to the questions its own program asked
 * (#110): applied to its spec as interview answers, the fields they set shown
 * among its edits against the task above. The reason when they do not apply,
 * null when nothing is answered.
 */
export function answered(base: TaskSpec, v: Variant, asks: Ask[], raw: Record<string, string>): { variant: Variant; changes: SpecChange[] } | { why: string } | null {
  const turn = nextTurn(v.spec);
  const changes = asks.flatMap((a) => answerChange(v.spec, a.slot, raw[a.slot], `interview#${turn}`) ?? []);
  if (changes.length === 0) return null;
  const applied = applyChanges(v.spec, changes);
  if (applied.warnings.length) return { why: applied.warnings.join("; ") };
  // edits are by field, as buildVariant lists them: steps[s2].tolerances, not steps[s2].tolerances.x_mm
  const fields = [...new Set(changes.map((c) => parsePath(c.path).slice(0, 3)).map(([list, id, field]) => `${list}[${id}].${field}`))];
  const edits = [...v.edits.filter((e) => !fields.includes(e.path)), ...fields.map((path) => ({ path, before: valueAt(base, path), after: valueAt(applied.spec, path) }))];
  return { variant: { ...v, spec: applied.spec, edits: edits.filter((e) => JSON.stringify(e.before) !== JSON.stringify(e.after)) }, changes };
}
