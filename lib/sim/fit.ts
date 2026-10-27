/**
 * Fit a labelled spec to the SO-101's bench. The vision model names the task
 * well but guesses poses from a camera with no scale (400 to 480 mm out,
 * past the ~300 mm reach), adds filler steps (reach, retract, a repeat) and
 * objects that play no part. The rehearsal keeps one manipulation: the first
 * insert or place step, a grasp of its object before it, and the two objects
 * they use, laid out where the arm is known to reach and sized to what its
 * jaws hold. Everything else is reported, never silently dropped. A missing
 * pocket clearance stays missing: the compiler asks for it.
 *
 * A clip with no such step but gestures keeps its gesture steps that have a
 * hand path (traced in the browser, already scaled into the arm's reach by
 * lib/sim/gesture.ts) and no objects: a gesture handles nothing.
 */
import type { Predicate, SpecObject, Step, TaskSpec } from "@/lib/spec/schema";

/** Resting spots checked by tests/sim/demo-spec.test.ts: in reach, clear of each other. */
const HELD_XY_MM = [200, -100] as const;
const FIXTURE_XY_MM = [175, 100] as const;
/** The jaws open to 60 mm; top-down reach ends near 90 mm above the table. */
const HELD_SIDE_MM = [6, 50] as const;
const HELD_MAX_H_MM = 40;
const FIXTURE_SIDE_MAX_MM = 150;
const FIXTURE_H_MM = [10, 30] as const;
/** Pocket clearance the 1 g / 0 g rehearsal has been measured over. */
const MAX_CLEARANCE_MM = 20;

/** `where`: the slot of the one question the person is asked before anything can be rehearsed (whereTo). */
export type Fit = { spec: TaskSpec; warnings: string[]; where?: string };

/** The answer "somewhere else on the bench" (lib/spec/answer.ts formFor): a fixture like any other once it is chosen. */
export const BENCH_SPOT = { id: "bench_spot", name: "spot on the bench", shape: "box", size_mm: [100, 100, 10], symmetry: "none", role: "surface", confidence: 1, source: "fit", sources: {} } as const satisfies SpecObject;

/**
 * A label that holds something but never says where it goes (a move with no target, a clip that
 * never lets go: 12 of the 15 labels of people's own clips left with nothing to rehearse after #150,
 * docs/MEASUREMENTS.md section 16): the grasp, and a place with no target for the person to name.
 * The scene's other objects stay in the spec as the answers to choose from, with a spot on the bench;
 * nothing is laid out until the answer comes back, when the fit runs again on the answered spec.
 */
function whereTo(spec: TaskSpec): Fit | null {
  const named = (id: string | undefined) => id !== undefined && spec.objects.some((o) => o.id === id);
  const first = spec.steps.find((s) => (s.verb === "grasp" || s.verb === "move") && named(s.object));
  if (!first) return null;
  const held = spec.objects.find((o) => o.id === first.object)!;
  const grasp = spec.steps.find((s) => s.verb === "grasp" && s.object === held.id);
  const steps: Step[] = [
    grasp ? { ...grasp, id: "s1", target: undefined } : { ...first, id: "s1", verb: "grasp", target: undefined, via_points: [], preconditions: [], success: [], tolerances: {}, source: "fit", sources: {} },
    { ...first, id: "s2", verb: "place", target: undefined, via_points: [], preconditions: [], success: [], tolerances: {}, t_start_s: (grasp ?? first).t_end_s, t_end_s: Math.max(...spec.steps.filter((s) => s.object === held.id).map((s) => s.t_end_s)), source: "fit", sources: {} },
  ];
  const spot = spec.objects.some((o) => o.id === BENCH_SPOT.id) ? [] : [{ ...BENCH_SPOT, size_mm: [...BENCH_SPOT.size_mm] as [number, number, number], sources: {} }];
  return {
    spec: { ...spec, objects: [...spec.objects, ...spot], steps, anchor: undefined },
    warnings: [`the label shows the ${held.name} picked up but not where it goes: the robot asks`],
    where: "steps[s2].target",
  };
}

const clamp = (x: number, [lo, hi]: readonly [number, number]) => Math.min(Math.max(x, lo), hi);

/**
 * A label with no insert or place step that still puts something down: a move of an object onto a
 * named object, then a release of it with no grasp between, is that place. The move says where the
 * object went, the release that the hand let go of it there. The release's own target wins, and one
 * that names no other object stops it; so does a release with preconditions of its own. Super VL wrote this in 7 of the 14 labels of people's own clips that had
 * nothing to rehearse (docs/MEASUREMENTS.md section 15). Null when the label has no such pair; `at`
 * is where the move sits in the label.
 */
function placeFromMove(spec: TaskSpec): { act: Step; at: number; note: string } | null {
  const named = (t: Step["target"], held: string) => (t && t.frame !== held && spec.objects.some((o) => o.id === t.frame) ? t : undefined);
  for (const [r, rel] of spec.steps.entries()) {
    if (rel.verb !== "release" || rel.object === undefined) continue;
    const held = rel.object;
    // the last move of the object before its release, with the hand still on it in between
    const at = spec.steps.slice(0, r).findLastIndex((s) => s.object === held && s.verb === "move");
    if (at < 0 || spec.steps.slice(at + 1, r).some((s) => s.object === held && (s.verb === "grasp" || s.verb === "release"))) continue;
    const move = spec.steps[at];
    // a release that names somewhere else (a point, the object itself) was not let go where the move went
    const target = rel.target ? named(rel.target, held) : named(move.target, held);
    // the release's own preconditions belong to the moment of letting go, which a place step's start is not
    if (!target || rel.preconditions.length > 0) continue;
    // the place ends as the release did: its checks and its landing tolerances; the move's checks were for the carry
    const act: Step = { ...move, verb: "place", target, t_end_s: Math.max(move.t_end_s, rel.t_end_s), success: rel.success, tolerances: { ...move.tolerances, ...rel.tolerances }, source: "fit", sources: {} };
    return { act, at, note: `steps ${move.id} and ${rel.id}: a move onto ${target.frame}, then a release, read as a place there` };
  }
  return null;
}

export function fitToBench(spec: TaskSpec): Fit {
  const warnings: string[] = [];
  // the first insert or place onto another named object: a label may put an object "into itself" first (#150)
  const placed = spec.steps.find((s) => (s.verb === "insert" || s.verb === "place") && s.target && s.target.frame !== s.object && spec.objects.some((o) => o.id === s.target!.frame) && spec.objects.some((o) => o.id === s.object));
  // as a place does, the place read from a move outranks any gesture beside it
  const read = placed ? null : placeFromMove(spec);
  if (read) warnings.push(read.note);
  const act = placed ?? read?.act;
  if (!act && spec.steps.some((s) => s.verb === "gesture")) return fitGestures(spec);
  const held = act && spec.objects.find((o) => o.id === act.object);
  const fixture = act && spec.objects.find((o) => o.id === act.target!.frame);
  if (!act || !held || !fixture || held === fixture) {
    // nowhere named to put it down: ask, when the label at least says what was picked up
    const ask = act ? null : whereTo(spec);
    if (ask) return { ...ask, warnings: [...warnings, ...ask.warnings] };
    return { spec, warnings: ["no insert or place step onto a named object: nothing to rehearse"] };
  }

  const changed = (o: SpecObject, before: number[]) => {
    if (o.size_mm.some((v, i) => v !== before[i])) warnings.push(`${o.id}: size [${before.join(", ")}] mm scaled to [${o.size_mm.join(", ")}] mm for the robot's jaws and reach`);
  };
  const pocket = act.target!.fixture === "pocket";
  // an object goes into a pocket along its longest axis, so it stands on it
  const sides = pocket ? [...held.size_mm].sort((a, b) => b - a) : [...held.size_mm];
  const [x, y, z] = pocket ? [sides[1], sides[2], sides[0]] : sides;
  const h: SpecObject = {
    ...held,
    role: "manipulated",
    size_mm: [clamp(x, HELD_SIDE_MM), held.shape === "box" ? clamp(y, HELD_SIDE_MM) : clamp(x, HELD_SIDE_MM), Math.min(z, HELD_MAX_H_MM)],
    pose: { xyz_mm: [HELD_XY_MM[0], HELD_XY_MM[1], 0], yaw_deg: 0, frame: "world" },
    sources: { ...held.sources, pose: "fit", size_mm: "fit" },
  };
  if (held.shape === "sphere") h.size_mm = [h.size_mm[0], h.size_mm[0], h.size_mm[0]];
  h.pose!.xyz_mm[2] = h.size_mm[2] / 2;
  changed(h, held.size_mm);

  const fp = Math.max(h.size_mm[0], h.size_mm[1]) + 2 * MAX_CLEARANCE_MM;
  const f: SpecObject = {
    ...fixture,
    role: "fixture",
    size_mm: [clamp(fixture.size_mm[0], [fp, FIXTURE_SIDE_MAX_MM]), clamp(fixture.size_mm[1], [fp, FIXTURE_SIDE_MAX_MM]), clamp(fixture.size_mm[2], FIXTURE_H_MM)],
    pose: { xyz_mm: [FIXTURE_XY_MM[0], FIXTURE_XY_MM[1], 0], yaw_deg: 0, frame: "world" },
    sources: { ...fixture.sources, pose: "fit", size_mm: "fit" },
  };
  if (fixture.shape !== "box") f.size_mm[1] = f.size_mm[0];
  f.pose!.xyz_mm[2] = f.size_mm[2] / 2;
  changed(f, fixture.size_mm);
  if (f.pocket_clearance_mm !== undefined && f.pocket_clearance_mm > MAX_CLEARANCE_MM) {
    warnings.push(`${f.id}: pocket clearance ${f.pocket_clearance_mm} mm capped at ${MAX_CLEARANCE_MM} mm`);
    f.pocket_clearance_mm = MAX_CLEARANCE_MM;
  }
  if (!pocket) delete f.pocket_clearance_mm;

  const before = spec.steps.slice(0, read ? read.at : spec.steps.indexOf(act));
  const grasp: Step = before.findLast((s) => s.verb === "grasp" && s.object === held.id) ?? {
    ...act,
    id: "grasp",
    verb: "grasp",
    target: undefined,
    via_points: [],
    preconditions: [],
    success: [],
    tolerances: {},
    t_end_s: act.t_start_s,
    source: "fit",
    sources: {},
  };
  // the spot on the bench is an answer the person did not choose, not something in the scene
  const dropped = spec.objects.filter((o) => o !== held && o !== fixture && o.id !== BENCH_SPOT.id);
  const gone = new Set(dropped.map((o) => o.id));
  // a check on an object that is no longer in the scene cannot be evaluated
  const kept = (ps: Predicate[]) => ps.filter((p) => !(p.object && gone.has(p.object)) && !(p.target && gone.has(p.target)));
  const steps: Step[] = [
    { ...grasp, id: "s1", target: undefined, via_points: [], preconditions: kept(grasp.preconditions), success: kept(grasp.success) },
    { ...act, id: "s2", via_points: [], preconditions: kept(act.preconditions), success: kept(act.success) },
  ];
  const mentions = (q: string, id: string) => new RegExp(`(^|[^\\w])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`).test(q);
  if (dropped.length) warnings.push(`left out of the rehearsal: ${dropped.map((o) => o.name).join(", ")}`);
  if (spec.steps.length > 2) warnings.push(`rehearsing ${grasp.id === "grasp" ? "a grasp" : `step ${grasp.id}`} and step ${act.id} of ${spec.steps.length}`);

  return {
    spec: {
      ...spec,
      objects: [h, f],
      steps,
      anchor: undefined,
      // questions about dropped objects or poses no longer apply; size questions are answered by the fit
      open_questions: spec.open_questions.filter((q) => !dropped.some((o) => mentions(q, o.id)) && !/size_mm|pose|position|dimension/i.test(q)),
    },
    warnings,
  };
}

const r0 = (x: number) => Math.round(x);

/** The gesture steps that have a path, renumbered, with no objects; the rest reported. */
function fitGestures(spec: TaskSpec): Fit {
  const warnings: string[] = [];
  const steps: Step[] = [];
  for (const s of spec.steps) {
    if (s.verb !== "gesture") continue;
    const path = s.gesture?.path ?? [];
    if (path.length < 2) {
      warnings.push(`step ${s.id}: no hand path was traced from the clip; left out`);
      continue;
    }
    const span = (k: 1 | 2) => r0(Math.max(...path.map((p) => p.xyz_mm[k])) - Math.min(...path.map((p) => p.xyz_mm[k])));
    const hand = s.gesture?.hand ? `the ${s.gesture.hand} hand's` : "the hand's";
    warnings.push(`step ${s.id}: ${hand} path, ${path.length} points over ${path.at(-1)!.t_s.toFixed(1)} s, ${span(1)} mm across and ${span(2)} mm high in front of the arm`);
    // the objects go, so nothing in the step may name one
    steps.push({ ...s, id: `s${steps.length + 1}`, object: undefined, target: undefined, via_points: [], preconditions: [], success: [] });
  }
  if (steps.length === 0) return { spec, warnings: [...warnings, "no gesture with a hand path: nothing to rehearse"] };
  const others = spec.steps.length - steps.length;
  if (others > 0) warnings.push(`rehearsing ${steps.length} gesture step${steps.length > 1 ? "s" : ""} of ${spec.steps.length}`);
  if (spec.objects.length) warnings.push(`left out of the rehearsal: ${spec.objects.map((o) => o.name).join(", ")} (a gesture handles nothing)`);
  return {
    spec: { ...spec, objects: [], steps, anchor: undefined, open_questions: spec.open_questions.filter((q) => !/size_mm|pose|position|dimension/i.test(q) && !spec.objects.some((o) => q.includes(o.id))) },
    warnings,
  };
}
