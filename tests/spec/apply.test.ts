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
    { id: "s1", verb: "grasp", object: "marker", t_start_s: 0.8, t_end_s: 1.6, source: "vl#seg1", via_points: [{ frame: "marker", xyz_mm: [0, 0, 60], source: "pose#seg1" }] },
    { id: "s2", verb: "insert", object: "marker", target: { fixture: "pocket", frame: "rack" }, t_start_s: 1.6, t_end_s: 3.1, source: "vl#seg2" },
  ],
});

describe("parsePath", () => {
  it("splits dots and brackets", () => {
    expect(parsePath("objects[rack].pocket_clearance_mm")).toEqual(["objects", "rack", "pocket_clearance_mm"]);
    expect(parsePath("steps[1].tolerances.x_mm")).toEqual(["steps", "1", "tolerances", "x_mm"]);
    expect(parsePath("anchor.t_s")).toEqual(["anchor", "t_s"]);
    expect(parsePath("objects[a.b].name")).toEqual(["objects", "a.b", "name"]);
  });
});

describe("applyChanges", () => {
  it("sets fields by id and records provenance per leaf", () => {
    const { spec: next, warnings } = applyChanges(spec, [
      { path: "objects[rack].pocket_clearance_mm", value: 3, source: "interview#2" },
      { path: "steps[s2].tolerances.x_mm", value: 2, source: "interview#2" },
      { path: "steps[s2].tolerances.y_mm", value: 4, source: "interview#3" },
      { path: "steps[s1].via_points[0].xyz_mm", value: [0, 0, 80], source: "user#edit" },
      { path: "title", value: "marker into the rack", source: "interview#1" },
    ]);
    expect(warnings).toEqual([]);
    expect(next.objects[1].pocket_clearance_mm).toBe(3);
    expect(next.objects[1].sources).toEqual({ pocket_clearance_mm: "interview#2" });
    expect(next.steps[1].tolerances).toEqual({ x_mm: 2, y_mm: 4 });
    expect(next.steps[1].sources).toEqual({ "tolerances.x_mm": "interview#2", "tolerances.y_mm": "interview#3" });
    expect(next.steps[0].sources).toEqual({ "via_points.0.xyz_mm": "user#edit" });
    expect(next.sources).toEqual({ title: "interview#1" });
    expect(spec.objects[1].pocket_clearance_mm).toBeUndefined(); // input untouched
  });
  it("drops descendant provenance when a parent is replaced", () => {
    const first = applyChanges(spec, [{ path: "steps[s1].via_points[0].xyz_mm", value: [0, 0, 80], source: "user#edit" }]).spec;
    const { spec: next } = applyChanges(first, [{ path: "steps[s1].via_points", value: [{ frame: "marker", xyz_mm: [0, 0, 90], source: "pose#seg1" }], source: "interview#4" }]);
    expect(next.steps[0].sources).toEqual({ via_points: "interview#4" });
  });
  it("sets a field by index and a top-level object", () => {
    const { spec: next } = applyChanges(spec, [
      { path: "objects[0].size_mm", value: [16, 16, 140], source: "user#edit" },
      { path: "anchor", value: { t_s: 1.2, confidence: 0.9 }, source: "pose#seg1" },
    ]);
    expect(next.objects[0].size_mm).toEqual([16, 16, 140]);
    expect(next.anchor?.t_s).toBe(1.2);
    expect(next.sources.anchor).toBe("pose#seg1");
  });
  it("applies interdependent changes as one transaction", () => {
    const { spec: next, warnings } = applyChanges(spec, [
      { path: "anchor.t_s", value: 1.2, source: "pose#seg1" },
      { path: "anchor.confidence", value: 0.9, source: "pose#seg1" },
      { path: "steps[s1].t_start_s", value: 2, source: "interview#2" },
      { path: "steps[s1].t_end_s", value: 3, source: "interview#2" },
    ]);
    expect(warnings).toEqual([]);
    expect(next.anchor).toEqual({ t_s: 1.2, confidence: 0.9 });
    expect([next.steps[0].t_start_s, next.steps[0].t_end_s]).toEqual([2, 3]);
  });
  it("rejects the whole batch when one change breaks an invariant, and names it", () => {
    const { spec: next, warnings } = applyChanges(spec, [
      { path: "steps[s1].t_start_s", value: 2, source: "interview#2" },
      { path: "steps[s1].t_end_s", value: 3, source: "interview#2" },
      { path: "objects[marker].size_mm", value: [0, 15, 140], source: "interview#3" },
    ]);
    expect(next).toEqual(spec);
    expect(warnings[0]).toMatch(/no change applied/);
    expect(warnings.slice(1)).toHaveLength(1);
    expect(warnings[1]).toMatch(/size_mm/);
  });
  it("names the batch as a whole when only the combination fails", () => {
    const { spec: next, warnings } = applyChanges(spec, [
      { path: "steps[s1].t_start_s", value: 3, source: "interview#2" },
      { path: "steps[s1].t_end_s", value: 2.9, source: "interview#2" },
    ]);
    expect(next).toEqual(spec);
    expect(warnings).toHaveLength(2); // the batch reason and the one change that fails alone (t_start_s 3 > t_end_s 1.6)
  });
  it("refuses unknown fields, nested unknown keys and forbidden paths", () => {
    const { spec: next, warnings } = applyChanges(spec, [
      { path: "objects[marker].material", value: "wood", source: "interview#3" },
      { path: "anchor", value: { t_s: 1, confidence: 0.9, extra: 1 }, source: "interview#1" },
      { path: "__proto__.probe", value: true, source: "interview#1" },
      { path: "objects[marker].constructor.prototype.x", value: 1, source: "interview#1" },
    ]);
    expect(next).toEqual(spec);
    expect(warnings.join("\n")).toMatch(/material.*unknown field/);
    expect(warnings.join("\n")).toMatch(/anchor.*extra/);
    expect(warnings.join("\n")).toMatch(/forbidden/);
    expect(({} as { probe?: boolean }).probe).toBeUndefined();
  });
  it("warns on an unknown path", () => {
    const { warnings } = applyChanges(spec, [{ path: "objects[plate].size_mm", value: [1, 1, 1], source: "x" }]);
    expect(warnings.join("\n")).toMatch(/not found/);
  });
  it("matches an id before an index inside brackets", () => {
    const withNumericId = TaskSpec.parse({ ...spec, objects: [spec.objects[0], { ...spec.objects[1], id: "0" }] });
    const { spec: next } = applyChanges(withNumericId, [{ path: "objects[0].name", value: "zero", source: "user#edit" }]);
    expect(next.objects[1].name).toBe("zero");
    expect(next.objects[0].name).toBe("marker");
  });
  it("can rename an id because locations are resolved before mutation", () => {
    const { spec: next, warnings } = applyChanges(spec, [{ path: "objects[rack].id", value: "holder", source: "user#edit" }]);
    expect(warnings).toEqual([]);
    expect(next.objects[1].id).toBe("holder");
  });
});
