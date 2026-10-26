import { beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/variants/route";
import { loadEngine, rollout, type Engine } from "@/lib/showcase/rehearse";
import { POUR_PROGRAMS, POUR_SPEC } from "@/lib/sim/demo-spec";
import { valueAt } from "@/lib/spec/apply";
import type { Predicate, TaskSpec } from "@/lib/spec/schema";
import type { StageResult } from "@/lib/spec/stage-result";
import { VariantReply, type Idea } from "@/lib/variants/parse";
import { pourOf } from "@/lib/variants/pour";
import { benchFacts, userMessage } from "@/lib/variants/prompt";
import { buildVariant, physicalKey, replyProblems, type Checked } from "@/lib/variants/validate";
import { issBase, postCompile } from "./harness";

const idea = (title: string, ...changes: [string, unknown][]): Idea => ({ title, summary: "", changes: changes.map(([path, value]) => ({ path, value })) });
const build = (...changes: [string, unknown][]) => buildVariant(POUR_SPEC, idea("v", ...changes), 1);
const why = (r: ReturnType<typeof build>) => ("why" in r ? r.why : "");
const variant = (r: ReturnType<typeof build>) => {
  if ("why" in r) throw new Error(r.why);
  return r.variant;
};
const object = (s: TaskSpec, id: string) => s.objects.find((o) => o.id === id)!;
const share = (value: number, object = "cup", target = "bowl"): Predicate => ({ kind: "liquid_inside", object, target, value });

describe("a variant of a pour", () => {
  it("takes a bigger or smaller target, standing it with the same gap to the held container's rim", () => {
    // the demo bowl stands 22 mm from the cup's rim: 80 mm between centres, 24 + 34 mm of half widths
    const bigger = variant(build(["objects[bowl].size_mm", [100, 100, 40]]));
    expect(object(bigger.spec, "bowl").pose).toEqual({ xyz_mm: [300, 96, 20], yaw_deg: 0, frame: "world" });
    expect(bigger.edits.map((e) => e.path)).toEqual(["objects[bowl].size_mm", "objects[bowl].pose"]);
    expect(object(variant(build(["objects[bowl].size_mm", [50, 50, 40]])).spec, "bowl").pose!.xyz_mm).toEqual([300, 71, 20]);
    // a shorter or taller target still stands on the table
    expect(object(variant(build(["objects[bowl].size_mm", [68, 68, 20]])).spec, "bowl").pose!.xyz_mm).toEqual([300, 80, 10]);
    expect(object(variant(build(["objects[bowl].size_mm", [68, 68, 60]])).spec, "bowl").pose!.xyz_mm).toEqual([300, 80, 30]);
    // the held container is never moved by a change to the target
    expect(object(bigger.spec, "cup").pose).toEqual(object(POUR_SPEC, "cup").pose);
  });

  it("keeps a move the variant gives: the target higher on a shelf, or further off", () => {
    const shelf = { xyz_mm: [300, 80, 40], yaw_deg: 0, frame: "world" };
    expect(object(variant(build(["objects[bowl].pose", shelf])).spec, "bowl").pose).toEqual(shelf);
    const off = { xyz_mm: [300, 110, 20], yaw_deg: 0, frame: "world" };
    expect(object(variant(build(["objects[bowl].pose", off], ["objects[bowl].size_mm", [50, 50, 40]])).spec, "bowl").pose).toEqual(off);
  });

  it("pours it back: the liquid, which one is held, where each stands and the check all turn round", () => {
    for (const change of [
      ["steps[s1].object", "bowl"],
      ["steps[s1].pour.into", "cup"],
      ["steps[s1].pour", { into: "cup", tilt_deg: 120, tilt_s: 1.5 }],
    ] as [string, unknown][]) {
      const v = variant(build(change));
      const [cup, bowl] = [object(v.spec, "cup"), object(v.spec, "bowl")];
      expect(pourOf(v.spec)).toMatchObject({ object: "bowl", pour: { into: "cup", tilt_deg: 120, tilt_s: 1.5 } });
      expect([bowl.role, bowl.liquid_ml, cup.role, cup.liquid_ml]).toEqual(["manipulated", 38, "fixture", undefined]);
      expect(v.spec.steps[0].success).toEqual([share(90, "bowl", "cup")]);
      // the bowl is held where the cup stood, on the block, narrowed to what the jaws hold; the cup stands 22 mm off its rim
      expect(bowl.size_mm).toEqual([50, 50, 40]);
      expect(bowl.pose!.xyz_mm).toEqual([300, 0, 66]);
      expect(cup.pose!.xyz_mm).toEqual([300, 71, 27]);
      expect(v.warnings).toEqual(["bowl is 68 x 68 mm across and the jaws hold 6 to 50 mm: it is 50 x 50 mm here"]);
      expect(v.edits.map((e) => e.path)).toEqual(expect.arrayContaining(["objects[cup].liquid_ml", "objects[bowl].liquid_ml", "steps[s1].object", "steps[s1].pour", "steps[s1].success"]));
    }
    // a size the variant gives for the new held container is narrowed too, and reported as its change
    const sized = variant(build(["steps[s1].object", "bowl"], ["objects[bowl].size_mm", [48, 48, 54]]));
    expect(object(sized.spec, "bowl").pose!.xyz_mm).toEqual([300, 0, 73]);
    expect(sized.warnings).toEqual([]);
    expect(variant(build(["steps[s1].object", "bowl"], ["objects[bowl].size_mm", [60, 60, 54]])).warnings).toEqual(["objects[bowl].size_mm is [50,50,54] on the bench, not [60,60,54]"]);
  });

  it("tightens the share of the liquid, never loosens or drops it", () => {
    const refused = (checks: string) => `it drops or loosens a check that the task is done (${checks}): a variant may add a check or tighten one, never remove or loosen one`;
    expect(variant(build(["steps[s1].success", [share(95)]])).spec.steps[0].success).toEqual([share(95)]);
    expect(why(build(["steps[s1].success", [share(80)]]))).toBe(refused("liquid_inside cup in bowl 90"));
    expect(why(build(["steps[s1].success", []]))).toBe(refused("liquid_inside cup in bowl 90"));
    expect(why(build(["steps[s1].success", [{ kind: "object_still", object: "cup" }]]))).toBe(refused("liquid_inside cup in bowl 90"));
    // turned round, the check must turn round with it: the old direction is not the same task
    expect(why(build(["steps[s1].object", "bowl"], ["steps[s1].success", [share(95, "bowl", "cup")]]))).toBe("");
    expect(why(build(["steps[s1].object", "bowl"], ["steps[s1].success", [share(90)]]))).toBe(refused("liquid_inside bowl in cup 90"));
  });

  it("changes how far and how fast it tilts", () => {
    const v = variant(build(["steps[s1].pour", { into: "bowl", tilt_deg: 180, tilt_s: 1 }]));
    expect(v.edits).toEqual([{ path: "steps[s1].pour", before: { into: "bowl", tilt_deg: 120, tilt_s: 1.5 }, after: { into: "bowl", tilt_deg: 180, tilt_s: 1 } }]);
    expect(physicalKey(v.spec)).not.toBe(physicalKey(POUR_SPEC));
    expect(why(build(["steps[s1].pour.tilt_s", 3]))).toBe("");
    expect(why(build(["steps[s1].pour.tilt_deg", 270]))).toMatch(/^rejected \(steps\.0\.pour\.tilt_deg/);
  });

  it("stays a pour between the same two containers", () => {
    expect(why(build(["steps[s1].verb", "place"]))).toBe("steps[s1].verb: a pour stays a pour: its verb and target do not change");
    expect(why(build(["steps[s1].target", { fixture: "zone", frame: "bowl" }]))).toBe("steps[s1].target: a pour stays a pour: its verb and target do not change");
    expect(why(build(["steps[s1].object", "block"]))).toBe('steps[s1].object: a pour keeps its two containers; it can only turn round, from "bowl" back into "cup"');
    expect(why(build(["steps[s1].pour.into", "block"]))).toBe('steps[s1].pour.into: a pour keeps its two containers; it can only turn round, from "bowl" back into "cup"');
    expect(why(build(["objects[cup].liquid_ml", 20]))).toMatch(/not something a variant can change/);
    expect(why(build(["objects[bowl].role", "manipulated"]))).toMatch(/not something a variant can change/);
    // turned round one way and not the other, it would pour into itself
    expect(why(build(["steps[s1].object", "bowl"], ["steps[s1].pour.into", "bowl"]))).toBe('step "s1" pours the bowl into itself');
    expect(why(build(["objects[bowl].name", "basin"]))).toBe("the arm would do exactly the task above");
  });

  it("refuses a target that cannot stand there", () => {
    // moved toward the cup, it would stand in the block
    expect(why(build(["objects[bowl].pose", { xyz_mm: [300, 60, 20], yaw_deg: 0, frame: "world" }]))).toBe("block and bowl would be in the same place");
    expect(why(build(["objects[bowl].pose", { xyz_mm: [300, 80, 5], yaw_deg: 0, frame: "world" }]))).toBe("bowl would be partly below the table");
    // the arm never reaches for the target: beyond its 300 mm is not a reason, as for the demo's own bowl
    expect(why(build(["objects[bowl].pose", { xyz_mm: [300, 120, 20], yaw_deg: 0, frame: "world" }]))).toBe("");
  });

  it("may say it pours, and still not that it waves", () => {
    expect(why(buildVariant(POUR_SPEC, { title: "Pour it back", summary: "The water is poured back into the cup.", changes: [{ path: "steps[s1].object", value: "bowl" }] }, 1))).toBe("");
    expect(why(buildVariant(POUR_SPEC, { title: "Wave, then pour", summary: "", changes: [{ path: "steps[s1].pour.tilt_s", value: 2 }] }, 1))).toBe('not yet: "wave" is not something the rehearsal runs; it runs one pour from a container the arm holds');
  });
});

describe("a task that does not pour", () => {
  let base: TaskSpec;
  beforeAll(async () => {
    base = (await issBase()).spec;
  });
  const never = "this task does not pour: its variants keep one grasp and then one insert or place and never turn into a pour";

  it("never turns into a pour", () => {
    expect(why(buildVariant(base, idea("v", ["steps[s2].verb", "pour"]), 1))).toBe(never);
    expect(why(buildVariant(base, idea("v", ["steps[s2].pour", { into: "obj2", tilt_deg: 120 }]), 1))).toMatch(/^steps\[s2\]\.pour: not something a variant can change/);
    expect(why(buildVariant(base, idea("v", ["objects[obj1].liquid_ml", 30]), 1))).toMatch(/not something a variant can change/);
    expect(why(buildVariant(base, { title: "Pour into tray", summary: "", changes: [{ path: "objects[obj2].pocket_clearance_mm", value: 2 }] }, 1))).toBe(never);
  });
});

describe("Super's reply for a pour", () => {
  it("is asked again when no suggestion pours it back, and not for a request", () => {
    const reply = VariantReply.parse({ variants: [idea("Bigger bowl", ["objects[bowl].size_mm", [90, 90, 40]]), idea("Faster", ["steps[s1].pour", { into: "bowl", tilt_deg: 180, tilt_s: 1 }]), idea("Stricter", ["steps[s1].success", [share(95)]])] });
    expect(replyProblems(POUR_SPEC, reply)).toEqual(['none of your variants pours it back; make one of them do it with {"path":"steps[s1].object","value":"bowl"}']);
    reply.variants.push(idea("Pour it back", ["steps[s1].object", "bowl"]));
    expect(replyProblems(POUR_SPEC, reply)).toEqual([]);
    expect(replyProblems(POUR_SPEC, VariantReply.parse({ variants: [reply.variants[0]] }), "a bigger bowl")).toEqual([]);
  });

  it("is prompted with the pour's own limits, and the examples never name it", () => {
    const facts = benchFacts(POUR_SPEC);
    expect(facts).toContain('cup "cup" is held and poured: box 48 x 48 x 54 mm, at (300, 0) mm, its bottom 46 mm and its rim 100 mm above the table, holding 38 mL');
    expect(facts).toContain("about 22 mm from cup's rim");
    expect(facts).toContain('Pouring back is this one change: {"path":"steps[s1].object","value":"bowl"}');
    expect(facts).toContain("bowl is 68 mm across, so the jaws hold it narrowed to 50 mm");
    expect(facts).toContain("Success: liquid_inside of cup in bowl 90");
    const message = userMessage(POUR_SPEC);
    expect(message).toContain('"pour":{"into":"bowl","tilt_deg":120,"tilt_s":1.5}');
    expect(message).toContain('"liquid_ml":38');
  });
});

describe("POST /api/variants in replay, on the stage's pour", () => {
  let engine: Engine;
  beforeAll(async () => {
    engine = await loadEngine();
  }, 60_000);

  const post = async (body: unknown): Promise<StageResult<Checked>> => (await POST(new Request("http://test/api/variants?replay=1", { method: "POST", body: JSON.stringify(body) }))).json();

  it("offers three or more pour variants, pouring it back among them, each rehearsed with the liquid measured on Earth and in orbit", async () => {
    const result = await post({ spec: POUR_SPEC });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.warnings).toContain("replay: recorded answer");
    const variants = result.value.variants;
    expect(variants.length).toBeGreaterThanOrEqual(3);
    expect(variants.every((v) => pourOf(v.spec) !== undefined)).toBe(true);
    expect(variants.some((v) => pourOf(v.spec)?.object === "bowl")).toBe(true);
    for (const v of variants) {
      // every pour variant keeps a check on the share of the liquid in its target
      const pour = pourOf(v.spec)!;
      expect(pour.success.some((p) => p.kind === "liquid_inside" && p.target === pour.pour.into && (p.value ?? 0) >= 90), v.title).toBe(true);
      const c = await postCompile(v.spec, POUR_PROGRAMS.pour);
      expect(c.status, v.title).toBe("done");
      if (c.status !== "done") continue;
      for (const world of ["earth", "orbit"] as const) {
        const r = rollout(engine, v.spec, c.value, world);
        // what a card shows: the share inside the target, as measured, and pass or fail
        expect(r.liquid, `${v.title} ${world}`).toBeDefined();
        expect(r.liquid!.containers[pour.pour.into]).toBeGreaterThanOrEqual(0);
        expect(typeof r.pass).toBe("boolean");
      }
    }
  }, 300_000);

  it("turns “pour it back” into the pour turned round", async () => {
    const result = await post({ spec: POUR_SPEC, request: "Pour it back." });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.value.variants).toHaveLength(1);
    expect(valueAt(result.value.variants[0].spec, "steps[s1].object")).toBe("bowl");
  });
});
