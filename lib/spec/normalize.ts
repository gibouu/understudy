/**
 * Rewrites near-misses in model output before validation and records what
 * changed as warnings. Aliases are an allowlist of unambiguous spellings;
 * anything unknown or malformed is dropped and surfaced (an unknown or
 * malformed predicate becomes an open question or an `ask`, never a guessed
 * safety check). Lookups use own properties only, so a value such as
 * "constructor" cannot reach a prototype.
 */
import { FIXTURES, PREDICATES, SHAPES, SYMMETRIES, type Fixture, type PredicateKind, type Program, type Shape, type TaskSpec } from "./schema";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => (typeof structuredClone === "function" ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T));
/** Normalized lookup key; non-strings never match anything. */
const key = (s: unknown): string => (typeof s === "string" ? s.trim().toLowerCase().replace(/[\s-]+/g, "_") : "");
const lookup = <T>(table: Record<string, T>, k: string): T | undefined => (k && Object.hasOwn(table, k) ? table[k] : undefined);
const show = (v: unknown) => {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.slice(0, 80);
  } catch {
    return "[unprintable]";
  }
};

const FIXTURE_ALIASES: Record<string, Fixture> = {
  pocket: "pocket", hole: "pocket", slot: "pocket", socket: "pocket", insert: "pocket", insertion: "pocket", rack: "pocket",
  zone: "zone", area: "zone", surface: "zone", region: "zone", place: "zone", placement: "zone", spot: "zone",
  stack: "stack", top: "stack", on_top: "stack", stacking: "stack",
};
/** Only spellings whose meaning is one predicate; bare "contact", "height", "tilt", "aperture" are ambiguous and stay unknown. */
const PREDICATE_ALIASES: Record<string, PredicateKind> = {
  ...Object.fromEntries(PREDICATES.map((p) => [p, p])),
  no_collisions: "no_collision", collision_free: "no_collision", collisionfree: "no_collision",
  inside: "inside_zone", in_zone: "inside_zone", within_zone: "inside_zone", in_pocket: "inside_zone", inserted: "inside_zone",
  both_pads_contact: "contact_both_pads", grasped: "contact_both_pads", in_gripper: "contact_both_pads", held: "contact_both_pads",
  above: "height_above", lifted: "height_above", height_over: "height_above",
  upright: "tilt_under", tilt_below: "tilt_under", tilt_less_than: "tilt_under",
  gripper_closed: "gripper_within", aperture_within: "gripper_within",
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

function normalizePredicates(list: unknown, where: string, warnings: string[], questions: string[]): unknown[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    warnings.push(`${where}: expected a list of checks, got ${show(list)}; dropped`);
    questions.push(`${where}: the checks were not a list (${show(list)}). Which of ${PREDICATES.join(", ")} apply?`);
    return [];
  }
  const out: unknown[] = [];
  for (const p of list) {
    if (!isRec(p)) {
      warnings.push(`${where}: a check was not an object (${show(p)}); dropped`);
      questions.push(`${where}: the check ${show(p)} could not be read. Which of ${PREDICATES.join(", ")} was meant?`);
      continue;
    }
    const canonical = lookup(PREDICATE_ALIASES, key(p.kind));
    if (!canonical) {
      warnings.push(`${where}: predicate ${show(p.kind)} is not one the simulator can evaluate; dropped`);
      questions.push(`${where}: which check should replace ${show(p.kind)}? One of ${PREDICATES.join(", ")}.`);
      continue;
    }
    if (canonical !== p.kind) warnings.push(`${where}: predicate ${show(p.kind)} read as ${canonical}`);
    out.push({ ...p, kind: canonical });
  }
  return out;
}

/** Normalize a raw TaskSpec object. Unknown fixtures degrade to zone with a warning. The input is not mutated. */
/**
 * A model writes null for a field it leaves unset (Super VL did in 10 of 16
 * first labels of clips of people's own, docs/MEASUREMENTS.md section 14). No
 * field of a spec takes null, so null reads as absent, at any depth of a record
 * (not inside arrays, where a null is a missing number). Keys in `keep` stay null,
 * for the schema to reject and the model to be asked. Returns the paths dropped.
 */
function dropNulls(r: Rec, keep: ReadonlySet<string> = new Set()): string[] {
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(r)) {
    if (v === null && keep.has(k)) continue;
    if (v === null) {
      delete r[k];
      dropped.push(k);
    } else if (isRec(v)) dropped.push(...dropNulls(v).map((x) => `${k}.${x}`));
  }
  return dropped;
}

export function normalizeSpec(raw: unknown): Normalized {
  const warnings: string[] = [];
  if (!isRec(raw)) return { data: raw, warnings };
  const spec = clone(raw);
  const nulls = (where: string, r: Rec, keep?: ReadonlySet<string>) => {
    const dropped = dropNulls(r, keep);
    if (dropped.length) warnings.push(`${where}: null ${dropped.join(", ")} read as unset`);
  };
  nulls("spec", spec);
  if (spec.version === undefined) spec.version = 1;
  if (!Array.isArray(spec.warnings)) spec.warnings = [];
  if (!Array.isArray(spec.open_questions)) spec.open_questions = [];
  const questions = spec.open_questions as string[];

  if (Array.isArray(spec.objects)) {
    for (const o of spec.objects) {
      if (!isRec(o)) continue;
      const id = show(o.id);
      nulls(`object ${id}`, o);
      // a pose is where an object stands: without its three coordinates there is none (the fit lays objects out anyway)
      if (o.pose !== undefined && !(isRec(o.pose) && Array.isArray(o.pose.xyz_mm) && o.pose.xyz_mm.length === 3)) {
        warnings.push(`object ${id}: a pose without xyz_mm left out`);
        delete o.pose;
      }
      const shape = lookup(SHAPE_ALIASES, key(o.shape));
      if (shape && shape !== o.shape) warnings.push(`object ${id}: shape ${show(o.shape)} read as ${shape}`);
      if (shape) o.shape = shape;
      const sym = lookup(SYMMETRY_ALIASES, key(o.symmetry));
      if (sym && sym !== o.symmetry) warnings.push(`object ${id}: symmetry ${show(o.symmetry)} read as ${sym}`);
      if (sym) o.symmetry = sym;
      else if (o.symmetry === undefined && shape) {
        o.symmetry = shape === "cylinder" ? "axial" : shape === "sphere" ? "full" : "none";
        warnings.push(`object ${id}: symmetry defaulted from shape`);
      }
      if (o.role === undefined) {
        o.role = "manipulated";
        warnings.push(`object ${id}: role defaulted to manipulated`);
      }
    }
  }

  if (Array.isArray(spec.steps)) {
    spec.steps.forEach((s, i) => {
      if (!isRec(s)) return;
      const where = `step ${typeof s.id === "string" ? s.id : i}`;
      // an insert or a place goes somewhere: a null target is a gap the model is asked about, not an unset field
      nulls(where, s, s.verb === "insert" || s.verb === "place" ? new Set(["target"]) : undefined);
      if (isRec(s.target)) {
        const f = lookup(FIXTURE_ALIASES, key(s.target.fixture));
        if (!f) {
          warnings.push(`${where}: fixture ${show(s.target.fixture)} is not pocket, zone or stack; degraded to zone`);
          s.target.fixture = "zone";
        } else {
          if (f !== s.target.fixture) warnings.push(`${where}: fixture ${show(s.target.fixture)} read as ${f}`);
          s.target.fixture = f;
        }
      }
      if (typeof s.verb === "string" && s.verb.toLowerCase() === "gesture") {
        // a gesture handles nothing and goes nowhere: whatever the model named as its object (the hand, the
        // camera) or its target is not one
        s.verb = "gesture";
        if (s.object !== undefined) {
          if (s.object !== null && s.object !== "") warnings.push(`${where}: a gesture handles no object; ${show(s.object)} dropped`);
          delete s.object;
        }
        if (s.target !== undefined) {
          if (s.target !== null) warnings.push(`${where}: a gesture has no target; ${show(s.target)} dropped`);
          delete s.target;
        }
        if (!isRec(s.gesture)) s.gesture = {};
        const g = s.gesture as Rec;
        // the path is measured from the clip in the browser, never taken from a model: only the hand is kept
        for (const field of ["path", "reach_mm"] as const) {
          if (g[field] === undefined) continue;
          if (!(Array.isArray(g[field]) && g[field].length === 0)) warnings.push(`${where}: the model's gesture ${field} dropped; it is measured from the clip`);
          delete g[field];
        }
        const hand = typeof g.hand === "string" ? g.hand.toLowerCase() : undefined;
        if (hand === "left" || hand === "right") g.hand = hand;
        else if (g.hand !== undefined) {
          warnings.push(`${where}: hand ${show(g.hand)} is not left or right; dropped`);
          delete g.hand;
        }
      } else if (s.gesture !== undefined) {
        // the prompt's step shape lists a gesture block; on any other verb it is a copy, not a gesture
        warnings.push(`${where}: a ${show(s.verb)} step has no gesture block; dropped`);
        delete s.gesture;
      }
      s.preconditions = normalizePredicates(s.preconditions, `${where} preconditions`, warnings, questions);
      s.success = normalizePredicates(s.success, `${where} success`, warnings, questions);
    });
  }
  return { data: spec, warnings };
}

/** Ops that take no operands, which a model sometimes writes as a bare name. */
const BARE_OPS = new Set(["follow", "release"]);

/** An op a model wrote as a string: its JSON, or the name of an op with no operands; anything else as it was. */
function opFromString(op: unknown): unknown {
  if (typeof op !== "string") return op;
  const text = op.trim();
  if (BARE_OPS.has(text)) return { op: text };
  try {
    const parsed: unknown = JSON.parse(text);
    return isRec(parsed) ? parsed : op;
  } catch {
    return op;
  }
}

/** The keys of a Program beside its steps. */
const PROGRAM_KEYS = new Set(["spec_title", "warnings"]);

/**
 * One entry of a raw Program's steps, read as the model meant it: a step written
 * as a JSON string is read; a key of the program itself ("warnings", or a record
 * holding only program keys) is a bracket put one place late, closing steps after
 * it (2 of 64 first answers from Nemotron 3.5 Lightning, both repeated word for
 * word when asked again: docs/MEASUREMENTS.md section 14), so it leaves steps and
 * any warnings it holds join the program's. Anything else stays for the schema.
 */
function stepEntry(entry: unknown, program: Rec, warnings: string[]): unknown[] {
  if (typeof entry === "string") {
    const text = entry.trim();
    // the key alone, or with the start of its value ("warnings[]", #150): never a step
    if (PROGRAM_KEYS.has(/^(\w+)\W*$/.exec(text)?.[1] ?? "")) {
      warnings.push(`steps held the key ${show(text)}, closed one place late; read as the program's`);
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRec(parsed)) {
        warnings.push(`a step written as a string; read as ${show(parsed.step_id)}`);
        return [parsed];
      }
    } catch {
      // not JSON: the schema says what is wrong with it
    }
    return [entry];
  }
  if (isRec(entry) && Object.keys(entry).length > 0 && Object.keys(entry).every((k) => PROGRAM_KEYS.has(k))) {
    warnings.push(`steps held the program's ${Object.keys(entry).join(", ")}, closed one place late; read as the program's`);
    if (Array.isArray(entry.warnings)) program.warnings = [...(Array.isArray(program.warnings) ? program.warnings : []), ...entry.warnings];
    if (typeof entry.spec_title === "string" && typeof program.spec_title !== "string") program.spec_title = entry.spec_title;
    return [];
  }
  return [entry];
}

/** Normalize a raw Program: steps and ops written as strings are read, a key of the program caught inside steps is put back, unknown or malformed predicate kinds become `ask` slots instead of guesses. */
export function normalizeProgram(raw: unknown): Normalized {
  const warnings: string[] = [];
  if (!isRec(raw)) return { data: raw, warnings };
  const program = clone(raw);
  if (!Array.isArray(program.steps)) return { data: program, warnings };
  const steps = program.steps.flatMap((entry: unknown) => stepEntry(entry, program, warnings));
  program.steps = steps;
  for (const step of steps) {
    if (!isRec(step) || !Array.isArray(step.ops)) continue;
    const stepId = show(step.step_id);
    step.ops = step.ops.map((raw: unknown) => {
      const op = opFromString(raw);
      if (op !== raw) warnings.push(`step ${stepId}: op ${show(raw)} written as a string; read as ${show(op)}`);
      if (!isRec(op) || (op.op !== "assert" && op.op !== "wait_until")) return op;
      const pred = isRec(op.predicate) ? op.predicate : null;
      const canonical = pred ? lookup(PREDICATE_ALIASES, key(pred.kind)) : undefined;
      if (pred && canonical) {
        if (canonical !== pred.kind) warnings.push(`step ${stepId}: predicate ${show(pred.kind)} read as ${canonical}`);
        return { ...op, predicate: { ...pred, kind: canonical } };
      }
      const kind = pred ? show(pred.kind) : show(op.predicate);
      warnings.push(`step ${stepId}: predicate ${kind} cannot be evaluated; turned into an ask`);
      return {
        op: "ask",
        slot: `steps[${typeof step.step_id === "string" ? step.step_id : "?"}].success`,
        question: `The check ${kind} cannot be measured in the rehearsal. Which of these applies: ${PREDICATES.join(", ")}?`,
        why: "unknown predicate from the compiler",
      };
    });
  }
  return { data: program, warnings };
}

/**
 * Nano sometimes names a fixture by its kind ("pocket") where an object id
 * belongs. Inside a step whose target is that kind, the kind can only mean
 * the target, so it is replaced by the target's id; anywhere else it stays
 * and the interpreter reports the unknown frame.
 */
export function resolveFixtureNames(program: Program, spec: TaskSpec): { program: Program; warnings: string[] } {
  const ids = new Set(spec.objects.map((o) => o.id));
  const warnings: string[] = [];
  const steps = program.steps.map((s) => {
    const target = spec.steps.find((x) => x.id === s.step_id)?.target;
    if (!target || ids.has(target.fixture)) return s;
    const fix = (name: string | undefined, where: string) => {
      if (name !== target.fixture) return name;
      warnings.push(`step ${s.step_id}: ${where} "${name}" read as ${target.frame}`);
      return target.frame;
    };
    return {
      ...s,
      ops: s.ops.map((op) => {
        if (op.op === "move_to") return { ...op, frame: fix(op.frame, "frame")! };
        if (op.op === "assert" || op.op === "wait_until") {
          const p = op.predicate;
          return { ...op, predicate: { ...p, object: fix(p.object, "check object"), target: fix(p.target, "check target") } };
        }
        return op;
      }),
    };
  });
  return { program: { ...program, steps }, warnings };
}

export const KNOWN_FIXTURES = FIXTURES;
