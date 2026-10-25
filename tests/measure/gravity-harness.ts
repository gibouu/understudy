/**
 * Harness for the gravity measurements (tests/measure/gravity.test.ts): MJCF
 * builders for a tube, the demo rack and a cup of particles, a thin wrapper
 * over MuJoCo's model and data, pose helpers, a markdown table and the JSON
 * writer for bench/results.
 *
 * Conventions: metres, seconds, radians inside; the tables print mm, mm/s and
 * degrees. Gravity is a vector in m/s². "In motion" is modelled as an
 * accelerating frame: a frame that accelerates at +a along x sees an apparent
 * gravity component of -a along x, so a lateral acceleration enters as a
 * horizontal gravity component. Nothing here uses the SO-101: objects are
 * placed and let go, which is what a release does.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import { DEMO_SPEC } from "@/lib/sim/demo-spec";
import { buildScene, DEFAULT_CLEARANCE_MM, MM } from "@/lib/sim/scene";
import { G_M_S2 } from "@/lib/sim/so101";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export const TIMESTEP_S = 0.002;
export const DEG = 180 / Math.PI;

export type GravityPreset = { id: "earth" | "mars" | "moon" | "orbit"; label: string; g: number };
export const GRAVITIES: GravityPreset[] = [
  { id: "earth", label: "Earth 1 g", g: 1 },
  { id: "mars", label: "Mars 0.379 g", g: 0.379 },
  { id: "moon", label: "Moon 0.1654 g", g: 0.1654 },
  { id: "orbit", label: "orbit 0 g", g: 0 },
];

/** Gravity vector in m/s²: `down_g` along -z plus the apparent pull of a frame accelerating at `lateral_g` along +x. */
export const gravityVec = (down_g: number, lateral_g = 0): Vec3 => [-lateral_g * G_M_S2, 0, -down_g * G_M_S2];

// --- MuJoCo -------------------------------------------------------------------
let loaded: Promise<MainModule> | undefined;
export function loadMujoco(): Promise<MainModule> {
  loaded ??= import("@mujoco/mujoco").then((m) => m.default());
  return loaded;
}

const f = (n: number) => Number(n.toFixed(7)).toString();
const v = (xs: number[]) => xs.map(f).join(" ");

/**
 * Contact settings. MuJoCo's default contact is soft (solref time constant
 * 20 ms); "stiff" is the stiffest it allows at this timestep (2 x 2 ms), the
 * closer stand-in for a rigid rim.
 */
export const CONTACTS = { default: "", stiff: '<default><geom solref="0.004 1"/></default>' } as const;
export type ContactModel = keyof typeof CONTACTS;

/** A world with a floor plane at z = 0 under the given gravity vector. */
export function worldXml(worldbody: string, gravity: Vec3, options: { timestep?: number; option?: string; contacts?: ContactModel } = {}): string {
  return `<mujoco model="understudy-gravity-measure">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="${options.timestep ?? TIMESTEP_S}" gravity="${v(gravity)}" ${options.option ?? ""}/>
  ${CONTACTS[options.contacts ?? "default"]}
  <worldbody>
    <geom name="floor" size="0 0 0.05" type="plane"/>
${worldbody}
  </worldbody>
</mujoco>`;
}

const FREE_JOINT = 0;

export class Sim {
  readonly model: MjModel;
  readonly data: MjData;
  constructor(
    readonly mj: MainModule,
    xml: string,
  ) {
    this.model = mj.MjModel.from_xml_string(xml);
    this.data = new mj.MjData(this.model);
    mj.mj_forward(this.model, this.data);
  }
  get t(): number {
    return this.data.time;
  }
  get dt(): number {
    return this.model.opt.timestep;
  }
  step(n = 1): void {
    for (let i = 0; i < n; i++) this.mj.mj_step(this.model, this.data);
  }
  id(kind: "body" | "site", name: string): number {
    const type = kind === "body" ? this.mj.mjtObj.mjOBJ_BODY.value : this.mj.mjtObj.mjOBJ_SITE.value;
    const id = this.mj.mj_name2id(this.model, type, name);
    if (id < 0) throw new Error(`no ${kind} named ${name}`);
    return id;
  }
  /** qpos and dof addresses of a named joint */
  joint(name: string): { q: number; d: number } {
    const j = this.mj.mj_name2id(this.model, this.mj.mjtObj.mjOBJ_JOINT.value, name);
    if (j < 0) throw new Error(`no joint named ${name}`);
    return { q: (this.model.jnt_qposadr as Int32Array)[j], d: (this.model.jnt_dofadr as Int32Array)[j] };
  }
  /** qpos and dof addresses of a free body's joint */
  free(name: string): { q: number; d: number } {
    const b = this.id("body", name);
    const j = (this.model.body_jntadr as Int32Array)[b];
    if (j < 0 || (this.model.jnt_type as Int32Array)[j] !== FREE_JOINT) throw new Error(`${name} is not a free body`);
    return { q: (this.model.jnt_qposadr as Int32Array)[j], d: (this.model.jnt_dofadr as Int32Array)[j] };
  }
  sitePos(name: string): Vec3 {
    const i = this.id("site", name);
    const p = this.data.site_xpos as Float64Array;
    return [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
  }
  setGravity(g: Vec3): void {
    const grav = this.model.opt.gravity as Float64Array;
    grav[0] = g[0];
    grav[1] = g[1];
    grav[2] = g[2];
  }
  dispose(): void {
    this.data.delete();
    this.model.delete();
  }
}

/** Run `fn` with a fresh simulation and always free it. */
export function withSim<T>(mj: MainModule, xml: string, fn: (sim: Sim) => T): T {
  const sim = new Sim(mj, xml);
  try {
    return fn(sim);
  } finally {
    sim.dispose();
  }
}

/** Pose and velocity of a free body, read from qpos / qvel (angular velocity in the body frame; only its norm is used). */
export type FreeState = { pos: Vec3; quat: Quat; vel: Vec3; angVel: Vec3 };
export function freeState(sim: Sim, adr: { q: number; d: number }): FreeState {
  const q = sim.data.qpos as Float64Array;
  const dq = sim.data.qvel as Float64Array;
  return {
    pos: [q[adr.q], q[adr.q + 1], q[adr.q + 2]],
    quat: [q[adr.q + 3], q[adr.q + 4], q[adr.q + 5], q[adr.q + 6]],
    vel: [dq[adr.d], dq[adr.d + 1], dq[adr.d + 2]],
    angVel: [dq[adr.d + 3], dq[adr.d + 4], dq[adr.d + 5]],
  };
}
export function setFreeVel(sim: Sim, adr: { d: number }, vel: Vec3): void {
  const dq = sim.data.qvel as Float64Array;
  dq[adr.d] = vel[0];
  dq[adr.d + 1] = vel[1];
  dq[adr.d + 2] = vel[2];
}

export const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** the body's z axis in world coordinates */
export function bodyZ(q: Quat): Vec3 {
  const [w, x, y, z] = q;
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
}
/** angle between a cylinder's axis and the vertical, degrees (either end up counts as upright) */
export const tiltDeg = (q: Quat) => Math.acos(Math.min(1, Math.abs(bodyZ(q)[2]))) * DEG;
/** z of the lowest point of a cylinder (radius r, half length h) */
export function cylinderLowestZ(s: FreeState, r: number, h: number): number {
  const az = Math.min(1, Math.abs(bodyZ(s.quat)[2]));
  return s.pos[2] - az * h - r * Math.sqrt(1 - az * az);
}
/** an upper bound on the speed of any point of a body within `reach` metres of its centre */
export const pointSpeed = (s: FreeState, reach: number) => norm(s.vel) + norm(s.angVel) * reach;

// --- the tube -------------------------------------------------------------------
/** The demo tube: 17 x 100 mm, like the /stage tube (cylinder, friction 1, density 1000). */
export const TUBE = { radius_m: 0.0085, half_m: 0.05, friction: "1 0.005 0.0001" };
export function tubeBody(name: string, pos: Vec3): string {
  return `<body name="${name}" pos="${v(pos)}">
      <freejoint name="${name}_free"/>
      <geom name="${name}_geom" type="cylinder" size="${f(TUBE.radius_m)} ${f(TUBE.half_m)}" rgba="0.93 0.52 0.2 1" friction="${TUBE.friction}"/>
    </body>`;
}

// --- the rack pocket from the demo spec ----------------------------------------
/**
 * The demo scene (tube and rack, buildScene) with the tube moved: upright,
 * its bottom `above_floor_mm` above the pocket floor and `dx_mm` from the
 * pocket centre along x. The rack keeps the demo spec's pose (60 x 60 x 40 mm,
 * an 8 mm floor, so a 32 mm deep pocket); clearance defaults to 3 mm, which
 * makes the opening 20 x 20 mm for the 17 mm tube.
 */
export function rackScene(above_floor_mm: number, dx_mm = 0, clearance_mm = DEFAULT_CLEARANCE_MM) {
  const spec = structuredClone(DEMO_SPEC);
  const tube = spec.objects.find((o) => o.id === "tube")!;
  const rack = spec.objects.find((o) => o.id === "rack")!;
  rack.pocket_clearance_mm = clearance_mm;
  // the pocket's depth does not depend on where the tube is: read it from a first build
  const depth_mm = buildScene(spec).pockets.rack.depth_m / MM;
  const [x, y, z] = rack.pose!.xyz_mm;
  const top_mm = z + rack.size_mm[2] / 2;
  const floor_mm = top_mm - depth_mm;
  tube.pose = { xyz_mm: [x + dx_mm, y, floor_mm + above_floor_mm + tube.size_mm[2] / 2], yaw_deg: 0, frame: "world" };
  const build = buildScene(spec);
  return {
    worldbody: build.worldbody,
    tube: build.names.tube,
    pocketFloorSite: `${build.names.rack}_pocket_floor`,
    inner_mm: build.pockets.rack.inner_m.map((m) => m / MM) as [number, number],
    depth_mm,
    floor_mm,
    top_mm,
    pocket_xy_m: [x * MM, y * MM] as [number, number],
  };
}

/** Seated: lowest point within 2 mm of the pocket floor, axis within 5 degrees of vertical, inside the pocket in plan. */
export const SEATED = { floor_mm: 2, tilt_deg: 5 };
export type PocketState = { lowest_above_floor_mm: number; tilt_deg: number; dx_mm: number; seated: boolean; in_pocket: boolean };
export function pocketState(s: FreeState, floorZ: number, pocketXY: [number, number], inner_mm: [number, number]): PocketState {
  const lowest = (cylinderLowestZ(s, TUBE.radius_m, TUBE.half_m) - floorZ) / MM;
  const tilt = tiltDeg(s.quat);
  const dx = (s.pos[0] - pocketXY[0]) / MM;
  const dy = (s.pos[1] - pocketXY[1]) / MM;
  const inPlan = Math.abs(dx) < inner_mm[0] / 2 + 1 && Math.abs(dy) < inner_mm[1] / 2 + 1;
  const inPocket = inPlan && lowest < SEATED.floor_mm;
  return { lowest_above_floor_mm: lowest, tilt_deg: tilt, dx_mm: dx, seated: inPocket && tilt <= SEATED.tilt_deg, in_pocket: inPocket };
}

// --- particles and cups ---------------------------------------------------------
/**
 * Liquid stand-in: spheres of water density with frictionless contacts
 * (condim 1). Frictionless is the "low friction" end; it also keeps the run
 * fast (condim 3 costs about four times as much per step here).
 */
export const PARTICLES = { count: 80, radius_m: 0.0035, density: 1000, condim: 1, friction: "0.1 0.005 0.0001", grid: 5, pitch_m: 0.008, layer_m: 0.0075 };
export const CUP = { inner_half_m: 0.02, wall_m: 0.004, height_m: 0.05 };

/**
 * An open box cup as geoms in a body frame. `origin` places the frame: "lip"
 * puts the frame at the outer top edge on the +x side (the pour pivot),
 * "floor" at the centre of the inner floor.
 */
export function cupGeoms(name: string, inner_half: [number, number], height: number, wall: number, origin: "lip" | "floor", rgba = "0.7 0.75 0.85 0.5"): string {
  const [ix, iy] = inner_half;
  // centre of the inner floor in the body frame
  const c: Vec3 = origin === "lip" ? [-(ix + wall), 0, -height] : [0, 0, 0];
  const box = (part: string, p: Vec3, half: Vec3) =>
    `<geom name="${name}_${part}" type="box" pos="${v([c[0] + p[0], c[1] + p[1], c[2] + p[2]])}" size="${v(half)}" rgba="${rgba}"/>`;
  return [
    box("floor", [0, 0, -wall / 2], [ix + wall, iy + wall, wall / 2]),
    box("xpos", [ix + wall / 2, 0, height / 2], [wall / 2, iy + wall, height / 2]),
    box("xneg", [-ix - wall / 2, 0, height / 2], [wall / 2, iy + wall, height / 2]),
    box("ypos", [0, iy + wall / 2, height / 2], [ix, wall / 2, height / 2]),
    box("yneg", [0, -iy - wall / 2, height / 2], [ix, wall / 2, height / 2]),
  ].join("\n      ");
}

/** A deterministic generator for the small jitter that breaks the lattice's symmetry. */
export function lcg(seed = 1): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5;
}

/**
 * Particle bodies on a jittered lattice standing on a cup floor whose inner
 * centre is at `floor` (world). `contact` overrides condim and friction for
 * cross-checks.
 */
export function particleBodies(floor: Vec3, contact: { condim?: number; friction?: string } = {}, seed = 1): { xml: string; names: string[] } {
  const p = { ...PARTICLES, ...contact };
  const rnd = lcg(seed);
  const parts: string[] = [];
  const names: string[] = [];
  const start = -((p.grid - 1) / 2) * p.pitch_m;
  for (let n = 0; n < p.count; n++) {
    const layer = Math.floor(n / (p.grid * p.grid));
    const i = Math.floor(n / p.grid) % p.grid;
    const j = n % p.grid;
    const pos: Vec3 = [
      floor[0] + start + i * p.pitch_m + rnd() * 0.0008,
      floor[1] + start + j * p.pitch_m + rnd() * 0.0008,
      floor[2] + p.radius_m + 0.0005 + layer * p.layer_m,
    ];
    const name = `p${n}`;
    names.push(name);
    parts.push(
      `<body name="${name}" pos="${v(pos)}"><freejoint/><geom type="sphere" size="${f(p.radius_m)}" density="${p.density}" condim="${p.condim}" friction="${p.friction}" rgba="0.3 0.55 0.9 1"/></body>`,
    );
  }
  return { xml: parts.join("\n"), names };
}

/** Particle centres and speeds, read in one pass. */
export function particleStates(sim: Sim, adrs: { q: number; d: number }[]): { pos: Vec3[]; speed: number[] } {
  const q = sim.data.qpos as Float64Array;
  const dq = sim.data.qvel as Float64Array;
  const pos: Vec3[] = [];
  const speed: number[] = [];
  for (const a of adrs) {
    pos.push([q[a.q], q[a.q + 1], q[a.q + 2]]);
    speed.push(Math.hypot(dq[a.d], dq[a.d + 1], dq[a.d + 2]));
  }
  return { pos, speed };
}

// --- reporting ---------------------------------------------------------------
export function mdTable(headers: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.map(String).join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}
export const fmt = (n: number, digits = 1) => (Number.isFinite(n) ? n.toFixed(digits) : String(n));

/** With MEASURE_WRITE=1, write bench/results/gravity-<name>.json. Returns the path or null. */
export function writeResults(name: string, payload: { parameters: unknown; results: unknown } & Record<string, unknown>): string | null {
  if (process.env.MEASURE_WRITE !== "1") return null;
  const dir = path.join(process.cwd(), "bench", "results");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `gravity-${name}.json`);
  const body = {
    measurement: name,
    generated_at: new Date().toISOString(),
    engine: "MuJoCo WebAssembly (@mujoco/mujoco 3.17) in Node",
    g_m_s2: G_M_S2,
    timestep_s: TIMESTEP_S,
    ...payload,
  };
  writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  return file;
}
