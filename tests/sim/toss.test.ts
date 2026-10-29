/**
 * A toss and a catch with one arm (#159), measured: hand-written programs over a band of seeds, at 1 g and 0 g.
 *
 *   Earth (1 g): a 20 x 20 x 50 mm box stands on a 20 mm post in front of the arm; the gripper takes it from behind
 *   (front approach), carries it to (240, 0, 220) mm, throws it straight up at 1.3 m/s asked and catches it back in
 *   the same gripper, where the gripper stopped (catch with no point named).
 *   Orbit (0 g): a 20 x 30 x 40 mm box rests on the floor; the gripper takes it from above, pushes it across along +y
 *   at 0.1 m/s from y = -90 mm, lifts over its path and catches it at y = +90 mm: one arm reaching both points.
 *
 * Each seed moves the box's start by up to 3 mm on x and y (sensed: the program is told where it is), the kind of
 * pose error the saboteur's grid moves an object by. A catch counts only as the interpreter counts it: the jaws
 * stopped on the box within CATCH_JOINT_RAD of the angle they held it at, the grasp's own check holding. The counts
 * are pinned: the simulator is deterministic, so a change that moves them must say so in docs/MEASUREMENTS.md
 * section 17. MEASURE_WRITE=1 writes bench/results/toss-catch.json.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MainModule, MjVFS } from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import { environment, runToEnd, type Rollout } from "@/lib/sim/interpreter";
import { park, SO101_XML, stageXml } from "@/lib/sim/so101";
import { nearestPass, predict, wilson, type Release } from "@/lib/sim/toss";
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

describe("ballistic prediction (lib/sim/toss.ts)", () => {
  const g: [number, number, number] = [0, 0, -9.81];
  const up: Release = { t: 1, xyz_m: [0.2, 0, 0.2], v_m_s: [0, 0, 1] };
  it("is a parabola under gravity and a straight line in orbit", () => {
    const apex = predict(up, g, 1 + 1 / 9.81);
    expect(apex[2]).toBeCloseTo(0.2 + 1 / (2 * 9.81), 6);
    expect(predict({ ...up, v_m_s: [0, 0.1, 0] }, [0, 0, 0], 3)).toEqual([0.2, 0.2, 0.2]);
  });
  it("takes the pass coming down when a toss straight up passes the point twice", () => {
    const pass = nearestPass(up, g, [0.2, 0, 0.23], 1, 2, 0.001)!;
    expect(pass.off_m).toBeLessThan(0.001);
    expect(pass.t).toBeGreaterThan(1 + 1 / 9.81);
  });
  it("Wilson 95% interval", () => {
    const [lo, hi] = wilson(8, 10);
    expect(lo).toBeCloseTo(0.49, 2);
    expect(hi).toBeCloseTo(0.943, 2);
    expect(wilson(0, 10)[0]).toBe(0);
  });
});

const POST_H = 220;
const earthSpec = (dx: number, dy: number) =>
  TaskSpec.parse({
    version: 1,
    title: "toss up and catch",
    summary: "",
    objects: [
      { id: "item", name: "item", shape: "box", size_mm: [20, 20, 50], symmetry: "none", role: "manipulated", pose: { xyz_mm: [275 + dx, dy, POST_H + 25] } },
      { id: "post", name: "post", shape: "box", size_mm: [20, 20, POST_H], symmetry: "none", role: "surface", pose: { xyz_mm: [275, 0, POST_H / 2] } },
    ],
    steps: [{ id: "s1", verb: "grasp", object: "item", t_start_s: 0, t_end_s: 1 }],
  });
const earthProgram = Program.parse({
  spec_title: "toss up and catch",
  steps: [
    {
      step_id: "s1",
      ops: [
        { op: "move_to", frame: "item", offset_mm: [-60, 0, 0], approach: "front" },
        { op: "move_to", frame: "item", offset_mm: [0, 0, 0], approach: "front" },
        { op: "grasp", object: "item", aperture_mm: 20 },
        { op: "move_to", frame: "item", offset_mm: [0, 0, 20], approach: "front" },
        { op: "move_to", frame: "world", offset_mm: [240, 0, 220], approach: "front" },
        { op: "toss", velocity_mm_s: [0, 0, 1300], run_mm: 110, brake_mm: 35 },
        { op: "catch", object: "item" },
        { op: "wait_until", predicate: { kind: "contact_both_pads", object: "item" }, timeout_s: 0.5 },
      ],
    },
  ],
});
const orbitSpec = (dx: number, dy: number) =>
  TaskSpec.parse({
    version: 1,
    title: "push across and catch",
    summary: "",
    objects: [{ id: "item", name: "item", shape: "box", size_mm: [20, 30, 40], symmetry: "none", role: "manipulated", pose: { xyz_mm: [200 + dx, -90 + dy, 20] } }],
    steps: [{ id: "s1", verb: "grasp", object: "item", t_start_s: 0, t_end_s: 1 }],
  });
const orbitProgram = Program.parse({
  spec_title: "push across and catch",
  steps: [
    {
      step_id: "s1",
      ops: [
        { op: "move_to", frame: "item", offset_mm: [0, 0, 40], approach: "top" },
        { op: "move_to", frame: "item", offset_mm: [0, 0, 8], approach: "top" },
        { op: "grasp", object: "item", aperture_mm: 20 },
        { op: "move_to", frame: "world", offset_mm: [200, -90, 50], approach: "top" },
        { op: "toss", velocity_mm_s: [0, 100, 0], run_mm: 40, brake_mm: 20 },
        { op: "move_to", frame: "world", offset_mm: [200, 90, 90], approach: "top" },
        { op: "catch", object: "item", frame: "world", offset_mm: [200, 90, 50] },
        { op: "wait_until", predicate: { kind: "contact_both_pads", object: "item" }, timeout_s: 0.5 },
      ],
    },
  ],
});

/** the band: up to BAND_MM on x and y, from a fixed seed */
const BAND_MM = 3;
const SEEDS = 10;
function offsets(seed: number): [number, number] {
  // mulberry32
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  return [Math.round((2 * next() - 1) * BAND_MM * 10) / 10, Math.round((2 * next() - 1) * BAND_MM * 10) / 10];
}

function rollout(spec: TaskSpec, program: Program, gravity_g: number): Rollout {
  const env = environment(spec, { id: "t", name: "t", axis: "x_mm", offset: 0, object: "item", expected: "unknown", why: "", gravity_g });
  const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g, graspable: env.graspable }), vfs);
  const data = new mujoco.MjData(model);
  try {
    park(mujoco, model, data);
    return runToEnd({ mujoco, model, data }, env, program, "sensed");
  } finally {
    data.delete();
    model.delete();
  }
}

type Row = { seed: number; dx: number; dy: number; caught: boolean; why?: string; flight?: NonNullable<Rollout["flights"]>[number] };
function band(spec: (dx: number, dy: number) => TaskSpec, program: Program, gravity_g: number): Row[] {
  return Array.from({ length: SEEDS }, (_, seed) => {
    const [dx, dy] = offsets(seed + 1);
    const r = rollout(spec(dx, dy), program, gravity_g);
    const flight = r.flights?.[0];
    const caught = r.pass && flight?.catch?.held === true && r.end?.find((o) => o.object === "item")?.held === true;
    return { seed: seed + 1, dx, dy, caught, ...(caught ? {} : { why: r.why ?? r.log.findLast((l) => l.includes("catch")) }), ...(flight ? { flight } : {}) };
  });
}

/** measured on 29 October 2026 (docs/MEASUREMENTS.md section 17); a change that moves these says so there */
const PINNED = { earth: 8, orbit: 0 };

describe("a toss and a catch, measured over a band of seeds (#159)", () => {
  const results: Record<string, { caught: number; of: number; wilson95: [number, number]; rows: Row[] }> = {};
  it.each([
    ["earth", 1, earthSpec, earthProgram],
    ["orbit", 0, orbitSpec, orbitProgram],
  ] as const)("%s", (name, gravity_g, spec, program) => {
    const rows = band(spec, program, gravity_g);
    const caught = rows.filter((r) => r.caught).length;
    const [lo, hi] = wilson(caught, rows.length);
    results[name] = { caught, of: rows.length, wilson95: [lo, hi], rows };
    console.log(`| ${name} | ${caught} of ${rows.length} | ${(100 * lo).toFixed(0)}% to ${(100 * hi).toFixed(0)}% |`);
    for (const r of rows) console.log(`  seed ${r.seed} (${r.dx}, ${r.dy}) mm: ${r.caught ? "caught" : `missed: ${r.why}`}${r.flight ? `; off the pads ${r.flight.release.v_mm_s.join(", ")} mm/s` : ""}`);
    const thrown = rows.filter((r) => r.flight);
    const shut = thrown.filter((r) => r.flight?.catch?.shut_rad !== undefined);
    console.log(`  ${thrown.length} thrown; ${shut.length} where the jaws stopped on it, both pads touching, but narrower than they held it`);
    if (process.env.MEASURE_WRITE) {
      mkdirSync("bench/results", { recursive: true });
      writeFileSync("bench/results/toss-catch.json", `${JSON.stringify(results, null, 1)}\n`);
    }
    if (!Number.isNaN(PINNED[name])) expect(caught).toBe(PINNED[name]);
  }, 600_000);
});
