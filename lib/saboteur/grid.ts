/**
 * The saboteur's twelve (issue #27, spec v2 section 4 stages 6 and 7): world
 * perturbations chosen from the spec's tightest constraint, each run blind
 * (the program is told the nominal poses) and sensed (the true ones) at
 * every gravity the page rehearses. This module knows what the spec allows
 * (`focusOf`), checks twelve written by a model (`scenarioProblems`), builds
 * twelve with no model (`fallbackScenarios`), and reads the per-axis
 * perception budget off the results (`budgetOf`). Nothing here names a task:
 * the target is whatever the spec's placing step puts its object into.
 */
import { environment } from "@/lib/sim/interpreter";
import { CONTAINER_WALL_M, containerIds, DEFAULT_CLEARANCE_MM, footprintMm, MM } from "@/lib/sim/scene";
import { Scenario, type Axis, type Mode, type SignedBand, type SpecObject, type TaskSpec } from "@/lib/spec/schema";

export const SCENARIO_COUNT = 12;
/** Bounds on what a scenario may do: past them the arm is no longer rehearsing this task, it is rehearsing another bench. */
export const MAX_SHIFT_MM = 60;
export const MAX_TURN_DEG = 45;
/** The axes the grid runs: world perturbations. pose_noise_mm changes nothing in the world, so it has no cell here. */
export const GRID_AXES = ["x_mm", "y_mm", "z_mm", "yaw_deg", "tilt_deg", "clearance_mm"] as const satisfies readonly Axis[];

/** What the grid is about: the object a step puts somewhere, the target it goes into, and how much room that leaves. */
export type Focus = {
  step_id: string;
  object: SpecObject;
  target: SpecObject;
  fixture: "pocket" | "zone" | "stack" | "pour";
  /** half-width of the room the object has in its target, mm: the tightest constraint the program must hold */
  band_mm: number;
  /** where band_mm comes from, in words */
  band_from: string;
  obstacles: SpecObject[];
};

const r1 = (x: number) => Math.round(x * 10) / 10;
/** half a millimetre is the finest step the grid takes */
const half = (x: number) => Math.max(0.5, Math.round(x * 2) / 2);

/** The placing step the grid perturbs, or null when the spec has none (a gesture, a grasp alone). */
export function focusOf(spec: TaskSpec): Focus | null {
  const byId = new Map(spec.objects.map((o) => [o.id, o]));
  const obstacles = spec.objects.filter((o) => o.role === "obstacle");
  // a step that puts its object somewhere first (insert, place, pour), then any step with a target (a reach toward it)
  const placing = new Set(["insert", "place", "pour"]);
  const steps = [...spec.steps.filter((s) => placing.has(s.verb)), ...spec.steps.filter((s) => !placing.has(s.verb))];
  for (const s of steps) {
    const object = s.object ? byId.get(s.object) : undefined;
    // a pour goes into its pour.into, whatever frame its target names
    const into = s.pour?.into ?? s.target?.frame;
    const target = into ? byId.get(into) : undefined;
    if (!object || !target || target.id === object.id) continue;
    const fixture = s.pour ? "pour" : s.target!.fixture;
    const told = [s.tolerances.x_mm, s.tolerances.y_mm].filter((x): x is number => x !== undefined && x >= 0);
    const stated = told.length ? Math.min(...told) : undefined;
    // the geometry's own room, then a stated tolerance when it is tighter: the smallest constraint is the one to probe
    // compared raw, rounded only for display: a rounding must not pick the looser constraint
    let band: { mm: number; from: string };
    const [tx, ty] = footprintMm(target);
    const [ox, oy] = footprintMm(object);
    // a pocket only where the scene builds one: a fixture, not a liquid container (lib/sim/scene.ts perturb)
    if (fixture === "pocket" && target.role === "fixture" && !containerIds(spec).has(target.id)) {
      const c = target.pocket_clearance_mm ?? DEFAULT_CLEARANCE_MM;
      band = { mm: c / 2, from: `half the pocket's ${c} mm clearance` };
    } else if (fixture === "pour") {
      // a pour does not put the held container inside the other: the stream has to land in the receiver's opening
      // the opening is inside the container's walls, as the scene builds it
      const opening = Math.max(0, Math.min(tx, ty) - (2 * CONTAINER_WALL_M) / MM);
      band = { mm: opening / 2, from: `half the ${target.name}'s ${r1(opening)} mm opening` };
    } else {
      const room = Math.min(tx - ox, ty - oy) / 2;
      band = { mm: room, from: `the room the ${object.name} has on the ${target.name} (half of ${r1(2 * room)} mm)` };
    }
    if (stated !== undefined && stated < band.mm) band = { mm: stated, from: "the step's stated tolerance, tighter than the geometry" };
    band.mm = Math.max(0.01, Math.round(band.mm * 100) / 100);
    return { step_id: s.id, object, target, fixture, band_mm: band.mm, band_from: band.from, obstacles };
  }
  return null;
}

const sc = (id: string, axis: Scenario["axis"], offset: number, object: string, why: string, extra: Partial<Scenario> = {}): Scenario =>
  Scenario.parse({ id, name: id, axis, offset, object, expected: "unknown", why, ...extra });

const signed = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(x)}`;

/**
 * Twelve with no model, from the spec alone: the target's pose error on x and y at one and two bands on both sides
 * (a band is the tightest room the object has), its yaw when it has a front, a narrower pocket, an obstacle moved
 * when there is one, the target tilted, then the target further out and the object's own pose error until there
 * are twelve. Always exactly twelve when the spec has a placing step.
 */
export function fallbackScenarios(spec: TaskSpec): Scenario[] {
  const f = focusOf(spec);
  if (!f) return [];
  const { target: T, object: O, band_mm: b } = f;
  // a spec whose own world cannot be built has no perturbation that can: nothing to try
  if (worldProblem(spec, sc("nominal", "x_mm", 0, O.id, ""))) return [];
  // one rung is the band, at least 1 mm (distinct rungs) and at most a third of MAX_SHIFT_MM (three rungs stay within it)
  const r = Math.min(MAX_SHIFT_MM / 3, Math.max(1, half(b)));
  const ladder = [r, 2 * r, 3 * r];
  const id = (o: SpecObject, axis: string, v: number) => `${o.id}-${axis}${signed(v).replace("−", "-")}`;
  const out: Scenario[] = [];
  /** worlds built to check candidates, bounded: a spec where most fail must not cost a build per obstacle */
  let tried = 0;
  const add = (o: SpecObject, axis: Scenario["axis"], v: number, why: string, extra: Partial<Scenario> = {}) => {
    const s = sc(id(o, axis.replace(/_(mm|deg)$/, ""), v), axis, v, o.id, why, extra);
    // twelve accepted is enough: every candidate builds its world to be checked
    if (out.length >= SCENARIO_COUNT || tried >= 4 * SCENARIO_COUNT || out.some((x) => x.id === s.id)) return;
    tried++;
    if (oneProblems(spec, s).length === 0) out.push(s);
  };
  // the target's pose error on both sides, at the band and at twice it: what the budget is read from
  for (const axis of ["x_mm", "y_mm"] as const) {
    for (const v of [-ladder[1], -ladder[0], ladder[0], ladder[1]]) add(T, axis, v, `the ${T.name} ${Math.abs(v)} mm off on ${axis[0]}: ${Math.abs(v) <= b ? "at" : "beyond"} the ${b} mm band`);
  }
  if (T.symmetry === "none") add(T, "yaw_deg", 15, `the ${T.name} turned 15°`);
  if (f.fixture === "pocket") {
    const c = T.pocket_clearance_mm ?? DEFAULT_CLEARANCE_MM;
    // half of it, rounded down to 0.1 mm and within MAX_SHIFT_MM: the pocket narrows, never closes
    const n = Math.min(MAX_SHIFT_MM, Math.floor((c / 2) * 10) / 10);
    if (n > 0 && n < c) add(T, "clearance_mm", -n, `the pocket ${n} mm narrower than the ${c} mm asked for`);
  }
  for (const o of f.obstacles) add(o, "y_mm", -ladder[1], `the ${o.name} moved ${ladder[1]} mm on y`);
  add(T, "tilt_deg", 5, `the ${T.name} standing 5° off level`, { tilt_axis: "x" });
  // what is left: the target further out, then the object's own pose error
  const fill: [SpecObject, Scenario["axis"], number][] = [
    [T, "x_mm", ladder[2]],
    [T, "y_mm", ladder[2]],
    [O, "x_mm", ladder[0]],
    [O, "y_mm", ladder[0]],
    [T, "x_mm", -ladder[2]],
    [T, "y_mm", -ladder[2]],
    [O, "x_mm", ladder[1]],
    [O, "y_mm", ladder[1]],
    [O, "x_mm", -ladder[0]],
    [O, "y_mm", -ladder[0]],
    [O, "x_mm", -ladder[1]],
    [O, "y_mm", -ladder[1]],
  ];
  for (const [o, axis, v] of fill) {
    if (out.length >= SCENARIO_COUNT) break;
    add(o, axis, v, o === O ? `the ${O.name} ${v} mm from where it was seen` : `the ${T.name} ${Math.abs(v)} mm off on ${axis[0]}`);
  }
  return out.slice(0, SCENARIO_COUNT);
}

/** Why the world of `s` cannot be built (a pocket widened past its fixture, say), or null. */
function worldProblem(spec: TaskSpec, s: Scenario): string | null {
  let built: string;
  try {
    built = environment(spec, { ...s, gravity_g: 1 }).worldbody;
  } catch (err) {
    return `its world cannot be built (${(err as Error).message})`;
  }
  // the simulator decides what a perturbation changes (a clearance on something not built as a pocket changes nothing)
  if (s.offset !== 0 && built === nominalWorld(spec)) return "its world is the same as the nominal one: it changes nothing the simulator builds";
  return null;
}

const nominals = new WeakMap<TaskSpec, string | null>();
/** The spec's own world as built, once per spec; null when it cannot be built. */
function nominalWorld(spec: TaskSpec): string | null {
  if (!nominals.has(spec)) {
    try {
      // through the same path as a perturbed world (perturb lays out missing poses), moved by nothing
      nominals.set(spec, environment(spec, sc("nominal", "x_mm", 0, spec.objects[0]?.id ?? "", "")).worldbody);
    } catch {
      nominals.set(spec, null);
    }
  }
  return nominals.get(spec)!;
}

/** What is wrong with a set of scenarios for this spec; empty when the grid can run them as they are. */
export function scenarioProblems(spec: TaskSpec, scenarios: Scenario[]): string[] {
  const problems: string[] = [];
  const f = focusOf(spec);
  if (scenarios.length !== SCENARIO_COUNT) problems.push(`there must be exactly ${SCENARIO_COUNT} scenarios, not ${scenarios.length}`);
  const ids = new Set<string>();
  const seen = new Set<string>();
  for (const s of scenarios) {
    const at = `scenario ${s.id}`;
    if (ids.has(s.id)) problems.push(`${at}: the id is used twice`);
    ids.add(s.id);
    problems.push(...oneProblems(spec, s).map((p) => `${at}: ${p}`));
    const key = `${s.object}|${s.axis}|${s.tilt_axis ?? ""}|${s.offset}`;
    if (seen.has(key)) problems.push(`${at}: the same perturbation as another scenario`);
    seen.add(key);
  }
  if (f) {
    const pose = scenarios.filter((s) => s.object === f.target.id && (s.axis === "x_mm" || s.axis === "y_mm"));
    if (pose.length < 4) problems.push(`at least 4 scenarios must move the target "${f.target.id}" on x_mm or y_mm (its pose error is the tightest constraint); there are ${pose.length}`);
  }
  return problems;
}

/** What is wrong with one scenario on its own, its world built to check it. */
function oneProblems(spec: TaskSpec, s: Scenario): string[] {
  const problems: string[] = [];
  const o = spec.objects.find((x) => x.id === s.object);
  if (!o) return [`there is no object "${s.object}"; the ids are ${spec.objects.map((x) => x.id).join(", ")}`];
  if (!(GRID_AXES as readonly string[]).includes(s.axis)) problems.push(`${s.axis} changes nothing in the world; use one of ${GRID_AXES.join(", ")}`);
  if (s.offset === 0) problems.push(`an offset of 0 changes nothing`);
  if (s.axis.endsWith("_mm") && Math.abs(s.offset) > MAX_SHIFT_MM) problems.push(`${s.offset} mm is past the ${MAX_SHIFT_MM} mm a scenario may move`);
  if (s.axis.endsWith("_deg") && Math.abs(s.offset) > MAX_TURN_DEG) problems.push(`${s.offset}° is past the ${MAX_TURN_DEG}° a scenario may turn`);
  if (s.axis === "yaw_deg" && o.symmetry !== "none") problems.push(`yaw on "${o.id}" (${o.symmetry} symmetry) changes nothing; drop it`);
  // a sphere turned any way is the same sphere, unless something is posed in its frame or a step aims at its frame
  // (or it is built as an open container, a box whatever its declared shape)
  const framed = spec.objects.some((x) => x.pose?.frame === o.id) || spec.steps.some((x) => x.target?.frame === o.id || x.pour?.into === o.id || x.via_points.some((v) => v.frame === o.id)) || containerIds(spec).has(o.id);
  // judged by the shape the scene builds, whatever symmetry the spec claims: a sphere turned any way, a cylinder
  // turned about its axis, is the same geometry
  if (!framed && ((o.shape === "sphere" && (s.axis === "tilt_deg" || s.axis === "yaw_deg")) || (o.shape === "cylinder" && s.axis === "yaw_deg"))) {
    problems.push(`turning the ${o.shape} "${o.id}" this way changes nothing physical; drop it`);
  }
  if (s.axis === "clearance_mm") {
    const pocket = spec.steps.some((x) => x.target?.fixture === "pocket" && x.target.frame === o.id);
    if (!pocket) problems.push(`clearance applies only to a fixture used as a pocket, and "${o.id}" is not one`);
    else if (s.offset <= -(o.pocket_clearance_mm ?? DEFAULT_CLEARANCE_MM)) problems.push(`${s.offset} mm would close the pocket's ${o.pocket_clearance_mm ?? DEFAULT_CLEARANCE_MM} mm clearance entirely`);
  }
  if (problems.length === 0) {
    const world = worldProblem(spec, s);
    if (world) problems.push(world);
  }
  return problems;
}

/** The scenarios as the grid runs them: gravity is the page's to set, and a tilt without an axis tilts about x. */
export function forGrid(scenarios: Scenario[]): Scenario[] {
  return scenarios.map((s) => ({ ...s, gravity_g: 1, ...(s.axis === "tilt_deg" && !s.tilt_axis ? { tilt_axis: "x" as const } : {}) }));
}

/** One cell's result, as the budget reads it. */
export type Cell = { scenario: Scenario; mode: Mode; pass: boolean };

/** One axis of one object: the signed band each mode survived. */
export type Budget = { object: string; axis: Axis; tilt_axis?: "x" | "y"; unit: "mm" | "°"; blind: SignedBand; sensed: SignedBand; tested: number[] };

/**
 * Per object and axis, per mode: the largest offset on each side that passed with every smaller one on that side
 * passing, and the smallest that failed. Only what was tested: a side with no scenario stays null.
 */
export function budgetOf(cells: Cell[]): Budget[] {
  const groups = new Map<string, Cell[]>();
  for (const c of cells) {
    const k = `${c.scenario.object}|${c.scenario.axis}|${c.scenario.axis === "tilt_deg" ? (c.scenario.tilt_axis ?? "x") : ""}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  return [...groups.values()].map((g) => {
    const s0 = g[0].scenario;
    const band = (mode: Mode): SignedBand => {
      const side = (sign: 1 | -1) => {
        const xs = g.filter((c) => c.mode === mode && Math.sign(c.scenario.offset) === sign).sort((a, b) => Math.abs(a.scenario.offset) - Math.abs(b.scenario.offset));
        let pass: number | null = null;
        let fail: number | null = null;
        for (const c of xs) {
          if (!c.pass) {
            fail = c.scenario.offset;
            break;
          }
          pass = c.scenario.offset;
        }
        return { pass, fail };
      };
      const pos = side(1);
      const neg = side(-1);
      return { pass_pos: pos.pass, fail_pos: pos.fail, pass_neg: neg.pass, fail_neg: neg.fail };
    };
    const tested = [...new Set(g.map((c) => c.scenario.offset))].sort((a, b) => a - b);
    return {
      object: s0.object,
      axis: s0.axis,
      ...(s0.axis === "tilt_deg" ? { tilt_axis: s0.tilt_axis ?? "x" } : {}),
      unit: s0.axis.endsWith("_deg") ? "°" : "mm",
      blind: band("blind"),
      sensed: band("sensed"),
      tested,
    };
  });
}

/** A band in words: "±2 passes, fails at +4", only what was tested. */
export function bandText(b: SignedBand, unit: string): string {
  const u = (x: number) => `${x > 0 ? "+" : "−"}${Math.abs(x)}${unit === "mm" ? " mm" : unit}`;
  const passed = [b.pass_neg, b.pass_pos].filter((x): x is number => x !== null);
  const failed = [b.fail_neg, b.fail_pos].filter((x): x is number => x !== null);
  const p = passed.length === 2 && Math.abs(passed[0]) === passed[1] ? `±${passed[1]}${unit === "mm" ? " mm" : unit}` : passed.map(u).join(" and ");
  const parts = [passed.length ? `survives ${p}` : "", failed.length ? `fails at ${failed.map(u).join(" and ")}` : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : "not tested";
}
