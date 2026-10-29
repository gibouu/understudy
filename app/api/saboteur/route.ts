/**
 * POST /api/saboteur {spec}: twelve perturbations of the spec's world for the
 * grid on /try (app/saboteur.tsx), chosen from the spec's object symmetry and
 * tightest constraint (lib/saboteur/grid.ts). Live, the patching model writes
 * them (lib/saboteur/ask.ts) and is asked once more with the problems when
 * they are not exactly twelve the grid can run; if they still are not, or
 * the call fails, the twelve are built from the spec with no model, so the
 * grid always runs. Replay (no key, ?replay=1, or no way past the spend
 * guard) answers from tests/fixtures/saboteur.json (lib/saboteur/replay.ts), the model's recorded
 * reply for this task's title, checked against the spec posted now; with no
 * recording for it, from the spec. The live calls count against the
 * variants route's ceiling (lib/unlock/cap.ts): both are one patching-model
 * call per click below the rehearsal.
 */
import { NextResponse } from "next/server";
import { tokenFactory, wantsReplay } from "@/lib/providers/tokenfactory";
import { askSaboteur, planOf, type SaboteurReply, type SaboteurPlan } from "@/lib/saboteur/ask";
import { replayPlan as replay } from "@/lib/saboteur/replay";
import { TaskSpec } from "@/lib/spec/schema";
import { failed, type LedgerEntry, type StageResult } from "@/lib/spec/stage-result";
import { budgetRefused, explain, liveGate } from "@/lib/unlock/check";

export const maxDuration = 60;
/** what the model calls may take in all, the spend gate's model list (up to 8 s) before them */
const DEADLINE_MS = 40_000;

export async function POST(req: Request): Promise<NextResponse<StageResult<SaboteurPlan>>> {
  const body = await req.json().catch(() => null);
  const spec = TaskSpec.safeParse(body?.spec);
  if (!spec.success) return NextResponse.json(failed(`invalid spec: ${spec.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, false), { status: 400 });

  const gate = wantsReplay(req) ? null : await liveGate("variants", body);
  const client = gate?.live ? tokenFactory({ timeout: 20_000, maxRetries: 0 }) : null;
  if (!client) return NextResponse.json(explain(replay(spec.data), gate));
  // a failed answer still cost its calls: the page counts them from this
  const billed: LedgerEntry[] = [];
  // callModel may ask up to three times (a 400 retried, then one fix): past the deadline the spec's twelve answer
  // inside maxDuration, and the calls still on their way are left to finish unheard
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<StageResult<SaboteurReply>>((resolve) => {
    timer = setTimeout(() => resolve(failed(`no answer within ${DEADLINE_MS / 1000} s`)), DEADLINE_MS);
  });
  const result = await Promise.race([askSaboteur(client, spec.data, billed), late]).finally(() => clearTimeout(timer));
  // turned away by the live budget halfway: the recording answers, as if the guard had said so
  const refused = budgetRefused(result);
  if (refused) return NextResponse.json({ ...explain(replay(spec.data), refused), ledger: billed });
  const plan = planOf(spec.data, result);
  return NextResponse.json(plan.status === "done" ? { ...plan, ledger: billed } : plan);
}
