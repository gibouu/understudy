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

  it("answers a pour variant from the re-recorded suggestions, and it passes on Earth", async () => {
    const variant = recorded.find((r) => r.spec.title.startsWith(`${POUR_SPEC.title}: `) && r.result.status === "done")?.spec;
    expect(variant && pourOf(variant)).toBeTruthy();
    const res = await compileWithoutKey(variant!);
    expect(res.status).toBe("done");
    if (res.status !== "done") return;
    expect(res.warnings.some((w) => w.includes("earlier version"))).toBe(false);
    const earth = rollout(engine, variant!, res.value, "earth");
    expect(earth.pass, earth.log.join("\n")).toBe(true);
  }, 60_000);
});

describe("Super's recorded pour summaries", () => {
  // the held container is moved only by the arm carrying, lifting or picking it up; its target may move, shift or rise
  const held = pourOf(POUR_SPEC)!.object;
  const CARRIES = new RegExp(`\\b(carr(y|ies|ied|ying)|lift(s|ed|ing)?|pick(s|ed|ing)?\\b[^.]*\\bup|(mov(e|es|ed|ing)|bring(s|ing)?|brought) (the )?${held})\\b`, "i");
  const ideas = (variants as { spec_title: string; result: StageResult<{ variants: { title: string; summary: string }[] }> }[])
    .filter((r) => r.spec_title === POUR_SPEC.title)
    .flatMap((r) => (r.result.status === "done" ? r.result.value.variants : []));

  it("has the pour's suggestions on record", () => {
    expect(ideas.length).toBeGreaterThanOrEqual(5);
  });

  it("the scan catches the summaries #134 found", () => {
    expect(CARRIES.test("The bowl sits further right so the arm carries the cup farther to pour.")).toBe(true);
    expect(CARRIES.test("The cup starts higher above the block so the arm picks it up from a greater height before pouring.")).toBe(true);
    expect(CARRIES.test("The bowl stands 30 mm higher on a shelf, closer to the cup's rim.")).toBe(false);
  });

  it("never says the arm carries, lifts or moves the container it holds", () => {
    expect(ideas.filter((v) => CARRIES.test(`${v.title} ${v.summary}`)).map((v) => v.summary)).toEqual([]);
  });
});
