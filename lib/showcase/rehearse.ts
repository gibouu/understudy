/**
 * The page's rehearsal, in node: what app/rehearsal.tsx asks the worker for
 * (reset, set gravity, run the program sensed from home, once per world), as
 * tests/sim/interpreter.test.ts drives the interpreter. A fresh model per
 * world is the worker's reset; gravity is the same model option either way.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MainModule, MjVFS } from "@mujoco/mujoco";
import type { WorldRun } from "@/lib/notes/note";
import { environment, runToEnd, type Rollout } from "@/lib/sim/interpreter";
import { SO101_XML, stageXml } from "@/lib/sim/so101";
import { GRAVITIES, type GravityName, type Program, type TaskSpec } from "@/lib/spec/schema";
import type { Run } from "./session";

export const WORLDS = ["earth", "orbit"] as const satisfies readonly GravityName[];
export type World = (typeof WORLDS)[number];

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

/** One world's rollout in full: its log and where the objects ended are what /api/notes reads. */
export function rollout({ mujoco, vfs }: Engine, spec: TaskSpec, program: Program, world: GravityName): Rollout {
  const env = environment(spec);
  const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: GRAVITIES[world], graspable: env.graspable }), vfs);
  const data = new mujoco.MjData(model);
  try {
    return runToEnd({ mujoco, model, data }, env, program, "sensed");
  } finally {
    data.delete();
    model.delete();
  }
}

/** What a recording keeps of a rollout. */
export const summary = (r: Rollout): Run => ({ pass: r.pass, failed_step_id: r.failed_step_id, failed_op: r.failed_op, failure_class: r.failure_class, why: r.why, t: Math.round(r.t * 1000) / 1000 });

export const rehearse = (engine: Engine, spec: TaskSpec, program: Program, world: GravityName): Run => summary(rollout(engine, spec, program, world));

export function rehearseAll(engine: Engine, spec: TaskSpec, program: Program): Record<World, Run> {
  return { earth: rehearse(engine, spec, program, "earth"), orbit: rehearse(engine, spec, program, "orbit") };
}

/** Every world's full rollout, as the page hands them to the patch loop. */
export const rollouts = (engine: Engine, spec: TaskSpec, program: Program): (WorldRun & { world: World })[] => WORLDS.map((world) => ({ world, rollout: rollout(engine, spec, program, world) }));
