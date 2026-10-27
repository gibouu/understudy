import { describe, expect, it } from "vitest";
import { tidyLabel } from "@/lib/spec/label";

const raw = (steps: { id: string; t_start_s: number; t_end_s: number }[], size_mm = [40, 40, 80]) => ({
  title: "t",
  summary: "",
  objects: [{ id: "a", name: "jar", shape: "cylinder", size_mm, role: "manipulated" }],
  steps: steps.map((s) => ({ ...s, verb: "move", object: "a" })),
  anchor: { t_s: 99, confidence: 1 },
});
const times = (d: unknown) => (d as { steps: { id: string; t_start_s: number; t_end_s: number }[] }).steps.map((s) => [s.id, s.t_start_s, s.t_end_s]);

describe("tidyLabel", () => {
  it("clamps times and the anchor to the clip", () => {
    const { data, warnings } = tidyLabel(raw([{ id: "s1", t_start_s: -1, t_end_s: 40 }]), 36);
    expect(times(data)).toEqual([["s1", 0, 36]]);
    expect((data as { anchor: { t_s: number } }).anchor.t_s).toBe(36);
    expect(warnings.some((w) => w.includes("clamped"))).toBe(true);
  });

  it("sorts steps and starts each where the previous one ended", () => {
    const { data } = tidyLabel(
      raw([
        { id: "s2", t_start_s: 8, t_end_s: 12 },
        { id: "s1", t_start_s: 0, t_end_s: 10 },
        { id: "s3", t_start_s: 9, t_end_s: 11 },
      ]),
      36,
    );
    expect(times(data)).toEqual([
      ["s1", 0, 10],
      ["s2", 10, 12],
      ["s3", 12, 12],
    ]);
  });

  it("flags a size outside 5 to 300 mm as a warning and an open question", () => {
    const { data, warnings } = tidyLabel(raw([], [400, 300, 2]), 36);
    expect(warnings).toContain("object a: size_mm [400, 300, 2] is outside 5 to 300 mm");
    expect((data as { open_questions: string[] }).open_questions[0]).toMatch(/^objects\[a\]\.size_mm/);
  });

  it("keeps what fits one arm when it is well formed, and drops it rather than re-ask when it is not (#158)", () => {
    const kept = tidyLabel({ ...raw([]), hands: "2", on_body: true, one_arm: "  toss it up and catch it  " }, 36);
    expect(kept.data).toMatchObject({ hands: 2, on_body: true, one_arm: "toss it up and catch it" });
    const dropped = tidyLabel({ ...raw([]), hands: 3, on_body: "yes", one_arm: "" }, 36);
    expect(dropped.data).not.toHaveProperty("hands");
    expect(dropped.data).not.toHaveProperty("on_body");
    expect(dropped.data).not.toHaveProperty("one_arm");
    expect(dropped.warnings).toEqual(expect.arrayContaining(["hands 3 is not 1 or 2; left out", 'on_body "yes" is not true or false; left out']));
  });
});
