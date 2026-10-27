/**
 * #155: the program that waits for where a place goes has no moves, so it is never what a recompile
 * falls back on. Token Factory is faked and answers nothing usable: before the fix the route kept the
 * waiting program, its answered ask dropped, and the page rehearsed an empty program as a pass.
 */
import { describe, expect, it, vi } from "vitest";
import { fitToBench } from "@/lib/sim/fit";
import { applyChanges } from "@/lib/spec/apply";
import { waitingProgram } from "@/lib/spec/answer";
import { TaskSpec } from "@/lib/spec/schema";

vi.mock("@/lib/providers/tokenfactory", async (original) => {
  const tf = await original<typeof import("@/lib/providers/tokenfactory")>();
  return {
    ...tf,
    wantsReplay: () => false,
    tokenFactory: () => ({
      models: { list: async () => ({ data: Object.values(tf.MODELS).map((id) => ({ id })) }) },
      chat: { completions: { create: async () => ({ choices: [{ message: { content: "not a program" } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }) } },
    }),
  };
});

const label = TaskSpec.parse({
  version: 1,
  title: "bag somewhere",
  summary: "",
  objects: [
    { id: "bag", name: "drink bag", shape: "box", size_mm: [80, 20, 120], symmetry: "none", role: "manipulated" },
    { id: "foam", name: "foam block", shape: "box", size_mm: [100, 100, 60], symmetry: "none", role: "fixture" },
  ],
  steps: [
    { id: "s1", verb: "grasp", object: "bag", t_start_s: 0, t_end_s: 1 },
    { id: "s2", verb: "move", object: "bag", t_start_s: 1, t_end_s: 2 },
  ],
});

describe("a recompile after where it goes", () => {
  it("fails rather than keep the waiting program when the model answers nothing usable", async () => {
    const { POST } = await import("@/app/api/compile/route");
    const pending = fitToBench(label);
    const waiting = waitingProgram(pending.spec)!;
    const answered = fitToBench(applyChanges(pending.spec, [{ path: pending.where!, value: { fixture: "zone", frame: "foam" }, source: "interview#1" }]).spec).spec;
    const res = await POST(new Request("http://localhost/api/compile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spec: answered, previous: waiting }) }));
    const r = await res.json();
    expect(r.status).toBe("failed");
  });
});
