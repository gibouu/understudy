import { TaskSpec } from "@/lib/spec/schema";

/**
 * The scene every measurement in tests/measure ran on (25 October 2026): a
 * 17 x 100 mm tube standing on the table and a 60 x 60 x 40 mm rack with a
 * 20 mm pocket and 3 mm of clearance. It is pinned here, apart from
 * lib/sim/demo-spec.ts, so the published numbers in docs/MEASUREMENTS.md
 * stay reproducible when the stage demo's scene changes (it switched to a
 * 60 mm tube for the interpreter on 25 October).
 */
export const MEASURE_SPEC = TaskSpec.parse({
  version: 1,
  title: "tube into rack",
  summary: "Pick up the tube and put it into the rack's pocket.",
  objects: [
    { id: "tube", name: "tube", shape: "cylinder", size_mm: [17, 17, 100], symmetry: "axial", role: "manipulated", pose: { xyz_mm: [200, -100, 50] }, source: "demo" },
    { id: "rack", name: "rack", shape: "box", size_mm: [60, 60, 40], symmetry: "none", role: "fixture", pocket_clearance_mm: 3, pose: { xyz_mm: [175, 100, 20] }, source: "demo" },
  ],
  steps: [
    { id: "s1", verb: "grasp", object: "tube", t_start_s: 0, t_end_s: 1, source: "demo" },
    { id: "s2", verb: "insert", object: "tube", target: { fixture: "pocket", frame: "rack" }, t_start_s: 1, t_end_s: 2, source: "demo" },
  ],
});
