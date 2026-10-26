import { Program, TaskSpec } from "@/lib/spec/schema";

/**
 * The /stage scene until a compiled spec arrives, after the hero clip: a seed
 * film strip (15 x 6 x 40 mm, standing; a real film is thinner, but the jaws
 * need something to close on) and a hand-sized plant pillow whose pocket fits
 * the strip. Top-down reach ends near z = 90 mm: the strip's grasp point and
 * 50 mm above the pocket must both solve, which tests/sim/demo-spec.test.ts checks.
 */
export const DEMO_SPEC = TaskSpec.parse({
  version: 1,
  title: "seed film into plant pillow",
  summary: "Pick up the seed film and tuck it into the plant pillow's pocket.",
  objects: [
    { id: "film", name: "seed film", shape: "box", size_mm: [15, 6, 40], symmetry: "none", role: "manipulated", pose: { xyz_mm: [200, -100, 20] }, source: "demo" },
    { id: "pillow", name: "plant pillow", shape: "box", size_mm: [100, 60, 30], symmetry: "none", role: "fixture", pocket_clearance_mm: 5, pose: { xyz_mm: [175, 100, 15] }, source: "demo" },
  ],
  steps: [
    { id: "s1", verb: "grasp", object: "film", t_start_s: 0, t_end_s: 1, source: "demo" },
    { id: "s2", verb: "insert", object: "film", target: { fixture: "pocket", frame: "pillow" }, t_start_s: 1, t_end_s: 2, source: "demo" },
  ],
});

/**
 * Two programs in the compiler's format for DEMO_SPEC. Offsets are in the
 * object's frame (its centre): the film is gripped 8 mm below its 40 mm top,
 * so the jaws stay above the 30 mm pillow once it is seated. While the film is
 * held, move_to places the film's centre: +37 mm over the pillow's centre puts
 * its bottom 2 mm above the opening, +14 mm puts it on the pocket floor.
 */
const pick = {
  step_id: "s1",
  ops: [
    { op: "move_to", frame: "film", offset_mm: [0, 0, 47] },
    { op: "move_to", frame: "film", offset_mm: [0, 0, 12] },
    { op: "grasp", object: "film", aperture_mm: 6 },
    { op: "wait_until", predicate: { kind: "contact_both_pads", object: "film" }, timeout_s: 1 },
    { op: "move_to", frame: "film", offset_mm: [0, 0, 42] },
  ],
};
const seated = [
  { op: "wait_until", predicate: { kind: "object_still", object: "film" }, timeout_s: 3 },
  { op: "assert", predicate: { kind: "inside_zone", object: "film", target: "pillow" } },
];
export const DEMO_PROGRAMS = {
  /** "drop it in": let go at the slot mouth; gravity finishes the job, on Earth */
  release_early: Program.parse({
    spec_title: DEMO_SPEC.title,
    steps: [
      pick,
      {
        step_id: "s2",
        ops: [
          { op: "move_to", frame: "pillow", offset_mm: [0, 0, 37] },
          { op: "release" },
          { op: "wait_until", predicate: { kind: "inside_zone", object: "film", target: "pillow" }, timeout_s: 2 },
          ...seated,
        ],
      },
    ],
  }),
  /** keep gripping until the film is on the pocket floor, then let go */
  hold_until_seated: Program.parse({
    spec_title: DEMO_SPEC.title,
    steps: [
      pick,
      {
        step_id: "s2",
        ops: [
          { op: "move_to", frame: "pillow", offset_mm: [0, 0, 37] },
          { op: "move_to", frame: "pillow", offset_mm: [0, 0, 14] },
          { op: "wait_until", predicate: { kind: "inside_zone", object: "film", target: "pillow" }, timeout_s: 1 },
          { op: "release" },
          ...seated,
        ],
      },
    ],
  }),
};

/**
 * The pour on /stage: the measured setup of docs/MEASUREMENTS.md section 5 (a 40 x 40 x 50 mm cup holding
 * 38 mL, its rim 100 mm above the table, poured into a 60 x 60 mm opening whose centre is 56 mm beyond the
 * pour lip). The cup stands on a block at that height, so the arm grasps it from the front and tilts it in
 * place by rolling its wrist: carried first, an open cup in orbit would lose its water before the pour.
 */
export const POUR_SPEC = TaskSpec.parse({
  version: 1,
  title: "cup into bowl",
  summary: "Pick up the cup on the block and pour its water into the bowl beside it.",
  objects: [
    { id: "block", name: "block", shape: "box", size_mm: [60, 60, 46], symmetry: "none", role: "surface", pose: { xyz_mm: [300, 0, 23] }, source: "demo" },
    { id: "cup", name: "cup", shape: "box", size_mm: [48, 48, 54], symmetry: "none", role: "manipulated", liquid_ml: 38, pose: { xyz_mm: [300, 0, 73] }, source: "demo" },
    { id: "bowl", name: "bowl", shape: "box", size_mm: [68, 68, 40], symmetry: "none", role: "fixture", pose: { xyz_mm: [300, 80, 20] }, source: "demo" },
  ],
  steps: [
    {
      id: "s1",
      verb: "pour",
      object: "cup",
      pour: { into: "bowl", tilt_deg: 120, tilt_s: 1.5 },
      success: [{ kind: "liquid_inside", object: "cup", target: "bowl", value: 90 }],
      t_start_s: 0,
      t_end_s: 4,
      source: "demo",
    },
  ],
});

/** Grasp the cup from the front, tilt it toward the bowl about its rim, wait for the water, turn it back, let go. */
const pourWith = (deg: number, seconds: number, wait_s: number) =>
  Program.parse({
    spec_title: POUR_SPEC.title,
    steps: [
      {
        step_id: "s1",
        ops: [
          { op: "move_to", frame: "cup", offset_mm: [0, 0, 50], approach: "front" },
          { op: "move_to", frame: "cup", offset_mm: [0, 0, 0], approach: "front" },
          { op: "grasp", object: "cup", aperture_mm: 48 },
          { op: "tilt", deg, toward: "bowl", seconds },
          { op: "wait_until", predicate: { kind: "liquid_inside", object: "cup", target: "bowl", value: 90 }, timeout_s: wait_s },
          { op: "tilt", deg: 0, seconds },
          { op: "release" },
          { op: "move_to", frame: "cup", offset_mm: [0, 0, 50], approach: "front" },
          { op: "assert", predicate: { kind: "liquid_inside", object: "cup", target: "bowl", value: 90 } },
        ],
      },
    ],
  });

export const POUR_PROGRAMS = {
  /** the pour a person makes: 120° over 1.5 s */
  pour: pourWith(120, 1.5, 3),
  /** the same tilt over 3 s: on Earth it pours, in orbit the water stays in the cup */
  slow_pour: pourWith(120, 3, 3),
  /** turned over in one second, then held until the water lands or 8 s pass: the measured way to pour in orbit */
  flip_in_1_s: pourWith(180, 1, 8),
};
