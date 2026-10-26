import { describe, expect, it } from "vitest";
import { fitToBench } from "@/lib/sim/fit";
import { askable, withRequiredAsks } from "@/lib/spec/answer";
import { tidyLabel } from "@/lib/spec/label";
import { normalizeProgram } from "@/lib/spec/normalize";
import { Program, Step, TaskSpec } from "@/lib/spec/schema";
import { lintProgram, validateSpec } from "@/lib/spec/validate";

const path = Array.from({ length: 20 }, (_, k) => ({ t_s: k / 10, xyz_mm: [220, 60 * Math.sin(k), 240] as [number, number, number] }));

const spec = (steps: unknown[], objects: unknown[] = []) => TaskSpec.parse({ version: 1, title: "t", summary: "", objects, steps });
const gesture = (extra: object = {}) => ({ id: "s1", verb: "gesture", gesture: { hand: "right", path }, t_start_s: 0, t_end_s: 2, ...extra });
const jar = { id: "jar", name: "jar", shape: "cylinder", size_mm: [40, 40, 80], symmetry: "axial", role: "manipulated" };
const tray = { id: "tray", name: "tray", shape: "box", size_mm: [200, 150, 20], symmetry: "none", role: "fixture" };

describe("the gesture step in the schema", () => {
  it("has no object; every other verb still needs one", () => {
    expect(Step.safeParse(gesture()).success).toBe(true);
    expect(Step.safeParse({ id: "s1", verb: "place", t_start_s: 0, t_end_s: 1 }).success).toBe(false);
    expect(Step.parse(gesture({ gesture: { path } })).gesture?.reach_mm).toBe(5);
    expect(Step.parse(gesture({ gesture: {} })).gesture?.path).toEqual([]);
  });

  it("reads an op a model wrote as a string", () => {
    const { data, warnings } = normalizeProgram({ spec_title: "", steps: [{ step_id: "s1", ops: ["follow", '{"op":"release"}', "lift it"] }] });
    expect((data as { steps: { ops: unknown[] }[] }).steps[0].ops).toEqual([{ op: "follow" }, { op: "release" }, "lift it"]);
    expect(warnings).toHaveLength(2);
  });

  it("parses the follow op", () => {
    expect(Program.parse({ spec_title: "", steps: [{ step_id: "s1", ops: [{ op: "follow" }] }] }).steps[0].ops[0]).toEqual({ op: "follow" });
  });
});

describe("a labelled gesture", () => {
  it("keeps its own window when it overlaps a step of the other hand, and the steps after it are still trimmed", () => {
    const raw = {
      title: "t",
      summary: "",
      objects: [jar],
      steps: [
        { id: "s1", verb: "grasp", object: "jar", t_start_s: 0, t_end_s: 8 },
        { id: "s2", verb: "gesture", gesture: { hand: "right" }, t_start_s: 0, t_end_s: 8 },
        { id: "s3", verb: "release", object: "jar", t_start_s: 7, t_end_s: 8 },
      ],
    };
    const spec = TaskSpec.parse(tidyLabel(raw, 8).data);
    expect(spec.steps.map((s) => [s.id, s.t_start_s, s.t_end_s])).toEqual([["s1", 0, 8], ["s2", 0, 8], ["s3", 8, 8]]);
    expect(validateSpec(spec).map((i) => i.code)).not.toContain("steps_overlap");
  });

  it("drops the object the model named, keeps the hand in lower case, and gets a gesture block", () => {
    const raw = { title: "t", summary: "", objects: [], steps: [{ id: "s1", verb: "Gesture", object: "hand", target: { fixture: "zone" }, gesture: { hand: "Right" }, t_start_s: 0, t_end_s: 8 }] };
    const { data, warnings } = tidyLabel(raw, 8);
    const s = TaskSpec.parse(data).steps[0];
    expect(s).toMatchObject({ verb: "gesture", gesture: { hand: "right", path: [] } });
    expect(s.object).toBeUndefined();
    expect(warnings.join(" ")).toMatch(/handles no object; "hand" dropped/);
    expect(s.target).toBeUndefined();
    expect(warnings.join(" ")).toMatch(/a gesture has no target/);
    const bare = tidyLabel({ ...raw, steps: [{ ...raw.steps[0], gesture: undefined, object: undefined }] }, 8).data;
    expect(TaskSpec.parse(bare).steps[0].gesture).toEqual({ path: [], reach_mm: 5 });
  });

  it("never keeps a path or a reach the model wrote: the path is measured from the clip", () => {
    const invented = { title: "t", summary: "", objects: [], steps: [{ id: "s1", verb: "gesture", gesture: { hand: "left", path: [{ t_s: 0, xyz_mm: [220, 0, 240] }, { t_s: 1, xyz_mm: [220, 60, 240] }], reach_mm: 50 }, t_start_s: 0, t_end_s: 8 }] };
    const { data, warnings } = tidyLabel(invented, 8);
    expect(TaskSpec.parse(data).steps[0].gesture).toEqual({ hand: "left", path: [], reach_mm: 5 });
    expect(warnings.filter((w) => /model's gesture (path|reach_mm) dropped/.test(w))).toHaveLength(2);
  });

  it("validates: a spec of gestures alone needs no manipulated object, and the path is checked", () => {
    expect(validateSpec(spec([gesture()])).filter((i) => i.severity === "error")).toEqual([]);
    const codes = (s: TaskSpec) => validateSpec(s).map((i) => i.code);
    expect(codes(spec([gesture({ gesture: { path: [] } })]))).toContain("gesture_without_path");
    expect(codes(spec([gesture({ gesture: undefined })]))).toContain("gesture_without_block");
    expect(codes(spec([{ id: "s1", verb: "place", object: "jar", gesture: { path }, t_start_s: 0, t_end_s: 1 }], [jar]))).toContain("gesture_block_on_other_verb");
    expect(codes(spec([gesture({ gesture: { path: [path[1], path[0]] } })]))).toContain("gesture_path_order");
    expect(codes(spec([gesture({ gesture: { path: [path[0], { ...path[1], t_s: path[0].t_s }] } })]))).toContain("gesture_path_order");
    // a manipulation still needs its object marked
    expect(codes(spec([gesture({ id: "s2", t_start_s: 2, t_end_s: 3 }), { id: "s1", verb: "move", object: "jar", t_start_s: 0, t_end_s: 1 }], [{ ...jar, role: "fixture" }]))).toContain("no_manipulated_object");
  });
});

describe("the compiled gesture", () => {
  const follow = Program.parse({ spec_title: "t", steps: [{ step_id: "s1", ops: [{ op: "follow" }] }] });

  it("lints: a gesture step must follow its path, and only a gesture step follows", () => {
    expect(lintProgram(follow, spec([gesture()]))).toEqual([]);
    expect(lintProgram(Program.parse({ spec_title: "t", steps: [{ step_id: "s1", ops: [] }] }), spec([gesture()]))).toEqual([expect.stringMatching(/never follows its path/)]);
    const place = spec([{ id: "s1", verb: "place", object: "jar", target: { fixture: "zone", frame: "tray" }, t_start_s: 0, t_end_s: 1 }], [jar, tray]);
    expect(lintProgram(follow, place).join(" ")).toMatch(/this step is not a gesture/);
  });

  it("asks nothing about a gesture: its path is its only check", () => {
    const s = spec([gesture()]);
    expect(askable(s, "steps[s1].success")).toBe(false);
    expect(askable(s, "steps[s1].tolerances.x_mm")).toBe(false);
    expect(withRequiredAsks(s, follow)).toEqual({ program: follow, added: [] });
  });
});

describe("fitToBench with gestures", () => {
  it("keeps the gesture steps that have a path, renumbered, and no objects", () => {
    const labelled = spec(
      [gesture({ id: "a" }), gesture({ id: "b", t_start_s: 2, t_end_s: 3, gesture: { path: [] } }), { id: "c", verb: "reach", object: "jar", t_start_s: 3, t_end_s: 4 }],
      [jar],
    );
    const fit = fitToBench(labelled);
    expect(fit.spec.objects).toEqual([]);
    expect(fit.spec.steps.map((s) => [s.id, s.verb, s.gesture?.path.length])).toEqual([["s1", "gesture", 20]]);
    expect(fit.spec.steps[0].object).toBeUndefined();
    const named = fitToBench(spec([gesture({ object: "jar" })], [jar]));
    expect(named.spec.steps[0].object).toBeUndefined();
    expect(named.spec.objects).toEqual([]);
    expect(fit.warnings.join("\n")).toMatch(/step a: the right hand's path, 20 points over 1.9 s, 119 mm across and 0 mm high in front of the arm/);
    expect(fit.warnings.join("\n")).toMatch(/step b: no hand path was traced from the clip; left out/);
    expect(fit.warnings.join("\n")).toMatch(/left out of the rehearsal: jar \(a gesture handles nothing\)/);
    expect(validateSpec(fit.spec).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("says there is nothing to rehearse when no gesture has a path", () => {
    const fit = fitToBench(spec([gesture({ gesture: { path: [] } })]));
    expect(fit.warnings.at(-1)).toBe("no gesture with a hand path: nothing to rehearse");
  });

  it("prefers a manipulation when the clip has one", () => {
    const both = spec(
      [gesture(), { id: "s2", verb: "place", object: "jar", target: { fixture: "zone", frame: "tray" }, t_start_s: 2, t_end_s: 3 }],
      [jar, tray],
    );
    expect(fitToBench(both).spec.steps.map((s) => s.verb)).toEqual(["grasp", "place"]);
  });
});
