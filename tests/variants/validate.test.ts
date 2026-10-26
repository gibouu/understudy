import { beforeAll, describe, expect, it } from "vitest";
import { fitToBench } from "@/lib/sim/fit";
import { parseModelJson } from "@/lib/spec/parse";
import type { TaskSpec } from "@/lib/spec/schema";
import { cleanRequest } from "@/lib/variants/ask";
import { MAX_VARIANTS, normalizeReply, VariantReply, type Idea } from "@/lib/variants/parse";
import { BENCH, benchFacts, userMessage } from "@/lib/variants/prompt";
import { buildVariant, checkReply, replyProblems } from "@/lib/variants/validate";
import { issBase } from "./harness";

let base: TaskSpec;
beforeAll(async () => {
  base = (await issBase()).spec;
});

const idea = (title: string, ...changes: [string, unknown][]): Idea => ({ title, summary: "", changes: changes.map(([path, value]) => ({ path, value })) });
const build = (...changes: [string, unknown][]) => buildVariant(base, idea("v", ...changes), 1);
const why = (r: ReturnType<typeof build>) => ("why" in r ? r.why : "");
const spec = (r: ReturnType<typeof build>) => {
  if ("why" in r) throw new Error(r.why);
  return r.variant.spec;
};

describe("parsing Super's reply", () => {
  const parse = (text: string) => parseModelJson(text, VariantReply, { normalize: normalizeReply }).value;

  it("reads variants and not-yet ideas, with defaults", () => {
    const r = parse('{"variants":[{"title":"Smaller tray","changes":[{"path":"objects[obj2].size_mm","value":[100,100,30]}]}],"not_yet":[{"idea":"Pour it"}]}');
    expect(r.variants[0]).toEqual({ title: "Smaller tray", summary: "", changes: [{ path: "objects[obj2].size_mm", value: [100, 100, 30] }] });
    expect(r.not_yet).toEqual([{ idea: "Pour it", why: "" }]);
  });

  it("accepts a bare list, a lone variant, and values written as JSON text", () => {
    expect(parse('[{"title":"a","changes":[{"path":"p","value":"[1, 2, 3]"}]}]').variants[0].changes[0].value).toEqual([1, 2, 3]);
    expect(parse('{"title":"a","changes":[{"path":"p","value":4,"source":"model"}]}').variants[0].changes).toEqual([{ path: "p", value: 4 }]);
    expect(parse('{"variants":[{"title":"a","changes":[{"path":"objects[x].name","value":"[draft"}]}]}').variants[0].changes[0].value).toBe("[draft");
  });

  it("refuses a variant without changes", () => {
    expect(() => parse('{"variants":[{"title":"a","changes":[]}]}')).toThrow(/schema validation failed/);
  });
});

describe("a variant of the ISS sample", () => {
  it("fits a change to the bench, names it and records its provenance", () => {
    const r = build(["objects[obj2].size_mm", [100, 100, 30]]);
    if ("why" in r) throw new Error(r.why);
    expect(r.variant.spec.title).toBe(`${base.title}: v`);
    expect(r.variant.edits).toEqual([{ path: "objects[obj2].size_mm", before: [150, 150, 30], after: [100, 100, 30] }]);
    expect(r.variant.spec.objects[1].sources.size_mm).toBe("fit");
    // what the person answered carries over
    expect(r.variant.spec.objects[1].pocket_clearance_mm).toBe(base.objects[1].pocket_clearance_mm);
    expect(r.variant.spec.steps[1].success).toEqual(base.steps[1].success);
  });

  it("keeps a move through the fit, which lays objects out at their usual spots", () => {
    const s = spec(build(["objects[obj2].pose", { xyz_mm: [205, 100, 15], yaw_deg: 30, frame: "world" }]));
    expect(s.objects[1].pose).toEqual({ xyz_mm: [205, 100, 15], yaw_deg: 30, frame: "world" });
    expect(s.objects[1].sources.pose).toBe("variant#1");
  });

  it("starts the object on the pocket floor with the pose the bench facts give", () => {
    const pose = JSON.parse(benchFacts(base).match(/on its pocket floor: pose (\{.*?\});/)![1]);
    expect(pose).toEqual({ xyz_mm: [0, 0, 13], yaw_deg: 0, frame: "obj2" });
    expect(spec(build(["objects[obj1].pose", pose])).objects[0].pose).toEqual(pose);
  });

  it("gives a new shape its symmetry", () => {
    const s = spec(build(["objects[obj1].shape", "cylinder"], ["objects[obj1].size_mm", [20, 20, 40]]));
    expect(s.objects[0]).toMatchObject({ shape: "cylinder", symmetry: "axial", size_mm: [20, 20, 40] });
    expect(why(build(["objects[obj1].shape", "sphere"], ["objects[obj1].symmetry", "none"]))).toMatch(/symmetry "full"/);
  });

  it("refuses what a variant may not change", () => {
    expect(why(build(["objects[obj1].role", "fixture"]))).toMatch(/not something a variant can change/);
    expect(why(build(["objects[obj1].id", "x"]))).toMatch(/not something a variant can change/);
    expect(why(build(["steps", []]))).toMatch(/not something a variant can change/);
    expect(why(build(["steps[s2].via_points", []]))).toMatch(/not something a variant can change/);
    expect(why(build(["steps[s2].target.frame", "obj1"]))).toMatch(/not something a variant can change/);
    expect(why(build(["objects[obj9].size_mm", [1, 2, 3]]))).toMatch(/no object "obj9"/);
    expect(why(build(["title", "renamed"]))).toBe("it changes nothing in the task");
  });

  it("refuses a variant that cannot apply, and says why", () => {
    expect(why(build(["objects[obj2].size_mm", [-5, 100, 30]]))).toMatch(/^rejected \(objects\.1\.size_mm\.0: /);
    expect(why(build(["objects[obj2].size_mm", [100, 100, 30]], ["objects[obj1].size_mm", [0, 10, 40]]))).toMatch(/^rejected .*\(objects\[obj1\]\.size_mm: the batch is valid without it\)$/);
    expect(why(build(["objects[obj2].pocket_clearance_mm", null]))).toBe("objects[obj2].pocket_clearance_mm: no value given");
    expect(why(build(["steps[s2].verb", "pour"]))).toMatch(/^rejected \(steps\.1\.verb/);
    expect(why(build(["steps[s2].verb", "release"]))).toMatch(/^not yet: the rehearsal runs one grasp and then one insert or place/);
  });

  it("refuses a variant the bench undoes, naming what it holds instead", () => {
    expect(why(build(["objects[obj2].size_mm", [150, 150, 80]]))).toBe("outside what the robot's jaws and reach hold: objects[obj2].size_mm is [150,150,30] on the bench, not [150,150,80]");
    expect(why(build(["objects[obj2].name", "a tray"]))).toBe("the arm would do exactly the task above");
  });

  it("keeps a change the bench only trims, with a warning", () => {
    const r = build(["objects[obj2].size_mm", [100, 100, 80]]);
    if ("why" in r) throw new Error(r.why);
    expect(r.variant.spec.objects[1].size_mm).toEqual([100, 100, 30]);
    expect(r.variant.warnings).toEqual(["objects[obj2].size_mm is [100,100,30] on the bench, not [100,100,80]"]);
  });

  it("refuses a world that cannot exist as posed", () => {
    const pose = (o: string, xyz: number[], frame = "world") => [`objects[${o}].pose`, { xyz_mm: xyz, yaw_deg: 0, frame }] as [string, unknown];
    expect(why(build(pose("obj2", [320, 100, 15])))).toMatch(/beyond its 300 mm reach/);
    expect(why(build(pose("obj1", [40, 0, 20])))).toMatch(/too close to reach down to/);
    expect(why(build(pose("obj1", [175, 40, 20])))).toMatch(/would overlap on the table/);
    expect(why(build(pose("obj1", [200, -100, 60])))).toMatch(/start in mid-air, 40 mm above/);
    expect(why(build(pose("obj1", [0, 0, 25], "obj2")))).toMatch(/start in mid-air, 12 mm above/);
    expect(why(build(pose("obj1", [0, 0, 5], "obj2")))).toMatch(/sunk into what is under it/);
    expect(why(build(pose("obj2", [175, 100, 5])))).toMatch(/partly below the table/);
  });

  it("widens a target too small for the object and its clearance, and says so", () => {
    const r = build(["objects[obj2].size_mm", [20, 20, 30]]);
    if ("why" in r) throw new Error(r.why);
    expect(r.variant.spec.objects[1].size_mm).toEqual([80, 80, 30]);
    expect(r.variant.warnings).toEqual(["objects[obj2].size_mm is [80,80,30] on the bench, not [20,20,30]"]);
  });
});

describe("checking a whole reply", () => {
  const smaller = idea("Smaller tray", ["objects[obj2].size_mm", [100, 100, 30]]);

  it("numbers the variants that fit, moves the rest to not yet, and counts a repeat once", () => {
    const reply = VariantReply.parse({
      variants: [smaller, idea("Smaller tray", ["objects[obj2].size_mm", [100, 100, 30]]), idea("Smaller tray", ["objects[obj2].size_mm", [90, 90, 30]]), idea("Taller tray", ["objects[obj2].size_mm", [150, 150, 80]])],
      not_yet: [{ idea: "Pour it", why: "the arm cannot pour yet" }],
    });
    const { variants, not_yet } = checkReply(base, reply, 3);
    expect(variants.map((v) => [v.id, v.title])).toEqual([
      ["variant#3", "Smaller tray"],
      ["variant#4", "Smaller tray (2)"],
    ]);
    expect(variants[1].spec.title).toBe(`${base.title}: Smaller tray (2)`);
    expect(not_yet.map((n) => n.idea)).toEqual(["Pour it", "Taller tray"]);
  });

  it(`keeps at most ${MAX_VARIANTS}`, () => {
    const many = Array.from({ length: 8 }, (_, i) => idea(`Tray ${i}`, ["objects[obj2].size_mm", [90 + i * 5, 90 + i * 5, 30]]));
    expect(checkReply(base, VariantReply.parse({ variants: many })).variants).toHaveLength(MAX_VARIANTS);
  });

  it("asks Super again when fewer than three fit, or a request gets more than one", () => {
    const one = VariantReply.parse({ variants: [smaller, idea("Taller tray", ["objects[obj2].size_mm", [150, 150, 80]])] });
    expect(replyProblems(base, one)).toEqual([expect.stringMatching(/^variant "Taller tray": outside/), "only 1 of your variants fit the bench; give 3 to 5 that do"]);
    const two = VariantReply.parse({ variants: [smaller, idea("Moved", ["objects[obj2].pose", { xyz_mm: [205, 100, 15], yaw_deg: 0, frame: "world" }])] });
    expect(replyProblems(base, two, "make it smaller")).toEqual(["give one variant for the request, not 2"]);
    expect(replyProblems(base, VariantReply.parse({}), "make it smaller")).toEqual(["give one variant, or one not_yet entry saying what the arm cannot do yet"]);
    expect(replyProblems(base, VariantReply.parse({ not_yet: [{ idea: "pour", why: "cannot pour yet" }] }), "pour it")).toEqual([]);
  });
});

describe("the prompt", () => {
  it("states this spec's limits and never names the task in the rules", () => {
    const facts = benchFacts(base);
    expect(facts).toContain(`obj1 "seed film packet" is held`);
    expect(facts).toContain("pocket clearance 10 mm");
    expect(facts).toContain("a shelf, its pose z raised, of up to 13 mm");
    expect(userMessage(base)).toContain("No request: suggest 5 variants");
    expect(userMessage(base, 'put "it" up')).toContain('Request from the person: "put \\"it\\" up"');
  });

  it("holds the limits fitToBench holds", () => {
    const sized = (o: 0 | 1, size: [number, number, number]) => {
      const s = structuredClone(base);
      s.objects[o].size_mm = size;
      return fitToBench(s).spec.objects[o].size_mm;
    };
    const [lo, hi] = BENCH.heldSideMm;
    const h = BENCH.heldMaxHeightMm;
    // into a pocket the object stands on its longest side, which the fit caps as its height
    expect(sized(0, [h, lo, h])).toEqual([h, lo, h]);
    expect(sized(0, [30, lo, h])).toEqual([30, lo, h]);
    expect(sized(0, [h + 5, lo - 1, h])).toEqual([h, lo, h]);
    const onto = structuredClone(base);
    onto.steps[1] = { ...onto.steps[1], verb: "place", target: { fixture: "zone", frame: "obj2" } };
    onto.objects[0].size_mm = [hi + 5, lo - 1, h + 5];
    expect(fitToBench(onto).spec.objects[0].size_mm).toEqual([hi, lo, h]);
    onto.objects[0].size_mm = [hi, lo, h];
    expect(fitToBench(onto).spec.objects[0].size_mm).toEqual([hi, lo, h]);
    const [fLo, fHi] = BENCH.fixtureHeightMm;
    expect(sized(1, [BENCH.fixtureSideMaxMm, BENCH.fixtureSideMaxMm, fHi])).toEqual([BENCH.fixtureSideMaxMm, BENCH.fixtureSideMaxMm, fHi]);
    expect(sized(1, [BENCH.fixtureSideMaxMm + 10, 200, fHi + 5])).toEqual([BENCH.fixtureSideMaxMm, BENCH.fixtureSideMaxMm, fHi]);
    expect(sized(1, [100, 100, fLo - 5])[2]).toBe(fLo);
    const s = structuredClone(base);
    s.objects[1].pocket_clearance_mm = BENCH.maxClearanceMm + 5;
    expect(fitToBench(s).spec.objects[1].pocket_clearance_mm).toBe(BENCH.maxClearanceMm);
  });
});

describe("cleanRequest", () => {
  it("keeps one short line", () => {
    expect(cleanRequest("  put it\n on a   shelf ", 200)).toBe("put it on a shelf");
    expect(cleanRequest("x".repeat(300), 200)).toHaveLength(200);
    expect(cleanRequest("   ", 200)).toBeUndefined();
    expect(cleanRequest(42, 200)).toBeUndefined();
  });
});
