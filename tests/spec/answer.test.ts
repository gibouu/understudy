import { describe, expect, it } from "vitest";
import { applyChanges } from "@/lib/spec/apply";
import { formFor } from "@/lib/spec/answer";
import { TaskSpec } from "@/lib/spec/schema";

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
