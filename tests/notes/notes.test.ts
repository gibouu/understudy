import { beforeAll, describe, expect, it } from "vitest";
import recordings from "@/tests/fixtures/notes.json";
import { applyPatch, knobsOf } from "@/lib/notes/knobs";
import { failureNote, outcomeLine } from "@/lib/notes/note";
import { escalation, MAX_PATCHES, patchPrompt, type Attempt } from "@/lib/notes/patch";
import { Program, TaskSpec } from "@/lib/spec/schema";
import { issSample, loadSim, patchLoop, rehearse } from "./harness";

let spec: TaskSpec;
let program: Program;

beforeAll(async () => {
  await loadSim();
  ({ spec, program } = await issSample());
}, 60_000);

const S2 = new Set(["s2"]);

describe("the knobs", () => {
  it("are the numbers of the failing step, bounded by the surface a held object rests on", () => {
    const knobs = knobsOf(spec, program, S2);
    expect(knobs.map((k) => k.name)).toEqual(["s2.op0.x_mm", "s2.op0.y_mm", "s2.op0.z_mm", "s2.op1.x_mm", "s2.op1.y_mm", "s2.op1.z_mm", "s2.op3.timeout_s"]);
    // the pillow is 30 mm high with an 8 mm floor, the packet 40 mm: its centre stops 13 mm above the pillow's centre
    expect(knobs.find((k) => k.name === "s2.op1.z_mm")).toMatchObject({ value: 36, min: 13, max: 300 });
    expect(knobs[0].meaning).toMatch(/a carry, \d+ mm sideways/);
    expect(knobs[3].meaning).toContain("straight down 19 mm");
    expect(knobs[3].meaning).toContain("its bottom 23.0 mm above obj2's pocket floor (1.0 mm above its rim)");
  });

  it("apply clamped, report what was clamped or rejected, and leave everything else alone", () => {
    const a = applyPatch(spec, program, { "s2.op1_z_mm": 5, "s2.op3.timeout_s": "4", "s1.op2.aperture_mm": 20, bogus: 1, "s2.op0.x_mm": "far" }, S2);
    expect(a.set).toEqual({ "s2.op1.z_mm": 13, "s2.op3.timeout_s": 4 });
    expect(a.clamps).toEqual([{ name: "s2.op1.z_mm", requested: 5, applied: 13 }]);
    expect(a.rejected.sort()).toEqual(["bogus", "s1.op2.aperture_mm", "s2.op0.x_mm"]);
    expect(a.noop).toBe(false);
    expect(a.program.steps[0]).toEqual(program.steps[0]);
    expect(a.program.steps[1].ops[1]).toMatchObject({ op: "move_to", offset_mm: [0, 0, 13] });
    expect(program.steps[1].ops[1]).toMatchObject({ offset_mm: [0, 0, 36] }); // the input is not mutated
  });

  it("leave out the aperture, which the interpreter does not read", () => {
    expect(knobsOf(spec, program).some((k) => k.name.endsWith("aperture_mm"))).toBe(false);
  });

  it("keep a held object above the table in the world frame, and use the pocket when a later step inserts", () => {
    const small = TaskSpec.parse({
      version: 1,
      title: "t",
      summary: "",
      objects: [
        { id: "a", name: "a", shape: "box", size_mm: [10, 10, 40], symmetry: "none", role: "manipulated", pose: { xyz_mm: [200, -100, 20] } },
        { id: "b", name: "b", shape: "box", size_mm: [100, 100, 30], symmetry: "none", role: "fixture", pocket_clearance_mm: 5, pose: { xyz_mm: [175, 100, 15] } },
      ],
      steps: [
        { id: "s1", verb: "place", object: "a", target: { fixture: "zone", frame: "b" }, t_start_s: 0, t_end_s: 1 },
        { id: "s-1", verb: "insert", object: "a", target: { fixture: "pocket", frame: "b" }, t_start_s: 1, t_end_s: 2 },
      ],
    });
    const prog = Program.parse({
      spec_title: "t",
      steps: [
        { step_id: "s1", ops: [{ op: "grasp", object: "a", aperture_mm: 10 }, { op: "move_to", frame: "world", offset_mm: [200, 0, 60] }] },
        { step_id: "s-1", ops: [{ op: "move_to", frame: "b", offset_mm: [0, 0, 60] }, { op: "move_to", frame: "b", offset_mm: [0, 0, 40] }] },
      ],
    });
    const k = new Map(knobsOf(small, prog).map((x) => [x.name, x]));
    expect(k.get("s1.op1.z_mm")?.min).toBe(20); // half the held 40 mm object above the table
    expect(k.get("s-1.op1.z_mm")?.min).toBe(13); // the pocket floor (-15 + 8) plus 20, not the zone's top
    // s-1 and s1 share a loose spelling: exact names patch their own step, the loose one patches nothing
    expect(applyPatch(small, prog, { "s-1.op1.z_mm": 30 }).set).toEqual({ "s-1.op1.z_mm": 30 });
    expect(applyPatch(small, prog, { "s1.op1.z_mm": 70 }).set).toEqual({ "s1.op1.z_mm": 70 });
    expect(applyPatch(small, prog, { s1op1zmm: 30 }).rejected).toEqual(["s1op1zmm"]);
    expect(applyPatch(small, prog, { "s-1.op0_z_mm": 70 }).set).toEqual({ "s-1.op0.z_mm": 70 });
    // with only s1 editable, a knob of s-1 is refused rather than read as s1's
    expect(applyPatch(small, prog, { "s-1.op1.z_mm": 30 }, new Set(["s1"]))).toMatchObject({ set: {}, rejected: ["s-1.op1.z_mm"], noop: true });
    expect(applyPatch(small, prog, { s1op1zmm: 30 }, new Set(["s1"])).rejected).toEqual(["s1op1zmm"]);
  });

  it("call a patch that changes no value a no-op", () => {
    expect(applyPatch(spec, program, { "s2.op1.z_mm": 36, "s2.op0.x_mm": 0 }, S2).noop).toBe(true);
    expect(applyPatch(spec, program, {}, S2).noop).toBe(true);
    expect(applyPatch(spec, program, { nothing: 1 }, S2)).toMatchObject({ noop: true, rejected: ["nothing"] });
  });
});

describe("escalation", () => {
  const a = (thinking: boolean): Attempt => ({ set: {}, thinking, clamps: [], rejected: [], outcome: "" });
  it("thinks only once the cheap patcher is stuck, and stays escalated", () => {
    expect(escalation([])).toBeNull();
    expect(escalation([a(false)])).toBeNull();
    expect(escalation([a(false), a(false)])).toBe("two_failed");
    expect(escalation([a(true)])).toBe("noop");
    expect(escalation([a(false), a(true), a(true)])).toBe("noop");
    expect(escalation([a(false), a(false), a(true), a(true)])).toBe("two_failed");
  });
});

describe("the failure note", () => {
  it("states what was measured in each world, never a knob or a value to set", () => {
    const runs = rehearse(spec, program);
    expect(runs.map((r) => r.rollout.pass)).toEqual([true, false]);
    const note = failureNote(spec, program, runs);
    expect(note).toMatch(/^earth \(1 g\): PASS/m);
    expect(note).toMatch(/^orbit \(0 g\): FAIL .* at s2 op 3 \(wait_until object_still obj1/m);
    expect(note).toMatch(/Let go at [\d.]+ s with obj1's centre at \([^)]+\) mm from obj2's centre, its bottom 2\d\.\d mm above obj2's pocket floor/);
    expect(note).toContain("not seated");
    expect(note).not.toMatch(/\bs\d+\.op\d+\./);
    expect(note).not.toMatch(/\b(set|should|try|lower|raise)\b/i);
    const prompt = patchPrompt(spec, program, knobsOf(spec, program, S2), outcomeLine(runs), [], note);
    expect(prompt).toContain("Return patch 1 of at most 5.");
    expect(prompt).toContain("its floor at z = -7 mm and its rim at z = 15 mm");
  }, 60_000);
});

describe("the recorded patch loop (replay, no key)", () => {
  it("patches the orbit failure to a pass at both gravities within five patches", async () => {
    expect((recordings as unknown[]).length).toBeGreaterThan(0);
    const { rounds, final, program: patched } = await patchLoop(spec, program, "http://test/api/notes?replay=1");
    expect(rounds.length).toBeLessThanOrEqual(MAX_PATCHES);
    expect(rounds.every((r) => r.result.status === "done")).toBe(true);
    expect(final.map((r) => [r.world, r.rollout.pass])).toEqual([
      ["earth", true],
      ["orbit", true],
    ]);
    // held until seated: let go on the pocket floor, not at its mouth
    expect(patched.steps[1].ops[1]).toMatchObject({ op: "move_to", frame: "obj2", offset_mm: [0, 0, 13] });
  }, 120_000);
});
