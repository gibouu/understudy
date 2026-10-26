/**
 * The checks a program can wait for or assert, read from the live MuJoCo
 * state. Each returns whether it holds and the measured quantity, so a failed
 * rollout says by how much. Targets are found by the sites the scene builder
 * emits: `<name>_pocket` (opening, box half-sizes) and `<name>_pocket_floor`
 * for pockets, `<name>_zone` (top face) for zones; a stack target is the
 * object's top face, from the spec's size. The liquid is measured inside a
 * container's `<name>_inside` site (lib/sim/liquid.ts).
 */
import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import type { Predicate, TaskSpec } from "@/lib/spec/schema";
import { graspIndex, jawsTouch } from "./grasp";
import type { Liquid } from "./liquid";
import { decodeName, toNumbers } from "./names";
import { footprintMm, heightMm, MM, NAME_PREFIX } from "./scene";

export type World = {
  mujoco: MainModule;
  model: MjModel;
  data: MjData;
  spec: TaskSpec;
  /** MJCF body name per object id (SceneBuild.names) */
  names: Record<string, string>;
  /** seconds since the rollout started */
  t: number;
  /** the scene's liquid, if it has any */
  liquid?: Liquid | null;
};
export type Check = { ok: boolean; measured?: number; why: string };

/** Resting on a surface: the object's bottom within this of it. */
const REST_M = 0.003;
/** Contacts in MuJoCo are soft: a footprint may poke this far past a wall it is pressed against. */
const FIT_SLACK_M = 0.0005;
/** Still: slower than these. */
const STILL_M_S = 0.005;
const STILL_RAD_S = 0.1;

export function evaluate(w: World, p: Predicate): Check {
  switch (p.kind) {
    case "contact_both_pads": {
      const ok = jawsTouch(w.mujoco, w.model, w.data, graspIndex(w.mujoco, w.model, body(w, p.object!)));
      return { ok, why: ok ? `both pads on ${p.object}` : `the pads are not both on ${p.object}` };
    }
    case "height_above": {
      const mm = bottom(w, p.object!) / MM;
      return { ok: mm >= p.value!, measured: mm, why: `${p.object}'s bottom ${mm.toFixed(1)} mm above the table, wanted >= ${p.value}` };
    }
    case "inside_zone":
      return insideZone(w, p.object!, p.target!);
    case "no_collision":
      return noCollision(w);
    case "tilt_under": {
      const R = mat(w, bodyId(w, body(w, p.object!)));
      const deg = (Math.acos(Math.max(-1, Math.min(1, R[8]))) * 180) / Math.PI;
      return { ok: deg <= p.value!, measured: deg, why: `${p.object} tilted ${deg.toFixed(1)}°, limit ${p.value}°` };
    }
    case "gripper_within": {
      // the jaw meshes overlap near the hinge, so the aperture is read as each jaw's gap to the object: both ~0 when it fits
      const g = graspIndex(w.mujoco, w.model, body(w, p.object!));
      const gap = (jaw: number[]) => Math.min(...jaw.flatMap((j) => g.objectGeoms.map((o) => w.mujoco.mj_geomDistance(w.model, w.data, j, o, 0.2, null))));
      const err = Math.max(...g.jaws.map((j) => Math.abs(gap(j)))) / MM;
      return { ok: err <= p.value!, measured: err, why: `a jaw is ${err.toFixed(1)} mm off ${p.object}'s surface, limit ${p.value} mm` };
    }
    case "object_still": {
      const [v, omega] = speed(w, p.object!);
      const ok = v < STILL_M_S && omega < STILL_RAD_S;
      return { ok, measured: v / MM, why: `${p.object} moving at ${(v / MM).toFixed(1)} mm/s` };
    }
    case "time_under":
      return { ok: w.t <= p.value!, measured: w.t, why: `${w.t.toFixed(2)} s elapsed, limit ${p.value} s` };
    case "liquid_inside": {
      if (!w.liquid) throw new Error("there is no liquid in the scene");
      const pc = 100 * w.liquid.shareIn(w.data, p.target!, p.object);
      const whose = p.object ? `the liquid from ${p.object}` : "the liquid";
      // a share just short of the threshold keeps its decimal: "95%, wanted >= 95%" would read as a pass
      const shown = pc < p.value! && Math.round(pc) >= p.value! ? pc.toFixed(1) : pc.toFixed(0);
      return { ok: pc >= p.value!, measured: pc, why: `${shown}% of ${whose} is inside ${p.target}, wanted >= ${p.value}%` };
    }
  }
}

/**
 * The object's whole footprint within the target's (axis-aligned with the target; yaw between them is ignored) and
 * resting on its support: the pocket floor, the zone, or the stacked-on object's top.
 */
function insideZone(w: World, objectId: string, targetId: string): Check {
  const name = body(w, targetId);
  const pocket = siteId(w, `${name}_pocket`);
  const zone = pocket >= 0 ? pocket : siteId(w, `${name}_zone`);
  const c = pos(w, bodyId(w, body(w, objectId)));
  let origin: number[], R: number[], half: number[], support: number;
  if (zone >= 0) {
    origin = vec(w.data.site_xpos, zone, 3);
    R = vec(w.data.site_xmat, zone, 9);
    const size = vec(w.model.site_size, zone, 3);
    half = [size[0], size[1]];
    support = pocket >= 0 ? vec(w.data.site_xpos, siteId(w, `${name}_pocket_floor`), 3)[2] : origin[2];
  } else {
    const t = object(w, targetId);
    const id = bodyId(w, name);
    origin = pos(w, id);
    R = mat(w, id);
    half = footprintMm(t).map((x) => (x * MM) / 2);
    support = origin[2] + (heightMm(t) * MM) / 2;
  }
  const d = [c[0] - origin[0], c[1] - origin[1], c[2] - origin[2]];
  const local = [0, 1].map((k) => R[k] * d[0] + R[3 + k] * d[1] + R[6 + k] * d[2]);
  const own = footprintMm(object(w, objectId)).map((x) => (x * MM) / 2);
  const over = [0, 1].every((k) => Math.abs(local[k]) <= half[k] - own[k] + FIT_SLACK_M);
  const gap = bottom(w, objectId) - support;
  const ok = over && Math.abs(gap) <= REST_M;
  const why = !over
    ? `${objectId} is ${(Math.hypot(local[0], local[1]) / MM).toFixed(1)} mm from ${targetId}'s centre, not inside it`
    : `${objectId} is ${(gap / MM).toFixed(1)} mm above ${targetId}'s ${pocket >= 0 ? "floor" : "surface"}`;
  return { ok, measured: gap / MM, why: ok ? `${objectId} rests in ${targetId}` : why };
}

/** No arm geom touches the floor or a scene object, except the jaws on a manipulated object. */
function noCollision(w: World): Check {
  const geomBody = toNumbers(w.model.geom_bodyid);
  const names = toNumbers(w.model.names);
  const bodyAdr = toNumbers(w.model.name_bodyadr);
  const isScene = (b: number) => b === 0 || decodeName(names, bodyAdr[b]).startsWith(NAME_PREFIX);
  const held = w.spec.objects.filter((o) => o.role === "manipulated").map((o) => body(w, o.id));
  const manipulated = new Set(held.map((n) => bodyId(w, n)));
  // the jaws are the same whichever object indexes them
  const jaws = new Set(held.length ? graspIndex(w.mujoco, w.model, held[0]).jaws.flat() : []);
  const contacts = w.data.contact as unknown as { get: (i: number) => { geom1: number; geom2: number } };
  for (let i = 0; i < (w.data.ncon as number); i++) {
    const { geom1, geom2 } = contacts.get(i);
    const [b1, b2] = [geomBody[geom1], geomBody[geom2]];
    if (isScene(b1) === isScene(b2)) continue; // scene on scene, or arm on arm
    const [arm, other] = isScene(b1) ? [geom2, b1] : [geom1, b2];
    if (jaws.has(arm) && manipulated.has(other)) continue;
    return { ok: false, why: `the arm touches ${other === 0 ? "the floor" : decodeName(names, bodyAdr[other])}` };
  }
  return { ok: true, why: "no collision" };
}

function object(w: World, id: string) {
  const o = w.spec.objects.find((x) => x.id === id);
  if (!o) throw new Error(`no object "${id}" in the spec`);
  return o;
}
function body(w: World, id: string) {
  const n = w.names[id];
  if (!n) throw new Error(`no object "${id}" in the scene`);
  return n;
}
function bodyId(w: World, name: string) {
  const i = w.mujoco.mj_name2id(w.model, w.mujoco.mjtObj.mjOBJ_BODY.value, name);
  if (i < 0) throw new Error(`no body ${name}`);
  return i;
}
function siteId(w: World, name: string) {
  return w.mujoco.mj_name2id(w.model, w.mujoco.mjtObj.mjOBJ_SITE.value, name);
}
const vec = (field: unknown, i: number, n: number) => {
  const a = toNumbers(field);
  return Array.from({ length: n }, (_, k) => a[n * i + k]);
};
const pos = (w: World, b: number) => vec(w.data.xpos, b, 3);
const mat = (w: World, b: number) => vec(w.data.xmat, b, 9);
/** Lowest point of an upright object: centre minus half its height (tilt is tilt_under's business). */
const bottom = (w: World, id: string) => pos(w, bodyId(w, body(w, id)))[2] - (heightMm(object(w, id)) * MM) / 2;
/** Linear (m/s) and angular (rad/s) speed of a free body. */
function speed(w: World, id: string): [number, number] {
  const b = bodyId(w, body(w, id));
  const jnt = toNumbers(w.model.body_jntadr)[b];
  if (jnt < 0) return [0, 0]; // a fixture has no joint: it never moves
  const dof = toNumbers(w.model.jnt_dofadr)[jnt];
  const v = vec(w.data.qvel, 0, w.model.nv as number).slice(dof, dof + 6);
  return [Math.hypot(v[0], v[1], v[2]), Math.hypot(v[3], v[4], v[5])];
}
