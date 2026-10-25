import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MainModule, MjVFS } from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import { DEMO_PROGRAMS, DEMO_SPEC } from "@/lib/sim/demo-spec";
import { environment, runToEnd, type Environment } from "@/lib/sim/interpreter";
import { SO101_XML, stageXml } from "@/lib/sim/so101";
import { Program, TaskSpec, type Mode, type Scenario } from "@/lib/spec/schema";

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

/** Set up the world, then run the program in it: the whole interface. */
function rollout(program: Program, mode: Mode, scenario?: Partial<Scenario>, spec: TaskSpec = DEMO_SPEC) {
  const env: Environment = environment(
    spec,
    scenario && { id: "t", name: "t", axis: "x_mm", offset: 0, object: "rack", expected: "unknown", why: "", gravity_g: 1, ...scenario },
  );
  const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: env.gravity_g, graspable: env.graspable }), vfs);
  const data = new mujoco.MjData(model);
  try {
    return runToEnd({ mujoco, model, data }, env, program, mode);
  } finally {
    data.delete();
    model.delete();
  }
}

describe("the program interpreter", () => {
  it.each([
    ["release_early", 1, true],
    ["release_early", 0, false],
    ["hold_until_seated", 1, true],
    ["hold_until_seated", 0, true],
  ] as const)("%s at %s g: pass %s", (name, gravity_g, pass) => {
    const r = rollout(DEMO_PROGRAMS[name], "sensed", { gravity_g });
    expect(r.pass, r.log.join("\n")).toBe(pass);
    if (!pass) expect(r.failed_predicate?.kind).toBe("inside_zone");
  }, 60_000);

  it("a 6 mm rack offset fails blind and passes sensed", () => {
    const scenario = { axis: "x_mm" as const, offset: 6, object: "rack" };
    const blind = rollout(DEMO_PROGRAMS.hold_until_seated, "blind", scenario);
    expect(blind.pass, blind.log.join("\n")).toBe(false);
    const sensed = rollout(DEMO_PROGRAMS.hold_until_seated, "sensed", scenario);
    expect(sensed.pass, sensed.log.join("\n")).toBe(true);
  }, 60_000);

  it("turns a program naming an unknown object into a spec gap, not a crash", () => {
    const bad = Program.parse({ spec_title: "", steps: [{ step_id: "s1", ops: [{ op: "assert", predicate: { kind: "object_still", object: "ghost" } }] }] });
    const r = rollout(bad, "sensed");
    expect(r.pass).toBe(false);
    expect(r.failure_class).toBe("spec_gap");
    expect(r.why).toContain("ghost");
  }, 60_000);

  it("reports an unreachable target as an embodiment limit", () => {
    const far = { spec_title: "", warnings: [], steps: [{ step_id: "s1", ops: [{ op: "move_to" as const, frame: "world", offset_mm: [800, 0, 100] as [number, number, number], approach: "top" as const }] }] };
    const r = rollout(far, "sensed");
    expect(r.pass).toBe(false);
    expect(r.failure_class).toBe("embodiment_limit");
  }, 60_000);

  it("runs a different experiment through the same two calls: a block placed on a pad", () => {
    const spec = TaskSpec.parse({
      version: 1,
      title: "block onto pad",
      summary: "Put the block on the pad.",
      objects: [
        { id: "block", name: "block", shape: "box", size_mm: [20, 20, 30], symmetry: "none", role: "manipulated", pose: { xyz_mm: [230, -60, 15], yaw_deg: 20 } },
        { id: "pad", name: "pad", shape: "box", size_mm: [50, 50, 10], symmetry: "none", role: "fixture", pose: { xyz_mm: [200, 80, 5] } },
      ],
      steps: [
        { id: "s1", verb: "grasp", object: "block", t_start_s: 0, t_end_s: 1 },
        { id: "s2", verb: "place", object: "block", target: { fixture: "zone", frame: "pad" }, t_start_s: 1, t_end_s: 2 },
      ],
    });
    const program = Program.parse({
      spec_title: spec.title,
      steps: [
        {
          step_id: "s1",
          ops: [
            { op: "move_to", frame: "block", offset_mm: [0, 0, 40] },
            { op: "move_to", frame: "block", offset_mm: [0, 0, 8] },
            { op: "grasp", object: "block", aperture_mm: 20 },
            { op: "wait_until", predicate: { kind: "contact_both_pads", object: "block" }, timeout_s: 1 },
            { op: "move_to", frame: "block", offset_mm: [0, 0, 40] },
          ],
        },
        {
          step_id: "s2",
          ops: [
            // held: the block's centre goes 15 mm (half its height) plus 2 mm above the pad's 5 mm top
            { op: "move_to", frame: "pad", offset_mm: [0, 0, 22] },
            { op: "release" },
            { op: "wait_until", predicate: { kind: "object_still", object: "block" }, timeout_s: 2 },
            { op: "assert", predicate: { kind: "inside_zone", object: "block", target: "pad" } },
            { op: "assert", predicate: { kind: "tilt_under", object: "block", value: 5 } },
          ],
        },
      ],
    });
    const r = rollout(program, "sensed", undefined, spec);
    expect(r.pass, r.log.join("\n")).toBe(true);
  }, 60_000);
});
