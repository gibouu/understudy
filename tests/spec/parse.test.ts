import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson, ModelOutputError, parseModelJson } from "@/lib/spec/parse";
import { InterviewTurn, Program, TaskSpec } from "@/lib/spec/schema";

describe("extractJson", () => {
  it("strips think blocks and code fences", () => {
    const text = '<think>let me reason</think>\nHere you go:\n```json\n{"a": 1, "b": "x}"}\n```';
    expect(extractJson(text)).toBe('{"a": 1, "b": "x}"}');
  });
  it("returns null when there is no JSON", () => {
    expect(extractJson("no json here")).toBeNull();
  });
  it("drops an unterminated think block", () => {
    expect(extractJson('<think>still thinking {"a":1}')).toBeNull();
  });
});

describe("parseModelJson", () => {
  it("applies schema defaults", () => {
    const { value } = parseModelJson('{"question":"How tight is the rack?"}', InterviewTurn);
    expect(value.chips).toEqual([]);
    expect(value.done).toBe(false);
  });
  it("throws a ModelOutputError with the path on a schema miss", () => {
    expect(() => parseModelJson('{"question": 3}', InterviewTurn)).toThrow(ModelOutputError);
    expect(() => parseModelJson('{"question": 3}', InterviewTurn)).toThrow(/question/);
  });
  it("accepts a minimal task spec", () => {
    const spec = {
      version: 1,
      title: "marker into rack",
      summary: "pick a marker from the tray and insert it in the rack",
      objects: [
        { id: "marker", name: "marker", shape: "cylinder", size_mm: [15, 15, 140], symmetry: "axial", role: "manipulated", source: "vl#seg1" },
        { id: "rack", name: "rack", shape: "box", size_mm: [120, 80, 40], symmetry: "none", role: "fixture", pocket_clearance_mm: 3, source: "vl#seg1" },
      ],
      steps: [
        { id: "s1", verb: "grasp", object: "marker", t_start_s: 0.8, t_end_s: 1.6, source: "vl#seg1" },
        { id: "s2", verb: "insert", object: "marker", target: { fixture: "pocket", frame: "rack" }, t_start_s: 1.6, t_end_s: 3.1, source: "vl#seg2", tolerances: { x_mm: 2 } },
      ],
    };
    const { value } = parseModelJson(JSON.stringify(spec), TaskSpec);
    expect(value.steps[1].tolerances.x_mm).toBe(2);
    expect(value.steps[0].via_points).toEqual([]);
    expect(value.objects[0].confidence).toBe(0.5);
  });
  it("rejects a predicate outside the closed enum", () => {
    const program = {
      spec_title: "x",
      steps: [{ step_id: "s1", ops: [{ op: "assert", predicate: { kind: "levitates" } }] }],
    };
    expect(() => parseModelJson(JSON.stringify(program), Program)).toThrow(/kind/);
  });
  it("accepts a program with an ask slot", () => {
    const program = {
      spec_title: "x",
      steps: [
        {
          step_id: "s2",
          ops: [
            { op: "move_to", frame: "rack", offset_mm: [0, 0, 60] },
            { op: "ask", slot: "steps[1].tolerances.x_mm", question: "How much can the rack move before insertion fails?", why: "no clearance measured" },
          ],
        },
      ],
    };
    const { value } = parseModelJson(JSON.stringify(program), Program);
    const first = value.steps[0].ops[0];
    expect(first.op === "move_to" && first.approach).toBe("top");
  });
  it("works with a plain zod schema too", () => {
    expect(parseModelJson("[1,2,3]", z.array(z.number())).value).toEqual([1, 2, 3]);
  });
});
