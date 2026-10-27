import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MainModule, MjVFS } from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import compiles from "@/tests/fixtures/compile.json";
import labels from "@/tests/fixtures/label.json";
import { POST } from "@/app/api/label/route";
import { fitToBench } from "@/lib/sim/fit";
import { environment, runToEnd } from "@/lib/sim/interpreter";
import { SO101_XML, stageXml } from "@/lib/sim/so101";
import { Program, TaskSpec } from "@/lib/spec/schema";

let mujoco: MainModule;
let vfs: MjVFS;

beforeAll(async () => {
  const { default: loadMujoco } = await import("@mujoco/mujoco");
  mujoco = await loadMujoco();
  const dir = path.join(process.cwd(), "assets", "so101");
  vfs = new mujoco.MjVFS();
  vfs.addBuffer(SO101_XML, new Uint8Array(readFileSync(path.join(dir, SO101_XML))));
  for (const file of readdirSync(path.join(dir, "assets"))) vfs.addBuffer(file, new Uint8Array(readFileSync(path.join(dir, "assets", file))));
}, 60_000);

const label = TaskSpec.parse((labels[0].result as { value: unknown }).value);
const post = (body: unknown) => POST(new Request("http://x/api/label?replay=1", { method: "POST", body: JSON.stringify(body) }));

describe("POST /api/label in replay", () => {
  it("answers with the recording of the same clip", async () => {
    const res = await (await post({ clip_sha256: labels[0].clip_sha256 })).json();
    expect(res.status).toBe("done");
    expect(TaskSpec.parse(res.value)).toEqual(label);
  });

  it("falls back to the first recording, with a warning, for another clip", async () => {
    const res = await (await post({ clip_sha256: "other" })).json();
    expect(res.status).toBe("done");
    expect(res.warnings).toContain("replay: recorded for another clip");
  });
});

describe("the recorded label of the hero clip, fitted to the bench", () => {
  const fit = fitToBench(label);

  it("keeps one grasp and the insert into the pocket, and reports what it left out", () => {
    expect(fit.spec.steps.map((s) => [s.verb, s.target?.fixture])).toEqual([
      ["grasp", undefined],
      ["insert", "pocket"],
    ]);
    expect(fit.spec.objects.map((o) => o.role)).toEqual(["manipulated", "fixture"]);
    expect(fit.warnings.some((w) => w.startsWith("left out of the rehearsal"))).toBe(true);
    expect(Math.max(...fit.spec.objects[1].size_mm)).toBeLessThanOrEqual(150);
  });

  it("is the spec Nano's recorded program was compiled for, once three answers are in", () => {
    const rec = compiles.find((r) => (r.spec as { title: string }).title === label.title)!;
    const answered = TaskSpec.parse(rec.spec);
    const expected = structuredClone(fit.spec);
    expected.objects[1].pocket_clearance_mm = answered.objects[1].pocket_clearance_mm;
    expected.objects[1].sources = answered.objects[1].sources;
    expected.steps[1] = { ...expected.steps[1], success: answered.steps[1].success, tolerances: answered.steps[1].tolerances, sources: answered.steps[1].sources };
    expect(answered).toEqual(expected);
  });

  it.each([
    [1, true],
    [0, false],
  ] as const)("Nano's recorded program for it runs at %s g: pass %s", (gravity_g, pass) => {
    const rec = compiles.find((r) => (r.spec as { title: string }).title === label.title)!;
    const spec = TaskSpec.parse(rec.spec);
    const program = Program.parse((rec.result as { value: unknown }).value);
    const env = environment(spec, { id: "t", name: "t", axis: "x_mm", offset: 0, object: spec.objects[0].id, expected: "unknown", why: "", gravity_g });
    const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: env.gravity_g, graspable: env.graspable }), vfs);
    const data = new mujoco.MjData(model);
    try {
      const r = runToEnd({ mujoco, model, data }, env, program, "sensed");
      expect(r.pass, r.log.join("\n")).toBe(pass);
    } finally {
      data.delete();
      model.delete();
    }
  }, 60_000);
});

describe("fitToBench", () => {
  const spec = TaskSpec.parse({
    version: 1,
    title: "t",
    summary: "",
    objects: [
      { id: "a", name: "peg", shape: "cylinder", size_mm: [10, 10, 30], symmetry: "axial", role: "obstacle" },
      { id: "b", name: "block", shape: "box", size_mm: [60, 60, 30], symmetry: "none", role: "surface" },
      { id: "c", name: "tray", shape: "box", size_mm: [300, 200, 10], symmetry: "none", role: "surface" },
    ],
    steps: [
      { id: "s1", verb: "insert", object: "a", target: { fixture: "pocket", frame: "b" }, preconditions: [{ kind: "contact_both_pads", object: "a" }], success: [{ kind: "inside_zone", object: "a", target: "c" }], t_start_s: 0, t_end_s: 1 },
    ],
    open_questions: ["Is a snug fit needed?", "Where is c?"],
  });
  const fit = fitToBench(spec).spec;

  it("makes the moved object manipulated and its target a fixture", () => {
    expect(fit.objects.map((o) => [o.id, o.role])).toEqual([
      ["a", "manipulated"],
      ["b", "fixture"],
    ]);
  });

  it("gives a made-up grasp no checks, and drops checks on objects left out", () => {
    expect(fit.steps[0]).toMatchObject({ verb: "grasp", preconditions: [], success: [] });
    expect(fit.steps[1].success).toEqual([]);
    expect(fit.steps[1].preconditions).toHaveLength(1);
  });

  it("drops only the questions about objects left out", () => {
    expect(fit.open_questions).toEqual(["Is a snug fit needed?"]);
  });
});

/** Own clips (#150): Super VL often puts something down as a move onto an object, then a release, with no place step. */
describe("fitToBench, a move and then a release", () => {
  const objects = [
    { id: "bag", name: "drink bag", shape: "box", size_mm: [80, 20, 120], symmetry: "none", role: "manipulated" },
    { id: "foam", name: "foam block", shape: "box", size_mm: [100, 100, 60], symmetry: "none", role: "fixture" },
    { id: "bench", name: "work surface", shape: "box", size_mm: [300, 300, 20], symmetry: "none", role: "surface" },
  ];
  const label = (steps: unknown[]) => TaskSpec.parse({ version: 1, title: "t", summary: "", objects, steps });
  const step = (id: string, verb: string, extra: object, t: number) => ({ id, verb, object: "bag", t_start_s: t, t_end_s: t + 1, ...extra });
  const zone = (frame: string) => ({ target: { fixture: "zone", frame } });

  it("reads them as a place onto where the bag went, and says so", () => {
    const fit = fitToBench(label([step("s1", "grasp", {}, 0), step("s2", "move", zone("foam"), 1), step("s3", "release", {}, 2)]));
    expect(fit.spec.steps.map((s) => [s.id, s.verb, s.object, s.target?.frame])).toEqual([
      ["s1", "grasp", "bag", undefined],
      ["s2", "place", "bag", "foam"],
    ]);
    expect(fit.warnings[0]).toBe("steps s2 and s3: a move onto foam, then a release, read as a place there");
    expect(fit.spec.steps[1]).toMatchObject({ t_start_s: 1, t_end_s: 3, source: "fit" });
  });

  it("takes the release's own target when it names another object", () => {
    const fit = fitToBench(label([step("s1", "grasp", {}, 0), step("s2", "move", zone("foam"), 1), step("s3", "release", zone("bench"), 2)]));
    expect(fit.spec.steps[1].target?.frame).toBe("bench");
  });

  it("ends as the release did: its checks and landing tolerances, not the carry's", () => {
    const carry = { success: [{ kind: "height_above", object: "bag", value: 80 }], tolerances: { x_mm: 20, z_mm: 9 } };
    const drop = { success: [{ kind: "inside_zone", object: "bag", target: "foam" }], tolerances: { x_mm: 1 } };
    const fit = fitToBench(label([step("s1", "grasp", {}, 0), step("s2", "move", { ...zone("foam"), ...carry }, 1), step("s3", "release", drop, 2)]));
    expect(fit.spec.steps[1].success).toEqual(drop.success);
    expect(fit.spec.steps[1].tolerances).toEqual({ x_mm: 1, z_mm: 9 });
  });

  it("finds nothing when the release goes elsewhere or has preconditions of its own", () => {
    const nothing = "no insert or place step onto a named object: nothing to rehearse";
    const elsewhere = { target: { fixture: "zone", frame: "world" } };
    expect(fitToBench(label([step("s1", "grasp", {}, 0), step("s2", "move", zone("foam"), 1), step("s3", "release", elsewhere, 2)])).warnings.at(-1)).toBe(nothing);
    const upright = { preconditions: [{ kind: "tilt_under", object: "bag", value: 5 }] };
    expect(fitToBench(label([step("s1", "grasp", {}, 0), step("s2", "move", zone("foam"), 1), step("s3", "release", upright, 2)])).warnings.at(-1)).toBe(nothing);
  });

  it("finds nothing when the move names no target, the bag is never let go, or is grasped again first", () => {
    const none = (steps: unknown[]) => fitToBench(label(steps)).warnings.at(-1);
    const nothing = "no insert or place step onto a named object: nothing to rehearse";
    expect(none([step("s1", "grasp", {}, 0), step("s2", "move", {}, 1), step("s3", "release", {}, 2)])).toBe(nothing);
    expect(none([step("s1", "grasp", {}, 0), step("s2", "move", zone("foam"), 1)])).toBe(nothing);
    expect(none([step("s1", "move", zone("foam"), 0), step("s2", "grasp", {}, 1), step("s3", "release", {}, 2)])).toBe(nothing);
    // a move onto the bag itself goes nowhere
    expect(none([step("s1", "grasp", {}, 0), step("s2", "move", zone("bag"), 1), step("s3", "release", {}, 2)])).toBe(nothing);
  });

  it("skips an insert of an object into itself for the place after it", () => {
    const fit = fitToBench(label([step("s1", "grasp", {}, 0), step("s2", "insert", { target: { fixture: "pocket", frame: "bag" } }, 1), step("s3", "place", zone("foam"), 2)]));
    expect(fit.spec.steps[1]).toMatchObject({ id: "s2", verb: "place", target: { frame: "foam" } });
  });

  it("leaves a label that has a place as it was", () => {
    const fit = fitToBench(label([step("s1", "grasp", {}, 0), step("s2", "move", zone("bench"), 1), step("s3", "place", zone("foam"), 2), step("s4", "release", {}, 3)]));
    expect(fit.spec.steps[1]).toMatchObject({ id: "s2", verb: "place", target: { frame: "foam" } });
    expect(fit.warnings.some((w) => /read as a place/.test(w))).toBe(false);
  });
});
