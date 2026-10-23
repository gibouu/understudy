import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson, jsonCandidates, ModelOutputError, parseModelJson, stripLeadingThink } from "@/lib/spec/parse";
import { normalizeProgram, normalizeSpec } from "@/lib/spec/normalize";
import { Envelope, InterviewTurn, Program, TaskSpec } from "@/lib/spec/schema";

const minimalSpec = {
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

describe("stripLeadingThink", () => {
  it("removes leading reasoning blocks", () => {
    expect(stripLeadingThink('<think>a</think>\n<think>b</think>\n{"x":1}')).toBe('{"x":1}');
  });
  it("drops everything after an unterminated leading block", () => {
    expect(stripLeadingThink('<think>still thinking {"a":1}')).toBe("");
  });
  it("leaves reasoning tags inside the body alone", () => {
    const body = '{"question":"What does <think>foo</think> mean?"}';
    expect(stripLeadingThink(body)).toBe(body);
  });
});

describe("extractJson and candidates", () => {
  it("strips think blocks and code fences", () => {
    const text = '<think>let me reason</think>\nHere you go:\n```json\n{"a": 1, "b": "x}"}\n```';
    expect(extractJson(text)).toBe('{"a": 1, "b": "x}"}');
  });
  it("returns null when there is no JSON", () => {
    expect(extractJson("no json here")).toBeNull();
  });
  it("skips prose braces before the answer", () => {
    expect(extractJson('Use {mm} for lengths.\n{"question":"q"}')).toBe('{"question":"q"}');
    expect(extractJson('[answer follows] {"question":"q"}')).toBe('{"question":"q"}');
  });
  it("keeps brackets, escapes and unicode inside strings", () => {
    const s = '{"a":"[{]}","b":"q\\"uote","c":"\\u007b"}';
    expect(JSON.parse(extractJson(s)!)).toEqual({ a: "[{]}", b: 'q"uote', c: "{" });
  });
  it("lists top-level candidates in order and ignores nested ones", () => {
    expect([...jsonCandidates('x {"a":[1]} y [2]')]).toEqual(['{"a":[1]}', "[2]"]);
  });
  it("offers nothing from inside an unfinished value", () => {
    expect([...jsonCandidates('{"draft":{"question":"DRAFT","done":true},"answer":')]).toEqual([]);
  });
  it("scans pathological input in linear time", () => {
    const t0 = performance.now();
    expect(extractJson("{".repeat(80_000))).toBeNull();
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("parseModelJson", () => {
  it("applies schema defaults", () => {
    const { value } = parseModelJson('{"question":"How tight is the rack?"}', InterviewTurn);
    expect(value.chips).toEqual([]);
    expect(value.done).toBe(false);
  });
  it("keeps think tags inside strings intact", () => {
    const { value } = parseModelJson('{"question":"What does <think>foo</think> mean?"}', InterviewTurn);
    expect(value.question).toBe("What does <think>foo</think> mean?");
    expect(parseModelJson('{"question":"What does <think> mean?"}', InterviewTurn).value.question).toBe("What does <think> mean?");
  });
  it("prefers the last valid candidate, so an example before the answer loses", () => {
    expect(parseModelJson('Example: {"question": 3}\nAnswer: {"question":"real"}', InterviewTurn).value.question).toBe("real");
    const v = parseModelJson('Example: {"question":"EXAMPLE","done":true}\nAnswer: {"question":"REAL"}', InterviewTurn).value;
    expect(v.question).toBe("REAL");
    expect(v.done).toBe(false);
  });
  it("refuses a truncated draft instead of answering from its inside", () => {
    expect(() => parseModelJson('{"draft":{"question":"DRAFT","done":true},"answer":', InterviewTurn)).toThrow(/no complete JSON/);
  });
  it("refuses oversized output", () => {
    expect(() => parseModelJson("x".repeat(2_000_001), InterviewTurn)).toThrow(/too long/);
  });
  it("throws a ModelOutputError with the path on a schema miss", () => {
    expect(() => parseModelJson('{"question": 3}', InterviewTurn)).toThrow(ModelOutputError);
    expect(() => parseModelJson('{"question": 3}', InterviewTurn)).toThrow(/question/);
  });
  it("accepts a minimal task spec", () => {
    const { value } = parseModelJson(JSON.stringify(minimalSpec), TaskSpec);
    expect(value.steps[1].tolerances.x_mm).toBe(2);
    expect(value.steps[0].via_points).toEqual([]);
    expect(value.objects[0].confidence).toBe(0.5);
    expect(value.objects[0].sources).toEqual({});
    expect(value.sources).toEqual({});
  });
  it("rejects a predicate outside the closed enum", () => {
    const program = { spec_title: "x", steps: [{ step_id: "s1", ops: [{ op: "assert", predicate: { kind: "levitates" } }] }] };
    expect(() => parseModelJson(JSON.stringify(program), Program)).toThrow(/kind/);
  });
  it("rejects predicates without their operands", () => {
    const program = { spec_title: "x", steps: [{ step_id: "s1", ops: [{ op: "assert", predicate: { kind: "height_above" } }] }] };
    expect(() => parseModelJson(JSON.stringify(program), Program)).toThrow(/needs an object|needs a value/);
  });
  it("rejects physical nonsense", () => {
    const bad = structuredClone(minimalSpec) as typeof minimalSpec & { objects: { size_mm: number[] }[] };
    bad.objects[0].size_mm = [0, 15, 140];
    expect(() => parseModelJson(JSON.stringify(bad), TaskSpec)).toThrow(/size_mm/);
    const reversed = structuredClone(minimalSpec);
    reversed.steps[0].t_end_s = 0.1;
    expect(() => parseModelJson(JSON.stringify(reversed), TaskSpec)).toThrow(/t_end_s/);
  });
  it("rejects signed bands with the wrong signs", () => {
    const empty = { pass_neg: null, pass_pos: null, fail_neg: null, fail_pos: null };
    expect(Envelope.safeParse({ x_mm: { sensed: { pass_neg: -4, pass_pos: 6, fail_neg: null, fail_pos: 8 }, blind: empty } }).success).toBe(true);
    expect(Envelope.safeParse({ x_mm: { sensed: { pass_neg: 10, pass_pos: -10, fail_neg: 100, fail_pos: -100 }, blind: empty } }).success).toBe(false);
  });
  it("accepts a program with an ask slot", () => {
    const program = {
      spec_title: "x",
      steps: [{ step_id: "s2", ops: [{ op: "move_to", frame: "rack", offset_mm: [0, 0, 60] }, { op: "ask", slot: "steps[1].tolerances.x_mm", question: "How much can the rack move before insertion fails?", why: "no clearance measured" }] }],
    };
    const { value } = parseModelJson(JSON.stringify(program), Program);
    const first = value.steps[0].ops[0];
    expect(first.op === "move_to" && first.approach).toBe("top");
  });
  it("normalizes aliases and degrades unknown fixtures with warnings", () => {
    const raw = structuredClone(minimalSpec) as unknown as { steps: Record<string, unknown>[]; objects: Record<string, unknown>[] };
    raw.steps[1].target = { fixture: "ledge", frame: "rack" };
    raw.steps[1].success = [{ kind: "inserted", object: "marker", target: "rack" }, { kind: "glows", object: "marker" }];
    raw.objects[0].shape = "tube";
    const { value, warnings } = parseModelJson(JSON.stringify(raw), TaskSpec, { normalize: normalizeSpec });
    expect(value.steps[1].target?.fixture).toBe("zone");
    expect(value.steps[1].success.map((p) => p.kind)).toEqual(["inside_zone"]);
    expect(value.objects[0].shape).toBe("cylinder");
    expect(value.open_questions.length).toBe(1);
    expect(warnings.join("\n")).toMatch(/degraded to zone/);
    expect(warnings.join("\n")).toMatch(/glows/);
  });
  it("surfaces malformed checks and ambiguous spellings instead of dropping them silently", () => {
    const raw = structuredClone(minimalSpec) as unknown as { steps: Record<string, unknown>[] };
    raw.steps[0].success = [null, "avoid collisions", { kind: "contact", object: "marker", target: "table" }, { kind: "constructor", object: "marker" }];
    raw.steps[1].preconditions = "none";
    const { value, warnings } = parseModelJson(JSON.stringify(raw), TaskSpec, { normalize: normalizeSpec });
    expect(value.steps[0].success).toEqual([]);
    expect(value.steps[1].preconditions).toEqual([]);
    expect(value.open_questions).toHaveLength(5);
    expect(warnings.filter((w) => /dropped/.test(w))).toHaveLength(5);
    expect(warnings.join("\n")).not.toMatch(/read as/);
  });
  it("survives a normalizer that throws on one candidate", () => {
    const boom = (raw: unknown) => {
      if ((raw as { question?: string }).question === "bad") throw new Error("nope");
      return { data: raw, warnings: [] };
    };
    expect(parseModelJson('{"question":"ok"} {"question":"bad"}', InterviewTurn, { normalize: boom }).value.question).toBe("ok");
  });
  it("does not throw on malformed alias inputs", () => {
    const raw = structuredClone(minimalSpec) as unknown as { objects: Record<string, unknown>[] };
    raw.objects[0].shape = { toString: null };
    expect(() => normalizeSpec(raw)).not.toThrow();
  });
  it("turns an unknown program predicate into an ask", () => {
    const program = { spec_title: "x", steps: [{ step_id: "s1", ops: [{ op: "assert", predicate: { kind: "levitates", object: "marker" } }] }] };
    const { value, warnings } = parseModelJson(JSON.stringify(program), Program, { normalize: normalizeProgram });
    expect(value.steps[0].ops[0].op).toBe("ask");
    expect(warnings[0]).toMatch(/levitates/);
  });
  it("works with a plain zod schema too", () => {
    expect(parseModelJson("[1,2,3]", z.array(z.number())).value).toEqual([1, 2, 3]);
  });
});
