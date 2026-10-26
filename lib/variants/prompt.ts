/**
 * The prompt Super gets for similar tasks: the spec the arm just rehearsed,
 * the bench limits worked out for it (the numbers a variant must stay
 * within), and either no request (suggest 5) or one line from the
 * person. The examples come from other domains and use their own ids.
 */
import { footprintMm, heightMm, MM, WALL_M } from "@/lib/sim/scene";
import type { TaskSpec } from "@/lib/spec/schema";

/**
 * Limits `fitToBench` (lib/sim/fit.ts) holds a spec to; tests/variants/validate.test.ts
 * checks them against it. The jaws open to 60 mm.
 */
export const BENCH = {
  heldSideMm: [6, 50],
  heldMaxHeightMm: 40,
  fixtureSideMaxMm: 150,
  fixtureHeightMm: [10, 30],
  maxClearanceMm: 20,
} as const;
/** Measured headless on the ISS sample (tests/variants/bench.test.ts): centres this far from the base reach. */
export const SPOT_RING_MM = [150, 250] as const;
/**
 * Measured the same way: the gripper reaches down from above up to about
 * 95 mm over the table. A 40 mm object carried with its bottom 20 mm over a
 * target reaches it while the target's top is at 44 mm and not at 46 mm.
 */
export const TOP_DOWN_REACH_MM = 95;
/** The compile route grips 8 mm below an object's top and carries it 20 mm over the target. */
const GRIP_BELOW_TOP_MM = 8;
const CARRY_OVER_MM = 20;

const r1 = (x: number) => Math.round(x * 10) / 10;

export const VARIANTS_SYSTEM = `You suggest similar tasks for a robot arm that has just rehearsed one task: a 5-DoF SO-101 arm with a parallel gripper that grasps from above, one grasp and then one insert or place. A variant is the same kind of task with something changed, written as changes to the task spec you are given. Return one compact JSON object only, no indentation:
{"variants":[{"title":string,"summary":string,"changes":[{"path":string,"value":any}]}],"not_yet":[{"idea":string,"why":string}]}
- title: 2 to 5 words naming what changed. summary: one sentence on what the arm now does differently.
- path is a spec path with ids in brackets; value replaces what is there. Only these can change:
  objects[<id>].size_mm  [x, y, z] in mm
  objects[<id>].shape with objects[<id>].symmetry: box with "none", cylinder with "axial", sphere with "full"
  objects[<id>].name
  objects[<id>].pose  {"xyz_mm":[x,y,z],"yaw_deg":number,"frame":"world" or an object id}
  objects[<id>].pocket_clearance_mm  on a fixture used as a pocket
  steps[<id>].verb  "insert" or "place", with steps[<id>].target.fixture  "pocket", "zone" or "stack"
  steps[<id>].tolerances.<axis>, steps[<id>].success
  Nothing else: no new or removed objects or steps, no ids, roles or times.
- Ideas the arm cannot do yet go under not_yet, with why in a few plain words; never squeeze them into changes. Not yet: pouring a liquid, waving or any gesture, wiping, pressing, screwing or turning a part, folding or anything soft, two hands, more than one grasp and one insert or place, an object that is not in the spec, anything outside the bench limits.
Rules:
- Without a request: 5 variants, each a different kind of change, some to the target and some to the object. Be inventive with what the spec can express: a bigger or smaller target, a tighter or looser fit, the target turned or moved, the target raised on a low shelf (its pose z up), the object starting somewhere else, the object starting inside the target so the arm takes it out and puts it back, a different size or shape of object, set on top instead of put in.
- With a request from the person: exactly one variant that does what they asked, or no variant and one not_yet entry that says plainly what the arm cannot do yet.
- Stay inside the bench limits you are given: the rehearsal runs the variant as written, and a value outside them is out of reach or does not fit.
- Keep every value you do not mean to change; what the person already answered (clearances, tolerances, success checks) carries over. A success check can be added or tightened, never removed or loosened: a pass must mean the same task done.
- One or two changes per variant. Write each value whole: a pose with all three fields, a size with all three numbers.
Examples from other tasks (their ids and numbers are theirs, not yours):
A vial (cylinder, size_mm [14,14,45]) goes into a rack hole (box fixture [80,40,30], pocket, clearance 2):
{"title":"Wider vial","summary":"The same rack takes a wider vial with the same 2 mm of play.","changes":[{"path":"objects[vial].size_mm","value":[20,20,45]}]}
{"title":"Vial starts in the rack","summary":"The arm takes the vial out of its hole and puts it back.","changes":[{"path":"objects[vial].pose","value":{"xyz_mm":[0,0,15.5],"yaw_deg":0,"frame":"rack"}}]}
A block of butter (box [40,30,20]) is set on a plate (cylinder fixture [120,120,15], zone):
{"title":"Plate further left","summary":"The plate sits 60 mm further left, so the arm carries the block further.","changes":[{"path":"objects[plate].pose","value":{"xyz_mm":[180,160,7.5],"yaw_deg":0,"frame":"world"}}]}
A bolt (cylinder [10,10,30]) is dropped into a parts bin (box fixture [100,100,30], pocket, clearance 15):
{"title":"Tight bin","summary":"4 mm of play instead of 15: the bolt has to go in straight.","changes":[{"path":"objects[bin].pocket_clearance_mm","value":4}]}
{"idea":"Pour the washers into the bin","why":"the arm cannot pour yet"}`;

/** The numbers a variant of this spec must stay within, worked out from its held object and its target. */
export function benchFacts(spec: TaskSpec): string {
  const act = spec.steps.find((s) => (s.verb === "insert" || s.verb === "place") && s.target);
  const held = act && spec.objects.find((o) => o.id === act.object);
  const target = act && spec.objects.find((o) => o.id === act.target!.frame);
  if (!act || !held || !target) return "- The task has no step that puts one object into or onto another: no variant of it can be rehearsed.";
  const pocket = act.target!.fixture === "pocket";
  const at = (o: typeof held) => (o.pose ? `at (${r1(o.pose.xyz_mm[0])}, ${r1(o.pose.xyz_mm[1])}) mm in frame "${o.pose.frame}", pose z ${r1(o.pose.xyz_mm[2])}` : "with no pose yet");
  const h = heightMm(held);
  const top = heightMm(target) / 2 + (target.pose?.frame === "world" ? target.pose.xyz_mm[2] : heightMm(target) / 2);
  const ownTop = heightMm(target) / 2;
  const maxTop = TOP_DOWN_REACH_MM - CARRY_OVER_MM - (h - GRIP_BELOW_TOP_MM);
  const minSide = Math.max(...footprintMm(held)) + 2 * BENCH.maxClearanceMm;
  const gap = r1((Math.hypot(...footprintMm(held)) + Math.hypot(...footprintMm(target))) / 2 + 20);
  const lines = [
    `- ${held.id} "${held.name}" is held: ${held.shape} ${held.size_mm.join(" x ")} mm, ${at(held)} (an object resting on the table has pose z = half its height). The jaws open to 60 mm: ${pocket ? `it goes into the pocket standing on its longest side, so that side is its height, at most ${BENCH.heldMaxHeightMm} mm, and its other sides ${BENCH.heldSideMm[0]} mm to its height` : `keep its sides ${BENCH.heldSideMm[0]} to ${BENCH.heldSideMm[1]} mm and its height ${BENCH.heldSideMm[0]} to ${BENCH.heldMaxHeightMm} mm`}.`,
    `- ${target.id} "${target.name}" is the target, used as a ${act.target!.fixture}: ${target.shape} ${target.size_mm.join(" x ")} mm, ${at(target)}, its top ${r1(top)} mm above the table${pocket ? `; pocket clearance ${target.pocket_clearance_mm ?? "not set"} mm (0 to ${BENCH.maxClearanceMm} mm rehearsed)` : ""}. Keep its sides ${minSide} to ${BENCH.fixtureSideMaxMm} mm and its height ${BENCH.fixtureHeightMm[0]} to ${BENCH.fixtureHeightMm[1]} mm; it can be a box or a cylinder, not a sphere.`,
    `- Spots: the world frame is the robot's base on the table, x away from the robot, y to its left, z up. Objects whose centres are ${SPOT_RING_MM[0]} to ${SPOT_RING_MM[1]} mm from the base are in reach. Keep the two centres at least ${gap} mm apart so their footprints stay clear of each other.`,
    maxTop - top > 2
      ? `- Height: carrying ${held.id} over ${target.id}, the gripper is ${CARRY_OVER_MM + h - GRIP_BELOW_TOP_MM} mm above ${target.id}'s top and reaches down from above only up to about ${TOP_DOWN_REACH_MM} mm over the table, so ${target.id}'s top can rise to about ${r1(maxTop)} mm (now ${r1(top)} mm): a shelf, its pose z raised, of up to ${r1(maxTop - top)} mm.`
      : `- Height: with ${held.id} ${h} mm tall, ${target.id}'s top cannot rise: there is no room for a shelf (a shorter ${held.id} makes some).`,
  ];
  if (pocket) {
    const floor = -ownTop + Math.min(WALL_M / MM, ownTop);
    lines.push(`- ${held.id} starting inside ${target.id}, on its pocket floor: pose {"xyz_mm":[0,0,${r1(floor + h / 2)}],"yaw_deg":0,"frame":"${target.id}"}; an object of height h rests there at z = ${r1(floor)} + h/2.`);
  }
  return lines.join("\n");
}

/** The fields of the spec a variant reads; provenance and timing stay out of the prompt. */
function view(spec: TaskSpec) {
  return {
    title: spec.title,
    summary: spec.summary,
    objects: spec.objects.map(({ id, name, shape, size_mm, symmetry, role, pose, pocket_clearance_mm }) => ({ id, name, shape, size_mm, symmetry, role, pose, pocket_clearance_mm })),
    steps: spec.steps.map(({ id, verb, object, target, success, tolerances }) => ({ id, verb, object, target, success, tolerances })),
  };
}

export const MAX_REQUEST_CHARS = 200;

export function userMessage(spec: TaskSpec, request?: string): string {
  const ask = request
    ? `Request from the person: ${JSON.stringify(request)}\nTurn it into one variant, or say under not_yet what the arm cannot do yet.`
    : "No request: suggest 5 variants, each a different kind of change.";
  return `Task spec the arm just rehearsed:\n${JSON.stringify(view(spec))}\n\nBench limits for this spec:\n${benchFacts(spec)}\n\n${ask}`;
}
