import { describe, expect, it } from "vitest";
import { resolveFixtureNames } from "@/lib/spec/normalize";
import { Program, TaskSpec } from "@/lib/spec/schema";

const spec = TaskSpec.parse({
  version: 1,
  title: "t",
  summary: "",
  objects: [
    { id: "obj1", name: "film", shape: "box", size_mm: [40, 10, 40], symmetry: "none", role: "manipulated" },
    { id: "obj2", name: "pillow", shape: "box", size_mm: [80, 80, 30], symmetry: "none", role: "fixture" },
  ],
  steps: [
    { id: "s1", verb: "grasp", object: "obj1", t_start_s: 0, t_end_s: 1 },
    { id: "s2", verb: "insert", object: "obj1", target: { fixture: "pocket", frame: "obj2" }, t_start_s: 1, t_end_s: 2 },
  ],
});
const program = Program.parse({
  spec_title: "t",
  steps: [
    { step_id: "s1", ops: [{ op: "move_to", frame: "pocket", offset_mm: [0, 0, 62] }] },
    {
      step_id: "s2",
      ops: [
        { op: "move_to", frame: "pocket", offset_mm: [0, 0, 55] },
        { op: "assert", predicate: { kind: "inside_zone", object: "obj1", target: "pocket" } },
      ],
    },
  ],
});

describe("resolveFixtureNames", () => {
  const { program: out, warnings } = resolveFixtureNames(program, spec);

  it("reads a fixture kind as the step's target inside that step", () => {
    const ops = out.steps[1].ops;
    expect(ops[0]).toMatchObject({ op: "move_to", frame: "obj2" });
    expect(ops[1]).toMatchObject({ predicate: { kind: "inside_zone", object: "obj1", target: "obj2" } });
    expect(warnings).toHaveLength(2);
  });

  it("leaves it alone in a step without that target", () => {
    expect(out.steps[0].ops[0]).toMatchObject({ frame: "pocket" });
  });
});
