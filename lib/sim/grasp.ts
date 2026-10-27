/**
 * Geometric grasp: each graspable body has a weld to the gripper, declared
 * off in the MJCF (stageXml). A grasp switches it on holding the object where
 * it is relative to the gripper; release switches it off and physics takes
 * over with whatever velocity the object had. No friction or slip, as
 * docs/LIMITATIONS.md says.
 */
import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import { toNumbers } from "./names";
import { SO101_GRIPPER_BODY, SO101_HELD_SITE, SO101_MOVING_JAW_BODY, graspWeld } from "./so101";

/** A jaw counts as touching within this gap, so a squeeze that stops just short still holds. */
const TOUCH_M = 0.003;
/** The moving jaw has stopped closing below this speed: it is squeezing, so attaching now leaves no push against the weld. */
const SETTLED_RAD_S = 0.05;
/** Simulated seconds a grasp waits for the jaws to close on the object before it fails. */
export const GRASP_TIMEOUT_S = 1.5;
/** mjNEQDATA: weld data is anchor[3], relpose pos[3], relpose quat[4], torquescale. */
const NEQDATA = 11;

export type Grasp = {
  body: string;
  bodyId: number;
  gripper: number;
  eq: number;
  objectGeoms: number[];
  jaws: [number[], number[]];
  /** SO101_HELD_SITE, on the gripper body */
  heldSite: number;
  /** qpos and dof addresses of the moving jaw's hinge */
  jawQpos: number;
  jawDof: number;
};

export function graspIndex(mujoco: MainModule, model: MjModel, body: string): Grasp {
  const id = (type: number, name: string) => {
    const i = mujoco.mj_name2id(model, type, name);
    if (i < 0) throw new Error(`no ${name} in the model`);
    return i;
  };
  const bodyId = id(mujoco.mjtObj.mjOBJ_BODY.value, body);
  const eq = id(mujoco.mjtObj.mjOBJ_EQUALITY.value, graspWeld(body));
  // copies, not views: the name lookups below allocate, which can grow the wasm heap and detach a view
  const geomBody = Array.from(toNumbers(model.geom_bodyid));
  const contype = Array.from(toNumbers(model.geom_contype));
  const conaff = Array.from(toNumbers(model.geom_conaffinity));
  const geomsOf = (b: number) =>
    Array.from({ length: model.ngeom as number }, (_, g) => g).filter((g) => geomBody[g] === b && (contype[g] || conaff[g]));
  const gripper = id(mujoco.mjtObj.mjOBJ_BODY.value, SO101_GRIPPER_BODY);
  const movingJaw = id(mujoco.mjtObj.mjOBJ_BODY.value, SO101_MOVING_JAW_BODY);
  const jawJoint = toNumbers(model.body_jntadr)[movingJaw];
  return {
    body,
    bodyId,
    gripper,
    eq,
    objectGeoms: geomsOf(bodyId),
    jaws: [geomsOf(gripper), geomsOf(movingJaw)],
    heldSite: id(mujoco.mjtObj.mjOBJ_SITE.value, SO101_HELD_SITE),
    jawQpos: toNumbers(model.jnt_qposadr)[jawJoint],
    jawDof: toNumbers(model.jnt_dofadr)[jawJoint],
  };
}

/** Both jaws within TOUCH_M of the object (mj_geomDistance returns TOUCH_M itself when nothing is closer). */
export function jawsTouch(mujoco: MainModule, model: MjModel, data: MjData, g: Grasp): boolean {
  const near = (jaw: number[]) =>
    jaw.some((j) => g.objectGeoms.some((o) => mujoco.mj_geomDistance(model, data, j, o, TOUCH_M, null) < TOUCH_M));
  return near(g.jaws[0]) && near(g.jaws[1]);
}

/** Ready to attach: both jaws on the object and the moving jaw no longer closing. */
export function holding(mujoco: MainModule, model: MjModel, data: MjData, g: Grasp): boolean {
  return Math.abs(toNumbers(data.qvel)[g.jawDof]) < SETTLED_RAD_S && jawsTouch(mujoco, model, data, g);
}

export function isAttached(data: MjData, g: Grasp): boolean {
  return toNumbers(data.eq_active)[g.eq] === 1;
}

/**
 * Weld the object where it is now: relpose = its pose in the gripper's frame
 * (otherwise MuJoCo would use qpos0's), and move SO101_HELD_SITE onto the
 * object's centre. Returns the jaw angle to hold from
 * now on: squeezing on towards closed would push the object against the weld.
 */
export function attach(model: MjModel, data: MjData, g: Grasp): number {
  const xpos = toNumbers(data.xpos);
  const xmat = toNumbers(data.xmat);
  const xquat = toNumbers(data.xquat);
  const p1 = [0, 1, 2].map((k) => xpos[3 * g.gripper + k]);
  const p2 = [0, 1, 2].map((k) => xpos[3 * g.bodyId + k]);
  const R1 = Array.from({ length: 9 }, (_, k) => xmat[9 * g.gripper + k]);
  const d = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
  const rel = [0, 1, 2].map((c) => R1[c] * d[0] + R1[3 + c] * d[1] + R1[6 + c] * d[2]);
  const q1 = [0, 1, 2, 3].map((k) => xquat[4 * g.gripper + k]);
  const q2 = [0, 1, 2, 3].map((k) => xquat[4 * g.bodyId + k]);
  const relq = mulQuat([q1[0], -q1[1], -q1[2], -q1[3]], q2);
  const eqData = model.eq_data as Float64Array;
  const o = NEQDATA * g.eq;
  eqData.set([0, 0, 0, ...rel, ...relq], o);
  (data.eq_active as Uint8Array)[g.eq] = 1;
  (model.site_pos as Float64Array).set(rel, 3 * g.heldSite);
  return toNumbers(data.qpos)[g.jawQpos];
}

export function detach(data: MjData, g: Grasp) {
  (data.eq_active as Uint8Array)[g.eq] = 0;
}

function mulQuat(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
