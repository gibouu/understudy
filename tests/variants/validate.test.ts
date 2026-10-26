import { beforeAll, describe, expect, it } from "vitest";
import { fitToBench } from "@/lib/sim/fit";
import { parseModelJson } from "@/lib/spec/parse";
import type { Predicate, TaskSpec } from "@/lib/spec/schema";
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

  it("keeps every check that the task is done, as strict: a pass means the same task done", () => {
    expect(base.steps[1].success.map((p) => p.kind)).toEqual(["inside_zone", "object_still"]);
    const still: Predicate = { kind: "object_still", object: "obj1" };
    const inside: Predicate = { kind: "inside_zone", object: "obj1", target: "obj2" };
    const tilt = (value: number): Predicate => ({ kind: "tilt_under", object: "obj1", value });
    const refused = (checks: string) => `it drops or loosens a check that the task is done (${checks}): a variant may add a check or tighten one, never remove or loosen one`;
    expect(why(build(["steps[s2].success", [still]]))).toBe(refused("inside_zone obj1 in obj2"));
    expect(why(build(["steps[s2].success", []]))).toBe(refused("inside_zone obj1 in obj2; object_still obj1"));
    // the same kind about something else is not the same check
    expect(why(build(["steps[s2].success", [{ ...inside, target: "obj1" }, still]]))).toBe(refused("inside_zone obj1 in obj2"));
    // adding a check is allowed
    expect(why(build(["steps[s2].success", [inside, still, tilt(20)]]))).toBe("");
    // a threshold may tighten, never loosen, and a looser duplicate does not stand in for a stricter check
    const strict = structuredClone(base);
    strict.steps[1].success = [inside, still, tilt(20)];
    const vary = (success: Predicate[]) => why(buildVariant(strict, idea("Straighter", ["steps[s2].success", success]), 1));
    expect(vary([inside, still, tilt(5)])).toBe("");
    expect(vary([inside, still, tilt(30)])).toBe(refused("tilt_under obj1 20"));
    expect(vary([inside, still, tilt(30), tilt(20)])).toBe("");
    const twice = structuredClone(base);
    twice.steps[1].success = [inside, still, tilt(5), tilt(20)];
    expect(why(buildVariant(twice, idea("One tilt", ["steps[s2].success", [inside, still, tilt(20)]]), 1))).toBe(refused("tilt_under obj1 5"));
    // for height_above, higher is stricter
    const lifted = structuredClone(base);
    lifted.steps[1].success = [inside, still, { kind: "height_above", object: "obj1", value: 5 }];
    expect(why(buildVariant(lifted, idea("Higher", ["steps[s2].success", [inside, still, { kind: "height_above", object: "obj1", value: 8 }]]), 1))).toBe("");
    expect(why(buildVariant(lifted, idea("Lower", ["steps[s2].success", [inside, still, { kind: "height_above", object: "obj1", value: 2 }]]), 1))).toBe(refused("height_above obj1 5"));
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
    expect(why(build(pose("obj1", [175, 40, 20])))).toBe("seed film packet and Veggie plant pillow tray would be in the same place");
    expect(why(build(pose("obj1", [200, -100, 60])))).toMatch(/start in mid-air, 40 mm above/);
    expect(why(build(pose("obj1", [0, 0, 25], "obj2")))).toMatch(/start in mid-air, 12 mm above/);
    expect(why(build(pose("obj1", [0, 0, 5], "obj2")))).toBe("seed film packet and Veggie plant pillow tray would be in the same place");
    expect(why(build(pose("obj2", [175, 100, 5])))).toMatch(/partly below the table/);
  });

  it("refuses what MuJoCo cannot build or the arm cannot grip", () => {
    expect(why(build(["objects[obj1].size_mm", [0.0001, 0.0001, 0.0001]]))).toBe("seed film packet would be under 6 mm in one direction");
    const sphere = build(["objects[obj2].shape", "sphere"], ["steps[s2].verb", "place"], ["steps[s2].target.fixture", "zone"]);
    expect(why(sphere)).toBe("Veggie plant pillow tray would be a sphere with different sizes in x, y and z");
  });

  it("refuses a start inside the pocket's wall, and accepts one inside its opening or on a zone's top", () => {
    const inWall = why(build(["objects[obj1].pose", { xyz_mm: [50, 0, 13], yaw_deg: 0, frame: "obj2" }]));
    expect(inWall).toBe("seed film packet and Veggie plant pillow tray would be in the same place");
    // turned a quarter turn, the 40 mm side no longer fits the 20 mm side of the opening
    expect(why(build(["objects[obj1].pose", { xyz_mm: [0, 0, 13], yaw_deg: 90, frame: "obj2" }]))).toBe("seed film packet and Veggie plant pillow tray would be in the same place");
    const onTop = (frame: string, xyz: number[]) => build(["steps[s2].verb", "place"], ["steps[s2].target.fixture", "zone"], ["objects[obj1].pose", { xyz_mm: xyz, yaw_deg: 0, frame }]);
    expect(why(onTop("world", [175, 100, 50]))).toBe("");
    expect(why(onTop("obj2", [0, 0, 35]))).toBe("");
  });

  it("does not offer a variant that claims an action the rehearsal does not run", () => {
    const pour = buildVariant(base, { title: "Pour into tray", summary: "The arm pours into the tray.", changes: [{ path: "objects[obj2].pocket_clearance_mm", value: 2 }] }, 1);
    expect(why(pour)).toBe('not yet: "pour" is not something the rehearsal runs; it runs one grasp and then one insert or place');
    const noun = buildVariant(base, { title: "Tighter holder", summary: "The arm inserts the stirring rod into a tighter holder, wiping nothing.", changes: [{ path: "objects[obj2].pocket_clearance_mm", value: 2 }] }, 1);
    expect(why(noun)).toBe("");
  });

  it("judges footprints by their real shape", () => {
    // 30 mm of table between the packet and the tray: bounding discs would overlap
    expect(why(build(["objects[obj1].pose", { xyz_mm: [175, -10, 20], yaw_deg: 0, frame: "world" }]))).toBe("");
    // a round object fits a pocket however it is turned
    const cyl = (yaw: number) => build(["objects[obj1].shape", "cylinder"], ["objects[obj1].size_mm", [20, 20, 40]], ["objects[obj1].pose", { xyz_mm: [0, 0, 13], yaw_deg: yaw, frame: "obj2" }]);
    expect(why(cyl(0))).toBe("");
    expect(why(cyl(45))).toBe("");
    // past a round target's edge there is no support, though its square bounds reach that far
    const plate = (xyz: number[]) => build(["objects[obj2].shape", "cylinder"], ["objects[obj2].size_mm", [100, 100, 30]], ["steps[s2].verb", "place"], ["steps[s2].target.fixture", "zone"], ["objects[obj1].pose", { xyz_mm: xyz, yaw_deg: 0, frame: "obj2" }]);
    expect(why(plate([0, 0, 35]))).toBe("");
    expect(why(plate([42, 42, 35]))).toBe("seed film packet would start in mid-air, 30 mm above the surface under it");
  });

  it("treats a pocket as the box the scene cuts, even in a round fixture", () => {
    const cylPocket = (xyz: number[]) =>
      build(["objects[obj1].shape", "cylinder"], ["objects[obj1].size_mm", [20, 20, 40]], ["objects[obj1].pose", { xyz_mm: xyz, yaw_deg: 0, frame: "world" }], ["objects[obj2].shape", "cylinder"], ["objects[obj2].size_mm", [70, 70, 30]], ["objects[obj2].pose", { xyz_mm: [175, 60, 15], yaw_deg: 0, frame: "world" }]);
    expect(why(cylPocket([211, 96, 20]))).toBe("seed film packet and Veggie plant pillow tray would be in the same place");
    expect(why(cylPocket([200, -60, 20]))).toBe("");
  });

  it("measures a box against a round target from its nearest corner", () => {
    const beside = (yaw: number) =>
      build(["steps[s2].verb", "place"], ["steps[s2].target.fixture", "zone"], ["objects[obj2].shape", "cylinder"], ["objects[obj2].size_mm", [100, 100, 30]], ["objects[obj2].pose", { xyz_mm: [175, 100, 15], yaw_deg: yaw, frame: "world" }], ["objects[obj1].pose", { xyz_mm: [230, 150, 20], yaw_deg: 0, frame: "world" }]);
    expect(why(beside(0))).toBe("");
    expect(why(beside(45))).toBe("");
  });

  it("refuses a start hanging on one rim of a pocket, and accepts one lying across both", () => {
    expect(why(build(["objects[obj1].pose", { xyz_mm: [8, 0, 35], yaw_deg: 0, frame: "obj2" }]))).toBe("seed film packet would start across the edge of Veggie plant pillow tray's pocket and tip in");
    // turned a quarter turn, the 40 mm packet lies across the 20 mm side of the opening
    expect(why(build(["objects[obj1].pose", { xyz_mm: [0, 0, 35], yaw_deg: 90, frame: "obj2" }]))).toBe("");
  });

  it("finds the table under a raised fixture", () => {
    const r = build(["objects[obj2].pose", { xyz_mm: [175, 100, 60], yaw_deg: 0, frame: "world" }], ["objects[obj1].pose", { xyz_mm: [175, 100, 20], yaw_deg: 0, frame: "world" }]);
    expect(why(r)).toBe("");
  });

  it("keeps the grasp a grasp", () => {
    expect(why(build(["steps[s1].verb", "place"]))).toBe("steps[s1].verb: the grasp stays a grasp: only the step that puts the object somewhere can change its verb");
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
