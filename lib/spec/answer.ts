/**
 * What the person types back for one compile `ask`, as a SpecChange. Until
 * Super runs the interview (#17), the page shows each ask as a form field:
 * a number for a measured field (…_mm, …_deg, …_s), a choice of checks for a
 * step's `success`. Anything else is not answerable here yet.
 */
import { parsePath } from "./apply";
import { AXES, type Predicate, type Program, type ProgramOp, type TaskSpec } from "./schema";

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
  if (step.pour) {
    // a pour succeeds by where the liquid goes, not by where the container ends up
    const into = step.pour.into;
    for (const [value, label] of [[90, "nearly all of it"], [75, "most of it"], [50, "at least half of it"]] as const) {
      options.push({ label: `${label} (${value}%) ends up in the ${name(into)}`, predicates: [{ kind: "liquid_inside", target: into, value }] });
    }
    return { kind: "success", options };
  }
  if (step.target && step.target.frame !== "world") {
    const inside: Predicate = { kind: "inside_zone", object: step.object, target: step.target.frame };
    options.push({ label: `the ${name(step.object)} ends up in the ${name(step.target.frame)} and stays there`, predicates: [inside, still] });
    options.push({ label: `the ${name(step.object)} ends up in the ${name(step.target.frame)}`, predicates: [inside] });
  }
  options.push({ label: `the ${name(step.object)} comes to rest`, predicates: [still] });
  return { kind: "success", options };
}


/**
 * The slots a person who did the task can answer: a pocket's clearance, a
 * step's tolerance on one axis, what counts as success. Poses and sizes come
 * from the fit and moves from the compile route, so an ask about anything
 * else (a carry point, a speed) has no one to answer it.
 */
export function askable(spec: TaskSpec, slot: string): boolean {
  const [list, id, field, sub, ...rest] = parsePath(slot);
  if (rest.length) return false;
  if (list === "objects") return spec.objects.some((o) => o.id === id && o.role === "fixture") && field === "pocket_clearance_mm" && sub === undefined;
  if (list !== "steps" || !spec.steps.some((s) => s.id === id)) return false;
  return (field === "success" && sub === undefined) || (field === "tolerances" && (AXES as readonly string[]).includes(sub));
}

/**
 * The gaps the rehearsal cannot run without, read from the spec: a pocket
 * with no clearance (the scene would assume 3 mm) and an insert, place or
 * pour step with no success check. Each one the program does not already ask
 * about gets an ask at the start of the step that needs it.
 */
export function withRequiredAsks(spec: TaskSpec, program: Program): { program: Program; added: string[] } {
  const asked = new Set(program.steps.flatMap((s) => s.ops).flatMap((op) => (op.op === "ask" ? [op.slot] : [])));
  const name = (id: string) => spec.objects.find((o) => o.id === id)?.name ?? id;
  const added: string[] = [];
  const steps = program.steps.map((ps) => {
    const step = spec.steps.find((s) => s.id === ps.step_id);
    if (step?.pour) {
      const success = `steps[${step.id}].success`;
      if (step.success.length > 0 || asked.has(success)) return ps;
      added.push(success);
      const ask = { op: "ask" as const, slot: success, question: `How much of what is in the ${name(step.object)} has to end up in the ${name(step.pour.into)} for the pour to count?`, why: "the step has no success check" };
      return { ...ps, ops: [ask, ...ps.ops] };
    }
    if (!step?.target || (step.verb !== "insert" && step.verb !== "place")) return ps;
    const asks: Extract<ProgramOp, { op: "ask" }>[] = [];
    const fixture = spec.objects.find((o) => o.id === step.target!.frame);
    const clearance = `objects[${step.target.frame}].pocket_clearance_mm`;
    if (step.target.fixture === "pocket" && fixture && fixture.pocket_clearance_mm === undefined && !asked.has(clearance)) {
      asks.push({ op: "ask", slot: clearance, question: `How much wider than the ${name(step.object)} is the opening of the ${name(fixture.id)}?`, why: "the pocket's clearance was not visible" });
    }
    const success = `steps[${step.id}].success`;
    if (step.success.length === 0 && !asked.has(success)) {
      asks.push({ op: "ask", slot: success, question: `When does putting the ${name(step.object)} in the ${name(step.target.frame)} count as done?`, why: "the step has no success check" });
    }
    added.push(...asks.map((a) => a.slot));
    return asks.length ? { ...ps, ops: [...asks, ...ps.ops] } : ps;
  });
  return { program: { ...program, steps }, added };
}
