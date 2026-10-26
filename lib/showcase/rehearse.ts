/**
 * The page's rehearsal, in node: what app/rehearsal.tsx asks the worker for
 * (reset, set gravity, run the program sensed from home, once per world), as
 * tests/sim/interpreter.test.ts drives the interpreter. A fresh model per
 * world is the worker's reset (the arm parked at home, the liquid filled when
 * the spec holds any); gravity is the same model option either way.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MainModule, MjVFS } from "@mujoco/mujoco";
import { environment, runToEnd } from "@/lib/sim/interpreter";
import { Liquid } from "@/lib/sim/liquid";
import { park, SO101_XML, stageXml } from "@/lib/sim/so101";
import { GRAVITIES, type GravityName, type Program, type TaskSpec } from "@/lib/spec/schema";
import type { Run } from "./session";

export const WORLDS: GravityName[] = ["earth", "orbit"];

export type Engine = { mujoco: MainModule; vfs: MjVFS };

export async function loadEngine(root = process.cwd()): Promise<Engine> {
  const { default: loadMujoco } = await import("@mujoco/mujoco");
  const mujoco = await loadMujoco();
  const dir = path.join(root, "assets", "so101");
  const vfs = new mujoco.MjVFS();
  vfs.addBuffer(SO101_XML, new Uint8Array(readFileSync(path.join(dir, SO101_XML))));
  for (const file of readdirSync(path.join(dir, "assets"))) vfs.addBuffer(file, new Uint8Array(readFileSync(path.join(dir, "assets", file))));
  return { mujoco, vfs };
}

export function rehearse({ mujoco, vfs }: Engine, spec: TaskSpec, program: Program, world: GravityName): Run {
  const env = environment(spec);
  const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: GRAVITIES[world], graspable: env.graspable }), vfs);
  const data = new mujoco.MjData(model);
  try {
    park(mujoco, model, data);
    const liquid = env.liquid ? new Liquid(mujoco, model, data, env.liquid, { gravity_g: GRAVITIES[world] }) : null;
    const r = runToEnd({ mujoco, model, data, liquid }, env, program, "sensed");
    return { pass: r.pass, failed_step_id: r.failed_step_id, failed_op: r.failed_op, failure_class: r.failure_class, why: r.why, t: Math.round(r.t * 1000) / 1000 };
  } finally {
    data.delete();
    model.delete();
  }
}

export function rehearseAll(engine: Engine, spec: TaskSpec, program: Program): Record<"earth" | "orbit", Run> {
  return { earth: rehearse(engine, spec, program, "earth"), orbit: rehearse(engine, spec, program, "orbit") };
}
