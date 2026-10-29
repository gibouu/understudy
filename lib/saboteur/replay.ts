/**
 * The twelve the grid runs with no model call: the patching model's recorded
 * reply for this task's title (tests/fixtures/saboteur.json), checked against
 * the spec given now, or, with no usable recording, the twelve built from the
 * spec. /api/saboteur answers this in replay; the scoreboard on /space runs it
 * for every version of a recorded program.
 */
import recordings from "@/tests/fixtures/saboteur.json";
import type { TaskSpec } from "@/lib/spec/schema";
import type { StageResult } from "@/lib/spec/stage-result";
import { fromSpec, planOf, SaboteurReply, type SaboteurPlan } from "./ask";

type Recording = { spec_title: string; result: StageResult<unknown> };

export function replayPlan(spec: TaskSpec): StageResult<SaboteurPlan> {
  const hit = (recordings as Recording[]).find((r) => r.spec_title === spec.title && r.result.status === "done");
  if (!hit || hit.result.status !== "done") return fromSpec(spec, ["replay: no recorded scenarios for this task"]);
  const reply = SaboteurReply.safeParse(hit.result.value);
  if (!reply.success) return fromSpec(spec, ["replay: the recorded scenarios do not parse"]);
  return planOf(spec, { status: "done", value: reply.data, warnings: hit.result.warnings, ledger: hit.result.ledger }, ["replay: recorded answer"]);
}
