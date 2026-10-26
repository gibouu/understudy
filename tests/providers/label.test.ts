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
