/**
 * Scene builder: task-spec primitives into an MJCF worldbody the rehearsal
 * stage appends next to the SO-101.
 *
 *   manipulated objects  free bodies (cylinder, box, sphere) with a site at their centre
 *   pocket fixtures      a static body whose pocket is four walls and a floor, sized from
 *                        the footprint of the object that goes in plus the clearance
 *   zone fixtures        the object as given plus a flat zone site on its top face
 *   stack targets        ordinary objects; the target frame is their body
 *   containers           any object that holds liquid (liquid_ml) or that a pour step pours
 *                        from or into: an open box, four walls and a floor, free if it is
 *                        manipulated; an `<name>_inside` site spans the space the liquid fills
 *   obstacles, surfaces  static bodies
 *
 * Units: the spec is millimetres and degrees, MJCF is metres and radians (the
 * included SO-101 sets angle="radian" for the whole model). The world frame
 * is the robot base on the table surface, z up. Object poses may be given in
 * another object's frame; chains are composed here as full 3D transforms
 * (position and rotation), so a tilted parent carries its children, and
 * every emitted body gets a world position and quaternion. Names are
 * namespaced and injective (`obj_` plus an encoding of the id), so they
 * cannot collide with the arm or each other. Objects without a pose are laid
 * out in a row in front of the robot, in free slots around whatever is
 * already placed (yaw-safe: each placed object is treated as a disc of its
 * diagonal), and reported so the compiler can ask. World perturbations (a
 * scenario's axis offset, given in world axes) move the object's nominal
 * pose or change a pocket's clearance; a perturbation that cannot apply is
 * reported with `applied: false` so no rollout counts it as tested; a
 * scenario perturbs one object, so a parent's own tilt is never in play when
 * an offset is converted into its frame. Geometry that cannot exist (a
 * pocket wider than its fixture, a fixture too shallow for a floor, a
 * non-finite coordinate, no room on the table) is an error, not a guess.
 */
import type { Scenario, SpecObject, TaskSpec } from "@/lib/spec/schema";

export const MM = 0.001;
const DEG = Math.PI / 180;
/** pocket wall and floor thickness, m */
export const WALL_M = 0.008;
/** thinnest wall we will build, m */
export const MIN_WALL_M = 0.003;
export const DEFAULT_CLEARANCE_MM = 3;
/**
 * container wall and floor thickness, m: at 4 mm a wall is thicker than the liquid's kernel
 * minus its particles (lib/sim/fluid.ts), so the solver never has to filter neighbours through it
 */
export const CONTAINER_WALL_M = 0.004;
export const NAME_PREFIX = "obj_";
const LAYOUT_X_MM = 250;
const LAYOUT_Y_START_MM = -250;
const LAYOUT_Y_END_MM = 800;
const LAYOUT_GAP_MM = 40;

export class SceneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneError";
  }
}

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
/** row-major 3x3 */
export type Mat3 = [number, number, number, number, number, number, number, number, number];
export type WorldPose = { xyz_m: Vec3; quat: Quat; yaw_rad: number };
export type Tilt = { axis: "x" | "y"; deg: number };
export type Pose3 = { xyz_mm: Vec3; R: Mat3; yaw_deg: number };
export type SceneBuild = {
  /** MJCF fragment to place inside <worldbody> */
  worldbody: string;
  /** world pose of every object body, by id */
  frames: Record<string, WorldPose>;
  /** MJCF body name per object id */
  names: Record<string, string>;
  /** MJCF body names of the free bodies, the ones the arm can grasp */
  manipulated: string[];
  /** pocket openings by fixture id: inner size and usable depth, m */
  pockets: Record<string, { inner_m: [number, number]; depth_m: number }>;
  /** open containers by object id: inner size and depth, m (the liquid's `<name>_inside` site) */
  containers: Record<string, { inner_m: [number, number]; depth_m: number }>;
  warnings: string[];
  /** objects that had no pose and were laid out */
  laidOut: string[];
};

export const COLORS: Record<SpecObject["role"], string> = {
  manipulated: "0.93 0.52 0.2 1",
  fixture: "0.55 0.6 0.7 1",
  obstacle: "0.75 0.3 0.3 1",
  surface: "0.76 0.66 0.5 1",
};

const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

// --- rotations ---------------------------------------------------------------
export const I3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const rotX = (deg: number): Mat3 => {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [1, 0, 0, 0, c, -s, 0, s, c];
};
export const rotY = (deg: number): Mat3 => {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
};
export const rotZ = (deg: number): Mat3 => {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};
export const mul = (a: Mat3, b: Mat3): Mat3 => {
  const r = new Array<number>(9) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
  return r;
};
export const transpose = (a: Mat3): Mat3 => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
export const apply = (a: Mat3, v: Vec3): Vec3 => [
  a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
  a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
  a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
];
/** unit quaternion [w, x, y, z] of a rotation matrix */
export function matToQuat(m: Mat3): Quat {
  const t = m[0] + m[4] + m[8];
  let w: number, x: number, y: number, z: number;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    w = s / 4; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[7] - m[5]) / s; x = s / 4; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = s / 4; z = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = s / 4;
  }
  const n = Math.hypot(w, x, y, z);
  return [w / n, x / n, y / n, z / n];
}
/** an object's own rotation: yaw first, then a world-axis tilt (MuJoCo's intrinsic xyz with euler [tx, ty, yaw]) */
const ownRotation = (yawDeg: number, tilt?: Tilt): Mat3 => {
  const yaw = rotZ(yawDeg);
  if (!tilt) return yaw;
  return mul(tilt.axis === "x" ? rotX(tilt.deg) : rotY(tilt.deg), yaw);
};

/** Injective MJCF-safe body name: letters, digits and '-' pass, '_' becomes '__', anything else '_<hex>_'. */
export function mjcfName(id: string): string {
  let out = NAME_PREFIX;
  for (const ch of id) {
    if (/[A-Za-z0-9-]/.test(ch)) out += ch;
    else if (ch === "_") out += "__";
    else out += `_${ch.codePointAt(0)!.toString(16)}_`;
  }
  return out;
}

function f(n: number): string {
  if (!Number.isFinite(n)) throw new SceneError(`non-finite coordinate ${n}`);
  return Number(n.toFixed(6)).toString();
}
const v = (xs: number[]) => xs.map(f).join(" ");

/** Footprint of an object in the table plane, mm: [x, y]. */
export function footprintMm(o: SpecObject): [number, number] {
  const [a, b] = o.size_mm;
  return o.shape === "box" ? [a, b] : [a, a];
}
/** Height of an object, mm. */
export function heightMm(o: SpecObject): number {
  return o.size_mm[2];
}
/** Radius of the disc that contains the footprint under any yaw, mm. */
const discRadiusMm = (o: SpecObject) => Math.hypot(...footprintMm(o)) / 2;

/**
 * World poses, composing frame chains as full transforms. In strict mode an
 * object whose chain reaches an unposed object is an error; in partial mode
 * it is left out (layout fills those first).
 */
export function worldPoses(spec: TaskSpec, tilts: Record<string, Tilt> = {}, options: { partial?: boolean } = {}): Record<string, Pose3> {
  const byId = new Map(spec.objects.map((o) => [o.id, o]));
  const out = dict<Pose3>();
  const skipped = new Set<string>();
  const visiting = new Set<string>();
  const resolve = (id: string): Pose3 | undefined => {
    if (id in out) return out[id];
    if (skipped.has(id)) return undefined;
    const o = byId.get(id);
    if (!o) throw new SceneError(`unknown frame "${id}"`);
    if (!o.pose) {
      if (options.partial) {
        skipped.add(id);
        return undefined;
      }
      throw new SceneError(`object "${id}" has no pose to resolve`);
    }
    if (visiting.has(id)) throw new SceneError(`object "${id}" has a cyclic pose frame`);
    visiting.add(id);
    const R_local = ownRotation(o.pose.yaw_deg, Object.hasOwn(tilts, id) ? tilts[id] : undefined); // own property: an id like __proto__ must not read the prototype
    let pose: Pose3 | undefined;
    if (o.pose.frame === "world") pose = { xyz_mm: [...o.pose.xyz_mm], R: R_local, yaw_deg: o.pose.yaw_deg };
    else {
      if (!byId.has(o.pose.frame)) throw new SceneError(`object "${id}" is posed in unknown frame "${o.pose.frame}"`);
      const p = resolve(o.pose.frame);
      if (p) {
        const t = apply(p.R, o.pose.xyz_mm);
        pose = { xyz_mm: [p.xyz_mm[0] + t[0], p.xyz_mm[1] + t[1], p.xyz_mm[2] + t[2]], R: mul(p.R, R_local), yaw_deg: p.yaw_deg + o.pose.yaw_deg };
      }
    }
    visiting.delete(id);
    if (pose) out[id] = pose;
    else skipped.add(id);
    return pose;
  };
  for (const o of spec.objects) resolve(o.id);
  return out;
}

/**
 * Give every object without a pose a resting spot in a row in front of the
 * robot, in free y intervals next to whatever is already placed there.
 */
export function layoutMissingPoses(spec: TaskSpec): { spec: TaskSpec; laidOut: string[]; warnings: string[] } {
  const out = structuredClone(spec);
  const missing = out.objects.filter((o) => !o.pose);
  if (missing.length === 0) return { spec: out, laidOut: [], warnings: [] };
  const widest = Math.max(...out.objects.map(discRadiusMm)) * 2;
  // y intervals already occupied in the layout band, each widened by the gap
  const occupied: [number, number][] = [];
  const reserved = new Set<string>();
  const reserveResolved = () => {
    const placed = worldPoses(out, {}, { partial: true });
    for (const o of out.objects) {
      const p = placed[o.id];
      if (!p || reserved.has(o.id)) continue;
      reserved.add(o.id);
      const r = discRadiusMm(o);
      if (Math.abs(p.xyz_mm[0] - LAYOUT_X_MM) > r + widest / 2) continue;
      occupied.push([p.xyz_mm[1] - r - LAYOUT_GAP_MM, p.xyz_mm[1] + r + LAYOUT_GAP_MM]);
    }
  };
  reserveResolved();
  const warnings: string[] = [];
  for (const o of missing) {
    const w = 2 * discRadiusMm(o);
    const starts = [LAYOUT_Y_START_MM, ...occupied.map(([, end]) => end)]
      .filter((s) => s >= LAYOUT_Y_START_MM && s + w <= LAYOUT_Y_END_MM)
      .sort((a, b) => a - b);
    const y = starts.find((s) => occupied.every(([a, b]) => s + w <= a || s >= b));
    if (y === undefined) throw new SceneError(`no room to lay out "${o.id}" in front of the robot`);
    o.pose = { xyz_mm: [LAYOUT_X_MM, y + w / 2, heightMm(o) / 2], yaw_deg: 0, frame: "world" };
    o.sources = { ...o.sources, pose: "default" };
    warnings.push(`object "${o.id}" had no pose; laid out at (${LAYOUT_X_MM}, ${Math.round(y + w / 2)}) mm in front of the robot`);
    // the new object and any children it just made resolvable now count as occupied
    reserveResolved();
  }
  return { spec: out, laidOut: missing.map((o) => o.id), warnings };
}

const usedAsPocket = (spec: TaskSpec, id: string) => spec.steps.some((s) => s.target?.fixture === "pocket" && s.target.frame === id);

/** Objects built as open containers: they hold liquid at the start, or a pour step pours from or into them. */
export function containerIds(spec: TaskSpec): Set<string> {
  const ids = new Set(spec.objects.filter((o) => o.liquid_ml !== undefined).map((o) => o.id));
  for (const s of spec.steps) {
    if (s.verb !== "pour") continue;
    ids.add(s.object);
    if (s.pour) ids.add(s.pour.into);
  }
  return ids;
}

/**
 * The spec after a scenario's world perturbation. Offsets are in world axes
 * and converted into the object's own pose frame. `applied` is false when
 * the perturbation changes nothing measurable in the world (observation
 * noise, clearance on something that is not a pocket), so the caller never
 * counts such a scenario as tested.
 */
export function perturb(
  spec: TaskSpec,
  scenario: Scenario,
): { spec: TaskSpec; tilts: Record<string, Tilt>; warnings: string[]; applied: boolean; gravity_g: number } {
  const laid = layoutMissingPoses(spec);
  const out = laid.spec;
  const warnings = [...laid.warnings];
  const tilts = dict<Tilt>();
  const o = out.objects.find((x) => x.id === scenario.object);
  if (!o) throw new SceneError(`scenario ${scenario.id}: unknown object "${scenario.object}"`);
  const pose = o.pose!;
  const world = worldPoses(out);
  const parentR = pose.frame === "world" ? I3 : world[pose.frame].R;
  const shift = (offset: Vec3) => {
    const local = apply(transpose(parentR), offset);
    pose.xyz_mm = [pose.xyz_mm[0] + local[0], pose.xyz_mm[1] + local[1], pose.xyz_mm[2] + local[2]];
  };
  let applied = true;
  switch (scenario.axis) {
    case "x_mm":
      shift([scenario.offset, 0, 0]);
      break;
    case "y_mm":
      shift([0, scenario.offset, 0]);
      break;
    case "z_mm":
      shift([0, 0, scenario.offset]);
      break;
    case "yaw_deg":
      if (o.symmetry !== "none") warnings.push(`scenario ${scenario.id}: yaw on "${o.id}" (${o.symmetry} symmetry) changes nothing measurable`);
      pose.yaw_deg += scenario.offset;
      break;
    case "tilt_deg":
      tilts[o.id] = { axis: scenario.tilt_axis ?? "x", deg: scenario.offset };
      break;
    case "clearance_mm": {
      if (o.role !== "fixture" || !usedAsPocket(out, o.id)) {
        warnings.push(`scenario ${scenario.id}: clearance applies only to a fixture used as a pocket; "${o.id}" is not one, nothing changed`);
        applied = false;
        break;
      }
      const before = o.pocket_clearance_mm ?? DEFAULT_CLEARANCE_MM;
      o.pocket_clearance_mm = Math.max(0, before + scenario.offset);
      if (before + scenario.offset < 0) warnings.push(`scenario ${scenario.id}: clearance clamped at 0 mm`);
      break;
    }
    case "pose_noise_mm":
      warnings.push(`scenario ${scenario.id}: pose_noise_mm is observation noise; the world is unchanged`);
      applied = false;
      break;
  }
  for (const c of pose.xyz_mm) if (!Number.isFinite(c)) throw new SceneError(`scenario ${scenario.id}: non-finite pose for "${o.id}"`);
  return { spec: out, tilts, warnings, applied, gravity_g: scenario.gravity_g ?? 1 };
}

function geomSize(o: SpecObject): string {
  const [a, b, c] = o.size_mm.map((x) => x * MM);
  switch (o.shape) {
    case "cylinder":
      return v([a / 2, c / 2]);
    case "sphere":
      return v([a / 2]);
    case "box":
      return v([a / 2, b / 2, c / 2]);
  }
}

/** Opening and floor of a fixture used as a pocket, or null; throws when it cannot be built. */
function pocketFor(spec: TaskSpec, fixture: SpecObject): { inner_m: [number, number]; depth_m: number; floor_m: number } | null {
  const users = spec.steps.filter((s) => s.target?.fixture === "pocket" && s.target.frame === fixture.id);
  if (users.length === 0) return null;
  let fx = 0;
  let fy = 0;
  for (const s of users) {
    const o = spec.objects.find((x) => x.id === s.object);
    if (!o) continue;
    const [a, b] = footprintMm(o);
    fx = Math.max(fx, a);
    fy = Math.max(fy, b);
  }
  if (fx === 0) return null;
  const clearance = fixture.pocket_clearance_mm ?? DEFAULT_CLEARANCE_MM;
  const inner: [number, number] = [(fx + clearance) * MM, (fy + clearance) * MM]; // hole minus object = clearance
  const [X, Y] = footprintMm(fixture).map((x) => x * MM);
  const Z = heightMm(fixture) * MM;
  const need = [inner[0] + 2 * MIN_WALL_M, inner[1] + 2 * MIN_WALL_M];
  if (X < need[0] || Y < need[1]) {
    throw new SceneError(
      `fixture "${fixture.id}" (${Math.round(X / MM)} x ${Math.round(Y / MM)} mm) is too small for a ${fx} x ${fy} mm object plus ${clearance} mm clearance; it needs at least ${Math.ceil(need[0] / MM)} x ${Math.ceil(need[1] / MM)} mm`,
    );
  }
  const floor = Math.min(WALL_M, Z / 2);
  const depth = Z - floor;
  if (depth < 0.001) throw new SceneError(`fixture "${fixture.id}" (${Math.round(Z / MM)} mm high) is too shallow for a pocket`);
  return { inner_m: inner, depth_m: depth, floor_m: floor };
}

export function buildScene(spec: TaskSpec, tilts: Record<string, Tilt> = {}): SceneBuild {
  const laid = layoutMissingPoses(spec);
  const s = laid.spec;
  const seen = new Set<string>();
  for (const o of s.objects) {
    if (seen.has(o.id)) throw new SceneError(`object id "${o.id}" appears twice`);
    seen.add(o.id);
  }
  const warnings = [...laid.warnings];
  const world = worldPoses(s, tilts);
  const frames = dict<WorldPose>();
  const names = dict<string>();
  const pockets = dict<{ inner_m: [number, number]; depth_m: number }>();
  const containers = dict<{ inner_m: [number, number]; depth_m: number }>();
  const open = containerIds(s);
  const parts: string[] = [];
  const manipulated: string[] = [];

  for (const o of s.objects) {
    const name = mjcfName(o.id);
    names[o.id] = name;
    const w = world[o.id];
    const xyz: Vec3 = [w.xyz_mm[0] * MM, w.xyz_mm[1] * MM, w.xyz_mm[2] * MM];
    const quat = matToQuat(w.R);
    frames[o.id] = { xyz_m: xyz, quat, yaw_rad: w.yaw_deg * DEG };
    const lines = [`<body name="${name}" pos="${v(xyz)}" quat="${v(quat)}">`];
    const rgba = COLORS[o.role];
    const container = open.has(o.id);
    const pocket = o.role === "fixture" && !container ? pocketFor(s, o) : null;
    if (container && o.role === "fixture" && usedAsPocket(s, o.id)) warnings.push(`object "${o.id}" holds liquid; it is built as an open container, not a pocket`);
    if (o.role === "manipulated") {
      lines.push(`  <freejoint name="${name}_free"/>`);
      manipulated.push(name);
    }
    if (container) {
      if (o.shape !== "box") warnings.push(`container "${o.id}" is a ${o.shape}; it is built as an open box`);
      const [X, Y] = footprintMm(o).map((x) => x * MM);
      const Z = heightMm(o) * MM;
      const t = CONTAINER_WALL_M;
      const [ix, iy, depth] = [X - 2 * t, Y - 2 * t, Z - t];
      // the liquid needs room for a few particles across: 4 mm ones, two kernels wide
      if (Math.min(ix, iy, depth) < 0.016) {
        throw new SceneError(`container "${o.id}" (${Math.round(X / MM)} x ${Math.round(Y / MM)} x ${Math.round(Z / MM)} mm) is too small to hold liquid with ${t / MM} mm walls; it needs at least ${Math.ceil((0.016 + 2 * t) / MM)} mm across and ${Math.ceil((0.016 + t) / MM)} mm high`);
      }
      containers[o.id] = { inner_m: [ix, iy], depth_m: depth };
      const wall = (part: string, pos: number[], half: number[]) =>
        lines.push(`  <geom name="${name}_${part}" type="box" pos="${v(pos)}" size="${v(half)}" rgba="${rgba}" friction="1 0.005 0.0001"/>`);
      wall("wall_xneg", [-(X - t) / 2, 0, 0], [t / 2, Y / 2, Z / 2]);
      wall("wall_xpos", [(X - t) / 2, 0, 0], [t / 2, Y / 2, Z / 2]);
      wall("wall_yneg", [0, -(Y - t) / 2, 0], [ix / 2, t / 2, Z / 2]);
      wall("wall_ypos", [0, (Y - t) / 2, 0], [ix / 2, t / 2, Z / 2]);
      wall("floor", [0, 0, -(Z - t) / 2], [ix / 2, iy / 2, t / 2]);
      lines.push(`  <site name="${name}_inside" pos="0 0 ${f(t / 2)}" size="${v([ix / 2, iy / 2, depth / 2])}" type="box" rgba="0 0 0 0"/>`);
    } else if (pocket) {
      if (o.shape !== "box") warnings.push(`fixture "${o.id}" is a ${o.shape}; its pocket is built as a box`);
      const [X, Y] = footprintMm(o).map((x) => x * MM);
      const Z = heightMm(o) * MM;
      const [ix, iy] = pocket.inner_m;
      const tx = (X - ix) / 2;
      const ty = (Y - iy) / 2;
      pockets[o.id] = { inner_m: [ix, iy], depth_m: pocket.depth_m };
      const wall = (part: string, pos: number[], half: number[]) =>
        lines.push(`  <geom name="${name}_${part}" type="box" pos="${v(pos)}" size="${v(half)}" rgba="${rgba}"/>`);
      wall("wall_xneg", [-(ix / 2 + tx / 2), 0, 0], [tx / 2, Y / 2, Z / 2]);
      wall("wall_xpos", [ix / 2 + tx / 2, 0, 0], [tx / 2, Y / 2, Z / 2]);
      wall("wall_yneg", [0, -(iy / 2 + ty / 2), 0], [ix / 2, ty / 2, Z / 2]);
      wall("wall_ypos", [0, iy / 2 + ty / 2, 0], [ix / 2, ty / 2, Z / 2]);
      wall("floor", [0, 0, -Z / 2 + pocket.floor_m / 2], [ix / 2, iy / 2, pocket.floor_m / 2]);
      lines.push(`  <site name="${name}_pocket" pos="0 0 ${f(Z / 2)}" size="${v([ix / 2, iy / 2, 0.002])}" type="box" rgba="0 0 0 0"/>`);
      lines.push(`  <site name="${name}_pocket_floor" pos="0 0 ${f(-Z / 2 + pocket.floor_m)}" size="0.002" rgba="0 0 0 0"/>`);
    } else {
      lines.push(`  <geom name="${name}_geom" type="${o.shape}" size="${geomSize(o)}" rgba="${rgba}" friction="1 0.005 0.0001"/>`);
      if (o.role === "fixture" || o.role === "surface") {
        const [X, Y] = footprintMm(o).map((x) => x * MM);
        const Z = heightMm(o) * MM;
        lines.push(`  <site name="${name}_zone" pos="0 0 ${f(Z / 2)}" size="${v([X / 2, Y / 2, 0.002])}" type="box" rgba="0 0 0 0"/>`);
      }
    }
    lines.push(`  <site name="${name}_site" pos="0 0 0" size="0.002" rgba="0 0 0 0"/>`);
    lines.push(`</body>`);
    parts.push(lines.join("\n"));
  }
  return { worldbody: parts.join("\n"), frames, names, manipulated, pockets, containers, warnings, laidOut: laid.laidOut };
}

/** A self-contained model for tests: the objects on a floor, no arm, under a given gravity. */
export function standaloneXml(worldbody: string, gravity_g = 1): string {
  return `<mujoco model="understudy-scene-test">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.005" gravity="0 0 ${-9.81 * gravity_g}"/>
  <worldbody>
    <light pos="0 0 3" dir="0 0 -1" directional="true"/>
    <geom name="floor" size="0 0 0.05" type="plane"/>
${worldbody}
  </worldbody>
</mujoco>`;
}
