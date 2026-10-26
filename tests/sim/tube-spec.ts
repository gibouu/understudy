import { TaskSpec } from "@/lib/spec/schema";

/** The first /stage scene, a 17 x 60 mm tube and a rack with a 20 mm pocket: the predicate tests place the tube by hand in it. */
export const TUBE_SPEC = TaskSpec.parse({
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
