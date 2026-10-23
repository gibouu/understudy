import { describe, expect, it } from "vitest";
import { Program, TaskSpec } from "@/lib/spec/schema";
import { validateProgram, validateSpec } from "@/lib/spec/validate";

const base = TaskSpec.parse({
  version: 1,
  title: "cup onto saucer",
  summary: "",
  objects: [
    { id: "cup", name: "cup", shape: "cylinder", size_mm: [80, 80, 90], symmetry: "axial", role: "manipulated", pose: { xyz_mm: [250, -100, 45] }, source: "vl#seg1" },
    { id: "saucer", name: "saucer", shape: "cylinder", size_mm: [140, 140, 10], symmetry: "axial", role: "fixture", source: "vl#seg1" },
  ],
  steps: [
    { id: "s1", verb: "grasp", object: "cup", t_start_s: 0, t_end_s: 1, source: "vl#seg1", success: [{ kind: "contact_both_pads", object: "cup" }] },
    { id: "s2", verb: "place", object: "cup", target: { fixture: "zone", frame: "saucer" }, t_start_s: 1, t_end_s: 2, source: "vl#seg2", success: [{ kind: "inside_zone", object: "cup", target: "saucer" }] },
  ],
});

describe("validateSpec", () => {
  it("passes a consistent spec with only a missing-pose warning", () => {
    const issues = validateSpec(base);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.map((i) => i.code)).toEqual(["missing_pose"]);
  });
  it("flags duplicate ids, unknown objects and unknown frames", () => {
    const spec = structuredClone(base);
    spec.objects.push({ ...spec.objects[0] });
    spec.steps[0].object = "ghost";
    spec.steps[1].target = { fixture: "zone", frame: "nowhere" };
    spec.steps[1].success[0].target = "nowhere";
    const codes = validateSpec(spec).map((i) => i.code);
    expect(codes).toContain("duplicate_object_id");
    expect(codes).toContain("unknown_object");
    expect(codes).toContain("unknown_frame");
    expect(codes).toContain("unknown_predicate_target");
  });
  it("warns on a pocket without clearance and on overlapping steps", () => {
    const spec = structuredClone(base);
    spec.steps[1].target = { fixture: "pocket", frame: "saucer" };
    spec.steps[1].t_start_s = 0.5;
    const codes = validateSpec(spec).map((i) => i.code);
    expect(codes).toContain("pocket_without_clearance");
    expect(codes).toContain("steps_overlap");
  });
  it("errors when nothing is manipulated", () => {
    const spec = structuredClone(base);
    spec.objects[0].role = "obstacle";
    expect(validateSpec(spec).map((i) => i.code)).toContain("no_manipulated_object");
  });
});

describe("validateProgram", () => {
  it("checks step ids, frames and grasp objects against the spec", () => {
    const program = Program.parse({
      spec_title: "x",
      steps: [
        { step_id: "s9", ops: [{ op: "move_to", frame: "mars", offset_mm: [0, 0, 0] }, { op: "grasp", object: "plate", aperture_mm: 60 }] },
        { step_id: "s1", ops: [{ op: "assert", predicate: { kind: "contact_both_pads", object: "cup" } }] },
      ],
    });
    const codes = validateProgram(program, base).map((i) => i.code);
    expect(codes).toEqual(["unknown_step", "unknown_frame", "unknown_grasp_object"]);
  });
});
