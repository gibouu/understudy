/**
 * Turn one of Super's ideas into a variant the rehearsal can run, or say why
 * not. A variant is the task the arm just rehearsed with a few fields
 * changed, so everything the person already answered (a clearance, a
 * tolerance, what counts as done) carries over untouched.
 *
 *   1. Only the fields a similar task changes may change: sizes, shapes,
 *      names, poses, a pocket's clearance, the verb and fixture kind of the
 *      step that puts the object somewhere, its tolerances and success check;
 *      on a pour, how far and how fast it tilts, and its direction (pouring
 *      back). No new objects or steps, no ids or roles. A variant keeps the
 *      task's kind: one that puts an object somewhere never turns into a
 *      pour, and a pour stays a pour.
 *   2. `applyChanges` applies the batch as one transaction and the reference
 *      checks of `validateSpec` must pass.
 *   3. `fitToBench` fits it to the robot's bench, which lays the objects out
 *      at their usual spots: a variant that moves something gets its pose
 *      back afterwards. What the fit had to change (a size the jaws cannot
 *      hold) is reported, and a variant the fit undoes entirely is refused.
 *      A pour is laid out by `pourBench` on the task's own layout instead.
 *   4. The world must exist: the scene builder accepts it, every pose the arm
 *      reaches is within its 300 mm, footprints on the table do not overlap,
 *      and the held object rests on the table, a fixture's top or a pocket
 *      floor.
 *
 * Reach itself (and whether the program then works) is the rehearsal's to
 * say: it reports a target out of reach as an embodiment limit.
 */
import { fitToBench } from "@/lib/sim/fit";
import { planLiquid } from "@/lib/sim/liquid";
import { apply, buildScene, CONTAINER_WALL_M, containerIds, DEFAULT_CLEARANCE_MM, footprintMm, heightMm, layoutMissingPoses, MM, SceneError, transpose, WALL_M, worldPoses, type Pose3 } from "@/lib/sim/scene";
import { applyChanges, canonicalSlot, parsePath, valueAt } from "@/lib/spec/apply";
import { AXES, FIXTURES, PREDICATE_OPERANDS, SHAPES, type Predicate, type PredicateKind, type SpecChange, type SpecObject, type TaskSpec } from "@/lib/spec/schema";
import { validateSpec } from "@/lib/spec/validate";
import { MAX_VARIANTS, type Idea, type NotYet, type VariantReply } from "./parse";
import { halfAlong, pourLine, pourOf, type Pour } from "./pour";
import { BENCH } from "./prompt";

/** What the rehearsal runs after the grasp: one insert or place (lib/sim/fit.ts). Any other verb is not supported yet, and a pour is only ever a pour. */
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
 * Pouring (#93) and waving (#94) are not part of a task that puts an object
 * somewhere: a variant of one whose name or summary claims either is not
 * offered, even when its changes alone would run. A pour's variants may say
 * they pour. Other actions the rehearsal does not run are left to the
 * prompt, since their words are also object names (a stirring rod, a wet wipe).
 */
const NOT_YET_ACTIONS = /\b(pour(s|ing|ed)?|wav(e|es|ing|ed))\b/i;
const POUR_WORD = /^pour/i;

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
const POUR_FIELDS = new Set(["into", "tilt_deg", "tilt_s"]);

/** What the rehearsal of this spec runs, in words. */
const runs = (spec: TaskSpec) => (pourOf(spec) ? "one pour from a container the arm holds" : "one grasp and then one insert or place");

/** Why a variant may not change this path, or null when it may. */
function refusal(spec: TaskSpec, tokens: string[]): string | null {
  const [list, id, field, sub, ...rest] = tokens;
  const no = `not something a variant can change (only sizes, shapes, names, poses, a pocket's clearance, the step's verb, fixture, tolerances and success${pourOf(spec) ? "; on a pour, its tilt and pouring back" : ""})`;
  if (id === undefined || field === undefined) return no;
  if (list === "objects") {
    if (!spec.objects.some((o) => o.id === id)) return `no object "${id}"`;
    if (OBJECT_FIELDS.has(field)) return (sub === undefined || (field === "size_mm" && /^[012]$/.test(sub))) && rest.length === 0 ? null : no;
    if (field === "pose") return sub === undefined || (POSE_FIELDS.has(sub) && (rest.length === 0 || (sub === "xyz_mm" && rest.length === 1 && /^[012]$/.test(rest[0])))) ? null : no;
    return no;
  }
  if (list === "steps") {
    const step = spec.steps.find((s) => s.id === id);
    if (!step) return `no step "${id}"`;
    if (rest.length) return no;
    if (step === pourOf(spec)) {
      // the pour's container and target are its own: it can only turn round (checked with the value)
      if ((field === "object" && sub === undefined) || (field === "pour" && (sub === undefined || POUR_FIELDS.has(sub)))) return null;
      if (field === "verb" || field === "target") return "a pour stays a pour: its verb and target do not change";
    }
    if (field === "verb" && sub === undefined) return step.target ? null : "the grasp stays a grasp: only the step that puts the object somewhere can change its verb";
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
    ...spec.objects.flatMap((o) => ["name", "shape", "size_mm", "pose", "pocket_clearance_mm", "liquid_ml"].map((f) => `objects[${o.id}].${f}`)),
    ...spec.steps.flatMap((s) => ["verb", "object", "target", "pour", "tolerances", "success"].map((f) => `steps[${s.id}].${f}`)),
  ];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What the rehearsal sees of a spec: everything but names, wording and provenance. */
export function physicalKey(spec: TaskSpec): string {
  return JSON.stringify({
    objects: spec.objects.map((o) => [o.id, o.shape, o.size_mm, o.role, o.pose, o.pocket_clearance_mm, o.liquid_ml]),
    steps: spec.steps.map((s) => [s.id, s.verb, s.object, s.target, s.pour, s.success, s.tolerances, s.preconditions, s.via_points]),
  });
}

const usedAsPocket = (spec: TaskSpec, id: string) => spec.steps.some((s) => s.target?.fixture === "pocket" && s.target.frame === id);

/** The opening the scene builder cuts in a pocket fixture, mm: the widest object that goes in, plus the clearance. */
function opening(spec: TaskSpec, f: SpecObject): [number, number] {
  const users = spec.steps.filter((s) => s.target?.fixture === "pocket" && s.target.frame === f.id).flatMap((s) => spec.objects.filter((o) => o.id === s.object));
  const c = f.pocket_clearance_mm ?? DEFAULT_CLEARANCE_MM;
  return [Math.max(...users.map((o) => footprintMm(o)[0])) + c, Math.max(...users.map((o) => footprintMm(o)[1])) + c];
}

/**
 * The hollow the scene builds in `f` (lib/sim/scene.ts), if any: an open
 * container's inside, or the pocket cut in a fixture a step puts something
 * into. Its opening (mm, centred) and how far its floor is above f's bottom.
 */
function hollowOf(spec: TaskSpec, f: SpecObject, containers: Set<string>): { inner: [number, number]; floor: number; name: string } | null {
  if (containers.has(f.id)) {
    const [a, b] = footprintMm(f);
    const t = CONTAINER_WALL_M / MM;
    return { inner: [a - 2 * t, b - 2 * t], floor: t, name: "opening" };
  }
  if (usedAsPocket(spec, f.id)) return { inner: opening(spec, f), floor: Math.min(WALL_M / MM, heightMm(f) / 2), name: "pocket" };
  return null;
}

/** Half extents of an object's footprint along another frame's axes, turned by `yaw` degrees against it. */
function halfExtents(o: SpecObject, yaw: number, round: boolean): [number, number] {
  const [a, b] = footprintMm(o);
  if (round) return [a / 2, a / 2];
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
  // a pocket is cut as a box whatever the fixture's shape, and a container is built as an open box (lib/sim/scene.ts)
  const containers = containerIds(spec);
  const round = (o: SpecObject) => o.shape !== "box" && !usedAsPocket(spec, o.id) && !containers.has(o.id);
  // a pour's target only catches the liquid: the arm never reaches for it
  const caught = pourOf(spec)?.pour.into;
  for (const o of spec.objects) {
    const r = Math.hypot(world[o.id].xyz_mm[0], world[o.id].xyz_mm[1]);
    if (r > REACH_MM && o.id !== caught) return `${o.name} would be ${Math.round(r)} mm from the robot's base, beyond its ${REACH_MM} mm reach`;
    if (r < MIN_REACH_MM) return `${o.name} would be ${Math.round(r)} mm from the robot's base, too close to reach down to`;
    if (bottom(o) < -REST_MM) return `${o.name} would be partly below the table`;
  }
  /** `q`'s centre in `p`'s frame, mm. */
  const localIn = (p: SpecObject, q: SpecObject) => {
    const w = world[p.id];
    const at = world[q.id].xyz_mm;
    return apply(transpose(w.R), [at[0] - w.xyz_mm[0], at[1] - w.xyz_mm[1], at[2] - w.xyz_mm[2]]);
  };
  const floorTop = (f: SpecObject) => world[f.id].xyz_mm[2] - heightMm(f) / 2 + (hollowOf(spec, f, containers)?.floor ?? 0);
  /**
   * Where `o` is against the opening of `f`'s hollow (a pocket, or an open
   * container's inside): centred over it, standing in it (its whole
   * footprint, on or above the floor), or bridging it (past both opposite
   * rims along one axis, so it lies on the two).
   */
  const opened = (o: SpecObject, f: SpecObject): { over: boolean; inside: boolean; bridge: boolean } => {
    const hollow = hollowOf(spec, f, containers);
    if (!hollow) return { over: false, inside: false, bridge: false };
    const [lx, ly] = localIn(f, o);
    const [ix, iy] = hollow.inner;
    const [ex, ey] = halfExtents(o, world[o.id].yaw_deg - world[f.id].yaw_deg, round(o));
    const over = Math.abs(lx) <= ix / 2 && Math.abs(ly) <= iy / 2;
    const fits = Math.abs(lx) + ex <= ix / 2 + 0.5 && Math.abs(ly) + ey <= iy / 2 + 0.5;
    const spans = (c: number, e: number, i: number) => c - e < -i / 2 && c + e > i / 2;
    return { over, inside: over && fits && bottom(o) >= floorTop(f) - REST_MM, bridge: spans(lx, ex, ix) || spans(ly, ey, iy) };
  };
  /** Whether the footprints of `a` and `b` overlap: separating axes for two boxes, the nearest point for a box and a disc, distance for two discs. */
  const footprintsOverlap = (a: SpecObject, b: SpecObject) => {
    const r = (o: SpecObject) => footprintMm(o)[0] / 2;
    if (round(a) && round(b)) {
      return Math.hypot(world[a.id].xyz_mm[0] - world[b.id].xyz_mm[0], world[a.id].xyz_mm[1] - world[b.id].xyz_mm[1]) < r(a) + r(b);
    }
    if (round(a) !== round(b)) {
      const [box, disc] = round(a) ? [b, a] : [a, b];
      const [lx, ly] = localIn(box, disc);
      const [hx, hy] = halfExtents(box, 0, false);
      return Math.hypot(lx - Math.max(-hx, Math.min(hx, lx)), ly - Math.max(-hy, Math.min(hy, ly))) < r(disc);
    }
    for (const [p, q] of [
      [a, b],
      [b, a],
    ]) {
      const [lx, ly] = localIn(p, q);
      const [px, py] = halfExtents(p, 0, false);
      const [qx, qy] = halfExtents(q, world[q.id].yaw_deg - world[p.id].yaw_deg, false);
      if (Math.abs(lx) >= px + qx || Math.abs(ly) >= py + qy) return false;
    }
    return true;
  };
  for (let i = 0; i < spec.objects.length; i++) {
    for (let j = i + 1; j < spec.objects.length; j++) {
      const [a, b] = [spec.objects[i], spec.objects[j]];
      const z = Math.min(bottom(a) + heightMm(a), bottom(b) + heightMm(b)) - Math.max(bottom(a), bottom(b));
      if (z <= REST_MM || !footprintsOverlap(a, b)) continue;
      if ((a.role === "manipulated" && opened(a, b).inside) || (b.role === "manipulated" && opened(b, a).inside)) continue;
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
      if (!under) continue;
      const hole = opened(o, f);
      // centred over the opening, neither standing in it nor lying across it: it hangs on one rim and tips in
      if (hole.over && !hole.inside && !hole.bridge && bottom(o) >= floorTop(f) - REST_MM) return `${o.name} would start across the edge of ${f.name}'s ${hollowOf(spec, f, containers)!.name} and tip in`;
      supports.push(hole.inside ? floorTop(f) : world[f.id].xyz_mm[2] + heightMm(f) / 2);
    }
    // it rests on the highest surface at or below its bottom
    const below = supports.filter((s) => s <= bottom(o) + REST_MM);
    const gap = bottom(o) - Math.max(...below);
    if (gap > REST_MM) return `${o.name} would start in mid-air, ${Math.round(gap)} mm above the surface under it`;
  }
  return null;
}

/** A check as what it checks: its kind and what it is about. */
const checkKey = (p: Predicate) => JSON.stringify([p.kind, p.object ?? null, p.target ?? null]);
const checkText = (p: Predicate) => [p.kind, p.object, p.target && `in ${p.target}`, p.value !== undefined && `${p.value}`].filter(Boolean).join(" ");
/** Which way a threshold is stricter: lib/sim/predicates.ts passes height_above and liquid_inside at value or more, the others at value or less. */
const STRICTER_IS_HIGHER: Partial<Record<PredicateKind, boolean>> = { height_above: true, liquid_inside: true, tilt_under: false, gripper_within: false, time_under: false };

/** Whether check `v` asks at least as much as `b` about the same thing. */
function asStrict(v: Predicate, b: Predicate): boolean {
  if (checkKey(v) !== checkKey(b)) return false;
  // a value on a kind that takes none is ignored by the simulator
  if (b.value === undefined || !PREDICATE_OPERANDS[b.kind].value) return true;
  if (v.value === undefined) return false;
  const higher = STRICTER_IS_HIGHER[b.kind];
  return higher === undefined ? v.value === b.value : higher ? v.value >= b.value : v.value <= b.value;
}

/**
 * The success checks of the task above that a variant no longer makes, or
 * makes more loosely. A pass must mean the same task done: a variant may add
 * a check or tighten one, never drop or loosen one (setting success to "comes
 * to rest" would pass with the object put down anywhere). Each check needs its
 * own match, so a looser duplicate does not stand in for a stricter one.
 */
function droppedChecks(base: TaskSpec, spec: TaskSpec, swap: (id?: string) => string | undefined = (id) => id): Predicate[] {
  return base.steps.flatMap((b) => {
    const now = spec.steps.find((s) => s.id === b.id)?.success ?? [];
    // a pour turned round asks the same of the other container: the checks turn round with it
    return b.success.map((p) => turned(p, swap)).filter((p) => !now.some((q) => asStrict(q, p)));
  });
}

/** A check with its object and target renamed by `swap`. */
function turned(p: Predicate, swap: (id?: string) => string | undefined): Predicate {
  const q = { ...p };
  if (p.object !== undefined) q.object = swap(p.object);
  if (p.target !== undefined) q.target = swap(p.target);
  return q;
}

/** `a` and `b` trade names: `swap(a)` is `b`, `swap(b)` is `a`, any other id stays. */
const trade = (a: string, b: string) => (id?: string) => (id === a ? b : id === b ? a : id);

/**
 * Whether a change to the pour step turns it round: its object becomes what
 * it pours into, or what it pours into becomes its object. False for a change
 * that leaves its two containers as they are, null for one that names another.
 */
function turnsRound(pour: Pour, tokens: string[], value: unknown): boolean | null {
  const [, , field, sub] = tokens;
  if (field === "object") return value === pour.pour.into ? true : value === pour.object ? false : null;
  if (field !== "pour" || (sub !== undefined && sub !== "into")) return false;
  // a whole pour block without `into` is the schema's to refuse
  const into = sub === "into" ? value : typeof value === "object" && value !== null ? (value as { into?: unknown }).into : undefined;
  return into === pour.object ? true : into === pour.pour.into || into === undefined ? false : null;
}

/**
 * The pour turned round, before the variant's own changes: the container it
 * poured into is held and poured from, the liquid starts where the pour put
 * it (the two trade what they hold, and which one is held), and every step
 * and check about one is about the other. Where the two stand is
 * `pourBench`'s to say.
 */
function pourBack(spec: TaskSpec, a: string, b: string, source: string): TaskSpec {
  const swap = trade(a, b);
  const out = structuredClone(spec);
  const [oa, ob] = [a, b].map((id) => out.objects.find((o) => o.id === id)!);
  const [roles, held] = [[oa.role, ob.role], [oa.liquid_ml, ob.liquid_ml]];
  for (const [o, k] of [[oa, 1], [ob, 0]] as const) {
    o.role = roles[k];
    if (held[k] === undefined) delete o.liquid_ml;
    else o.liquid_ml = held[k];
    o.sources = { ...o.sources, role: source, liquid_ml: source };
  }
  for (const st of out.steps) {
    const before = structuredClone(st);
    st.object = swap(st.object)!;
    if (st.target) st.target = { ...st.target, frame: swap(st.target.frame)! };
    if (st.pour) st.pour = { ...st.pour, into: swap(st.pour.into)! };
    st.success = st.success.map((p) => turned(p, swap));
    st.preconditions = st.preconditions.map((p) => turned(p, swap));
    st.via_points = st.via_points.map((v) => ({ ...v, frame: swap(v.frame)! }));
    for (const f of ["object", "target", "pour", "success", "preconditions", "via_points"] as const) {
      if (!same(before[f], st[f])) st.sources = { ...st.sources, [f]: source };
    }
  }
  return out;
}

/** Whether `id`'s pose hangs, through its frames, on object `on`. */
function posedOn(spec: TaskSpec, id: string, on: string): boolean {
  const seen = new Set<string>();
  for (let frame = spec.objects.find((o) => o.id === id)?.pose?.frame; frame && frame !== "world" && !seen.has(frame); frame = spec.objects.find((o) => o.id === frame)?.pose?.frame) {
    if (frame === on) return true;
    seen.add(frame);
  }
  return false;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * A pour laid out on the task's own bench (lib/sim/fit.ts lays out only an
 * insert or place): the arm pours from where the held container stood, and
 * the target stands where the stream landed, as far from the held
 * container's rim as in the task above, along the same line. Each keeps the
 * height of its spot: its bottom where the bottom of the container that
 * stood there was, on whatever held that one (a block, a pocket's floor, a
 * rim). A container the variant moved keeps its move; a
 * held one wider than the jaws is narrowed, and the warnings say so unless
 * the variant's own size is the one narrowed (buildVariant reports that).
 */
function pourBench(base: TaskSpec, spec: TaskSpec, changes: SpecChange[]): { spec: TaskSpec; warnings: string[] } | { why: string } {
  const was = pourOf(base)!;
  const now = pourOf(spec);
  if (!now) return { why: "a pour stays a pour" };
  /** whether the variant itself sets this field of object `id` */
  const touched = (id: string, field: string) =>
    changes.some((c) => {
      const [list, i, f] = parsePath(c.path);
      return list === "objects" && i === id && f === field;
    });
  let wb: Record<string, Pose3>;
  try {
    wb = worldPoses(base);
  } catch (err) {
    if (err instanceof SceneError) return { why: err.message };
    throw err;
  }
  const { from: spot, u, gap } = pourLine(base, was, wb);

  const out = structuredClone(spec);
  const warnings: string[] = [];
  const held = out.objects.find((o) => o.id === now.object)!;
  const target = out.objects.find((o) => o.id === now.pour.into)!;
  const [lo, hi] = BENCH.heldSideMm;
  const narrow = held.size_mm.map((v, i) => (i < 2 ? Math.min(Math.max(v, lo), hi) : v)) as SpecObject["size_mm"];
  if (narrow.some((v, i) => v !== held.size_mm[i])) {
    if (!touched(held.id, "size_mm")) warnings.push(`${held.name} is ${footprintMm(held).join(" x ")} mm across and the jaws hold ${lo} to ${hi} mm: it is ${narrow.slice(0, 2).join(" x ")} mm here`);
    held.size_mm = narrow;
    held.sources = { ...held.sources, size_mm: "fit" };
  }

  let world: Record<string, Pose3>;
  try {
    world = worldPoses(out);
  } catch (err) {
    if (err instanceof SceneError) return { why: err.message };
    throw err;
  }
  // where each container should stand, worked out before anything moves: one may be posed in the other's frame
  /** where the bottom of the container that stood at a spot was, in the task above */
  const bottomOf = (id: string) => wb[id].xyz_mm[2] - heightMm(base.objects.find((o) => o.id === id)!) / 2;
  const on = ([x, y]: [number, number], o: SpecObject, bottom: number): [number, number, number] => [r1(x), r1(y), r1(bottom + heightMm(o) / 2)];
  const want = new Map<SpecObject, { xyz: [number, number, number]; yaw: number }>();
  if (!touched(held.id, "pose")) want.set(held, { xyz: on(spot, held, bottomOf(was.object)), yaw: wb[was.object].yaw_deg });
  // the target from where the held container stands, the same gap from its rim
  const h = want.get(held) ?? { xyz: world[held.id].xyz_mm, yaw: world[held.id].yaw_deg };
  const yaw = wb[was.pour.into].yaw_deg;
  const reach = halfAlong(held, h.yaw, u) + gap + halfAlong(target, yaw, u);
  if (!touched(target.id, "pose")) want.set(target, { xyz: on([h.xyz[0] + u[0] * reach, h.xyz[1] + u[1] * reach], target, bottomOf(was.pour.into)), yaw });
  const off = (o: SpecObject) => {
    const w = want.get(o)!;
    return world[o.id].yaw_deg !== w.yaw || w.xyz.some((v, i) => Math.abs(v - world[o.id].xyz_mm[i]) >= 0.05);
  };
  const moving = [...want.keys()].filter(off);
  // the bench moves the two containers and nothing else: what hangs on one that moves is posed where it stands now
  const hangs = out.objects.filter((o) => o.pose && !moving.includes(o) && !touched(o.id, "pose") && moving.some((m) => posedOn(out, o.id, m.id)));
  for (const o of [...moving, ...hangs]) {
    const w = want.get(o) ?? { xyz: world[o.id].xyz_mm.map(r1) as [number, number, number], yaw: world[o.id].yaw_deg };
    o.pose = { xyz_mm: w.xyz, yaw_deg: w.yaw, frame: "world" };
    o.sources = { ...o.sources, pose: "fit" };
  }
  return { spec: out, warnings };
}

/**
 * What the rehearsal will say of the liquid in `spec` (lib/sim/liquid.ts, as
 * lib/sim/interpreter.ts plans it) that it does not say of the task above:
 * a container that holds less than it is given, a fill cut to the particle
 * budget. The card shows them next to the edits that cause them.
 */
function liquidWarnings(base: TaskSpec, spec: TaskSpec): string[] {
  const plan = (s: TaskSpec) => {
    try {
      return planLiquid(layoutMissingPoses(s).spec, buildScene(s))?.warnings ?? [];
    } catch (err) {
      if (err instanceof SceneError) return [];
      throw err;
    }
  };
  const before = new Set(plan(base));
  return plan(spec).filter((w) => !before.has(w));
}

/** applyChanges' reason for refusing a batch, and which change is at fault when there are several. */
function refused(warnings: string[], n: number): string {
  const whole = warnings[0].replace(/^no change applied: /, "");
  return n > 1 && warnings.length > 1 ? `${whole} (${warnings.slice(1).join("; ")})` : whole;
}

/** One idea as a runnable variant (`n` numbers it), or the reason it cannot be one. */
export function buildVariant(base: TaskSpec, idea: Idea, n: number): { variant: Variant } | { why: string } {
  const source = `variant#${n}`;
  const pour = pourOf(base);
  const neverPours = `this task does not pour: its variants keep ${runs(base)} and never turn into a pour`;
  const changes: SpecChange[] = [];
  let back = false;
  for (const c of idea.changes) {
    const path = canonicalSlot(base, c.path);
    const tokens = parsePath(path);
    if (tokens[0] === "title" || tokens[0] === "summary") continue; // the idea's own title and summary name the variant
    const no = refusal(base, tokens);
    if (no) return { why: `${c.path}: ${no}` };
    if (c.value === undefined || c.value === null) return { why: `${c.path}: no value given` };
    if (pour && tokens[0] === "steps" && tokens[1] === pour.id) {
      const turn = turnsRound(pour, tokens, c.value);
      if (turn === null) return { why: `${c.path}: a pour keeps its two containers; it can only turn round, from "${pour.pour.into}" back into "${pour.object}"` };
      back ||= turn;
    }
    changes.push({ path, value: c.value, source });
  }
  if (changes.length === 0) return { why: "it changes nothing in the task" };
  // a pour's variants may say they pour; nothing says it waves yet
  const claim = [...`${idea.title} ${idea.summary}`.matchAll(new RegExp(NOT_YET_ACTIONS, "gi"))].find((m) => !(pour && POUR_WORD.test(m[0])));
  if (claim) return { why: !pour && POUR_WORD.test(claim[0]) ? neverPours : `not yet: "${claim[0].toLowerCase()}" is not something the rehearsal runs; it runs ${runs(base)}` };

  // a new shape brings its symmetry: a cylinder turns freely about its axis, a sphere about any
  for (const c of changes.filter((c) => parsePath(c.path)[2] === "shape" && (SHAPES as readonly unknown[]).includes(c.value))) {
    const id = parsePath(c.path)[1];
    const want = SYMMETRY_OF[c.value as keyof typeof SYMMETRY_OF];
    const given = changes.find((x) => x.path === `objects[${id}].symmetry`);
    if (!given) changes.push({ path: `objects[${id}].symmetry`, value: want, source });
    else if (given.value !== want) return { why: `a ${c.value} has symmetry "${want}", not "${String(given.value)}"` };
  }

  // pouring back starts from the pour turned round; the changes that turn it are then already true
  const start = back ? pourBack(base, pour!.object, pour!.pour.into, source) : base;
  const changed = applyChanges(start, changes);
  if (changed.warnings.length) return { why: refused(changed.warnings, changes.length) };
  const applied = applyChanges(changed.spec, [
    { path: "title", value: `${base.title}: ${idea.title}`, source },
    { path: "summary", value: idea.summary || base.summary, source },
  ]);
  for (const s of applied.spec.steps) {
    const before = base.steps.find((b) => b.id === s.id);
    if (before && s.verb !== before.verb) {
      if (s.verb === "pour") return { why: neverPours };
      if (!REHEARSED_VERBS.includes(s.verb)) return { why: `not yet: the rehearsal runs ${runs(base)}, not "${s.verb}"` };
    }
    if (s.target && !(FIXTURES as readonly string[]).includes(s.target.fixture)) return { why: `"${s.target.fixture}" is not a fixture the bench has` };
  }
  const issue = validateSpec(applied.spec).find((i) => i.severity === "error");
  if (issue) return { why: issue.message };
  if (pour) {
    // turned round once and back again in the same batch would leave the liquid and the check turned round
    const [from, into] = back ? [pour.pour.into, pour.object] : [pour.object, pour.pour.into];
    const now = pourOf(applied.spec);
    if (now && (now.object !== from || now.pour.into !== into)) return { why: `its changes disagree on which way it pours: from "${from}" into "${into}", not from "${now.object}" into "${now.pour.into}"` };
  }

  let spec: TaskSpec;
  const warnings: string[] = [];
  if (pour) {
    const bench = pourBench(base, applied.spec, changes);
    if ("why" in bench) return bench;
    spec = bench.spec;
    warnings.push(...bench.warnings);
  } else {
    const fit = fitToBench(applied.spec);
    if (fit.spec === applied.spec) return { why: fit.warnings.join("; ") };
    // the fit puts every object at its usual spot; a variant that moves one keeps its move
    const moves = changes.filter((c) => parsePath(c.path)[2] === "pose");
    const placed = moves.length ? applyChanges(fit.spec, moves) : { spec: fit.spec, warnings: [] };
    if (placed.warnings.length) return { why: refused(placed.warnings, moves.length) };
    spec = placed.spec;
  }
  const dropped = droppedChecks(base, spec, back ? trade(pour!.object, pour!.pour.into) : undefined);
  if (dropped.length) return { why: `it drops or loosens a check that the task is done (${dropped.map(checkText).join("; ")}): a variant may add a check or tighten one, never remove or loosen one` };

  const edits = watched(base)
    .map((path) => ({ path, before: valueAt(base, path), after: valueAt(spec, path) }))
    .filter((e) => !same(e.before, e.after));
  for (const c of changes) {
    const got = valueAt(spec, c.path);
    if (!same(got, c.value)) warnings.push(`${c.path} is ${got === undefined ? "not kept" : JSON.stringify(got)} on the bench, not ${JSON.stringify(c.value)}`);
  }
  if (physicalKey(spec) === physicalKey(base)) {
    return { why: warnings.length ? `outside what the robot's jaws and reach hold: ${warnings.join("; ")}` : "the arm would do exactly the task above" };
  }
  const problem = geometryProblem(spec);
  if (problem) return { why: problem };
  warnings.push(...liquidWarnings(base, spec));
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
  } else {
    if (checked.variants.length < 3) problems.push(`only ${checked.variants.length} of your variants fit the bench; give 3 to 5 that do`);
    // pouring back is the pour's own variant: Super tends to write it as the container starting in the target, which cannot run
    const pour = pourOf(base);
    if (pour && !checked.variants.some((v) => pourOf(v.spec)?.object === pour.pour.into)) {
      problems.push(`none of your variants pours it back; make one of them do it with {"path":"steps[${pour.id}].object","value":"${pour.pour.into}"}`);
    }
  }
  return problems;
}
