/**
 * The prompt the patching model gets for the saboteur: the spec's objects
 * (shape, symmetry, size, pose, clearance), the step the grid is about and
 * the tightest constraint worked out for it (lib/saboteur/grid.ts focusOf),
 * and the rules a scenario must follow. The examples come from other domains
 * and use their own ids.
 */
import type { TaskSpec } from "@/lib/spec/schema";
import { GRID_AXES, MAX_SHIFT_MM, MAX_TURN_DEG, SCENARIO_COUNT, type Focus } from "./grid";

export const SABOTEUR_SYSTEM = `You are the saboteur for a robot rehearsal. A scripted program for a 5-DoF SO-101 arm with a parallel gripper has just passed in simulation (rigid bodies, a geometric grasp). You write ${SCENARIO_COUNT} perturbations of its world that probe where it breaks. Each one runs twice: blind (the program is told the nominal poses while the world is perturbed: how much pose error the task survives without perception) and sensed (the program is told the true poses). Return one compact JSON object only, no indentation:
{"scenarios":[{"id":string,"name":string,"axis":string,"offset":number,"object":string,"tilt_axis":"x"|"y","expected":"pass"|"fail"|"unknown","why":string}]}
- exactly ${SCENARIO_COUNT} scenarios, each a single perturbation of one object on one axis; ids short and unique (like "rack-x+3").
- axis is one of ${GRID_AXES.join(", ")}. x_mm, y_mm, z_mm shift the object in mm; yaw_deg turns it about the vertical; tilt_deg tips it off level about tilt_axis (give tilt_axis only for tilt_deg); clearance_mm widens (+) or narrows (-) a pocket, only on a fixture used as a pocket.
- offset is signed, never 0, at most ${MAX_SHIFT_MM} mm or ${MAX_TURN_DEG}°.
- object is an object id from the spec.
- expected is what you expect in blind mode; why is one short line.
Choose from the spec, not from habit:
- The tightest constraint is given to you: spend most scenarios there. Move the target on x_mm and y_mm on a ladder around the band (inside it, at it, beyond it) and on both sides, so the report can say how much pose error the task survives: at least 4 scenarios move the target on x_mm or y_mm.
- Use symmetry: never yaw an object with axial or full symmetry (a cylinder or a sphere looks the same turned); yaw a box target when its pocket or footprint has a front.
- Then the slot clearance (narrower), the target tilted a few degrees, the held object's own pose error, and an obstacle moved into the path when the spec has one.
- Gravity is not yours to set: every scenario is run on Earth and in orbit by the page.
Examples from other tasks (their ids and numbers are theirs, not yours):
A vial (cylinder, axial) goes into a rack hole (box fixture, pocket, clearance 2 mm, band 1 mm):
{"id":"rack-x+1","name":"rack 1 mm off on x","axis":"x_mm","offset":1,"object":"rack","expected":"pass","why":"at the band: the vial still clears the rim"}
{"id":"rack-y-2","name":"rack 2 mm off on y","axis":"y_mm","offset":-2,"object":"rack","expected":"fail","why":"twice the band: the vial lands on the rim"}
{"id":"rack-clear-1","name":"hole 1 mm narrower","axis":"clearance_mm","offset":-1,"object":"rack","expected":"fail","why":"half the play left"}
A cup (cylinder) is set on a coaster (box fixture, zone, band 15 mm), a lamp (obstacle) beside it:
{"id":"coaster-yaw+10","name":"coaster turned 10°","axis":"yaw_deg","offset":10,"object":"coaster","expected":"pass","why":"a square zone turned a little still holds the cup"}
{"id":"lamp-y-20","name":"lamp 20 mm closer","axis":"y_mm","offset":-20,"object":"lamp","expected":"unknown","why":"the carry may pass close to it"}`;

export function userMessage(spec: TaskSpec, focus: Focus): string {
  const objects = spec.objects.map((o) => ({
    id: o.id,
    name: o.name,
    role: o.role,
    shape: o.shape,
    symmetry: o.symmetry,
    size_mm: o.size_mm,
    ...(o.pose ? { pose: o.pose } : {}),
    ...(o.pocket_clearance_mm !== undefined ? { pocket_clearance_mm: o.pocket_clearance_mm } : {}),
  }));
  const steps = spec.steps.map((s) => ({ id: s.id, verb: s.verb, object: s.object, ...(s.target ? { target: s.target } : {}), ...(Object.keys(s.tolerances).length ? { tolerances: s.tolerances } : {}) }));
  return [
    `Task: ${spec.title}. ${spec.summary}`,
    `Objects: ${JSON.stringify(objects)}`,
    `Steps: ${JSON.stringify(steps)}`,
    `The grid is about step ${focus.step_id}: the ${focus.object.name} ("${focus.object.id}") goes ${focus.fixture === "pour" ? "poured into" : `into the ${focus.fixture} of`} the ${focus.target.name} ("${focus.target.id}", ${focus.target.symmetry} symmetry).`,
    `Tightest constraint: a band of ${focus.band_mm} mm, ${focus.band_from}.`,
    focus.obstacles.length ? `Obstacles: ${focus.obstacles.map((o) => `"${o.id}"`).join(", ")}.` : "No obstacles.",
    `Write the ${SCENARIO_COUNT} scenarios.`,
  ].join("\n");
}
