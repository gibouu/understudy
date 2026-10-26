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
