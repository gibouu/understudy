/**
 * What a patch may change: the numbers in the ops of the step that failed, as
 * named knobs with bounds, the contract docs/MEASUREMENTS.md section 8
 * measured (Super fixes 69% of solvable failures alone, 94% escalating, with
 * 2 to 4 knobs a probe). Frames, objects, the order of ops, the approach and
 * the checks stay fixed: a patch tunes where the arm goes and how long it
 * waits, never what counts as done.
 *
 * A knob is named <step id>.op<index>.<field>, e.g. s2.op1.z_mm, and matched
 * ignoring separators (s2.op1_z_mm is the same knob). Values are validated and
 * clamped to their bounds, which are physical: a held object stops on the
 * surface it would rest on (a pocket's floor, a zone's or a stacked object's
 * top, else the table). Whatever was clamped or rejected is reported back to
 * the patcher in its next prompt instead of passing silently.
 */
import { apply, layoutMissingPoses, MM, WALL_M, worldPoses, type Pose3, type Vec3 } from "@/lib/sim/scene";
import { Program, type ProgramOp, type TaskSpec } from "@/lib/spec/schema";

/** The arm reaches about 300 mm from its base; no offset needs more. */
const REACH_MM = 300;
/** The jaws open from 0 to 60 mm. */
const APERTURE_MM: [number, number] = [0, 60];
const TIMEOUT_S: [number, number] = [0.1, 10];

type Field = "x_mm" | "y_mm" | "z_mm" | "aperture_mm" | "timeout_s";

export type Knob = {
  name: string;
  step: number;
  op: number;
  field: Field;
  value: number;
  min: number;
  max: number;
  /** what the op does, in words */
  meaning: string;
};

export type Clamp = { name: string; requested: number; applied: number };

export type Applied = {
  program: Program;
  /** knob -> value as applied, for the knobs whose value changed */
  set: Record<string, number>;
  changes: { name: string; from: number; to: number }[];
  clamps: Clamp[];
  /** names that are not knobs, or values that are not usable */
  rejected: string[];
  /** nothing changed: the next rollout would repeat the last one */
  noop: boolean;
};

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Where a held object's bottom stops going down in an object's frame (mm from its centre), as the
 * scene builder makes it: a pocket's floor, a zone's or a stacked-on object's top, else the table.
 */
export function restingSurface(spec: TaskSpec, frame: string): { z: number; what: string; rim?: number } {
  const o = spec.objects.find((x) => x.id === frame);
  if (!o) return { z: 0, what: "the table" };
  const top = o.size_mm[2] / 2;
  const fixture = spec.steps.find((s) => s.target?.frame === frame)?.target?.fixture;
  if (fixture === "pocket") return { z: r1(-top + Math.min(WALL_M / MM, top)), what: `${frame}'s pocket floor`, rim: top };
  if (fixture) return { z: top, what: `${frame}'s top` };
  return { z: -top, what: "the table" };
}

/** "its bottom N mm above <surface>" for an object whose centre sits at height z in a frame. */
export function bottomAbove(spec: TaskSpec, object: string, frame: string, z: number): string {
  const half = (spec.objects.find((o) => o.id === object)?.size_mm[2] ?? 0) / 2;
  const s = restingSurface(spec, frame);
  const b = z - half;
  const rel = (d: number, what: string) => `${Math.abs(r1(d)).toFixed(1)} mm ${r1(d) < 0 ? "below" : "above"} ${what}`;
  return `its bottom ${rel(b - s.z, s.what)}${s.rim !== undefined ? ` (${rel(b - s.rim, "its rim")})` : ""}`;
}

/** Object frames as the nominal rehearsal lays them out; empty when the spec cannot be posed. */
function framesOf(spec: TaskSpec): Record<string, Pose3> {
  try {
    return worldPoses(layoutMissingPoses(spec).spec);
  } catch {
    return {};
  }
}

/** The knobs of the given steps (all steps when none are given), in program order. */
export function knobsOf(spec: TaskSpec, program: Program, steps?: ReadonlySet<string>): Knob[] {
  const name = (id?: string) => spec.objects.find((o) => o.id === id)?.name ?? id ?? "?";
  const frames = framesOf(spec);
  /** where a move aims, world mm, when its frame is known */
  const aim = (op: Extract<ProgramOp, { op: "move_to" }>): Vec3 | null => {
    if (op.frame === "world") return op.offset_mm;
    const f = Object.hasOwn(frames, op.frame) ? frames[op.frame] : undefined;
    if (!f) return null;
    const d = apply(f.R, op.offset_mm);
    return [f.xyz_mm[0] + d[0], f.xyz_mm[1] + d[1], f.xyz_mm[2] + d[2]];
  };
  const knobs: Knob[] = [];
  let held: string | null = null;
  let last: Vec3 | null = null;
  program.steps.forEach((s, si) => {
    s.ops.forEach((op, oi) => {
      const mine = !steps || steps.has(s.step_id);
      const k = (field: Field, value: number, meaning: string, min: number, max: number) => mine && knobs.push({ name: `${s.step_id}.op${oi}.${field}`, step: si, op: oi, field, value, meaning, min, max });
      switch (op.op) {
        case "move_to": {
          const what = held ? `the held ${name(held)}'s centre` : "the point between the pads";
          const from = op.frame === "world" ? "the robot base" : `${op.frame}'s centre`;
          const at = aim(op);
          const side = at && last ? Math.hypot(at[0] - last[0], at[1] - last[1]) : null;
          const travel = side === null ? "" : side > 5 ? ` (a carry, ${Math.round(side)} mm sideways from the previous move)` : ` (straight ${at![2] < last![2] ? "down" : "up"} ${Math.round(Math.abs(at![2] - last![2]))} mm from the previous move)`;
          const where = held && op.frame !== "world" ? `: ${bottomAbove(spec, held, op.frame, op.offset_mm[2])}` : "";
          const meaning = `${s.step_id} op ${oi}: move ${what} to (${op.offset_mm.join(", ")}) mm from ${from}${travel}${where}`;
          // the pads stop at the table; a held object on the surface it would rest on
          const half = (spec.objects.find((o) => o.id === held)?.size_mm[2] ?? 0) / 2;
          const floor = op.frame === "world" ? 0 : held ? restingSurface(spec, op.frame).z + half : -(spec.objects.find((o) => o.id === op.frame)?.size_mm[2] ?? 0) / 2;
          k("x_mm", op.offset_mm[0], meaning, -REACH_MM, REACH_MM);
          k("y_mm", op.offset_mm[1], meaning, -REACH_MM, REACH_MM);
          k("z_mm", op.offset_mm[2], meaning, r1(floor), REACH_MM);
          last = at;
          break;
        }
        case "grasp":
          k("aperture_mm", op.aperture_mm, `${s.step_id} op ${oi}: close the gripper to this aperture on the ${name(op.object)}`, ...APERTURE_MM);
          held = op.object;
          break;
        case "release":
          held = null;
          break;
        case "wait_until":
          k("timeout_s", op.timeout_s, `${s.step_id} op ${oi}: how long to wait for ${op.predicate.kind}${op.predicate.object ? ` of the ${name(op.predicate.object)}` : ""} before failing`, ...TIMEOUT_S);
          break;
      }
    });
  });
  return knobs;
}

const canonical = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Validate, clamp and apply a patch's `set` to the knobs of `steps`; the result always parses as a Program. */
export function applyPatch(spec: TaskSpec, program: Program, set: Record<string, unknown> | null | undefined, steps?: ReadonlySet<string>): Applied {
  const knobs = new Map(knobsOf(spec, program, steps).map((k) => [canonical(k.name), k]));
  const next: Program = structuredClone(program);
  const out: Applied = { program: next, set: {}, changes: [], clamps: [], rejected: [], noop: true };
  for (const [asked, raw] of Object.entries(set ?? {})) {
    const k = knobs.get(canonical(asked));
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!k || !Number.isFinite(n)) {
      out.rejected.push(asked);
      continue;
    }
    const value = r1(Math.min(Math.max(n, k.min), k.max));
    if (value !== r1(n)) out.clamps.push({ name: k.name, requested: n, applied: value });
    if (value === k.value) continue;
    const op = next.steps[k.step].ops[k.op];
    if (op.op === "move_to") op.offset_mm[["x_mm", "y_mm", "z_mm"].indexOf(k.field)] = value;
    else if (op.op === "grasp") op.aperture_mm = value;
    else if (op.op === "wait_until") op.timeout_s = value;
    out.set[k.name] = value;
    out.changes.push({ name: k.name, from: k.value, to: value });
  }
  out.noop = out.changes.length === 0;
  out.program = Program.parse(next);
  return out;
}

/** The knobs grouped by op, as the patcher reads them. */
export function knobLines(knobs: Knob[]): string {
  const byOp = new Map<string, Knob[]>();
  for (const k of knobs) byOp.set(k.meaning, [...(byOp.get(k.meaning) ?? []), k]);
  return [...byOp.entries()].map(([meaning, ks]) => `- ${meaning}\n${ks.map((k) => `    ${k.name} = ${k.value} (${k.min} to ${k.max})`).join("\n")}`).join("\n");
}
