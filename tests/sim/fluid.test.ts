/**
 * Physics validations of the position-based fluid (lib/sim/fluid.ts) and its MuJoCo
 * coupling (lib/sim/fluid-mujoco.ts). Each validation prints a markdown table; with
 * MEASURE_WRITE=1 it also writes bench/results/fluid-<name>.json with its parameters.
 *
 * Particle counts are kept small (1,000 to 2,300 particles at 4 to 5 mm spacing) so the
 * whole file runs in well under two minutes on a laptop; the performance block measures
 * larger counts separately.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import { axisAngleToMat, create, matToQuat, quatToMat, type Aabb, type Fluid, type FluidParams } from "@/lib/sim/fluid";
import { bindMujocoGeoms } from "@/lib/sim/fluid-mujoco";
import { G_M_S2 } from "@/lib/sim/so101";

const G0 = G_M_S2; // the app's 1 g, 9.81 m/s^2
const BODIES = { earth: 1, mars: 0.379, moon: 0.1654, orbit: 0 } as const;
const FPS = 60;

// ---------------------------------------------------------------- reporting

type Cell = string | number;
function markdown(title: string, head: string[], rows: Cell[][], notes: string[] = []): string {
  const line = (r: Cell[]) => `| ${r.join(" | ")} |`;
  return [``, `**${title}**`, ``, line(head), line(head.map(() => "---")), ...rows.map(line), ...notes.map((n) => `_${n}_`), ``].join("\n");
}

/** Print the table (stdout shows for passing tests) and, with MEASURE_WRITE=1, write the JSON. */
function report(name: string, title: string, head: string[], rows: Cell[][], data: Record<string, unknown>, notes: string[] = []) {
  process.stdout.write(markdown(title, head, rows, notes) + "\n");
  if (process.env.MEASURE_WRITE === "1") {
    const dir = path.join(process.cwd(), "bench", "results");
    mkdirSync(dir, { recursive: true });
    const body = { name: `fluid-${name}`, title, measured_at: new Date().toISOString(), machine: cpus()[0]?.model ?? "unknown", node: process.version, head, rows, notes, ...data };
    writeFileSync(path.join(dir, `fluid-${name}.json`), JSON.stringify(body, null, 2) + "\n");
  }
}

const f2 = (v: number) => v.toFixed(2);
const f3 = (v: number) => v.toFixed(3);
const pct = (v: number) => `${(100 * v).toFixed(1)}%`;

// ---------------------------------------------------------------- scene helpers

/** Solid box walls around an inner box; the lid is optional, an open top is the default. */
function walls(f: Fluid, min: number[], max: number[], t: number, options: { lid?: boolean } = {}): number[] {
  const c = [0, 1, 2].map((a) => (min[a] + max[a]) / 2);
  const e = [0, 1, 2].map((a) => (max[a] - min[a]) / 2);
  const specs: [number[], number[]][] = [
    [[c[0], c[1], min[2] - t / 2], [e[0] + t, e[1] + t, t / 2]],
    [[min[0] - t / 2, c[1], c[2]], [t / 2, e[1] + t, e[2]]],
    [[max[0] + t / 2, c[1], c[2]], [t / 2, e[1] + t, e[2]]],
    [[c[0], min[1] - t / 2, c[2]], [e[0], t / 2, e[2]]],
    [[c[0], max[1] + t / 2, c[2]], [e[0], t / 2, e[2]]],
  ];
  if (options.lid) specs.push([[c[0], c[1], max[2] + t / 2], [e[0] + t, e[1] + t, t / 2]]);
  return specs.map(([pos, half]) => f.addSolid({ shape: { type: "box", halfSize: half }, pose: { position: pos } }));
}

function centroidStats(f: Fluid) {
  const p = f.positions, n = f.count;
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) c[a] += p[3 * i + a] / n;
  let r2 = 0, rmax = 0;
  for (let i = 0; i < n; i++) {
    const d2 = (p[3 * i] - c[0]) ** 2 + (p[3 * i + 1] - c[1]) ** 2 + (p[3 * i + 2] - c[2]) ** 2;
    r2 += d2 / n;
    rmax = Math.max(rmax, Math.sqrt(d2));
  }
  return { c, rms: Math.sqrt(r2), rmax };
}

/** Fraction of particles with fewer than `min` others within r: spray and stragglers. */
function isolatedFraction(f: Fluid, r: number, min: number): number {
  const p = f.positions, n = f.count;
  let iso = 0;
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (let j = 0; j < n && c < min; j++) {
      if (j === i) continue;
      const d2 = (p[3 * i] - p[3 * j]) ** 2 + (p[3 * i + 1] - p[3 * j + 1]) ** 2 + (p[3 * i + 2] - p[3 * j + 2]) ** 2;
      if (d2 < r * r) c++;
    }
    if (c < min) iso++;
  }
  return iso / n;
}

/** The solver's private neighbour search, for the brute-force check. */
type Internals = { buildGrid(p: Float64Array): void; findNeighbors(): void; nbr: Int32Array; nbrCount: Int32Array; maxNbr: number; x: Float64Array };

// ---------------------------------------------------------------- building blocks

describe("fluid solver building blocks", () => {
  it("finds exactly the brute-force neighbours, also with far spray that coarsens the grid", () => {
    for (const spray of [false, true]) {
      const f = create({ spacing: 0.005, maxNeighbors: 128 });
      let seed = 7;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const pts: number[] = [];
      for (let i = 0; i < 600; i++) pts.push(0.04 * rnd(), 0.04 * rnd(), 0.04 * rnd());
      if (spray) pts.push(3, -2, 5, -4, 1, 0.02, 3.004, -2, 5);
      f.addParticles(pts);
      const a = f as unknown as Internals;
      a.buildGrid(a.x);
      a.findNeighbors();
      const pos = a.x, h2 = f.h * f.h;
      let mismatches = 0, pairs = 0;
      for (let i = 0; i < f.count; i++) {
        const got = new Set(Array.from(a.nbr.subarray(i * a.maxNbr, i * a.maxNbr + a.nbrCount[i])));
        let want = 0;
        for (let j = 0; j < f.count; j++) {
          if (j === i) continue;
          const d2 = (pos[3 * i] - pos[3 * j]) ** 2 + (pos[3 * i + 1] - pos[3 * j + 1]) ** 2 + (pos[3 * i + 2] - pos[3 * j + 2]) ** 2;
          if (d2 < h2) {
            want++;
            if (!got.has(j)) mismatches++;
          }
        }
        if (want !== got.size) mismatches++;
        pairs += want;
      }
      expect(pairs).toBeGreaterThan(1000);
      expect(mismatches).toBe(0);
    }
  });

  it("reads rest density inside a lattice block and keeps the kernel mass apart from the physical mass", () => {
    const f = create({ spacing: 0.004 });
    f.addBlock({ min: [0, 0, 0], max: [0.048, 0.048, 0.048] });
    const st = f.densityStats();
    expect(st.interiorCount).toBeGreaterThan(100);
    expect(st.meanAbsInterior).toBeLessThan(1e-9);
    expect(f.particleMass).toBeCloseTo(1000 * 0.004 ** 3, 12);
    expect(f.volume).toBeCloseTo(12 ** 3 * 0.004 ** 3, 12);
  });

  it("round-trips rotations between matrices and quaternions", () => {
    const R = axisAngleToMat([0.3, -0.5, 0.8], 2.2);
    const back = Array.from(quatToMat(matToQuat(R)));
    back.forEach((v, i) => expect(v).toBeCloseTo(R[i], 12));
  });

  it("does not let a fast particle tunnel through a thin static or moving wall", () => {
    // a 2 mm wall and a particle at 6 m/s, which crosses it within one substep
    const f = create({ spacing: 0.005, gravity: [0, 0, 0] });
    f.addSolid({ shape: { type: "box", halfSize: [0.001, 0.05, 0.05] }, pose: { position: [0.01, 0, 0] } });
    f.addParticles([0, 0, 0], [6, 0, 0]);
    for (let k = 0; k < 10; k++) f.step(1 / FPS);
    expect(f.positions[0]).toBeLessThan(0.01);
    // the wall sweeps 6 cm toward -x in one frame, past a particle at rest: it carries the particle
    const g = create({ spacing: 0.005, gravity: [0, 0, 0] });
    const wall = g.addSolid({ shape: { type: "box", halfSize: [0.001, 0.05, 0.05] }, pose: { position: [0.03, 0, 0] } });
    g.addParticles([0, 0, 0]);
    g.setSolidPose(wall, { position: [-0.03, 0, 0] });
    g.step(1 / FPS);
    expect(g.positions[0]).toBeLessThan(-0.03);
  });

  it("bounces with the restitution asked for and holds or slides on a tilted plane by Coulomb's law", () => {
    // one particle dropped 5 cm onto a plane rebounds to e^2 of the drop
    for (const e of [0, 0.5]) {
      const f = create({ spacing: 0.005, cohesion: 0, restitution: e });
      f.addSolid({ shape: { type: "plane" }, pose: { position: [0, 0, 0] } });
      const r = f.collisionRadius;
      f.addParticles([0, 0, 0.05 + r]);
      let bounced = false, peak = 0;
      for (let k = 0; k < 90; k++) {
        f.step(1 / FPS);
        if (f.velocities[2] > 0) bounced = true;
        if (bounced) peak = Math.max(peak, f.positions[2] - r);
      }
      if (e === 0) expect(peak).toBeLessThan(0.001);
      else expect(Math.abs(peak / (0.05 * e * e) - 1)).toBeLessThan(0.15); // the incoming speed is taken at the substep start: O(g dt) low
    }
    // on a 20 degree slope: mu = 0.5 > tan 20 holds, mu = 0.2 slides at g (sin - mu cos)
    const theta = (20 * Math.PI) / 180;
    for (const mu of [0.5, 0.2, 0]) {
      const f = create({ spacing: 0.005, cohesion: 0, friction: mu });
      const R = axisAngleToMat([0, 1, 0], theta);
      f.addSolid({ shape: { type: "plane" }, pose: { position: [0, 0, 0], rotation: R } });
      const r = f.collisionRadius;
      f.addParticles([R[2] * r, R[5] * r, R[8] * r]); // resting on the plane
      for (let k = 0; k < FPS; k++) f.step(1 / FPS);
      const slid = Math.hypot(f.positions[0] - R[2] * r, f.positions[2] - R[8] * r);
      const a = mu >= Math.tan(theta) ? 0 : G0 * (Math.sin(theta) - mu * Math.cos(theta));
      if (a === 0) expect(slid).toBeLessThan(0.001);
      else expect(Math.abs(slid / (0.5 * a) - 1)).toBeLessThan(0.05);
    }
  });

  it("runs with vorticity confinement on without blowing up", () => {
    const f = create({ spacing: 0.005, vorticity: 0.5 });
    walls(f, [0, 0, 0], [0.08, 0.04, 0.1], 0.01);
    f.addBlock({ min: [0, 0, 0], max: [0.04, 0.04, 0.06] });
    for (let k = 0; k < 60; k++) f.step(1 / FPS);
    expect(f.countInBox({ min: [0, 0, 0], max: [0.08, 0.04, 0.1] })).toBe(f.count);
    expect(Number.isFinite(f.kineticEnergy())).toBe(true);
    expect(f.kineticEnergy()).toBeLessThan(0.01);
  });

  it("projects out of capsules, cylinders and a tilted box", () => {
    const f = create({ spacing: 0.004, gravity: [0, 0, -G0] });
    f.addSolid({ shape: { type: "cylinder", radius: 0.02, halfLength: 0.05 }, pose: { position: [0, 0, 0], rotation: axisAngleToMat([1, 0, 0], Math.PI / 2) } });
    f.addSolid({ shape: { type: "capsule", radius: 0.01, halfLength: 0.03 }, pose: { position: [0.1, 0, 0] } });
    f.addSolid({ shape: { type: "box", halfSize: [0.03, 0.03, 0.005] }, pose: { position: [0.2, 0, 0], rotation: axisAngleToMat([0, 1, 0], 0.3) } });
    f.addParticles([0.001, 0, 0.05, 0.1, 0, 0.06, 0.2, 0, 0.03]);
    for (let k = 0; k < 60; k++) f.step(1 / FPS);
    const p = f.positions, r = f.collisionRadius;
    // never inside the cylinder lying along y, nor inside the capsule standing along z
    expect(Math.hypot(p[0], p[2]) >= 0.02 + r - 1e-9 || Math.abs(p[1]) >= 0.05 + r - 1e-9).toBe(true);
    expect(Math.hypot(p[3] - 0.1, p[4], Math.max(0, Math.abs(p[5]) - 0.03))).toBeGreaterThanOrEqual(0.01 + r - 1e-9);
    // the box is tilted by 0.3 rad: a frictionless particle slides off it and falls
    expect(p[8]).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------- review regressions

/** Codex's review of the first version, one test per finding, built from its reproductions. */
describe("review regressions", () => {
  const halfTurn = (deg: number) => axisAngleToMat([0, 0, 1], (deg * Math.PI) / 180);

  it("P1 friction: a wall dragging a particle along the floor never leaves it inside either", () => {
    for (const mu of [0, 1]) {
      const f = create({ spacing: 0.001, gravity: [0, 0, -G0], friction: mu, cohesion: 0 });
      f.addSolid({ shape: { type: "plane" }, pose: { position: [0, 0, 0] } }); // floor, facing +z
      const R = axisAngleToMat([0, 1, 0], Math.PI / 2); // a plane facing +x
      const wall = f.addSolid({ shape: { type: "plane" }, pose: { position: [0, 0, 0], rotation: R } });
      f.addParticles([0.0005, 0, 0.0005]);
      f.setSolidPose(wall, { position: [0.01, 0, -0.01], rotation: R });
      f.step(1 / FPS);
      // before the fix, friction 1 left it at x = 0.008, 2 mm inside the wall
      expect(f.positions[0]).toBeGreaterThanOrEqual(0.0105 - 1e-9);
      expect(f.positions[2]).toBeGreaterThanOrEqual(0.0005 - 1e-9);
    }
  });

  it("P1 sweep: a fast thin wall cannot pass a particle at rest, whatever its speed", () => {
    const f = create({ spacing: 0.001, gravity: [0, 0, 0], cohesion: 0 });
    const wall = f.addSolid({ shape: { type: "box", halfSize: [0.001, 1, 1] }, pose: { position: [-0.1, 0, 0] } });
    f.addParticles([0, 0, 0]);
    f.setSolidPose(wall, { position: [0.3064, 0, 0] }); // 10 cm per substep through a 2 mm wall
    f.step(0.25);
    // before the fix the particle stayed at 0; now it rides in front of the wall
    expect(f.positions[0]).toBeGreaterThanOrEqual(0.3064 + 0.001 + 0.0005 - 1e-6);
  });

  it("P2 broad phase: a long box rotating through a particle hits it", () => {
    const f = create({ spacing: 0.001, gravity: [0, 0, 0], cohesion: 0 });
    const rod = f.addSolid({ shape: { type: "box", halfSize: [1, 0.001, 0.001] }, pose: { position: [0, 0, 0], rotation: halfTurn(-40) } });
    f.addParticles([0.9992, 0, 0]);
    f.setSolidPose(rod, { position: [0, 0, 0], rotation: halfTurn(50) });
    f.step(1 / FPS);
    // swept from -40 to +50 degrees: the particle is pushed ahead of the rod, not left on the x axis
    const [px, py] = [f.positions[0], f.positions[1]];
    expect(py).toBeGreaterThan(0.5);
    const c = Math.cos((50 * Math.PI) / 180), s = Math.sin((50 * Math.PI) / 180);
    expect(Math.abs(-s * px + c * py)).toBeGreaterThanOrEqual(0.0015 - 1e-6); // outside the rod at the end
  });

  it("P2 rotating frames: a particle beside a cylinder spinning on its axis is left alone", () => {
    const f = create({ spacing: 0.001, gravity: [0, 0, 0], cohesion: 0 });
    const disc = f.addSolid({ shape: { type: "cylinder", radius: 0.01, halfLength: 0.0001 }, pose: { position: [0, 0, 0] } });
    // just outside radius + collision radius, on a diagonal (inside the disc's bounding box)
    const rho = 0.0105 + 1e-5, start = [rho * Math.SQRT1_2, rho * Math.SQRT1_2, 0];
    f.addParticles(start);
    f.setSolidPose(disc, { position: [0, 0, 0], rotation: halfTurn(90) });
    f.step(1 / FPS);
    // before the fix the interpolated chord cut through the disc and kicked it
    expect(Math.hypot(f.velocities[0], f.velocities[1], f.velocities[2])).toBeLessThan(1e-9);
    start.forEach((v, k) => expect(f.positions[k]).toBeCloseTo(v, 12));
  });

  it("P2 corners: walls meeting at a corner count once (a rest lattice reads rho0 in corners, on edges, on faces)", () => {
    const d = 0.01;
    const f = create({ spacing: d, gravity: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] } });
    f.addBlock({ min: [0, 0, 0], max: [0.06, 0.06, 0.06] });
    const rho = f.densities();
    const at = (i: number, j: number, k: number) => rho[i + 6 * j + 36 * k] / 1000 - 1;
    // corner, edge, face, interior; before the fix the corner read 1087.88
    for (const e of [at(0, 0, 0), at(3, 0, 0), at(3, 3, 0), at(3, 3, 3)]) expect(Math.abs(e)).toBeLessThan(0.01);
    // the same against box walls (a cup corner: floor and two walls)
    const g = create({ spacing: d, gravity: [0, 0, 0] });
    walls(g, [0, 0, 0], [0.2, 0.2, 0.2], 0.02);
    g.addBlock({ min: [0, 0, 0], max: [0.06, 0.06, 0.06] });
    const rb = g.densities();
    for (const i of [0, 3, 21, 129]) expect(Math.abs(rb[i] / 1000 - 1)).toBeLessThan(0.01);
  });

  it("P2 thin walls: liquid does not feel liquid through a sealed 1 mm wall", () => {
    const d = 0.004, half = 0.0005;
    const make = (bothSides: boolean) => {
      const f = create({ spacing: d, gravity: [0, 0, 0] });
      f.addSolid({ shape: { type: "plane" }, pose: { position: [0, 0, 0] } });
      f.addSolid({ shape: { type: "box", halfSize: [half, 0.05, 0.05] }, pose: { position: [0, 0, 0.05] } });
      f.addBlock({ min: [-half - 6 * d, -0.012, 0], max: [-half, 0.012, 0.024] });
      if (bothSides) f.addBlock({ min: [half, -0.012, 0], max: [half + 6 * d, 0.012, 0.024] });
      return f.densities();
    };
    // the bottom-layer particle against the wall, mid-block: i = 5 (against the wall), j = 3, k = 0
    const idx = 5 + 6 * 3;
    const one = make(false)[idx], two = make(true)[idx];
    // before the fix: 1000 alone, 1141.31 with liquid behind the wall
    expect(Math.abs(one / 1000 - 1)).toBeLessThan(0.01);
    expect(Math.abs(two / one - 1)).toBeLessThan(0.001);
  });

  it("P2 parameters: degenerate ones are refused and a lone particle stays finite", () => {
    expect(() => create({ spacing: 0.005, kernelRatio: 1 })).toThrow(/kernelRatio/);
    expect(() => create({ spacing: 0 })).toThrow(/spacing/);
    expect(() => create({ spacing: 0.005, substeps: 0 })).toThrow(/substeps/);
    expect(() => create({ spacing: 0.005, cohesion: 2 })).toThrow(/cohesion/);
    expect(() => create({ spacing: 0.005, gravity: [0, Number.NaN, 0] })).toThrow(/gravity/);
    for (const extra of [{}, { relaxation: 0 }, { cohesion: 1, relaxation: 0 }] as Partial<FluidParams>[]) {
      const f = create({ spacing: 0.005, gravity: [0, 0, 0], ...extra });
      f.addParticles([0.1, 0.2, 0.3]);
      for (let k = 0; k < 10; k++) f.step(1 / FPS);
      expect(Array.from(f.positions)).toEqual([0.1, 0.2, 0.3]);
      // and next to a wall, where its lambda has only the wall's gradient to divide by
      const g = create({ spacing: 0.005, gravity: [0, 0, 0], ...extra });
      g.addSolid({ shape: { type: "plane" }, pose: { position: [0, 0, 0] } });
      g.addParticles([0, 0, 0.004]);
      for (let k = 0; k < 10; k++) g.step(1 / FPS);
      expect(Array.from(g.positions).every(Number.isFinite)).toBe(true);
      expect(g.positions[2]).toBeGreaterThanOrEqual(0.0025 - 1e-9);
    }
  });

  it("P2 speed cap: the velocities returned never exceed maxSpeed", () => {
    const f = create({ spacing: 0.005, gravity: [0, 0, 0], maxSpeed: 0.001 });
    f.addBlock({ min: [0, 0, 0], max: [0.012, 0.012, 0.012] }, 0.003); // 4 x 4 x 4 at 3 mm: squeezed
    const x0 = Array.from(f.positions);
    f.step(1 / 240);
    let vmax = 0, dmax = 0;
    for (let i = 0; i < f.count; i++) {
      vmax = Math.max(vmax, Math.hypot(f.velocities[3 * i], f.velocities[3 * i + 1], f.velocities[3 * i + 2]));
      dmax = Math.max(dmax, Math.hypot(f.positions[3 * i] - x0[3 * i], f.positions[3 * i + 1] - x0[3 * i + 1], f.positions[3 * i + 2] - x0[3 * i + 2]));
    }
    // before the fix: 2.2226 m/s
    expect(vmax).toBeLessThanOrEqual(0.001 * (1 + 1e-9));
    expect(dmax).toBeLessThanOrEqual((0.001 / 240) * (1 + 1e-9));
  });
});

/** Codex's second review: one test per fixed finding, built from its reproductions. */
describe("second review regressions", () => {
  const rot = (axis: number[], deg: number) => axisAngleToMat(axis, (deg * Math.PI) / 180);
  const mul = (A: number[], B: number[]) => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j]));

  it("R2-1 a moving box edge or sphere passing through a particle moves it, whatever the path length", () => {
    // box half [.001,.01,.01] from [-.0016,-.0092,0] to [.004,-.0148,0]: its edge sweeps the particle
    const f = create({ spacing: 0.001, gravity: [0, 0, 0], wallDensity: false, xsph: 0 });
    const box = f.addSolid({ shape: { type: "box", halfSize: [0.001, 0.01, 0.01] }, pose: { position: [-0.0016, -0.0092, 0] } });
    f.addParticles([0, 0, 0]);
    f.setSolidPose(box, { position: [0.004, -0.0148, 0] });
    f.step(1 / FPS);
    const [bx, by] = [f.positions[0], f.positions[1]];
    expect(Math.hypot(bx, by)).toBeGreaterThan(0.001); // before the fix: untouched
    const lx = bx - 0.004, ly = by + 0.0148;
    expect(Math.abs(lx) >= 0.0015 - 1e-9 || Math.abs(ly) >= 0.0105 - 1e-9).toBe(true); // outside at the end
    // sphere r .01 from [.005,-.0095,0] to [-.035,-.0095,0], passing 0.5 mm through the particle
    const g = create({ spacing: 0.001, gravity: [0, 0, 0], wallDensity: false, xsph: 0 });
    const ball = g.addSolid({ shape: { type: "sphere", radius: 0.01 }, pose: { position: [0.005, -0.0095, 0] } });
    g.addParticles([0, 0, 0]);
    g.setSolidPose(ball, { position: [-0.035, -0.0095, 0] });
    g.step(1 / FPS);
    const q = g.positions;
    expect(Math.hypot(q[0], q[1], q[2])).toBeGreaterThan(0.001);
    expect(Math.hypot(q[0] + 0.035, q[1] + 0.0095, q[2])).toBeGreaterThanOrEqual(0.0105 - 1e-9);
  });

  it("R2-3 a rotating plane that dips through a particle between two end poses pushes it", () => {
    const f = create({ spacing: 0.001, gravity: [0, 0, 0], wallDensity: false, xsph: 0 });
    const tilt = rot([0, 1, 0], 45);
    const plane = f.addSolid({ shape: { type: "plane" }, pose: { position: [0, 0, 0], rotation: mul(rot([0, 0, 1], -40), tilt) } });
    const p0 = [-0.0992546152, 0.0121869343, 0.0998585786]; // outside at both ends, inside at azimuth -7 degrees
    f.addParticles(p0);
    const end = mul(rot([0, 0, 1], 50), tilt);
    f.setSolidPose(plane, { position: [0, 0, 0], rotation: end });
    f.step(1 / FPS);
    const p = f.positions;
    const moved = Math.hypot(p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]);
    expect(moved).toBeGreaterThan(0.0003); // before the fix: unchanged
    expect(end[2] * p[0] + end[5] * p[1] + end[8] * p[2]).toBeGreaterThanOrEqual(0.0005 - 1e-9);
  });

  it("R2-5 the corner overlap is computed for the positions the pressure solve is at", () => {
    type W = {
      x: Float64Array; p: Float64Array; wallRho: Float64Array; wallGrad: Float64Array;
      holdSolids(c: boolean): void; buildGrid(p: Float64Array): void; findNeighbors(): void; collectWallPairs(p: Float64Array): void;
      filterThroughWalls(p: Float64Array): void; computeWallOverlap?(p: Float64Array): void; computeWallDensity(p: Float64Array): void;
    };
    const make = () => {
      const f = create({ spacing: 0.01, gravity: [0, 0, 0], substeps: 1, bounds: { min: [0, 0, 0], max: [1, 1, 1] } });
      f.addBlock({ min: [0.0025, 0.0025, 0.0025], max: [0.0225, 0.0225, 0.0225] }, 0.005);
      return f;
    };
    const f = make(), a = f as unknown as W, n = f.count;
    // a substep starts: neighbours and nearby surfaces at the predicted positions
    a.holdSolids(true);
    a.p.set(a.x.subarray(0, 3 * n));
    a.buildGrid(a.p); a.findNeighbors(); a.collectWallPairs(a.p); a.filterThroughWalls(a.p);
    a.computeWallOverlap?.(a.p); // the first version cached the overlap here
    // the pressure solve moves particle 21 (in the corner of three bounds) before the next iteration
    a.p[63] += 0.004; a.p[64] -= 0.002; a.p[65] += 0.003;
    a.computeWallDensity(a.p);
    const used = [a.wallRho[21], a.wallGrad[63], a.wallGrad[64], a.wallGrad[65]];
    // the same configuration, from scratch
    const g = make(), b = g as unknown as W;
    g.positions.set(a.p.subarray(0, 3 * n));
    g.densities();
    const fresh = [b.wallRho[21], b.wallGrad[63], b.wallGrad[64], b.wallGrad[65]];
    used.forEach((v, k) => expect(v).toBeCloseTo(fresh[k], 9));
  });

  it("R2-7 tensile settings that would overflow are refused; the most extreme accepted stay finite", () => {
    expect(() => create({ spacing: 0.005, gravity: [0, 0, 0], scorrDq: 0.99, scorrN: 64 })).toThrow(/scorr/);
    expect(() => create({ spacing: 0.005, scorrN: 9 })).toThrow(/scorrN/);
    expect(() => create({ spacing: 0.005, scorrDq: 0.6 })).toThrow(/scorrDq/);
    for (const extra of [{ scorrDq: 0.05, scorrN: 8 }, { scorrDq: 0.5, scorrN: 8 }, { scorrDq: 0.5, scorrN: 1, scorrK: 1 }] as Partial<FluidParams>[]) {
      const f = create({ spacing: 0.005, gravity: [0, 0, 0], ...extra });
      f.addParticles([0, 0, 0, 0.0001, 0, 0]);
      f.step(1 / FPS);
      expect(Array.from(f.positions).every(Number.isFinite)).toBe(true);
      expect(Array.from(f.velocities).every(Number.isFinite)).toBe(true);
    }
  });

  it("R2-8 one fast particle far away does not raise the rotating-sweep samples of the others", () => {
    const scene = (outlier: boolean) => {
      const f = create({ spacing: 0.001, gravity: [0, 0, 0], cohesion: 0, wallDensity: false, xsph: 0 });
      const plate = f.addSolid({ shape: { type: "box", halfSize: [0.05, 0.0005, 0.05] }, pose: { position: [0, 0, 0] } });
      const pts: number[] = [];
      for (let a = 0; a < 45; a++) for (let b = 0; b < 45; b++) pts.push(0.052, -0.044 + 0.002 * a, -0.044 + 0.002 * b); // 2,025 at rest beside the plate's sweep
      f.addParticles(pts);
      if (outlier) f.addParticles([1, 1, 1], [240, 0, 0]);
      f.setSolidPose(plate, { position: [0, 0, 0], rotation: rot([0, 0, 1], 20) });
      const t0 = performance.now();
      f.step(1 / FPS);
      return { samples: f.sweepSampleCount, ms: performance.now() - t0 };
    };
    const base = scene(false), withOutlier = scene(true);
    process.stdout.write(`R2-8 plate: ${base.samples} samples, ${base.ms.toFixed(1)} ms; with a 240 m/s particle at [1,1,1]: ${withOutlier.samples} samples, ${withOutlier.ms.toFixed(1)} ms\n`);
    expect(typeof withOutlier.samples).toBe("number");
    expect(base.samples).toBeGreaterThan(0);
    expect(withOutlier.samples).toBe(base.samples);
  });
});

/** Codex's third review: the two remaining gaps, built from its reproductions. */
describe("third review regressions", () => {
  const quiet = { spacing: 0.001, gravity: [0, 0, 0], wallDensity: false, xsph: 0, friction: 0, cohesion: 0 } as FluidParams;

  it("R3-1 a swept push from one solid never leaves the particle inside an earlier one", () => {
    const f = create(quiet);
    f.addSolid({ shape: { type: "plane" }, pose: { position: [0, -0.0005, 0], rotation: axisAngleToMat([1, 0, 0], -Math.PI / 2) } }); // clearance y >= 0
    const ball = f.addSolid({ shape: { type: "sphere", radius: 0.01 }, pose: { position: [0.007, 0.01047, 0] } });
    f.addParticles([0, 0, 0]);
    f.setSolidPose(ball, { position: [-0.001, 0.01047, 0] });
    f.step(1 / FPS);
    const p = f.positions;
    // before the fix: [-0.0000505794, -0.0001320096, 0], 132 um inside the plane's clearance
    expect(p[1]).toBeGreaterThanOrEqual(-1e-9);
    expect(Math.hypot(p[0] + 0.001, p[1] - 0.01047, p[2])).toBeGreaterThanOrEqual(0.0105 - 1e-9);
  });

  it("R3-2 a path starting in the sharp corner of the inflation but outside the rounded shape is still swept", () => {
    // box: the first substep's path starts 0.566 mm from the box edge (r = 0.5 mm) and crosses about 1 mm inside it
    const f = create({ spacing: 0.001, gravity: [0, 0, 0], wallDensity: false, xsph: 0 });
    const box = f.addSolid({ shape: { type: "box", halfSize: [0.001, 0.01, 0.01] }, pose: { position: [-0.0014, -0.0104, 0] } });
    f.addParticles([0, 0, 0]);
    f.setSolidPose(box, { position: [0.0106, 0.0112, 0] });
    f.step(1 / FPS);
    const p = f.positions;
    expect(Math.hypot(p[0], p[1], p[2])).toBeGreaterThan(0.0005); // before the fix: exactly 0
    const lx = p[0] - 0.0106, ly = p[1] - 0.0112;
    expect(Math.hypot(Math.max(0, Math.abs(lx) - 0.001), Math.max(0, Math.abs(ly) - 0.01))).toBeGreaterThanOrEqual(0.0005 - 1e-6);
  });

  it("R3-2 the same around a cylinder's rim", () => {
    const g = create({ spacing: 0.001, gravity: [0, 0, 0], wallDensity: false, xsph: 0 });
    const can = g.addSolid({ shape: { type: "cylinder", radius: 0.01, halfLength: 0.01 }, pose: { position: [-0.0104, 0, -0.0104] } });
    g.addParticles([0, 0, 0]);
    g.setSolidPose(can, { position: [-0.0104 + 0.048, 0, -0.0104 + 0.0864] }); // the first substep's path crosses the rim
    g.step(1 / FPS);
    const q = g.positions;
    expect(Math.hypot(q[0], q[1], q[2])).toBeGreaterThan(0.0005);
    const cx = q[0] - (-0.0104 + 0.048), cz = q[2] - (-0.0104 + 0.0864);
    expect(Math.hypot(Math.max(0, Math.hypot(cx, q[1]) - 0.01), Math.max(0, Math.abs(cz) - 0.01))).toBeGreaterThanOrEqual(0.0005 - 1e-6);
  });
});

/** The two limits the owner asked to remove: outlier-sensitive grid, capped rotating sweep. */
describe("removed limits", () => {
  it("A: one particle a metre or ten metres away does not change the neighbour search's work", () => {
    const scene = (far: number) => {
      const f = create({ spacing: 0.005 });
      walls(f, [0, 0, 0], [0.12, 0.06, 0.15], 0.01);
      f.addBlock({ min: [0, 0, 0], max: [0.06, 0.06, 0.07] });
      if (far) f.addParticles([far, far, far]); // a splashed drop, far from everything
      for (let k = 0; k < 5; k++) f.step(1 / FPS);
      const c0 = f.neighborCandidates, times: number[] = [];
      for (let k = 0; k < 7; k++) {
        const t0 = performance.now();
        f.step(1 / FPS);
        times.push(performance.now() - t0);
      }
      return { work: f.neighborCandidates - c0, table: f.gridTableSize, ms: [...times].sort((x, y) => x - y)[3] };
    };
    const base = scene(0), m1 = scene(1), m10 = scene(10);
    process.stdout.write(`A grid: ${base.work} candidates, ${base.ms.toFixed(1)} ms/frame alone; +1 m: ${m1.work}, ${m1.ms.toFixed(1)} ms; +10 m: ${m10.work}, ${m10.ms.toFixed(1)} ms (table ${base.table} / ${m1.table} / ${m10.table}; timing reported, not asserted)\n`);
    for (const r of [m1, m10]) {
      // the far particle only adds its own cell (itself, 4 substeps x 7 frames); the table does not grow
      expect(r.work).toBeGreaterThanOrEqual(base.work);
      expect(r.work).toBeLessThanOrEqual(base.work + 64);
      expect(r.table).toBe(base.table);
    }
  });

  it("B: a rod too thin and fast for 512 samples is swept exactly (conservative advancement)", () => {
    const cases = [
      { half: 0.00001, spacing: 0.0001, from: -40, to: 50, substeps: 4 }, // Codex's repro
      { half: 0.000001, spacing: 0.00001, from: -60, to: 60, substeps: 1 }, // ten times thinner, 120 degrees in one substep
    ];
    for (const c of cases) {
      const f = create({ spacing: c.spacing, gravity: [0, 0, 0], cohesion: 0, wallDensity: false, xsph: 0, substeps: c.substeps });
      const rot = (deg: number) => axisAngleToMat([0, 0, 1], (deg * Math.PI) / 180);
      const rod = f.addSolid({ shape: { type: "box", halfSize: [1, c.half, c.half] }, pose: { position: [0, 0, 0], rotation: rot(c.from) } });
      f.addParticles([0.9992, 0, 0]);
      f.setSolidPose(rod, { position: [0, 0, 0], rotation: rot(c.to) });
      f.step(1 / FPS);
      const [px, py] = [f.positions[0], f.positions[1]];
      const a = (c.to * Math.PI) / 180;
      // swept along in front of the rod to its end pose, not passed through
      expect(py).toBeGreaterThan(0.9 * Math.sin(a));
      expect(-Math.sin(a) * px + Math.cos(a) * py).toBeGreaterThanOrEqual(c.half + c.spacing / 2 - 1e-9);
      expect(f.advanceCount).toBeGreaterThan(0); // the exact fallback ran
    }
  });
});

// ---------------------------------------------------------------- validations

describe("liquid physics validations", () => {
  // a. a block settles in a box at 1 g
  it("a. rest: a dam-break block settles at rest density without losing a particle", () => {
    const d = 0.005, L = 0.12, W = 0.06, H = 0.15;
    const params: FluidParams = { spacing: d };
    const f = create(params);
    walls(f, [0, 0, 0], [L, W, H], 0.01);
    f.addBlock({ min: [0, 0, 0], max: [0.06, W, 0.08] }, d, { jitter: 0.05 });
    const n = f.count;
    const seconds = 3;
    const t0 = performance.now();
    for (let k = 0; k < seconds * FPS; k++) f.step(1 / FPS);
    const msFrame = (performance.now() - t0) / (seconds * FPS);
    const st = f.densityStats();
    const inside = f.countInBox({ min: [0, 0, 0], max: [L, W, H] });
    // liquid height from the top particle of each column (centres sit about d/2 under the surface);
    // bins of d sometimes miss the top particle (reads low), bins of 2d pick the highest of four (reads high)
    const p = f.positions;
    const heightFrom = (bin: number) => {
      const nx = Math.round(L / bin), ny = Math.round(W / bin);
      const top = new Float64Array(nx * ny).fill(-Infinity);
      for (let i = 0; i < n; i++) {
        const ix = Math.min(nx - 1, Math.max(0, Math.floor(p[3 * i] / bin))), iy = Math.min(ny - 1, Math.max(0, Math.floor(p[3 * i + 1] / bin)));
        top[ix + nx * iy] = Math.max(top[ix + nx * iy], p[3 * i + 2]);
      }
      return top.reduce((s, v) => s + v, 0) / top.length + d / 2;
    };
    const volErr = [d, 2 * d].map((bin) => (heightFrom(bin) * L * W) / f.volume - 1);
    const ke = f.kineticEnergy();
    report(
      "rest",
      `a. Rest: ${n} particles (d = ${d * 1000} mm) dam-break in a ${L * 100} x ${W * 100} cm box at 1 g, after ${seconds} s`,
      ["quantity", "measured", "tolerance"],
      [
        ["particles inside the box", `${inside} / ${n}`, `${n} / ${n}`],
        ["mean compression max(0, rho/rho0 - 1)", pct(st.meanCompression), "< 3%"],
        [`mean abs density error, interior (${st.interiorCount} particles)`, pct(st.meanAbsInterior), "< 3%"],
        ["max compression (bottom layer)", pct(st.maxCompression), "reported"],
        ["volume from the surface height vs n d^3 (bins of d / 2d)", `${pct(volErr[0])} / ${pct(volErr[1])}`, "reported (see note)"],
        ["kinetic energy (J)", ke.toExponential(2), "< 1e-4"],
        ["ms per 1/60 s frame (4 substeps x 4 iterations)", msFrame.toFixed(1), "reported"],
      ],
      { params: { spacing: d, substeps: f.substeps, iterations: f.iterations, cohesion: f.cohesion, xsph: f.xsph, scorrK: f.scorrK, box_m: [L, W, H], block_m: [0.06, W, 0.08], seconds }, results: { n, inside, density: st, volume_error_bins_d_2d: volErr, kinetic_energy_J: ke, ms_per_frame: msFrame } },
      [
        "Volume from the height is not asserted: about 2 points of it are the 4 x 4 budget's compression (it falls to -3.4% at 16 iterations, where the kernel compression is 0.14%),",
        "the rest is where a disordered particle surface sits against the lattice convention 'top centre + d/2', which this 5 mm resolution cannot settle. Count about 0.95 d^3 of liquid per particle.",
      ],
    );
    expect(inside).toBe(n);
    expect(st.meanCompression).toBeLessThan(0.03);
    expect(st.meanAbsInterior).toBeLessThan(0.03);
    expect(ke).toBeLessThan(1e-4);
  }, 60_000);

  // b and c. drain through a slot at the bottom of one wall of a 6 x 6 cm tank
  const DRAIN = { d: 0.005, W: 0.06, slot: 0.015, t: 0.01, fill: 0.07 };
  function drain(gScale: number, maxSeconds: number) {
    const { d, W, slot, t, fill } = DRAIN;
    const f = create({ spacing: d, gravity: [0, 0, -G0 * gScale], bounds: { min: [-0.03, -0.03, -0.2], max: [0.5, 0.09, 0.25] } });
    const box = (c: number[], e: number[]) => f.addSolid({ shape: { type: "box", halfSize: e }, pose: { position: c } });
    box([W / 2, W / 2, -t / 2], [W / 2 + t, W / 2 + t, t / 2]); // floor, reaching under the outlet wall
    box([-t / 2, W / 2, 0.075], [t / 2, W / 2 + t, 0.075]);
    box([W / 2, -t / 2, 0.075], [W / 2, t / 2, 0.075]);
    box([W / 2, W + t / 2, 0.075], [W / 2, t / 2, 0.075]);
    box([W + t / 2, W / 2, (slot + 0.15) / 2], [t / 2, W / 2 + t, (0.15 - slot) / 2]); // outlet wall above the slot
    const gate = box([W + t / 2, W / 2, slot / 2], [t / 2, W / 2, slot / 2]);
    f.addBlock({ min: [0, 0, 0], max: [W, W, fill] }, d, { jitter: 0.05 });
    f.relax(10);
    const n = f.count;
    // settle with the gate shut, for a time that scales like the flow itself
    const settle = gScale > 0 ? 0.5 / Math.sqrt(gScale) : 0.25;
    for (let k = 0; k < Math.round(settle * FPS); k++) f.step(1 / FPS);
    const shape0 = centroidStats(f);
    f.setSolidEnabled(gate, false);
    const tank: Aabb = { min: [-1, -1, -0.001], max: [W + t, 1, 1] };
    let t50 = NaN, t90 = NaN, prev = 0;
    const frames = Math.round(maxSeconds * FPS);
    for (let k = 1; k <= frames; k++) {
      f.step(1 / FPS);
      const left = 1 - f.countInBox(tank) / n;
      const time = k / FPS;
      const cross = (q: number) => time - (left - q) / Math.max(1e-12, left - prev) / FPS; // linear between frames
      if (Number.isNaN(t50) && left >= 0.5) t50 = cross(0.5);
      if (Number.isNaN(t90) && left >= 0.9) {
        t90 = cross(0.9);
        break;
      }
      prev = left;
    }
    return { f, n, t50, t90, left: 1 - f.countInBox(tank) / n, shape0, settle };
  }
  let moonT90 = NaN;

  it("b. pour time versus gravity: drain time scales like 1/sqrt(g) (Torricelli)", () => {
    const res = (["earth", "mars", "moon"] as const).map((body) => {
      const g = BODIES[body];
      return { body, g, ...drain(g, 4 / Math.sqrt(g)) };
    });
    const earth = res[0];
    moonT90 = res[2].t90;
    const rows = res.map((r) => {
      const theory = Math.sqrt(1 / r.g);
      const r50 = r.t50 / earth.t50, r90 = r.t90 / earth.t90;
      return [r.body, f2(G0 * r.g), f3(r.t50), f3(r.t90), f3(r50), f3(r90), f3(theory), pct(r50 / theory - 1), pct(r90 / theory - 1)];
    });
    report(
      "drain",
      `b. Drain of ${res[0].n} particles (d = 5 mm, 7 cm deep in a 6 x 6 cm tank) through a 1.5 x 6 cm slot at the foot of one wall`,
      ["body", "g (m/s^2)", "t50 (s)", "t90 (s)", "t50 / Earth", "t90 / Earth", "Torricelli sqrt(g_E/g)", "t50 dev", "t90 dev"],
      rows,
      { params: { ...DRAIN, solver: "defaults", settle_s: res.map((r) => r.settle) }, results: res.map((r) => ({ body: r.body, g: r.g, t50: r.t50, t90: r.t90 })) },
      ["Times from the gate opening, interpolated between frames; tolerance 20% on each ratio."],
    );
    for (const r of res.slice(1)) {
      const theory = Math.sqrt(1 / r.g);
      expect(Math.abs(r.t50 / earth.t50 / theory - 1)).toBeLessThan(0.2);
      expect(Math.abs(r.t90 / earth.t90 / theory - 1)).toBeLessThan(0.2);
    }
  }, 60_000);

  it("c. orbit: at 0 g the same tank does not drain and the liquid stays one blob", () => {
    const seconds = Number.isFinite(moonT90) ? moonT90 * 1.2 : 2.7; // longer than the Moon's 90% drain
    const r = drain(0, seconds);
    const end = centroidStats(r.f);
    const iso = isolatedFraction(r.f, r.f.h, 3);
    const drift = Math.hypot(end.c[0] - r.shape0.c[0], end.c[1] - r.shape0.c[1], end.c[2] - r.shape0.c[2]);
    const ke = r.f.kineticEnergy();
    report(
      "orbit",
      `c. Orbit (0 g): the same tank, gate open for ${f2(seconds)} s (1.2 x the Moon's t90)`,
      ["quantity", "measured", "tolerance"],
      [
        ["fraction drained", pct(r.left), "< 5%"],
        ["rms radius about the centroid (mm)", `${(r.shape0.rms * 1000).toFixed(1)} -> ${(end.rms * 1000).toFixed(1)}`, "within 10%"],
        ["farthest particle from the centroid (mm)", `${(r.shape0.rmax * 1000).toFixed(1)} -> ${(end.rmax * 1000).toFixed(1)}`, "reported"],
        ["particles with < 3 neighbours within h", pct(iso), "< 2%"],
        ["centroid drift (mm)", (drift * 1000).toFixed(1), "reported"],
        ["kinetic energy (J)", ke.toExponential(2), "reported"],
      ],
      { params: { ...DRAIN, seconds, solver: "defaults" }, results: { drained: r.left, rms0: r.shape0.rms, rms1: end.rms, rmax0: r.shape0.rmax, rmax1: end.rmax, isolated: iso, centroid_drift_m: drift, kinetic_energy_J: ke } },
      ["The drift is the blob rounding itself (weak cohesion) and pushing off the floor; with no wall adhesion nothing holds it down."],
    );
    expect(r.left).toBeLessThan(0.05);
    expect(Math.abs(end.rms / r.shape0.rms - 1)).toBeLessThan(0.1);
    expect(iso).toBeLessThan(0.02);
  }, 60_000);

  // c2. the orbit check above passes for frozen liquid too; this one needs a working liquid
  it("c2. orbit control: a 0 g blob thrown at a wall splashes like a liquid, unlike pressureless dust", () => {
    const v0 = 0.3;
    const run = (extra: Partial<FluidParams>) => {
      const d = 0.004;
      const f = create({ spacing: d, gravity: [0, 0, 0], ...extra });
      f.addSolid({ shape: { type: "box", halfSize: [0.005, 0.08, 0.08] }, pose: { position: [0.085, 0.02, 0.02] } }); // face at x = 8 cm
      f.addBlock({ min: [0, 0, 0], max: [0.04, 0.04, 0.04] }, d, { jitter: 0.05 });
      f.relax(10);
      const n = f.count, v = f.velocities;
      for (let i = 0; i < n; i++) v[3 * i] = v0;
      const meanVelocity = () => {
        const P = [0, 0, 0];
        for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) P[a] += f.velocities[3 * i + a] / n;
        return P;
      };
      const lateral = () => {
        const p = f.positions;
        let cy = 0, cz = 0, s2 = 0;
        for (let i = 0; i < n; i++) { cy += p[3 * i + 1] / n; cz += p[3 * i + 2] / n; }
        for (let i = 0; i < n; i++) s2 += ((p[3 * i + 1] - cy) ** 2 + (p[3 * i + 2] - cz) ** 2) / n;
        return Math.sqrt(s2);
      };
      const lat0 = lateral();
      let free = [0, 0, 0], peakMean = 0, peakMax = 0;
      for (let k = 1; k <= 48; k++) {
        f.step(1 / FPS);
        if (k === 6) free = meanVelocity(); // 0.1 s: the front is still 1 cm short of the wall
        if (k >= 6 && k % 3 === 0) {
          const st = f.densityStats();
          peakMean = Math.max(peakMean, st.meanCompression);
          peakMax = Math.max(peakMax, st.maxCompression);
        }
      }
      return { n, free, peakMean, peakMax, spread: lateral() / lat0, isolated: isolatedFraction(f, f.h, 3), after: meanVelocity() };
    };
    const liquid = run({}), dust = run({ iterations: 0 });
    report(
      "orbit-impact",
      `c2. Orbit control: ${liquid.n} particles (d = 4 mm) thrown at ${v0} m/s against a wall at 0 g, 0.8 s; the control has the pressure solve off`,
      ["quantity", "liquid (defaults)", "control: no pressure (0 iterations)", "liquid must"],
      [
        ["mean velocity in free flight / v0 (x; y, z)", `${f3(liquid.free[0] / v0)}; ${f3(liquid.free[1] / v0)}, ${f3(liquid.free[2] / v0)}`, `${f3(dust.free[0] / v0)}; ${f3(dust.free[1] / v0)}, ${f3(dust.free[2] / v0)}`, "1 within 1%; 0 within 1%"],
        ["peak mean compression through the impact", pct(liquid.peakMean), pct(dust.peakMean), "< 5%"],
        ["peak max compression", pct(liquid.peakMax), pct(dust.peakMax), "reported"],
        ["lateral spread along the wall (rms, end / start)", f2(liquid.spread), f2(dust.spread), "> 1.2"],
        ["particles with < 3 neighbours within h", pct(liquid.isolated), pct(dust.isolated), "< 2%"],
        ["mean velocity at 0.8 s / v0 (x)", f3(liquid.after[0] / v0), f3(dust.after[0] / v0), "reported"],
      ],
      { params: { v0, spacing: 0.004, block_m: 0.04, wall_x_m: 0.08, seconds: 0.8 }, results: { liquid, dust } },
      ["A liquid keeps its momentum in flight, stays near rest density as it hits, and flows sideways along the wall; dust without pressure piles into the wall."],
    );
    expect(Math.abs(liquid.free[0] / v0 - 1)).toBeLessThan(0.01);
    expect(Math.hypot(liquid.free[1], liquid.free[2]) / v0).toBeLessThan(0.01);
    expect(liquid.peakMean).toBeLessThan(0.05);
    expect(liquid.spread).toBeGreaterThan(1.2);
    expect(liquid.isolated).toBeLessThan(0.02);
    // the same checks catch a liquid whose pressure does not work
    expect(dust.peakMean).toBeGreaterThan(0.3);
    expect(dust.spread).toBeLessThan(liquid.spread);
  }, 60_000);

  // d. a box under a constant lateral acceleration: the free surface tilts by atan(a/g)
  const SLOSH = { d: 0.004, L: 0.1, W: 0.02, H: 0.16, t: 0.01, fill: 0.048 };
  /** Free-surface tilt in degrees (positive when it falls toward +x): the top particle per bin, refit in the fitted surface's own frame. */
  function surfaceAngle(f: Fluid, xOffset: number): number {
    const { d, L, W, H } = SLOSH;
    const p = f.positions, n = f.count;
    let theta = 0;
    for (let pass = 0; pass < 4; pass++) {
      const c = Math.cos(theta), s = Math.sin(theta);
      const nb = Math.ceil((L + H) / d) * 2, ny = Math.max(1, Math.round(W / d));
      const top = new Float64Array(nb * ny).fill(-Infinity), idx = new Int32Array(nb * ny).fill(-1);
      for (let i = 0; i < n; i++) {
        const x = p[3 * i] - xOffset, y = p[3 * i + 1], z = p[3 * i + 2];
        const along = x * c - z * s, up = x * s + z * c;
        const b = Math.floor((along + H) / d), yb = Math.min(ny - 1, Math.max(0, Math.floor(y / d)));
        if (b < 0 || b >= nb) continue;
        if (up > top[b * ny + yb]) {
          top[b * ny + yb] = up;
          idx[b * ny + yb] = i;
        }
      }
      const xs: number[] = [], hs: number[] = [];
      for (let k = 0; k < nb * ny; k++) {
        const i = idx[k];
        if (i < 0) continue;
        const x = p[3 * i] - xOffset, z = p[3 * i + 2];
        if (x < 2 * d || x > L - 2 * d || z < 2 * d || z > H - 2 * d) continue; // away from walls, floor and lid
        xs.push(x * c - z * s);
        hs.push(top[k]);
      }
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length, mh = hs.reduce((a, b) => a + b, 0) / hs.length;
      let sxx = 0, sxh = 0;
      for (let k = 0; k < xs.length; k++) {
        sxx += (xs[k] - mx) ** 2;
        sxh += (xs[k] - mx) * (hs[k] - mh);
      }
      theta -= Math.atan(sxh / sxx);
    }
    return (theta * 180) / Math.PI;
  }
  function slosh(gScale: number, aScale: number, seconds: number, driven: boolean) {
    const { d, L, W, H, t, fill } = SLOSH;
    const f = create({ spacing: d });
    const ids = walls(f, [0, 0, 0], [L, W, H], t, { lid: true });
    const base = ids.map((id) => f.solidPose(id).position);
    f.addBlock({ min: [0, 0, 0], max: [L, W, fill] }, d, { jitter: 0.05 });
    f.relax(10);
    const a = G0 * aScale;
    // in the box's frame the acceleration is a lateral part of gravity; "driven" moves the real walls instead
    f.setGravity(driven ? [0, 0, -G0 * gScale] : [-a, 0, -G0 * gScale]);
    const xBox = (time: number) => (driven ? 0.5 * a * time * time : 0);
    const samples: number[] = [];
    const frames = Math.round(seconds * FPS);
    for (let k = 1; k <= frames; k++) {
      if (driven) ids.forEach((id, i) => f.setSolidPose(id, { position: [base[i][0] + xBox(k / FPS), base[i][1], base[i][2]] }));
      f.step(1 / FPS);
      if (k > frames - FPS && k % 6 === 0) samples.push(surfaceAngle(f, xBox(k / FPS)));
    }
    return { n: f.count, deg: samples.reduce((s, v) => s + v, 0) / samples.length, spread: Math.max(...samples) - Math.min(...samples) };
  }

  it("d. slosh: under a lateral acceleration a the surface tilts by atan(a/g)", () => {
    const cases = [
      { body: "earth", g: 1, a: 0.1, seconds: 3, driven: false },
      { body: "earth", g: 1, a: 0.3, seconds: 3, driven: false },
      { body: "moon", g: BODIES.moon, a: 0.1, seconds: 6, driven: false },
      { body: "moon", g: BODIES.moon, a: 0.3, seconds: 6, driven: false },
      { body: "earth", g: 1, a: 0.3, seconds: 3, driven: true },
    ];
    const res = cases.map((c) => ({ ...c, expected: (Math.atan(c.a / c.g) * 180) / Math.PI, ...slosh(c.g, c.a, c.seconds, c.driven) }));
    report(
      "slosh",
      `d. Slosh: ${res[0].n} particles (d = 4 mm), 10 x 2 cm box filled 4.8 cm, surface angle averaged over the last second`,
      ["body", "a (g0)", "how", "atan(a/g) (deg)", "measured (deg)", "error (deg)", "swing in last s (deg)"],
      res.map((r) => [r.body, f2(r.a), r.driven ? "walls driven at a, true gravity" : "box frame, gravity (-a, 0, -g)", f2(r.expected), f2(r.deg), f2(r.deg - r.expected), f2(r.spread)]),
      { params: { ...SLOSH, solver: "defaults" }, results: res },
      ["Tolerance 2 degrees. The surface is the top particle per 4 mm bin, fitted by least squares in its own frame (iterated 4 times)."],
    );
    for (const r of res) expect(Math.abs(r.deg - r.expected)).toBeLessThan(2);
  }, 60_000);

  // e. MuJoCo tilts a cup over a hinge; the liquid pours into a fixed cup at 1 g, not at 0 g
  describe("e. coupling with MuJoCo", () => {
    let mujoco: MainModule;
    beforeAll(async () => {
      const { default: loadMujoco } = await import("@mujoco/mujoco");
      mujoco = await loadMujoco();
    }, 60_000);

    const CUP = { a: 0.025, tw: 0.002, floorZ: -0.014, rim: 0.056, hingeZ: 0.2 };
    const TARGET = { x0: -0.02, x1: 0.14, y: 0.05, top: 0.13, depth: 0.06 };
    function pourXml(gz: number): string {
      const { a, tw, floorZ, rim } = CUP;
      const wallC = (floorZ - 2 * tw + rim) / 2, wallH = (rim - (floorZ - 2 * tw)) / 2;
      const T = TARGET, tz = T.top - T.depth, tcx = (T.x0 + T.x1) / 2, thx = (T.x1 - T.x0) / 2, tcz = tz + T.depth / 2;
      // the hinge sits at the liquid's centroid, so turning the cup at 0 g barely pushes the liquid
      return `<mujoco model="pour">
  <option timestep="0.002" gravity="0 0 ${gz}"/>
  <worldbody>
    <body name="cup" pos="0 0 ${CUP.hingeZ}">
      <joint name="tilt" type="hinge" axis="0 1 0" damping="0.002"/>
      <geom name="cup_floor" type="box" pos="0 0 ${floorZ - tw}" size="${a + 2 * tw} ${a + 2 * tw} ${tw}"/>
      <geom name="cup_xn" type="box" pos="${-(a + tw)} 0 ${wallC}" size="${tw} ${a + 2 * tw} ${wallH}"/>
      <geom name="cup_xp" type="box" pos="${a + tw} 0 ${wallC}" size="${tw} ${a + 2 * tw} ${wallH}"/>
      <geom name="cup_yn" type="box" pos="0 ${-(a + tw)} ${wallC}" size="${a} ${tw} ${wallH}"/>
      <geom name="cup_yp" type="box" pos="0 ${a + tw} ${wallC}" size="${a} ${tw} ${wallH}"/>
    </body>
    <body name="target">
      <geom name="tgt_floor" type="box" pos="${tcx} 0 ${tz - tw}" size="${thx + 2 * tw} ${T.y + 2 * tw} ${tw}"/>
      <geom name="tgt_xn" type="box" pos="${T.x0 - tw} 0 ${tcz}" size="${tw} ${T.y + 2 * tw} ${T.depth / 2}"/>
      <geom name="tgt_xp" type="box" pos="${T.x1 + tw} 0 ${tcz}" size="${tw} ${T.y + 2 * tw} ${T.depth / 2}"/>
      <geom name="tgt_yn" type="box" pos="${tcx} ${-(T.y + tw)} ${tcz}" size="${thx} ${tw} ${T.depth / 2}"/>
      <geom name="tgt_yp" type="box" pos="${tcx} ${T.y + tw} ${tcz}" size="${thx} ${tw} ${T.depth / 2}"/>
    </body>
  </worldbody>
  <actuator><position name="tilt_servo" joint="tilt" kp="2" dampratio="1"/></actuator>
</mujoco>`;
    }

    function pour(gScale: number) {
      const model: MjModel = mujoco.MjModel.from_xml_string(pourXml(-G0 * gScale));
      const data: MjData = new mujoco.MjData(model);
      try {
        mujoco.mj_forward(model, data);
        const d = 0.004;
        const f = create({ spacing: d, gravity: [0, 0, -G0 * gScale], bounds: { min: [-0.3, -0.3, -0.05], max: [0.4, 0.3, 0.5] } });
        const coupling = bindMujocoGeoms(f, model, { bodies: ["cup", "target"] });
        coupling.sync(model, data);
        const z0 = CUP.hingeZ + CUP.floorZ;
        f.addBlock({ min: [-CUP.a, -CUP.a, z0], max: [CUP.a, CUP.a, z0 + 0.028] }, d, { jitter: 0.05 });
        f.relax(10);
        const n = f.count;
        const target: Aabb = { min: [TARGET.x0, -TARGET.y, TARGET.top - TARGET.depth], max: [TARGET.x1, TARGET.y, TARGET.top] };
        const cupBody = 1; // body 0 is the world
        const inCup = () => {
          const xp = data.xpos as Float64Array, xm = data.xmat as Float64Array;
          const o = 3 * cupBody, m = 9 * cupBody, p = f.positions;
          let c = 0;
          for (let i = 0; i < n; i++) {
            const dx = p[3 * i] - xp[o], dy = p[3 * i + 1] - xp[o + 1], dz = p[3 * i + 2] - xp[o + 2];
            const lx = xm[m] * dx + xm[m + 3] * dy + xm[m + 6] * dz, ly = xm[m + 1] * dx + xm[m + 4] * dy + xm[m + 7] * dz, lz = xm[m + 2] * dx + xm[m + 5] * dy + xm[m + 8] * dz;
            if (Math.abs(lx) <= CUP.a && Math.abs(ly) <= CUP.a && lz >= CUP.floorZ && lz <= CUP.rim) c++;
          }
          return c / n;
        };
        const ctrl = data.ctrl as Float64Array, qpos = data.qpos as Float64Array;
        const thetaMax = (120 * Math.PI) / 180, tilt = 1.5, total = 4;
        const steps = Math.round(1 / FPS / (model.opt as { timestep: number }).timestep);
        let firstLanding = NaN, halfLanded = NaN, angleAtFirst = NaN;
        const t0 = performance.now();
        for (let k = 1; k <= total * FPS; k++) {
          const u = Math.min(1, k / FPS / tilt);
          ctrl[0] = thetaMax * u * u * (3 - 2 * u); // smoothstep to 120 degrees over 1.5 s
          for (let s = 0; s < steps; s++) mujoco.mj_step(model, data);
          coupling.sync(model, data);
          f.step(1 / FPS);
          const landed = f.countInBox(target) / n;
          if (Number.isNaN(firstLanding) && landed > 0.01) {
            firstLanding = k / FPS;
            angleAtFirst = (qpos[0] * 180) / Math.PI;
          }
          if (Number.isNaN(halfLanded) && landed >= 0.5) halfLanded = k / FPS;
        }
        const msFrame = (performance.now() - t0) / (total * FPS);
        return { g: gScale, n, landed: f.countInBox(target) / n, inCup: inCup(), firstLanding, angleAtFirst, halfLanded, finalDeg: (qpos[0] * 180) / Math.PI, msFrame, walls: coupling.boundaries.length };
      } finally {
        data.delete();
        model.delete();
      }
    }

    it("P3 names: binds geoms and bodies with UTF-8 names", () => {
      const xml = `<mujoco model="utf8">
  <worldbody>
    <body name="tasse_à_thé" pos="0 0 0.1">
      <geom name="café" type="box" size="0.01 0.02 0.03"/>
      <geom name="anse" type="cylinder" size="0.005 0.01" pos="0.03 0 0"/>
    </body>
  </worldbody>
</mujoco>`;
      const model: MjModel = mujoco.MjModel.from_xml_string(xml);
      const data: MjData = new mujoco.MjData(model);
      try {
        mujoco.mj_forward(model, data);
        const byGeom = bindMujocoGeoms(create({ spacing: 0.004 }), model, { geoms: ["café"] });
        expect(byGeom.boundaries.map((b) => b.name)).toEqual(["café"]);
        const byBody = bindMujocoGeoms(create({ spacing: 0.004 }), model, { bodies: ["tasse_à_thé"] });
        expect(byBody.boundaries.map((b) => b.name).sort()).toEqual(["anse", "café"]);
        byBody.sync(model, data);
        expect(byBody.fluid.solidPose(byBody.boundaries.find((b) => b.name === "café")!.solid).position[2]).toBeCloseTo(0.1, 12);
      } finally {
        data.delete();
        model.delete();
      }
    });

    it("pours into the second cup at 1 g but not at 0 g", () => {
      const res = [pour(1), pour(0)];
      report(
        "coupling",
        `e. MuJoCo-driven pour: ${res[0].n} particles (d = 4 mm) in a 5 x 5 cm cup tilted 120 deg over 1.5 s by a position actuator, read at 4 s`,
        ["gravity", "landed in target cup", "left in source cup", "first landing (s, hinge deg)", "50% landed (s)", "final hinge (deg)", "ms/frame (MuJoCo + liquid)"],
        res.map((r) => [r.g === 1 ? "1 g" : "0 g", pct(r.landed), pct(r.inCup), Number.isNaN(r.firstLanding) ? "never" : `${f2(r.firstLanding)} s, ${r.angleAtFirst.toFixed(0)} deg`, Number.isNaN(r.halfLanded) ? "never" : f2(r.halfLanded), r.finalDeg.toFixed(1), r.msFrame.toFixed(1)]),
        { params: { cup: CUP, target: TARGET, tilt_deg: 120, tilt_s: 1.5, read_at_s: 4, mujoco_geoms_bound: res[0].walls, solver: "defaults, d = 4 mm" }, results: res },
        ["One-way coupling: MuJoCo's geom poses drive the walls each frame; the liquid does not load the cup."],
      );
      expect(res[0].walls).toBe(10);
      expect(res[0].landed).toBeGreaterThan(0.9);
      expect(res[1].landed).toBeLessThan(0.05);
      expect(res[1].inCup).toBeGreaterThan(0.9);
    }, 60_000);
  });

  // f. how many particles fit a 60 fps worker: reported, never asserted (wall-clock time depends on the machine and its load)
  it("f. performance: particles per second on this machine (report only)", () => {
    const rows: Cell[][] = [];
    const results: { n: number; substeps: number; iterations: number; ms_per_frame: number; ms_windows: number[]; particle_substeps_per_s: number }[] = [];
    const runs: { side: number[]; substeps?: number; iterations?: number }[] = [
      { side: [10, 10, 10] },
      { side: [12, 12, 14] },
      { side: [16, 16, 16] },
      { side: [20, 20, 20] },
      { side: [12, 12, 14], iterations: 3 },
    ];
    for (const run of runs) {
      const d = 0.005;
      const f = create({ spacing: d, substeps: run.substeps, iterations: run.iterations });
      const [sx, sy, sz] = run.side;
      walls(f, [0, 0, 0], [2 * sx * d, sy * d, 2 * sz * d], 0.01);
      f.addBlock({ min: [0, 0, 0], max: [sx * d, sy * d, sz * d] });
      for (let k = 0; k < 10; k++) f.step(1 / FPS); // the dam break is in full flow
      // three windows of 10 frames; the median is the figure, the spread shows the noise
      const windows: number[] = [];
      for (let w = 0; w < 3; w++) {
        const t0 = performance.now();
        for (let k = 0; k < 10; k++) f.step(1 / FPS);
        windows.push((performance.now() - t0) / 10);
      }
      const ms = [...windows].sort((a, b) => a - b)[1];
      const r = { n: f.count, substeps: f.substeps, iterations: f.iterations, ms_per_frame: ms, ms_windows: windows, particle_substeps_per_s: (f.count * f.substeps * 1000) / ms };
      results.push(r);
      rows.push([r.n, r.substeps, r.iterations, ms.toFixed(1), `${Math.min(...windows).toFixed(1)}-${Math.max(...windows).toFixed(1)}`, (1000 / ms).toFixed(0), (r.particle_substeps_per_s / 1e6).toFixed(2)]);
    }
    const defaults = results.filter((r) => r.iterations === 4);
    const perParticle = defaults.reduce((s, r) => s + r.ms_per_frame / r.n, 0) / defaults.length;
    const fit16 = Math.floor(16.7 / perParticle), fit8 = Math.floor(8 / perParticle);
    report(
      "perf",
      `f. Performance on ${cpus()[0]?.model ?? "this machine"}, Node ${process.version}, one thread, dam break in full flow (d = 5 mm)`,
      ["particles", "substeps", "iterations", "ms per 1/60 s frame (median of 3)", "range", "frames/s", "M particle-substeps/s"],
      rows,
      { params: { runs, windows: 3, frames_per_window: 10, warmup_frames: 10 }, results, budget: { ms_per_particle_frame: perParticle, fits_16_7ms: fit16, fits_8ms: fit8 } },
      [`About ${(perParticle * 1000).toFixed(2)} us per particle per frame at 4 x 4: ~${fit16} particles fill a whole 16.7 ms frame, ~${fit8} fit an 8 ms share next to MuJoCo and rendering. Not asserted.`],
    );
    expect(results).toHaveLength(runs.length); // every run completed; timing is reported only
  }, 60_000);
});
