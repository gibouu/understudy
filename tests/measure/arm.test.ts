/**
 * Measured numbers about what the rehearsal can do today: reach of the SO-101
 * under the IK as shipped, IK accuracy checked by forward kinematics, the wall
 * time to simulate rollouts at each gravity, and what the scene builder does
 * with twelve saboteur-style perturbations.
 *
 *   node_modules/.bin/vitest run tests/measure/arm.test.ts --silent=false
 *   MEASURE_WRITE=1 node_modules/.bin/vitest run tests/measure/arm.test.ts --silent=false
 *
 * --silent=false shows the markdown tables (vitest hides a passing test's
 * console). MEASURE_WRITE=1 also writes bench/results/arm-<name>.json.
 * MEASURE_GRID_MM sets the reach grid spacing (default 50; 25 takes about
 * 150 s on an M4). Timings are Node, single thread, on whatever else the
 * machine is doing: the load average at start is recorded with each result.
 * No interpreter, grasp or predicate runs here; a rollout is the arm
 * following a joint trajectory next to the demo scene.
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MainModule, MjData, MjModel, MjVFS } from "@mujoco/mujoco";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_SPEC } from "@/lib/sim/demo-spec";
import { IK_JOINTS, reachability, solveIk, type Approach, type IkResult } from "@/lib/sim/ik";
import { sampleWaypoints } from "@/lib/sim/names";
import type { Waypoint } from "@/lib/sim/protocol";
import { buildScene, perturb, SceneError, type SceneBuild, type Vec3 } from "@/lib/sim/scene";
import { SO101_HOME, SO101_JOINT_NAMES, SO101_TIP_SITE, SO101_XML, stageXml } from "@/lib/sim/so101";
import { APPROACHES, GRAVITIES, Scenario, type SpecObject } from "@/lib/spec/schema";

let mujoco: MainModule;
let vfs: MjVFS;
let armModel: MjModel;
let armData: MjData;
let fkData: MjData;
const loadavgAtStart = os.loadavg()[0];

beforeAll(async () => {
  const { default: loadMujoco } = await import("@mujoco/mujoco");
  mujoco = await loadMujoco();
  const dir = path.join(process.cwd(), "assets", "so101");
  vfs = new mujoco.MjVFS();
  vfs.addBuffer(SO101_XML, new Uint8Array(readFileSync(path.join(dir, SO101_XML))));
  for (const file of readdirSync(path.join(dir, "assets"))) vfs.addBuffer(file, new Uint8Array(readFileSync(path.join(dir, "assets", file))));
  armModel = mujoco.MjModel.from_xml_string(stageXml(""), vfs);
  armData = new mujoco.MjData(armModel);
  fkData = new mujoco.MjData(armModel);
}, 60_000);
afterAll(() => {
  fkData?.delete();
  armData?.delete();
  armModel?.delete();
  vfs?.delete();
});

// --- helpers -------------------------------------------------------------------
const HOME5 = SO101_HOME.slice(0, 5);
const round = (x: number, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : x);
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : "n/a");
/** nearest-rank quantile */
function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}
const median = (xs: number[]) => quantile(xs, 0.5);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function table(head: string[], rows: (string | number)[][]): string {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function machine() {
  let git_head = "unknown";
  try {
    git_head = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* not a checkout */
  }
  const mujocoVersion = JSON.parse(readFileSync(path.join(process.cwd(), "node_modules", "@mujoco", "mujoco", "package.json"), "utf8")).version;
  return {
    cpu: os.cpus()[0].model,
    cores: os.cpus().length,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    node: process.version,
    mujoco_wasm: mujocoVersion,
    threads_used: 1,
    loadavg_1m_at_start: round(loadavgAtStart),
    git_head,
  };
}

function writeResult(name: string, payload: Record<string, unknown>) {
  if (process.env.MEASURE_WRITE !== "1") return;
  const dir = path.join(process.cwd(), "bench", "results");
  mkdirSync(dir, { recursive: true });
  const body = { name: `arm-${name}`, measured_at: new Date().toISOString(), machine: machine(), ...payload };
  writeFileSync(path.join(dir, `arm-${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
}

const id = (model: MjModel, type: "joint" | "site" | "body", name: string) => {
  const t = { joint: mujoco.mjtObj.mjOBJ_JOINT, site: mujoco.mjtObj.mjOBJ_SITE, body: mujoco.mjtObj.mjOBJ_BODY }[type].value;
  const i = mujoco.mj_name2id(model, t, name);
  if (i < 0) throw new Error(`no ${type} named ${name}`);
  return i;
};
const armQposAdr = (model: MjModel) => SO101_JOINT_NAMES.map((n) => (model.jnt_qposadr as Int32Array)[id(model, "joint", n)]);
const f64 = (view: unknown) => view as Float64Array;

/** Sum of MuJoCo's warning counters (instability, contact overflow, ...) on this MjData. */
function mujocoWarnings(data: MjData): number {
  // the vector and its entries are views into the MjData, not owned handles: deleting them aborts
  const vec = data.warning;
  let n = 0;
  for (let k = 0; k < vec.size(); k++) n += vec.get(k)?.number ?? 0;
  return n;
}

/** Lowest point of an object's outer shape in world z, mm, from its built frame (negative: inside the table). */
function lowestPointMm(o: SpecObject, xyz_m: Vec3, quat: [number, number, number, number]): number {
  const [w, x, y, z] = quat;
  const r = [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]; // third row of R
  const [a, b, c] = o.size_mm;
  const drop =
    o.shape === "box"
      ? Math.abs(r[0]) * (a / 2) + Math.abs(r[1]) * (b / 2) + Math.abs(r[2]) * (c / 2)
      : o.shape === "cylinder"
        ? Math.abs(r[2]) * (c / 2) + (a / 2) * Math.hypot(r[0], r[1])
        : a / 2;
  return xyz_m[2] * 1000 - drop;
}

/** Arm at home, controls at home, derived quantities computed. */
function home(model: MjModel, data: MjData) {
  const adr = armQposAdr(model);
  const qpos = f64(data.qpos);
  adr.forEach((a, i) => (qpos[a] = SO101_HOME[i]));
  f64(data.ctrl).set(SO101_HOME);
  mujoco.mj_forward(model, data);
}

/** Where the tip site is for arm joints q (IK_JOINTS order): forward kinematics on a separate MjData. */
function fkTip(q: number[]): { p: number[]; a: number[] } {
  const adr = armQposAdr(armModel).slice(0, IK_JOINTS.length);
  const qpos = f64(fkData.qpos);
  qpos.fill(0);
  adr.forEach((a, i) => (qpos[a] = q[i]));
  mujoco.mj_kinematics(armModel, fkData);
  const s = id(armModel, "site", SO101_TIP_SITE);
  const p = Array.from(f64(fkData.site_xpos).slice(3 * s, 3 * s + 3));
  const m = f64(fkData.site_xmat);
  return { p, a: [m[9 * s], m[9 * s + 3], m[9 * s + 6]] };
}

// --- 1 + 2: the reach sweep, solved once and shared ----------------------------
const GRID_MM = Number(process.env.MEASURE_GRID_MM ?? 50);
const GRID = {
  x_m: [0.1, 0.4],
  y_m: [-0.25, 0.25],
  step_m: GRID_MM / 1000,
  z_m: [0.02, 0.06, 0.12],
};
type Solve = { target: Vec3; approach: Approach; r: IkResult; ms: number };
let sweep: Solve[] | null = null;
function reachSweep(): Solve[] {
  if (sweep) return sweep;
  const out: Solve[] = [];
  const n = (lo: number, hi: number) => Math.round((hi - lo) / GRID.step_m);
  for (const z of GRID.z_m)
    for (const approach of APPROACHES)
      for (let ix = 0; ix <= n(GRID.x_m[0], GRID.x_m[1]); ix++)
        for (let iy = 0; iy <= n(GRID.y_m[0], GRID.y_m[1]); iy++) {
          const target: Vec3 = [GRID.x_m[0] + ix * GRID.step_m, GRID.y_m[0] + iy * GRID.step_m, z].map((v) => round(v, 6)) as Vec3;
          // every point starts from home: a first target in a reachability pre-check, independent of grid order
          const t0 = performance.now();
          const r = solveIk(mujoco, armModel, armData, target, approach, HOME5);
          out.push({ target, approach, r, ms: performance.now() - t0 });
        }
  sweep = out;
  return out;
}

describe("arm measurements", () => {
  it("reach: fraction of a tabletop grid the IK solves, per height and approach", () => {
    const t0 = performance.now();
    const all = reachSweep();
    const seconds = (performance.now() - t0) / 1000;
    const key = (s: Solve) => `${s.target[0]},${s.target[1]},${s.target[2]}`;
    const rows: Record<string, unknown>[] = [];
    for (const z of GRID.z_m) {
      const atZ = all.filter((s) => s.target[2] === z);
      for (const approach of [...APPROACHES, "any"] as const) {
        let ok: number, tip: number, projection: number, points: number;
        if (approach === "any") {
          const byPoint = new Map<string, Solve[]>();
          for (const s of atZ) byPoint.set(key(s), [...(byPoint.get(key(s)) ?? []), s]);
          points = byPoint.size;
          ok = [...byPoint.values()].filter((ss) => ss.some((s) => s.r.ok)).length;
          tip = [...byPoint.values()].filter((ss) => ss.some((s) => s.r.pos_err_mm < 2)).length;
          projection = NaN;
        } else {
          const ss = atZ.filter((s) => s.approach === approach);
          points = ss.length;
          ok = ss.filter((s) => s.r.ok).length;
          tip = ss.filter((s) => s.r.pos_err_mm < 2).length;
          // the tip got there but the asked approach is more than 20 degrees out of the arm's pitch plane
          projection = ss.filter((s) => !s.r.ok && s.r.approach_deg > 20).length;
        }
        rows.push({ z_mm: z * 1000, approach, points, ok, ok_frac: round(ok / points, 3), tip_within_2mm: tip, tip_frac: round(tip / points, 3), rejected_for_approach_over_20deg: projection });
      }
    }
    console.log(
      `\n### reach (grid x ${GRID.x_m.join("-")} m, y ${GRID.y_m.join(" to ")} m, every ${GRID_MM} mm; ok = tip within 2 mm, axis within 2 deg, asked approach within 20 deg of the arm's pitch plane)\n` +
        table(
          ["z mm", "approach", "points", "ok", "ok %", "tip within 2 mm %", "approach > 20 deg"],
          rows.map((r) => [r.z_mm as number, r.approach as string, r.points as number, r.ok as number, pct(r.ok as number, r.points as number), pct(r.tip_within_2mm as number, r.points as number), Number.isNaN(r.rejected_for_approach_over_20deg) ? "-" : (r.rejected_for_approach_over_20deg as number)]),
        ) +
        `\n${all.length} solves in ${seconds.toFixed(1)} s`,
    );
    // sane: the demo's own targets are inside the grid's reach, and nothing out of range counts as ok
    expect(all.length).toBe(GRID.z_m.length * APPROACHES.length * (Math.round(0.3 / GRID.step_m) + 1) * (Math.round(0.5 / GRID.step_m) + 1));
    for (const s of all) if (s.r.ok) expect(s.r.pos_err_mm).toBeLessThan(2);
    const topLow = rows.find((r) => r.z_mm === 20 && r.approach === "top")!;
    expect(topLow.ok as number).toBeGreaterThan(0);
    writeResult("reach", {
      parameters: { ...GRID, seed: "SO101_HOME (each point solved alone)", solver: "lib/sim/ik.ts solveIk", ok_definition: "pos_err < 2 mm, axis_err < 2 deg, approach projection <= 20 deg", model: "stageXml('') arm only" },
      seconds_total: round(seconds, 2),
      rows,
      points: all.map((s) => ({ xyz_m: s.target, approach: s.approach, ok: s.r.ok, pos_err_mm: round(s.r.pos_err_mm, 3), approach_deg: round(s.r.approach_deg, 1) })),
    });
  }, 300_000);

  it("ik-accuracy: tip error by independent forward kinematics, and solve time", () => {
    const all = reachSweep();
    const rows: Record<string, unknown>[] = [];
    const ranges = Array.from(f64(armModel.jnt_range));
    for (const approach of [...APPROACHES, "all"] as const) {
      const ss = all.filter((s) => approach === "all" || s.approach === approach);
      const ok = ss.filter((s) => s.r.ok);
      const errs: number[] = [];
      const axisErrs: number[] = [];
      for (const s of ok) {
        const fk = fkTip(s.r.q);
        const e = dist(fk.p, s.target) * 1000;
        errs.push(e);
        axisErrs.push((Math.acos(Math.min(1, fk.a[0] * s.r.axis[0] + fk.a[1] * s.r.axis[1] + fk.a[2] * s.r.axis[2])) * 180) / Math.PI);
        // the solver's own report agrees with forward kinematics, and q is inside the joint ranges
        expect(Math.abs(e - s.r.pos_err_mm)).toBeLessThan(1e-6);
        s.r.q.forEach((v, i) => {
          expect(v).toBeGreaterThanOrEqual(ranges[2 * i] - 1e-9);
          expect(v).toBeLessThanOrEqual(ranges[2 * i + 1] + 1e-9);
        });
      }
      const failMs = ss.filter((s) => !s.r.ok).map((s) => s.ms);
      rows.push({
        approach,
        solved: ok.length,
        tip_err_mm: { median: round(median(errs), 3), p95: round(quantile(errs, 0.95), 3), max: round(Math.max(...errs), 3) },
        axis_err_deg: { median: round(median(axisErrs), 2), max: round(Math.max(...axisErrs), 2) },
        iterations_median: median(ok.map((s) => s.r.iterations)),
        solve_ms_ok: { median: round(median(ok.map((s) => s.ms)), 2), p95: round(quantile(ok.map((s) => s.ms), 0.95), 2) },
        solve_ms_not_ok: { n: failMs.length, median: round(median(failMs), 1), p95: round(quantile(failMs, 0.95), 1) },
      });
      if (ok.length) expect(Math.max(...errs)).toBeLessThan(2);
    }
    type R = { approach: string; solved: number; tip_err_mm: { median: number; p95: number; max: number }; axis_err_deg: { median: number; max: number }; solve_ms_ok: { median: number; p95: number }; solve_ms_not_ok: { n: number; median: number; p95: number } };
    console.log(
      "\n### ik-accuracy (solved points of the reach grid; error = |FK(q) - target| on a separate MjData)\n" +
        table(
          ["approach", "solved", "tip err median mm", "p95 mm", "max mm", "axis err median deg", "solve ms median (ok)", "p95 (ok)", "solve ms median (not ok)", "p95 (not ok)"],
          (rows as R[]).map((r) => [r.approach, r.solved, r.tip_err_mm.median, r.tip_err_mm.p95, r.tip_err_mm.max, r.axis_err_deg.median, r.solve_ms_ok.median, r.solve_ms_ok.p95, r.solve_ms_not_ok.median, r.solve_ms_not_ok.p95]),
        ),
    );
    writeResult("ik-accuracy", {
      parameters: { grid: GRID, check: "mj_kinematics on a separate MjData from the returned q; same MuJoCo model, so it checks the solver, not the model against the real arm" },
      rows,
    });
  }, 300_000);

  // --- 3: rehearsal throughput ------------------------------------------------------
  const ROLLOUT_S = 3;
  const ROLLOUTS = 24;
  const GRAVITY_LIST = [GRAVITIES.earth, GRAVITIES.moon, GRAVITIES.orbit];

  function compile(worldbody: string, gravity_g: number): { model: MjModel; ms: number } {
    const t0 = performance.now();
    const model = mujoco.MjModel.from_xml_string(stageXml(worldbody, { gravity_g }), vfs);
    return { model, ms: performance.now() - t0 };
  }
  /** Pocket opening + 50 mm, top, solved from home on a scratch MjData of `model`. */
  function aboveRack(model: MjModel, build: SceneBuild): { target: Vec3; r: IkResult } {
    const data = new mujoco.MjData(model);
    try {
      home(model, data);
      const s = id(model, "site", `${build.names.rack}_pocket`);
      const o = f64(data.site_xpos).slice(3 * s, 3 * s + 3);
      const target: Vec3 = [o[0], o[1], o[2] + 0.05];
      return { target, r: solveIk(mujoco, model, data, target, "top", HOME5) };
    } finally {
      data.delete();
    }
  }
  /** Fresh MjData, arm at home, ctrl follows the waypoints the way the worker's play loop does. */
  function rollout(model: MjModel, wp: Waypoint[], tubeName: string) {
    const t0 = performance.now();
    const data = new mujoco.MjData(model);
    home(model, data);
    const dt = (model.opt as unknown as { timestep: number }).timestep;
    const steps = Math.round(ROLLOUT_S / dt);
    for (let i = 0; i < steps; i++) {
      f64(data.ctrl).set(sampleWaypoints(wp, i * dt));
      mujoco.mj_step(model, data);
    }
    const ms = performance.now() - t0;
    mujoco.mj_kinematics(model, data);
    const tip = Array.from(f64(data.site_xpos).slice(3 * id(model, "site", SO101_TIP_SITE), 3 * id(model, "site", SO101_TIP_SITE) + 3));
    const tube = Array.from(f64(data.xpos).slice(3 * id(model, "body", tubeName), 3 * id(model, "body", tubeName) + 3));
    const finite = Array.from(f64(data.qpos)).every(Number.isFinite);
    const warnings = mujocoWarnings(data);
    data.delete();
    return { ms, steps, dt, tip, tube, finite, warnings };
  }
  const trajectory = (q5: number[]): Waypoint[] => {
    const q = [...q5, SO101_HOME[5]];
    return [
      { t: 0, q: [...SO101_HOME] },
      { t: 1.5, q },
      { t: ROLLOUT_S, q },
    ];
  };

  it("rehearsal-throughput: wall time for 24 rollouts of 3 s at 1 g, 0.1654 g and 0 g", () => {
    const build = buildScene(DEMO_SPEC);
    const rows: Record<string, unknown>[] = [];
    for (const g of GRAVITY_LIST) {
      const { model, ms: compileMs } = compile(build.worldbody, g);
      try {
        const { target, r } = aboveRack(model, build);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        const wp = trajectory(r.q);
        const warm = rollout(model, wp, build.names.tube); // untimed: first rollout on a fresh model
        const runs = Array.from({ length: ROLLOUTS }, () => rollout(model, wp, build.names.tube));
        const ms = runs.map((x) => x.ms);
        const total = ms.reduce((a, b) => a + b, 0) / 1000;
        const simulated = ROLLOUTS * ROLLOUT_S;
        for (const x of runs) {
          expect(x.finite).toBe(true);
          expect(x.steps).toBe(600);
        }
        const tipErr = dist(runs[0].tip, target) * 1000;
        const tubeDrift = dist(runs[0].tube, build.frames.tube.xyz_m) * 1000;
        rows.push({
          gravity_g: g,
          compile_ms: round(compileMs, 0),
          warmup_rollout_s: round(warm.ms / 1000, 4),
          s_per_rollout: { mean: round(mean(ms) / 1000, 4), min: round(Math.min(...ms) / 1000, 4), max: round(Math.max(...ms) / 1000, 4) },
          s_for_24: round(total, 2),
          real_time_factor: round(simulated / total, 1),
          steps_per_rollout: runs[0].steps,
          us_per_step: round((1000 * mean(ms)) / runs[0].steps, 1),
          tip_err_at_3s_mm: round(tipErr, 1),
          tube_moved_mm: round(tubeDrift, 1),
          mujoco_warnings: runs[0].warnings,
          identical_rollouts: runs.every((x) => dist(x.tip, runs[0].tip) === 0),
        });
      } finally {
        model.delete();
      }
    }
    type R = { gravity_g: number; compile_ms: number; s_per_rollout: { mean: number }; s_for_24: number; real_time_factor: number; us_per_step: number; tip_err_at_3s_mm: number; tube_moved_mm: number };

    // end to end per gravity: the 12 scenario worlds each compiled, then two rollouts each (blind on the
    // nominal IK solution, sensed re-solved on the perturbed pocket), IK included, no interpreter
    const e2e: Record<string, unknown>[] = [];
    for (const g of GRAVITY_LIST) {
      const t0 = performance.now();
      let compileMs = 0;
      let ikMs = 0;
      let simMs = 0;
      let rollouts = 0;
      const nominal = compile(build.worldbody, g);
      const blindQ = aboveRack(nominal.model, build).r.q;
      nominal.model.delete();
      for (const sc of SCENARIOS) {
        const p = perturb(DEMO_SPEC, { ...sc, gravity_g: g });
        const b = buildScene(p.spec, p.tilts);
        const c = compile(b.worldbody, g);
        compileMs += c.ms;
        try {
          const t1 = performance.now();
          const sensed = aboveRack(c.model, b);
          ikMs += performance.now() - t1;
          for (const q of [blindQ, sensed.r.q]) {
            const x = rollout(c.model, trajectory(q), b.names.tube);
            expect(x.finite).toBe(true);
            simMs += x.ms;
            rollouts++;
          }
        } finally {
          c.model.delete();
        }
      }
      const total = (performance.now() - t0) / 1000;
      e2e.push({ gravity_g: g, rollouts, scenario_worlds: SCENARIOS.length, s_total: round(total, 2), s_compile: round(compileMs / 1000, 2), s_ik: round(ikMs / 1000, 3), s_sim: round(simMs / 1000, 2), real_time_factor: round((rollouts * ROLLOUT_S) / total, 1) });
      expect(rollouts).toBe(24);
    }
    type E = { gravity_g: number; rollouts: number; s_total: number; s_compile: number; s_ik: number; s_sim: number; real_time_factor: number };
    const cpu = os.cpus()[0].model;
    console.log(
      `\n### rehearsal-throughput (demo scene + SO-101, ${ROLLOUT_S} s simulated per rollout, fresh MjData each, one model per gravity; Node single thread on ${cpu}, load avg ${loadavgAtStart.toFixed(1)} at start; the browser worker runs the same WASM but is not measured here)\n` +
        table(
          ["gravity g", "compile ms", "s per rollout", "s for 24", "real-time factor", "us per step", "tip err at 3 s mm", "tube moved mm"],
          (rows as R[]).map((r) => [r.gravity_g, r.compile_ms, r.s_per_rollout.mean, r.s_for_24, `${r.real_time_factor}x`, r.us_per_step, r.tip_err_at_3s_mm, r.tube_moved_mm]),
        ) +
        "\n\n#### end to end: 12 scenario worlds compiled, 2 rollouts each (blind, sensed), IK per world\n" +
        table(
          ["gravity g", "rollouts", "s total", "s compiling", "s IK", "s simulating", "real-time factor"],
          (e2e as E[]).map((r) => [r.gravity_g, r.rollouts, r.s_total, r.s_compile, r.s_ik, r.s_sim, `${r.real_time_factor}x`]),
        ),
    );
    writeResult("rehearsal-throughput", {
      parameters: {
        scene: "buildScene(DEMO_SPEC) inside stageXml, gravity_g per row",
        rollout_s: ROLLOUT_S,
        rollouts_per_gravity: ROLLOUTS,
        trajectory: "ctrl = linear interpolation (sampleWaypoints) home -> IK solution 50 mm above the rack pocket (top) by t=1.5 s, held to 3 s; gripper at home",
        timing: "performance.now() from new MjData to the last mj_step; one untimed warm-up rollout per model",
        note: "Node single thread; the browser worker is similar WASM but not measured here; rollouts within one gravity are identical (no interpreter, grasp or predicates)",
      },
      rows,
      end_to_end: { description: "per gravity: 12 perturbed scenario worlds compiled; per world one IK solve above the perturbed pocket and two rollouts (blind uses the nominal solution, sensed the re-solved one)", rows: e2e },
    });
  }, 300_000);

  // --- 4: scenario coverage ---------------------------------------------------------
  const sc = (id: string, axis: Scenario["axis"], offset: number, object: string, extra: Partial<Scenario> = {}) =>
    Scenario.parse({ id, name: id, axis, offset, object, expected: "unknown", why: "measurement", ...extra });
  const SCENARIOS: Scenario[] = [
    sc("rack-x+8", "x_mm", 8, "rack"),
    sc("rack-x-8", "x_mm", -8, "rack"),
    sc("rack-y+8", "y_mm", 8, "rack"),
    sc("tube-x+15", "x_mm", 15, "tube"),
    sc("tube-y-15", "y_mm", -15, "tube"),
    sc("rack-yaw+15", "yaw_deg", 15, "rack"),
    sc("tube-yaw+30", "yaw_deg", 30, "tube"),
    sc("rack-tilt-x5", "tilt_deg", 5, "rack", { tilt_axis: "x" }),
    sc("tube-tilt-y8", "tilt_deg", 8, "tube", { tilt_axis: "y" }),
    sc("rack-clearance-2", "clearance_mm", -2, "rack"),
    sc("moon-nominal", "x_mm", 0, "rack", { gravity_g: GRAVITIES.moon }),
    sc("orbit-nominal", "x_mm", 0, "rack", { gravity_g: GRAVITIES.orbit }),
  ];

  it("scenario-coverage: 12 saboteur-style scenarios through perturb, buildScene and MuJoCo", () => {
    const nominal = buildScene(DEMO_SPEC);
    const rows: Record<string, unknown>[] = [];
    for (const s of SCENARIOS) {
      const row: Record<string, unknown> = { id: s.id, axis: s.axis, offset: s.offset, object: s.object, gravity_g: s.gravity_g };
      try {
        const p = perturb(DEMO_SPEC, s);
        const b = buildScene(p.spec, p.tilts);
        const nf = nominal.frames[s.object];
        const pf = b.frames[s.object];
        const moved = dist(pf.xyz_m, nf.xyz_m) * 1000;
        const dq = Math.abs(nf.quat[0] * pf.quat[0] + nf.quat[1] * pf.quat[1] + nf.quat[2] * pf.quat[2] + nf.quat[3] * pf.quat[3]);
        const turned = (2 * Math.acos(Math.min(1, dq)) * 180) / Math.PI;
        const pocketChange = (b.pockets.rack.inner_m[0] - nominal.pockets.rack.inner_m[0]) * 1000;
        const obj = p.spec.objects.find((o) => o.id === s.object)!;
        const geometryDiffers = b.worldbody !== nominal.worldbody;
        const gravityDiffers = p.gravity_g !== 1;
        const noOp = p.warnings.some((w) => /changes nothing measurable|world is unchanged|nothing changed/.test(w));
        Object.assign(row, {
          applied: p.applied,
          warnings: [...p.warnings, ...b.warnings],
          geometry_differs: geometryDiffers,
          gravity_differs: gravityDiffers,
          moved_mm: round(moved, 1),
          turned_deg: round(turned, 1),
          pocket_inner_change_mm: round(pocketChange, 1),
          lowest_point_mm: round(lowestPointMm(obj, pf.xyz_m, pf.quat), 2),
          differs_measurably: p.applied && !noOp && (geometryDiffers || gravityDiffers),
          builds: true,
        });
        const c = compile(b.worldbody, p.gravity_g);
        const data = new mujoco.MjData(c.model);
        try {
          home(c.model, data);
          const ncon0 = data.ncon as number;
          const tubeId = id(c.model, "body", b.names.tube);
          const tube0 = Array.from(f64(data.xpos).slice(3 * tubeId, 3 * tubeId + 3));
          for (let i = 0; i < 100; i++) mujoco.mj_step(c.model, data); // 0.5 s, arm held at home
          mujoco.mj_kinematics(c.model, data);
          const tube1 = Array.from(f64(data.xpos).slice(3 * tubeId, 3 * tubeId + 3));
          const tubeTiltAfter = (Math.acos(Math.min(1, f64(data.xmat)[9 * tubeId + 8])) * 180) / Math.PI; // body z axis against world z
          const finite = Array.from(f64(data.qpos)).every(Number.isFinite);
          const warnCount = mujocoWarnings(data);
          const pre = reachability(mujoco, c.model, data, [
            { pos: [tube1[0], tube1[1], tube1[2]] as Vec3, approach: "top" },
            { pos: aboveRack(c.model, b).target, approach: "top" },
          ]);
          Object.assign(row, { loads: true, compile_ms: round(c.ms, 0), contacts_at_load: ncon0, stable_0_5s: finite && warnCount === 0, mujoco_warnings: warnCount, tube_settled_mm: round(dist(tube1, tube0) * 1000, 1), tube_tilt_after_0_5s_deg: round(tubeTiltAfter, 1), precheck_ok: pre.ok, precheck_pos_err_mm: pre.results.map((r) => round(r.pos_err_mm, 2)) });
        } finally {
          data.delete();
          c.model.delete();
        }
      } catch (err) {
        Object.assign(row, { builds: row.builds ?? false, loads: false, error: err instanceof SceneError ? `SceneError: ${err.message}` : String(err) });
      }
      rows.push(row);
    }
    const count = (k: string) => rows.filter((r) => r[k] === true).length;
    const summary = {
      scenarios: rows.length,
      applied_flag_true: count("applied"),
      differs_measurably: count("differs_measurably"),
      geometry_differs: count("geometry_differs"),
      builds: count("builds"),
      loads_in_mujoco: count("loads"),
      stable_0_5s: count("stable_0_5s"),
      precheck_ok: count("precheck_ok"),
      with_warnings: rows.filter((r) => (r.warnings as string[] | undefined)?.length).length,
      start_below_table: rows.filter((r) => (r.lowest_point_mm as number) < -0.01).length,
    };
    const yes = (v: unknown) => (v === true ? "yes" : v === false ? "no" : "-");
    console.log(
      "\n### scenario-coverage (DEMO_SPEC: tube 17 x 100 mm, rack 60 x 60 x 40 mm with a 3 mm clearance pocket)\n" +
        table(
          ["scenario", "applied", "differs", "moved mm", "turned deg", "pocket change mm", "lowest point z mm", "loads", "tube moved mm / tilt deg after 0.5 s", "pre-check ok", "warnings"],
          rows.map((r) => [r.id as string, yes(r.applied), yes(r.differs_measurably), (r.moved_mm as number) ?? "-", (r.turned_deg as number) ?? "-", (r.pocket_inner_change_mm as number) ?? "-", (r.lowest_point_mm as number) ?? "-", yes(r.loads), r.loads ? `${r.tube_settled_mm} / ${r.tube_tilt_after_0_5s_deg}` : "-", yes(r.precheck_ok), ((r.warnings as string[]) ?? [r.error as string]).join("; ") || "-"]),
        ) +
        `\n${summary.differs_measurably}/${summary.scenarios} differ measurably from nominal, ${summary.loads_in_mujoco}/${summary.scenarios} build and load next to the arm, ${summary.precheck_ok}/${summary.scenarios} pass the two-target reachability pre-check`,
    );
    expect(rows).toHaveLength(12);
    expect(summary.builds).toBe(12);
    expect(summary.loads_in_mujoco).toBe(summary.builds);
    writeResult("scenario-coverage", {
      parameters: {
        spec: "lib/sim/demo-spec.ts DEMO_SPEC",
        scenarios: SCENARIOS,
        differs_measurably: "perturb().applied, no 'changes nothing measurable' or 'world is unchanged' warning, and the built worldbody or the gravity differs from nominal",
        loads: "stageXml(buildScene(...).worldbody, { gravity_g }) compiles with the SO-101 and steps 0.5 s with the arm held at home without non-finite qpos",
        precheck: "reachability() from home: tube centre (after settling) and 50 mm above the pocket opening, both top",
      },
      summary,
      rows,
    });
  }, 300_000);
});
