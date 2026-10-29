/**
 * Headless rehearsal: a list of rollouts of one program, run as fast as the
 * CPU allows instead of at the stage's pace (issue #76). Each rollout gets a
 * fresh MjData; the world of a scenario at a gravity is compiled once and
 * shared by its blind and sensed rollouts. The worker runs it on a "batch"
 * message, a test runs it directly; both pass their own `compile` (the worker's
 * engine has the SO-101 files mounted, a test hands MuJoCo a VFS).
 *
 * The stepping is runToEnd's: one mj_step (and liquid step) per yield of the
 * interpreter, as the paced worker does, so a rollout here is the rollout the
 * stage would play.
 */
import type { MainModule, MjModel } from "@mujoco/mujoco";
import type { Mode, Program, Scenario, TaskSpec } from "@/lib/spec/schema";
import { environment, run, type Environment, type Rollout } from "./interpreter";
import { Liquid } from "./liquid";
import { toNumbers } from "./names";
import { park, stageXml } from "./so101";

/** One rollout to run: the spec's world perturbed by `scenario` (none: nominal), told the poses of `mode`, at `gravity_g` (the scenario's when left out). */
export type BatchRollout = { scenario?: Scenario; mode: Mode; gravity_g?: number };

/** `qpos` sampled every `sample_s` simulated seconds, when asked: enough to replay a rollout as a strip. */
export type BatchSample = { t: number; qpos: number[] };

export type BatchResult = {
  /** its place in the list asked for */
  index: number;
  gravity_g: number;
  mode: Mode;
  scenario_id?: string;
  /** the rollout, or why it could not be set up (a scenario the scene builder refuses, say) */
  rollout?: Rollout;
  error?: string;
  /** wall-clock milliseconds this rollout took, its world's compile included when it was the first to need it */
  ms: number;
  samples?: BatchSample[];
};

export type BatchOptions = {
  /** simulated seconds between qpos samples; none when left out */
  sample_s?: number;
  /** heard after each rollout, in order */
  onResult?: (r: BatchResult) => void;
  /** awaited between rollouts: the worker yields here so its other messages are answered */
  between?: () => Promise<void>;
};

type World = { env: Environment; model: MjModel; gravity_g: number };

const worldKey = (r: BatchRollout, g: number) => `${g}|${r.scenario ? JSON.stringify(r.scenario) : "nominal"}`;

/** Run every rollout of `program` in `rollouts`; every MjModel and MjData made here is deleted before it returns. */
export async function runBatch(
  mujoco: MainModule,
  compile: (xml: string) => MjModel,
  spec: TaskSpec,
  program: Program,
  rollouts: BatchRollout[],
  options: BatchOptions = {},
): Promise<BatchResult[]> {
  const worlds = new Map<string, World | { error: string }>();
  const out: BatchResult[] = [];
  try {
    for (const [index, r] of rollouts.entries()) {
      const started = performance.now();
      const gravity_g = r.gravity_g ?? r.scenario?.gravity_g ?? 1;
      const base = { index, gravity_g, mode: r.mode, ...(r.scenario ? { scenario_id: r.scenario.id } : {}) };
      const key = worldKey(r, gravity_g);
      let world = worlds.get(key);
      if (!world) {
        try {
          const env = environment(spec, r.scenario);
          world = { env, model: compile(stageXml(env.worldbody, { gravity_g, graspable: env.graspable })), gravity_g };
        } catch (err) {
          world = { error: errorText(err) };
        }
        worlds.set(key, world);
      }
      let result: BatchResult;
      if ("error" in world) result = { ...base, error: world.error, ms: performance.now() - started };
      else {
        try {
          const { rollout, samples } = rolloutIn(mujoco, world, program, r.mode, options.sample_s);
          result = { ...base, rollout, ms: performance.now() - started, ...(samples ? { samples } : {}) };
        } catch (err) {
          result = { ...base, error: errorText(err), ms: performance.now() - started };
        }
      }
      out.push(result);
      options.onResult?.(result);
      if (options.between && index < rollouts.length - 1) await options.between();
    }
  } finally {
    for (const w of worlds.values()) if (!("error" in w)) w.model.delete();
  }
  return out;
}

/** One rollout from home on a fresh MjData of `world`, drained as runToEnd drains it. */
function rolloutIn(mujoco: MainModule, world: World, program: Program, mode: Mode, sample_s?: number): { rollout: Rollout; samples?: BatchSample[] } {
  const { env, model, gravity_g } = world;
  const data = new mujoco.MjData(model);
  try {
    park(mujoco, model, data);
    const liquid = env.liquid ? new Liquid(mujoco, model, data, env.liquid, { gravity_g }) : null;
    const dt = (model.opt as { timestep: number }).timestep;
    const samples: BatchSample[] | undefined = sample_s && sample_s > 0 ? [] : undefined;
    let t = 0;
    let next = 0;
    const it = run({ mujoco, model, data, liquid }, env, program, mode);
    for (let step = it.next(); ; step = it.next()) {
      if (samples && t >= next - 1e-9) {
        samples.push({ t, qpos: Array.from(toNumbers(data.qpos)) });
        next += sample_s!;
      }
      if (step.done) return { rollout: step.value, samples };
      mujoco.mj_step(model, data);
      liquid?.advance(model, data, dt);
      t += dt;
    }
  } finally {
    data.delete();
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
