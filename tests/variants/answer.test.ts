/**
 * A question a variant's own program asks, answered on its card (#110): the
 * answer goes into that variant's spec as an interview answer, shows among its
 * edits, and the replayed compile of the answered spec asks it no more.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/variants/route";
import { DEFAULT_ANSWERS, answerFor } from "@/lib/showcase/answers";
import { answerChange, asksOf } from "@/lib/spec/answer";
import { valueAt } from "@/lib/spec/apply";
import type { Program, TaskSpec } from "@/lib/spec/schema";
import type { StageResult } from "@/lib/spec/stage-result";
import { answered, nextTurn } from "@/lib/variants/answer";
import type { Checked, Variant } from "@/lib/variants/validate";
import { issBase, loadSim, postCompile, rollout } from "./harness";

let base: { spec: TaskSpec; program: Program };
let asking: { variant: Variant; program: Program };

beforeAll(async () => {
  await loadSim();
  base = await issBase();
  const res = await POST(new Request("http://test/api/variants?replay=1", { method: "POST", body: JSON.stringify({ spec: base.spec }) }));
  const r = (await res.json()) as StageResult<Checked>;
  if (r.status !== "done") throw new Error("no replayed suggestions");
  for (const v of r.value.variants) {
    const c = await postCompile(v.spec, base.program);
    if (c.status === "done" && asksOf(c.value).length) asking = { variant: v, program: c.value };
  }
  if (!asking) throw new Error("no recorded variant compile asks a question");
}, 60_000);

describe("answering a variant's own question", () => {
  it("numbers the answer as the next interview turn of the variant's spec", () => {
    expect(nextTurn(base.spec)).toBe(2);
    expect(nextTurn({ ...base.spec, objects: [], steps: [] })).toBe(1);
  });

  it("turns what the person gave into a change, and nothing given into none", () => {
    const [ask] = asksOf(asking.program);
    expect(answerChange(asking.variant.spec, ask.slot, "", "interview#2")).toBeNull();
    expect(answerChange(asking.variant.spec, ask.slot, undefined, "interview#2")).toBeNull();
    expect(answerChange(asking.variant.spec, ask.slot, "abc", "interview#2")).toBeNull();
    expect(answerChange(base.spec, "steps[s2].success", "9", "interview#2")).toBeNull();
  });

  it("applies it to that variant's spec with interview provenance, and lists it among the variant's edits", () => {
    const asks = asksOf(asking.program);
    const raw = Object.fromEntries(asks.map((a) => [a.slot, "4"]));
    const r = answered(base.spec, asking.variant, asks, raw);
    if (!r || "why" in r) throw new Error(r ? r.why : "nothing answered");
    for (const a of asks) expect(valueAt(r.variant.spec, a.slot)).toBe(4);
    const step = r.variant.spec.steps.find((s) => asks.some((a) => a.slot.startsWith(`steps[${s.id}]`)));
    expect(Object.values(step?.sources ?? {})).toContain("interview#2");
    expect(r.changes.every((c) => c.source === "interview#2")).toBe(true);
    // the variant's own edits stay, and the answered field joins them
    for (const e of asking.variant.edits) expect(r.variant.edits.map((x) => x.path)).toContain(e.path);
    expect(r.variant.edits.some((e) => asks.some((a) => a.slot.startsWith(e.path)))).toBe(true);
    // the task above is left as it was
    for (const a of asks) expect(valueAt(asking.variant.spec, a.slot)).toBeUndefined();
    expect(answered(base.spec, asking.variant, asks, {})).toBeNull();
  });

  it("replays a compile of the answered spec that asks no more and rehearses", async () => {
    const asks = asksOf(asking.program);
    // as tests/variants/record.test.ts answers it: the recorder's defaults
    const changes = asks.flatMap((a) => answerFor(asking.variant.spec, a.slot, nextTurn(asking.variant.spec), DEFAULT_ANSWERS)?.change ?? []);
    const raw = Object.fromEntries(changes.map((c) => [c.path, String(c.value)]));
    const r = answered(base.spec, asking.variant, asks, raw);
    if (!r || "why" in r) throw new Error(r ? r.why : "nothing answered");
    const c = await postCompile(r.variant.spec, asking.program);
    expect(c.status).toBe("done");
    if (c.status !== "done") return;
    expect(c.warnings.join(" ")).not.toMatch(/earlier version/);
    expect(asksOf(c.value)).toEqual([]);
    const earth = rollout(r.variant.spec, c.value, 1);
    expect(earth.why ?? "").not.toMatch(/unanswered/);
  });
});
