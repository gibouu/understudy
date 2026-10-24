/**
 * Messages between the main thread and the MuJoCo worker. The worker owns the
 * physics; the main thread only renders what it is told. Requests that expect
 * an answer carry an `id` so errors reach the right caller.
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
  gravity_g: number;
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
  /** simulated seconds the worker had to drop to catch up (tab in the background) */
  dropped_s: number;
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
  | { type: "load"; id: number; mujocoBase: string; assetBase: string; gravityG?: number; demoTube?: boolean }
  | { type: "setGravity"; g: number }
  | { type: "nudge"; body: string; velocity: [number, number, number] }
  | { type: "setCtrl"; ctrl: number[] }
  | { type: "play"; waypoints: Waypoint[]; loop?: boolean }
  | { type: "stop" }
  | { type: "reset" }
  | { type: "jacobian"; id: number; site: string };

export type FromWorker =
  | { type: "status"; message: string; progress?: number }
  | { type: "loaded"; id: number; meta: SimMeta }
  | { type: "frame"; frame: Frame }
  | { type: "jacobian"; id: number; site: string; nv: number; jacp: Float64Array; jacr: Float64Array }
  | { type: "error"; id?: number; message: string };
