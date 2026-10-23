/**
 * Rewrites near-misses in model output before validation and records what
 * changed as warnings. Aliases are an allowlist; anything unknown is dropped
 * and surfaced (an unknown predicate becomes an open question or an `ask`,
 * never a guessed safety check).
 */
import { FIXTURES, PREDICATES, SHAPES, SYMMETRIES, type Fixture, type PredicateKind, type Shape } from "./schema";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => (typeof structuredClone === "function" ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T));
const key = (s: unknown) => String(s).trim().toLowerCase().replace(/[\s-]+/g, "_");

const FIXTURE_ALIASES: Record<string, Fixture> = {
  pocket: "pocket", hole: "pocket", slot: "pocket", socket: "pocket", insert: "pocket", insertion: "pocket", rack: "pocket",
  zone: "zone", area: "zone", surface: "zone", region: "zone", place: "zone", placement: "zone", spot: "zone",
  stack: "stack", top: "stack", on_top: "stack", stacking: "stack",
};
const PREDICATE_ALIASES: Record<string, PredicateKind> = {
  ...Object.fromEntries(PREDICATES.map((p) => [p, p])),
  no_collisions: "no_collision", collision_free: "no_collision", collisionfree: "no_collision",
  inside: "inside_zone", in_zone: "inside_zone", within_zone: "inside_zone", in_pocket: "inside_zone", inserted: "inside_zone",
  contact: "contact_both_pads", both_pads_contact: "contact_both_pads", grasped: "contact_both_pads", in_gripper: "contact_both_pads",
  above: "height_above", lifted: "height_above", height: "height_above",
  upright: "tilt_under", tilt_below: "tilt_under", tilt: "tilt_under",
  gripper_closed: "gripper_within", aperture_within: "gripper_within", aperture: "gripper_within",
  still: "object_still", stable: "object_still", at_rest: "object_still",
  within_time: "time_under", time_below: "time_under", duration_under: "time_under",
};
const SHAPE_ALIASES: Record<string, Shape> = {
  ...Object.fromEntries(SHAPES.map((s) => [s, s])),
  cylindrical: "cylinder", tube: "cylinder", bottle: "cylinder", can: "cylinder", marker: "cylinder", pen: "cylinder", cup: "cylinder",
  cube: "box", cuboid: "box", block: "box", carton: "box", rectangular: "box",
  ball: "sphere", round: "sphere", spherical: "sphere",
};
const SYMMETRY_ALIASES: Record<string, (typeof SYMMETRIES)[number]> = {
  ...Object.fromEntries(SYMMETRIES.map((s) => [s, s])),
  cylindrical: "axial", rotational: "axial", around_z: "axial",
  spherical: "full", any: "full",
  asymmetric: "none", box: "none", no: "none",
};

export type Normalized = { data: unknown; warnings: string[] };

function normalizePredicates(list: unknown, where: string, warnings: string[], dropped: string[]): unknown[] {
  if (!Array.isArray(list)) return [];
  const out: unknown[] = [];
  for (const p of list) {
    if (!isRec(p)) continue;
    const k = key(p.kind);
    const canonical = PREDICATE_ALIASES[k];
    if (!canonical) {
      warnings.push(`${where}: predicate "${String(p.kind)}" is not one the simulator can evaluate; dropped`);
      dropped.push(`${where}: which check should replace "${String(p.kind)}"? One of ${PREDICATES.join(", ")}.`);
      continue;
    }
    if (canonical !== p.kind) warnings.push(`${where}: predicate "${String(p.kind)}" read as ${canonical}`);
    out.push({ ...p, kind: canonical });
  }
  return out;
}

/** Normalize a raw TaskSpec object. Unknown fixtures degrade to zone with a warning. */
export function normalizeSpec(raw: unknown): Normalized {
  const warnings: string[] = [];
  if (!isRec(raw)) return { data: raw, warnings };
  const spec = clone(raw);
  if (spec.version === undefined) spec.version = 1;
  if (!Array.isArray(spec.warnings)) spec.warnings = [];
  if (!Array.isArray(spec.open_questions)) spec.open_questions = [];
  const openQuestions = spec.open_questions as unknown[];

  if (Array.isArray(spec.objects)) {
    for (const o of spec.objects) {
      if (!isRec(o)) continue;
      const shape = SHAPE_ALIASES[key(o.shape)];
      if (shape && shape !== o.shape) warnings.push(`object ${String(o.id)}: shape "${String(o.shape)}" read as ${shape}`);
      if (shape) o.shape = shape;
      const sym = SYMMETRY_ALIASES[key(o.symmetry)];
      if (sym && sym !== o.symmetry) warnings.push(`object ${String(o.id)}: symmetry "${String(o.symmetry)}" read as ${sym}`);
      if (sym) o.symmetry = sym;
      else if (o.symmetry === undefined && shape) {
        o.symmetry = shape === "cylinder" ? "axial" : shape === "sphere" ? "full" : "none";
        warnings.push(`object ${String(o.id)}: symmetry defaulted from shape`);
      }
      if (o.role === undefined) {
        o.role = "manipulated";
        warnings.push(`object ${String(o.id)}: role defaulted to manipulated`);
      }
    }
  }

  if (Array.isArray(spec.steps)) {
    spec.steps.forEach((s, i) => {
      if (!isRec(s)) return;
      const where = `step ${String(s.id ?? i)}`;
      if (isRec(s.target)) {
        const f = FIXTURE_ALIASES[key(s.target.fixture)];
        if (!f) {
          warnings.push(`${where}: fixture "${String(s.target.fixture)}" is not pocket, zone or stack; degraded to zone`);
          s.target.fixture = "zone";
        } else {
          if (f !== s.target.fixture) warnings.push(`${where}: fixture "${String(s.target.fixture)}" read as ${f}`);
          s.target.fixture = f;
        }
      }
      const dropped: string[] = [];
      s.preconditions = normalizePredicates(s.preconditions, `${where} preconditions`, warnings, dropped);
      s.success = normalizePredicates(s.success, `${where} success`, warnings, dropped);
      openQuestions.push(...dropped);
    });
  }
  return { data: spec, warnings };
}

/** Normalize a raw Program: unknown predicate kinds become `ask` slots instead of guesses. */
export function normalizeProgram(raw: unknown): Normalized {
  const warnings: string[] = [];
  if (!isRec(raw)) return { data: raw, warnings };
  const program = clone(raw);
  if (!Array.isArray(program.steps)) return { data: program, warnings };
  for (const step of program.steps) {
    if (!isRec(step) || !Array.isArray(step.ops)) continue;
    step.ops = step.ops.map((op: unknown) => {
      if (!isRec(op) || (op.op !== "assert" && op.op !== "wait_until") || !isRec(op.predicate)) return op;
      const k = key(op.predicate.kind);
      const canonical = PREDICATE_ALIASES[k];
      if (canonical) {
        if (canonical !== op.predicate.kind) warnings.push(`step ${String(step.step_id)}: predicate "${String(op.predicate.kind)}" read as ${canonical}`);
        return { ...op, predicate: { ...op.predicate, kind: canonical } };
      }
      warnings.push(`step ${String(step.step_id)}: predicate "${String(op.predicate.kind)}" cannot be evaluated; turned into an ask`);
      return {
        op: "ask",
        slot: `steps[${String(step.step_id)}].success`,
        question: `The check "${String(op.predicate.kind)}" cannot be measured in the rehearsal. Which of these applies: ${PREDICATES.join(", ")}?`,
        why: "unknown predicate from the compiler",
      };
    });
  }
  return { data: program, warnings };
}

export const KNOWN_FIXTURES = FIXTURES;
