/**
 * Scene builder: task-spec primitives into an MJCF worldbody the rehearsal
 * stage appends next to the SO-101.
 *
 *   manipulated objects  free bodies (cylinder, box, sphere) with a site at their centre
 *   pocket fixtures      a static body whose pocket is four walls and a floor, sized from
 *                        the footprint of the object that goes in plus the clearance
 *   zone fixtures        the object as given plus a flat zone site on its top face
 *   stack targets        ordinary objects; the target frame is their body
 *   obstacles, surfaces  static bodies
 *
 * Units: the spec is millimetres and degrees, MJCF is metres and radians (the
 * included SO-101 sets angle="radian" for the whole model). The world frame
 * is the robot base on the table surface, z up. Object poses may be given in
 * another object's frame; chains are composed here, so every emitted body
 * carries a world pose. Names are namespaced and injective (`obj_` plus an
 * encoding of the id), so they cannot collide with the arm or each other.
 * Objects without a pose are laid out in a row in front of the robot, around
 * whatever is already placed, and reported so the compiler can ask. World
 * perturbations (a scenario's axis offset, given in world axes) move the
 * object's nominal pose or change a pocket's clearance; a perturbation that
 * cannot apply is reported with `applied: false` so no rollout counts it as
 * tested; observation noise is left to the interpreter's sensed mode.
 * Geometry that cannot exist (a pocket wider than its fixture, a fixture too
 * shallow for a floor, a non-finite coordinate) is an error, not a guess.
 */
import type { Scenario, SpecObject, TaskSpec } from "@/lib/spec/schema";

export const MM = 0.001;
const DEG = Math.PI / 180;
/** pocket wall and floor thickness, m */
export const WALL_M = 0.008;
/** thinnest wall we will build, m */
export const MIN_WALL_M = 0.003;
export const DEFAULT_CLEARANCE_MM = 3;
export const NAME_PREFIX = "obj_";
const LAYOUT_X_MM = 250;
const LAYOUT_Y_START_MM = -250;
const LAYOUT_GAP_MM = 40;

export class SceneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneError";
  }
}

export type WorldPose = { xyz_m: [number, number, number]; euler_rad: [number, number, number] };
export type Tilt = { axis: "x" | "y"; deg: number };
export type SceneBuild = {
  /** MJCF fragment to place inside <worldbody> */
  worldbody: string;
  /** world pose of every object body, by id */
  frames: Record<string, WorldPose>;
  /** MJCF body name per object id */
  names: Record<string, string>;
  /** pocket openings by fixture id: inner size and usable depth, m */
  pockets: Record<string, { inner_m: [number, number]; depth_m: number }>;
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

type Flat = { xyz_mm: [number, number, number]; yaw_deg: number };

function rotZ(x: number, y: number, deg: number): [number, number] {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [c * x - s * y, s * x + c * y];
}

/** World poses of every posed object, composing frame chains. Throws on unknown or cyclic frames. */
export function worldPoses(spec: TaskSpec): Record<string, Flat> {
  const byId = new Map(spec.objects.map((o) => [o.id, o]));
  const out = dict<Flat>();
  const visiting = new Set<string>();
  const resolve = (id: string): Flat => {
    if (id in out) return out[id];
    const o = byId.get(id);
    if (!o?.pose) throw new SceneError(`object "${id}" has no pose to resolve`);
    if (visiting.has(id)) throw new SceneError(`object "${id}" has a cyclic pose frame`);
    visiting.add(id);
    let flat: Flat;
    if (o.pose.frame === "world") flat = { xyz_mm: [...o.pose.xyz_mm], yaw_deg: o.pose.yaw_deg };
    else {
      if (!byId.has(o.pose.frame)) throw new SceneError(`object "${id}" is posed in unknown frame "${o.pose.frame}"`);
      const p = resolve(o.pose.frame);
      const [x, y] = rotZ(o.pose.xyz_mm[0], o.pose.xyz_mm[1], p.yaw_deg);
      flat = { xyz_mm: [p.xyz_mm[0] + x, p.xyz_mm[1] + y, p.xyz_mm[2] + o.pose.xyz_mm[2]], yaw_deg: p.yaw_deg + o.pose.yaw_deg };
    }
    visiting.delete(id);
    out[id] = flat;
    return flat;
  };
  for (const o of spec.objects) if (o.pose) resolve(o.id);
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
  const placed = worldPoses(out);
  const widest = Math.max(...out.objects.map((o) => Math.max(...footprintMm(o))));
  // y intervals already occupied in the layout band, each widened by the gap
  const occupied: [number, number][] = [];
  for (const o of out.objects) {
    const p = placed[o.id];
    if (!p) continue;
    const half = Math.max(...footprintMm(o)) / 2; // yaw-safe square footprint
    if (Math.abs(p.xyz_mm[0] - LAYOUT_X_MM) > half + widest / 2) continue;
    occupied.push([p.xyz_mm[1] - half - LAYOUT_GAP_MM, p.xyz_mm[1] + half + LAYOUT_GAP_MM]);
  }
  const warnings: string[] = [];
  for (const o of missing) {
    const w = Math.max(...footprintMm(o));
    const starts = [LAYOUT_Y_START_MM, ...occupied.map(([, end]) => end)].sort((a, b) => a - b);
    const y = starts.find((s) => occupied.every(([a, b]) => s + w <= a || s >= b));
    if (y === undefined) throw new SceneError(`no room to lay out "${o.id}"`);
    o.pose = { xyz_mm: [LAYOUT_X_MM, y + w / 2, heightMm(o) / 2], yaw_deg: 0, frame: "world" };
    o.sources = { ...o.sources, pose: "default" };
    occupied.push([y - LAYOUT_GAP_MM, y + w + LAYOUT_GAP_MM]);
    warnings.push(`object "${o.id}" had no pose; laid out at (${LAYOUT_X_MM}, ${Math.round(y + w / 2)}) mm in front of the robot`);
  }
  return { spec: out, laidOut: missing.map((o) => o.id), warnings };
}

const usedAsPocket = (spec: TaskSpec, id: string) => spec.steps.some((s) => s.target?.fixture === "pocket" && s.target.frame === id);

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
): { spec: TaskSpec; tilts: Record<string, Tilt>; warnings: string[]; applied: boolean } {
  const laid = layoutMissingPoses(spec);
  const out = laid.spec;
  const warnings = [...laid.warnings];
  const tilts = dict<Tilt>();
  const o = out.objects.find((x) => x.id === scenario.object);
  if (!o) throw new SceneError(`scenario ${scenario.id}: unknown object "${scenario.object}"`);
  const pose = o.pose!;
  const world = worldPoses(out);
  const parentYaw = pose.frame === "world" ? 0 : world[pose.frame].yaw_deg;
  const shift = (dx: number, dy: number, dz: number) => {
    const [lx, ly] = rotZ(dx, dy, -parentYaw);
    pose.xyz_mm = [pose.xyz_mm[0] + lx, pose.xyz_mm[1] + ly, pose.xyz_mm[2] + dz];
  };
  let applied = true;
  switch (scenario.axis) {
    case "x_mm":
      shift(scenario.offset, 0, 0);
      break;
    case "y_mm":
      shift(0, scenario.offset, 0);
      break;
    case "z_mm":
      shift(0, 0, scenario.offset);
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
  return { spec: out, tilts, warnings, applied };
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
  const world = worldPoses(s);
  const frames = dict<WorldPose>();
  const names = dict<string>();
  const pockets = dict<{ inner_m: [number, number]; depth_m: number }>();
  const parts: string[] = [];

  for (const o of s.objects) {
    const name = mjcfName(o.id);
    names[o.id] = name;
    const w = world[o.id];
    const tilt = tilts[o.id];
    const xyz: [number, number, number] = [w.xyz_mm[0] * MM, w.xyz_mm[1] * MM, w.xyz_mm[2] * MM];
    // intrinsic xyz: yaw is applied first, then the tilt about a world axis
    const euler: [number, number, number] = [tilt?.axis === "x" ? tilt.deg * DEG : 0, tilt?.axis === "y" ? tilt.deg * DEG : 0, w.yaw_deg * DEG];
    frames[o.id] = { xyz_m: xyz, euler_rad: euler };
    const lines = [`<body name="${name}" pos="${v(xyz)}" euler="${v(euler)}">`];
    const rgba = COLORS[o.role];
    const pocket = o.role === "fixture" ? pocketFor(s, o) : null;
    if (o.role === "manipulated") lines.push(`  <freejoint name="${name}_free"/>`);
    if (pocket) {
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
  return { worldbody: parts.join("\n"), frames, names, pockets, warnings, laidOut: laid.laidOut };
}

/** A self-contained model for tests: the objects on a floor, no arm. */
export function standaloneXml(worldbody: string): string {
  return `<mujoco model="understudy-scene-test">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.005"/>
  <worldbody>
    <light pos="0 0 3" dir="0 0 -1" directional="true"/>
    <geom name="floor" size="0 0 0.05" type="plane"/>
${worldbody}
  </worldbody>
</mujoco>`;
}
