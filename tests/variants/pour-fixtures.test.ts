/**
 * The pour's recordings (#125, #134): its compile replays with no key and
 * passes on Earth, so does one of its variants, and none of Super's recorded
 * pour summaries says the arm carries, lifts or moves the container it
 * holds: in a pour the arm tilts it where it stands.
 */
import { beforeAll, describe, expect, it } from "vitest";
import compiles from "@/tests/fixtures/compile.json";
import variants from "@/tests/fixtures/variants.json";
import { POST } from "@/app/api/compile/route";
import { loadEngine, rollout, type Engine } from "@/lib/showcase/rehearse";
import { POUR_SPEC } from "@/lib/sim/demo-spec";
import { Program, TaskSpec } from "@/lib/spec/schema";
import type { StageResult } from "@/lib/spec/stage-result";
import { pourOf } from "@/lib/variants/pour";

let engine: Engine;
beforeAll(async () => {
  engine = await loadEngine();
}, 60_000);

/** POST /api/compile with no key in the environment: the route answers from tests/fixtures/compile.json. */
async function compileWithoutKey(spec: TaskSpec): Promise<StageResult<Program>> {
  const key = process.env.NEBIUS_API_KEY;
  delete process.env.NEBIUS_API_KEY;
  try {
    const res = await POST(new Request("http://test/api/compile", { method: "POST", body: JSON.stringify({ spec }) }));
    return res.json();
  } finally {
    if (key !== undefined) process.env.NEBIUS_API_KEY = key;
  }
}

const recorded = (compiles as { spec: unknown; result: StageResult<unknown> }[]).map((r) => ({ spec: TaskSpec.parse(r.spec), result: r.result }));

describe("the pour's recorded compile", () => {
  it("answers POUR_SPEC with no key, and the program passes on Earth", async () => {
    const own = recorded.find((r) => JSON.stringify(r.spec) === JSON.stringify(POUR_SPEC));
    expect(own?.result.status, "tests/fixtures/compile.json has no recording of POUR_SPEC").toBe("done");
    const res = await compileWithoutKey(POUR_SPEC);
    expect(res.status).toBe("done");
    if (res.status !== "done") return;
    expect(res.warnings.some((w) => w.includes("earlier version"))).toBe(false);
    expect(Program.parse(res.value).steps.flatMap((s) => s.ops).some((op) => op.op === "tilt")).toBe(true);
    const earth = rollout(engine, POUR_SPEC, res.value, "earth");
    expect(earth.pass, earth.log.join("\n")).toBe(true);
  }, 60_000);

  it("answers the variant recorded for \"pour it into a bigger bowl\" with no key, and it passes on Earth", async () => {
    // the request's one variant, compiled after the suggestions: the last compile of its title
    const reply = (variants as { spec_title: string; request: string | null; result: StageResult<{ variants: { title: string }[] }> }[]).find(
      (r) => r.spec_title === POUR_SPEC.title && r.request === "pour it into a bigger bowl",
    )?.result;
    expect(reply?.status).toBe("done");
    const title = reply?.status === "done" ? `${POUR_SPEC.title}: ${reply.value.variants[0].title}` : "";
    const variant = recorded.findLast((r) => r.spec.title === title)?.spec;
    expect(variant && pourOf(variant), `no recorded compile of "${title}"`).toBeTruthy();
    if (!variant) return;
    const res = await compileWithoutKey(variant);
    expect(res.status).toBe("done");
    if (res.status !== "done") return;
    expect(res.warnings.some((w) => w.includes("earlier version"))).toBe(false);
    const earth = rollout(engine, variant, res.value, "earth");
    expect(earth.pass, earth.log.join("\n")).toBe(true);
  }, 60_000);
});

describe("Super's recorded pour summaries", () => {
  type Idea = { title: string; summary: string; changes: { path: string; value: unknown }[] };
  const base = pourOf(POUR_SPEC)!;
  /** The container the arm holds in this variant: the base's, or its pour.into once the variant pours back. */
  const heldBy = (v: Pick<Idea, "changes">) => {
    const back = v.changes.find((c) => c.path === `steps[${base.id}].object`)?.value;
    return typeof back === "string" ? back : base.object;
  };
  const MOVES = String.raw`carr(?:y|ies|ied|ying)|lift(?:s|ed|ing)?|pick(?:s|ed|ing)?|mov(?:e|es|ed|ing)|bring(?:s|ing)?|brought`;
  const MOVED = String.raw`carried|lifted|picked|moved|brought`;
  const NOT = String.raw`(?<!\b(?:without|never|not|no)\s)`;
  /** Says the arm carries, lifts, picks up or moves the held container (or "it"), actively or passively, unless negated. */
  const carries = (v: Idea) => {
    const held = heldBy(v);
    const active = new RegExp(String.raw`${NOT}\b(?:${MOVES})\b(?:\s+\w+){0,2}?\s+(?:the\s+)?(?:${held}|it)\b`, "i");
    const passive = new RegExp(String.raw`\b${held}\b(?:\s+\w+){0,2}?\s+(?:is|gets|being)\s+(?:${MOVED})\b`, "i");
    const text = `${v.title}. ${v.summary}`;
    return active.test(text) || passive.test(text);
  };
  const ideas = (variants as { spec_title: string; result: StageResult<{ variants: Idea[] }> }[])
    .filter((r) => r.spec_title === POUR_SPEC.title)
    .flatMap((r) => (r.result.status === "done" ? r.result.value.variants : []));

  it("has the pour's suggestions on record", () => {
    expect(ideas.length).toBeGreaterThanOrEqual(5);
  });

  it("the scan catches the summaries #134 found, and lets the target move", () => {
    const say = (summary: string, changes: Idea["changes"] = []) => carries({ title: "t", summary, changes });
    const back = [{ path: `steps[${base.id}].object`, value: base.pour.into }];
    expect(say("The bowl sits further right so the arm carries the cup farther to pour.")).toBe(true);
    expect(say("The cup starts higher above the block so the arm picks it up from a greater height before pouring.")).toBe(true);
    expect(say("The cup is moved farther before pouring.")).toBe(true);
    expect(say("The arm moves the bowl closer before pouring back.", back)).toBe(true);
    expect(say("The bowl stands 30 mm higher on a shelf, closer to the cup's rim.")).toBe(false);
    expect(say("The bowl is lifted onto a shelf.")).toBe(false);
    expect(say("The arm tilts the cup without lifting it.")).toBe(false);
    expect(say("The water starts in the bowl and the arm pours it back into the cup.", back)).toBe(false);
  });

  it("never says the arm carries, lifts or moves the container it holds", () => {
    expect(ideas.filter(carries).map((v) => v.summary)).toEqual([]);
  });
});
