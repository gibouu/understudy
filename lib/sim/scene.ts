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
 * is the robot base on the table surface, z up. Objects without a pose are
 * laid out in a row in front of the robot and reported, so the compiler can
 * ask. World perturbations (a scenario's axis offset) move the object's
 * nominal pose or change a pocket's clearance; observation noise is not a
 * world change and is left to the interpreter's sensed mode.
 */
import type { Scenario, SpecObject, TaskSpec } from "@/lib/spec/schema";

export const MM = 0.001;
const DEG = Math.PI / 180;
/** pocket wall and floor thickness, m */
export const WALL_M = 0.008;
/** pocket depth is the fixture height minus the floor */
export const DEFAULT_CLEARANCE_MM = 3;
const LAYOUT_X_MM = 250;
const LAYOUT_GAP_MM = 40;

export type WorldPose = { xyz_m: [number, number, number]; euler_rad: [number, number, number] };
export type Tilt = { axis: "x" | "y"; deg: number };
export type SceneBuild = {
  /** MJCF fragment to place inside <worldbody> */
  worldbody: string;
  /** world pose of every object body, by id */
  frames: Record<string, WorldPose>;
  /** pocket openings by fixture id: inner size and the floor height, m */
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

const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
const f = (n: number) => (Number.isFinite(n) ? Number(n.toFixed(6)).toString() : "0");
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

/** Give every object without a pose a resting spot in a row in front of the robot. */
export function layoutMissingPoses(spec: TaskSpec): { spec: TaskSpec; laidOut: string[]; warnings: string[] } {
  const out = structuredClone(spec);
  const missing = out.objects.filter((o) => !o.pose);
  if (missing.length === 0) return { spec: out, laidOut: [], warnings: [] };
  const widths = missing.map((o) => footprintMm(o)[1]);
  const total = widths.reduce((s, w) => s + w, 0) + LAYOUT_GAP_MM * (missing.length - 1);
  let y = -total / 2;
  const warnings: string[] = [];
  for (const [k, o] of missing.entries()) {
    const w = widths[k];
    o.pose = { xyz_mm: [LAYOUT_X_MM, y + w / 2, heightMm(o) / 2], yaw_deg: 0, frame: "world" };
    o.sources = { ...o.sources, pose: "default" };
    warnings.push(`object "${o.id}" had no pose; laid out at (${LAYOUT_X_MM}, ${Math.round(y + w / 2)}) mm in front of the robot`);
    y += w + LAYOUT_GAP_MM;
  }
  return { spec: out, laidOut: missing.map((o) => o.id), warnings };
}

/** The spec after a scenario's world perturbation; observation noise is reported, not applied. */
export function perturb(spec: TaskSpec, scenario: Scenario): { spec: TaskSpec; tilts: Record<string, Tilt>; warnings: string[] } {
  const laid = layoutMissingPoses(spec);
  const out = laid.spec;
  const warnings = [...laid.warnings];
  const tilts: Record<string, Tilt> = {};
  const o = out.objects.find((x) => x.id === scenario.object);
  if (!o) throw new Error(`scenario ${scenario.id}: unknown object "${scenario.object}"`);
  const pose = o.pose!;
  switch (scenario.axis) {
    case "x_mm":
      pose.xyz_mm[0] += scenario.offset;
      break;
    case "y_mm":
      pose.xyz_mm[1] += scenario.offset;
      break;
    case "z_mm":
      pose.xyz_mm[2] += scenario.offset;
      break;
    case "yaw_deg":
      if (o.symmetry !== "none") warnings.push(`scenario ${scenario.id}: yaw on "${o.id}" (${o.symmetry} symmetry) changes nothing measurable`);
      pose.yaw_deg += scenario.offset;
      break;
    case "tilt_deg":
      tilts[o.id] = { axis: scenario.tilt_axis ?? "x", deg: scenario.offset };
      break;
    case "clearance_mm": {
      const before = o.pocket_clearance_mm ?? DEFAULT_CLEARANCE_MM;
      o.pocket_clearance_mm = Math.max(0, before + scenario.offset);
      if (before + scenario.offset < 0) warnings.push(`scenario ${scenario.id}: clearance clamped at 0 mm`);
      break;
    }
    case "pose_noise_mm":
      warnings.push(`scenario ${scenario.id}: pose_noise_mm is observation noise; the world is unchanged`);
      break;
  }
  return { spec: out, tilts, warnings };
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

function pocketFor(spec: TaskSpec, fixture: SpecObject): { inner_m: [number, number]; depth_m: number } | null {
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
  return { inner_m: [(fx + 2 * clearance) * MM, (fy + 2 * clearance) * MM], depth_m: heightMm(fixture) * MM - WALL_M };
}

function bodyOpen(o: SpecObject, tilt: Tilt | undefined): { open: string; pose: WorldPose } {
  const p = o.pose!;
  const xyz: [number, number, number] = [p.xyz_mm[0] * MM, p.xyz_mm[1] * MM, p.xyz_mm[2] * MM];
  const euler: [number, number, number] = [
    tilt?.axis === "x" ? tilt.deg * DEG : 0,
    tilt?.axis === "y" ? tilt.deg * DEG : 0,
    p.yaw_deg * DEG,
  ];
  return { open: `<body name="${safe(o.id)}" pos="${v(xyz)}" euler="${v(euler)}">`, pose: { xyz_m: xyz, euler_rad: euler } };
}

export function buildScene(spec: TaskSpec, tilts: Record<string, Tilt> = {}): SceneBuild {
  const laid = layoutMissingPoses(spec);
  const s = laid.spec;
  const warnings = [...laid.warnings];
  const frames: Record<string, WorldPose> = {};
  const pockets: SceneBuild["pockets"] = {};
  const parts: string[] = [];

  for (const o of s.objects) {
    const id = safe(o.id);
    const { open, pose } = bodyOpen(o, tilts[o.id]);
    frames[o.id] = pose;
    const lines = [open];
    const rgba = COLORS[o.role];
    const pocket = o.role === "fixture" ? pocketFor(s, o) : null;
    if (o.role === "manipulated") lines.push(`  <freejoint name="${id}_free"/>`);
    if (pocket) {
      if (o.shape !== "box") warnings.push(`fixture "${o.id}" is a ${o.shape}; its pocket is built as a box`);
      const [X, Y] = footprintMm(o).map((x) => x * MM);
      const Z = heightMm(o) * MM;
      let [ix, iy] = pocket.inner_m;
      let tx = (X - ix) / 2;
      let ty = (Y - iy) / 2;
      if (tx < 0.003 || ty < 0.003) {
        warnings.push(`fixture "${o.id}" is too small for its pocket; walls thinned to 3 mm`);
        tx = Math.max(tx, 0.003);
        ty = Math.max(ty, 0.003);
        ix = Math.min(ix, X - 2 * tx);
        iy = Math.min(iy, Y - 2 * ty);
      }
      pockets[o.id] = { inner_m: [ix, iy], depth_m: pocket.depth_m };
      const wall = (name: string, pos: number[], half: number[]) =>
        lines.push(`  <geom name="${id}_${name}" type="box" pos="${v(pos)}" size="${v(half)}" rgba="${rgba}"/>`);
      wall("wall_xneg", [-(ix / 2 + tx / 2), 0, 0], [tx / 2, Y / 2, Z / 2]);
      wall("wall_xpos", [ix / 2 + tx / 2, 0, 0], [tx / 2, Y / 2, Z / 2]);
      wall("wall_yneg", [0, -(iy / 2 + ty / 2), 0], [ix / 2, ty / 2, Z / 2]);
      wall("wall_ypos", [0, iy / 2 + ty / 2, 0], [ix / 2, ty / 2, Z / 2]);
      wall("floor", [0, 0, -Z / 2 + WALL_M / 2], [ix / 2, iy / 2, WALL_M / 2]);
      lines.push(`  <site name="${id}_pocket" pos="0 0 ${f(Z / 2)}" size="${v([ix / 2, iy / 2, 0.002])}" type="box" rgba="0 0 0 0"/>`);
      lines.push(`  <site name="${id}_pocket_floor" pos="0 0 ${f(-Z / 2 + WALL_M)}" size="0.002" rgba="0 0 0 0"/>`);
    } else {
      lines.push(`  <geom name="${id}_geom" type="${o.shape}" size="${geomSize(o)}" rgba="${rgba}" friction="1 0.005 0.0001"/>`);
      if (o.role === "fixture" || o.role === "surface") {
        const [X, Y] = footprintMm(o).map((x) => x * MM);
        const Z = heightMm(o) * MM;
        lines.push(`  <site name="${id}_zone" pos="0 0 ${f(Z / 2)}" size="${v([X / 2, Y / 2, 0.002])}" type="box" rgba="0 0 0 0"/>`);
      }
    }
    lines.push(`  <site name="${id}_site" pos="0 0 0" size="0.002" rgba="0 0 0 0"/>`);
    lines.push(`</body>`);
    parts.push(lines.join("\n"));
  }
  return { worldbody: parts.join("\n"), frames, pockets, warnings, laidOut: laid.laidOut };
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
