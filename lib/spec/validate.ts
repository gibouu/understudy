/**
 * Reference checks the Zod schema cannot do: ids, frames, step ids. Errors
 * mean the simulator cannot run the thing; warnings mean the compiler should
 * ask or default. The compile route turns each error into an `ask`.
 */
import type { Program, TaskSpec } from "./schema";

export type SpecIssue = {
  code:
    | "duplicate_object_id"
    | "duplicate_step_id"
    | "unknown_object"
    | "unknown_frame"
    | "unknown_predicate_object"
    | "unknown_predicate_target"
    | "no_manipulated_object"
    | "missing_pose"
    | "steps_overlap"
    | "pocket_without_clearance"
    | "unknown_step"
    | "unknown_grasp_object";
  path: string;
  message: string;
  severity: "error" | "warning";
};

export function validateSpec(spec: TaskSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const ids = new Set<string>();
  spec.objects.forEach((o, i) => {
    if (ids.has(o.id)) issues.push({ code: "duplicate_object_id", path: `objects[${i}].id`, message: `object id "${o.id}" appears twice`, severity: "error" });
    ids.add(o.id);
    if (!o.pose) issues.push({ code: "missing_pose", path: `objects[${i}].pose`, message: `object "${o.id}" has no nominal pose; the scene builder will lay it out`, severity: "warning" });
    if (o.role === "fixture" && o.pocket_clearance_mm === undefined && spec.steps.some((s) => s.target?.fixture === "pocket" && s.target.frame === o.id)) {
      issues.push({ code: "pocket_without_clearance", path: `objects[${i}].pocket_clearance_mm`, message: `fixture "${o.id}" is used as a pocket but has no clearance`, severity: "warning" });
    }
  });
  if (!spec.objects.some((o) => o.role === "manipulated")) {
    issues.push({ code: "no_manipulated_object", path: "objects", message: "no object is marked manipulated", severity: "error" });
  }
  const frames = new Set<string>(["world", ...ids]);
  const stepIds = new Set<string>();
  spec.steps.forEach((s, i) => {
    const at = `steps[${i}]`;
    if (stepIds.has(s.id)) issues.push({ code: "duplicate_step_id", path: `${at}.id`, message: `step id "${s.id}" appears twice`, severity: "error" });
    stepIds.add(s.id);
    if (!ids.has(s.object)) issues.push({ code: "unknown_object", path: `${at}.object`, message: `step "${s.id}" manipulates unknown object "${s.object}"`, severity: "error" });
    if (s.target && !frames.has(s.target.frame)) issues.push({ code: "unknown_frame", path: `${at}.target.frame`, message: `step "${s.id}" targets unknown frame "${s.target.frame}"`, severity: "error" });
    s.via_points.forEach((v, k) => {
      if (!frames.has(v.frame)) issues.push({ code: "unknown_frame", path: `${at}.via_points[${k}].frame`, message: `via-point in unknown frame "${v.frame}"`, severity: "error" });
    });
    for (const [list, name] of [[s.preconditions, "preconditions"], [s.success, "success"]] as const) {
      list.forEach((p, k) => {
        if (p.object && !ids.has(p.object)) issues.push({ code: "unknown_predicate_object", path: `${at}.${name}[${k}].object`, message: `${p.kind} names unknown object "${p.object}"`, severity: "error" });
        if (p.target && !frames.has(p.target)) issues.push({ code: "unknown_predicate_target", path: `${at}.${name}[${k}].target`, message: `${p.kind} names unknown target "${p.target}"`, severity: "error" });
      });
    }
    const prev = spec.steps[i - 1];
    if (prev && s.t_start_s < prev.t_end_s) issues.push({ code: "steps_overlap", path: `${at}.t_start_s`, message: `step "${s.id}" starts before "${prev.id}" ends`, severity: "warning" });
  });
  return issues;
}

export function validateProgram(program: Program, spec: TaskSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const stepIds = new Set(spec.steps.map((s) => s.id));
  const ids = new Set(spec.objects.map((o) => o.id));
  const frames = new Set<string>(["world", ...ids]);
  program.steps.forEach((ps, i) => {
    const at = `steps[${i}]`;
    if (!stepIds.has(ps.step_id)) issues.push({ code: "unknown_step", path: `${at}.step_id`, message: `program step "${ps.step_id}" is not in the spec`, severity: "error" });
    ps.ops.forEach((op, k) => {
      if (op.op === "move_to" && !frames.has(op.frame)) issues.push({ code: "unknown_frame", path: `${at}.ops[${k}].frame`, message: `move_to in unknown frame "${op.frame}"`, severity: "error" });
      if (op.op === "grasp" && !ids.has(op.object)) issues.push({ code: "unknown_grasp_object", path: `${at}.ops[${k}].object`, message: `grasp of unknown object "${op.object}"`, severity: "error" });
      if ((op.op === "assert" || op.op === "wait_until") && op.predicate.object && !ids.has(op.predicate.object)) {
        issues.push({ code: "unknown_predicate_object", path: `${at}.ops[${k}].predicate.object`, message: `${op.predicate.kind} names unknown object "${op.predicate.object}"`, severity: "error" });
      }
    });
  });
  return issues;
}
