/**
 * The ISS sample as the guided flow leaves it in replay mode (label, fit, the
 * two questions answered with the form's first choices), its recorded
 * program, and headless rollouts of any spec and program at a gravity.
 */
import type { MainModule } from "@mujoco/mujoco";
import labels from "@/tests/fixtures/label.json";
import { POST as compile } from "@/app/api/compile/route";
import { environment, runToEnd } from "@/lib/sim/interpreter";
import { fitToBench } from "@/lib/sim/fit";
import { footprintMm, MM, WALL_M } from "@/lib/sim/scene";
import { stageXml } from "@/lib/sim/so101";
import { loadSo101 } from "@/lib/sim/so101-disk";
import { formFor } from "@/lib/spec/answer";
import { applyChanges } from "@/lib/spec/apply";
import { Program, TaskSpec, type Predicate, type SpecChange } from "@/lib/spec/schema";
import type { StageResult } from "@/lib/spec/stage-result";

let mujoco: MainModule;

export async function loadSim() {
  mujoco = await loadSo101();
}

export function rollout(spec: TaskSpec, program: Program, gravity_g: number) {
  const env = environment(spec, { id: "t", name: "t", axis: "x_mm", offset: 0, object: spec.objects[0].id, expected: "unknown", why: "", gravity_g });
  const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: env.gravity_g, graspable: env.graspable }));
  const data = new mujoco.MjData(model);
  try {
    return runToEnd({ mujoco, model, data }, env, program, "sensed");
  } finally {
    data.delete();
    model.delete();
  }
}

export async function postCompile(spec: TaskSpec, previous?: Program, replay = true): Promise<StageResult<Program>> {
  const res = await compile(new Request(`http://test/api/compile${replay ? "?replay=1" : ""}`, { method: "POST", body: JSON.stringify({ spec, previous }) }));
  return res.json();
}

/** The fitted ISS label with the asks of its replayed compile answered: 10 mm of clearance, "ends up in it and stays there". */
export async function issBase(): Promise<{ spec: TaskSpec; program: Program }> {
  const fitted = fitToBench(TaskSpec.parse((labels[0].result as { value: unknown }).value)).spec;
  const first = await postCompile(fitted);
  if (first.status !== "done") throw new Error("no replayed compile for the ISS sample");
  const changes: SpecChange[] = [];
  for (const op of first.value.steps.flatMap((s) => s.ops)) {
    if (op.op !== "ask") continue;
    const form = formFor(fitted, op.slot);
    const value: number | Predicate[] = form.kind === "success" ? form.options[0].predicates : 10;
    changes.push({ path: op.slot, value, source: "interview#1" });
  }
  const { spec, warnings } = applyChanges(fitted, changes);
  if (warnings.length) throw new Error(warnings.join("; "));
  const answered = await postCompile(spec, first.value);
  if (answered.status !== "done") throw new Error("no replayed compile for the answered ISS sample");
  return { spec, program: answered.value };
}

/**
 * The program the compile route's ready moves spell out, written by hand:
 * grip 8 mm below the top, lift, carry 20 mm over the target, then down to
 * the pocket floor (or 1 mm over a zone) before letting go. Measures what the
 * bench reaches without a model in the loop.
 */
export function heldUntilSeated(spec: TaskSpec): Program {
  const s2 = spec.steps.find((s) => s.target)!;
  const h = spec.objects.find((o) => o.id === s2.object)!;
  const f = spec.objects.find((o) => o.id === s2.target!.frame)!;
  const grip = Math.max(0, h.size_mm[2] / 2 - 8);
  const top = f.size_mm[2] / 2;
  const half = h.size_mm[2] / 2;
  const to = (frame: string, z: number) => ({ op: "move_to" as const, frame, offset_mm: [0, 0, z] as [number, number, number], approach: "top" as const });
  const down = s2.target!.fixture === "pocket" ? -top + Math.min(WALL_M / MM, top) + half : top + half + 1;
  return Program.parse({
    spec_title: spec.title,
    steps: [
      { step_id: spec.steps[0].id, ops: [to(h.id, grip + 50), to(h.id, grip), { op: "grasp", object: h.id, aperture_mm: Math.min(...footprintMm(h)) }, { op: "wait_until", predicate: { kind: "contact_both_pads", object: h.id }, timeout_s: 1 }, to(h.id, 50)] },
      { step_id: s2.id, ops: [to(f.id, top + half + 20), to(f.id, down), { op: "release" }, { op: "wait_until", predicate: { kind: "object_still", object: h.id }, timeout_s: 2 }, { op: "assert", predicate: { kind: "inside_zone", object: h.id, target: f.id } }] },
    ],
  });
}
