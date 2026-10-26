import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MainModule, MjVFS } from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import recordings from "@/tests/fixtures/compile.json";
import { POST } from "@/app/api/compile/route";
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

const [bare, answered] = recordings.map((r) => ({ spec: TaskSpec.parse(r.spec), program: Program.parse((r.result as { value: unknown }).value) }));
const asks = (p: Program) => p.steps.flatMap((s) => s.ops).filter((op) => op.op === "ask");

function rollout(spec: TaskSpec, program: Program, gravity_g: number) {
  const env = environment(spec, { id: "t", name: "t", axis: "x_mm", offset: 0, object: spec.objects[0].id, expected: "unknown", why: "", gravity_g });
  const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: env.gravity_g, graspable: env.graspable }), vfs);
  const data = new mujoco.MjData(model);
  try {
    return runToEnd({ mujoco, model, data }, env, program, "sensed");
  } finally {
    data.delete();
    model.delete();
  }
}

describe("Nano's recorded compile of the demo spec", () => {
  it("asks when the spec has gaps, and asks nothing once they are answered", () => {
    expect(asks(bare.program).length).toBeGreaterThan(0);
    expect(asks(answered.program)).toEqual([]);
  });

  it.each([
    [1, true],
    [0, false],
  ] as const)("runs at %s g: pass %s", (gravity_g, pass) => {
    const r = rollout(answered.spec, answered.program, gravity_g);
    expect(r.pass, r.log.join("\n")).toBe(pass);
  }, 60_000);
});

describe("POST /api/compile in replay", () => {
  const post = (body: unknown) => POST(new Request("http://x/api/compile?replay=1", { method: "POST", body: JSON.stringify(body) }));

  it("answers with the recording of the same spec", async () => {
    const res = await (await post({ spec: answered.spec })).json();
    expect(res.status).toBe("done");
    expect(Program.parse(res.value)).toEqual(answered.program);
  });

  it("refuses an invalid spec", async () => {
    const res = await post({ spec: { title: "x" } });
    expect(res.status).toBe(400);
  });
});
