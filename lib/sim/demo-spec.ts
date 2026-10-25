import { Program, TaskSpec } from "@/lib/spec/schema";

/**
 * The /stage scene until a compiled spec arrives: a 17 x 100 mm tube standing
 * on the table and a rack with a 20 mm pocket. Top-down reach ends near
 * z = 90 mm: the tube's mid-height and 50 mm above the pocket must both
 * solve, which tests/sim/demo-spec.test.ts checks.
 */
export const DEMO_SPEC = TaskSpec.parse({
  version: 1,
  title: "tube into rack",
  summary: "Pick up the tube and put it into the rack's pocket.",
  objects: [
    { id: "tube", name: "tube", shape: "cylinder", size_mm: [17, 17, 60], symmetry: "axial", role: "manipulated", pose: { xyz_mm: [200, -100, 30] }, source: "demo" },
    { id: "rack", name: "rack", shape: "box", size_mm: [60, 60, 40], symmetry: "none", role: "fixture", pocket_clearance_mm: 3, pose: { xyz_mm: [175, 100, 20] }, source: "demo" },
  ],
  steps: [
    { id: "s1", verb: "grasp", object: "tube", t_start_s: 0, t_end_s: 1, source: "demo" },
    { id: "s2", verb: "insert", object: "tube", target: { fixture: "pocket", frame: "rack" }, t_start_s: 1, t_end_s: 2, source: "demo" },
  ],
});

/**
 * Two programs in the compiler's format for DEMO_SPEC. Offsets are in the
 * object's frame (its centre): the tube is gripped 17 mm below its 60 mm top,
 * so the jaws stay above the 40 mm rack once it is seated. While the tube is
 * held, move_to places the tube's centre: +52 mm over the rack's centre puts
 * its bottom 2 mm above the opening, +19 mm puts it on the pocket floor.
 */
const pick = {
  step_id: "s1",
  ops: [
    { op: "move_to", frame: "tube", offset_mm: [0, 0, 48] },
    { op: "move_to", frame: "tube", offset_mm: [0, 0, 13] },
    { op: "grasp", object: "tube", aperture_mm: 17 },
    { op: "wait_until", predicate: { kind: "contact_both_pads", object: "tube" }, timeout_s: 1 },
    { op: "move_to", frame: "tube", offset_mm: [0, 0, 42] },
  ],
};
const seated = [
  { op: "wait_until", predicate: { kind: "object_still", object: "tube" }, timeout_s: 3 },
  { op: "assert", predicate: { kind: "inside_zone", object: "tube", target: "rack" } },
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
          { op: "move_to", frame: "rack", offset_mm: [0, 0, 52] },
          { op: "release" },
          { op: "wait_until", predicate: { kind: "inside_zone", object: "tube", target: "rack" }, timeout_s: 2 },
          ...seated,
        ],
      },
    ],
  }),
  /** keep gripping until the tube is on the pocket floor, then let go */
  hold_until_seated: Program.parse({
    spec_title: DEMO_SPEC.title,
    steps: [
      pick,
      {
        step_id: "s2",
        ops: [
          { op: "move_to", frame: "rack", offset_mm: [0, 0, 52] },
          { op: "move_to", frame: "rack", offset_mm: [0, 0, 19] },
          { op: "wait_until", predicate: { kind: "inside_zone", object: "tube", target: "rack" }, timeout_s: 1 },
          { op: "release" },
          ...seated,
        ],
      },
    ],
  }),
};
