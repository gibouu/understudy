/**
 * Settings: scene dressing that shows the bench in a place where the task
 * would really be done, a station module for a clip shot aboard a spacecraft
 * and a kitchen counter for everything else. Visual only: nothing here is in
 * the MuJoCo model, so the arm, the objects and the liquid move exactly as on
 * the bench. The work surface's top is the bench's z = 0, and every part stays
 * out of the volume the arm works in (CLEAR_M).
 *
 * World metres in MuJoCo's Z-up frame, the robot base at the origin. The room
 * is a corner behind the arm and to its left as the stage camera sees it: a
 * back wall at x = BACK_X, a side wall at y = SIDE_Y, the counter between them
 * and the room's floor a counter's height below. Walls are one-sided planes
 * facing the room, so orbiting behind one drops it out of the way. Parts are
 * boxes, cylinders and spheres merged into one mesh per material: a whole
 * setting is about a dozen draw calls. Shapes are generic; no agency marks.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { GravityName } from "@/lib/spec/schema";

export const SETTINGS = ["station", "kitchen"] as const;
export type SettingName = (typeof SETTINGS)[number];
export const SETTING_NAMES: Record<SettingName, string> = { station: "station module", kitchen: "kitchen counter" };
/** The world a setting stands for: a program is shown in a setting only once it has passed in that world. */
export const SETTING_WORLD: Record<SettingName, GravityName> = { station: "orbit", kitchen: "earth" };

/** Words that put a clip aboard a spacecraft; any other clip is done at home. */
const SPACE =
  /\b(ISS|space ?stations?|orbit(al|ing)?|in space|astronauts?|cosmonauts?|spacecraft|space ?walks?|micro-?gravity|zero[- ]g(ravity)?|weightless(ness)?|aboard (the|a) (station|module))\b/i;

/** The setting a clip belongs in, from its words: the label's title and summary, the uploader's hint. */
export function settingFor(...texts: (string | undefined)[]): SettingName {
  return texts.some((t) => t && SPACE.test(t)) ? "station" : "kitchen";
}

type Vec = [number, number, number];

/** The volume the arm and the task's objects use; no part of a setting enters it. */
export const CLEAR_M: { min: Vec; max: Vec } = { min: [-0.25, -0.5, 0.0005], max: [0.6, 0.5, 0.55] };

/**
 * Where the stage camera goes when a setting comes on, [target, from]: back and up from the bench view, so the
 * walls show around the arm. The frame ends near the camera's height, so what says "station" or "kitchen" sits
 * below about 0.55 m.
 */
export const SETTING_VIEW: [Vec, Vec] = [
  [0.05, 0.06, 0.16],
  [0.8, -0.7, 0.56],
];

const BACK_X = -0.35;
const SIDE_Y = 0.6;
/** the far end of the back wall and the open front of the room */
const FAR_Y = -1.4;
const NEAR_X = 1.7;
/** the counter's front edge */
const FRONT_X = 0.62;
/** the room's floor, a counter's height below the work surface, and the top of the walls */
const FLOOR_Z = -0.9;
const TOP_Z = 1.3;

/** A wall seen from the room: the plane it stands in, which way it faces, and its extent along the floor. */
type Wall = { face: "+x" | "-y"; plane: number; u: [number, number] };
const BACK: Wall = { face: "+x", plane: BACK_X, u: [FAR_Y, SIDE_Y] };
const SIDE: Wall = { face: "-y", plane: SIDE_Y, u: [BACK_X, NEAR_X] };

/** A point on a wall: `u` along it, `z` up, `d` out into the room. */
const onWall = (w: Wall, u: number, z: number, d: number): Vec => (w.face === "+x" ? [w.plane + d, u, z] : [u, w.plane - d, z]);

const mat = (color: number, roughness = 0.85) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
/** a surface that reads as lit from inside: a light panel, a window, a screen */
const glow = (color: number, intensity = 1) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 1 });

/** Collects parts by material and merges each material's parts into one mesh. */
class Parts {
  private byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();

  private add(m: THREE.Material, g: THREE.BufferGeometry) {
    const list = this.byMat.get(m);
    if (list) list.push(g);
    else this.byMat.set(m, [g]);
  }

  /** an axis-aligned box between two opposite corners */
  box(m: THREE.Material, a: Vec, b: Vec) {
    const g = new THREE.BoxGeometry(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]));
    g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    this.add(m, g);
  }

  /** a box standing out from a wall: `u` and `z` its extent on the wall, `d` how far it stands out */
  onWall(m: THREE.Material, w: Wall, u: [number, number], z: [number, number], d: [number, number]) {
    this.box(m, onWall(w, u[0], z[0], d[0]), onWall(w, u[1], z[1], d[1]));
  }

  /** a cylinder of radius `r` from `a` to `b` */
  rod(m: THREE.Material, a: Vec, b: Vec, r: number, segments = 12) {
    const from = new THREE.Vector3(...a);
    const axis = new THREE.Vector3(...b).sub(from);
    const g = new THREE.CylinderGeometry(r, r, axis.length(), segments);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize()));
    g.translate(from.x + axis.x / 2, from.y + axis.y / 2, from.z + axis.z / 2);
    this.add(m, g);
  }

  ball(m: THREE.Material, c: Vec, r: number) {
    const g = new THREE.SphereGeometry(r, 12, 8);
    g.translate(...c);
    this.add(m, g);
  }

  /** a one-sided rectangle seen from the room (a wall), or facing up (a floor) */
  plane(m: THREE.Material, face: Wall["face"] | "+z", c: Vec, w: number, h: number) {
    const [u, v, n] = {
      "+x": [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)],
      "-y": [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0)],
      "+z": [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
    }[face];
    const g = new THREE.PlaneGeometry(w, h);
    g.applyMatrix4(new THREE.Matrix4().makeBasis(u, v, n).setPosition(...c));
    this.add(m, g);
  }

  /** the walls and the floor of the room, the walls painted to `wall` */
  shell(wall: THREE.Material, floor: THREE.Material) {
    const h = TOP_Z - FLOOR_Z;
    const zc = (TOP_Z + FLOOR_Z) / 2;
    this.plane(wall, "+x", [BACK_X, (FAR_Y + SIDE_Y) / 2, zc], SIDE_Y - FAR_Y, h);
    this.plane(wall, "-y", [(BACK_X + NEAR_X) / 2, SIDE_Y, zc], NEAR_X - BACK_X, h);
    this.plane(floor, "+z", [(BACK_X + NEAR_X) / 2, (FAR_Y + SIDE_Y) / 2, FLOOR_Z], NEAR_X - BACK_X, SIDE_Y - FAR_Y);
  }

  /**
   * A grid of doors on a wall, each standing out `depth` with a gap between them: `us` and `zs` are the grid lines.
   * `latch` adds a small handle near each door's top edge.
   */
  doors(m: THREE.Material, w: Wall, us: number[], zs: number[], depth: number, gap: number, latch?: THREE.Material) {
    for (let i = 0; i + 1 < us.length; i++)
      for (let k = 0; k + 1 < zs.length; k++) {
        const [u0, u1, z0, z1] = [us[i] + gap / 2, us[i + 1] - gap / 2, zs[k] + gap / 2, zs[k + 1] - gap / 2];
        this.onWall(m, w, [u0, u1], [z0, z1], [0, depth]);
        if (latch) this.onWall(latch, w, [(u0 + u1) / 2 - 0.035, (u0 + u1) / 2 + 0.035], [z1 - 0.045, z1 - 0.03], [depth, depth + 0.012]);
      }
  }

  build(): THREE.Group {
    const group = new THREE.Group();
    for (const [m, geos] of this.byMat) {
      const merged = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      if (!merged) throw new Error("setting parts could not be merged");
      const mesh = new THREE.Mesh(merged, m);
      mesh.matrixAutoUpdate = false; // the room never moves
      group.add(mesh);
    }
    return group;
  }
}

/** Grid lines from `a` to `b` in steps of about `size`, ending exactly at both. */
function lines(a: number, b: number, size: number): number[] {
  const n = Math.max(1, Math.round((b - a) / size));
  return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
}

/** A handrail on a wall: a bar on two stand-offs. */
function handrail(p: Parts, bar: THREE.Material, foot: THREE.Material, w: Wall, u: [number, number], z: number) {
  for (const x of u) p.rod(foot, onWall(w, x, z, 0), onWall(w, x, z, 0.05), 0.009, 8);
  p.rod(bar, onWall(w, u[0] - 0.02, z, 0.05), onWall(w, u[1] + 0.02, z, 0.05), 0.013);
}

/**
 * A station module: deck plates on the work table, racks of small stowage lockers on both walls and under the table,
 * blue handrails, a framed light panel, a cargo bag strapped to the rack, a laptop on a bracket, hook-and-loop
 * patches.
 */
function station(): { group: THREE.Group; background: number } {
  const m = {
    rack: mat(0x8f99a4),
    locker: mat(0xe9e7e1, 0.7),
    plate: mat(0xd2d6d9, 0.6),
    latch: mat(0x4b5664),
    rail: mat(0x2f66ad, 0.45),
    foot: mat(0x99a2ab, 0.5),
    patch: mat(0x3a3f46),
    bag: mat(0xf6f3ea, 0.95),
    strap: mat(0xcf5220, 0.7),
    light: glow(0xfff3d8, 1.1),
    laptop: mat(0x2b3036, 0.5),
    screen: glow(0x6f93c4, 0.5),
  };
  const p = new Parts();
  p.shell(m.rack, m.rack);
  // the work table on the racks: deck plates over a dark frame, a seat-track rail along its front edge
  p.box(m.latch, [BACK_X, FAR_Y, -0.035], [FRONT_X, SIDE_Y, -0.003]);
  const plateX = lines(BACK_X, FRONT_X, 0.32);
  const plateY = lines(FAR_Y, SIDE_Y, 0.32);
  for (let i = 0; i + 1 < plateX.length; i++)
    for (let k = 0; k + 1 < plateY.length; k++) p.box(m.plate, [plateX[i] + 0.004, plateY[k] + 0.004, -0.003], [plateX[i + 1] - 0.004, plateY[k + 1] - 0.004, 0]);
  p.box(m.foot, [FRONT_X, FAR_Y, -0.035], [FRONT_X + 0.014, SIDE_Y, -0.01]);
  // lockers under the table, on the back wall, on the side wall around the light panel and past the table
  const under: Wall = { face: "+x", plane: FRONT_X - 0.02, u: [FAR_Y, SIDE_Y] };
  const rows = [0.02, 0.2, 0.38, 0.56, 0.78, 1.0, TOP_Z - 0.02];
  p.doors(m.locker, under, lines(FAR_Y, SIDE_Y, 0.26), [FLOOR_Z + 0.04, -0.62, -0.34, -0.06], 0.015, 0.012, m.latch);
  p.doors(m.locker, BACK, lines(FAR_Y, SIDE_Y - 0.05, 0.24), rows, 0.016, 0.012, m.latch);
  const sideU = lines(BACK_X + 0.05, FRONT_X, 0.23);
  p.doors(m.locker, SIDE, sideU, rows.slice(0, 3), 0.016, 0.012, m.latch);
  p.doors(m.locker, SIDE, sideU.slice(0, 2), rows.slice(2, 4), 0.016, 0.012, m.latch);
  p.doors(m.locker, SIDE, sideU, rows.slice(3), 0.016, 0.012, m.latch);
  p.doors(m.locker, SIDE, lines(FRONT_X, NEAR_X, 0.26), [FLOOR_Z, -0.6, -0.3, 0, 0.3, 0.56, 0.78, 1.0, TOP_Z - 0.02], 0.016, 0.012, m.latch);
  const lit: [number, number] = [sideU[1] + 0.02, sideU.at(-1)! - 0.02];
  p.onWall(m.foot, SIDE, lit, [rows[2] + 0.01, rows[3] - 0.01], [0, 0.014]);
  p.onWall(m.light, SIDE, [lit[0] + 0.02, lit[1] - 0.02], [rows[2] + 0.03, rows[3] - 0.03], [0.014, 0.016]);
  // the corner post where the racks meet
  p.box(m.foot, [BACK_X, SIDE_Y - 0.05, FLOOR_Z], [BACK_X + 0.05, SIDE_Y, TOP_Z]);
  // handrails: one along the back wall behind the arm, one upright by the corner, more out of frame
  handrail(p, m.rail, m.foot, BACK, [-0.2, 0.42], 0.29);
  handrail(p, m.rail, m.foot, BACK, [-1.25, -0.7], 0.47);
  handrail(p, m.rail, m.foot, SIDE, [0.85, 1.4], 0.47);
  for (const z of [0.07, 0.33]) p.rod(m.foot, onWall(SIDE, -0.22, z, 0), onWall(SIDE, -0.22, z, 0.05), 0.009, 8);
  p.rod(m.rail, onWall(SIDE, -0.22, 0.05, 0.05), onWall(SIDE, -0.22, 0.35, 0.05), 0.013);
  // hook-and-loop patches where tools are stuck between uses
  for (const [u, z] of [[0.05, 0.43], [0.2, 0.45], [-0.75, 0.25], [-1.1, 0.08]] as const) p.onWall(m.patch, BACK, [u, u + 0.05], [z, z + 0.035], [0.016, 0.019]);
  for (const [u, z] of [[-0.12, 0.25], [0.3, 0.1]] as const) p.onWall(m.patch, SIDE, [u, u + 0.05], [z, z + 0.035], [0.016, 0.019]);
  // a soft cargo bag strapped to the back-wall rack, left of the arm
  p.onWall(m.bag, BACK, [-0.62, -0.26], [0.03, 0.22], [0.016, 0.09]);
  for (const u of [-0.53, -0.36]) p.onWall(m.strap, BACK, [u, u + 0.03], [0.02, 0.23], [0.016, 0.094]);
  p.onWall(m.strap, BACK, [-0.64, -0.24], [0.11, 0.135], [0.016, 0.094]);
  // a laptop on a bracket on the side wall
  p.rod(m.foot, onWall(SIDE, 0.27, 0.22, 0.016), onWall(SIDE, 0.27, 0.22, 0.06), 0.012, 8);
  p.onWall(m.laptop, SIDE, [0.13, 0.41], [0.12, 0.32], [0.06, 0.075]);
  p.onWall(m.screen, SIDE, [0.145, 0.395], [0.135, 0.305], [0.075, 0.077]);
  const group = p.build();
  const lamp = new THREE.PointLight(0xf1f5ff, 1.2, 0, 2);
  lamp.position.set(0.6, -0.2, 0.95);
  group.add(lamp);
  return { group, background: 0xd3d9de };
}

/**
 * A kitchen: a wooden counter on cream cabinets, a tiled splashback, a spice shelf, a window with a pot of herbs on
 * the sill, a utensil crock and a cutting board in the far corner, wall cupboards above.
 */
function kitchen(): { group: THREE.Group; background: number } {
  const m = {
    wall: mat(0xf0e4cf),
    floor: mat(0xb7a387),
    wood: mat(0xcfa77c, 0.6),
    edge: mat(0xa57c52, 0.6),
    cabinet: mat(0xefe6d4, 0.7),
    carcass: mat(0xcabda5),
    handle: mat(0x16283f, 0.4),
    tile: mat(0xdde6dd, 0.4),
    grout: mat(0xcfc3ad),
    frame: mat(0xfbf6ec, 0.6),
    glass: glow(0xc4dcea, 0.55),
    ink: mat(0x27466d, 0.5),
    accent: mat(0xcf5220, 0.6),
    sun: mat(0xefb340, 0.6),
    plate: mat(0xfaf6ee, 0.4),
    pot: mat(0xb5552b),
    leaf: mat(0x5d8a55),
  };
  const p = new Parts();
  p.shell(m.wall, m.floor);
  // the counter, its top the bench's z = 0
  p.box(m.wood, [BACK_X, FAR_Y, -0.04], [FRONT_X, SIDE_Y, 0]);
  p.box(m.edge, [FRONT_X - 0.004, FAR_Y, -0.042], [FRONT_X + 0.004, SIDE_Y, -0.002]);
  // cabinets under it: a carcass, a row of drawers, doors, a toe kick
  p.box(m.carcass, [BACK_X, FAR_Y, FLOOR_Z + 0.1], [FRONT_X - 0.03, SIDE_Y, -0.04]);
  p.box(m.handle, [BACK_X, FAR_Y, FLOOR_Z], [FRONT_X - 0.09, SIDE_Y, FLOOR_Z + 0.1]);
  const front: Wall = { face: "+x", plane: FRONT_X - 0.03, u: [FAR_Y, SIDE_Y] };
  const cols = lines(FAR_Y, SIDE_Y, 0.5);
  p.doors(m.cabinet, front, cols, [-0.22, -0.045], 0.018, 0.01);
  p.doors(m.cabinet, front, cols, [FLOOR_Z + 0.1, -0.22], 0.018, 0.01);
  for (let i = 0; i + 1 < cols.length; i++) {
    const c = (cols[i] + cols[i + 1]) / 2;
    p.onWall(m.handle, front, [c - 0.07, c + 0.07], [-0.14, -0.125], [0.018, 0.03]);
    p.onWall(m.handle, front, [cols[i + 1] - 0.06, cols[i + 1] - 0.045], [-0.42, -0.3], [0.018, 0.03]);
  }
  // the splashback: square tiles on grout, on both walls up to the shelf
  p.onWall(m.grout, BACK, [FAR_Y, SIDE_Y], [0, 0.4], [0, 0.003]);
  p.doors(m.tile, BACK, lines(FAR_Y, SIDE_Y, 0.1), lines(0, 0.4, 0.1), 0.008, 0.006);
  p.onWall(m.grout, SIDE, [BACK_X, FRONT_X], [0, 0.1], [0, 0.003]);
  p.doors(m.tile, SIDE, lines(BACK_X, FRONT_X, 0.1), [0, 0.1], 0.008, 0.006);
  // a spice shelf above the splashback, with jars
  p.onWall(m.wood, BACK, [-1.3, 0.55], [0.4, 0.42], [0, 0.095]);
  const jars: [number, number, THREE.Material][] = [[-1.2, 0.11, m.ink], [-1.1, 0.08, m.accent], [-1.0, 0.13, m.sun], [-0.88, 0.09, m.ink], [-0.62, 0.12, m.plate], [-0.5, 0.1, m.accent], [0.1, 0.12, m.ink], [0.22, 0.08, m.sun], [0.34, 0.1, m.plate], [0.45, 0.13, m.accent]];
  for (const [u, h, jm] of jars) p.rod(jm, onWall(BACK, u, 0.42, 0.05), onWall(BACK, u, 0.42 + h, 0.05), 0.032, 16);
  // wall cupboards higher up, out of the stage camera's frame until it pulls back
  p.onWall(m.carcass, BACK, [FAR_Y, -0.05], [0.72, TOP_Z], [0, 0.3]);
  p.doors(m.cabinet, { ...BACK, plane: BACK_X + 0.3 }, lines(FAR_Y, -0.05, 0.45), [0.73, TOP_Z - 0.01], 0.015, 0.01);
  // a window on the side wall, a sill and a pot of herbs
  const win = { u: [-0.08, 0.38] as [number, number], z: [0.16, 0.62] as [number, number] };
  p.onWall(m.frame, SIDE, win.u, win.z, [0, 0.02]);
  p.onWall(m.glass, SIDE, [win.u[0] + 0.03, win.u[1] - 0.03], [win.z[0] + 0.03, win.z[1] - 0.03], [0.02, 0.022]);
  p.onWall(m.frame, SIDE, [(win.u[0] + win.u[1]) / 2 - 0.012, (win.u[0] + win.u[1]) / 2 + 0.012], win.z, [0.022, 0.03]);
  p.onWall(m.frame, SIDE, win.u, [(win.z[0] + win.z[1]) / 2 - 0.012, (win.z[0] + win.z[1]) / 2 + 0.012], [0.022, 0.03]);
  p.onWall(m.frame, SIDE, [win.u[0] - 0.03, win.u[1] + 0.03], [win.z[0] - 0.03, win.z[0]], [0, 0.07]);
  p.rod(m.pot, onWall(SIDE, 0.27, win.z[0], 0.04), onWall(SIDE, 0.27, win.z[0] + 0.07, 0.04), 0.035, 16);
  for (const [du, dz, r] of [[0, 0.11, 0.04], [-0.03, 0.09, 0.03], [0.03, 0.095, 0.032], [0.005, 0.14, 0.028]] as const)
    p.ball(m.leaf, onWall(SIDE, 0.27 + du, win.z[0] + dz, 0.04), r);
  // a utensil crock and a cutting board in the far corners of the counter, out of the arm's way
  p.rod(m.ink, [-0.3, 0.545, 0], [-0.3, 0.545, 0.12], 0.04, 16);
  for (const [dx, dy, h] of [[-0.012, 0.01, 0.25], [0.012, -0.008, 0.23], [0, 0.015, 0.21]] as const)
    p.rod(m.edge, [-0.3 + dx, 0.545 + dy, 0.1], [-0.3 + dx * 2, 0.545 + dy * 2, h], 0.006, 6);
  p.box(m.wood, [BACK_X + 0.003, -1.05, 0], [BACK_X + 0.025, -0.7, 0.3]);
  p.ball(m.plate, [BACK_X + 0.012, -0.875, 0.27], 0.012);
  const group = p.build();
  const lamp = new THREE.PointLight(0xffe4c0, 1.4, 0, 2);
  lamp.position.set(0.7, -0.3, 0.95);
  group.add(lamp);
  return { group, background: 0xece2cf };
}

/** A setting, built and ready to add to the stage's scene. */
export class Dressing {
  readonly group: THREE.Group;
  readonly background: THREE.Color;

  constructor(readonly name: SettingName) {
    const built = name === "station" ? station() : kitchen();
    this.group = built.group;
    this.background = new THREE.Color(built.background);
  }

  /** Free the GPU buffers: every material is used by one merged mesh, so each is disposed once. */
  dispose() {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
