import { describe, expect, it } from "vitest";
import { applyChanges, parsePath } from "@/lib/spec/apply";
import { TaskSpec } from "@/lib/spec/schema";

const spec = TaskSpec.parse({
  version: 1,
  title: "marker into rack",
  summary: "",
  objects: [
    { id: "marker", name: "marker", shape: "cylinder", size_mm: [15, 15, 140], symmetry: "axial", role: "manipulated", source: "vl#seg1" },
    { id: "rack", name: "rack", shape: "box", size_mm: [120, 80, 40], symmetry: "none", role: "fixture", source: "vl#seg1" },
  ],
  steps: [
    { id: "s1", verb: "grasp", object: "marker", t_start_s: 0.8, t_end_s: 1.6, source: "vl#seg1" },
    { id: "s2", verb: "insert", object: "marker", target: { fixture: "pocket", frame: "rack" }, t_start_s: 1.6, t_end_s: 3.1, source: "vl#seg2" },
  ],
});

describe("parsePath", () => {
  it("splits dots and brackets", () => {
    expect(parsePath("objects[rack].pocket_clearance_mm")).toEqual(["objects", "rack", "pocket_clearance_mm"]);
    expect(parsePath("steps[1].tolerances.x_mm")).toEqual(["steps", "1", "tolerances", "x_mm"]);
    expect(parsePath("anchor.t_s")).toEqual(["anchor", "t_s"]);
  });
});

describe("applyChanges", () => {
  it("sets a field by id and records its provenance", () => {
    const { spec: next, warnings } = applyChanges(spec, [
      { path: "objects[rack].pocket_clearance_mm", value: 3, source: "interview#2" },
      { path: "steps[s2].tolerances.x_mm", value: 2, source: "interview#2" },
    ]);
    expect(warnings).toEqual([]);
    expect(next.objects[1].pocket_clearance_mm).toBe(3);
    expect(next.objects[1].sources).toEqual({ pocket_clearance_mm: "interview#2" });
    expect(next.steps[1].tolerances.x_mm).toBe(2);
    expect(next.steps[1].sources).toEqual({ tolerances: "interview#2" });
    expect(spec.objects[1].pocket_clearance_mm).toBeUndefined(); // input untouched
  });
  it("sets a field by index and a top-level field", () => {
    const { spec: next } = applyChanges(spec, [
      { path: "objects[0].size_mm", value: [16, 16, 140], source: "user#edit" },
      { path: "anchor", value: { t_s: 1.2, confidence: 0.9 }, source: "pose#seg1" },
    ]);
    expect(next.objects[0].size_mm).toEqual([16, 16, 140]);
    expect(next.anchor?.t_s).toBe(1.2);
  });
  it("rejects a change that breaks an invariant and keeps the rest", () => {
    const { spec: next, warnings } = applyChanges(spec, [
      { path: "objects[marker].size_mm", value: [0, 15, 140], source: "interview#3" },
      { path: "steps[s1].t_end_s", value: 1.9, source: "interview#3" },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/size_mm/);
    expect(next.objects[0].size_mm).toEqual([15, 15, 140]);
    expect(next.steps[0].t_end_s).toBe(1.9);
  });
  it("warns on an unknown path", () => {
    const { warnings } = applyChanges(spec, [{ path: "objects[plate].size_mm", value: [1, 1, 1], source: "x" }]);
    expect(warnings[0]).toMatch(/not found/);
  });
});
