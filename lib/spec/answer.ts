/**
 * What the person types back for one compile `ask`, as a SpecChange. Until
 * Super runs the interview (#17), the page shows each ask as a form field:
 * a number for a measured field (…_mm, …_deg, …_s), a choice of checks for a
 * step's `success`. Anything else is not answerable here yet.
 */
import { parsePath } from "./apply";
import type { Predicate, TaskSpec } from "./schema";

export type AskForm =
  | { kind: "number"; unit: string }
  | { kind: "success"; options: { label: string; predicates: Predicate[] }[] }
  | { kind: "unsupported" };

const UNITS: [RegExp, string][] = [
  [/_mm$/, "mm"],
  [/_deg$/, "°"],
  [/_s$/, "s"],
];

export function formFor(spec: TaskSpec, slot: string): AskForm {
  const unit = UNITS.find(([re]) => re.test(slot))?.[1];
  if (unit) return { kind: "number", unit };
  const path = parsePath(slot);
  const step = path[0] === "steps" && path[2] === "success" && path.length === 3 ? spec.steps.find((s) => s.id === path[1]) : undefined;
  if (!step) return { kind: "unsupported" };
  const name = (id: string) => spec.objects.find((o) => o.id === id)?.name ?? id;
  const still: Predicate = { kind: "object_still", object: step.object };
  const options: { label: string; predicates: Predicate[] }[] = [];
  if (step.target && step.target.frame !== "world") {
    const inside: Predicate = { kind: "inside_zone", object: step.object, target: step.target.frame };
    options.push({ label: `the ${name(step.object)} ends up in the ${name(step.target.frame)} and stays there`, predicates: [inside, still] });
    options.push({ label: `the ${name(step.object)} ends up in the ${name(step.target.frame)}`, predicates: [inside] });
  }
  options.push({ label: `the ${name(step.object)} comes to rest`, predicates: [still] });
  return { kind: "success", options };
}

