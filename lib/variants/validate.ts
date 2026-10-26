/**
 * Turn one of Super's ideas into a variant the rehearsal can run, or say why
 * not. A variant is the task the arm just rehearsed with a few fields
 * changed, so everything the person already answered (a clearance, a
 * tolerance, what counts as done) carries over untouched.
 *
 *   1. Only the fields a similar task changes may change: sizes, shapes,
 *      names, poses, a pocket's clearance, the verb and fixture kind of the
 *      step that puts the object somewhere, its tolerances and success check.
 *      No new objects or steps, no ids or roles.
 *   2. `applyChanges` applies the batch as one transaction and the reference
 *      checks of `validateSpec` must pass.
 *   3. `fitToBench` fits it to the robot's bench, which lays the objects out
 *      at their usual spots: a variant that moves something gets its pose
 *      back afterwards. What the fit had to change (a size the jaws cannot
 *      hold) is reported, and a variant the fit undoes entirely is refused.
 *   4. The world must exist: the scene builder accepts it, every pose is
 *      within the arm's 300 mm, footprints on the table do not overlap, and
 *      the held object rests on the table, a fixture's top or a pocket floor.
 *
 * Reach itself (and whether the program then works) is the rehearsal's to
 * say: it reports a target out of reach as an embodiment limit.
 */
import { fitToBench } from "@/lib/sim/fit";
import { apply, buildScene, DEFAULT_CLEARANCE_MM, footprintMm, heightMm, MM, SceneError, transpose, WALL_M, worldPoses } from "@/lib/sim/scene";
import { applyChanges, canonicalSlot, parsePath, valueAt } from "@/lib/spec/apply";
import { AXES, FIXTURES, SHAPES, type SpecChange, type SpecObject, type TaskSpec } from "@/lib/spec/schema";
import { validateSpec } from "@/lib/spec/validate";
import { MAX_VARIANTS, type Idea, type NotYet, type VariantReply } from "./parse";

/** What the rehearsal runs after the grasp: one insert or place (lib/sim/fit.ts). Any other verb is not supported yet. */
export const REHEARSED_VERBS: readonly string[] = ["insert", "place"];
export const SYMMETRY_OF = { box: "none", cylinder: "axial", sphere: "full" } as const;
/** The SO-101's reach from its base, mm, and a spot too close to it to reach down to. */
export const REACH_MM = 300;
export const MIN_REACH_MM = 80;
/** How far a resting object may sit from its support, mm. */
const REST_MM = 2;
/** The smallest side the bench builds and grips: the fit's narrowest held side. */
export const MIN_SIZE_MM = 6;
const DEG = Math.PI / 180;
/**
 * Pouring (#93) and waving (#94) are not supported yet: a variant whose name
 * or summary claims either is not offered, even when its changes alone
 * would run. Other actions the rehearsal does not run are left to the prompt,
 * since their words are also object names (a stirring rod, a wet wipe).
 */
const NOT_YET_ACTIONS = /\b(pour(s|ing|ed)?|wav(e|es|ing|ed))\b/i;

export type Edit = { path: string; before: unknown; after: unknown };
export type Variant = {
  /** `variant#<n>`, also the provenance of every field it changed */
  id: string;
  title: string;
  summary: string;
  changes: SpecChange[];
  /** every field that differs from the task above, after the fit */
  edits: Edit[];
  /** fitted to the bench, ready for /api/compile */
  spec: TaskSpec;
  warnings: string[];
};
export type Checked = { variants: Variant[]; not_yet: NotYet[] };

const OBJECT_FIELDS = new Set(["size_mm", "name", "shape", "symmetry", "pocket_clearance_mm"]);
const POSE_FIELDS = new Set(["xyz_mm", "yaw_deg", "frame"]);

/** Why a variant may not change this path, or null when it may. */
function refusal(spec: TaskSpec, tokens: string[]): string | null {
  const [list, id, field, sub, ...rest] = tokens;
  const no = "not something a variant can change (only sizes, shapes, names, poses, a pocket's clearance, the step's verb, fixture, tolerances and success)";
  if (id === undefined || field === undefined) return no;
  if (list === "objects") {
    if (!spec.objects.some((o) => o.id === id)) return `no object "${id}"`;
    if (OBJECT_FIELDS.has(field)) return (sub === undefined || (field === "size_mm" && /^[012]$/.test(sub))) && rest.length === 0 ? null : no;
    if (field === "pose") return sub === undefined || (POSE_FIELDS.has(sub) && (rest.length === 0 || (sub === "xyz_mm" && rest.length === 1 && /^[012]$/.test(rest[0])))) ? null : no;
    return no;
  }
  if (list === "steps") {
    if (!spec.steps.some((s) => s.id === id)) return `no step "${id}"`;
    if (rest.length) return no;
    if (field === "verb" && sub === undefined) return spec.steps.find((s) => s.id === id)?.target ? null : "the grasp stays a grasp: only the step that puts the object somewhere can change its verb";
    if (field === "success" && sub === undefined) return null;
    if (field === "target" && (sub === undefined || sub === "fixture")) return null;
    if (field === "tolerances" && (sub === undefined || (AXES as readonly string[]).includes(sub))) return null;
    return no;
  }
  return no;
}

/** The fields a variant can differ in, for showing what changed. */
function watched(spec: TaskSpec): string[] {
  return [
    ...spec.objects.flatMap((o) => ["name", "shape", "size_mm", "pose", "pocket_clearance_mm"].map((f) => `objects[${o.id}].${f}`)),
    ...spec.steps.flatMap((s) => ["verb", "target", "tolerances", "success"].map((f) => `steps[${s.id}].${f}`)),
  ];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What the rehearsal sees of a spec: everything but names, wording and provenance. */
export function physicalKey(spec: TaskSpec): string {
  return JSON.stringify({
    objects: spec.objects.map((o) => [o.id, o.shape, o.size_mm, o.role, o.pose, o.pocket_clearance_mm]),
    steps: spec.steps.map((s) => [s.id, s.verb, s.object, s.target, s.success, s.tolerances, s.preconditions, s.via_points]),
  });
}

const usedAsPocket = (spec: TaskSpec, id: string) => spec.steps.some((s) => s.target?.fixture === "pocket" && s.target.frame === id);

/** The opening the scene builder cuts in a pocket fixture, mm: the widest object that goes in, plus the clearance. */
function opening(spec: TaskSpec, f: SpecObject): [number, number] {
  const users = spec.steps.filter((s) => s.target?.fixture === "pocket" && s.target.frame === f.id).flatMap((s) => spec.objects.filter((o) => o.id === s.object));
  const c = f.pocket_clearance_mm ?? DEFAULT_CLEARANCE_MM;
  return [Math.max(...users.map((o) => footprintMm(o)[0])) + c, Math.max(...users.map((o) => footprintMm(o)[1])) + c];
}

const round = (o: SpecObject) => o.shape !== "box";

/** Half extents of an object's footprint along another frame's axes, turned by `yaw` degrees against it. */
function halfExtents(o: SpecObject, yaw: number): [number, number] {
  const [a, b] = footprintMm(o);
  if (round(o)) return [a / 2, a / 2];
  const [c, s] = [Math.abs(Math.cos(yaw * DEG)), Math.abs(Math.sin(yaw * DEG))];
  return [(c * a + s * b) / 2, (s * a + c * b) / 2];
}

/**
 * The world must exist as posed: sizes the scene can build, every object
 * within the arm's reach and above the table, no two objects in the same
 * place (a held object standing in a pocket's opening or on a fixture's top
 * is not a clash), and the held object resting on what is under it.
 */
function geometryProblem(spec: TaskSpec): string | null {
  for (const o of spec.objects) {
    if (Math.min(...o.size_mm) < MIN_SIZE_MM) return `${o.name} would be under ${MIN_SIZE_MM} mm in one direction`;
    if (o.shape === "sphere" && new Set(o.size_mm).size > 1) return `${o.name} would be a sphere with different sizes in x, y and z`;
  }
  let world: ReturnType<typeof worldPoses>;
  try {
    buildScene(spec);
    world = worldPoses(spec);
  } catch (err) {
    if (err instanceof SceneError) return err.message;
    throw err;
  }
  const bottom = (o: SpecObject) => world[o.id].xyz_mm[2] - heightMm(o) / 2;
  for (const o of spec.objects) {
    const r = Math.hypot(world[o.id].xyz_mm[0], world[o.id].xyz_mm[1]);
    if (r > REACH_MM) return `${o.name} would be ${Math.round(r)} mm from the robot's base, beyond its ${REACH_MM} mm reach`;
    if (r < MIN_REACH_MM) return `${o.name} would be ${Math.round(r)} mm from the robot's base, too close to reach down to`;
    if (bottom(o) < -REST_MM) return `${o.name} would be partly below the table`;
  }
  /** `q`'s centre in `p`'s frame, mm. */
  const localIn = (p: SpecObject, q: SpecObject) => {
    const w = world[p.id];
    const at = world[q.id].xyz_mm;
    return apply(transpose(w.R), [at[0] - w.xyz_mm[0], at[1] - w.xyz_mm[1], at[2] - w.xyz_mm[2]]);
  };
  const floorTop = (f: SpecObject) => world[f.id].xyz_mm[2] - heightMm(f) / 2 + Math.min(WALL_M / MM, heightMm(f) / 2);
  /** Whether `o`'s whole footprint stands inside pocket fixture `f`'s opening, on or above its floor. */
  const inOpening = (o: SpecObject, f: SpecObject) => {
    if (!usedAsPocket(spec, f.id) || bottom(o) < floorTop(f) - REST_MM) return false;
    const [lx, ly] = localIn(f, o);
    const [ix, iy] = opening(spec, f);
    const [ex, ey] = halfExtents(o, world[o.id].yaw_deg - world[f.id].yaw_deg);
    return Math.abs(lx) + ex <= ix / 2 + 0.5 && Math.abs(ly) + ey <= iy / 2 + 0.5;
  };
  /** Whether the footprints of `a` and `b` overlap: separating axes for boxes, distance for round ones. */
  const footprintsOverlap = (a: SpecObject, b: SpecObject) => {
    if (round(a) && round(b)) {
      const d = Math.hypot(world[a.id].xyz_mm[0] - world[b.id].xyz_mm[0], world[a.id].xyz_mm[1] - world[b.id].xyz_mm[1]);
      return d < footprintMm(a)[0] / 2 + footprintMm(b)[0] / 2;
    }
    for (const [p, q] of [
      [a, b],
      [b, a],
    ]) {
      const [lx, ly] = localIn(p, q);
      const [px, py] = halfExtents(p, 0);
      const [qx, qy] = halfExtents(q, world[q.id].yaw_deg - world[p.id].yaw_deg);
      if (Math.abs(lx) >= px + qx || Math.abs(ly) >= py + qy) return false;
    }
    return true;
  };
  for (let i = 0; i < spec.objects.length; i++) {
    for (let j = i + 1; j < spec.objects.length; j++) {
      const [a, b] = [spec.objects[i], spec.objects[j]];
      const z = Math.min(bottom(a) + heightMm(a), bottom(b) + heightMm(b)) - Math.max(bottom(a), bottom(b));
      if (z <= REST_MM || !footprintsOverlap(a, b)) continue;
      if ((a.role === "manipulated" && inOpening(a, b)) || (b.role === "manipulated" && inOpening(b, a))) continue;
      return `${a.name} and ${b.name} would be in the same place`;
    }
  }
  for (const o of spec.objects.filter((x) => x.role === "manipulated")) {
    // the surfaces under the object's centre: the table, a fixture's top, a pocket's floor
    const supports = [0];
    for (const f of spec.objects.filter((x) => x !== o && x.role !== "manipulated")) {
      const [lx, ly] = localIn(f, o);
      const [fx, fy] = footprintMm(f);
      const under = round(f) ? Math.hypot(lx, ly) <= fx / 2 : Math.abs(lx) <= fx / 2 && Math.abs(ly) <= fy / 2;
      if (under) supports.push(inOpening(o, f) ? floorTop(f) : world[f.id].xyz_mm[2] + heightMm(f) / 2);
    }
    // it rests on the highest surface at or below its bottom
    const below = supports.filter((s) => s <= bottom(o) + REST_MM);
    const gap = bottom(o) - Math.max(...below);
    if (gap > REST_MM) return `${o.name} would start in mid-air, ${Math.round(gap)} mm above the surface under it`;
  }
  return null;
}

/** applyChanges' reason for refusing a batch, and which change is at fault when there are several. */
function refused(warnings: string[], n: number): string {
  const whole = warnings[0].replace(/^no change applied: /, "");
  return n > 1 && warnings.length > 1 ? `${whole} (${warnings.slice(1).join("; ")})` : whole;
}

/** One idea as a runnable variant (`n` numbers it), or the reason it cannot be one. */
export function buildVariant(base: TaskSpec, idea: Idea, n: number): { variant: Variant } | { why: string } {
  const source = `variant#${n}`;
  const changes: SpecChange[] = [];
  for (const c of idea.changes) {
    const path = canonicalSlot(base, c.path);
    const tokens = parsePath(path);
    if (tokens[0] === "title" || tokens[0] === "summary") continue; // the idea's own title and summary name the variant
    const no = refusal(base, tokens);
    if (no) return { why: `${c.path}: ${no}` };
    if (c.value === undefined || c.value === null) return { why: `${c.path}: no value given` };
    changes.push({ path, value: c.value, source });
  }
  if (changes.length === 0) return { why: "it changes nothing in the task" };
  const claim = `${idea.title} ${idea.summary}`.match(NOT_YET_ACTIONS);
  if (claim) return { why: `not yet: "${claim[0].toLowerCase()}" is not something the rehearsal runs; it runs one grasp and then one insert or place` };

  // a new shape brings its symmetry: a cylinder turns freely about its axis, a sphere about any
  for (const c of changes.filter((c) => parsePath(c.path)[2] === "shape" && (SHAPES as readonly unknown[]).includes(c.value))) {
    const id = parsePath(c.path)[1];
    const want = SYMMETRY_OF[c.value as keyof typeof SYMMETRY_OF];
    const given = changes.find((x) => x.path === `objects[${id}].symmetry`);
    if (!given) changes.push({ path: `objects[${id}].symmetry`, value: want, source });
    else if (given.value !== want) return { why: `a ${c.value} has symmetry "${want}", not "${String(given.value)}"` };
  }

  const changed = applyChanges(base, changes);
  if (changed.warnings.length) return { why: refused(changed.warnings, changes.length) };
  const applied = applyChanges(changed.spec, [
    { path: "title", value: `${base.title}: ${idea.title}`, source },
    { path: "summary", value: idea.summary || base.summary, source },
  ]);
  for (const s of applied.spec.steps) {
    const before = base.steps.find((b) => b.id === s.id);
    if (before && s.verb !== before.verb && !REHEARSED_VERBS.includes(s.verb)) {
      return { why: `not yet: the rehearsal runs one grasp and then one insert or place, not "${s.verb}"` };
    }
    if (s.target && !(FIXTURES as readonly string[]).includes(s.target.fixture)) return { why: `"${s.target.fixture}" is not a fixture the bench has` };
  }
  const issue = validateSpec(applied.spec).find((i) => i.severity === "error");
  if (issue) return { why: issue.message };

  const fit = fitToBench(applied.spec);
  if (fit.spec === applied.spec) return { why: fit.warnings.join("; ") };
  // the fit puts every object at its usual spot; a variant that moves one keeps its move
  const moves = changes.filter((c) => parsePath(c.path)[2] === "pose");
  const placed = moves.length ? applyChanges(fit.spec, moves) : { spec: fit.spec, warnings: [] };
  if (placed.warnings.length) return { why: refused(placed.warnings, moves.length) };
  const spec = placed.spec;

  const edits = watched(base)
    .map((path) => ({ path, before: valueAt(base, path), after: valueAt(spec, path) }))
    .filter((e) => !same(e.before, e.after));
  const warnings: string[] = [];
  for (const c of changes) {
    const got = valueAt(spec, c.path);
    if (!same(got, c.value)) warnings.push(`${c.path} is ${got === undefined ? "not kept" : JSON.stringify(got)} on the bench, not ${JSON.stringify(c.value)}`);
  }
  if (physicalKey(spec) === physicalKey(base)) {
    return { why: warnings.length ? `outside what the robot's jaws and reach hold: ${warnings.join("; ")}` : "the arm would do exactly the task above" };
  }
  const problem = geometryProblem(spec);
  if (problem) return { why: problem };
  return { variant: { id: source, title: idea.title, summary: idea.summary, changes, edits, spec, warnings } };
}

/**
 * Every idea checked against the task above: up to MAX_VARIANTS runnable
 * ones, numbered from `first`; the rest join the model's own not-yet list
 * with the reason. Two ideas the arm would do the same way count once.
 */
export function checkReply(base: TaskSpec, reply: VariantReply, first = 1): Checked {
  const variants: Variant[] = [];
  const not_yet: NotYet[] = [...reply.not_yet];
  const seen = new Set([physicalKey(base)]);
  const titles = new Set<string>();
  for (const raw of reply.variants) {
    if (variants.length >= MAX_VARIANTS) break;
    // the title names the variant's spec, which a recorded compile is found by
    let title = raw.title;
    for (let k = 2; titles.has(title.toLowerCase()); k++) title = `${raw.title} (${k})`;
    const idea = { ...raw, title };
    const r = buildVariant(base, idea, first + variants.length);
    if ("why" in r) {
      not_yet.push({ idea: idea.title, why: r.why });
      continue;
    }
    const key = physicalKey(r.variant.spec);
    if (seen.has(key)) continue;
    seen.add(key);
    titles.add(title.toLowerCase());
    variants.push(r.variant);
  }
  return { variants, not_yet };
}

/** What to tell Super when its answer needs another go: the ideas that do not fit, and a count that is off. */
export function replyProblems(base: TaskSpec, reply: VariantReply, request?: string): string[] {
  const checked = checkReply(base, reply);
  const problems = checked.not_yet.slice(reply.not_yet.length).map((n) => `variant "${n.idea}": ${n.why}`);
  if (request) {
    if (reply.variants.length > 1) problems.push(`give one variant for the request, not ${reply.variants.length}`);
    if (reply.variants.length === 0 && reply.not_yet.length === 0) problems.push("give one variant, or one not_yet entry saying what the arm cannot do yet");
  } else if (checked.variants.length < 3) {
    problems.push(`only ${checked.variants.length} of your variants fit the bench; give 3 to 5 that do`);
  }
  return problems;
}
