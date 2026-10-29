/**
 * A toss and a catch with one arm (issue #159): the pure part, with no MuJoCo, so it is unit-tested.
 *
 * A toss lets go of the held object while the gripper moves; from then on MuJoCo carries the object as a rigid body
 * under gravity and contacts. Drag is left out: there is no air in the simulator, so a light, flat object flies as
 * far as a heavy, round one would.
 *
 * A catch predicts where the object will be from its state at the moment it comes off the pads (where it was and how
 * fast it moved, which the arm knows from its own joints, since the object moved with the pads until then) and the
 * world's gravity: a parabola on Earth, a straight line in orbit. Nothing watches the object in flight. The catch
 * then puts the point between the pads where that path passes nearest the point the program aims at, and closes the
 * jaws so they meet it on time. Whether it is held again is the grasp's own check (both jaws on it, the moving jaw
 * settled: lib/sim/grasp.ts), within a window after the predicted moment; nothing is welded unless that check holds.
 */

type Vec3 = [number, number, number];

/** The object's state as it came off the pads, world frame, metres and seconds since the rollout started. */
export type Release = { t: number; xyz_m: Vec3; v_m_s: Vec3 };

/** What a toss and its catch did, measured: what a test and a failure note read. */
export type Flight = {
  step_id: string;
  object: string;
  /** asked for by the program, mm/s */
  asked_mm_s: Vec3;
  /** when the jaws let go, s */
  let_go_t: number;
  /** measured as the object came off the pads (or TOSS_PART_MAX_S after letting go, if it had not): its path starts here */
  release: { t: number; xyz_mm: Vec3; v_mm_s: Vec3 };
  /** whether it came off the pads before that */
  parted: boolean;
  /** the fastest any arm joint was asked to turn during the toss, run-up, coast and brake, rad/s (at most TOSS_JOINT_RAD_S) */
  peak_joint_rad_s: number;
  /** the fastest any arm joint really turned during the toss, rad/s: the servo's lag correction on top of the rates can exceed the cap */
  measured_joint_rad_s: number;
  catch?: {
    step_id: string;
    /** the moment the object was predicted at the catch point, s */
    t_predicted: number;
    /** where it was predicted, mm, world */
    xyz_mm: Vec3;
    /** how far the predicted path passes from the point the program aimed at, mm */
    aim_off_mm: number;
    /** how far the object really was from where it was predicted, at that moment, mm */
    predicted_off_mm?: number;
    held: boolean;
    /** seconds after the predicted moment the grasp check held (negative: before it) */
    held_after_s?: number;
    /** the jaw angle they stopped at when they stopped, both on the object, but not where they had held it (rad) */
    shut_rad?: number;
    /** it was already against the gripper when the jaws were to start closing: no catch was tried */
    touching?: boolean;
  };
};

/** Where the object is predicted at time `t` (s): ballistic from its release, no drag. `g` is the gravity vector, m/s². */
export function predict(r: Release, g: Vec3, t: number): Vec3 {
  const s = t - r.t;
  return [0, 1, 2].map((k) => r.xyz_m[k] + r.v_m_s[k] * s + 0.5 * g[k] * s * s) as Vec3;
}

/**
 * The time in [from, to], sampled every `dt`, at which the predicted path passes nearest `aim`, and how near (m).
 * Of two passes equally near (within a millimetre: a toss straight up passes the same point going up and coming
 * down) the later one wins, the one coming down. Null when the interval is empty.
 */
export function nearestPass(r: Release, g: Vec3, aim: Vec3, from: number, to: number, dt: number): { t: number; off_m: number } | null {
  if (!(to >= from) || !(dt > 0)) return null;
  const n = Math.floor((to - from) / dt + 1e-9);
  const samples = Array.from({ length: n + 1 }, (_, i) => {
    const t = from + i * dt;
    const p = predict(r, g, t);
    return { t, off_m: Math.hypot(p[0] - aim[0], p[1] - aim[1], p[2] - aim[2]) };
  });
  // the passes: local minima of the distance, the ends of the interval included
  const passes = samples.filter((x, i) => (i === 0 || x.off_m <= samples[i - 1].off_m) && (i === n || x.off_m <= samples[i + 1].off_m));
  const nearest = Math.min(...passes.map((x) => x.off_m));
  return passes.findLast((x) => x.off_m <= nearest + 0.001) ?? null;
}

/** Wilson score interval for k successes out of n, 95% by default: what a catch rate is reported with. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
