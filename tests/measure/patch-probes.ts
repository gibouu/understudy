/**
 * Task probes for the self-improvement loop (tests/measure/patch-loop.test.ts).
 *
 * Each probe is a small robot program (a handful of bounded knobs) run in
 * MuJoCo against a world (gravity, a disturbance, a seed). A run returns
 * pass/fail, metrics, and a failure note: what the simulator measured, in the
 * words the Notes stage would get, never the fix. The loop hands the note to
 * a model, which patches the knobs, and the probe runs again.
 *
 *   insert  tube into the demo rack pocket (release height, hold until seated,
 *           approach offset correction, release speed)
 *   place   tube upright onto a zone on the table (release height, release
 *           speed, wait before release)
 *   pour    80 water-density spheres from the source cup into the target cup
 *           (tilt angle, tilt duration, target distance offset, strategy)
 *   carry   a seated tube in its holder, or an open cup of particles, carried
 *           300 mm while the vehicle may accelerate (max acceleration, hold grip)
 *
 * Physics conventions are the harness's (gravity-harness.ts): an accelerating
 * frame is a gravity vector with a lateral component; the gripper is not
 * simulated, so "held" means the object moves with the hand and "release"
 * means the object starts free with the hand-off velocity.
 *
 * Hand-off velocity: a world's `handoff_mm_s` is the object's residual
 * velocity when the fingers open at the nominal hand speed (20 mm/s); it
 * scales with the program's release speed, so slowing down reduces it.
 */
import type { MainModule } from "@mujoco/mujoco";
import { create as createFluid } from "@/lib/sim/fluid";
import { bindMujocoGeoms } from "@/lib/sim/fluid-mujoco";
import {
  CUP,
  cupGeoms,
  cylinderLowestZ,
  DEG,
  freeState,
  GRAVITIES,
  gravityVec,
  lcg,
  particleBodies,
  particleStates,
  PARTICLES,
  pocketState,
  norm,
  sub,
  rackScene,
  SEATED,
  setFreeVel,
  type Sim,
  tiltDeg,
  TUBE,
  tubeBody,
  type Vec3,
  withSim,
  worldXml,
} from "./gravity-harness";

const MM = 0.001;
const G = 9.81;
/**
 * At rest: the object's centre moved less than this many mm over the last
 * second. A net drift, not an instantaneous speed: on MuJoCo's soft contacts a
 * tube seated in the pocket under Earth gravity chatters at 1 to 2 mm/s
 * without going anywhere.
 */
export const REST_MM_S = 1;
/** the hand speed at which a world's hand-off velocity is specified */
export const NOMINAL_SPEED_MM_S = 20;
/** particle scenes use CG, as in gravity.test.ts */
const PARTICLE_OPTION = 'solver="CG"';

export type GravityId = "earth" | "mars" | "moon" | "orbit";
export type ProbeId = "insert" | "place" | "pour" | "carry" | "pour-liquid";

export type World = {
  gravity: GravityId;
  /** vehicle acceleration along +x in Earth g (absolute, not a fraction of local g), a burst from t = 0 */
  frame_g?: number;
  /** burst length in seconds (default 1.5, jittered by the seed) */
  frame_s?: number;
  /** residual velocity of the object when the fingers open at the nominal hand speed, mm/s */
  handoff_mm_s?: number;
  /** insert: where the tube ends up along x from the pocket centre with no correction, mm */
  offset_mm?: number;
  /** pour: the target cup sits this much farther along +x than nominal, mm */
  target_shift_mm?: number;
  /** carry: what is carried */
  object?: "tube" | "cup";
  seed: number;
};

export type KnobSpec =
  | { name: string; kind: "number"; min: number; max: number; unit: string; doc: string }
  | { name: string; kind: "bool"; doc: string }
  | { name: string; kind: "enum"; options: string[]; doc: string };
export type KnobValue = number | boolean | string;
export type Knobs = Record<string, KnobValue>;
export type Metrics = Record<string, number | boolean | string | null>;
export type ProbeResult = {
  pass: boolean;
  /** 1 on a pass; below 1 a coarse progress measure used only to spot patches that make things worse */
  score: number;
  /** analysis label, never shown to the patcher */
  failure_class: string | null;
  metrics: Metrics;
  /** measured facts for the patcher; no advice */
  note: string;
};
/**
 * derived: add one line of arithmetic on the measurements (geometry overlap,
 * timing against the vehicle burst, acceleration over local gravity). Still
 * facts, never the fix; an ablation of how much the note has to spell out.
 */
export type NoteOptions = { derived?: boolean };
export type Probe = {
  id: ProbeId;
  task: string;
  knobs: KnobSpec[];
  /** iteration 0: the human-like default */
  naive: Knobs;
  /** a hand-written program that should pass, used to tell solvable cases from unsolvable ones */
  expert: (w: World) => Knobs;
  run: (mj: MainModule, k: Knobs, w: World, opts?: NoteOptions) => ProbeResult;
};

export const gravityOf = (id: GravityId) => GRAVITIES.find((g) => g.id === id)!;
export const localG = (w: World) => gravityOf(w.gravity).g;

const r1 = (x: number, d = 1) => {
  const s = x.toFixed(d);
  return Number(s) === 0 ? (0).toFixed(d) : s; // no "-0.0"
};
const yes = (b: boolean) => (b ? "yes" : "no");
const num = (k: Knobs, n: string) => Number(k[n]);
const steps = (sim: Sim, seconds: number) => Math.round(seconds / sim.dt);

/** world line for the patcher: what the robot knows about its environment before it runs */
export function describeWorld(w: World): string {
  const G0 = gravityOf(w.gravity);
  return G0.g > 0
    ? `${G0.label.replace(/ [\d.]+ g$/, "")} gravity, ${(G0.g * G).toFixed(2)} m/s² (${G0.g} g) straight down in the work frame`
    : "orbit: free fall, no gravity in the work frame (0 m/s²)";
}

/** the seed's jitter source; independent streams per use */
const rng = (w: World, salt: number) => lcg(w.seed * 7919 + salt * 104729 + 17);

/** hand-off velocity vector (m/s): azimuth uniform, elevation within ±30 deg */
function handoff(w: World, releaseSpeed: number): { v: Vec3; speed_mm_s: number } {
  const speed = ((w.handoff_mm_s ?? 0) * releaseSpeed) / NOMINAL_SPEED_MM_S;
  const r = rng(w, 1);
  const az = (r() + 0.5) * 2 * Math.PI;
  const el = r() * (Math.PI / 3);
  const v: Vec3 = [speed * Math.cos(el) * Math.cos(az) * MM, speed * Math.cos(el) * Math.sin(az) * MM, speed * Math.sin(el) * MM];
  return { v, speed_mm_s: speed };
}

/** vehicle burst: [start, end] in s from the start of the step, and the acceleration in Earth g */
function burst(w: World): { a_g: number; t0: number; t1: number } {
  const a = w.frame_g ?? 0;
  if (!a) return { a_g: 0, t0: 0, t1: 0 };
  const r = rng(w, 2);
  return { a_g: a, t0: 0, t1: (w.frame_s ?? 1.5) + r() * 0.4 };
}
const imuLine = (b: { a_g: number; t0: number; t1: number }) =>
  b.a_g ? `Frame (vehicle) acceleration from the IMU: ${r1(b.a_g * G, 2)} m/s² (${r1(b.a_g, 3)} g) along +x from t = ${r1(b.t0, 2)} s to t = ${r1(b.t1, 2)} s, none afterwards.` : "Frame (vehicle) acceleration from the IMU: none measured.";

// --- patch validation -----------------------------------------------------------
export type PatchCheck = { knobs: Knobs; changed: string[]; clamped: string[]; rejected: string[]; clamps: { name: string; requested: number; applied: number }[] };

/**
 * Apply a model's patch to the knobs: unknown names and unusable values are
 * rejected, numbers are clamped to their bounds, enums matched loosely
 * ("Hold and wait" -> "hold-and-wait"). Never throws.
 */
export function applyPatch(probe: Probe, current: Knobs, patch: unknown): PatchCheck {
  const knobs: Knobs = { ...current };
  const out: PatchCheck = { knobs, changed: [], clamped: [], rejected: [], clamps: [] };
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return out;
  for (const [name, raw] of Object.entries(patch as Record<string, unknown>)) {
    const spec = probe.knobs.find((s) => s.name === name);
    if (!spec) {
      out.rejected.push(name);
      continue;
    }
    let value: KnobValue | null = null;
    if (spec.kind === "number") {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (Number.isFinite(n)) {
        value = Math.min(spec.max, Math.max(spec.min, n));
        if (value !== n) {
          out.clamped.push(name);
          out.clamps.push({ name, requested: n, applied: value });
        }
      }
    } else if (spec.kind === "bool") {
      if (typeof raw === "boolean") value = raw;
      else if (raw === "true" || raw === "false") value = raw === "true";
    } else {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
      if (typeof raw === "string") value = spec.options.find((o) => norm(o) === norm(raw)) ?? null;
    }
    if (value === null) {
      out.rejected.push(name);
      continue;
    }
    if (value !== current[name]) out.changed.push(name);
    knobs[name] = value;
  }
  return out;
}

export function knobLines(probe: Probe, k: Knobs): string {
  return probe.knobs
    .map((s) => {
      const range = s.kind === "number" ? `number, ${s.min} to ${s.max} ${s.unit}` : s.kind === "bool" ? "true or false" : `one of ${s.options.map((o) => `"${o}"`).join(", ")}`;
      return `- ${s.name} = ${JSON.stringify(k[s.name])} (${range}): ${s.doc}`;
    })
    .join("\n");
}

// --- insert ---------------------------------------------------------------------
const INSERT_T = 4;
const insert: Probe = {
  id: "insert",
  task: `Insert a 17 x 100 mm tube (held upright in the gripper above the rack) into the rack's pocket: a 20 x 20 mm opening, 32 mm deep. Success, checked ${INSERT_T} s after the gripper opens: the tube's lowest point within ${SEATED.floor_mm} mm of the pocket floor, its axis within ${SEATED.tilt_deg} deg of vertical, and at rest (its centre moved less than ${REST_MM_S} mm over the last second).`,
  knobs: [
    { name: "release_height_mm", kind: "number", min: 0, max: 40, unit: "mm", doc: "height of the tube's bottom above the pocket floor when the gripper opens (32 = level with the rack top)" },
    { name: "hold_until_seated", kind: "bool", doc: "true: keep holding while lowering the tube to the pocket floor and open the gripper there (release_height_mm is then ignored)" },
    { name: "offset_correction_mm", kind: "number", min: -10, max: 10, unit: "mm", doc: "added to the approach target's x coordinate; the tube's x at release moves by this amount" },
    { name: "release_speed_mm_s", kind: "number", min: 0.5, max: 50, unit: "mm/s", doc: "hand speed over the last 10 mm of the approach and while the fingers open" },
  ],
  naive: { release_height_mm: 30, hold_until_seated: false, offset_correction_mm: 0, release_speed_mm_s: NOMINAL_SPEED_MM_S },
  expert: (w) => ({ release_height_mm: 0, hold_until_seated: true, offset_correction_mm: -(w.offset_mm ?? 0), release_speed_mm_s: 0.5 }),
  run(mj, k, w, opts = {}) {
    const g = localG(w);
    const r = rng(w, 3);
    const offset = (w.offset_mm ?? 0) + r() * 0.4;
    const residual = offset + num(k, "offset_correction_mm");
    const probeScene = rackScene(0);
    const depth = probeScene.depth_mm;
    const freePlay = (probeScene.inner_mm[0] - 2 * TUBE.radius_m * 1000) / 2;
    const clear = Math.abs(residual) <= freePlay;
    const hold = Boolean(k.hold_until_seated);
    const commanded = hold ? 0 : num(k, "release_height_mm");
    const blocked = commanded < depth && !clear;
    const h = (blocked ? depth : commanded) + 0.05;
    const speed = num(k, "release_speed_mm_s");
    const ho = handoff(w, speed);
    const b = burst(w);
    const scene = rackScene(h, residual);
    const approach_mm = hold ? 10 + Math.max(0, depth - h) : 10;
    const cycle_s = 1 + approach_mm / speed;
    return withSim(mj, worldXml(scene.worldbody, gravityVec(g, b.a_g)), (sim) => {
      const floorZ = sim.sitePos(scene.pocketFloorSite)[2];
      const adr = sim.free(scene.tube);
      setFreeVel(sim, adr, ho.v);
      let maxTilt = 0;
      let maxLowest = -Infinity;
      let before: Vec3 = [0, 0, 0];
      const nI = steps(sim, INSERT_T);
      for (let i = 1; i <= nI; i++) {
        if (i === nI - steps(sim, 1)) before = freeState(sim, adr).pos;
        const t = i * sim.dt;
        sim.setGravity(gravityVec(g, t >= b.t0 && t < b.t1 ? b.a_g : 0));
        sim.step();
        const s = freeState(sim, adr);
        maxTilt = Math.max(maxTilt, tiltDeg(s.quat));
        maxLowest = Math.max(maxLowest, (cylinderLowestZ(s, TUBE.radius_m, TUBE.half_m) - floorZ) / MM);
      }
      const s = freeState(sim, adr);
      const p = pocketState(s, floorZ, scene.pocket_xy_m, scene.inner_mm);
      const dy = (s.pos[1] - scene.pocket_xy_m[1]) / MM;
      const spd = norm(sub(s.pos, before)) / MM;
      const rest = spd < REST_MM_S;
      const pass = p.seated && rest;
      const inPlan = Math.abs(p.dx_mm) < scene.inner_mm[0] / 2 + 1 && Math.abs(dy) < scene.inner_mm[1] / 2 + 1;
      const overRack = Math.abs(p.dx_mm) < 30 && Math.abs(dy) < 30;
      const onRim = !p.in_pocket && overRack && Math.abs(p.lowest_above_floor_mm - depth) < 1.5;
      const where = pass
        ? "seated and at rest"
        : p.seated
          ? "seated but still moving"
          : p.in_pocket
            ? `inside the pocket, axis tilted ${r1(p.tilt_deg)} deg`
            : onRim
              ? "standing on the rack top beside the pocket opening"
              : inPlan && p.lowest_above_floor_mm < depth
                ? "inside the pocket opening, above the pocket floor"
                : overRack && p.lowest_above_floor_mm > depth
                  ? "above the rack"
                  : "off the rack";
      const failure_class = pass
        ? null
        : blocked
          ? "offset: stopped on the rim"
          : g === 0 && !p.in_pocket
            ? hold || h < 2
              ? "0 g: drifted out after release"
              : "0 g: released above the floor, floats"
            : !rest
              ? "still moving"
              : p.in_pocket
                ? "in the pocket, tilted"
                : "other";
      const score = pass ? 1 : p.in_pocket ? 0.6 : Math.max(0, 0.4 * (1 - Math.min(1, p.lowest_above_floor_mm / 40)));
      const metrics: Metrics = {
        release_above_floor_mm: h,
        release_dx_mm: residual,
        descent_stopped_on_rim: blocked,
        handoff_mm_s: ho.speed_mm_s,
        lowest_above_floor_mm: p.lowest_above_floor_mm,
        max_lowest_above_floor_mm: maxLowest,
        tilt_deg: p.tilt_deg,
        max_tilt_deg: maxTilt,
        dx_mm: p.dx_mm,
        dy_mm: dy,
        drift_last_s_mm: spd,
        in_pocket: p.in_pocket,
        seated: p.seated,
        at_rest: rest,
        cycle_s,
      };
      const v = ho.v.map((x) => x / MM);
      const note = [
        `Release: the gripper opened with the tube's bottom ${r1(h)} mm above the pocket floor${blocked ? " (the descent stopped there: the tube's bottom touched the rack top)" : ""}, the tube's axis ${r1(residual)} mm from the pocket centre along x and 0.0 mm along y; tube velocity just after opening ${r1(ho.speed_mm_s, 2)} mm/s (x ${r1(v[0], 2)}, y ${r1(v[1], 2)}, z ${r1(v[2], 2)}).`,
        imuLine(b),
        `During the ${INSERT_T} s after release: highest point of the tube's bottom ${r1(maxLowest)} mm above the pocket floor, maximum tilt ${r1(maxTilt)} deg.`,
        `End (${INSERT_T} s after release): tube's bottom ${r1(p.lowest_above_floor_mm)} mm above the pocket floor, axis tilted ${r1(p.tilt_deg)} deg, axis ${r1(p.dx_mm)} mm (x) and ${r1(dy)} mm (y) from the pocket centre; its centre moved ${r1(spd, 2)} mm over the last second: ${where}.`,
        `Checks: bottom within ${SEATED.floor_mm} mm of the pocket floor ${yes(p.lowest_above_floor_mm < SEATED.floor_mm && p.in_pocket)}; tilt within ${SEATED.tilt_deg} deg ${yes(p.tilt_deg <= SEATED.tilt_deg)}; at rest (moved under ${REST_MM_S} mm in the last second) ${yes(rest)}.`,
        `Cycle time ${r1(cycle_s)} s.`,
        ...(opts.derived ? [insertDerived(residual, scene.inner_mm[0])] : []),
      ].join("\n");
      return { pass, score, failure_class, metrics, note };
    });
  },
};

function insertDerived(residual: number, inner: number): string {
  const r = TUBE.radius_m / MM;
  const overlap = Math.abs(residual) + r - inner / 2;
  return `Derived: at release the tube's bottom (${r1(2 * r, 0)} mm across) spanned x = ${r1(residual - r)} to ${r1(residual + r)} mm from the pocket centre; the opening spans x = ${r1(-inner / 2)} to ${r1(inner / 2)} mm${overlap > 0 ? `, so the bottom overlapped the rack top by ${r1(overlap)} mm` : `, so it cleared the opening by ${r1(-overlap)} mm`}.`;
}

// --- place ----------------------------------------------------------------------
const PLACE_T = 4;
const ZONE_R_MM = 10;
const place: Probe = {
  id: "place",
  task: `Place a 17 x 100 mm tube, held upright in the gripper above a marked zone on the table, standing upright on the zone (a 10 mm radius circle around the zone centre). Success, checked ${PLACE_T} s after the gripper opens: axis within 5 deg of vertical, the tube's bottom within 1 mm of the table, its centre within ${ZONE_R_MM} mm of the zone centre, at rest (its centre moved less than ${REST_MM_S} mm over the last second). t = 0 is when the hand arrives above the zone.`,
  knobs: [
    { name: "release_height_mm", kind: "number", min: 0, max: 50, unit: "mm", doc: "height of the tube's bottom above the table when the gripper opens" },
    { name: "release_speed_mm_s", kind: "number", min: 0.5, max: 50, unit: "mm/s", doc: "hand speed over the last 10 mm of the approach and while the fingers open" },
    { name: "wait_before_release_s", kind: "number", min: 0, max: 5, unit: "s", doc: "time the hand holds the tube still at the release height before opening" },
  ],
  naive: { release_height_mm: 10, release_speed_mm_s: NOMINAL_SPEED_MM_S, wait_before_release_s: 0 },
  expert: () => ({ release_height_mm: 0, release_speed_mm_s: 0.5, wait_before_release_s: 2.5 }),
  run(mj, k, w, opts = {}) {
    const g = localG(w);
    const h = num(k, "release_height_mm") + 0.05;
    const speed = num(k, "release_speed_mm_s");
    const wait = num(k, "wait_before_release_s");
    const ho = handoff(w, speed);
    const b = burst(w);
    const cycle_s = 1 + 10 / speed + wait;
    return withSim(mj, worldXml(tubeBody("tube", [0, 0, TUBE.half_m + h * MM]), gravityVec(g)), (sim) => {
      const adr = sim.free("tube");
      setFreeVel(sim, adr, ho.v);
      let maxTilt = 0;
      let toppleAt: number | null = null;
      let touchAt: number | null = null;
      let before: Vec3 = [0, 0, 0];
      const nP = steps(sim, PLACE_T);
      for (let i = 1; i <= nP; i++) {
        if (i === nP - steps(sim, 1)) before = freeState(sim, adr).pos;
        const t = wait + i * sim.dt; // time since the hand arrived
        sim.setGravity(gravityVec(g, t >= b.t0 && t < b.t1 ? b.a_g : 0));
        sim.step();
        const s = freeState(sim, adr);
        const tilt = tiltDeg(s.quat);
        maxTilt = Math.max(maxTilt, tilt);
        if (toppleAt === null && tilt > 45) toppleAt = t;
        if (touchAt === null && cylinderLowestZ(s, TUBE.radius_m, TUBE.half_m) / MM < 0.5) touchAt = t;
      }
      const s = freeState(sim, adr);
      const tilt = tiltDeg(s.quat);
      const lowest = cylinderLowestZ(s, TUBE.radius_m, TUBE.half_m) / MM;
      const dist = Math.hypot(s.pos[0], s.pos[1]) / MM;
      const spd = norm(sub(s.pos, before)) / MM;
      const upright = tilt <= 5;
      const touching = lowest < 1;
      const inZone = dist <= ZONE_R_MM;
      const rest = spd < REST_MM_S;
      const pass = upright && touching && inZone && rest;
      const failure_class = pass
        ? null
        : !upright
          ? "toppled"
          : !touching
            ? g === 0
              ? "0 g: not touching, floats"
              : "not touching"
            : !inZone
              ? "slid out of the zone"
              : "still moving";
      const score = pass ? 1 : !upright ? 0 : touching ? 0.6 : 0.3;
      const metrics: Metrics = {
        release_above_table_mm: h,
        release_t_s: wait,
        handoff_mm_s: ho.speed_mm_s,
        frame_accel_g: b.a_g,
        frame_burst_end_s: b.a_g ? b.t1 : null,
        lowest_above_table_mm: lowest,
        tilt_deg: tilt,
        max_tilt_deg: maxTilt,
        topple_t_s: toppleAt,
        first_touch_t_s: touchAt,
        dist_from_zone_centre_mm: dist,
        drift_last_s_mm: spd,
        upright,
        touching,
        in_zone: inZone,
        at_rest: rest,
        cycle_s,
      };
      const v = ho.v.map((x) => x / MM);
      const note = [
        `Release: the gripper opened at t = ${r1(wait, 2)} s with the tube upright, its bottom ${r1(h)} mm above the table, centred on the zone; tube velocity just after opening ${r1(ho.speed_mm_s, 2)} mm/s (x ${r1(v[0], 2)}, y ${r1(v[1], 2)}, z ${r1(v[2], 2)}).`,
        imuLine(b),
        `During the ${PLACE_T} s after release: maximum tilt ${r1(maxTilt)} deg${toppleAt !== null ? `, tilt passed 45 deg at t = ${r1(toppleAt, 2)} s` : ""}; ${touchAt !== null ? `first contact with the table at t = ${r1(touchAt, 2)} s` : "the tube never touched the table"}.`,
        `End (t = ${r1(wait + PLACE_T, 2)} s): tube's bottom ${r1(lowest)} mm above the table, axis tilted ${r1(tilt)} deg, centre ${r1(dist)} mm from the zone centre; its centre moved ${r1(spd, 2)} mm over the last second.`,
        `Checks: upright within 5 deg ${yes(upright)}; bottom within 1 mm of the table ${yes(touching)}; inside the zone ${yes(inZone)}; at rest ${yes(rest)}.`,
        `Cycle time ${r1(cycle_s)} s.`,
        ...(opts.derived && b.a_g
          ? [
              `Derived: the gripper opened ${r1(Math.abs(b.t1 - wait), 2)} s ${wait < b.t1 ? "before" : "after"} the vehicle acceleration ended; that acceleration was ${g > 0 ? `${r1(b.a_g / g, 2)} times the local gravity` : "the only acceleration acting (local gravity is 0)"}.`,
            ]
          : []),
      ].join("\n");
      return { pass, score, failure_class, metrics, note };
    });
  },
};

// --- pour -----------------------------------------------------------------------
const W = CUP.wall_m;
const IN = CUP.inner_half_m;
const H = CUP.height_m;
const SRC_RIM = 0.1;
const PIVOT: Vec3 = [IN + W, 0, SRC_RIM];
const TGT = { x: 0.08, inner_half: 0.03, rim: 0.04, wall: 0.01 };
const POUR_HOLD_S = 0.5;
const WAIT_TIMEOUT_S = 8;
const COUNT_AFTER_S = 1;
const POUR_PASS = Math.ceil(0.9 * PARTICLES.count);
const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : (1 - Math.cos(Math.PI * u)) / 2);
const easeRate = (u: number) => (u <= 0 || u >= 1 ? 0 : (Math.PI / 2) * Math.sin(Math.PI * u));

const pour: Probe = {
  id: "pour",
  task: `Pour the contents of the source cup (80 water-density beads standing in for a liquid, in a 40 x 40 x 50 mm open cup whose rim is 100 mm above the table) into the target cup (60 x 60 mm opening, rim 40 mm above the table, its centre nominally 56 mm beyond the source cup's pour lip along +x). The pour tilts the source cup about its lip toward +x. Success, counted ${COUNT_AFTER_S} s after the source cup is back upright: at least ${POUR_PASS} of 80 beads inside the target cup. If the task cannot be done by this robot in this world, the program may report it infeasible instead; that report is correct only when no program could pour here.`,
  knobs: [
    { name: "tilt_deg", kind: "number", min: 30, max: 180, unit: "deg", doc: "how far the source cup turns about its lip (90 = on its side)" },
    { name: "tilt_s", kind: "number", min: 0.2, max: 6, unit: "s", doc: "duration of the tilt (smooth start and stop); the return to upright takes the same time" },
    { name: "target_offset_mm", kind: "number", min: -40, max: 40, unit: "mm", doc: "moves the pour position (the source cup and its lip) along +x before tilting" },
    {
      name: "strategy",
      kind: "enum",
      options: ["pour", "hold-and-wait", "report-infeasible"],
      doc: `pour: tilt, hold ${POUR_HOLD_S} s, return upright; hold-and-wait: tilt, then hold until the source cup is empty or no bead has left it for 1 s (at most ${WAIT_TIMEOUT_S} s), then return upright; report-infeasible: do not move and report the task infeasible`,
    },
  ],
  naive: { tilt_deg: 90, tilt_s: 1, target_offset_mm: 0, strategy: "pour" },
  expert: (w) => (localG(w) > 0 ? { tilt_deg: 135, tilt_s: 2, target_offset_mm: w.target_shift_mm ?? 0, strategy: "hold-and-wait" } : { tilt_deg: 90, tilt_s: 1, target_offset_mm: 0, strategy: "report-infeasible" }),
  run(mj, k, w, opts = {}) {
    const g = localG(w);
    const strategy = String(k.strategy);
    const tgtLipDist = (TGT.x - PIVOT[0]) / MM + (w.target_shift_mm ?? 0) - num(k, "target_offset_mm");
    const opening = [tgtLipDist - TGT.inner_half / MM, tgtLipDist + TGT.inner_half / MM];
    if (strategy === "report-infeasible") {
      const pass = g === 0;
      const metrics: Metrics = { strategy, reported_infeasible: true, in_target: 0, in_source: PARTICLES.count, out: 0 };
      const note = `The program reported the task infeasible and did not move. Count: 0 of 80 beads in the target cup, 80 in the source cup.`;
      return { pass, score: pass ? 1 : 0, failure_class: pass ? null : "reported infeasible where a pour works", metrics, note };
    }
    const A = num(k, "tilt_deg") / DEG;
    const ts = num(k, "tilt_s");
    const tgtX = PIVOT[0] + tgtLipDist * MM;
    const source = `<body name="src" pos="${PIVOT.join(" ")}">
      <joint name="tilt" type="hinge" axis="0 1 0" armature="100"/>
      ${cupGeoms("src", [IN, IN], H, W, "lip")}
    </body>`;
    const target = `<body name="tgt" pos="${tgtX} 0 ${TGT.wall}">
      ${cupGeoms("tgt", [TGT.inner_half, TGT.inner_half], TGT.rim - TGT.wall, TGT.wall, "floor")}
    </body>`;
    const particles = particleBodies([0, 0, SRC_RIM - H], {}, w.seed);
    return withSim(mj, worldXml(`${source}\n${target}\n${particles.xml}`, gravityVec(g), { option: PARTICLE_OPTION }), (sim) => {
      const hinge = sim.joint("tilt");
      const adrs = particles.names.map((n) => sim.free(n));
      const qpos = sim.data.qpos as Float64Array;
      const qvel = sim.data.qvel as Float64Array;
      const where = (pos: Vec3[]) => {
        const th = qpos[hinge.q];
        const c = Math.cos(th);
        const s = Math.sin(th);
        return pos.map(([x, y, z]) => {
          const px = x - PIVOT[0];
          const pz = z - PIVOT[2];
          const lx = c * px - s * pz;
          const lz = s * px + c * pz;
          if (Math.abs(lx + IN + W) < IN && Math.abs(y) < IN && lz > -H && lz < 0) return "source" as const;
          if (Math.abs(x - tgtX) < TGT.inner_half && Math.abs(y) < TGT.inner_half && z < TGT.rim + 0.01) return "target" as const;
          return "out" as const;
        });
      };
      const drive = (th: number, rate: number) => {
        qpos[hinge.q] = th;
        qvel[hinge.d] = rate;
      };
      for (let i = 0; i < steps(sim, 1); i++) {
        drive(0, 0);
        sim.step();
      }
      // phases: tilt [0, ts], hold [ts, tHoldEnd], return [tHoldEnd, tHoldEnd + ts], then still for COUNT_AFTER_S
      let tHoldEnd = strategy === "pour" ? ts + POUR_HOLD_S : Infinity;
      let waitEnded: string | null = null;
      let tFirstLeft: number | null = null;
      let tLastLeft = 0;
      let leftByReturn: number | null = null;
      const left = new Array<boolean>(adrs.length).fill(false);
      /** where each bead first touched the table outside both cups (x from the lip, mm) */
      const landX = new Array<number | null>(adrs.length).fill(null);
      const tableZ = PARTICLES.radius_m + 0.002;
      let t = 0;
      let tEnd = Infinity;
      while (t < tEnd - sim.dt / 2) {
        let th: number;
        let rate: number;
        if (t < ts) {
          th = A * ease(t / ts);
          rate = (A / ts) * easeRate(t / ts);
        } else if (t < tHoldEnd) {
          th = A;
          rate = 0;
        } else {
          const u = (t - tHoldEnd) / ts;
          th = A * (1 - ease(u));
          rate = -(A / ts) * easeRate(u);
        }
        drive(th, rate);
        sim.step();
        t += sim.dt;
        if (Math.round(t / sim.dt) % 5 !== 0) continue;
        const st = particleStates(sim, adrs);
        const wh = where(st.pos);
        let inSource = 0;
        wh.forEach((x, i) => {
          if (x === "source") inSource++;
          else if (!left[i]) {
            left[i] = true;
            tLastLeft = t;
            tFirstLeft ??= t;
          }
          const p = st.pos[i];
          if (landX[i] === null && x === "out" && p[2] < tableZ) landX[i] = (p[0] - PIVOT[0]) / MM;
        });
        if (tHoldEnd === Infinity && t >= ts) {
          if (inSource === 0) {
            tHoldEnd = t;
            waitEnded = "the source cup was empty";
          } else if (t >= ts + 1 && t - tLastLeft >= 1) {
            tHoldEnd = t;
            waitEnded = "no bead had left the source cup for 1 s";
          } else if (t >= ts + WAIT_TIMEOUT_S) {
            tHoldEnd = t;
            waitEnded = `timeout (${WAIT_TIMEOUT_S} s)`;
          }
        }
        if (leftByReturn === null && t >= tHoldEnd) {
          leftByReturn = adrs.length - inSource;
          tEnd = tHoldEnd + ts + COUNT_AFTER_S;
        }
      }
      const st = particleStates(sim, adrs);
      const wh = where(st.pos);
      const inTarget = wh.filter((x) => x === "target").length;
      const inSource = wh.filter((x) => x === "source").length;
      const out = wh.filter((x) => x === "out").length;
      const moving = st.speed.filter((v) => v / MM > 5).length;
      const landed = landX.filter((x, i): x is number => x !== null && wh[i] === "out");
      const airborne = st.pos.filter((p, i) => wh[i] === "out" && landX[i] === null);
      const pass = inTarget >= POUR_PASS;
      const failure_class = pass ? null : g === 0 ? "0 g: nothing flows" : inSource > PARTICLES.count - POUR_PASS ? "beads left in the source" : "beads outside both cups";
      const metrics: Metrics = {
        strategy,
        tilt_deg: num(k, "tilt_deg"),
        tilt_s: ts,
        target_opening_from_lip_mm: `${r1(opening[0])}..${r1(opening[1])}`,
        hold_end_s: tHoldEnd,
        wait_ended: waitEnded,
        first_left_s: tFirstLeft,
        left_by_return: leftByReturn,
        count_t_s: t,
        in_target: inTarget,
        in_source: inSource,
        out,
        moving_faster_than_5_mm_s: moving,
        landed_x_min_mm: landed.length ? Math.min(...landed) : null,
        landed_x_max_mm: landed.length ? Math.max(...landed) : null,
        airborne: airborne.length,
      };
      const program =
        strategy === "pour"
          ? `strategy pour: tilted ${r1(num(k, "tilt_deg"), 0)} deg over ${r1(ts, 2)} s, held ${POUR_HOLD_S} s, returned upright over ${r1(ts, 2)} s`
          : `strategy hold-and-wait: tilted ${r1(num(k, "tilt_deg"), 0)} deg over ${r1(ts, 2)} s, held until t = ${r1(tHoldEnd, 2)} s (${waitEnded}), returned upright over ${r1(ts, 2)} s`;
      const outLines = [
        landed.length ? `${landed.length} beads outside both cups first touched the table at x = ${r1(Math.min(...landed), 0)} to ${r1(Math.max(...landed), 0)} mm from the pour lip (median ${r1(landed.sort((p, q) => p - q)[Math.floor(landed.length / 2)], 0)} mm).` : "",
        airborne.length ? `${airborne.length} beads outside both cups never touched the table; at the count they are ${r1(Math.min(...airborne.map((p) => p[2])) / MM, 0)} to ${r1(Math.max(...airborne.map((p) => p[2])) / MM, 0)} mm above it.` : "",
      ].filter(Boolean);
      const note = [
        `Program: ${program}; the target cup's opening spans x = ${r1(opening[0], 0)} to ${r1(opening[1], 0)} mm from the pour lip. Counted at t = ${r1(t, 2)} s (t = 0 at the start of the tilt).`,
        `Flow: ${tFirstLeft === null ? "no bead left the source cup" : `the first bead left the source cup at t = ${r1(tFirstLeft, 2)} s, the last at t = ${r1(tLastLeft, 2)} s`}; ${leftByReturn ?? 0} of 80 had left it when the return to upright began.`,
        `Count: ${inTarget} of 80 beads in the target cup, ${inSource} still in the source cup, ${out} outside both; ${moving} of 80 still faster than 5 mm/s.`,
        ...(outLines.length ? outLines : ["No bead is outside both cups."]),
        ...(opts.derived && landed.length
          ? [
              (() => {
                const med = landed.sort((p, q) => p - q)[Math.floor(landed.length / 2)];
                return `Derived: the median landing point is ${med < opening[0] ? `${r1(opening[0] - med, 0)} mm short of the target opening's near edge` : med > opening[1] ? `${r1(med - opening[1], 0)} mm beyond the target opening's far edge` : "within the span of the target opening"}.`;
              })(),
            ]
          : []),
      ].join("\n");
      return { pass, score: pass ? 1 : (0.9 * inTarget) / PARTICLES.count, failure_class, metrics, note };
    });
  },
};

// --- pour with a liquid ----------------------------------------------------------------
/**
 * The pour probe with a position-based liquid (lib/sim/fluid.ts) instead of beads:
 * the same cups, knobs, strategies and success check (90% of the liquid in the target
 * cup), the cups one-way coupled through lib/sim/fluid-mujoco.ts. 4 mm particles fill
 * the source cup 24 mm deep: 600 particles, 38 mL. Fewer than the 1,000 one could
 * afford for a single run, so that a loop of up to six rollouts stays near a minute.
 * The table is the solver's bounds floor; the bounds also stop a thrown blob 0.3 m away.
 */
export const LIQUID = { spacing_m: 0.004, fill_m: 0.024, fps: 60, settle_s: 0.5 };
/** the liquid must still be in the target cup this long after the count */
const LIQUID_HOLD_S = 2;
const pourLiquid: Probe = {
  id: "pour-liquid",
  task: `Pour the water in the source cup (38 mL, 24 mm deep in a 40 x 40 x 50 mm open cup whose rim is 100 mm above the table) into the target cup (60 x 60 mm opening, rim 40 mm above the table, its centre nominally 56 mm beyond the source cup's pour lip along +x). The pour tilts the source cup about its lip toward +x. Success, counted ${COUNT_AFTER_S} s after the source cup is back upright and again ${LIQUID_HOLD_S} s later: at least 90% of the water inside the target cup both times. If the task cannot be done by this robot in this world, the program may report it infeasible instead; that report is correct only when no program could pour here.`,
  knobs: pour.knobs,
  naive: pour.naive,
  /**
   * Unlike the beads, the liquid can be thrown at 0 g: inverting the cup over 1 s lands the
   * blob in the target cup and it stays there (wetting, no rebound). Found by a 96-program
   * search in orbit; so in orbit the expert throws, and reporting infeasible is wrong here.
   */
  expert: (w) => (localG(w) > 0 ? pour.expert(w) : { tilt_deg: 180, tilt_s: 1, target_offset_mm: w.target_shift_mm ?? 0, strategy: "hold-and-wait" }),
  run(mj, k, w) {
    const g = localG(w);
    const strategy = String(k.strategy);
    const tgtLipDist = (TGT.x - PIVOT[0]) / MM + (w.target_shift_mm ?? 0) - num(k, "target_offset_mm");
    const opening = [tgtLipDist - TGT.inner_half / MM, tgtLipDist + TGT.inner_half / MM];
    if (strategy === "report-infeasible") {
      // a passing program exists in every liquid case, orbit included (see expert)
      const metrics: Metrics = { strategy, reported_infeasible: true, in_target_pct: 0, in_source_pct: 100, out_pct: 0 };
      const note = `The program reported the task infeasible and did not move. Count: 0% of the water in the target cup, 100% in the source cup.`;
      return { pass: false, score: 0, failure_class: "reported infeasible where a pour works", metrics, note };
    }
    const A = num(k, "tilt_deg") / DEG;
    const ts = num(k, "tilt_s");
    const tgtX = PIVOT[0] + tgtLipDist * MM;
    const xml = worldXml(
      `<body name="src" pos="${PIVOT.join(" ")}">
      <joint name="tilt" type="hinge" axis="0 1 0"/>
      ${cupGeoms("src", [IN, IN], H, W, "lip")}
    </body>
    <body name="tgt" pos="${tgtX} 0 ${TGT.wall}">
      ${cupGeoms("tgt", [TGT.inner_half, TGT.inner_half], TGT.rim - TGT.wall, TGT.wall, "floor")}
    </body>`,
      gravityVec(g),
    );
    return withSim(mj, xml, (sim) => {
      const hinge = sim.joint("tilt");
      const qpos = sim.data.qpos as Float64Array;
      const d = LIQUID.spacing_m;
      const f = createFluid({ spacing: d, gravity: gravityVec(g), seed: w.seed, bounds: { min: [-0.3, -0.3, 0], max: [0.5, 0.3, 0.4] } });
      const coupling = bindMujocoGeoms(f, sim.model, { bodies: ["src", "tgt"] });
      const pose = (th: number) => {
        qpos[hinge.q] = th;
        sim.mj.mj_forward(sim.model, sim.data);
        coupling.sync(sim.model, sim.data);
      };
      pose(0);
      const floorZ = SRC_RIM - H;
      f.addBlock({ min: [-IN, -IN, floorZ], max: [IN, IN, floorZ + LIQUID.fill_m] }, d, { jitter: 0.05 });
      f.relax(10);
      const n = f.count;
      const dt = 1 / LIQUID.fps;
      for (let i = 0; i < Math.round(LIQUID.settle_s * LIQUID.fps); i++) f.step(dt);
      const where = (th: number) => {
        const c = Math.cos(th);
        const sn = Math.sin(th);
        const x = f.positions;
        const out: ("source" | "target" | "out")[] = new Array(n);
        for (let i = 0; i < n; i++) {
          const px = x[3 * i] - PIVOT[0];
          const py = x[3 * i + 1];
          const pz = x[3 * i + 2] - PIVOT[2];
          const lx = c * px - sn * pz;
          const lz = sn * px + c * pz;
          out[i] =
            Math.abs(lx + IN + W) < IN && Math.abs(py) < IN && lz > -H && lz < 0
              ? "source"
              : Math.abs(x[3 * i] - tgtX) < TGT.inner_half && Math.abs(py) < TGT.inner_half && x[3 * i + 2] < TGT.rim + 0.01
                ? "target"
                : "out";
        }
        return out;
      };
      let tHoldEnd = strategy === "pour" ? ts + POUR_HOLD_S : Infinity;
      let waitEnded: string | null = null;
      let tFirstLeft: number | null = null;
      let tLastLeft = 0;
      let leftByReturn: number | null = null;
      const left = new Array<boolean>(n).fill(false);
      const landX = new Array<number | null>(n).fill(null);
      const tableZ = d / 2 + 0.002;
      let t = 0;
      let tEnd = Infinity;
      let th = 0;
      while (t < tEnd - dt / 2) {
        const tn = t + dt;
        th = tn < ts ? A * ease(tn / ts) : tn < tHoldEnd ? A : A * (1 - ease((tn - tHoldEnd) / ts));
        pose(th);
        f.step(dt);
        t = tn;
        const wh = where(th);
        const x = f.positions;
        let inSource = 0;
        for (let i = 0; i < n; i++) {
          if (wh[i] === "source") inSource++;
          else if (!left[i]) {
            left[i] = true;
            tLastLeft = t;
            tFirstLeft ??= t;
          }
          if (landX[i] === null && wh[i] === "out" && x[3 * i + 2] < tableZ) landX[i] = (x[3 * i] - PIVOT[0]) / MM;
        }
        if (tHoldEnd === Infinity && t >= ts) {
          if (inSource === 0) {
            tHoldEnd = t;
            waitEnded = "the source cup was empty";
          } else if (t >= ts + 1 && t - tLastLeft >= 1) {
            tHoldEnd = t;
            waitEnded = "no liquid had left the source cup for 1 s";
          } else if (t >= ts + WAIT_TIMEOUT_S) {
            tHoldEnd = t;
            waitEnded = `timeout (${WAIT_TIMEOUT_S} s)`;
          }
        }
        if (leftByReturn === null && t >= tHoldEnd) {
          leftByReturn = n - inSource;
          tEnd = tHoldEnd + ts + COUNT_AFTER_S;
        }
      }
      const wh = where(th);
      const v = f.velocities;
      const x = f.positions;
      const cnt = (s0: string) => wh.filter((q) => q === s0).length;
      // does it stay? the same count LIQUID_HOLD_S later, the source cup upright and still
      const moving = Array.from({ length: n }, (_, i) => Math.hypot(v[3 * i], v[3 * i + 1], v[3 * i + 2]) / MM > 5).filter(Boolean).length;
      const xAtCount = Float64Array.from(x);
      for (let i = 0; i < Math.round(LIQUID_HOLD_S * LIQUID.fps); i++) {
        pose(0);
        f.step(dt);
      }
      const laterInTarget = where(0).filter((q) => q === "target").length;
      const inTarget = cnt("target");
      const inSource = cnt("source");
      const out = cnt("out");
      const landed = landX.filter((q, i): q is number => q !== null && wh[i] === "out");
      const airborneZ: number[] = [];
      for (let i = 0; i < n; i++) if (wh[i] === "out" && landX[i] === null) airborneZ.push(xAtCount[3 * i + 2] / MM);
      const P = (c0: number) => (100 * c0) / n;
      const stays = laterInTarget >= 0.9 * n;
      const pass = inTarget >= 0.9 * n && stays;
      const failure_class = pass ? null : inTarget >= 0.9 * n ? "did not stay in the target" : g === 0 ? "0 g: missed the target" : inSource > 0.1 * n ? "liquid left in the source" : "liquid outside both cups";
      const metrics: Metrics = {
        strategy,
        particles: n,
        tilt_deg: num(k, "tilt_deg"),
        tilt_s: ts,
        target_opening_from_lip_mm: `${r1(opening[0])}..${r1(opening[1])}`,
        hold_end_s: tHoldEnd,
        wait_ended: waitEnded,
        first_left_s: tFirstLeft,
        left_by_return_pct: P(leftByReturn ?? 0),
        count_t_s: t,
        in_target_pct: P(inTarget),
        in_source_pct: P(inSource),
        out_pct: P(out),
        moving_faster_than_5_mm_s_pct: P(moving),
        landed_x_min_mm: landed.length ? Math.min(...landed) : null,
        landed_x_max_mm: landed.length ? Math.max(...landed) : null,
        airborne_pct: P(airborneZ.length),
        in_target_later_pct: P(laterInTarget),
      };
      const program =
        strategy === "pour"
          ? `strategy pour: tilted ${r1(num(k, "tilt_deg"), 0)} deg over ${r1(ts, 2)} s, held ${POUR_HOLD_S} s, returned upright over ${r1(ts, 2)} s`
          : `strategy hold-and-wait: tilted ${r1(num(k, "tilt_deg"), 0)} deg over ${r1(ts, 2)} s, held until t = ${r1(tHoldEnd, 2)} s (${waitEnded}), returned upright over ${r1(ts, 2)} s`;
      const pc = (c0: number) => (c0 > 0 && P(c0) < 0.5 ? "under 1%" : `${r1(P(c0), 0)}%`);
      const outLines = [
        landed.length ? `${pc(landed.length)} of the water landed on the table outside both cups, first touching it at x = ${r1(Math.min(...landed), 0)} to ${r1(Math.max(...landed), 0)} mm from the pour lip (median ${r1(landed.sort((p, q) => p - q)[Math.floor(landed.length / 2)], 0)} mm).` : "",
        airborneZ.length ? `${pc(airborneZ.length)} of the water is outside both cups without having touched the table; at the count it is ${r1(Math.min(...airborneZ), 0)} to ${r1(Math.max(...airborneZ), 0)} mm above it.` : "",
      ].filter(Boolean);
      const note = [
        `Program: ${program}; the target cup's opening spans x = ${r1(opening[0], 0)} to ${r1(opening[1], 0)} mm from the pour lip. Counted at t = ${r1(t, 2)} s (t = 0 at the start of the tilt).`,
        `Flow: ${tFirstLeft === null ? "no water left the source cup" : `water first left the source cup at t = ${r1(tFirstLeft, 2)} s, the last of it at t = ${r1(tLastLeft, 2)} s`}; ${pc(leftByReturn ?? 0)} had left it when the return to upright began.`,
        `Count: ${pc(inTarget)} of the water in the target cup, ${pc(inSource)} still in the source cup, ${pc(out)} outside both; ${pc(moving)} still moving faster than 5 mm/s. ${LIQUID_HOLD_S} s later, the source cup upright and still: ${pc(laterInTarget)} in the target cup.`,
        ...(outLines.length ? outLines : ["No water is outside both cups."]),
      ].join("\n");
      return { pass, score: pass ? 1 : (0.9 * inTarget) / n, failure_class, metrics, note };
    });
  },
};

// --- carry ----------------------------------------------------------------------
const CARRY_D_M = Number(process.env.CARRY_D_M ?? 0.4);
const CARRY_VMAX = Number(process.env.CARRY_VMAX ?? 0.5);
/** the tube counts as having jumped out if its bottom ever rises this far off the pocket floor */
const CARRY_MAX_LIFT_MM = 5;
const CARRY_AFTER_S = 2;
/** the near-full cup from gravity.test.ts: 80 beads in a 40 x 40 mm cup, 25 mm deep */
const CARRY_CUP_H = Number(process.env.CARRY_CUP_H ?? 0.025);

export function carryProfile(a: number): { ta: number; tc: number; total: number; vpeak: number } {
  const ta = Math.min(CARRY_VMAX / a, Math.sqrt(CARRY_D_M / a));
  const vpeak = a * ta;
  const tc = (CARRY_D_M - a * ta * ta) / vpeak;
  return { ta, tc, total: 2 * ta + tc, vpeak };
}
const carryAccel = (t: number, a: number, p: ReturnType<typeof carryProfile>) => (t < 0 ? 0 : t < p.ta ? a : t < p.ta + p.tc ? 0 : t < p.total ? -a : 0);

const carry: Probe = {
  id: "carry",
  task: `Carry an object ${CARRY_D_M / MM} mm along +x and set it down still: either a 17 x 100 mm tube seated in a small rack (20 x 20 mm pocket, 32 mm deep) that the gripper carries, or an open 40 x 40 mm cup, 25 mm deep, holding 80 water-density beads (a liquid stand-in). No lid or cover is available. The carry accelerates up to the knob's limit, coasts at up to ${CARRY_VMAX / MM} mm/s and brakes at the same limit; the vehicle may accelerate during the step. Success, checked ${CARRY_AFTER_S} s after the carry ends: for the tube, its bottom never more than ${CARRY_MAX_LIFT_MM} mm off the pocket floor during the step and, at the check, within 2 mm of it, inside the pocket and at rest (its centre moved less than ${REST_MM_S} mm over the last second); for the cup, all 80 beads inside it.`,
  knobs: [
    { name: "max_accel_m_s2", kind: "number", min: 0.05, max: 5, unit: "m/s²", doc: "acceleration and braking limit of the carry" },
    { name: "hold_grip", kind: "bool", doc: "true: the fingers also clamp the carried tube in its pocket during the carry and open once the carry has stopped (they cannot cover the cup)" },
  ],
  naive: { max_accel_m_s2: 3, hold_grip: false },
  expert: () => ({ max_accel_m_s2: 0.1, hold_grip: true }),
  run(mj, k, w, opts = {}) {
    const g = localG(w);
    const a = num(k, "max_accel_m_s2");
    const hold = Boolean(k.hold_grip);
    const prof = carryProfile(a);
    const b = burst(w);
    const r = rng(w, 4);
    const lateralAt = (t: number) => (carryAccel(t, a, prof) + (t >= b.t0 && t < b.t1 ? b.a_g * G : 0)) / G;
    const tEnd = prof.total + CARRY_AFTER_S;
    const phase = (t: number) => (t < prof.ta ? "accelerating" : t < prof.ta + prof.tc ? "coasting" : t < prof.total ? "braking" : "after the carry");
    let peakH = 0;
    for (let t = 0; t < tEnd; t += 0.002) peakH = Math.max(peakH, Math.abs(lateralAt(t) * G));
    const programLine = `Program: carried ${CARRY_D_M / MM} mm along +x, accelerating at ${r1(a, 2)} m/s² for ${r1(prof.ta, 2)} s, coasting at ${r1(prof.vpeak / MM, 0)} mm/s for ${r1(prof.tc, 2)} s, braking at ${r1(a, 2)} m/s² until t = ${r1(prof.total, 2)} s; then held still ${CARRY_AFTER_S} s. Peak horizontal acceleration of the carried object (gripper IMU, carry plus vehicle): ${r1(peakH, 2)} m/s².`;
    const object = w.object ?? "tube";
    if (object === "tube") {
      const scene = rackScene(0, r() * 0.6);
      return withSim(mj, worldXml(scene.worldbody, gravityVec(g)), (sim) => {
        const floorZ = sim.sitePos(scene.pocketFloorSite)[2];
        const adr = sim.free(scene.tube);
        sim.step(steps(sim, 0.5));
        const qpos = sim.data.qpos as Float64Array;
        const held = Array.from(qpos.slice(adr.q, adr.q + 7));
        let maxLift = -Infinity;
        let maxLiftT = 0;
        let maxTilt = 0;
        let leftAt: number | null = null;
        let before: Vec3 = [0, 0, 0];
        const nC = steps(sim, tEnd);
        for (let i = 1; i <= nC; i++) {
          if (i === nC - steps(sim, 1)) before = freeState(sim, adr).pos;
          const t = i * sim.dt;
          sim.setGravity(gravityVec(g, lateralAt(t)));
          sim.step();
          if (hold && t <= prof.total) {
            // clamped: the tube moves with the rack until the fingers open
            for (let j = 0; j < 7; j++) qpos[adr.q + j] = held[j];
            const dq = sim.data.qvel as Float64Array;
            for (let j = 0; j < 6; j++) dq[adr.d + j] = 0;
            sim.mj.mj_forward(sim.model, sim.data);
          }
          const s = freeState(sim, adr);
          const lift = (cylinderLowestZ(s, TUBE.radius_m, TUBE.half_m) - floorZ) / MM;
          if (lift > maxLift) {
            maxLift = lift;
            maxLiftT = t;
          }
          maxTilt = Math.max(maxTilt, tiltDeg(s.quat));
          if (leftAt === null && !pocketState(s, floorZ, scene.pocket_xy_m, scene.inner_mm).in_pocket) leftAt = t;
        }
        const s = freeState(sim, adr);
        const p = pocketState(s, floorZ, scene.pocket_xy_m, scene.inner_mm);
        const spd = norm(sub(s.pos, before)) / MM;
        const rest = spd < REST_MM_S;
        const stayed = maxLift < CARRY_MAX_LIFT_MM;
        const pass = stayed && p.in_pocket && rest;
        const failure_class = pass ? null : !p.in_pocket || !stayed ? (g === 0 ? "0 g: tube left the pocket" : "tube left the pocket") : "still moving";
        const metrics: Metrics = {
          object,
          max_accel_m_s2: a,
          hold_grip: hold,
          carry_s: prof.total,
          peak_horizontal_m_s2: peakH,
          frame_accel_g: b.a_g,
          max_lift_mm: maxLift,
          max_tilt_deg: maxTilt,
          first_left_pocket_s: leftAt,
          lowest_above_floor_mm: p.lowest_above_floor_mm,
          tilt_deg: p.tilt_deg,
          in_pocket: p.in_pocket,
          drift_last_s_mm: spd,
          at_rest: rest,
        };
        const note = [
          `Object: the tube seated in its rack. ${programLine} Grip: ${hold ? "the fingers clamped the tube in its pocket during the carry and opened at t = " + r1(prof.total, 2) + " s" : "the tube was free in its pocket (only the rack was held)"}.`,
          imuLine(b),
          `During the step: the tube's bottom rose at most ${r1(maxLift)} mm off the pocket floor (t = ${r1(maxLiftT, 2)} s, ${phase(maxLiftT)}), maximum tilt ${r1(maxTilt)} deg${leftAt !== null ? `; it was out of the pocket from t = ${r1(leftAt, 2)} s (${phase(leftAt)})` : ""}.`,
          `End (t = ${r1(tEnd, 2)} s): tube's bottom ${r1(p.lowest_above_floor_mm)} mm above the pocket floor, tilt ${r1(p.tilt_deg)} deg, ${p.in_pocket ? "inside the pocket" : "not in the pocket"}; its centre moved ${r1(spd, 2)} mm over the last second.`,
          `Checks: never more than ${CARRY_MAX_LIFT_MM} mm off the pocket floor ${yes(stayed)}; in the pocket at the end ${yes(p.in_pocket)}; at rest ${yes(rest)}.`,
          ...(opts.derived ? carryDerived(peakH, g) : []),
        ].join("\n");
        return { pass, score: pass ? 1 : p.in_pocket ? 0.6 : 0, failure_class, metrics, note };
      });
    }
    const cup = `<body name="cup" pos="0 0 ${W}">
      ${cupGeoms("cup", [IN, IN], CARRY_CUP_H, W, "floor")}
    </body>`;
    const particles = particleBodies([0, 0, W], {}, w.seed);
    const inCup = ([x, y, z]: Vec3) => Math.abs(x) < IN && Math.abs(y) < IN && z > W && z < W + CARRY_CUP_H;
    return withSim(mj, worldXml(`${cup}\n${particles.xml}`, gravityVec(g), { option: PARTICLE_OPTION }), (sim) => {
      const adrs = particles.names.map((n) => sim.free(n));
      sim.step(steps(sim, 1));
      let firstOut: number | null = null;
      let maxOut = 0;
      let maxOutT = 0;
      const ever = new Set<number>();
      for (let i = 1; i <= steps(sim, tEnd); i++) {
        const t = i * sim.dt;
        sim.setGravity(gravityVec(g, lateralAt(t)));
        sim.step();
        if (i % 5 === 0) {
          const pos = particleStates(sim, adrs).pos;
          let n = 0;
          pos.forEach((p, j) => {
            if (!inCup(p)) {
              n++;
              ever.add(j);
            }
          });
          if (n && firstOut === null) firstOut = t;
          if (n > maxOut) {
            maxOut = n;
            maxOutT = t;
          }
        }
      }
      const st = particleStates(sim, adrs);
      const outEnd = st.pos.filter((p) => !inCup(p)).length;
      const moving = st.speed.filter((v) => v / MM > 5).length;
      const pass = outEnd === 0;
      const failure_class = pass ? null : g === 0 ? "0 g: beads left the open cup" : "spilled";
      const metrics: Metrics = {
        object,
        max_accel_m_s2: a,
        hold_grip: hold,
        carry_s: prof.total,
        peak_horizontal_m_s2: peakH,
        frame_accel_g: b.a_g,
        first_out_s: firstOut,
        ever_out: ever.size,
        out_at_end: outEnd,
        max_out: maxOut,
        moving_faster_than_5_mm_s: moving,
      };
      const note = [
        `Object: the open cup of beads. ${programLine} Grip: ${hold ? "hold_grip was set, but the fingers cannot cover the cup" : "the cup was held at its sides"}.`,
        imuLine(b),
        `During the step: ${firstOut === null ? "no bead left the cup" : `the first bead left the cup at t = ${r1(firstOut, 2)} s (${phase(firstOut)}); at most ${maxOut} were outside at once (t = ${r1(maxOutT, 2)} s, ${phase(maxOutT)}); ${ever.size} different beads were outside at some point`}.`,
        `End (t = ${r1(tEnd, 2)} s): ${outEnd} of 80 beads outside the cup, ${moving} of 80 still faster than 5 mm/s.`,
        `Check: all 80 beads inside the cup ${yes(pass)}.`,
        ...(opts.derived ? carryDerived(peakH, g) : []),
      ].join("\n");
      return { pass, score: pass ? 1 : (0.9 * (PARTICLES.count - outEnd)) / PARTICLES.count, failure_class, metrics, note };
    });
  },
};

function carryDerived(peakH: number, g: number): string[] {
  return g > 0 ? [`Derived: the peak horizontal acceleration was ${r1(peakH / (g * G), 2)} times the local gravity.`] : [];
}

export const PROBES: Record<ProbeId, Probe> = { insert, place, pour, carry, "pour-liquid": pourLiquid };

// --- cases ------------------------------------------------------------------------
export type CaseDef = { id: string; probe: ProbeId; disturbance: string; world: Omit<World, "seed"> };

/**
 * The case grid: probe x gravity x disturbance; the loop adds the seeds.
 * Disturbances follow the gravity report: hand-off velocity, lateral offsets,
 * vehicle acceleration (0.05 / 0.2 g on the surfaces, 0.02 g in orbit), and,
 * for the pour, a target placed 30 mm farther than nominal. Most cases fail
 * with the naive program; a few controls do not (marked in the results by
 * their iteration-0 pass), and the open cup in orbit has no passing program
 * with these knobs (marked by the expert check).
 */
export function caseGrid(): CaseDef[] {
  const out: CaseDef[] = [];
  const add = (probe: ProbeId, gravity: GravityId, disturbance: string, world: Omit<World, "seed" | "gravity">) =>
    out.push({ id: `${probe}/${gravity}/${disturbance}`, probe, disturbance, world: { gravity, ...world } });
  const surfaces: GravityId[] = ["earth", "mars", "moon"];
  // insert: a lateral offset (with and without hand-off velocity); in orbit also the plain release
  add("insert", "earth", "handoff5", { handoff_mm_s: 5 });
  for (const gid of surfaces) {
    add("insert", gid, "offset+4mm", { offset_mm: 4 });
    add("insert", gid, "offset-6mm+handoff5", { offset_mm: -6, handoff_mm_s: 5 });
  }
  add("insert", "orbit", "handoff0", {});
  add("insert", "orbit", "handoff5", { handoff_mm_s: 5 });
  add("insert", "orbit", "offset+4mm", { offset_mm: 4 });
  add("insert", "orbit", "offset-6mm+handoff5", { offset_mm: -6, handoff_mm_s: 5 });
  // place: vehicle bursts on the surfaces (the same 0.05 g is harmless on Earth), hand-off and a burst in orbit
  add("place", "earth", "frame0.05g", { frame_g: 0.05 });
  for (const gid of surfaces) add("place", gid, "frame0.2g", { frame_g: 0.2 });
  add("place", "mars", "frame0.05g", { frame_g: 0.05 });
  add("place", "moon", "frame0.05g", { frame_g: 0.05 });
  add("place", "orbit", "handoff0", {});
  add("place", "orbit", "handoff5", { handoff_mm_s: 5 });
  add("place", "orbit", "frame0.02g", { frame_g: 0.02 });
  // pour: nominal target and a target 30 mm farther, everywhere
  for (const gid of [...surfaces, "orbit" as const]) {
    add("pour", gid, "nominal", {});
    add("pour", gid, "target+30mm", { target_shift_mm: 30 });
  }
  // carry: the cup on the surfaces (only the Moon is sensitive), the tube in orbit, and the open cup in orbit
  add("carry", "earth", "cup+frame0.2g", { object: "cup", frame_g: 0.2 });
  add("carry", "mars", "cup+frame0.05g", { object: "cup", frame_g: 0.05 });
  add("carry", "moon", "cup", { object: "cup" });
  add("carry", "moon", "cup+frame0.05g", { object: "cup", frame_g: 0.05 });
  add("carry", "moon", "tube+frame0.2g", { object: "tube", frame_g: 0.2 });
  add("carry", "orbit", "tube", { object: "tube" });
  add("carry", "orbit", "tube+frame0.02g", { object: "tube", frame_g: 0.02 });
  add("carry", "orbit", "cup", { object: "cup" });
  return out;
}

/** The liquid pour cases: the bead pour's two disturbances at all four gravities. */
export function liquidCaseGrid(): CaseDef[] {
  return (["earth", "mars", "moon", "orbit"] as GravityId[]).flatMap((gravity) => [
    { id: `pour-liquid/${gravity}/nominal`, probe: "pour-liquid" as const, disturbance: "nominal", world: { gravity } },
    { id: `pour-liquid/${gravity}/target+30mm`, probe: "pour-liquid" as const, disturbance: "target+30mm", world: { gravity, target_shift_mm: 30 } },
  ]);
}
