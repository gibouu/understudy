import { describe, expect, it } from "vitest";
import { beyondOneArm, LINE_MAX, oneArmLine, scopeNotes, sentenceOf } from "@/lib/spec/confirm";
import { TaskSpec } from "@/lib/spec/schema";

describe("the question after the label (#158)", () => {
  it("asks about the summary, or the title when the summary is empty", () => {
    expect(sentenceOf({ title: "t", summary: "  A person tosses a ball.  " })).toBe("A person tosses a ball.");
    expect(sentenceOf({ title: "Tossing a ball", summary: " " })).toBe("Tossing a ball");
  });

  it("says nothing when one arm fits, or when the label does not say", () => {
    expect(scopeNotes({})).toEqual([]);
    expect(scopeNotes({ hands: 1, on_body: false })).toEqual([]);
    expect(beyondOneArm({ hands: 1 })).toBe(false);
  });

  it("says plainly when two hands work together, or when it is done on the body", () => {
    const two = scopeNotes({ hands: 2 });
    expect(two[0]).toMatch(/one arm/);
    expect(two.at(-1)).toMatch(/no throw, no catch and no contact with a person/);
    const body = scopeNotes({ on_body: true });
    expect(body[0]).toMatch(/own body/);
    expect(scopeNotes({ hands: 2, on_body: true })).toHaveLength(3);
  });

  it("offers the one-arm line only when the task does not fit one arm", () => {
    expect(oneArmLine({ hands: 2, one_arm: " toss it up and catch it in the same hand " })).toBe("toss it up and catch it in the same hand");
    expect(oneArmLine({ on_body: true, one_arm: "apply it gently to another person's hand" })).toBe("apply it gently to another person's hand");
    expect(oneArmLine({ hands: 1, one_arm: "toss it up" })).toBeUndefined();
    expect(oneArmLine({ hands: 2, one_arm: "  " })).toBeUndefined();
    expect(oneArmLine({ hands: 2, one_arm: "x".repeat(300) })).toHaveLength(LINE_MAX);
  });

  it("keeps hands, on_body and one_arm in a parsed spec, and parses a spec without them", () => {
    const base = { version: 1, title: "t", summary: "s", objects: [], steps: [] };
    expect(TaskSpec.parse({ ...base, hands: 2, on_body: false, one_arm: "toss it up" })).toMatchObject({ hands: 2, on_body: false, one_arm: "toss it up" });
    expect(TaskSpec.parse(base).hands).toBeUndefined();
    expect(TaskSpec.safeParse({ ...base, hands: 3 }).success).toBe(false);
  });
});
