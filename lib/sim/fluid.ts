/**
 * Position-based fluids (Macklin and Müller, "Position Based Fluids", SIGGRAPH 2013).
 *
 * MuJoCo has no free-surface liquid: its "fluid forces" are drag and lift on rigid
 * bodies moving through a surrounding medium (air, water) that has no shape of its
 * own. Pouring and sloshing need a liquid with a surface, so this module simulates
 * one with particles and lets MuJoCo geoms act as its walls (see fluid-mujoco.ts).
 *
 * The solver, per substep:
 *   1. v += g dt, predict p = x + v dt, push p out of solids;
 *   2. find neighbours of p in a uniform grid (cell = kernel radius h, counting sort);
 *   3. iterate the density constraint C_i = rho_i / rho0 - 1 (poly6 density, spiky
 *      gradient): lambda_i = -C_i / (sum_k |grad_k C_i|^2 + eps), then
 *      dp_i = 1/rho0 sum_j m (lambda_i + lambda_j + s_corr) grad W_ij, push out of solids;
 *   4. Coulomb friction against each particle's dominant contact, one more projection
 *      if that (or the speed cap) moved anything, v = (p - x) / dt with restitution,
 *      XSPH viscosity, optional vorticity confinement, speed cap, x = p.
 *
 * Choices that differ from the paper, all switchable:
 *   - `cohesion` scales the negative (stretched) part of the constraint. The paper
 *     solves C_i = 0 both ways (cohesion 1), which gives the liquid a strong artificial
 *     surface tension whose strength does not scale with gravity. 0 makes the liquid
 *     push but never pull; the default 0.05 keeps a weak pull, enough to hold a blob
 *     together at 0 g. Because walls count in the density (below), it also pulls
 *     under-dense particles toward walls: a weak wetting.
 *   - s_corr is expressed in units of the rest lambda, so `scorrK` is dimensionless
 *     and does not depend on the particle size; the paper's k = 0.1 is in the units
 *     of its own scene.
 *   - XSPH is the SPH-consistent form v_i += c sum_j (m / rho_j) (v_j - v_i) W_ij, so
 *     `xsph` is the fraction of the local velocity difference removed per substep.
 *   - Solids count in the density of the particles near them (`wallDensity`), as a
 *     ghost lattice of liquid at rest behind their surface; without it the layers along
 *     walls and floors pack far tighter than rho0. Where surfaces meet, the lattices'
 *     overlap is counted once, so corners read rho0 too.
 *   - Neighbour pairs across a solid thinner than the kernel are dropped: liquid does
 *     not feel liquid through a sealed thin wall.
 *   - Paths are tested, not just end points: exactly for solids that translate (swept
 *     slabs and quadratics, confirmed against the rounded inflated shape), at exact
 *     poses sampled per particle for solids that rotate (planes included), so neither a
 *     fast thin wall nor a spinning one passes through a particle.
 *
 * Known limits (measured by an external review, not fixed):
 *   - Ghost-density weights treat every nearby surface as independent. Redundant or
 *     rotated surfaces over-subtract: a plane through a bounds corner facing
 *     (1, 1, 0) / sqrt 2 lowers the corner's density from 1000 to 940.6 kg/m^3, three
 *     such planes to 894.2. A curved surface's tangent basis can switch between two
 *     nearly equal axes, changing its ghost density by about 2 kg/m^3 across a 3e-12 m
 *     move.
 *   - The neighbour filter only checks solids that are thin everywhere (2 (half
 *     thickness + r) < h). Near the corner of a thick solid two particles can still see
 *     each other through it: spacing 0.01, radius 0.001, box half-size [0.02, 0.02, 1]
 *     at [-0.02, -0.02, 0], particles at [0.0011, -0.002, 0] and [-0.002, 0.0011, 0]
 *     gain 167 kg/m^3. Its cost grows with the square of the number of thin solids
 *     near a particle (1, 16, 64 panels: 0.19, 3.6, 19.6 ms per substep at 1,000
 *     particles), fine for a scene with a few geoms.
 *   - The closing contact pass projects a particle out of each solid in turn (up to 4
 *     rounds). Where solids leave no room for it at all, the last projection wins and it
 *     may end inside another solid.
 */

export type Vec3 = [number, number, number];
/** 3x3 rotation, row-major, local to world: world = position + R * local (MuJoCo's xmat layout). */
export type Mat3 = ArrayLike<number>;
/** Unit quaternion in MuJoCo order: w, x, y, z. */
export type Quat = [number, number, number, number];

export interface Pose {
  position: ArrayLike<number>;
  /** row-major 3x3, local to world; wins over `quaternion` */
  rotation?: Mat3;
  quaternion?: Quat;
}

/**
 * Solid shapes in their local frame. Capsules and cylinders run along local z
 * (MuJoCo's convention); a plane is the half-space z < 0 of its frame.
 */
export type SolidShape =
  | { type: "box"; halfSize: ArrayLike<number> }
  | { type: "capsule"; radius: number; halfLength: number }
  | { type: "cylinder"; radius: number; halfLength: number }
  | { type: "sphere"; radius: number }
  | { type: "plane" };

export interface SolidSpec {
  shape: SolidShape;
  pose?: Pose;
  /** Coulomb friction coefficient against the liquid (0 = free slip). Default: the fluid's `friction`. */
  friction?: number;
  /** Normal restitution 0..1 (0 = the liquid sticks to the wall in the normal direction). Default: the fluid's `restitution`. */
  restitution?: number;
  enabled?: boolean;
  name?: string;
}

export interface Aabb {
  min: ArrayLike<number>;
  max: ArrayLike<number>;
}

export interface FluidParams {
  /** rest spacing between particles, m; one particle stands for spacing^3 of liquid */
  spacing: number;
  /** kg/m^3, default 1000 (water) */
  restDensity?: number;
  /** kernel radius over spacing, 1.5 to 4, default 2 (about 30 neighbours) */
  kernelRatio?: number;
  /** m/s^2, default [0, 0, -9.81] */
  gravity?: ArrayLike<number>;
  /** substeps per step() call, default 4 */
  substeps?: number;
  /** density iterations per substep, default 4 */
  iterations?: number;
  /** constraint relaxation (constraint force mixing) relative to the rest denominator, default 0.05 */
  relaxation?: number;
  /** 0..1 weight of the stretched part of the density constraint (0 = push only, 1 = the paper), default 0.05 */
  cohesion?: number;
  /** tensile correction strength, in units of the rest lambda; default 0.005 */
  scorrK?: number;
  /** tensile correction exponent, 1 to 8, default 4 */
  scorrN?: number;
  /** tensile correction reference distance as a fraction of h, 0.05 to 0.5, default 0.2 */
  scorrDq?: number;
  /** XSPH viscosity: fraction of the neighbour velocity difference removed per substep, default 0.01 */
  xsph?: number;
  /** vorticity confinement strength, m/s^2 per (1/s) of vorticity; default 0 (off) */
  vorticity?: number;
  /** distance kept between a particle centre and a solid surface, default spacing / 2 */
  collisionRadius?: number;
  /** default Coulomb friction against solids, default 0 */
  friction?: number;
  /** default normal restitution against solids, default 0 */
  restitution?: number;
  /** neighbours stored per particle, default 64 (extra ones are dropped and counted) */
  maxNeighbors?: number;
  /** a world box the particles cannot leave (it acts as walls); default none */
  bounds?: Aabb;
  /** per-substep position correction cap, as a fraction of h; default 0.25 */
  maxCorrection?: number;
  /** speed cap in m/s on each substep's displacement and on the velocity returned (a wall's push still wins), default none */
  maxSpeed?: number;
  /** seed of the jitter generator, default 1 */
  seed?: number;
  /** count solids and bounds in the density of nearby particles (see computeWallDensity), default true */
  wallDensity?: boolean;
}

export interface DensityStats {
  /** mean over all particles of max(0, rho / rho0 - 1): the compression PBF is meant to remove */
  meanCompression: number;
  maxCompression: number;
  /** mean |rho / rho0 - 1| over particles whose kernel is full of liquid (not at a surface or a wall) */
  meanAbsInterior: number;
  interiorCount: number;
  /** mean rho / rho0 - 1 over all particles, surface ones included (they read low by construction) */
  meanSigned: number;
}

interface Solid {
  name: string;
  shape: SolidShape;
  enabled: boolean;
  friction: number;
  restitution: number;
  /** pose at the end of the current step (set by the caller) */
  pos: Float64Array;
  rot: Float64Array;
  /** pose at the start of the current step */
  pos0: Float64Array;
  rot0: Float64Array;
  /** interpolated poses at the start (a) and end (b) of the current substep */
  posA: Float64Array;
  rotA: Float64Array;
  posB: Float64Array;
  rotB: Float64Array;
  /** step start / end quaternions, and the substep's start (a) / end (b) ones */
  q0: Float64Array;
  q1: Float64Array;
  qA: Float64Array;
  qB: Float64Array;
  /** rotation over the current substep, rad */
  angle: number;
  /** thinner than the kernel: liquid on both sides could see itself through it */
  thin: boolean;
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** distance (m) within which a point on a solid's inflated surface still counts as outside it */
const SURFACE_EPS = 1e-7;
/** samples of the wall density table Psi(z), z in [0, h] */
const PSI_SAMPLES = 128;
/** below this rotation over a substep (rad) a solid counts as translating only */
const ROTATION_EPS = 1e-6;
/** most pose samples along one substep of a rotating solid; past it, conservative advancement takes over */
const MAX_SWEEP_SAMPLES = 512;
/** most nearby surfaces counted in one particle's wall density */
const MAX_PLANES = 8;
/** largest (W / W(dq))^n the tensile correction may use */
const SCORR_CAP = 1e4;
const BOUNDS_ID = -2;

/** cell coordinates are clamped here: still exact (clamping never separates neighbours), never overflowing */
const CELL_LIMIT = 1 << 28;
function clampCell(c: number): number {
  return c > CELL_LIMIT ? CELL_LIMIT : c < -CELL_LIMIT ? -CELL_LIMIT : c | 0;
}
function cellHash(x: number, y: number, z: number): number {
  return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
}
function cellLess(X: Int32Array, Y: Int32Array, Z: Int32Array, a: number, b: number): boolean {
  return X[a] !== X[b] ? X[a] < X[b] : Y[a] !== Y[b] ? Y[a] < Y[b] : Z[a] < Z[b];
}

/** Deterministic PRNG (mulberry32): same jitter in Node and in the browser. */
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

/** Row-major rotation matrix from a unit quaternion (w, x, y, z). */
export function quatToMat(q: ArrayLike<number>, out: Float64Array | number[] = new Float64Array(9)): Float64Array | number[] {
  const [w, x, y, z] = [q[0], q[1], q[2], q[3]];
  const n = Math.hypot(w, x, y, z) || 1;
  const a = w / n, b = x / n, c = y / n, d = z / n;
  out[0] = 1 - 2 * (c * c + d * d); out[1] = 2 * (b * c - a * d); out[2] = 2 * (b * d + a * c);
  out[3] = 2 * (b * c + a * d); out[4] = 1 - 2 * (b * b + d * d); out[5] = 2 * (c * d - a * b);
  out[6] = 2 * (b * d - a * c); out[7] = 2 * (c * d + a * b); out[8] = 1 - 2 * (b * b + c * c);
  return out;
}

/** Unit quaternion (w, x, y, z) from a row-major rotation matrix (Shepperd's method). */
export function matToQuat(m: ArrayLike<number>, out: Float64Array | number[] = new Float64Array(4)): Float64Array | number[] {
  const tr = m[0] + m[4] + m[8];
  let w, x, y, z;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[7] - m[5]) / s; x = 0.25 * s; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = 0.25 * s; z = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = 0.25 * s;
  }
  const n = Math.hypot(w, x, y, z) || 1;
  out[0] = w / n; out[1] = x / n; out[2] = y / n; out[3] = z / n;
  return out;
}

/** Rotation of `angle` radians about a unit axis, row-major. */
export function axisAngleToMat(axis: ArrayLike<number>, angle: number): number[] {
  const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const s = Math.sin(angle / 2);
  return Array.from(quatToMat([Math.cos(angle / 2), (axis[0] / n) * s, (axis[1] / n) * s, (axis[2] / n) * s]));
}

export class Fluid {
  readonly spacing: number;
  readonly h: number;
  readonly restDensity: number;
  /** physical mass of one particle, rho0 * spacing^3 (kinetic energy, buoyancy) */
  readonly particleMass: number;
  /** kernel mass, calibrated so a cubic lattice at `spacing` reads exactly rho0 */
  readonly kernelMass: number;
  readonly gravity: Float64Array;
  substeps: number;
  iterations: number;
  cohesion: number;
  xsph: number;
  vorticity: number;
  scorrK: number;
  readonly scorrN: number;
  readonly collisionRadius: number;
  friction: number;
  restitution: number;
  maxSpeed: number;
  bounds: Aabb | null;
  /** neighbours dropped because a particle had more than maxNeighbors (diagnostic) */
  neighborOverflow = 0;
  /** simulated time, s */
  time = 0;

  private n = 0;
  private cap = 0;
  private readonly maxNbr: number;
  private x = new Float64Array(0);
  private v = new Float64Array(0);
  private p = new Float64Array(0);
  private dp = new Float64Array(0);
  private vNew = new Float64Array(0);
  private omega = new Float64Array(0);
  private lambda = new Float64Array(0);
  private rho = new Float64Array(0);
  private nbr = new Int32Array(0);
  private nbrCount = new Int32Array(0);
  private contactSolid = new Int32Array(0);
  /** first solid each particle touched this substep, and whether it needs the closing pass */
  private touched = new Int32Array(0);
  private entangled = new Uint8Array(0);
  private contactNormal = new Float64Array(0);
  private contactDepth = new Float64Array(0);
  private cellOf = new Int32Array(0);
  private cellX = new Int32Array(0);
  private cellY = new Int32Array(0);
  private cellZ = new Int32Array(0);
  private cellStart = new Int32Array(0);
  private cellEntries = new Int32Array(0);
  private readonly solids: Solid[] = [];
  private readonly rand: () => number;
  readonly wallDensity: boolean;
  private wallPairs = new Int32Array(1024);
  private nWallPairs = 0;
  private wallRho = new Float64Array(0);
  private wallGrad = new Float64Array(0);
  /** solids near particle i are wallPairs[pairStart[i] .. pairStart[i] + pairCount[i]) */
  private pairStart = new Int32Array(0);
  private pairCount = new Int32Array(0);
  private readonly planeZ = new Float64Array(MAX_PLANES);
  private readonly planeN = new Float64Array(3 * MAX_PLANES);
  private readonly planeT = new Float64Array(3 * MAX_PLANES);
  private readonly psi = new Float64Array(PSI_SAMPLES + 1);
  private readonly dpsi = new Float64Array(PSI_SAMPLES + 1);

  private readonly poly6C: number;
  private readonly spikyC: number;
  private readonly eps: number;
  private readonly lambdaScale: number;
  private readonly wDq: number;
  private readonly maxCorr: number;
  private readonly denomFloor: number;

  constructor(params: FluidParams) {
    validateParams(params);
    this.spacing = params.spacing;
    this.h = (params.kernelRatio ?? 2) * params.spacing;
    this.restDensity = params.restDensity ?? 1000;
    this.gravity = new Float64Array(params.gravity ? [params.gravity[0], params.gravity[1], params.gravity[2]] : [0, 0, -9.81]);
    this.substeps = params.substeps ?? 4;
    this.iterations = params.iterations ?? 4;
    this.cohesion = params.cohesion ?? 0.05;
    this.xsph = params.xsph ?? 0.01;
    this.vorticity = params.vorticity ?? 0;
    this.scorrK = params.scorrK ?? 0.005;
    this.scorrN = params.scorrN ?? 4;
    this.collisionRadius = params.collisionRadius ?? params.spacing / 2;
    this.friction = params.friction ?? 0;
    this.restitution = params.restitution ?? 0;
    this.maxSpeed = params.maxSpeed ?? Infinity;
    this.bounds = params.bounds ?? null;
    this.maxNbr = params.maxNeighbors ?? 64;
    this.maxCorr = (params.maxCorrection ?? 0.25) * this.h;
    this.wallDensity = params.wallDensity ?? true;
    this.rand = mulberry32(params.seed ?? 1);

    const h = this.h;
    this.poly6C = 315 / (64 * Math.PI * h ** 9);
    this.spikyC = -45 / (Math.PI * h ** 6);
    this.particleMass = this.restDensity * this.spacing ** 3;

    // calibrate the kernel mass on an infinite cubic lattice at the rest spacing,
    // and measure the rest denominator sum_k |grad_k C|^2 there
    const d = this.spacing;
    const reach = Math.ceil(h / d);
    let wSum = 0;
    const grads: number[] = [];
    for (let i = -reach; i <= reach; i++)
      for (let j = -reach; j <= reach; j++)
        for (let k = -reach; k <= reach; k++) {
          const r = Math.hypot(i, j, k) * d;
          if (r >= h) continue;
          wSum += this.w(r * r);
          if (r > 0) grads.push(-this.spikyC * (h - r) ** 2);
        }
    this.kernelMass = this.restDensity / wSum;
    const gScale = this.kernelMass / this.restDensity;
    const denom = grads.reduce((s, g) => s + (gScale * g) ** 2, 0);
    if (!(denom > 0) || !Number.isFinite(denom)) throw new Error("fluid: kernelRatio leaves no neighbours at rest");
    this.eps = (params.relaxation ?? 0.05) * denom;
    this.lambdaScale = 1 / (denom + this.eps);
    // no particle, however alone, divides by less than this
    this.denomFloor = 1e-6 * denom;
    const dq = (params.scorrDq ?? 0.2) * h;
    this.wDq = this.w(dq * dq);

    // Psi(z): density a wall adds to a particle z from its surface, as a ghost lattice at
    // rest (layers at z + d/2, z + 3d/2, ...); a lattice resting on a wall then reads rho0
    for (let t = 0; t <= PSI_SAMPLES; t++) {
      const z = (h * t) / PSI_SAMPLES;
      let sum = 0;
      for (let k = 0; z + d / 2 + k * d < h; k++)
        for (let i = -reach; i <= reach; i++)
          for (let j = -reach; j <= reach; j++) {
            const zz = z + d / 2 + k * d;
            sum += this.w((i * d) ** 2 + (j * d) ** 2 + zz * zz);
          }
      this.psi[t] = this.kernelMass * sum;
    }
    for (let t = 0; t <= PSI_SAMPLES; t++) {
      const a = Math.max(0, t - 1), b = Math.min(PSI_SAMPLES, t + 1);
      this.dpsi[t] = (this.psi[b] - this.psi[a]) / (((b - a) * h) / PSI_SAMPLES);
    }
  }

  /** poly6 kernel value at squared distance r2 */
  private w(r2: number): number {
    const h2 = this.h * this.h;
    if (r2 >= h2) return 0;
    const t = h2 - r2;
    return this.poly6C * t * t * t;
  }

  get count(): number {
    return this.n;
  }
  /** liquid volume the particles stand for, n * spacing^3 (settled liquid packs about 5% tighter, see the rest test) */
  get volume(): number {
    return this.n * this.spacing ** 3;
  }
  /** live view of the positions, x0 y0 z0 x1 ...; invalid after particles are added */
  get positions(): Float64Array {
    return this.x.subarray(0, 3 * this.n);
  }
  /** live view of the velocities */
  get velocities(): Float64Array {
    return this.v.subarray(0, 3 * this.n);
  }
  /** copy the positions into a Float32Array (for a renderer or a postMessage transfer) */
  copyPositions(out = new Float32Array(3 * this.n)): Float32Array {
    out.set(this.x.subarray(0, Math.min(out.length, 3 * this.n)));
    return out;
  }

  setGravity(g: ArrayLike<number>): void {
    this.gravity[0] = g[0];
    this.gravity[1] = g[1];
    this.gravity[2] = g[2];
  }

  private ensureCapacity(n: number) {
    if (n <= this.cap) return;
    const cap = Math.max(n, Math.ceil(this.cap * 1.5), 256);
    const grow3 = (a: Float64Array) => {
      const b = new Float64Array(3 * cap);
      b.set(a);
      return b;
    };
    this.x = grow3(this.x);
    this.v = grow3(this.v);
    this.p = new Float64Array(3 * cap);
    this.dp = new Float64Array(3 * cap);
    this.vNew = new Float64Array(3 * cap);
    this.omega = new Float64Array(3 * cap);
    this.lambda = new Float64Array(cap);
    this.rho = new Float64Array(cap);
    this.nbr = new Int32Array(cap * this.maxNbr);
    this.nbrCount = new Int32Array(cap);
    this.contactSolid = new Int32Array(cap);
    this.touched = new Int32Array(cap);
    this.entangled = new Uint8Array(cap);
    this.contactNormal = new Float64Array(3 * cap);
    this.contactDepth = new Float64Array(cap);
    this.wallRho = new Float64Array(cap);
    this.wallGrad = new Float64Array(3 * cap);
    this.pairStart = new Int32Array(cap);
    this.pairCount = new Int32Array(cap);
    this.cellOf = new Int32Array(cap);
    this.cellEntries = new Int32Array(cap);
    this.cellX = new Int32Array(cap);
    this.cellY = new Int32Array(cap);
    this.cellZ = new Int32Array(cap);
    this.cap = cap;
  }

  /** Add particles at the given positions (x y z ...), optionally with velocities. Returns the first new index. */
  addParticles(positions: ArrayLike<number>, velocities?: ArrayLike<number>): number {
    const k = Math.floor(positions.length / 3);
    const first = this.n;
    this.ensureCapacity(this.n + k);
    for (let i = 0; i < 3 * k; i++) {
      this.x[3 * first + i] = positions[i];
      this.v[3 * first + i] = velocities ? velocities[i] : 0;
    }
    this.n += k;
    return first;
  }

  /**
   * Fill an axis-aligned box with a cubic lattice of particles, the first one half a
   * spacing in from `min`. `spacing` defaults to the rest spacing; another value fills
   * the box at a different density, which then relaxes. Returns the number added.
   */
  addBlock(box: Aabb, spacing = this.spacing, options: { velocity?: ArrayLike<number>; jitter?: number } = {}): number {
    const counts = [0, 1, 2].map((a) => Math.max(0, Math.floor((box.max[a] - box.min[a]) / spacing + 1e-9)));
    const pos: number[] = [];
    const vel: number[] = [];
    const jitter = (options.jitter ?? 0) * spacing;
    const v = options.velocity ?? [0, 0, 0];
    for (let k = 0; k < counts[2]; k++)
      for (let j = 0; j < counts[1]; j++)
        for (let i = 0; i < counts[0]; i++) {
          pos.push(
            box.min[0] + (i + 0.5) * spacing + jitter * (this.rand() - 0.5),
            box.min[1] + (j + 0.5) * spacing + jitter * (this.rand() - 0.5),
            box.min[2] + (k + 0.5) * spacing + jitter * (this.rand() - 0.5),
          );
          vel.push(v[0], v[1], v[2]);
        }
    this.addParticles(pos, vel);
    return pos.length / 3;
  }

  /** Remove every particle. */
  clearParticles(): void {
    this.n = 0;
  }

  // ---------------------------------------------------------------- solids

  /** Add a static or moving solid; returns its id. */
  addSolid(spec: SolidSpec): number {
    const s: Solid = {
      name: spec.name ?? `solid${this.solids.length}`,
      shape: spec.shape,
      enabled: spec.enabled ?? true,
      friction: spec.friction ?? this.friction,
      restitution: spec.restitution ?? this.restitution,
      pos: new Float64Array(3),
      rot: new Float64Array(IDENTITY),
      pos0: new Float64Array(3),
      rot0: new Float64Array(IDENTITY),
      posA: new Float64Array(3),
      rotA: new Float64Array(IDENTITY),
      posB: new Float64Array(3),
      rotB: new Float64Array(IDENTITY),
      q0: new Float64Array([1, 0, 0, 0]),
      q1: new Float64Array([1, 0, 0, 0]),
      qA: new Float64Array([1, 0, 0, 0]),
      qB: new Float64Array([1, 0, 0, 0]),
      angle: 0,
      thin: false,
    };
    this.solids.push(s);
    const id = this.solids.length - 1;
    if (spec.pose) this.setSolidPose(id, spec.pose, { teleport: true });
    return id;
  }

  get solidCount(): number {
    return this.solids.length;
  }

  /**
   * Pose of a solid at the end of the next step(). The solver sweeps it from its pose at
   * the start of the step, so a moving wall pushes the liquid instead of jumping through
   * it. `teleport` moves it without sweeping.
   */
  setSolidPose(id: number, pose: Pose, options: { teleport?: boolean } = {}): void {
    const s = this.solids[id];
    if (!s) throw new Error(`no solid ${id}`);
    s.pos[0] = pose.position[0];
    s.pos[1] = pose.position[1];
    s.pos[2] = pose.position[2];
    if (pose.rotation) for (let i = 0; i < 9; i++) s.rot[i] = pose.rotation[i];
    else if (pose.quaternion) quatToMat(pose.quaternion, s.rot);
    if (options.teleport) {
      s.pos0.set(s.pos);
      s.rot0.set(s.rot);
    }
  }

  /** Replace a solid's shape (for example when MuJoCo resizes a geom). */
  setSolidShape(id: number, shape: SolidShape): void {
    this.solids[id].shape = shape;
  }

  setSolidEnabled(id: number, enabled: boolean): void {
    this.solids[id].enabled = enabled;
  }

  /** Current (end of step) pose of a solid. */
  solidPose(id: number): { position: Vec3; rotation: number[] } {
    const s = this.solids[id];
    return { position: [s.pos[0], s.pos[1], s.pos[2]], rotation: Array.from(s.rot) };
  }

  // ---------------------------------------------------------------- stepping

  /** Advance by dt seconds in `substeps` equal substeps. */
  step(dt: number): void {
    if (!(dt > 0)) return;
    const S = Math.max(1, this.substeps | 0);
    for (const s of this.solids) {
      matToQuat(s.rot0, s.q0);
      matToQuat(s.rot, s.q1);
      // shortest arc
      if (s.q0[0] * s.q1[0] + s.q0[1] * s.q1[1] + s.q0[2] * s.q1[2] + s.q0[3] * s.q1[3] < 0) for (let i = 0; i < 4; i++) s.q1[i] = -s.q1[i];
    }
    const sub = dt / S;
    for (let k = 0; k < S; k++) {
      this.interpolateSolids(k / S, (k + 1) / S);
      this.substep(sub);
    }
    for (const s of this.solids) {
      s.pos0.set(s.pos);
      s.rot0.set(s.rot);
    }
  }

  /**
   * Relax freshly added particles toward rest density without dynamics: `passes` solver
   * substeps with gravity off and the velocities zeroed after each. Removes the "pop"
   * of a jittered or overfilled block. Solids stay at their start-of-step poses.
   */
  relax(passes = 10): void {
    const g = Array.from(this.gravity);
    const time = this.time;
    this.gravity.fill(0);
    this.holdSolids(false);
    for (let k = 0; k < passes; k++) {
      this.substep(1 / 240);
      this.v.fill(0, 0, 3 * this.n);
    }
    this.setGravity(g);
    this.time = time;
  }

  /** every solid still over the substep, at its start-of-step pose (or its current one) */
  private holdSolids(current: boolean) {
    this.poseStamp++;
    for (const s of this.solids) {
      const P = current ? s.pos : s.pos0, R = current ? s.rot : s.rot0;
      s.posA.set(P); s.posB.set(P);
      s.rotA.set(R); s.rotB.set(R);
      matToQuat(R, s.qA);
      s.qB.set(s.qA);
      s.angle = 0;
    }
  }

  private interpolateSolids(a: number, b: number) {
    this.poseStamp++;
    for (const s of this.solids) {
      poseAt(s, a, s.posA, s.rotA, s.qA);
      poseAt(s, b, s.posB, s.rotB, s.qB);
      const dot = Math.abs(s.qA[0] * s.qB[0] + s.qA[1] * s.qB[1] + s.qA[2] * s.qB[2] + s.qA[3] * s.qB[3]);
      s.angle = 2 * Math.acos(Math.min(1, dot));
    }
  }

  private substep(dt: number) {
    const n = this.n;
    if (n === 0) {
      this.time += dt;
      return;
    }
    const { x, v, p, gravity } = this;
    const gx = gravity[0] * dt, gy = gravity[1] * dt, gz = gravity[2] * dt;
    const vmax = this.maxSpeed;
    for (let i = 0; i < n; i++) {
      const o = 3 * i;
      let vx = v[o] + gx, vy = v[o + 1] + gy, vz = v[o + 2] + gz;
      if (vmax < Infinity) {
        const s = Math.hypot(vx, vy, vz);
        if (s > vmax) {
          const f = vmax / s;
          vx *= f; vy *= f; vz *= f;
        }
      }
      v[o] = vx; v[o + 1] = vy; v[o + 2] = vz;
      p[o] = x[o] + vx * dt;
      p[o + 1] = x[o + 1] + vy * dt;
      p[o + 2] = x[o + 2] + vz * dt;
    }
    this.contactSolid.fill(-1, 0, n);
    this.contactDepth.fill(0, 0, n);
    this.touched.fill(-1, 0, n);
    this.entangled.fill(0, 0, n);
    this.collide();
    this.buildGrid(p);
    this.findNeighbors();
    this.collectWallPairs(p);
    this.filterThroughWalls(p);
    for (let it = 0; it < this.iterations; it++) {
      this.computeWallDensity(p);
      this.computeLambda();
      this.computeCorrection();
      this.collide();
    }
    let moved = this.applyFriction();
    if (vmax < Infinity && this.capDisplacement(vmax * dt)) moved = true;
    // friction and the cap move particles after the last projection: project once more
    if (moved) this.collide();
    this.closeContacts();
    this.finishVelocities(dt);
    if (this.xsph > 0 || this.vorticity > 0) {
      if (this.iterations === 0) this.computeWallDensity(p);
      this.computeDensity(p); // densities at the final positions for the SPH sums
      if (this.vorticity > 0) this.applyVorticity(dt);
      if (this.xsph > 0) this.applyXsph();
    }
    if (vmax < Infinity) this.capVelocities(vmax);
    x.set(p.subarray(0, 3 * n));
    this.time += dt;
  }

  // ---------------------------------------------------------------- neighbours

  /**
   * Hashed uniform grid, cells of h. A particle's cell is its integer coordinates
   * floor(p / h) (clamped far out, which keeps neighbours in adjacent cells), hashed
   * into a table of about 2 n buckets. Counting sort by bucket, then by cell inside a
   * bucket, makes each cell's particles contiguous; a copy of the positions in that
   * order follows. The cost depends on the number of particles, not on how far apart
   * they are: a drop splashed a metre away costs what it costs anywhere else.
   */
  private buildGrid(pos: Float64Array) {
    const n = this.n, inv = 1 / this.h;
    let T = 1024;
    while (T < 2 * n) T *= 2;
    if (this.cellStart.length !== T + 1) {
      this.cellStart = new Int32Array(T + 1);
      this.cursor = new Int32Array(T);
    }
    const mask = (this.tableMask = T - 1);
    const start = this.cellStart, cursor = this.cursor, bucketOf = this.cellOf;
    const { cellX, cellY, cellZ } = this;
    start.fill(0);
    for (let i = 0; i < n; i++) {
      const cx = clampCell(Math.floor(pos[3 * i] * inv)), cy = clampCell(Math.floor(pos[3 * i + 1] * inv)), cz = clampCell(Math.floor(pos[3 * i + 2] * inv));
      cellX[i] = cx; cellY[i] = cy; cellZ[i] = cz;
      const b = cellHash(cx, cy, cz) & mask;
      bucketOf[i] = b;
      start[b + 1]++;
    }
    for (let b = 0; b < T; b++) start[b + 1] += start[b];
    cursor.set(start.subarray(0, T));
    const entries = this.cellEntries;
    for (let i = 0; i < n; i++) entries[cursor[bucketOf[i]]++] = i;
    // inside a bucket, order by cell (buckets are small: insertion sort)
    for (let b = 0; b < T; b++) {
      const b0 = start[b], b1 = start[b + 1];
      for (let k = b0 + 1; k < b1; k++) {
        const j = entries[k];
        let m = k - 1;
        while (m >= b0 && cellLess(cellX, cellY, cellZ, j, entries[m])) {
          entries[m + 1] = entries[m];
          m--;
        }
        entries[m + 1] = j;
      }
    }
    if (this.sortedPos.length < 3 * n) this.sortedPos = new Float64Array(3 * this.cap);
    const sp = this.sortedPos;
    for (let e = 0; e < n; e++) {
      const j = entries[e];
      sp[3 * e] = pos[3 * j];
      sp[3 * e + 1] = pos[3 * j + 1];
      sp[3 * e + 2] = pos[3 * j + 2];
    }
  }

  private cursor = new Int32Array(0);
  private sortedPos = new Float64Array(0);
  private tableMask = 0;
  /** neighbour candidates examined since creation (diagnostic: the search's work) */
  neighborCandidates = 0;
  /** buckets of the neighbour hash table (diagnostic) */
  get gridTableSize(): number {
    return this.tableMask + 1;
  }

  private gx = new Float64Array(0);
  private gy = new Float64Array(0);
  private gz = new Float64Array(0);
  private gi = new Int32Array(0);

  /**
   * Neighbour lists of the positions last passed to buildGrid. Cell by cell: gather the
   * particles of the 27 surrounding cells (their buckets, keeping only the right cell, so
   * hash collisions cost a check and never a wrong pair) into one scratch list, then scan
   * it once per particle of the cell: one long loop per particle, which JavaScript runs fast.
   */
  private findNeighbors() {
    const n = this.n, h2 = this.h * this.h, K = this.maxNbr, mask = this.tableMask;
    const { nbr, nbrCount, cellStart, cellEntries, cellX, cellY, cellZ } = this;
    const sp = this.sortedPos;
    let overflow = 0, examined = 0;
    let e = 0;
    while (e < n) {
      const i0 = cellEntries[e];
      const cx = cellX[i0], cy = cellY[i0], cz = cellZ[i0];
      let e1 = e + 1;
      while (e1 < n) {
        const j = cellEntries[e1];
        if (cellX[j] !== cx || cellY[j] !== cy || cellZ[j] !== cz) break;
        e1++;
      }
      // gather the 27-cell neighbourhood
      let m = 0;
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy, nz = cz + dz;
            const b = cellHash(nx, ny, nz) & mask;
            const k0 = cellStart[b], k1 = cellStart[b + 1];
            if (m + k1 - k0 > this.gx.length) this.growScratch(m + k1 - k0);
            const { gx, gy, gz, gi } = this;
            for (let k = k0; k < k1; k++) {
              const j = cellEntries[k];
              if (cellX[j] !== nx || cellY[j] !== ny || cellZ[j] !== nz) continue;
              gx[m] = sp[3 * k];
              gy[m] = sp[3 * k + 1];
              gz[m] = sp[3 * k + 2];
              gi[m++] = j;
            }
          }
      const { gx, gy, gz, gi } = this;
      for (let q = e; q < e1; q++) {
        const i = cellEntries[q];
        const px = sp[3 * q], py = sp[3 * q + 1], pz = sp[3 * q + 2];
        const base = i * K;
        let cnt = 0;
        for (let k = 0; k < m; k++) {
          const dx = px - gx[k], dy = py - gy[k], dz = pz - gz[k];
          if (dx * dx + dy * dy + dz * dz < h2) {
            const j = gi[k];
            if (j === i) continue;
            if (cnt < K) nbr[base + cnt++] = j;
            else overflow++;
          }
        }
        nbrCount[i] = cnt;
      }
      examined += m * (e1 - e);
      e = e1;
    }
    this.neighborOverflow += overflow;
    this.neighborCandidates += examined;
  }

  private growScratch(need: number) {
    const size = Math.max(256, need * 2);
    const gx = new Float64Array(size), gy = new Float64Array(size), gz = new Float64Array(size), gi = new Int32Array(size);
    gx.set(this.gx); gy.set(this.gy); gz.set(this.gz); gi.set(this.gi);
    this.gx = gx; this.gy = gy; this.gz = gz; this.gi = gi;
  }

  // ---------------------------------------------------------------- density constraint

  private computeLambda() {
    const n = this.n, K = this.maxNbr;
    const { p, nbr, nbrCount, lambda, rho, wallRho, wallGrad } = this;
    const h = this.h, h2 = h * h;
    const m = this.kernelMass, rho0 = this.restDensity;
    const poly6C = this.poly6C, spikyC = this.spikyC;
    const gScale = (m / rho0) * spikyC;
    const self = m * poly6C * h2 * h2 * h2;
    const cohesion = this.cohesion, eps = this.eps, denomFloor = this.denomFloor;
    for (let i = 0; i < n; i++) {
      const px = p[3 * i], py = p[3 * i + 1], pz = p[3 * i + 2];
      let density = self + wallRho[i];
      let gix = wallGrad[3 * i], giy = wallGrad[3 * i + 1], giz = wallGrad[3 * i + 2], sum2 = 0;
      const base = i * K;
      for (let k = 0, c = nbrCount[i]; k < c; k++) {
        const j = nbr[base + k];
        const dx = px - p[3 * j], dy = py - p[3 * j + 1], dz = pz - p[3 * j + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= h2) continue;
        const t = h2 - r2;
        density += m * poly6C * t * t * t;
        const r = Math.sqrt(r2);
        if (r > 1e-12) {
          const hr = h - r;
          const g = (gScale * hr * hr) / r; // grad_i C_i contribution = g * (dx, dy, dz)
          const ux = g * dx, uy = g * dy, uz = g * dz;
          gix += ux; giy += uy; giz += uz;
          sum2 += ux * ux + uy * uy + uz * uz;
        }
      }
      rho[i] = density;
      let C = density / rho0 - 1;
      if (C < 0) C *= cohesion;
      sum2 += gix * gix + giy * giy + giz * giz;
      const den = sum2 + eps;
      lambda[i] = C === 0 ? 0 : -C / (den > denomFloor ? den : denomFloor);
    }
  }

  private computeCorrection() {
    const n = this.n, K = this.maxNbr;
    const { p, dp, nbr, nbrCount, lambda, wallGrad } = this;
    const h = this.h, h2 = h * h;
    const coef = (this.kernelMass / this.restDensity) * this.spikyC;
    const k = this.scorrK * this.lambdaScale, nExp = this.scorrN;
    const invWdq = 1 / this.wDq, poly6C = this.poly6C;
    const maxCorr = this.maxCorr, maxCorr2 = maxCorr * maxCorr;
    for (let i = 0; i < n; i++) {
      const px = p[3 * i], py = p[3 * i + 1], pz = p[3 * i + 2];
      const li = lambda[i];
      // the walls' part of grad_i C_i
      let ax = li * wallGrad[3 * i], ay = li * wallGrad[3 * i + 1], az = li * wallGrad[3 * i + 2];
      const base = i * K;
      for (let q = 0, c = nbrCount[i]; q < c; q++) {
        const j = nbr[base + q];
        const dx = px - p[3 * j], dy = py - p[3 * j + 1], dz = pz - p[3 * j + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= h2) continue;
        const r = Math.sqrt(r2);
        if (r < 1e-12) continue;
        // dp_i = sum_j (lambda_i + lambda_j + s_corr) (m / rho0) grad W_ij
        let s = li + lambda[j];
        if (k > 0) {
          const t = h2 - r2;
          const ratio = poly6C * t * t * t * invWdq;
          const r4 = ratio * ratio * ratio * ratio;
          const term = nExp === 4 ? r4 : Math.pow(ratio, nExp);
          s -= k * (term < SCORR_CAP ? term : SCORR_CAP); // never Infinity, whatever the settings
        }
        const hr = h - r;
        const g = (s * coef * hr * hr) / r;
        ax += g * dx; ay += g * dy; az += g * dz;
      }
      const a2 = ax * ax + ay * ay + az * az;
      if (a2 > maxCorr2) {
        const f = maxCorr / Math.sqrt(a2);
        ax *= f; ay *= f; az *= f;
      }
      dp[3 * i] = ax; dp[3 * i + 1] = ay; dp[3 * i + 2] = az;
    }
    for (let i = 0; i < 3 * n; i++) p[i] += dp[i];
  }

  private computeDensity(pos: Float64Array) {
    const n = this.n, K = this.maxNbr;
    const { nbr, nbrCount, rho, wallRho } = this;
    const h2 = this.h * this.h, m = this.kernelMass, poly6C = this.poly6C;
    for (let i = 0; i < n; i++) {
      const px = pos[3 * i], py = pos[3 * i + 1], pz = pos[3 * i + 2];
      let density = m * poly6C * h2 * h2 * h2 + wallRho[i];
      const base = i * K;
      for (let q = 0, c = nbrCount[i]; q < c; q++) {
        const j = nbr[base + q];
        const dx = px - pos[3 * j], dy = py - pos[3 * j + 1], dz = pz - pos[3 * j + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= h2) continue;
        const t = h2 - r2;
        density += m * poly6C * t * t * t;
      }
      rho[i] = density;
    }
  }

  // ---------------------------------------------------------------- velocities

  /**
   * Coulomb friction against each particle's dominant contact of the substep: the
   * tangential displacement relative to that wall shrinks by at most mu times the depth
   * that wall pushed the particle out by. The caller projects once more afterwards.
   */
  private applyFriction(): boolean {
    let moved = false;
    const n = this.n;
    const { x, p, contactSolid, contactNormal, contactDepth } = this;
    const sv = this.tmpSv;
    for (let i = 0; i < n; i++) {
      const sid = contactSolid[i];
      if (sid === -1) continue;
      const mu = sid === BOUNDS_ID ? this.friction : this.solids[sid].friction;
      if (!(mu > 0)) continue;
      const o = 3 * i;
      if (sid === BOUNDS_ID) sv[0] = sv[1] = sv[2] = 0;
      else this.solidDisplacement(this.solids[sid], p[o], p[o + 1], p[o + 2], sv);
      const nx = contactNormal[o], ny = contactNormal[o + 1], nz = contactNormal[o + 2];
      const rx = p[o] - x[o] - sv[0], ry = p[o + 1] - x[o + 1] - sv[1], rz = p[o + 2] - x[o + 2] - sv[2];
      const rn = rx * nx + ry * ny + rz * nz;
      const tx = rx - rn * nx, ty = ry - rn * ny, tz = rz - rn * nz;
      const tl = Math.hypot(tx, ty, tz);
      if (tl > 1e-15) {
        const f = Math.min(1, (mu * contactDepth[i]) / tl);
        p[o] -= f * tx; p[o + 1] -= f * ty; p[o + 2] -= f * tz;
        moved = true;
      }
    }
    return moved;
  }

  /** no particle moves further than `maxStep` in one substep (the walls' final projection still wins) */
  private capDisplacement(maxStep: number): boolean {
    let moved = false;
    const { x, p } = this;
    for (let i = 0; i < this.n; i++) {
      const o = 3 * i;
      const dx = p[o] - x[o], dy = p[o + 1] - x[o + 1], dz = p[o + 2] - x[o + 2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l > maxStep) {
        const f = maxStep / l;
        p[o] = x[o] + dx * f; p[o + 1] = x[o + 1] + dy * f; p[o + 2] = x[o + 2] + dz * f;
        moved = true;
      }
    }
    return moved;
  }

  private capVelocities(vmax: number) {
    const v = this.v;
    for (let i = 0; i < this.n; i++) {
      const o = 3 * i;
      const s = Math.hypot(v[o], v[o + 1], v[o + 2]);
      if (s > vmax) {
        const f = vmax / s;
        v[o] *= f; v[o + 1] *= f; v[o + 2] *= f;
      }
    }
  }

  /** v = (p - x) / dt, then restitution against the dominant contact */
  private finishVelocities(dt: number) {
    const n = this.n;
    const { x, v, p, contactSolid, contactNormal } = this;
    const sv = this.tmpSv;
    for (let i = 0; i < n; i++) {
      const o = 3 * i;
      const sid = contactSolid[i];
      let vx = (p[o] - x[o]) / dt, vy = (p[o + 1] - x[o + 1]) / dt, vz = (p[o + 2] - x[o + 2]) / dt;
      const e = sid === -1 ? 0 : sid === BOUNDS_ID ? this.restitution : this.solids[sid].restitution;
      if (e > 0) {
        if (sid === BOUNDS_ID) sv[0] = sv[1] = sv[2] = 0;
        else this.solidDisplacement(this.solids[sid], p[o], p[o + 1], p[o + 2], sv);
        const nx = contactNormal[o], ny = contactNormal[o + 1], nz = contactNormal[o + 2];
        // incoming normal speed relative to the wall, from the velocity at the start of the substep
        const vin = (v[o] - sv[0] / dt) * nx + (v[o + 1] - sv[1] / dt) * ny + (v[o + 2] - sv[2] / dt) * nz;
        if (vin < 0) {
          const vrel = (vx - sv[0] / dt) * nx + (vy - sv[1] / dt) * ny + (vz - sv[2] / dt) * nz;
          const target = -e * vin;
          if (vrel < target) {
            vx += (target - vrel) * nx; vy += (target - vrel) * ny; vz += (target - vrel) * nz;
          }
        }
      }
      v[o] = vx; v[o + 1] = vy; v[o + 2] = vz;
    }
  }

  private readonly tmpSv = [0, 0, 0];

  /** displacement over the current substep of the solid's material point now at (px, py, pz) */
  private solidDisplacement(s: Solid, px: number, py: number, pz: number, out: number[]) {
    const B = s.rotB, A = s.rotA;
    const dx = px - s.posB[0], dy = py - s.posB[1], dz = pz - s.posB[2];
    const lx = B[0] * dx + B[3] * dy + B[6] * dz;
    const ly = B[1] * dx + B[4] * dy + B[7] * dz;
    const lz = B[2] * dx + B[5] * dy + B[8] * dz;
    out[0] = px - (s.posA[0] + A[0] * lx + A[1] * ly + A[2] * lz);
    out[1] = py - (s.posA[1] + A[3] * lx + A[4] * ly + A[5] * lz);
    out[2] = pz - (s.posA[2] + A[6] * lx + A[7] * ly + A[8] * lz);
  }

  private applyXsph() {
    const n = this.n, K = this.maxNbr;
    const { p, v, vNew, nbr, nbrCount, rho } = this;
    const h2 = this.h * this.h, m = this.kernelMass, poly6C = this.poly6C, c = this.xsph;
    for (let i = 0; i < n; i++) {
      const o = 3 * i;
      const px = p[o], py = p[o + 1], pz = p[o + 2];
      let ax = 0, ay = 0, az = 0;
      const base = i * K;
      for (let q = 0, cnt = nbrCount[i]; q < cnt; q++) {
        const j = nbr[base + q];
        const dx = px - p[3 * j], dy = py - p[3 * j + 1], dz = pz - p[3 * j + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= h2) continue;
        const t = h2 - r2;
        const wgt = ((m / rho[j]) * poly6C * t * t * t);
        ax += wgt * (v[3 * j] - v[o]);
        ay += wgt * (v[3 * j + 1] - v[o + 1]);
        az += wgt * (v[3 * j + 2] - v[o + 2]);
      }
      vNew[o] = v[o] + c * ax;
      vNew[o + 1] = v[o + 1] + c * ay;
      vNew[o + 2] = v[o + 2] + c * az;
    }
    v.set(vNew.subarray(0, 3 * n));
  }

  private applyVorticity(dt: number) {
    const n = this.n, K = this.maxNbr;
    const { p, v, omega, nbr, nbrCount, rho } = this;
    const h = this.h, h2 = h * h, m = this.kernelMass, spikyC = this.spikyC;
    // omega_i = sum_j (m / rho_j) (v_j - v_i) x grad_j W_ij, with grad_j W_ij = -grad_i W_ij
    for (let i = 0; i < n; i++) {
      const o = 3 * i;
      let wx = 0, wy = 0, wz = 0;
      const base = i * K;
      for (let q = 0, c = nbrCount[i]; q < c; q++) {
        const j = nbr[base + q];
        const dx = p[o] - p[3 * j], dy = p[o + 1] - p[3 * j + 1], dz = p[o + 2] - p[3 * j + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= h2) continue;
        const r = Math.sqrt(r2);
        if (r < 1e-12) continue;
        const hr = h - r;
        const g = -((m / rho[j]) * spikyC * hr * hr) / r; // grad_j W = g * d
        const gx = g * dx, gy = g * dy, gz = g * dz;
        const ux = v[3 * j] - v[o], uy = v[3 * j + 1] - v[o + 1], uz = v[3 * j + 2] - v[o + 2];
        wx += uy * gz - uz * gy;
        wy += uz * gx - ux * gz;
        wz += ux * gy - uy * gx;
      }
      omega[o] = wx; omega[o + 1] = wy; omega[o + 2] = wz;
    }
    const eps = this.vorticity;
    for (let i = 0; i < n; i++) {
      const o = 3 * i;
      const wi = Math.hypot(omega[o], omega[o + 1], omega[o + 2]);
      let ex = 0, ey = 0, ez = 0;
      const base = i * K;
      for (let q = 0, c = nbrCount[i]; q < c; q++) {
        const j = nbr[base + q];
        const dx = p[o] - p[3 * j], dy = p[o + 1] - p[3 * j + 1], dz = p[o + 2] - p[3 * j + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= h2) continue;
        const r = Math.sqrt(r2);
        if (r < 1e-12) continue;
        const hr = h - r;
        const wj = Math.hypot(omega[3 * j], omega[3 * j + 1], omega[3 * j + 2]);
        const g = ((m / rho[j]) * (wj - wi) * spikyC * hr * hr) / r; // grad_i |omega|
        ex += g * dx; ey += g * dy; ez += g * dz;
      }
      const el = Math.hypot(ex, ey, ez);
      if (el < 1e-12) continue;
      const Nx = ex / el, Ny = ey / el, Nz = ez / el;
      v[o] += dt * eps * (Ny * omega[o + 2] - Nz * omega[o + 1]);
      v[o + 1] += dt * eps * (Nz * omega[o] - Nx * omega[o + 2]);
      v[o + 2] += dt * eps * (Nx * omega[o + 1] - Ny * omega[o]);
    }
  }

  // ---------------------------------------------------------------- solids

  /**
   * Push predicted positions out of every enabled solid and inside the bounds. A particle
   * whose path crosses a solid during the substep is caught too, so nothing tunnels:
   * against a solid that only translates, by an exact swept test of the straight
   * relative path; against a rotating one, by sampling its interpolated poses finely
   * enough that the particle moves less than the solid is thick between samples.
   */
  private collide() {
    const n = this.n;
    const { x, p, contactSolid, contactNormal, contactDepth } = this;
    const r = this.collisionRadius;
    const loc = this.tmpLoc, start = this.tmpStart, nrm = this.tmpNrm;
    for (let sid = 0; sid < this.solids.length; sid++) {
      const s = this.solids[sid];
      if (!s.enabled) continue;
      const B = s.rotB, A = s.rotA;
      const rotating = s.angle > ROTATION_EPS;
      const bb = this.sweptBounds(s, r, rotating);
      const isPlane = s.shape.type === "plane";
      const thin = minHalfThickness(s.shape) + r;
      for (let i = 0; i < n; i++) {
        const o = 3 * i;
        const px = p[o], py = p[o + 1], pz = p[o + 2];
        if (bb) {
          // the particle's path box against everywhere the solid can be during the substep
          const x0 = x[o], y0 = x[o + 1], z0 = x[o + 2];
          if ((px > x0 ? px : x0) < bb[0] || (px < x0 ? px : x0) > bb[3]) continue;
          if ((py > y0 ? py : y0) < bb[1] || (py < y0 ? py : y0) > bb[4]) continue;
          if ((pz > z0 ? pz : z0) < bb[2] || (pz < z0 ? pz : z0) > bb[5]) continue;
        }
        // predicted position in the end-of-substep frame
        let dx = px - s.posB[0], dy = py - s.posB[1], dz = pz - s.posB[2];
        loc[0] = B[0] * dx + B[3] * dy + B[6] * dz;
        loc[1] = B[1] * dx + B[4] * dy + B[7] * dz;
        loc[2] = B[2] * dx + B[5] * dy + B[8] * dz;
        // start position in the start-of-substep frame: tells which side it came from
        dx = x[o] - s.posA[0]; dy = x[o + 1] - s.posA[1]; dz = x[o + 2] - s.posA[2];
        start[0] = A[0] * dx + A[3] * dy + A[6] * dz;
        start[1] = A[1] * dx + A[4] * dy + A[7] * dz;
        start[2] = A[2] * dx + A[5] * dy + A[8] * dz;
        let hit = projectOut(s.shape, r, loc, start, nrm);
        if (!hit) {
          // the end point is clear: did the path meet the solid on the way?
          if (rotating) hit = this.sweepRotating(s, r, i, start, loc, nrm, thin);
          else if (!isPlane) hit = sweepStraight(s.shape, r, start, loc, nrm, this.tmpQ, this.tmpT); // a translating half-space cannot be crossed and left
          // a swept push is not a projection onto this solid's surface alone: check the others after
          if (hit) this.entangled[i] = 1;
        }
        if (!hit) continue;
        this.placeOnSolid(i, sid, s, loc, nrm);
      }
    }
    const b = this.bounds;
    if (b) {
      for (let i = 0; i < n; i++) {
        for (let a = 0; a < 3; a++) {
          const o = 3 * i + a;
          const lo = b.min[a] + r, hi = b.max[a] - r;
          let v = p[o], sign = 0, depth = 0;
          if (v < lo) { depth = lo - v; v = lo; sign = 1; }
          else if (v > hi) { depth = v - hi; v = hi; sign = -1; }
          if (sign === 0) continue;
          p[o] = v;
          const cur = contactSolid[i];
          if (cur === BOUNDS_ID) contactDepth[i] += depth;
          else if (cur === -1 || depth > contactDepth[i]) {
            contactSolid[i] = BOUNDS_ID;
            contactDepth[i] = depth;
          } else continue;
          contactNormal[3 * i] = contactNormal[3 * i + 1] = contactNormal[3 * i + 2] = 0;
          contactNormal[o] = sign;
        }
      }
    }
  }

  /**
   * Move particle i to the end-frame local point `loc` of solid s and keep the dominant
   * contact of the substep (friction and restitution act against it). A particle that
   * touches a second solid in the substep is marked for the closing pass.
   */
  private placeOnSolid(i: number, sid: number, s: Solid, loc: Float64Array, nrm: Float64Array) {
    const { p, contactSolid, contactNormal, contactDepth } = this;
    const B = s.rotB, o = 3 * i;
    const wx = s.posB[0] + B[0] * loc[0] + B[1] * loc[1] + B[2] * loc[2];
    const wy = s.posB[1] + B[3] * loc[0] + B[4] * loc[1] + B[5] * loc[2];
    const wz = s.posB[2] + B[6] * loc[0] + B[7] * loc[1] + B[8] * loc[2];
    const depth = Math.hypot(wx - p[o], wy - p[o + 1], wz - p[o + 2]);
    p[o] = wx; p[o + 1] = wy; p[o + 2] = wz;
    if (this.touched[i] === -1) this.touched[i] = sid;
    else if (this.touched[i] !== sid) this.entangled[i] = 1;
    const cur = contactSolid[i];
    if (cur === sid) contactDepth[i] += depth;
    else if (cur === -1 || depth > contactDepth[i]) {
      contactSolid[i] = sid;
      contactDepth[i] = depth;
    } else return;
    contactNormal[o] = B[0] * nrm[0] + B[1] * nrm[1] + B[2] * nrm[2];
    contactNormal[o + 1] = B[3] * nrm[0] + B[4] * nrm[1] + B[5] * nrm[2];
    contactNormal[o + 2] = B[6] * nrm[0] + B[7] * nrm[1] + B[8] * nrm[2];
  }

  /**
   * End of substep: particles pushed by a swept contact, or touching two or more solids,
   * are projected out of every solid at its end pose again (end points only, Gauss-Seidel,
   * until nothing moves, at most 4 rounds), so a push from one solid cannot leave them
   * inside another. Where solids leave no room at all the last projection wins.
   */
  private closeContacts() {
    const n = this.n, r = this.collisionRadius;
    const { x, p, entangled } = this;
    const loc = this.tmpLoc, start = this.tmpStart, nrm = this.tmpNrm;
    let any = false;
    for (let i = 0; i < n && !any; i++) if (entangled[i]) any = true;
    if (!any) return;
    for (let round = 0; round < 4; round++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        if (!entangled[i]) continue;
        const o = 3 * i;
        for (let sid = 0; sid < this.solids.length; sid++) {
          const s = this.solids[sid];
          if (!s.enabled) continue;
          toLocal(s, p, i, loc);
          const A = s.rotA;
          const dx = x[o] - s.posA[0], dy = x[o + 1] - s.posA[1], dz = x[o + 2] - s.posA[2];
          start[0] = A[0] * dx + A[3] * dy + A[6] * dz;
          start[1] = A[1] * dx + A[4] * dy + A[7] * dz;
          start[2] = A[2] * dx + A[5] * dy + A[8] * dz;
          if (!projectOut(s.shape, r, loc, start, nrm)) continue;
          this.placeOnSolid(i, sid, s, loc, nrm);
          moved = true;
        }
        const b = this.bounds;
        if (b)
          for (let a = 0; a < 3; a++) {
            const lo = b.min[a] + r, hi = b.max[a] - r;
            if (p[o + a] < lo) { p[o + a] = lo; moved = true; }
            else if (p[o + a] > hi) { p[o + a] = hi; moved = true; }
          }
      }
      if (!moved) break;
    }
  }

  /** world box holding every pose of a solid over the substep, inflated by pad; null when unbounded */
  private sweptBounds(s: Solid, pad: number, rotating: boolean): number[] | null {
    if (s.shape.type === "plane") return null;
    if (!rotating) {
      // a translating solid: its start and end boxes bound the motion
      const a = this.solidAabb(s, pad, false)!, b = this.solidAabb(s, pad, true)!;
      return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])];
    }
    // a rotating one: its bounding sphere, swept from start to end
    const rad = boundingRadius(s.shape) + pad * 1.001;
    const A = s.posA, B = s.posB;
    return [Math.min(A[0], B[0]) - rad, Math.min(A[1], B[1]) - rad, Math.min(A[2], B[2]) - rad, Math.max(A[0], B[0]) + rad, Math.max(A[1], B[1]) + rad, Math.max(A[2], B[2]) + rad];
  }

  /**
   * Path of particle i against a rotating solid. Its exact poses (position lerp, rotation
   * nlerp, as the substeps themselves) are sampled at N instants, N chosen for this
   * particle alone so it moves less than the solid's half-thickness relative to it
   * between samples (a plane: half the collision radius, and the lowest sample is then
   * refined): no crossing falls between samples, and one fast particle elsewhere does not
   * raise everyone's count. Walking the samples, every time the particle (with the pushes
   * so far) is inside, the solid pushes it out again, so a fast wall sweeps it along and a
   * plane that dips through it and retreats leaves just its push. `loc` becomes the end
   * point plus the pushes, in the end frame, still projected out if the solid is there.
   */
  private sweepRotating(s: Solid, r: number, i: number, start: Float64Array, loc: Float64Array, nrm: Float64Array, thin: number): boolean {
    const { x, p } = this;
    const o = 3 * i;
    const PA = s.posA, PB = s.posB;
    const dP = Math.hypot(PB[0] - PA[0], PB[1] - PA[1], PB[2] - PA[2]);
    const arm = Math.max(Math.hypot(x[o] - PA[0], x[o + 1] - PA[1], x[o + 2] - PA[2]), Math.hypot(p[o] - PB[0], p[o + 1] - PB[1], p[o + 2] - PB[2])) + dP;
    // bound on the relative path length (nlerp turns at most ~1.1x faster than uniform)
    const path = 1.3 * (Math.hypot(p[o] - x[o], p[o + 1] - x[o + 1], p[o + 2] - x[o + 2]) + dP + s.angle * arm);
    // distance to a surface changes no faster than the point moves: too far to reach it, skip
    if (surfaceDistance(s.shape, start, this.tmpN2) - r > path) return false;
    const plane = s.shape.type === "plane";
    const need = Math.ceil(path / (plane ? r / 2 : thin));
    // too fast or too thin for sampling: exact conservative advancement instead
    if (need > MAX_SWEEP_SAMPLES) return this.advanceRotating(s, r, i, start, loc, nrm);
    const N = Math.max(2, need);
    this.sweepSampleCount += N - 1;
    this.sampleTable(s, N);
    const SP = this.tablePos, SR = this.tableRot, q = this.tmpQ, prev = this.tmpPrev, raw = this.tmpRaw, D = this.tmpD;
    D[0] = D[1] = D[2] = 0;
    prev.set(start);
    let pushed = false, kLow = -1, low = Infinity;
    for (let k = 1; k < N; k++) {
      const t = k / N, R = 9 * k;
      const wx = x[o] + (p[o] - x[o]) * t + D[0] - SP[3 * k], wy = x[o + 1] + (p[o + 1] - x[o + 1]) * t + D[1] - SP[3 * k + 1], wz = x[o + 2] + (p[o + 2] - x[o + 2]) * t + D[2] - SP[3 * k + 2];
      q[0] = SR[R] * wx + SR[R + 3] * wy + SR[R + 6] * wz;
      q[1] = SR[R + 1] * wx + SR[R + 4] * wy + SR[R + 7] * wz;
      q[2] = SR[R + 2] * wx + SR[R + 5] * wy + SR[R + 8] * wz;
      raw.set(q);
      if (projectOut(s.shape, r, q, prev, nrm)) {
        // the push, back in world coordinates
        const ux = q[0] - raw[0], uy = q[1] - raw[1], uz = q[2] - raw[2];
        D[0] += SR[R] * ux + SR[R + 1] * uy + SR[R + 2] * uz;
        D[1] += SR[R + 3] * ux + SR[R + 4] * uy + SR[R + 5] * uz;
        D[2] += SR[R + 6] * ux + SR[R + 7] * uy + SR[R + 8] * uz;
        pushed = true;
      } else if (plane && q[2] < low) {
        low = q[2];
        kLow = k;
      }
      prev.set(q);
    }
    if (plane && !pushed && kLow > 0) {
      // a dip between two samples: refine the lowest point of the path above the plane
      const height = (t: number) => {
        this.poseAtSub(s, t, this.tmpP2, this.tmpR2);
        const R = this.tmpR2, P = this.tmpP2;
        return R[2] * (x[o] + (p[o] - x[o]) * t - P[0]) + R[5] * (x[o + 1] + (p[o + 1] - x[o + 1]) * t - P[1]) + R[8] * (x[o + 2] + (p[o + 2] - x[o + 2]) * t - P[2]);
      };
      const tm = goldenMin(height, (kLow - 1) / N, Math.min(1, (kLow + 1) / N), 40);
      const z = height(tm); // leaves the pose at tm in tmpR2 / tmpP2
      if (z < r) {
        const R = this.tmpR2;
        D[0] = R[2] * (r - z); D[1] = R[5] * (r - z); D[2] = R[8] * (r - z);
        nrm[0] = 0; nrm[1] = 0; nrm[2] = 1;
        pushed = true;
      }
    }
    if (!pushed) return false;
    const B = s.rotB;
    const dx = p[o] + D[0] - PB[0], dy = p[o + 1] + D[1] - PB[1], dz = p[o + 2] + D[2] - PB[2];
    loc[0] = B[0] * dx + B[3] * dy + B[6] * dz;
    loc[1] = B[1] * dx + B[4] * dy + B[7] * dz;
    loc[2] = B[2] * dx + B[5] * dy + B[8] * dz;
    if (projectOut(s.shape, r, loc, prev, this.tmpN2)) nrm.set(this.tmpN2); // still in the way at the end: pushed on
    return true;
  }

  private readonly tmpRaw = new Float64Array(3);
  private readonly tmpD = new Float64Array(3);

  /**
   * Exact sweep for a particle the sampling would need more than MAX_SWEEP_SAMPLES for
   * (a very thin or very fast rotating solid): conservative advancement on the true
   * rounded shape. From t = 0, step t by (distance to the inflated surface) / (upper
   * bound on the relative point speed): linear part |(p - x) - (PB - PA)| plus the
   * nlerp's top turning rate 4 tan(angle / 4) times the farthest the particle gets from
   * the solid's centre. No step can jump the surface and the steps shrink only near it;
   * a cap on their number ends in a contact, so it always terminates and never tunnels.
   * On contact the solid carries the contact point to its end pose, and the particle adds
   * its own remaining motion except any part into the solid.
   */
  private advanceRotating(s: Solid, r: number, i: number, start: Float64Array, loc: Float64Array, nrm: Float64Array): boolean {
    const { x, p } = this;
    const o = 3 * i;
    const PA = s.posA, PB = s.posB;
    const lin = Math.hypot(p[o] - x[o] - (PB[0] - PA[0]), p[o + 1] - x[o + 1] - (PB[1] - PA[1]), p[o + 2] - x[o + 2] - (PB[2] - PA[2]));
    // |w(t) - P(t)| is convex in t, so its largest value is at an end
    const arm = Math.max(Math.hypot(x[o] - PA[0], x[o + 1] - PA[1], x[o + 2] - PA[2]), Math.hypot(p[o] - PB[0], p[o + 1] - PB[1], p[o + 2] - PB[2]));
    const speed = lin + 4 * Math.tan(s.angle / 4) * arm;
    if (!(speed > 0)) return false;
    const q = this.tmpQ, nq = this.tmpN2, R = this.tmpR2, P = this.tmpP2;
    q.set(start);
    let t = 0, contact = false;
    for (let step = 0; step < 100000; step++) {
      const d = surfaceDistance(s.shape, q, nq) - r;
      if (d <= SURFACE_EPS) {
        contact = true;
        break;
      }
      t += d / speed;
      if (t >= 1) break;
      this.poseAtSub(s, t, P, R);
      const wx = x[o] + (p[o] - x[o]) * t - P[0], wy = x[o + 1] + (p[o + 1] - x[o + 1]) * t - P[1], wz = x[o + 2] + (p[o + 2] - x[o + 2]) * t - P[2];
      q[0] = R[0] * wx + R[3] * wy + R[6] * wz;
      q[1] = R[1] * wx + R[4] * wy + R[7] * wz;
      q[2] = R[2] * wx + R[5] * wy + R[8] * wz;
      if (step === 99999) contact = true; // ending in a contact keeps it safe
    }
    this.sweepSampleCount++;
    this.advanceCount++;
    if (!contact) return false;
    // the solid carries the contact point; the particle adds its own later motion, never into the solid
    surfaceDistance(s.shape, q, nq);
    const B = s.rotB, rest = 1 - t;
    const ox = (p[o] - x[o]) * rest, oy = (p[o + 1] - x[o + 1]) * rest, oz = (p[o + 2] - x[o + 2]) * rest;
    let ux = B[0] * ox + B[3] * oy + B[6] * oz, uy = B[1] * ox + B[4] * oy + B[7] * oz, uz = B[2] * ox + B[5] * oy + B[8] * oz;
    const un = ux * nq[0] + uy * nq[1] + uz * nq[2];
    if (un < 0) {
      ux -= un * nq[0]; uy -= un * nq[1]; uz -= un * nq[2];
    }
    loc[0] = q[0] + ux; loc[1] = q[1] + uy; loc[2] = q[2] + uz;
    nrm.set(nq);
    this.tmpPrev.set(q);
    if (projectOut(s.shape, r, loc, this.tmpPrev, nq)) nrm.set(nq); // still in the way at the end: pushed on
    return true;
  }

  /** particle sweeps resolved by conservative advancement since creation (diagnostic) */
  advanceCount = 0;

  /**
   * A rotating solid's poses at k / N of the substep, k = 1 .. N-1, kept per (solid, N)
   * for the substep so particles needing the same N share them.
   */
  private sampleTable(s: Solid, N: number) {
    if (this.tableStamp !== this.poseStamp) {
      this.tables.clear();
      this.tableStamp = this.poseStamp;
    }
    const key = this.solids.indexOf(s) * (MAX_SWEEP_SAMPLES + 1) + N;
    let tab = this.tables.get(key);
    if (!tab) {
      tab = { pos: new Float64Array(3 * N), rot: new Float64Array(9 * N) };
      for (let k = 1; k < N; k++) {
        this.poseAtSub(s, k / N, this.tmpP2, this.tmpR2);
        tab.pos.set(this.tmpP2, 3 * k);
        tab.rot.set(this.tmpR2, 9 * k);
      }
      this.tables.set(key, tab);
    }
    this.tablePos = tab.pos;
    this.tableRot = tab.rot;
  }

  /** pose of a solid at fraction t of the current substep */
  private poseAtSub(s: Solid, t: number, pos: Float64Array, rot: Float64Array) {
    const quat = this.tmpQuat;
    for (let a = 0; a < 4; a++) quat[a] = s.qA[a] + (s.qB[a] - s.qA[a]) * t;
    quatToMat(quat, rot);
    for (let a = 0; a < 3; a++) pos[a] = s.posA[a] + (s.posB[a] - s.posA[a]) * t;
  }

  /** samples spent on rotating sweeps since creation (diagnostic) */
  sweepSampleCount = 0;
  private poseStamp = 0;
  private tableStamp = -1;
  private readonly tables = new Map<number, { pos: Float64Array; rot: Float64Array }>();
  private tablePos: Float64Array = new Float64Array(0);
  private tableRot: Float64Array = new Float64Array(0);
  private readonly tmpN2 = new Float64Array(3);
  private readonly tmpP2 = new Float64Array(3);
  private readonly tmpR2 = new Float64Array(9);

  private readonly tmpQuat = new Float64Array(4);
  private readonly tmpR = new Float64Array(9);
  private readonly tmpT = new Float64Array(3);
  private readonly tmpLoc = new Float64Array(3);
  private readonly tmpStart = new Float64Array(3);
  private readonly tmpNrm = new Float64Array(3);
  private readonly tmpQ = new Float64Array(3);
  private readonly tmpPrev = new Float64Array(3);

  /** world AABB of a solid at the end (or start) of the substep, inflated by pad; null when unbounded */
  private solidAabb(s: Solid, pad: number, end = true): number[] | null {
    const B = end ? s.rotB : s.rotA, P = end ? s.posB : s.posA;
    let e: number[];
    switch (s.shape.type) {
      case "plane":
        return null;
      case "box": {
        const hs = s.shape.halfSize;
        e = [0, 1, 2].map((a) => Math.abs(B[3 * a]) * hs[0] + Math.abs(B[3 * a + 1]) * hs[1] + Math.abs(B[3 * a + 2]) * hs[2]);
        break;
      }
      case "sphere":
        e = [s.shape.radius, s.shape.radius, s.shape.radius];
        break;
      default: {
        const { radius, halfLength } = s.shape;
        e = [0, 1, 2].map((a) => Math.abs(B[3 * a + 2]) * halfLength + radius);
      }
    }
    const m = pad * 1.001;
    return [P[0] - e[0] - m, P[1] - e[1] - m, P[2] - e[2] - m, P[0] + e[0] + m, P[1] + e[1] + m, P[2] + e[2] + m];
  }

  // ---------------------------------------------------------------- wall density

  /**
   * Solids count in the density of the particles near them as if they were liquid at
   * rest: a ghost lattice behind each surface, Psi(z) tabulated in the constructor.
   * Without it a particle next to a wall misses half its neighbours, reads too light and
   * lets the layers along walls and floors pack far tighter than rho0. Where several
   * surfaces meet (a corner of a cup) their ghost lattices overlap; the overlap is
   * removed (inclusion-exclusion, ghostOverlap) so a corner reads rho0 too.
   */
  private collectWallPairs(pos: Float64Array) {
    const n = this.n, reach = this.h * 1.25;
    this.nWallPairs = 0;
    const boxes = this.solids.map((s) => (s.enabled ? this.solidAabb(s, reach, true) : undefined));
    const { pairStart, pairCount } = this;
    for (let i = 0; i < n; i++) {
      const o = 3 * i;
      pairStart[i] = this.nWallPairs;
      for (let sid = 0; sid < boxes.length; sid++) {
        const bb = boxes[sid];
        if (bb === undefined) continue; // disabled
        if (bb && (pos[o] < bb[0] || pos[o] > bb[3] || pos[o + 1] < bb[1] || pos[o + 1] > bb[4] || pos[o + 2] < bb[2] || pos[o + 2] > bb[5])) continue;
        if (this.nWallPairs + 1 > this.wallPairs.length) {
          const grown = new Int32Array(Math.max(1024, this.wallPairs.length * 2));
          grown.set(this.wallPairs);
          this.wallPairs = grown;
        }
        this.wallPairs[this.nWallPairs++] = sid;
      }
      pairCount[i] = this.nWallPairs - pairStart[i];
    }
  }

  /**
   * Drop neighbour pairs whose segment crosses a solid: liquid on the two sides of a
   * sealed wall thinner than the kernel must not feel each other. Only solids that thin
   * can have liquid on both sides within h, so only they are tested.
   */
  private filterThroughWalls(pos: Float64Array) {
    const r = this.collisionRadius, h = this.h;
    let any = false;
    for (const s of this.solids) {
      s.thin = s.enabled && s.shape.type !== "plane" && 2 * (minHalfThickness(s.shape) + r) < h;
      any = any || s.thin;
    }
    if (!any) return;
    const n = this.n, K = this.maxNbr;
    const { nbr, nbrCount, pairStart, pairCount, wallPairs } = this;
    const a = this.tmpLoc, b = this.tmpStart, nrm = this.tmpNrm;
    for (let i = 0; i < n; i++) {
      const i0 = pairStart[i], i1 = i0 + pairCount[i];
      let thinNear = false;
      for (let k = i0; k < i1; k++) if (this.solids[wallPairs[k]].thin) thinNear = true;
      if (!thinNear) continue;
      const base = i * K;
      let w = 0;
      for (let q = 0, c = nbrCount[i]; q < c; q++) {
        const j = nbr[base + q];
        let crosses = false;
        for (let k = i0; k < i1 && !crosses; k++) {
          const sid = wallPairs[k], s = this.solids[sid];
          if (!s.thin) continue;
          let shared = false;
          for (let m = pairStart[j], m1 = m + pairCount[j]; m < m1; m++) if (wallPairs[m] === sid) shared = true;
          if (!shared) continue; // j is not near this solid, so the segment cannot cross it
          toLocal(s, pos, i, a);
          toLocal(s, pos, j, b);
          crosses = segmentCrossesShape(s.shape, a, b, nrm);
        }
        if (!crosses) nbr[base + w++] = j;
      }
      nbrCount[i] = w;
    }
  }

  /**
   * The surfaces within h of particle i (solids and bound faces): distance, outward
   * normal and (with `tangents`) a tangent, nearest first. Returns how many.
   */
  private gatherPlanes(i: number, pos: Float64Array, tangents: boolean): number {
    const h = this.h, o = 3 * i;
    const loc = this.tmpLoc, nl = this.tmpNrm, tl = this.tmpT;
    let np = 0;
    for (let k = this.pairStart[i], k1 = k + this.pairCount[i]; k < k1; k++) {
      const s = this.solids[this.wallPairs[k]];
      toLocal(s, pos, i, loc);
      const dist = surfaceDistance(s.shape, loc, nl);
      if (dist >= h) continue;
      const B = s.rotB;
      if (tangents) tangentOf(nl, tl);
      np = this.pushPlane(
        np, dist > 0 ? dist : 0,
        B[0] * nl[0] + B[1] * nl[1] + B[2] * nl[2], B[3] * nl[0] + B[4] * nl[1] + B[5] * nl[2], B[6] * nl[0] + B[7] * nl[1] + B[8] * nl[2],
        tangents ? B[0] * tl[0] + B[1] * tl[1] + B[2] * tl[2] : 0, tangents ? B[3] * tl[0] + B[4] * tl[1] + B[5] * tl[2] : 0, tangents ? B[6] * tl[0] + B[7] * tl[1] + B[8] * tl[2] : 0,
      );
    }
    const bd = this.bounds;
    if (bd) {
      for (let a = 0; a < 3; a++) {
        const lo = pos[o + a] - bd.min[a], hi = bd.max[a] - pos[o + a];
        const t = (a + 1) % 3, tx = t === 0 ? 1 : 0, ty = t === 1 ? 1 : 0, tz = t === 2 ? 1 : 0;
        if (lo < h) np = this.pushPlane(np, lo > 0 ? lo : 0, a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0, tx, ty, tz);
        if (hi < h) np = this.pushPlane(np, hi > 0 ? hi : 0, a === 0 ? -1 : 0, a === 1 ? -1 : 0, a === 2 ? -1 : 0, tx, ty, tz);
      }
    }
    return np;
  }

  /** insert a surface by distance; past MAX_PLANES the farthest is dropped */
  private pushPlane(np: number, z: number, nx: number, ny: number, nz: number, tx: number, ty: number, tz: number): number {
    const Z = this.planeZ, N = this.planeN, T = this.planeT;
    let k: number;
    if (np < MAX_PLANES) k = np++;
    else {
      if (Z[MAX_PLANES - 1] <= z) return np;
      k = MAX_PLANES - 1;
    }
    while (k > 0 && Z[k - 1] > z) {
      Z[k] = Z[k - 1];
      N[3 * k] = N[3 * k - 3]; N[3 * k + 1] = N[3 * k - 2]; N[3 * k + 2] = N[3 * k - 1];
      T[3 * k] = T[3 * k - 3]; T[3 * k + 1] = T[3 * k - 2]; T[3 * k + 2] = T[3 * k - 1];
      k--;
    }
    Z[k] = z;
    N[3 * k] = nx; N[3 * k + 1] = ny; N[3 * k + 2] = nz;
    T[3 * k] = tx; T[3 * k + 1] = ty; T[3 * k + 2] = tz;
    return np;
  }

  /**
   * For a particle near two or more surfaces (gathered by gatherPlanes with tangents):
   * the density their ghost lattices count more than once, and its gradient. A ghost of
   * surface s that also lies behind other surfaces (occupancy occ_t, a smoothstep over
   * one spacing so it moves smoothly) keeps weight 1 / (1 + sum_t occ_t): a ghost shared
   * by k lattices counts k x 1/k = once, whatever order the surfaces come in.
   */
  private ghostOverlap(np: number, out: Float64Array) {
    const d = this.spacing, h = this.h, h2 = h * h, m = this.kernelMass, c6 = this.poly6C;
    const reach = Math.ceil(h / d);
    const Z = this.planeZ, N = this.planeN, T = this.planeT;
    let rho = 0, gx = 0, gy = 0, gz = 0;
    for (let sI = 0; sI < np; sI++) {
      const nx = N[3 * sI], ny = N[3 * sI + 1], nz = N[3 * sI + 2];
      const t1x = T[3 * sI], t1y = T[3 * sI + 1], t1z = T[3 * sI + 2];
      const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;
      for (let k = 0; ; k++) {
        const depth = Z[sI] + d / 2 + k * d;
        if (depth >= h) break;
        for (let a = -reach; a <= reach; a++)
          for (let b = -reach; b <= reach; b++) {
            const rho2 = (a * d) ** 2 + (b * d) ** 2 + depth * depth;
            if (rho2 >= h2) continue;
            // ghost position relative to the particle (it keeps its lateral place, its depth follows z_s)
            const qx = -nx * depth + a * d * t1x + b * d * t2x;
            const qy = -ny * depth + a * d * t1y + b * d * t2y;
            const qz = -nz * depth + a * d * t1z + b * d * t2z;
            let S = 0, dSx = 0, dSy = 0, dSz = 0;
            for (let t = 0; t < np; t++) {
              if (t === sI) continue;
              const ntx = N[3 * t], nty = N[3 * t + 1], ntz = N[3 * t + 2];
              const u = 0.5 - (Z[t] + ntx * qx + nty * qy + ntz * qz) / d;
              if (u <= 0) continue;
              if (u >= 1) {
                S += 1;
                continue;
              }
              // smoothstep occupancy: exact 0 / 1 at the band edges, no kink in the gradient
              S += u * u * (3 - 2 * u);
              // d occ_t / dx = occ'(u) du/dx, du/dx = -(n_t - (n_t . n_s) n_s) / d
              const ns = ntx * nx + nty * ny + ntz * nz;
              const k6 = (6 * u * (1 - u)) / d;
              dSx -= k6 * (ntx - ns * nx); dSy -= k6 * (nty - ns * ny); dSz -= k6 * (ntz - ns * nz);
            }
            if (S === 0 && dSx === 0 && dSy === 0 && dSz === 0) continue;
            const tt = h2 - rho2;
            const w = m * c6 * tt * tt * tt;
            const extra = S / (1 + S); // 1 - weight
            rho += w * extra;
            const dw = -6 * m * c6 * depth * tt * tt * extra; // d w / d z_s, times extra
            gx += dw * nx; gy += dw * ny; gz += dw * nz;
            const f = w / ((1 + S) * (1 + S)); // d extra / dS
            gx += f * dSx; gy += f * dSy; gz += f * dSz;
          }
      }
    }
    out[0] = rho; out[1] = gx; out[2] = gy; out[3] = gz;
  }

  /**
   * wallRho = ghost density of the nearby surfaces (overlap removed); wallGrad = its
   * gradient / rho0. Recomputed at the current positions every iteration, overlap
   * included, so the density and its gradient always describe the same configuration.
   */
  private computeWallDensity(pos: Float64Array) {
    const n = this.n;
    const { wallRho, wallGrad } = this;
    wallRho.fill(0, 0, n);
    wallGrad.fill(0, 0, 3 * n);
    if (!this.wallDensity) return;
    const inv0 = 1 / this.restDensity;
    const Z = this.planeZ, N = this.planeN, ov = this.tmpOverlap;
    for (let i = 0; i < n; i++) {
      // tangents are only needed where surfaces meet; a second pass fetches them then
      let np = this.gatherPlanes(i, pos, false);
      if (np === 0) continue;
      let rho = 0, gx = 0, gy = 0, gz = 0;
      if (np > 1) {
        np = this.gatherPlanes(i, pos, true);
        this.ghostOverlap(np, ov);
        rho -= ov[0]; gx -= ov[1]; gy -= ov[2]; gz -= ov[3];
      }
      for (let k = 0; k < np; k++) {
        const z = Z[k];
        rho += this.psiAt(z);
        const dpsi = this.dpsiAt(z);
        gx += dpsi * N[3 * k]; gy += dpsi * N[3 * k + 1]; gz += dpsi * N[3 * k + 2];
      }
      if (!(rho > 0)) continue; // clipped at zero: no density, so no gradient either
      wallRho[i] = rho;
      wallGrad[3 * i] = gx * inv0; wallGrad[3 * i + 1] = gy * inv0; wallGrad[3 * i + 2] = gz * inv0;
    }
  }

  private readonly tmpOverlap = new Float64Array(4);

  private psiAt(z: number): number {
    const t = (z / this.h) * PSI_SAMPLES;
    if (t >= PSI_SAMPLES) return 0;
    const k = Math.floor(t), f = t - k;
    return this.psi[k] * (1 - f) + this.psi[k + 1] * f;
  }

  private dpsiAt(z: number): number {
    const t = (z / this.h) * PSI_SAMPLES;
    if (t >= PSI_SAMPLES) return 0;
    const k = Math.floor(t), f = t - k;
    return this.dpsi[k] * (1 - f) + this.dpsi[k + 1] * f;
  }

  // ---------------------------------------------------------------- read-outs

  /** Number of particles inside an axis-aligned box. */
  countInBox(box: Aabb): number {
    let c = 0;
    const x = this.x;
    for (let i = 0; i < this.n; i++) {
      const o = 3 * i;
      if (x[o] >= box.min[0] && x[o] <= box.max[0] && x[o + 1] >= box.min[1] && x[o + 1] <= box.max[1] && x[o + 2] >= box.min[2] && x[o + 2] <= box.max[2]) c++;
    }
    return c;
  }

  /** Kinetic energy of the liquid, J (each particle weighs rho0 * spacing^3). */
  kineticEnergy(): number {
    let s = 0;
    const v = this.v;
    for (let i = 0; i < 3 * this.n; i++) s += v[i] * v[i];
    return 0.5 * this.particleMass * s;
  }

  /** Mean compression max(0, rho / rho0 - 1) at the current positions. */
  meanDensityError(): number {
    return this.densityStats().meanCompression;
  }

  /** Density of every particle (kg/m^3) at the current positions, walls included (rebuilds the neighbour lists). */
  densities(): Float64Array {
    this.densitiesAtRest();
    return this.rho.slice(0, this.n);
  }

  private densitiesAtRest() {
    const x = this.x;
    this.holdSolids(true);
    this.buildGrid(x);
    this.findNeighbors();
    this.collectWallPairs(x);
    this.filterThroughWalls(x);
    this.computeWallDensity(x);
    this.computeDensity(x);
  }

  /** Density errors at the current positions (rebuilds the neighbour lists). */
  densityStats(): DensityStats {
    const n = this.n;
    if (n === 0) return { meanCompression: 0, maxCompression: 0, meanAbsInterior: 0, interiorCount: 0, meanSigned: 0 };
    const x = this.x;
    this.densitiesAtRest();
    const K = this.maxNbr, h = this.h, h2 = h * h, m = this.kernelMass, spikyC = this.spikyC, rho0 = this.restDensity;
    let comp = 0, maxComp = 0, absInt = 0, nInt = 0, signed = 0;
    for (let i = 0; i < n; i++) {
      const e = this.rho[i] / rho0 - 1;
      signed += e;
      if (e > 0) comp += e;
      if (e > maxComp) maxComp = e;
      // colour-field gradient: about 0 inside the liquid, about 1 / h at a surface or wall
      let gx = 0, gy = 0, gz = 0;
      const base = i * K;
      for (let q = 0, c = this.nbrCount[i]; q < c; q++) {
        const j = this.nbr[base + q];
        const dx = x[3 * i] - x[3 * j], dy = x[3 * i + 1] - x[3 * j + 1], dz = x[3 * i + 2] - x[3 * j + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= h2) continue;
        const r = Math.sqrt(r2);
        if (r < 1e-12) continue;
        const g = ((m / this.rho[j]) * spikyC * (h - r) * (h - r)) / r;
        gx += g * dx; gy += g * dy; gz += g * dz;
      }
      if (Math.hypot(gx, gy, gz) * h < 0.15 && !this.nearSolid(i)) {
        absInt += Math.abs(e);
        nInt++;
      }
    }
    return { meanCompression: comp / n, maxCompression: maxComp, meanAbsInterior: nInt ? absInt / nInt : 0, interiorCount: nInt, meanSigned: signed / n };
  }

  /** whether particle i lies within a kernel radius of an enabled solid or the bounds */
  private nearSolid(i: number): boolean {
    const o = 3 * i;
    const reach = this.h;
    const b = this.bounds;
    if (b) for (let a = 0; a < 3; a++) if (this.x[o + a] - b.min[a] < reach || b.max[a] - this.x[o + a] < reach) return true;
    const loc = new Float64Array(3), nrm = new Float64Array(3);
    for (const s of this.solids) {
      if (!s.enabled) continue;
      const R = s.rot;
      const dx = this.x[o] - s.pos[0], dy = this.x[o + 1] - s.pos[1], dz = this.x[o + 2] - s.pos[2];
      loc[0] = R[0] * dx + R[3] * dy + R[6] * dz;
      loc[1] = R[1] * dx + R[4] * dy + R[7] * dz;
      loc[2] = R[2] * dx + R[5] * dy + R[8] * dz;
      if (projectOut(s.shape, reach, loc, loc.slice(), nrm)) return true;
    }
    return false;
  }
}

/** A solid's pose at fraction t of the step (position lerp, rotation nlerp), into pos / rot / quat. */
function poseAt(s: Solid, t: number, pos: Float64Array, rot: Float64Array, quat: Float64Array) {
  for (let i = 0; i < 3; i++) pos[i] = s.pos0[i] + (s.pos[i] - s.pos0[i]) * t;
  if (t <= 0) {
    rot.set(s.rot0);
    quat.set(s.q0);
  } else if (t >= 1) {
    rot.set(s.rot);
    quat.set(s.q1);
  } else {
    for (let i = 0; i < 4; i++) quat[i] = s.q0[i] + (s.q1[i] - s.q0[i]) * t;
    const l = Math.hypot(quat[0], quat[1], quat[2], quat[3]) || 1;
    for (let i = 0; i < 4; i++) quat[i] /= l;
    quatToMat(quat, rot);
  }
}

/** Particle i in solid s's end-of-substep frame. */
function toLocal(s: Solid, pos: Float64Array, i: number, out: Float64Array) {
  const B = s.rotB, o = 3 * i;
  const dx = pos[o] - s.posB[0], dy = pos[o + 1] - s.posB[1], dz = pos[o + 2] - s.posB[2];
  out[0] = B[0] * dx + B[3] * dy + B[6] * dz;
  out[1] = B[1] * dx + B[4] * dy + B[7] * dz;
  out[2] = B[2] * dx + B[5] * dy + B[8] * dz;
}

/** Reject parameters the solver cannot run with, by name. */
function validateParams(p: FluidParams) {
  const check = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`fluid: ${what}`);
  };
  const finite = (v: number | undefined) => v === undefined || Number.isFinite(v);
  check(Number.isFinite(p.spacing) && p.spacing > 0, "spacing must be a positive number of metres");
  check(p.kernelRatio === undefined || (p.kernelRatio >= 1.5 && p.kernelRatio <= 4), "kernelRatio must be between 1.5 and 4 (2 recommended)");
  check(p.restDensity === undefined || (Number.isFinite(p.restDensity) && p.restDensity > 0), "restDensity must be positive");
  check(p.substeps === undefined || (Number.isInteger(p.substeps) && p.substeps >= 1), "substeps must be an integer >= 1");
  check(p.iterations === undefined || (Number.isInteger(p.iterations) && p.iterations >= 0), "iterations must be an integer >= 0");
  check(p.relaxation === undefined || (finite(p.relaxation) && p.relaxation >= 0), "relaxation must be >= 0");
  check(p.cohesion === undefined || (p.cohesion >= 0 && p.cohesion <= 1), "cohesion must be between 0 and 1");
  check(p.xsph === undefined || (p.xsph >= 0 && p.xsph <= 1), "xsph must be between 0 and 1");
  check(p.vorticity === undefined || (finite(p.vorticity) && p.vorticity >= 0), "vorticity must be >= 0");
  check(p.scorrK === undefined || (finite(p.scorrK) && p.scorrK >= 0), "scorrK must be >= 0");
  check(p.scorrN === undefined || (p.scorrN >= 1 && p.scorrN <= 8), "scorrN must be between 1 and 8 (the paper uses 4)");
  check(p.scorrDq === undefined || (p.scorrDq >= 0.05 && p.scorrDq <= 0.5), "scorrDq must be between 0.05 and 0.5 (the paper uses 0.1 to 0.3)");
  check(p.collisionRadius === undefined || (finite(p.collisionRadius) && p.collisionRadius >= 0), "collisionRadius must be >= 0");
  check(p.friction === undefined || (finite(p.friction) && p.friction >= 0), "friction must be >= 0");
  check(p.restitution === undefined || (p.restitution >= 0 && p.restitution <= 1), "restitution must be between 0 and 1");
  check(p.maxNeighbors === undefined || (Number.isInteger(p.maxNeighbors) && p.maxNeighbors >= 8), "maxNeighbors must be an integer >= 8");
  check(p.maxCorrection === undefined || (finite(p.maxCorrection) && p.maxCorrection > 0), "maxCorrection must be positive");
  check(p.maxSpeed === undefined || p.maxSpeed > 0, "maxSpeed must be positive");
  check(!p.gravity || (p.gravity.length >= 3 && [0, 1, 2].every((a) => Number.isFinite(p.gravity![a]))), "gravity must be three finite numbers");
  check(!p.bounds || [0, 1, 2].every((a) => Number.isFinite(p.bounds!.min[a]) && Number.isFinite(p.bounds!.max[a]) && p.bounds!.min[a] < p.bounds!.max[a]), "bounds must have min < max on every axis");
}

/** radius of a sphere about the shape's centre that holds it */
function boundingRadius(shape: SolidShape): number {
  switch (shape.type) {
    case "plane":
      return Infinity;
    case "box":
      return Math.hypot(shape.halfSize[0], shape.halfSize[1], shape.halfSize[2]);
    case "sphere":
      return shape.radius;
    case "capsule":
      return shape.halfLength + shape.radius;
    case "cylinder":
      return Math.hypot(shape.radius, shape.halfLength);
  }
}

/** A unit tangent to the local normal n, along the local axis least aligned with it (box faces get box axes). */
function tangentOf(n: Float64Array, out: Float64Array) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const k = ax <= ay && ax <= az ? 0 : ay <= az ? 1 : 2;
  out[0] = (k === 0 ? 1 : 0) - n[k] * n[0];
  out[1] = (k === 1 ? 1 : 0) - n[k] * n[1];
  out[2] = (k === 2 ? 1 : 0) - n[k] * n[2];
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l; out[1] /= l; out[2] /= l;
}

/**
 * First parameter t in [0, 1] where the local segment a -> b enters the shape inflated
 * by r, with the outward normal there; -1 when it does not enter (or a is inside).
 * Exact for every shape: slabs for a box, quadratics for the round ones.
 */
function segmentEntry(shape: SolidShape, r: number, a: ArrayLike<number>, b: ArrayLike<number>, nrm: Float64Array): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-15) return -1;
  const tol = SURFACE_EPS / len;
  switch (shape.type) {
    case "plane":
      return -1;
    case "box": {
      let tmin = -Infinity, tmax = Infinity, axis = -1, sign = 0;
      for (let k = 0; k < 3; k++) {
        const e = shape.halfSize[k] + r, o = a[k], v = k === 0 ? dx : k === 1 ? dy : dz;
        if (Math.abs(v) < 1e-18) {
          if (o < -e || o > e) return -1;
          continue;
        }
        const tn = v > 0 ? (-e - o) / v : (e - o) / v;
        const tf = v > 0 ? (e - o) / v : (-e - o) / v;
        if (tn > tmin) { tmin = tn; axis = k; sign = v > 0 ? -1 : 1; }
        if (tf < tmax) tmax = tf;
      }
      if (axis < 0 || tmin > tmax || tmin > 1 || tmax < 0 || tmin < -tol) return -1;
      nrm[0] = nrm[1] = nrm[2] = 0;
      nrm[axis] = sign;
      return Math.max(0, tmin);
    }
    case "sphere":
    case "capsule": {
      const R = shape.radius + r, hl = shape.type === "capsule" ? shape.halfLength : 0;
      const ca = Math.max(-hl, Math.min(hl, a[2]));
      if (Math.hypot(a[0], a[1], a[2] - ca) < R - SURFACE_EPS) return -1;
      let best = Infinity;
      // the side of the inner cylinder, between the two end spheres
      const A2 = dx * dx + dy * dy;
      if (hl > 0 && A2 > 1e-30) {
        const B2 = 2 * (a[0] * dx + a[1] * dy), C2 = a[0] * a[0] + a[1] * a[1] - R * R;
        const disc = B2 * B2 - 4 * A2 * C2;
        if (disc >= 0) {
          const t = (-B2 - Math.sqrt(disc)) / (2 * A2);
          const z = a[2] + t * dz;
          if (t >= -tol && t <= 1 && z >= -hl && z <= hl) best = Math.min(best, t);
        }
      }
      for (const cz of hl > 0 ? [-hl, hl] : [0]) {
        const ox = a[0], oy = a[1], oz = a[2] - cz;
        const A3 = len * len, B3 = 2 * (ox * dx + oy * dy + oz * dz), C3 = ox * ox + oy * oy + oz * oz - R * R;
        const disc = B3 * B3 - 4 * A3 * C3;
        if (disc < 0) continue;
        const t = (-B3 - Math.sqrt(disc)) / (2 * A3);
        if (t >= -tol && t <= 1) best = Math.min(best, t);
      }
      if (best === Infinity) return -1;
      const t = Math.max(0, best);
      const px = a[0] + t * dx, py = a[1] + t * dy, pz = a[2] + t * dz;
      const cz = Math.max(-hl, Math.min(hl, pz));
      const l = Math.hypot(px, py, pz - cz) || 1;
      nrm[0] = px / l; nrm[1] = py / l; nrm[2] = (pz - cz) / l;
      return t;
    }
    case "cylinder": {
      const R = shape.radius + r, H = shape.halfLength + r;
      if (Math.hypot(a[0], a[1]) < R - SURFACE_EPS && Math.abs(a[2]) < H - SURFACE_EPS) return -1;
      let best = Infinity, cap = 0;
      const A2 = dx * dx + dy * dy;
      if (A2 > 1e-30) {
        const B2 = 2 * (a[0] * dx + a[1] * dy), C2 = a[0] * a[0] + a[1] * a[1] - R * R;
        const disc = B2 * B2 - 4 * A2 * C2;
        if (disc >= 0) {
          const t = (-B2 - Math.sqrt(disc)) / (2 * A2);
          const z = a[2] + t * dz;
          if (t >= -tol && t <= 1 && Math.abs(z) <= H) best = t;
        }
      }
      if (Math.abs(dz) > 1e-18)
        for (const sg of [-1, 1]) {
          const t = (sg * H - a[2]) / dz;
          if (t < -tol || t > 1 || t >= best) continue;
          const px = a[0] + t * dx, py = a[1] + t * dy;
          if (px * px + py * py <= R * R) {
            best = t;
            cap = sg;
          }
        }
      if (best === Infinity) return -1;
      const t = Math.max(0, best);
      if (cap !== 0) {
        nrm[0] = 0; nrm[1] = 0; nrm[2] = cap;
      } else {
        const px = a[0] + t * dx, py = a[1] + t * dy, l = Math.hypot(px, py) || 1;
        nrm[0] = px / l; nrm[1] = py / l; nrm[2] = 0;
      }
      return t;
    }
  }
}

/** Minimum of a convex function on [a, b] by golden-section search. */
function goldenMin(f: (t: number) => number, a: number, b: number, iterations: number): number {
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
  for (let k = 0; k < iterations; k++) {
    if (fc <= fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  return (a + b) / 2;
}

/**
 * The local relative path a -> b of a particle that ends outside a translating solid:
 * if it met the solid on the way, press b onto the tangent plane where it met it (which
 * keeps its motion along the surface, around an edge too). Exact: the inflated box and
 * cylinder have sharp corners, so a hit on them is confirmed against the true rounded
 * shape (the solid's distance along the path reaching r), and a path that only cuts a
 * sharp corner is left alone.
 */
function sweepStraight(shape: SolidShape, r: number, a: Float64Array, b: Float64Array, nrm: Float64Array, tmp: Float64Array, tmpN: Float64Array): boolean {
  let t0 = segmentEntry(shape, r, a, b, nrm);
  const rounded = shape.type === "box" || shape.type === "cylinder";
  if (t0 < 0 && !rounded) return false;
  let te = t0;
  if (rounded) {
    const dist = (t: number) => {
      for (let k = 0; k < 3; k++) tmp[k] = a[k] + (b[k] - a[k]) * t;
      return surfaceDistance(shape, tmp, tmpN);
    };
    if (t0 < 0) {
      // the sharp test reports no entry: either the path misses the sharp shape (and so the
      // rounded one inside it), or it starts in a sharp corner region, outside the rounded shape
      if (!insideInflated(shape, r, a) || dist(0) <= r - SURFACE_EPS) return false;
      t0 = te = 0;
    }
    const tStar = goldenMin(dist, t0, 1, 40);
    if (dist(tStar) >= r - SURFACE_EPS) return false; // only cut a sharp corner of the inflated shape
    if (dist(t0) > r + SURFACE_EPS) {
      // entered through a corner region: find where the distance first reaches r
      let lo = t0, hi = tStar;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (dist(mid) > r) lo = mid;
        else hi = mid;
      }
      te = hi;
    }
    dist(te);
    nrm.set(tmpN); // outward normal of the solid at the contact
  }
  // the contact point, and b pressed onto the tangent plane there
  const ex = a[0] + (b[0] - a[0]) * te, ey = a[1] + (b[1] - a[1]) * te, ez = a[2] + (b[2] - a[2]) * te;
  const sd = (b[0] - ex) * nrm[0] + (b[1] - ey) * nrm[1] + (b[2] - ez) * nrm[2];
  if (sd < 0) {
    b[0] -= sd * nrm[0]; b[1] -= sd * nrm[1]; b[2] -= sd * nrm[2];
  }
  return true;
}

/** Whether a local point lies inside the shape inflated by r with sharp corners (the conservative inflation). */
function insideInflated(shape: SolidShape, r: number, a: ArrayLike<number>): boolean {
  switch (shape.type) {
    case "plane":
      return a[2] < r;
    case "box":
      return Math.abs(a[0]) < shape.halfSize[0] + r && Math.abs(a[1]) < shape.halfSize[1] + r && Math.abs(a[2]) < shape.halfSize[2] + r;
    case "sphere":
      return Math.hypot(a[0], a[1], a[2]) < shape.radius + r;
    case "capsule": {
      const cz = Math.max(-shape.halfLength, Math.min(shape.halfLength, a[2]));
      return Math.hypot(a[0], a[1], a[2] - cz) < shape.radius + r;
    }
    case "cylinder":
      return Math.hypot(a[0], a[1]) < shape.radius + r && Math.abs(a[2]) < shape.halfLength + r;
  }
}

/** Whether the local segment a -> b touches the (not inflated) shape. */
function segmentCrossesShape(shape: SolidShape, a: Float64Array, b: Float64Array, nrm: Float64Array): boolean {
  if (shape.type === "plane") return false;
  if (surfaceDistance(shape, a, nrm) < 0 || surfaceDistance(shape, b, nrm) < 0) return true;
  return segmentEntry(shape, 0, a, b, nrm) >= 0;
}

/** half of the thinnest dimension of a shape (how far a particle may move before it could skip over it) */
function minHalfThickness(shape: SolidShape): number {
  switch (shape.type) {
    case "plane":
      return Infinity;
    case "box":
      return Math.min(shape.halfSize[0], shape.halfSize[1], shape.halfSize[2]);
    case "sphere":
      return shape.radius;
    case "capsule":
      return shape.radius;
    case "cylinder":
      return Math.min(shape.radius, shape.halfLength);
  }
}

/** Signed distance from a local point to a shape's surface (negative inside) and the outward normal. */
function surfaceDistance(shape: SolidShape, loc: Float64Array, nrm: Float64Array): number {
  switch (shape.type) {
    case "plane":
      nrm[0] = 0; nrm[1] = 0; nrm[2] = 1;
      return loc[2];
    case "box": {
      const qx = Math.abs(loc[0]) - shape.halfSize[0], qy = Math.abs(loc[1]) - shape.halfSize[1], qz = Math.abs(loc[2]) - shape.halfSize[2];
      if (qx > 0 || qy > 0 || qz > 0) {
        const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0, mz = qz > 0 ? qz : 0;
        const len = Math.sqrt(mx * mx + my * my + mz * mz);
        nrm[0] = (loc[0] >= 0 ? mx : -mx) / len; nrm[1] = (loc[1] >= 0 ? my : -my) / len; nrm[2] = (loc[2] >= 0 ? mz : -mz) / len;
        return len;
      }
      const axis = qx >= qy && qx >= qz ? 0 : qy >= qz ? 1 : 2;
      nrm[0] = nrm[1] = nrm[2] = 0;
      nrm[axis] = loc[axis] >= 0 ? 1 : -1;
      return axis === 0 ? qx : axis === 1 ? qy : qz;
    }
    case "sphere":
    case "capsule": {
      const hl = shape.type === "capsule" ? shape.halfLength : 0;
      const cz = Math.max(-hl, Math.min(hl, loc[2]));
      const vx = loc[0], vy = loc[1], vz = loc[2] - cz;
      const d = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (d < 1e-12) { nrm[0] = 1; nrm[1] = 0; nrm[2] = 0; }
      else { nrm[0] = vx / d; nrm[1] = vy / d; nrm[2] = vz / d; }
      return d - shape.radius;
    }
    case "cylinder": {
      const rho = Math.hypot(loc[0], loc[1]);
      const ux = rho > 1e-12 ? loc[0] / rho : 1, uy = rho > 1e-12 ? loc[1] / rho : 0, sz = loc[2] >= 0 ? 1 : -1;
      const dr = rho - shape.radius, dz = Math.abs(loc[2]) - shape.halfLength;
      if (dr > 0 || dz > 0) {
        const mr = dr > 0 ? dr : 0, mz = dz > 0 ? dz : 0;
        const len = Math.sqrt(mr * mr + mz * mz);
        nrm[0] = (mr * ux) / len; nrm[1] = (mr * uy) / len; nrm[2] = (mz * sz) / len;
        return len;
      }
      if (dr > dz) { nrm[0] = ux; nrm[1] = uy; nrm[2] = 0; return dr; }
      nrm[0] = 0; nrm[1] = 0; nrm[2] = sz;
      return dz;
    }
  }
}

/**
 * Move a local point out of a shape inflated by r. `start` is where the particle was at
 * the start of the substep, in the solid's frame then: if it was outside, the particle
 * leaves through the face it came in by, so it cannot tunnel through a thin wall.
 * Returns false when the point is not inside; otherwise updates `loc` and the outward
 * local normal `nrm`.
 */
function projectOut(shape: SolidShape, r: number, loc: Float64Array, start: Float64Array, nrm: Float64Array): boolean {
  switch (shape.type) {
    case "plane": {
      if (loc[2] >= r) return false;
      loc[2] = r;
      nrm[0] = 0; nrm[1] = 0; nrm[2] = 1;
      return true;
    }
    case "box": {
      const ex = shape.halfSize[0] + r, ey = shape.halfSize[1] + r, ez = shape.halfSize[2] + r;
      const ax = Math.abs(loc[0]), ay = Math.abs(loc[1]), az = Math.abs(loc[2]);
      if (ax >= ex || ay >= ey || az >= ez) return false;
      // a particle left exactly on the surface by the last projection counts as outside
      const ox = Math.abs(start[0]) - ex, oy = Math.abs(start[1]) - ey, oz = Math.abs(start[2]) - ez;
      let axis: number, sign: number;
      if (ox > -SURFACE_EPS || oy > -SURFACE_EPS || oz > -SURFACE_EPS) {
        axis = ox >= oy && ox >= oz ? 0 : oy >= oz ? 1 : 2;
        sign = start[axis] >= 0 ? 1 : -1;
      } else {
        const px = ex - ax, py = ey - ay, pz = ez - az;
        axis = px <= py && px <= pz ? 0 : py <= pz ? 1 : 2;
        sign = loc[axis] >= 0 ? 1 : -1;
      }
      const e = axis === 0 ? ex : axis === 1 ? ey : ez;
      loc[axis] = sign * e;
      nrm[0] = nrm[1] = nrm[2] = 0;
      nrm[axis] = sign;
      return true;
    }
    case "sphere":
    case "capsule": {
      const R = shape.radius + r;
      const hl = shape.type === "capsule" ? shape.halfLength : 0;
      const cz = Math.max(-hl, Math.min(hl, loc[2]));
      let vx = loc[0], vy = loc[1], vz = loc[2] - cz;
      let d = Math.hypot(vx, vy, vz);
      if (d >= R) return false;
      if (d < 1e-12) {
        vx = start[0]; vy = start[1]; vz = start[2] - Math.max(-hl, Math.min(hl, start[2]));
        d = Math.hypot(vx, vy, vz);
        if (d < 1e-12) { vx = 1; vy = 0; vz = 0; d = 1; }
      }
      nrm[0] = vx / d; nrm[1] = vy / d; nrm[2] = vz / d;
      loc[0] = nrm[0] * R; loc[1] = nrm[1] * R; loc[2] = cz + nrm[2] * R;
      return true;
    }
    case "cylinder": {
      const R = shape.radius + r, H = shape.halfLength + r;
      const rho = Math.hypot(loc[0], loc[1]);
      if (rho >= R || Math.abs(loc[2]) >= H) return false;
      const os = Math.hypot(start[0], start[1]) - R, oc = Math.abs(start[2]) - H;
      let side: boolean;
      if (os > -SURFACE_EPS || oc > -SURFACE_EPS) side = os >= oc;
      else side = R - rho <= H - Math.abs(loc[2]);
      if (side) {
        let ux = loc[0], uy = loc[1], ul = rho;
        if (ul < 1e-12) {
          ux = start[0]; uy = start[1]; ul = Math.hypot(ux, uy);
          if (ul < 1e-12) { ux = 1; uy = 0; ul = 1; }
        }
        nrm[0] = ux / ul; nrm[1] = uy / ul; nrm[2] = 0;
        loc[0] = nrm[0] * R; loc[1] = nrm[1] * R;
      } else {
        const sign = (Math.abs(start[2]) > H - SURFACE_EPS ? start[2] : loc[2]) >= 0 ? 1 : -1;
        loc[2] = sign * H;
        nrm[0] = 0; nrm[1] = 0; nrm[2] = sign;
      }
      return true;
    }
  }
}

/** Create a solver; see FluidParams for the defaults. */
export function create(params: FluidParams): Fluid {
  return new Fluid(params);
}
