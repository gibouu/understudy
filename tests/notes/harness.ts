/**
 * The ISS sample the way the page plays it without a key: the recorded label,
 * fitted to the bench, the recorded compile, then the same 1 g / 0 g
 * rehearsal app/rehearsal.tsx runs (nominal scene, sensed, from home).
 */
import type { MainModule } from "@mujoco/mujoco";
import labels from "@/tests/fixtures/label.json";
import { POST as compile } from "@/app/api/compile/route";
import { outcomeLine, type WorldRun } from "@/lib/notes/note";
import { MAX_PATCHES, type Attempt, type NotePatch } from "@/lib/notes/patch";
import { fitToBench } from "@/lib/sim/fit";
import { formFor } from "@/lib/spec/answer";
import { applyChanges } from "@/lib/spec/apply";
import { environment, runToEnd } from "@/lib/sim/interpreter";
import { stageXml } from "@/lib/sim/so101";
import { loadSo101 } from "@/lib/sim/so101-disk";
import { GRAVITIES, TaskSpec, type GravityName, type Program } from "@/lib/spec/schema";
import type { StageResult } from "@/lib/spec/stage-result";

export const WORLDS: GravityName[] = ["earth", "orbit"];

let sim: { mujoco: MainModule } | null = null;

export async function loadSim() {
  if (sim) return sim;
  const mujoco = await loadSo101();
  sim = { mujoco };
  return sim;
}

export function rehearse(spec: TaskSpec, program: Program, worlds: GravityName[] = WORLDS): WorldRun[] {
  if (!sim) throw new Error("loadSim() first");
  const { mujoco } = sim;
  const env = environment(spec);
  return worlds.map((world) => {
    const model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: GRAVITIES[world], graspable: env.graspable }));
    const data = new mujoco.MjData(model);
    try {
      return { world, rollout: runToEnd({ mujoco, model, data }, env, program, "sensed") };
    } finally {
      data.delete();
      model.delete();
    }
  });
}

async function compiled(spec: TaskSpec, previous?: Program): Promise<Program> {
  const res = await compile(new Request("http://test/api/compile?replay=1", { method: "POST", body: JSON.stringify({ spec, previous }) }));
  const r = (await res.json()) as StageResult<Program>;
  if (r.status !== "done") throw new Error(`compile replay: ${r.status === "failed" ? r.message : r.status}`);
  return r.value;
}

/**
 * The ISS sample's spec and program as the page gets them in replay, after one round of answers
 * the way app/flow.tsx applies them: a clearance of `clearance_mm`, and the first success choice.
 */
export async function issSample(clearance_mm = 10): Promise<{ spec: TaskSpec; program: Program }> {
  const label = (labels as { result: StageResult<TaskSpec> }[])[0].result;
  if (label.status !== "done") throw new Error("no recorded label");
  const fitted = fitToBench(TaskSpec.parse(label.value)).spec;
  const asked = await compiled(fitted);
  const changes = asked.steps
    .flatMap((s) => s.ops)
    .flatMap((op) => (op.op === "ask" ? [op.slot] : []))
    .map((slot) => {
      const form = formFor(fitted, slot);
      return { path: slot, value: form.kind === "success" ? form.options[0].predicates : clearance_mm, source: "interview#1" };
    });
  const { spec, warnings } = applyChanges(fitted, changes);
  if (warnings.length) throw new Error(warnings.join("; "));
  return { spec, program: await compiled(spec, asked) };
}

export type Round = { attempt: number; program: Program; result: StageResult<NotePatch>; runs: WorldRun[] };

/**
 * The loop the page runs: rehearse at both gravities, ask /api/notes for a patch, apply it,
 * rehearse again, at most MAX_PATCHES times. `url` picks live (key) or replay (?replay=1).
 */
export async function patchLoop(spec: TaskSpec, program: Program, url: string): Promise<{ rounds: Round[]; final: WorldRun[]; program: Program }> {
  const { POST } = await import("@/app/api/notes/route");
  let runs = rehearse(spec, program);
  const first = outcomeLine(runs);
  const history: Attempt[] = [];
  const rounds: Round[] = [];
  while (runs.some((r) => !r.rollout.pass) && history.length < MAX_PATCHES) {
    const res = await POST(new Request(url, { method: "POST", body: JSON.stringify({ spec, program, runs, first, history }) }));
    const result = (await res.json()) as StageResult<NotePatch>;
    rounds.push({ attempt: history.length, program, result, runs });
    if (result.status !== "done") break;
    const p = result.value;
    program = p.program;
    runs = p.noop ? runs : rehearse(spec, program);
    history.push({ set: p.set, thinking: p.thinking, clamps: p.clamps, rejected: p.rejected, outcome: outcomeLine(runs) });
  }
  return { rounds, final: runs, program };
}
