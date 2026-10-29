/**
 * The failure note: what the simulator measured in the last rehearsal, per
 * gravity, in words. Measured facts only (the failed op, the check's reading,
 * where the object was let go and where it ended up, its speed, seated or
 * not), never a knob name or a value to set: the patcher has to find the
 * change itself (docs/MEASUREMENTS.md section 8).
 */
import type { ObjectState, Rollout } from "@/lib/sim/interpreter";
import { apply, layoutMissingPoses, mjcfName, transpose, worldPoses, type Pose3, type Vec3 } from "@/lib/sim/scene";
import { GRAVITIES, type GravityName, type Predicate, type Program, type ProgramOp, type TaskSpec } from "@/lib/spec/schema";
import { bottomAbove } from "./knobs";

export type WorldRun = { world: GravityName; rollout: Rollout };

const f1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
const xyz = (v: number[]) => `(${v.map(f1).join(", ")})`;

function pred(p: Predicate): string {
  return [p.kind, p.object, p.target && `in ${p.target}`, p.value !== undefined && `${p.value}`].filter(Boolean).join(" ");
}

/** An op as the note names it: the program's own words, no knob names. */
export function opText(op: ProgramOp): string {
  switch (op.op) {
    case "move_to":
      return `move_to ${op.frame} (${op.offset_mm.join(", ")}) mm from the ${op.approach}`;
    case "grasp":
      return `grasp ${op.object} at ${op.aperture_mm} mm`;
    case "release":
      return "release";
    case "follow":
      return "follow the gesture path";
    case "contact":
      return "contact along the step's path";
    case "toss":
      return `toss at (${op.velocity_mm_s.join(", ")}) mm/s over a ${op.run_mm} mm run-up`;
    case "catch":
      return `catch ${op.object}${op.frame === undefined && op.offset_mm === undefined ? " where the gripper is" : ` near ${op.frame ?? "world"} (${(op.offset_mm ?? [0, 0, 0]).join(", ")}) mm`}`;
    case "tilt":
      return `tilt ${op.deg}°${op.toward ? ` toward ${op.toward}` : ""} over ${op.seconds} s`;
    case "wait_until":
      return `wait_until ${pred(op.predicate)} (up to ${op.timeout_s} s)`;
    case "assert":
      return `assert ${pred(op.predicate)}`;
    case "ask":
      return `ask ${op.slot}`;
  }
}

/** A world point in an object's frame. */
function local(frame: Pose3, p: Vec3): Vec3 {
  return apply(transpose(frame.R), [p[0] - frame.xyz_mm[0], p[1] - frame.xyz_mm[1], p[2] - frame.xyz_mm[2]]);
}

/** `release <body> at (x, y, z) mm` lines of a rollout log, as object ids and world mm. */
function releases(spec: TaskSpec, log: string[]): { t: number; object: string; at: Vec3 }[] {
  const byBody = new Map(spec.objects.map((o) => [mjcfName(o.id), o.id]));
  return log.flatMap((line) => {
    const m = /^(\d+(?:\.\d+)?) release (\S+) at \(([^)]+)\) mm/.exec(line);
    const object = m && byBody.get(m[2]);
    const at = m?.[3].split(",").map(Number);
    return m && object && at?.length === 3 && at.every(Number.isFinite) ? [{ t: Number(m[1]), object, at: at as Vec3 }] : [];
  });
}

function place(spec: TaskSpec, frames: Record<string, Pose3>, object: string, world: Vec3): string {
  const target = spec.steps.findLast((s) => s.object === object && s.target && s.target.frame !== "world")?.target?.frame;
  const f = target && Object.hasOwn(frames, target) ? frames[target] : undefined;
  if (!f) return `${object}'s centre at ${xyz(world)} mm from the robot base`;
  const p = local(f, world);
  return `${object}'s centre at ${xyz(p)} mm from ${target}'s centre, ${bottomAbove(spec, object, target!, p[2])}`;
}

function endLine(spec: TaskSpec, frames: Record<string, Pose3>, s: ObjectState): string {
  const parts = [place(spec, frames, s.object, s.xyz_mm), `moving at ${f1(s.speed_mm_s)} mm/s`, s.held ? "still held" : "not held"];
  if (s.seated) parts.push(s.seated.ok ? `seated in ${s.seated.target}` : `not seated: ${s.seated.why}`);
  return parts.join(", ");
}

/** One line per world, for the attempts list: pass, or where and why it failed. */
export function outcomeLine(runs: WorldRun[]): string {
  return runs
    .map(({ world, rollout: r }) => `${world} (${GRAVITIES[world]} g) ${r.pass ? "PASS" : `FAIL${r.failed_step_id ? ` at ${r.failed_step_id}${r.failed_op !== undefined ? ` op ${r.failed_op}` : ""}` : ""}: ${r.why ?? "no reason given"}`}`)
    .join("; ");
}

export function failureNote(spec: TaskSpec, program: Program, runs: WorldRun[]): string {
  // sensed rehearsals without a scenario see the spec's own poses, laid out the way the scene builder does
  let frames: Record<string, Pose3> = {};
  try {
    frames = worldPoses(layoutMissingPoses(spec).spec);
  } catch {
    // an unposable spec still gets a note, in world coordinates
  }
  return runs
    .map(({ world, rollout: r }) => {
      const head = `${world} (${GRAVITIES[world]} g):`;
      if (r.pass) return `${head} PASS in ${f1(r.t)} s.${r.end?.length ? ` At the end: ${r.end.map((s) => endLine(spec, frames, s)).join("; ")}.` : ""}`;
      const op = r.failed_step_id !== undefined && r.failed_op !== undefined ? program.steps.find((s) => s.step_id === r.failed_step_id)?.ops[r.failed_op] : undefined;
      const lines = [
        `${head} FAIL after ${f1(r.t)} s${r.failed_step_id ? ` at ${r.failed_step_id}${r.failed_op !== undefined ? ` op ${r.failed_op}` : ""}` : ""}${op ? ` (${opText(op)})` : ""}${r.failure_class ? `, ${r.failure_class.replace("_", " ")}` : ""}.`,
        `  Measured: ${r.why ?? "no reason given"}.`,
        ...releases(spec, r.log).map((x) => `  Let go at ${f1(x.t)} s with ${place(spec, frames, x.object, x.at)}.`),
        ...(r.end ?? []).map((s) => `  At the end: ${endLine(spec, frames, s)}.`),
      ];
      return lines.join("\n");
    })
    .join("\n");
}
