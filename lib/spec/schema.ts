/**
 * The shared contract of Understudy. Every stage reads or writes one of these.
 *
 * Units and frames
 *   The spec speaks millimetres and degrees; the simulator converts to metres
 *   and radians at its boundary. The world frame sits where the robot base
 *   meets the table: x away from the robot, y to the robot's left, z up. An
 *   object frame sits at the object's centre, rotated by its yaw. Via-points
 *   and `move_to` offsets are expressed in a named frame ("world" or an
 *   object id); perturbations move the object frame, which is how the same
 *   program is replayed under a displaced rack.
 *
 * Provenance
 *   Each object and step carries a default `source` and a `sources` map for
 *   fields that were later changed by someone else (an interview answer, a
 *   hand edit). Prefixes:
 *     vl#<segment>      labelled by the vision model from keyframes
 *     pose#<segment>    measured from MediaPipe landmarks
 *     interview#<turn>  answered by the person who did the task
 *     tavily:<url>      grounded in a fetched document (opt-in)
 *     user#edit         edited by hand in the UI
 *     default           a default the compiler or UI filled in
 *
 * Validation happens in two layers: this file checks shape and physical
 * invariants; `validate.ts` checks references (ids, frames, step ids) so the
 * compiler can turn a dangling reference into an `ask` instead of a crash.
 */
import { z } from "zod";

export const FIXTURES = ["pocket", "zone", "stack"] as const;
export const SHAPES = ["cylinder", "box", "sphere"] as const;
/** none: a box; axial: a cylinder (yaw does not matter); full: a sphere. */
export const SYMMETRIES = ["none", "axial", "full"] as const;
export const ROLES = ["manipulated", "fixture", "obstacle", "surface"] as const;
export const VERBS = ["reach", "grasp", "move", "insert", "place", "release", "retract", "pour", "gesture"] as const;
export const APPROACHES = ["top", "side", "front"] as const;
/** The person's own hands, as MediaPipe names them. */
export const HANDS = ["left", "right"] as const;
/** Closed enum: the simulator evaluates exactly these and nothing else. */
export const PREDICATES = [
  "contact_both_pads",
  "height_above",
  "inside_zone",
  "no_collision",
  "tilt_under",
  "gripper_within",
  "object_still",
  "time_under",
  "liquid_inside",
] as const;
/** Perturbation axes the saboteur may pick; a tolerance is a half-width. */
export const AXES = [
  "x_mm",
  "y_mm",
  "z_mm",
  "yaw_deg",
  "tilt_deg",
  "clearance_mm",
  "pose_noise_mm",
] as const;
export const MODES = ["sensed", "blind"] as const;
/** Gravity presets, in g. Orbit is microgravity; the same program is rehearsed under each. */
export const GRAVITIES = { earth: 1, moon: 0.1654, orbit: 0 } as const;
export type GravityName = keyof typeof GRAVITIES;
export const FAILURE_CLASSES = [
  "spec_gap",
  "footage_gap",
  "embodiment_limit",
  "simulator_artefact",
] as const;

export type Fixture = (typeof FIXTURES)[number];
export type Shape = (typeof SHAPES)[number];
export type Axis = (typeof AXES)[number];
export type Mode = (typeof MODES)[number];
export type PredicateKind = (typeof PREDICATES)[number];

export const Source = z.string().min(1).default("default");
/** field name -> source, for fields whose provenance differs from the record's `source` */
export const Sources = z.record(z.string(), z.string().min(1)).default({});
const finite = z.number().finite();
export const Vec3mm = z.tuple([finite, finite, finite]);

/** Operands each predicate kind needs; the compiler asks for what is missing. */
export const PREDICATE_OPERANDS: Record<PredicateKind, { object: boolean; target: boolean; value: boolean; unit?: string }> = {
  contact_both_pads: { object: true, target: false, value: false },
  height_above: { object: true, target: false, value: true, unit: "mm above the table" },
  inside_zone: { object: true, target: true, value: false },
  no_collision: { object: false, target: false, value: false },
  tilt_under: { object: true, target: false, value: true, unit: "degrees from upright" },
  gripper_within: { object: true, target: false, value: true, unit: "mm of aperture error" },
  object_still: { object: true, target: false, value: false },
  time_under: { object: false, target: false, value: true, unit: "seconds" },
  /** with an object: the share of the liquid that started in that container, so what the target held before does not count */
  liquid_inside: { object: false, target: true, value: true, unit: "% of the liquid inside the target; with an object, of the liquid that started in it" },
};

export const Predicate = z
  .object({
    kind: z.enum(PREDICATES),
    /** object id the predicate is about */
    object: z.string().min(1).optional(),
    /** zone, pocket or object id it is measured against */
    target: z.string().min(1).optional(),
    /** threshold, unit per PREDICATE_OPERANDS */
    value: finite.optional(),
  })
  .superRefine((p, ctx) => {
    const need = PREDICATE_OPERANDS[p.kind];
    if (need.object && !p.object) ctx.addIssue({ code: "custom", path: ["object"], message: `${p.kind} needs an object` });
    if (need.target && !p.target) ctx.addIssue({ code: "custom", path: ["target"], message: `${p.kind} needs a target` });
    if (need.value && p.value === undefined) ctx.addIssue({ code: "custom", path: ["value"], message: `${p.kind} needs a value (${need.unit})` });
    if (need.value && p.value !== undefined && p.value < 0) ctx.addIssue({ code: "custom", path: ["value"], message: `${p.kind} value must be >= 0` });
    // a share of the liquid, in percent: 0 always holds and above 100 never can
    if (p.kind === "liquid_inside" && p.value !== undefined && !(p.value > 0 && p.value <= 100)) ctx.addIssue({ code: "custom", path: ["value"], message: "liquid_inside value is a percent: more than 0, at most 100" });
  });
export type Predicate = z.infer<typeof Predicate>;

export const Pose = z.object({
  xyz_mm: Vec3mm,
  yaw_deg: finite.default(0),
  /** "world" or an object id */
  frame: z.string().min(1).default("world"),
});
export type Pose = z.infer<typeof Pose>;

export const SpecObject = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  shape: z.enum(SHAPES),
  /** cylinder: [diameter, diameter, height]; box: [x, y, z]; sphere: [d, d, d]; all > 0 */
  size_mm: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
  symmetry: z.enum(SYMMETRIES),
  role: z.enum(ROLES),
  /** nominal pose; missing means the scene builder lays it out and the compiler asks */
  pose: Pose.optional(),
  /** fixtures with a pocket: hole minus object, in mm */
  pocket_clearance_mm: z.number().nonnegative().optional(),
  /** liquid the object holds at the start, mL; it is then built as an open container (as is a pour step's source or `into`) */
  liquid_ml: z.number().positive().optional(),
  confidence: z.number().min(0).max(1).default(0.5),
  source: Source,
  sources: Sources,
});
export type SpecObject = z.infer<typeof SpecObject>;

/** How close (mm) the point between the pads must pass to a gesture path's point, unless the spec says otherwise. */
export const GESTURE_REACH_MM = 5;
/** One point of a gesture path: the hand, in the world frame, `t_s` seconds after the gesture starts. */
export const PathPoint = z.object({ t_s: z.number().nonnegative(), xyz_mm: Vec3mm });
export type PathPoint = z.infer<typeof PathPoint>;

export const ViaPoint = z.object({
  /** frame the point is expressed in: an object id or "world" */
  frame: z.string().min(1),
  xyz_mm: Vec3mm,
  t_s: z.number().nonnegative().optional(),
  source: Source,
});
export type ViaPoint = z.infer<typeof ViaPoint>;

export const Step = z
  .object({
    id: z.string().min(1),
    verb: z.enum(VERBS),
    /** manipulated object id; required, except on a gesture step, which handles nothing */
    object: z.string().min(1).optional(),
    target: z.object({ fixture: z.enum(FIXTURES), frame: z.string().min(1) }).optional(),
    via_points: z.array(ViaPoint).default([]),
    preconditions: z.array(Predicate).default([]),
    success: z.array(Predicate).default([]),
    /** half-width of the band the step must survive, per axis, >= 0 */
    tolerances: z.partialRecord(z.enum(AXES), z.number().nonnegative()).default({}),
    /** verb "pour": the held `object` is an open container whose liquid goes into the open container `into`, tilted by tilt_deg over tilt_s */
    pour: z
      .object({
        into: z.string().min(1),
        tilt_deg: z.number().gt(0).max(180),
        tilt_s: z.number().positive().optional(),
      })
      .optional(),
    /**
     * verb "gesture": no object; the point between the pads follows `path`, the person's hand (MediaPipe on the
     * clip, in the browser) scaled into the arm's reach. Empty until it is traced. A point counts as reached
     * when that point passes within `reach_mm` of it, in order (lib/sim/gesture.ts); a gesture has no other success.
     */
    gesture: z
      .object({
        hand: z.enum(HANDS).optional(),
        path: z.array(PathPoint).default([]),
        reach_mm: z.number().positive().default(GESTURE_REACH_MM),
      })
      .optional(),
    t_start_s: z.number().nonnegative(),
    t_end_s: z.number().nonnegative(),
    source: Source,
    sources: Sources,
  })
  .refine((s) => s.t_end_s >= s.t_start_s, { message: "t_end_s must be >= t_start_s", path: ["t_end_s"] })
  .refine((s) => s.object !== undefined || s.verb === "gesture", { message: "only a gesture step has no object", path: ["object"] });
export type Step = z.infer<typeof Step>;

export const TaskSpec = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  summary: z.string(),
  objects: z.array(SpecObject),
  steps: z.array(Step),
  /** the grasp moment the via-points are anchored on */
  anchor: z.object({ t_s: z.number().nonnegative(), confidence: z.number().min(0).max(1) }).optional(),
  warnings: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
  /** provenance of top-level fields (title, summary, anchor) changed after labelling */
  sources: Sources,
  provenance: z
    .object({
      label_input: z.enum(["keyframes", "video"]),
      clip_sha256: z.string().optional(),
      model: z.string().optional(),
    })
    .optional(),
});
export type TaskSpec = z.infer<typeof TaskSpec>;

/** What the compiler (Nano) emits per step; `ask` is a slot it could not fill. */
export const ProgramOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("move_to"),
    frame: z.string().min(1),
    offset_mm: Vec3mm,
    approach: z.enum(APPROACHES).default("top"),
  }),
  z.object({ op: z.literal("grasp"), object: z.string().min(1), aperture_mm: z.number().nonnegative() }),
  z.object({ op: z.literal("release") }),
  /**
   * Tilt the held object by `deg` from upright toward the frame `toward`, over `seconds`, about its rim on that side
   * (a pour); `deg` 0 turns it back upright about the same rim.
   */
  z.object({
    op: z.literal("tilt"),
    deg: z.number().min(0).max(180),
    toward: z.string().min(1).optional(),
    seconds: z.number().positive().default(1),
  }),
  /** Trace the gesture path of the step it is in with the point between the pads, then check each point was reached. */
  z.object({ op: z.literal("follow") }),
  z.object({
    op: z.literal("wait_until"),
    predicate: Predicate,
    timeout_s: z.number().positive().default(3),
  }),
  z.object({ op: z.literal("assert"), predicate: Predicate }),
  z.object({
    op: z.literal("ask"),
    /** path in the spec the answer fills, e.g. steps[1].tolerances.x_mm */
    slot: z.string().min(1),
    question: z.string().min(1),
    why: z.string().default(""),
  }),
]);
export type ProgramOp = z.infer<typeof ProgramOp>;

export const Program = z.object({
  spec_title: z.string(),
  steps: z.array(z.object({ step_id: z.string().min(1), ops: z.array(ProgramOp) })),
  warnings: z.array(z.string()).default([]),
});
export type Program = z.infer<typeof Program>;

/** One field-level change, applied with `applyChanges`, which also records provenance. */
export const SpecChange = z.object({
  /** e.g. objects[rack].pocket_clearance_mm, steps[s2].tolerances.x_mm, anchor.t_s */
  path: z.string().min(1),
  value: z.unknown(),
  source: Source,
});
export type SpecChange = z.infer<typeof SpecChange>;

/** One interview turn from Super, streamed in this key order. */
export const InterviewTurn = z.object({
  question: z.string(),
  chips: z.array(z.string()).default([]),
  why: z.string().default(""),
  done: z.boolean().default(false),
  changes: z.array(SpecChange).default([]),
});
export type InterviewTurn = z.infer<typeof InterviewTurn>;

/**
 * A saboteur scenario: a world perturbation on one axis of one object, with
 * optional observation noise on top (what the sensed mode sees), and an
 * expected outcome. `seed` makes the noise reproducible.
 */
export const Scenario = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  axis: z.enum(AXES),
  /** signed offset in the axis unit */
  offset: finite,
  /** object id the perturbation applies to */
  object: z.string().min(1),
  /** for tilt_deg: which horizontal axis the object tilts about */
  tilt_axis: z.enum(["x", "y"]).optional(),
  /** observation noise added to the pose the program receives in sensed mode */
  pose_noise_mm: z.number().nonnegative().optional(),
  seed: z.number().int().nonnegative().optional(),
  /** gravity the rollout runs under, in g: 1 Earth, 0.1654 Moon, 0 orbit */
  gravity_g: z.number().min(0).max(2).default(1),
  expected: z.enum(["pass", "fail", "unknown"]),
  why: z.string().default(""),
});
export type Scenario = z.infer<typeof Scenario>;

export const RolloutResult = z.object({
  scenario_id: z.string().min(1),
  mode: z.enum(MODES),
  pass: z.boolean(),
  failed_step_id: z.string().optional(),
  failed_predicate: Predicate.optional(),
  /** "embodiment_limit" when the reachability pre-check fails */
  failure_class: z.enum(FAILURE_CLASSES).optional(),
  gravity_g: z.number().min(0).max(2).default(1),
  metrics: z.record(z.string(), finite).default({}),
  seconds: z.number().nonnegative().default(0),
});
export type RolloutResult = z.infer<typeof RolloutResult>;

/**
 * Sampled evidence per axis and mode: the largest offset that passed and the
 * smallest that failed, on each side. A symmetric half-width is
 * min(|pass_neg|, pass_pos) and only exists when both sides were sampled;
 * the report shows the signed numbers, never a band it did not test.
 */
export const SignedBand = z.object({
  pass_neg: finite.max(0).nullable(),
  pass_pos: finite.min(0).nullable(),
  fail_neg: finite.max(0).nullable(),
  fail_pos: finite.min(0).nullable(),
});
export type SignedBand = z.infer<typeof SignedBand>;
export const Envelope = z.partialRecord(
  z.enum(AXES),
  z.object({ sensed: SignedBand, blind: SignedBand }),
);
export type Envelope = z.infer<typeof Envelope>;
