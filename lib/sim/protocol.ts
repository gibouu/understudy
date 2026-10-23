/**
 * Messages between the main thread and the MuJoCo worker. The worker owns the
 * physics; the main thread only renders what it is told.
 */

/** mjtGeom values we render. */
export const GEOM_PLANE = 0;
export const GEOM_SPHERE = 2;
export const GEOM_CAPSULE = 3;
export const GEOM_ELLIPSOID = 4;
export const GEOM_CYLINDER = 5;
export const GEOM_BOX = 6;
export const GEOM_MESH = 7;

export type GeomMeta = {
  id: number;
  name: string;
  type: number;
  /** MuJoCo half-sizes, meaning depends on type */
  size: [number, number, number];
  rgba: [number, number, number, number];
  group: number;
  bodyId: number;
  /** mesh id for GEOM_MESH, else -1 */
  meshId: number;
};

export type MeshMeta = {
  id: number;
  name: string;
  /** xyz triples in the geom frame */
  vertices: Float32Array;
  /** vertex index triples */
  faces: Int32Array;
};

export type SimMeta = {
  nq: number;
  nv: number;
  nu: number;
  ngeom: number;
  nsite: number;
  timestep: number;
  joints: { name: string; qposadr: number; range: [number, number] }[];
  actuators: { name: string; ctrlrange: [number, number] }[];
  sites: { name: string; id: number }[];
  bodies: { name: string; id: number }[];
  geoms: GeomMeta[];
  meshes: MeshMeta[];
};

export type Frame = {
  /** simulated seconds since reset */
  t: number;
  qpos: Float64Array;
  ctrl: Float64Array;
  /** ngeom x 3 world positions */
  geomXpos: Float64Array;
  /** ngeom x 9 row-major rotation matrices */
  geomXmat: Float64Array;
  /** nsite x 3 world positions */
  siteXpos: Float64Array;
};

export type Waypoint = { t: number; q: number[] };

export type ToWorker =
  | { type: "load"; mujocoBase: string; assetBase: string }
  | { type: "setCtrl"; ctrl: number[] }
  | { type: "play"; waypoints: Waypoint[]; loop?: boolean }
  | { type: "stop" }
  | { type: "reset" }
  | { type: "jacobian"; site: string };

export type FromWorker =
  | { type: "status"; message: string; progress?: number }
  | { type: "loaded"; meta: SimMeta }
  | { type: "frame"; frame: Frame }
  | { type: "jacobian"; site: string; nv: number; jacp: Float64Array; jacr: Float64Array }
  | { type: "error"; message: string };
