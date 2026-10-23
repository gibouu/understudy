/**
 * The shared contract of Understudy. Every stage reads or writes one of these.
 *
 * Provenance: every object, step and via-point carries a `source` string so the
 * UI can badge where a value came from and the reshoot list can tell footage
 * gaps from spec gaps. Prefixes:
 *   vl#<segment>      labelled by the vision model from keyframes
 *   pose#<segment>    measured from MediaPipe landmarks
 *   interview#<turn>  answered by the person who did the task
 *   tavily:<url>      grounded in a fetched document (opt-in)
 *   user#edit         edited by hand in the UI
 *   default           a default the compiler or UI filled in
 */
import { z } from "zod";

export const FIXTURES = ["pocket", "zone", "stack"] as const;
export const SHAPES = ["cylinder", "box", "sphere"] as const;
/** none: a box; axial: a cylinder (yaw does not matter); full: a sphere. */
export const SYMMETRIES = ["none", "axial", "full"] as const;
export const ROLES = ["manipulated", "fixture", "obstacle", "surface"] as const;
export const VERBS = ["reach", "grasp", "move", "insert", "place", "release", "retract"] as const;
export const APPROACHES = ["top", "side", "front"] as const;
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
] as const;
/** Perturbation axes the saboteur may pick; the band is a half-width. */
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

export type Fixture = (typeof FIXTURES)[number];
export type Shape = (typeof SHAPES)[number];
export type Axis = (typeof AXES)[number];
export type Mode = (typeof MODES)[number];
export type PredicateKind = (typeof PREDICATES)[number];

export const Source = z.string().min(1).default("default");
export const Vec3mm = z.tuple([z.number(), z.number(), z.number()]);

export const Predicate = z.object({
  kind: z.enum(PREDICATES),
  /** object id the predicate is about */
  object: z.string().optional(),
  /** zone, pocket or object id it is measured against */
  target: z.string().optional(),
  /** threshold in mm, degrees or seconds depending on the kind */
  value: z.number().optional(),
});
export type Predicate = z.infer<typeof Predicate>;

export const SpecObject = z.object({
  id: z.string(),
  name: z.string(),
  shape: z.enum(SHAPES),
  /** cylinder: [diameter, diameter, height]; box: [x, y, z]; sphere: [d, d, d] */
  size_mm: Vec3mm,
  symmetry: z.enum(SYMMETRIES),
  role: z.enum(ROLES),
  /** fixtures with a pocket: hole minus object, in mm */
  pocket_clearance_mm: z.number().optional(),
  confidence: z.number().min(0).max(1).default(0.5),
  source: Source,
});
export type SpecObject = z.infer<typeof SpecObject>;

export const ViaPoint = z.object({
  /** frame the point is expressed in: an object id or "world" */
  frame: z.string(),
  xyz_mm: Vec3mm,
  t_s: z.number().optional(),
  source: Source,
});
export type ViaPoint = z.infer<typeof ViaPoint>;

export const Step = z.object({
  id: z.string(),
  verb: z.enum(VERBS),
  /** manipulated object id */
  object: z.string(),
  target: z
    .object({ fixture: z.enum(FIXTURES), frame: z.string() })
    .optional(),
  via_points: z.array(ViaPoint).default([]),
  preconditions: z.array(Predicate).default([]),
  success: z.array(Predicate).default([]),
  /** half-width of the band the step must survive, per axis */
  tolerances: z.partialRecord(z.enum(AXES), z.number()).default({}),
  t_start_s: z.number(),
  t_end_s: z.number(),
  source: Source,
});
export type Step = z.infer<typeof Step>;

export const TaskSpec = z.object({
  version: z.literal(1),
  title: z.string(),
  summary: z.string(),
  objects: z.array(SpecObject),
  steps: z.array(Step),
  /** the grasp moment the via-points are anchored on */
  anchor: z.object({ t_s: z.number(), confidence: z.number() }).optional(),
  warnings: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
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
    frame: z.string(),
    offset_mm: Vec3mm,
    approach: z.enum(APPROACHES).default("top"),
  }),
  z.object({ op: z.literal("grasp"), object: z.string(), aperture_mm: z.number() }),
  z.object({ op: z.literal("release") }),
  z.object({
    op: z.literal("wait_until"),
    predicate: Predicate,
    timeout_s: z.number().default(3),
  }),
  z.object({ op: z.literal("assert"), predicate: Predicate }),
  z.object({
    op: z.literal("ask"),
    /** JSON path in the spec the answer fills, e.g. steps[1].tolerances.x_mm */
    slot: z.string(),
    question: z.string(),
    why: z.string(),
  }),
]);
export type ProgramOp = z.infer<typeof ProgramOp>;

export const Program = z.object({
  spec_title: z.string(),
  steps: z.array(z.object({ step_id: z.string(), ops: z.array(ProgramOp) })),
  warnings: z.array(z.string()).default([]),
});
export type Program = z.infer<typeof Program>;

/** One interview turn from Super, streamed in this key order. */
export const SpecChange = z.object({
  path: z.string(),
  value: z.unknown(),
  source: Source,
});
export const InterviewTurn = z.object({
  question: z.string(),
  chips: z.array(z.string()).default([]),
  why: z.string().default(""),
  done: z.boolean().default(false),
  changes: z.array(SpecChange).default([]),
});
export type InterviewTurn = z.infer<typeof InterviewTurn>;

/** A saboteur scenario: one axis, one offset, an expected outcome. */
export const Scenario = z.object({
  id: z.string(),
  name: z.string(),
  axis: z.enum(AXES),
  /** signed offset in the axis unit */
  offset: z.number(),
  /** object id the perturbation applies to */
  object: z.string(),
  expected: z.enum(["pass", "fail", "unknown"]),
  why: z.string().default(""),
});
export type Scenario = z.infer<typeof Scenario>;

export const RolloutResult = z.object({
  scenario_id: z.string(),
  mode: z.enum(MODES),
  pass: z.boolean(),
  failed_step_id: z.string().optional(),
  failed_predicate: Predicate.optional(),
  /** "embodiment limit" when the reachability pre-check fails */
  failure_class: z
    .enum(["spec_gap", "footage_gap", "embodiment_limit", "simulator_artefact"])
    .optional(),
  metrics: z.record(z.string(), z.number()).default({}),
  seconds: z.number().default(0),
});
export type RolloutResult = z.infer<typeof RolloutResult>;

/** Per-axis envelope: the largest offset that still passed, per mode. */
export const Envelope = z.record(
  z.enum(AXES),
  z.object({ sensed: z.number().nullable(), blind: z.number().nullable() }),
);
export type Envelope = z.infer<typeof Envelope>;
