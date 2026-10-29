/**
 * The prompt Super gets for similar tasks: the spec the arm just rehearsed,
 * the bench limits worked out for it (the numbers a variant must stay
 * within), and either no request (suggest 5) or one line from the
 * person. The examples come from other domains and use their own ids.
 */
import { footprintMm, heightMm, MM, SceneError, WALL_M, worldPoses } from "@/lib/sim/scene";
import type { TaskSpec } from "@/lib/spec/schema";
import { pourLine, pourOf, type Pour } from "./pour";

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

export const VARIANTS_SYSTEM = `You suggest similar tasks for a robot arm that has just rehearsed one task: a 5-DoF SO-101 arm with a parallel gripper, either one grasp from above and then one insert or place, or one pour from an open container it grips from the front into another. A variant is the same kind of task with something changed, written as changes to the task spec you are given. Return one compact JSON object only, no indentation:
{"variants":[{"title":string,"summary":string,"changes":[{"path":string,"value":any}]}],"not_yet":[{"idea":string,"why":string}]}
- title: 2 to 5 words naming what changed. summary: one sentence on what the arm now does differently.
- path is a spec path with ids in brackets; value replaces what is there. Only these can change:
  objects[<id>].size_mm  [x, y, z] in mm
  objects[<id>].shape with objects[<id>].symmetry: box with "none", cylinder with "axial", sphere with "full"
  objects[<id>].name
  objects[<id>].pose  {"xyz_mm":[x,y,z],"yaw_deg":number,"frame":"world" or an object id}
  objects[<id>].pocket_clearance_mm  on a fixture used as a pocket
  steps[<id>].verb  "insert" or "place", with steps[<id>].target.fixture  "pocket", "zone" or "stack", on a step that puts an object somewhere
  steps[<id>].pour  {"into":<the same target>,"tilt_deg":up to 180,"tilt_s":seconds}, on a pour: how far and how fast it tilts
  steps[<id>].object  on a pour, set to its pour.into to pour back: the liquid starts in that container and the arm pours it back
  steps[<id>].tolerances.<axis>, steps[<id>].success
  Nothing else: no new or removed objects or steps, no ids, roles, liquid amounts or times. A task keeps its kind: a step that puts an object somewhere never becomes a pour, and a pour stays a pour.
- Ideas the arm cannot do yet go under not_yet, with why in a few plain words; never squeeze them into changes. Not yet: pouring in a task that has no pour, waving or any gesture, wiping, pressing, screwing or turning a part, folding or anything soft, two hands, more than one grasp and one insert or place, more than one pour, an object that is not in the spec, anything outside the bench limits.
Rules:
- Without a request: 5 variants, each a different kind of change, some to the target and some to the object. Be inventive with what the spec can express: a bigger or smaller target, a tighter or looser fit, the target turned or moved, the target raised on a low shelf (its pose z up), the object starting somewhere else, the object starting inside the target so the arm takes it out and puts it back, a different size or shape of object, set on top instead of put in. For a pour: pouring it back, always, then a bigger or smaller target, a target with a lower rim (shorter) or standing higher (its pose z up), a stricter share of the liquid in the target, a faster or slower tilt; the held container is gripped where it stands and never starts anywhere else.
- With a request from the person: exactly one variant that does what they asked, or no variant and one not_yet entry that says plainly what the arm cannot do yet. The person may call an object something else (a jar for a pot, a tank for a reservoir): change that object, by its id. Ids never change; a new name changes only objects[<id>].name.
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
{"idea":"Pour water into the bin","why":"this task puts a bolt in the bin; it has no pour"}
A lab beaker of buffer (box [44,44,60]) is poured into a flask (box fixture [70,70,90]) in s2, success liquid_inside of the beaker's buffer in the flask, 85:
{"title":"Pour it back","summary":"The buffer starts in the flask and the arm pours it back into the beaker.","changes":[{"path":"steps[s2].object","value":"flask"}]}
{"title":"Stricter transfer","summary":"95% of the buffer has to reach the flask instead of 85%.","changes":[{"path":"steps[s2].success","value":[{"kind":"liquid_inside","object":"beaker","target":"flask","value":95}]}]}
A mug of tea (cylinder [46,46,52]) is poured into a teapot (box fixture [90,90,60]) in s1 with pour {"into":"teapot","tilt_deg":120,"tilt_s":1.5}:
{"title":"Turned over faster","summary":"The mug turns all the way over in one second.","changes":[{"path":"steps[s1].pour","value":{"into":"teapot","tilt_deg":180,"tilt_s":1}}]}
A jug of coolant (box [40,40,70]) is emptied into an engine's reservoir (box fixture [120,90,50]) in s1:
{"title":"Narrow reservoir","summary":"The reservoir is half as wide, so the stream has a smaller opening to land in.","changes":[{"path":"objects[reservoir].size_mm","value":[60,60,50]}]}
{"title":"Reservoir on a shelf","summary":"The reservoir stands 20 mm higher, closer to the jug's rim.","changes":[{"path":"objects[reservoir].pose","value":{"xyz_mm":[300,95,45],"yaw_deg":0,"frame":"world"}}]}`;

/** The numbers a pour's variant must stay within: the container the arm pours from, the one it pours into, the tilt and the check. */
function pourFacts(spec: TaskSpec, step: Pour): string {
  const held = spec.objects.find((o) => o.id === step.object);
  const into = spec.objects.find((o) => o.id === step.pour.into);
  if (!held || !into) return "- The pour names a container that is not in the spec: no variant of it can be rehearsed.";
  let world: ReturnType<typeof worldPoses>;
  try {
    world = worldPoses(spec);
  } catch (err) {
    if (err instanceof SceneError) return `- The task's layout cannot be built (${err.message}): no variant of it can be rehearsed.`;
    throw err;
  }
  const bottom = (o: typeof held) => world[o.id].xyz_mm[2] - heightMm(o) / 2;
  const at = (o: typeof held) => `at (${r1(world[o.id].xyz_mm[0])}, ${r1(world[o.id].xyz_mm[1])}) mm, its bottom ${r1(bottom(o))} mm and its rim ${r1(bottom(o) + heightMm(o))} mm above the table`;
  const [lo, hi] = BENCH.heldSideMm;
  const wide = Math.max(...footprintMm(into));
  const gap = r1(pourLine(spec, step, world).gap);
  const liquid = held.liquid_ml !== undefined ? `, holding ${held.liquid_ml} mL` : "";
  const checks = step.success.map((p) => [p.kind, p.object && `of ${p.object}`, p.target && `in ${p.target}`, p.value !== undefined && `${p.value}`].filter(Boolean).join(" "));
  return [
    `- ${held.id} "${held.name}" is held and poured: ${held.shape} ${held.size_mm.join(" x ")} mm, ${at(held)}${liquid}. The arm grips it from the front at its centre and tilts it about its rim toward ${into.id}, where it stands: it never lifts, carries or moves ${held.id}, so no summary says it does; a farther or higher ${into.id} is ${into.id} moved, not ${held.id} carried. The jaws hold ${lo} to ${hi} mm across. Leave its pose out, even when you resize it: a front grip reaches only about where it stands, and the bench keeps it there with its bottom at the same height. It never starts inside ${into.id} or anywhere else.`,
    `- ${into.id} "${into.name}" is the target, an open container: ${into.shape} ${into.size_mm.join(" x ")} mm, ${at(into)}, about ${gap} mm from ${held.id}'s rim. It can be bigger or smaller (sides up to ${BENCH.fixtureSideMaxMm} mm), shorter or taller, stand on a shelf (give its pose in frame "world", where z is its centre's height, now ${r1(world[into.id].xyz_mm[2])} mm: raised d mm, its z is ${r1(world[into.id].xyz_mm[2])} + d, and a summary names the rise d, not the new z) or further off; its rim has to stay below ${held.id}'s rim, where the liquid leaves. To resize it, change only its size_mm: the bench then keeps its bottom at the same height and the same gap to ${held.id}'s rim. A pose you give is kept as given.`,
    `- The pour: step ${step.id} tilts ${held.id} ${step.pour.tilt_deg} degrees over ${step.pour.tilt_s ?? 1.5} s. A faster or slower tilt is a new steps[${step.id}].pour, whole, with the same into: tilt_deg up to 180, tilt_s in seconds.`,
    `- Pouring back is this one change: {"path":"steps[${step.id}].object","value":"${into.id}"}. The liquid then starts in ${into.id}, the arm holds ${into.id} where ${held.id} stood and pours it into ${held.id}, and the success check turns round with it.${wide > hi ? ` ${into.id} is ${wide} mm across, so the jaws hold it narrowed to ${hi} mm.` : ""}`,
    `- Success: ${checks.join("; ") || "none yet"}. A share of the liquid can rise (stricter), never fall.`,
  ].join("\n");
}

/** The numbers a variant of this spec must stay within, worked out from its held object and its target. */
export function benchFacts(spec: TaskSpec): string {
  const pour = pourOf(spec);
  if (pour) return pourFacts(spec, pour);
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
    objects: spec.objects.map(({ id, name, shape, size_mm, symmetry, role, pose, pocket_clearance_mm, liquid_ml }) => ({ id, name, shape, size_mm, symmetry, role, pose, pocket_clearance_mm, liquid_ml })),
    steps: spec.steps.map(({ id, verb, object, target, pour, success, tolerances }) => ({ id, verb, object, target, pour, success, tolerances })),
  };
}

export const MAX_REQUEST_CHARS = 200;

export function userMessage(spec: TaskSpec, request?: string): string {
  const ask = request
    ? `Request from the person: ${JSON.stringify(request)}\nTurn it into one variant, or say under not_yet what the arm cannot do yet.`
    : "No request: suggest 5 variants, each a different kind of change.";
  return `Task spec the arm just rehearsed:\n${JSON.stringify(view(spec))}\n\nBench limits for this spec:\n${benchFacts(spec)}\n\n${ask}`;
}
