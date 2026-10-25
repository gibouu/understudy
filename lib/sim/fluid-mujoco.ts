/**
 * MuJoCo geoms as walls for the particle liquid (fluid.ts).
 *
 * Each step, after MuJoCo has moved its bodies (mj_step, mj_forward or mj_kinematics),
 * `sync` reads the world pose (geom_xpos, geom_xmat) and size (geom_size) of the bound
 * geoms and hands them to the solver as solids. The solver sweeps each solid from its
 * previous pose to the new one over its substeps, so a cup carried or tilted by the arm
 * pushes and pours the liquid instead of jumping through it.
 *
 * Coupling is ONE-WAY: MuJoCo moves the liquid's walls, but the liquid does not push
 * back on the rigid bodies. A full cup weighs the same as an empty one to the arm, and a
 * floating object is not lifted. That is fine while the liquid is light next to what
 * carries it; it is wrong for buoyancy, for a cup's weight shifting as it pours, and for
 * an object knocked by a splash.
 *
 * TODO(two-way coupling): per bound geom, accumulate the impulse the solid applies to
 * the particles it projects (particleMass * correction / dt^2 along the contact normal,
 * summed over a step), plus a buoyancy term rho0 * submerged volume * -g and a drag
 * term from the relative velocity of nearby particles, and apply the opposite as a
 * wrench in data.xfrc_applied on the geom's body before the next mj_step. Not built yet.
 */
import type { MjData, MjModel } from "@mujoco/mujoco";
import type { Fluid, SolidShape } from "./fluid";
import { toNumbers } from "./names";

const utf8 = new TextDecoder("utf-8");

/**
 * A MuJoCo name: NUL-terminated UTF-8 bytes at `adr` in the model's one name buffer.
 * Decoded as UTF-8 (names.ts's decodeName maps one byte to one character, which turns
 * "café" into "cafÃ©"); bytes may come signed from the binding, hence the mask.
 */
export function decodeUtf8Name(names: ArrayLike<number>, adr: number): string {
  if (adr < 0 || adr >= names.length) return "";
  let end = adr;
  while (end < names.length && names[end] !== 0) end++;
  const bytes = new Uint8Array(end - adr);
  for (let k = adr; k < end; k++) bytes[k - adr] = names[k] & 0xff;
  return utf8.decode(bytes);
}

/** mjtGeom values of the shapes the liquid can collide with. */
export const MJ_GEOM = { plane: 0, sphere: 2, capsule: 3, cylinder: 5, box: 6 } as const;

export interface GeomBoundary {
  name: string;
  /** MuJoCo geom id */
  geom: number;
  /** solid id in the fluid solver */
  solid: number;
  /** mjtGeom */
  type: number;
}

export interface CouplingOptions {
  /** geom names to use as walls */
  geoms?: string[];
  /** use every supported geom of these bodies (a cup built from five boxes, say) */
  bodies?: string[];
  /** Coulomb friction of these walls against the liquid; default the fluid's */
  friction?: number;
  /** normal restitution of these walls; default the fluid's */
  restitution?: number;
}

/** The solver shape for a MuJoCo geom type and its geom_size triple, or null if unsupported (mesh, ellipsoid, height field). */
export function geomShape(type: number, size: ArrayLike<number>, offset = 0): SolidShape | null {
  const s0 = size[offset], s1 = size[offset + 1], s2 = size[offset + 2];
  switch (type) {
    case MJ_GEOM.box:
      return { type: "box", halfSize: [s0, s1, s2] };
    case MJ_GEOM.cylinder:
      return { type: "cylinder", radius: s0, halfLength: s1 };
    case MJ_GEOM.capsule:
      return { type: "capsule", radius: s0, halfLength: s1 };
    case MJ_GEOM.sphere:
      return { type: "sphere", radius: s0 };
    case MJ_GEOM.plane:
      return { type: "plane" }; // MuJoCo planes collide as infinite half-spaces
    default:
      return null;
  }
}

/** Geom ids by name; throws on a name the model does not have. */
export function geomIdsByName(model: MjModel, names: string[]): number[] {
  const buf = toNumbers(model.names);
  const adr = toNumbers(model.name_geomadr);
  const ngeom = model.ngeom as number;
  return names.map((n) => {
    for (let g = 0; g < ngeom; g++) if (decodeUtf8Name(buf, adr[g]) === n) return g;
    throw new Error(`no geom named ${n}`);
  });
}

/** Ids of the supported geoms attached to the named bodies. */
export function geomIdsOfBodies(model: MjModel, bodies: string[]): number[] {
  const buf = toNumbers(model.names);
  const bodyAdr = toNumbers(model.name_bodyadr);
  const nbody = model.nbody as number;
  const ids = bodies.map((n) => {
    for (let b = 0; b < nbody; b++) if (decodeUtf8Name(buf, bodyAdr[b]) === n) return b;
    throw new Error(`no body named ${n}`);
  });
  const geomBody = toNumbers(model.geom_bodyid);
  const type = toNumbers(model.geom_type);
  const size = toNumbers(model.geom_size);
  const out: number[] = [];
  for (let g = 0; g < (model.ngeom as number); g++) if (ids.includes(geomBody[g]) && geomShape(type[g], size, 3 * g)) out.push(g);
  return out;
}

export class MujocoFluidCoupling {
  readonly boundaries: GeomBoundary[] = [];
  private synced = false;

  constructor(
    readonly fluid: Fluid,
    model: MjModel,
    options: CouplingOptions,
  ) {
    const ids = [...geomIdsByName(model, options.geoms ?? []), ...geomIdsOfBodies(model, options.bodies ?? [])];
    const buf = toNumbers(model.names);
    const adr = toNumbers(model.name_geomadr);
    const type = toNumbers(model.geom_type);
    const size = toNumbers(model.geom_size);
    for (const g of new Set(ids)) {
      const shape = geomShape(type[g], size, 3 * g);
      const name = decodeUtf8Name(buf, adr[g]) || `geom${g}`;
      if (!shape) throw new Error(`geom ${name} has type ${type[g]}, which the liquid cannot collide with`);
      const solid = fluid.addSolid({ shape, friction: options.friction, restitution: options.restitution, name });
      this.boundaries.push({ name, geom: g, solid, type: type[g] });
    }
  }

  /**
   * Copy the bound geoms' current world poses and sizes into the solver; call once per
   * fluid.step(), after MuJoCo has updated data. The first call (or `teleport`) places
   * the walls without sweeping them through the liquid.
   */
  sync(model: MjModel, data: MjData, options: { teleport?: boolean } = {}): void {
    const xpos = toNumbers(data.geom_xpos);
    const xmat = toNumbers(data.geom_xmat);
    const size = toNumbers(model.geom_size);
    const teleport = options.teleport || !this.synced;
    for (const b of this.boundaries) {
      const g = b.geom;
      const shape = geomShape(b.type, size, 3 * g);
      if (shape) this.fluid.setSolidShape(b.solid, shape);
      this.fluid.setSolidPose(
        b.solid,
        {
          position: [xpos[3 * g], xpos[3 * g + 1], xpos[3 * g + 2]],
          rotation: [xmat[9 * g], xmat[9 * g + 1], xmat[9 * g + 2], xmat[9 * g + 3], xmat[9 * g + 4], xmat[9 * g + 5], xmat[9 * g + 6], xmat[9 * g + 7], xmat[9 * g + 8]],
        },
        { teleport },
      );
    }
    this.synced = true;
  }
}

/** Bind named geoms (or all supported geoms of named bodies) as walls of the liquid. */
export function bindMujocoGeoms(fluid: Fluid, model: MjModel, options: CouplingOptions): MujocoFluidCoupling {
  return new MujocoFluidCoupling(fluid, model, options);
}
