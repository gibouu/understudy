import { describe, expect, it } from "vitest";
import { applyChanges } from "@/lib/spec/apply";
import { askable, formFor, withRequiredAsks } from "@/lib/spec/answer";
import { Program, TaskSpec } from "@/lib/spec/schema";

const spec = TaskSpec.parse({
  version: 1,
  title: "t",
  summary: "",
  objects: [
    { id: "peg", name: "peg", shape: "cylinder", size_mm: [10, 10, 30], symmetry: "axial", role: "manipulated" },
    { id: "block", name: "block", shape: "box", size_mm: [60, 60, 30], symmetry: "none", role: "fixture" },
  ],
  steps: [{ id: "s2", verb: "insert", object: "peg", target: { fixture: "pocket", frame: "block" }, t_start_s: 0, t_end_s: 1 }],
});

describe("formFor", () => {
  it("asks for a number with its unit on measured fields", () => {
    expect(formFor(spec, "objects[block].pocket_clearance_mm")).toEqual({ kind: "number", unit: "mm" });
    expect(formFor(spec, "steps[s2].tolerances.yaw_deg")).toEqual({ kind: "number", unit: "°" });
  });

  it("offers checks for a step's success that apply to the spec", () => {
    const form = formFor(spec, "steps[s2].success");
    if (form.kind !== "success") throw new Error(form.kind);
    expect(form.options[0].label).toBe("the peg ends up in the block and stays there");
    const { spec: answered, warnings } = applyChanges(spec, [{ path: "steps[s2].success", value: form.options[0].predicates, source: "interview#1" }]);
    expect(warnings).toEqual([]);
    expect(answered.steps[0].success.map((p) => p.kind)).toEqual(["inside_zone", "object_still"]);
  });

  it("says when it cannot take an answer", () => {
    expect(formFor(spec, "objects[block].pose")).toEqual({ kind: "unsupported" });
    expect(formFor(spec, "steps[nope].success")).toEqual({ kind: "unsupported" });
  });
});

describe("askable", () => {
  it("keeps the questions a person can answer", () => {
    expect(askable(spec, "objects[block].pocket_clearance_mm")).toBe(true);
    expect(askable(spec, "steps[s2].tolerances.x_mm")).toBe(true);
    expect(askable(spec, "steps[s2].success")).toBe(true);
  });

  it("drops questions about motion, unknown ids and fields the fit sets", () => {
    expect(askable(spec, "steps[s2].carry_point")).toBe(false);
    expect(askable(spec, "steps[s2].via_points")).toBe(false);
    expect(askable(spec, "steps[s9].success")).toBe(false);
    expect(askable(spec, "objects[block].pose")).toBe(false);
    expect(askable(spec, "objects[peg].pocket_clearance_mm")).toBe(false);
    expect(askable(spec, "steps[s2].tolerances.speed_mm")).toBe(false);
    expect(askable(spec, "carry_height")).toBe(false);
  });
});

describe("withRequiredAsks", () => {
  const program = Program.parse({ spec_title: "t", steps: [{ step_id: "s2", ops: [{ op: "release" }] }] });

  it("asks for a missing clearance and success check, once", () => {
    const { program: out, added } = withRequiredAsks(spec, program);
    expect(added).toEqual(["objects[block].pocket_clearance_mm", "steps[s2].success"]);
    expect(out.steps[0].ops.map((op) => op.op)).toEqual(["ask", "ask", "release"]);
    expect(withRequiredAsks(spec, out).added).toEqual([]);
  });

  it("asks nothing once the spec has both", () => {
    const answered = TaskSpec.parse({ ...spec, objects: [spec.objects[0], { ...spec.objects[1], pocket_clearance_mm: 8 }], steps: [{ ...spec.steps[0], success: [{ kind: "object_still", object: "peg" }] }] });
    expect(withRequiredAsks(answered, program).added).toEqual([]);
  });
});
