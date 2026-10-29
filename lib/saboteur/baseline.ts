/**
 * The scoreboard's baseline (issue #55): "retarget and replay", the standard approach the interview is measured
 * against. A program written by fixed rules from the label's steps as the fit laid them on the bench, with no model
 * and no answers: for each step, in the order the person did them, take the object (above it, down to the grip
 * point 8 mm below its top, close to its narrower side, lift) and let go where the step puts it (20 mm over the
 * target, then the object's bottom 1 mm above the target's top, or on the pocket floor for a pocket); a pour tilts
 * by the label's angle and back, with no wait. Via-points the label recorded from the hand are passed through on
 * the way. No waits, no checks: the rollout passes only where the spec's success holds, as for every version.
 * The heights are the ones the compile route hands the compiling model (app/api/compile/route.ts geometry).
 *
 * It is built only where those rules reach: a step the label gives no target (where the person put it was an
 * answer), or a frame the scored spec no longer has, gives the reason instead of a program.
 */
import { footprintMm, MM, WALL_M } from "@/lib/sim/scene";
import type { Program, ProgramOp, TaskSpec } from "@/lib/spec/schema";

export type Baseline = { program: Program } | { why: string };

const r1 = (x: number) => Math.round(x * 10) / 10;

export function baselineProgram(label: TaskSpec, scored: TaskSpec): Baseline {
  const obj = (id: string) => label.objects.find((o) => o.id === id);
  const top = (frame: string, z: number): ProgramOp => ({ op: "move_to", frame, offset_mm: [0, 0, r1(z)], approach: "top" });
  const front = (frame: string, z: number): ProgramOp => ({ op: "move_to", frame, offset_mm: [0, 0, r1(z)], approach: "front" });
  let held: string | null = null;
  const steps: Program["steps"] = [];
  let moves = 0;

  const take = (id: string): ProgramOp[] => {
    if (held === id) return [];
    const o = obj(id)!;
    const grip = Math.max(0, o.size_mm[2] / 2 - 8);
    const ops: ProgramOp[] = [...(held ? [{ op: "release" } as const] : []), top(id, grip + 50), top(id, grip), { op: "grasp", object: id, aperture_mm: Math.min(...footprintMm(o)) }, top(id, 50)];
    held = id;
    return ops;
  };

  for (const s of label.steps) {
    if (s.verb === "gesture") return { why: "a gesture moves nothing, so there is nothing to retarget onto the bench" };
    const id = s.object!;
    if (!obj(id)) return { why: `step ${s.id} handles ${id}, which the label has no object for` };
    const via: ProgramOp[] = s.via_points.map((v) => ({ op: "move_to", frame: v.frame, offset_mm: v.xyz_mm, approach: "top" }));
    if (s.verb === "pour") {
      if (!s.pour) return { why: `step ${s.id} pours with no angle in the label` };
      const o = obj(id)!;
      const ops: ProgramOp[] = [
        ...(held && held !== id ? [{ op: "release" } as const] : []),
        front(id, 50),
        front(id, 0),
        { op: "grasp", object: id, aperture_mm: Math.min(...footprintMm(o)) },
        ...via,
        { op: "tilt", deg: s.pour.tilt_deg, toward: s.pour.into, seconds: s.pour.tilt_s ?? 1.5 },
        { op: "tilt", deg: 0, seconds: s.pour.tilt_s ?? 1.5 },
        { op: "release" },
        front(id, 50),
      ];
      held = null;
      moves++;
      steps.push({ step_id: s.id, ops });
      continue;
    }
    if (s.target) {
      const f = obj(s.target.frame);
      if (!f) return { why: `step ${s.id} puts ${id} on ${s.target.frame}, which the label has no object for` };
      const o = obj(id)!;
      const surface = f.size_mm[2] / 2;
      const half = o.size_mm[2] / 2;
      const down = s.target.fixture === "pocket" ? -surface + Math.min(WALL_M / MM, surface) + half : surface + half + 1;
      steps.push({ step_id: s.id, ops: [...take(id), ...via, top(f.id, surface + half + 20), top(f.id, down), { op: "release" }] });
      held = null;
      moves++;
      continue;
    }
    if (s.verb === "place" || s.verb === "insert") return { why: `the label gives step ${s.id} nowhere to go: where it went was an answer` };
    // reach, grasp, move, release, retract with nowhere to go: the hand takes the object, or lets it go
    steps.push({ step_id: s.id, ops: s.verb === "release" || s.verb === "retract" ? (held ? ((held = null), [{ op: "release" }]) : []) : [...take(id), ...via] });
  }
  if (moves === 0) return { why: "the label has no step that puts an object somewhere" };
  const frames = new Set(["world", ...scored.objects.map((o) => o.id)]);
  const missing = steps.flatMap((s) => s.ops).flatMap((op) => (op.op === "move_to" ? [op.frame] : op.op === "grasp" ? [op.object] : [])).find((f) => !frames.has(f));
  if (missing) return { why: `the scored spec has no ${missing}, which the label's steps use` };
  return { program: { spec_title: label.title, steps, warnings: [] } };
}
