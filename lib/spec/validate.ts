/**
 * Reference checks the Zod schema cannot do: ids, frames, step ids, program
 * coverage. Errors mean the simulator cannot run the thing; warnings mean the
 * compiler should ask or default. The compile route turns each error into an
 * `ask`.
 */
import type { Program, TaskSpec } from "./schema";

export type IssueCode =
  | "duplicate_object_id"
  | "duplicate_step_id"
  | "unknown_object"
  | "unknown_frame"
  | "unknown_pose_frame"
  | "pose_frame_cycle"
  | "unknown_predicate_object"
  | "unknown_predicate_target"
  | "no_manipulated_object"
  | "missing_pose"
  | "steps_overlap"
  | "pocket_without_clearance"
  | "unknown_step"
  | "duplicate_program_step"
  | "missing_program_step"
  | "program_step_order"
  | "unknown_grasp_object";

export type SpecIssue = { code: IssueCode; path: string; message: string; severity: "error" | "warning" };

type Registries = { ids: Set<string>; frames: Set<string> };

function registries(spec: TaskSpec): Registries {
  const ids = new Set(spec.objects.map((o) => o.id));
  return { ids, frames: new Set<string>(["world", ...ids]) };
}

function checkPredicates(
  list: TaskSpec["steps"][number]["success"],
  at: string,
  reg: Registries,
  issues: SpecIssue[],
) {
  list.forEach((p, k) => {
    if (p.object && !reg.ids.has(p.object)) {
      issues.push({ code: "unknown_predicate_object", path: `${at}[${k}].object`, message: `${p.kind} names unknown object "${p.object}"`, severity: "error" });
    }
    if (p.target && !reg.frames.has(p.target)) {
      issues.push({ code: "unknown_predicate_target", path: `${at}[${k}].target`, message: `${p.kind} names unknown target "${p.target}"`, severity: "error" });
    }
  });
}

export function validateSpec(spec: TaskSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const seen = new Set<string>();
  spec.objects.forEach((o, i) => {
    if (seen.has(o.id)) issues.push({ code: "duplicate_object_id", path: `objects[${i}].id`, message: `object id "${o.id}" appears twice`, severity: "error" });
    seen.add(o.id);
  });
  const reg = registries(spec);
  const poseFrame = new Map(spec.objects.map((o) => [o.id, o.pose?.frame ?? "world"]));
  // Resolve every pose chain once: "ok" when it reaches world, "cycle" otherwise.
  const chain = new Map<string, "ok" | "cycle">();
  const resolveChain = (start: string) => {
    const path: string[] = [];
    const visiting = new Set<string>();
    let f = start;
    while (f !== "world" && !chain.has(f)) {
      if (visiting.has(f)) {
        for (const id of path) chain.set(id, "cycle");
        return;
      }
      visiting.add(f);
      path.push(f);
      f = poseFrame.get(f) ?? "world";
    }
    const verdict = f === "world" ? "ok" : chain.get(f)!;
    for (const id of path) chain.set(id, verdict);
  };

  spec.objects.forEach((o, i) => {
    if (!o.pose) {
      issues.push({ code: "missing_pose", path: `objects[${i}].pose`, message: `object "${o.id}" has no nominal pose; the scene builder will lay it out`, severity: "warning" });
    } else if (!reg.frames.has(o.pose.frame) || o.pose.frame === o.id) {
      issues.push({ code: "unknown_pose_frame", path: `objects[${i}].pose.frame`, message: `object "${o.id}" is posed in unknown or self frame "${o.pose.frame}"`, severity: "error" });
    } else {
      resolveChain(o.id);
      if (chain.get(o.id) === "cycle") {
        issues.push({ code: "pose_frame_cycle", path: `objects[${i}].pose.frame`, message: `object "${o.id}" has a cyclic pose frame`, severity: "error" });
      }
    }
    if (o.role === "fixture" && o.pocket_clearance_mm === undefined && spec.steps.some((s) => s.target?.fixture === "pocket" && s.target.frame === o.id)) {
      issues.push({ code: "pocket_without_clearance", path: `objects[${i}].pocket_clearance_mm`, message: `fixture "${o.id}" is used as a pocket but has no clearance`, severity: "warning" });
    }
  });
  if (!spec.objects.some((o) => o.role === "manipulated")) {
    issues.push({ code: "no_manipulated_object", path: "objects", message: "no object is marked manipulated", severity: "error" });
  }

  const stepIds = new Set<string>();
  spec.steps.forEach((s, i) => {
    const at = `steps[${i}]`;
    if (stepIds.has(s.id)) issues.push({ code: "duplicate_step_id", path: `${at}.id`, message: `step id "${s.id}" appears twice`, severity: "error" });
    stepIds.add(s.id);
    if (!reg.ids.has(s.object)) issues.push({ code: "unknown_object", path: `${at}.object`, message: `step "${s.id}" manipulates unknown object "${s.object}"`, severity: "error" });
    if (s.target && !reg.frames.has(s.target.frame)) issues.push({ code: "unknown_frame", path: `${at}.target.frame`, message: `step "${s.id}" targets unknown frame "${s.target.frame}"`, severity: "error" });
    s.via_points.forEach((v, k) => {
      if (!reg.frames.has(v.frame)) issues.push({ code: "unknown_frame", path: `${at}.via_points[${k}].frame`, message: `via-point in unknown frame "${v.frame}"`, severity: "error" });
    });
    checkPredicates(s.preconditions, `${at}.preconditions`, reg, issues);
    checkPredicates(s.success, `${at}.success`, reg, issues);
    const prev = spec.steps[i - 1];
    if (prev && s.t_start_s < prev.t_end_s) issues.push({ code: "steps_overlap", path: `${at}.t_start_s`, message: `step "${s.id}" starts before "${prev.id}" ends`, severity: "warning" });
  });
  return issues;
}

/** A program must cover every spec step exactly once, in order, and reference only known things. */
export function validateProgram(program: Program, spec: TaskSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const reg = registries(spec);
  const specOrder = spec.steps.map((s) => s.id);
  const specSteps = new Set(specOrder);
  const seen = new Set<string>();
  program.steps.forEach((ps, i) => {
    const at = `steps[${i}]`;
    if (!specSteps.has(ps.step_id)) issues.push({ code: "unknown_step", path: `${at}.step_id`, message: `program step "${ps.step_id}" is not in the spec`, severity: "error" });
    else if (seen.has(ps.step_id)) issues.push({ code: "duplicate_program_step", path: `${at}.step_id`, message: `program step "${ps.step_id}" appears twice`, severity: "error" });
    seen.add(ps.step_id);
    ps.ops.forEach((op, k) => {
      const opAt = `${at}.ops[${k}]`;
      if (op.op === "move_to" && !reg.frames.has(op.frame)) issues.push({ code: "unknown_frame", path: `${opAt}.frame`, message: `move_to in unknown frame "${op.frame}"`, severity: "error" });
      if (op.op === "grasp" && !reg.ids.has(op.object)) issues.push({ code: "unknown_grasp_object", path: `${opAt}.object`, message: `grasp of unknown object "${op.object}"`, severity: "error" });
      if (op.op === "assert" || op.op === "wait_until") checkPredicates([op.predicate], `${opAt}.predicate`, reg, issues);
    });
  });
  for (const id of specOrder) {
    if (!seen.has(id)) issues.push({ code: "missing_program_step", path: "steps", message: `spec step "${id}" has no program step`, severity: "error" });
  }
  const covered = program.steps.map((ps) => ps.step_id).filter((id) => specSteps.has(id));
  const expected = specOrder.filter((id) => seen.has(id));
  if (covered.length === expected.length && covered.some((id, i) => id !== expected[i])) {
    issues.push({ code: "program_step_order", path: "steps", message: "program steps are not in the spec's order", severity: "warning" });
  }
  return issues;
}
