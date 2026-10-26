/**
 * The liquid of a rehearsal: particles of lib/sim/fluid.ts in the spec's open
 * containers (scene.ts builds them), whose walls are MuJoCo geoms bound through
 * lib/sim/fluid-mujoco.ts. The coupling is one way: the arm carries the cup and
 * the liquid follows, but the liquid does not load the arm.
 *
 * Whoever calls mj_step calls `advance` right after it (the worker's tick,
 * runToEnd in tests). The liquid steps at 1/60 s with the solver's defaults,
 * the settings docs/MEASUREMENTS.md section 5 validated, so a frame of the
 * stage costs one liquid step.
 *
 * Particle budget: 4 mm particles (0.064 mL each), the size the coupling was
 * measured at, up to MAX_PARTICLES; a larger volume is cut and the plan says
 * so. Larger particles would not help: their kernel outgrows the containers'
 * 4 mm walls, which the solver then treats as thin and filters neighbours
 * through, and a step costs more, not less. A cup the arm turns costs two to
 * three times what the solver's dam-break benchmark does per particle (its
 * walls rotate, so contacts are swept), hence the budget.
 */
import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import type { TaskSpec } from "@/lib/spec/schema";
import { create, type Fluid } from "./fluid";
import { bindMujocoGeoms, type MujocoFluidCoupling } from "./fluid-mujoco";
import { toNumbers } from "./names";
import { containerIds, type SceneBuild } from "./scene";
import { G_M_S2 } from "./so101";

export const LIQUID_STEP_S = 1 / 60;
export const LIQUID_SPACING_M = 0.004;
/**
 * Particles that keep the stage at 60 fps on an M4 while the arm pours: a liquid step took 11 to 13 ms
 * (median) at 594 particles and 17 to 22 ms at 1,000, against a 16.7 ms frame (tests/sim/pour.test.ts
 * notes how it was measured).
 */
export const MAX_PARTICLES = 600;
/** a container a pour step pours from without saying how much it holds is filled this far up */
const DEFAULT_FILL = 0.5;
/** at most this share of a container's room is filled: the rest is freeboard */
const MAX_FILL = 0.8;
/** a particle this close to the table (in particle diameters) and in no container is on the table */
const ON_TABLE = 1.5;
/**
 * Inside a container: between its walls, from its floor up to this far above its rim, where a full or a
 * landed blob's surface stands (in orbit it bulges); the measured pours counted the target cup the same way
 * (tests/measure/patch-probes.ts, the pour probes).
 */
const ABOVE_RIM_M = 0.01;
/** what locate() says of a particle in no container */
const ON_THE_TABLE = -1;
const ELSEWHERE = -2;

export type LiquidPlan = {
  spacing_m: number;
  /** containers holding liquid at the start */
  fills: { id: string; ml: number; particles: number }[];
  /** every open container: object id -> its `<name>_inside` site */
  containers: Record<string, string>;
  /** MJCF bodies whose geoms are the liquid's walls: every spec object */
  bodies: string[];
  warnings: string[];
};

/** Where the liquid is, as shares of all of it: per container id, on the table, and elsewhere (in the air, on other objects). */
export type LiquidWhere = { containers: Record<string, number>; table: number; elsewhere: number };

/** Whole particles of size `s` across `length` (40 mm over 4 mm is 10, not 9.999...). */
const across = (length: number, s: number) => Math.floor(length / s + 1e-9);

/** Lookups keyed by spec ids own nothing else: an id like "__proto__" must stay an ordinary key. */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/** The liquid a spec needs, or null when nothing in it holds liquid. `spec` is the laid-out spec the scene was built from. */
export function planLiquid(spec: TaskSpec, scene: Pick<SceneBuild, "names" | "containers">): LiquidPlan | null {
  const ids = containerIds(spec);
  if (ids.size === 0) return null;
  const warnings: string[] = [];
  const spacing = LIQUID_SPACING_M;
  const perParticleMl = spacing ** 3 * 1e6;
  const has = (id: string) => Object.hasOwn(scene.containers, id);
  // what a container holds is counted in the lattice its fill starts as: whole particles across, layers up
  const room = (id: string) => {
    const c = scene.containers[id];
    return across(c.inner_m[0], spacing) * across(c.inner_m[1], spacing) * across(c.depth_m, spacing);
  };
  const wanted = spec.objects.filter((o) => o.liquid_ml !== undefined && has(o.id)).map((o) => ({ id: o.id, ml: o.liquid_ml! }));
  // the first pour pours from something: when the spec does not say how much that holds, it is half full
  const source = spec.steps.find((s) => s.verb === "pour")?.object;
  if (source !== undefined && has(source) && !wanted.some((w) => w.id === source)) {
    const ml = Math.floor(DEFAULT_FILL * room(source)) * perParticleMl;
    warnings.push(`the spec does not say how much liquid "${source}" holds; it was filled half way (${Math.round(ml)} mL)`);
    wanted.push({ id: source, ml });
  }
  if (wanted.length === 0) return null;
  const capped = wanted.map(({ id, ml }) => {
    const most = Math.floor(MAX_FILL * room(id)) * perParticleMl;
    if (ml <= most) return { id, ml };
    warnings.push(`"${id}" holds ${Math.round(most)} mL at most; ${Math.round(ml)} mL was asked`);
    return { id, ml: most };
  });
  const total = capped.reduce((s, w) => s + w.ml, 0);
  const cut = Math.min(1, (MAX_PARTICLES * perParticleMl) / total);
  if (cut < 1) warnings.push(`only ${Math.round(cut * 100)}% of the ${Math.round(total)} mL is simulated: ${MAX_PARTICLES} particles of ${spacing * 1000} mm keep the frame rate`);
  const fills = capped.map(({ id, ml }) => {
    const particles = Math.max(1, Math.round((ml * cut) / perParticleMl));
    return { id, ml: particles * perParticleMl, particles };
  });
  const containers = dict<string>();
  for (const id of ids) if (has(id)) containers[id] = `${scene.names[id]}_inside`;
  return { spacing_m: spacing, fills, containers, bodies: spec.objects.map((o) => scene.names[o.id]), warnings };
}

export class Liquid {
  readonly fluid: Fluid;
  private coupling: MujocoFluidCoupling;
  private sites = dict<number>();
  /** the containers, in the order locate() numbers them */
  private containerIds: string[] = [];
  /** per particle, the index in plan.fills of the container it started in (the solver never reorders particles) */
  private origins = new Int32Array(0);
  /** half-sizes of every site, from the model: the containers' insides do not change size */
  private siteSize: number[];
  private pending = 0;
  /** milliseconds the latest liquid step took */
  stepMs = 0;

  constructor(
    mujoco: MainModule,
    model: MjModel,
    data: MjData,
    readonly plan: LiquidPlan,
    { gravity_g = 1, seed = 1 }: { gravity_g?: number; seed?: number } = {},
  ) {
    this.fluid = create({
      spacing: plan.spacing_m,
      gravity: [0, 0, -G_M_S2 * gravity_g],
      seed,
      // the table is the floor; the walls stop a thrown blob before it leaves the scene
      bounds: { min: [-1, -1, 0], max: [1, 1, 1.5] },
    });
    this.coupling = bindMujocoGeoms(this.fluid, model, { bodies: plan.bodies });
    this.siteSize = Array.from(toNumbers(model.site_size));
    for (const [id, site] of Object.entries(plan.containers)) {
      const s = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, site);
      if (s < 0) throw new Error(`no site ${site} for the liquid in "${id}"`);
      this.sites[id] = s;
      this.containerIds.push(id);
    }
    this.fill(model, data, seed);
  }

  get count(): number {
    return this.fluid.count;
  }

  /** Empty the scene and fill the containers again, where they stand now (after a reset). */
  fill(model: MjModel, data: MjData, seed = 1) {
    const f = this.fluid;
    const s = this.plan.spacing_m;
    f.clearParticles();
    const origins: number[] = [];
    this.coupling.sync(model, data, { teleport: true });
    const rand = mulberry32(seed);
    const xpos = toNumbers(data.site_xpos);
    const xmat = toNumbers(data.site_xmat);
    const size = this.siteSize;
    for (const { id, particles } of this.plan.fills) {
      const site = this.sites[id];
      const [hx, hy, hz] = [0, 1, 2].map((k) => size[3 * site + k]);
      const nx = Math.max(1, across(2 * hx, s));
      const ny = Math.max(1, across(2 * hy, s));
      const R = Array.from({ length: 9 }, (_, k) => xmat[9 * site + k]);
      const p = [0, 1, 2].map((k) => xpos[3 * site + k]);
      const out: number[] = [];
      for (let i = 0; i < particles; i++) {
        const layer = Math.floor(i / (nx * ny));
        const local = [
          ((i % nx) + 0.5) * s - (nx * s) / 2 + 0.05 * s * (rand() - 0.5),
          ((Math.floor(i / nx) % ny) + 0.5) * s - (ny * s) / 2 + 0.05 * s * (rand() - 0.5),
          -hz + (layer + 0.5) * s + 0.05 * s * (rand() - 0.5),
        ];
        for (let r = 0; r < 3; r++) out.push(p[r] + R[3 * r] * local[0] + R[3 * r + 1] * local[1] + R[3 * r + 2] * local[2]);
      }
      f.addParticles(out);
      for (let i = 0; i < particles; i++) origins.push(this.plan.fills.findIndex((x) => x.id === id));
    }
    f.relax(10);
    this.origins = Int32Array.from(origins);
    this.pending = 0;
  }

  /** Call after every mj_step with its timestep: the liquid takes a step each time 1/60 s has gathered. */
  advance(model: MjModel, data: MjData, dt: number) {
    this.pending += dt;
    while (this.pending >= LIQUID_STEP_S - 1e-9) {
      this.pending -= LIQUID_STEP_S;
      this.coupling.sync(model, data);
      const t0 = performance.now();
      this.fluid.step(LIQUID_STEP_S);
      this.stepMs = performance.now() - t0;
    }
  }

  setGravity(g: number) {
    this.fluid.setGravity([0, 0, -G_M_S2 * g]);
  }

  /**
   * Share (0 to 1) of the liquid inside container `id` (between its walls, up to ABOVE_RIM_M over its rim): of all
   * of it, or with `from`, of the liquid that started in that container (what a pour moved, whatever the target
   * held before).
   */
  shareIn(data: MjData, id: string, from?: string): number {
    if (!Object.hasOwn(this.sites, id)) throw new Error(`"${id}" is not an open container`);
    const k = this.containerIds.indexOf(id);
    const where = this.locate(data);
    if (from === undefined) return this.fluid.count ? where.filter((c) => c === k).length / this.fluid.count : 0;
    const origin = this.plan.fills.findIndex((f) => f.id === from);
    if (origin < 0) throw new Error(`"${from}" held no liquid at the start`);
    let mine = 0;
    let there = 0;
    for (let i = 0; i < where.length; i++) {
      if (this.origins[i] !== origin) continue;
      mine++;
      if (where[i] === k) there++;
    }
    return mine ? there / mine : 0;
  }

  where(data: MjData): LiquidWhere {
    const where = this.locate(data);
    const n = where.length;
    const counts = new Array(this.containerIds.length).fill(0);
    let table = 0;
    for (const k of where) {
      if (k >= 0) counts[k]++;
      else if (k === ON_THE_TABLE) table++;
    }
    const share = (c: number) => (n ? c / n : 0);
    const containers = dict<number>();
    this.containerIds.forEach((id, k) => (containers[id] = share(counts[k])));
    const inside = counts.reduce((a, b) => a + b, 0);
    return { containers, table: share(table), elsewhere: share(n - inside - table) };
  }

  /** Per particle: the index (in containerIds) of the container it is in, else ON_THE_TABLE or ELSEWHERE. */
  private locate(data: MjData): Int32Array {
    const x = this.fluid.positions;
    const n = this.fluid.count;
    const xpos = toNumbers(data.site_xpos);
    const xmat = toNumbers(data.site_xmat);
    const size = this.siteSize;
    const boxes = this.containerIds.map((id) => {
      const s = this.sites[id];
      return {
        p: [0, 1, 2].map((k) => xpos[3 * s + k]),
        R: Array.from({ length: 9 }, (_, k) => xmat[9 * s + k]),
        h: [0, 1, 2].map((k) => size[3 * s + k]),
      };
    });
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const px = x[3 * i], py = x[3 * i + 1], pz = x[3 * i + 2];
      const k = boxes.findIndex(({ p, R, h }) => {
        const d = [px - p[0], py - p[1], pz - p[2]];
        const l = [0, 1, 2].map((c) => R[c] * d[0] + R[3 + c] * d[1] + R[6 + c] * d[2]);
        return Math.abs(l[0]) <= h[0] && Math.abs(l[1]) <= h[1] && l[2] >= -h[2] && l[2] <= h[2] + ABOVE_RIM_M;
      });
      out[i] = k >= 0 ? k : pz < ON_TABLE * this.plan.spacing_m ? ON_THE_TABLE : ELSEWHERE;
    }
    return out;
  }
}

/** One sentence of where the liquid is, by object name: what a rehearsal reports. */
export function describeLiquid(where: LiquidWhere, name: (id: string) => string, gravity_g: number): string {
  const pc = (v: number) => (v > 0 && v < 0.005 ? "under 1%" : `${Math.round(v * 100)}%`);
  const parts = Object.entries(where.containers).map(([id, v]) => `${pc(v)} in the ${name(id)}`);
  if (where.table > 0) parts.push(`${pc(where.table)} on the table`);
  if (where.elsewhere > 0) parts.push(`${pc(where.elsewhere)} ${gravity_g > 0 ? "elsewhere" : "floating free"}`);
  return `liquid: ${parts.join(", ")}`;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
