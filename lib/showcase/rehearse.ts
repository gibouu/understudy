/**
 * The page's rehearsal, in node: what app/rehearsal.tsx asks the worker for
 * (reset, set gravity, run the program sensed from home, once per world), as
 * tests/sim/interpreter.test.ts drives the interpreter. A fresh model per
 * world is the worker's reset (the arm parked at home, the liquid filled when
 * the spec holds any); gravity is the same model option either way.
 */
import type { MainModule } from "@mujoco/mujoco";
import type { WorldRun } from "@/lib/notes/note";
import { environment, runToEnd, type Rollout } from "@/lib/sim/interpreter";
import { Liquid } from "@/lib/sim/liquid";
import { park, stageXml } from "@/lib/sim/so101";
import { loadSo101 } from "@/lib/sim/so101-disk";
import { GRAVITIES, type GravityName, type Program, type TaskSpec } from "@/lib/spec/schema";
import type { Run } from "./session";

export const WORLDS = ["earth", "orbit"] as const satisfies readonly GravityName[];
export type World = (typeof WORLDS)[number];

/** An engine with the SO-101 mounted in its file system: models compile from stageXml alone. */
export type Engine = { mujoco: MainModule };

export async function loadEngine(root = process.cwd()): Promise<Engine> {
  return { mujoco: await loadSo101(root) };
}

/** One world's rollout in full: its log and where the objects ended are what /api/notes reads. */
export function rollout({ mujoco }: Engine, spec: TaskSpec, program: Program, world: GravityName): Rollout {
  const env = environment(spec);
  const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: GRAVITIES[world], graspable: env.graspable }));
  const data = new mujoco.MjData(model);
  try {
    park(mujoco, model, data);
    const liquid = env.liquid ? new Liquid(mujoco, model, data, env.liquid, { gravity_g: GRAVITIES[world] }) : null;
    return runToEnd({ mujoco, model, data, liquid }, env, program, "sensed");
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
