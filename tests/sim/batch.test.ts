/**
 * The headless batch (lib/sim/batch.ts, issue #76) against the paced path the
 * worker takes for a single rollout: one model loaded per world, reset and
 * parked, gravity set at run time, the interpreter advanced one mj_step per
 * yield in ticks of uneven length. Both must give the same pass, the same
 * failing step and the same simulated time for every rollout.
 *
 *   node_modules/.bin/vitest run tests/sim/batch.test.ts --silent=false
 */
import type { MainModule, MjModel } from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import { runBatch, type BatchRollout } from "@/lib/sim/batch";
import { DEMO_PROGRAMS, DEMO_SPEC, POUR_PROGRAMS, POUR_SPEC } from "@/lib/sim/demo-spec";
import { environment, run, type Rollout } from "@/lib/sim/interpreter";
import { Liquid } from "@/lib/sim/liquid";
import { G_M_S2, park, stageXml } from "@/lib/sim/so101";
import { loadSo101 } from "@/lib/sim/so101-disk";
import { GRAVITIES, MODES, Scenario, type Program, type TaskSpec } from "@/lib/spec/schema";

let mujoco: MainModule;

beforeAll(async () => {
  mujoco = await loadSo101();
}, 60_000);

const compile = (xml: string): MjModel => mujoco.MjModel.from_xml_string(xml);
const sc = (id: string, axis: Scenario["axis"], offset: number, object: string) => Scenario.parse({ id, name: id, axis, offset, object, expected: "unknown" });
const SCENARIOS = [sc("pillow-x+6", "x_mm", 6, "pillow"), sc("pillow-y-2", "y_mm", -2, "pillow"), sc("film-x+10", "x_mm", 10, "film")];

/** The worker's paced path for one rollout: as load, reset and setGravity, then tick() in uneven slices. */
function paced(program: Program, r: BatchRollout, spec: TaskSpec = DEMO_SPEC): Rollout {
  const env = environment(spec, r.scenario);
  const model = compile(stageXml(env.worldbody, { gravity_g: env.gravity_g, graspable: env.graspable }));
  const data = new mujoco.MjData(model);
  try {
    const g = r.gravity_g ?? 1;
    const liquid = env.liquid ? new Liquid(mujoco, model, data, env.liquid, { gravity_g: env.gravity_g }) : null;
    // the run message's reset, then its gravity
    mujoco.mj_resetData(model, data);
    park(mujoco, model, data);
    liquid?.fill(model, data);
    (model.opt as { gravity: Float64Array }).gravity[2] = -(G_M_S2 * g);
    liquid?.setGravity(g);
    const dt = (model.opt as { timestep: number }).timestep;
    const it = run({ mujoco, model, data, liquid }, env, program, r.mode);
    // ticks of 1 to 7 steps: the result must not depend on how steps fall into ticks
    for (let tick = 0; ; tick++) {
      for (let s = 0; s < 1 + (tick % 7); s++) {
        const step = it.next();
        if (step.done) return step.value;
        mujoco.mj_step(model, data);
        liquid?.advance(model, data, dt);
      }
    }
  } finally {
    data.delete();
    model.delete();
  }
}

describe("the headless batch", () => {
  const rollouts: BatchRollout[] = [GRAVITIES.earth, GRAVITIES.orbit].flatMap((gravity_g) =>
    [undefined, ...SCENARIOS].flatMap((scenario) => MODES.map((mode) => ({ scenario, mode, gravity_g }))),
  );

  it.each(Object.keys(DEMO_PROGRAMS) as (keyof typeof DEMO_PROGRAMS)[])("gives the paced result for every rollout of %s", async (name) => {
    const program = DEMO_PROGRAMS[name];
    const heard: number[] = [];
    const batch = await runBatch(mujoco, compile, DEMO_SPEC, program, rollouts, { onResult: (r) => heard.push(r.index) });
    expect(heard).toEqual(rollouts.map((_, i) => i));
    for (const [i, r] of rollouts.entries()) {
      const b = batch[i];
      expect(b.error).toBeUndefined();
      const p = paced(program, r);
      const what = `${name} ${r.scenario?.id ?? "nominal"} ${r.mode} ${r.gravity_g} g`;
      expect({ pass: b.rollout!.pass, step: b.rollout!.failed_step_id, why: b.rollout!.why }, what).toEqual({ pass: p.pass, step: p.failed_step_id, why: p.why });
      expect(b.rollout!.t, what).toBeCloseTo(p.t, 9);
    }
  }, 300_000);

  it("gives the paced result with a liquid in the scene", async () => {
    const program = POUR_PROGRAMS.pour;
    const [b] = await runBatch(mujoco, compile, POUR_SPEC, program, [{ mode: "sensed" }]);
    const p = paced(program, { mode: "sensed" }, POUR_SPEC);
    expect(b.rollout?.liquid).toBeDefined();
    expect({ pass: b.rollout!.pass, why: b.rollout!.why, liquid: b.rollout!.liquid }).toEqual({ pass: p.pass, why: p.why, liquid: p.liquid });
  }, 300_000);

  it("tells blind from sensed: a 6 mm pillow offset fails blind and passes sensed", async () => {
    const [blind, sensed] = await runBatch(mujoco, compile, DEMO_SPEC, DEMO_PROGRAMS.hold_until_seated, [
      { scenario: SCENARIOS[0], mode: "blind" },
      { scenario: SCENARIOS[0], mode: "sensed" },
    ]);
    expect(blind.rollout?.pass).toBe(false);
    expect(sensed.rollout?.pass).toBe(true);
  }, 60_000);

  it("reports a world it cannot build as that rollout's error and runs the rest", async () => {
    const bad = sc("ghost", "x_mm", 5, "no-such-object");
    const out = await runBatch(mujoco, compile, DEMO_SPEC, DEMO_PROGRAMS.hold_until_seated, [{ scenario: bad, mode: "blind" }, { mode: "sensed" }]);
    expect(out).toHaveLength(2);
    expect(out[0].rollout).toBeUndefined();
    expect(out[0].error).toContain('unknown object "no-such-object"');
    expect(out[1].rollout?.pass).toBe(true);
  }, 60_000);

  it("samples the joints when asked, from t = 0 at the interval given", async () => {
    const [r] = await runBatch(mujoco, compile, DEMO_SPEC, DEMO_PROGRAMS.hold_until_seated, [{ mode: "sensed" }], { sample_s: 0.5 });
    const samples = r.samples!;
    expect(samples[0].t).toBe(0);
    expect(samples.length).toBe(Math.floor(r.rollout!.t / 0.5 + 1e-6) + 1);
    expect(samples[1].t).toBeCloseTo(0.5, 2);
  }, 60_000);

  it("runs 24 rollouts per gravity in seconds, not the 72 s the paced stage takes", async () => {
    const grid: BatchRollout[] = Array.from({ length: 12 }, (_, k) => sc(`pillow-x${k - 6}`, "x_mm", k - 6, "pillow")).flatMap((scenario) => MODES.map((mode) => ({ scenario, mode })));
    for (const gravity_g of [GRAVITIES.earth, GRAVITIES.orbit]) {
      const started = performance.now();
      const out = await runBatch(mujoco, compile, DEMO_SPEC, DEMO_PROGRAMS.hold_until_seated, grid.map((r) => ({ ...r, gravity_g })));
      const s = (performance.now() - started) / 1000;
      const simulated = out.reduce((sum, r) => sum + (r.rollout?.t ?? 0), 0);
      console.info(`batch: 24 rollouts at ${gravity_g} g in ${s.toFixed(2)} s wall clock, ${simulated.toFixed(1)} s simulated (${(simulated / s).toFixed(0)}x real time)`);
      expect(out.every((r) => r.rollout)).toBe(true);
      expect(s).toBeLessThan(30); // generous: the Mac is shared; the number logged is the measurement
    }
  }, 120_000);
});
