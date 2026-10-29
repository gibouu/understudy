/**
 * POST /api/reshoot {spec, program, runs, patches}: the reshoot list (issue
 * #33). `runs` is the compiled program's rehearsal in every world, `patches`
 * the patch loop's attempts with their outcomes, if it ran. Nemotron 3 Ultra,
 * thinking on (the 90 s the page waits allow it: lib/reshoot/reshoot.ts THINKING), returns failure classes with evidence from the run, reshoot
 * items for fields that came from the clip or from the person's answers, and
 * open risks (lib/reshoot/reshoot.ts); the reply is validated with zod and
 * its reshoot items checked against the spec's sources. `unlock` or
 * `sample_token` lets it go live (lib/unlock/check.ts; its own ceiling of live
 * calls per minute in lib/unlock/cap.ts, #193). Replay (no key,
 * ?replay=1, or no way past the spend guard) answers from
 * tests/fixtures/reshoot.json: the list recorded for the same task.
 */
import { NextResponse } from "next/server";
import recordings from "@/tests/fixtures/reshoot.json";
import { callModel } from "@/lib/providers/call";
import { priced } from "@/lib/providers/price";
import { MODELS, tokenFactory, wantsReplay } from "@/lib/providers/tokenfactory";
import { checkReply, finalOutcome, MAX_TOKENS, normalizeReply, REPLY_SHAPE, THINKING, RESHOOT_SYSTEM, ReshootBody, ReshootReply, reshootPrompt, type Reshoot } from "@/lib/reshoot/reshoot";
import { done, failed, type LedgerEntry, type StageResult } from "@/lib/spec/stage-result";
import { budgetRefused, explain, liveGate } from "@/lib/unlock/check";

// one Ultra call (4 to 40 s measured with thinking on), re-asked once if it does not parse; the page stops waiting at 90 s
export const maxDuration = 120;
/** The route answers by then whatever the model does, re-ask included: inside maxDuration. */
const DEADLINE_MS = 100_000;

type Recording = { spec_title: string; outcome: string; program?: unknown; result: StageResult<Reshoot> };

/** The list recorded for this task, its reshoot items checked again against the spec posted now. */
function replay(b: ReshootBody, outcome: string): StageResult<Reshoot> {
  const same = (recordings as Recording[]).filter((r) => r.spec_title === b.spec.title && r.result.status === "done");
  const hit = same.find((r) => r.outcome === outcome) ?? same[0];
  // another task's list would cite another run's evidence: none is better
  if (!hit || hit.result.status !== "done") return failed("no recorded reshoot list for this task", false);
  const v = hit.result.value;
  const { reshoot, dropped } = checkReply(b.spec, { failure_classes: v.failure_classes, reshoot: v.reshoot, open_risks: v.open_risks });
  const notes = [
    ...(hit.outcome === outcome ? [] : ["replay: recorded after a rehearsal with another outcome"]),
    ...(hit.program === undefined || JSON.stringify(hit.program) === JSON.stringify(b.program) ? [] : ["replay: recorded for another version of the program"]),
  ];
  return done({ ...v, reshoot, dropped: [...v.dropped, ...dropped] }, ["replay: recorded reshoot list", ...notes, ...hit.result.warnings, ...dropped.map((d) => `reshoot item dropped: ${d}`)], hit.result.ledger);
}

export async function POST(req: Request): Promise<NextResponse<StageResult<Reshoot>>> {
  const body = await req.json().catch(() => null);
  const parsed = ReshootBody.safeParse(body);
  if (!parsed.success) return NextResponse.json(failed(`invalid request: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, false), { status: 400 });
  const b = parsed.data;
  const outcome = finalOutcome(b);
  if (wantsReplay(req)) return NextResponse.json(replay(b, outcome));
  const gate = await liveGate("reshoot", body);
  if (!gate.live) return NextResponse.json(explain(replay(b, outcome), gate));
  const base = tokenFactory({ timeout: 80_000, maxRetries: 0 });
  if (!base) return NextResponse.json(replay(b, outcome));

  // one deadline for every request of this answer, the re-ask included: at DEADLINE_MS the request in flight is
  // aborted and no other starts, so nothing runs past maxDuration; the race answers even if the SDK lingers
  const deadline = new AbortController();
  const client = base.withOptions({ fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal }) });
  const ledger: LedgerEntry[] = [];
  const late = `ultra: no usable answer within ${DEADLINE_MS / 1000} s`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<StageResult<ReshootReply>>((resolve) => {
    timer = setTimeout(() => {
      deadline.abort();
      resolve(failed(late));
    }, DEADLINE_MS);
  });
  const answer = callModel(client, { role: "ultra", system: RESHOOT_SYSTEM, user: reshootPrompt(b.spec, b), maxTokens: MAX_TOKENS, schema: ReshootReply, normalize: normalizeReply, shape: REPLY_SHAPE, thinking: THINKING, ledger });
  let r = await Promise.race([answer, expired]).finally(() => clearTimeout(timer));
  if (deadline.signal.aborted) r = failed(late);
  const costs = priced(ledger);
  const spent = costs.reduce((n, e) => n + (e.usd ?? 0), 0);
  // the live budget turned the call away: the recording answers, saying why
  const refused = budgetRefused(r);
  if (refused) return NextResponse.json(explain(replay(b, outcome), refused));
  if (r.status !== "done") return NextResponse.json(failed(`${r.status === "failed" ? r.message : "no answer"} (${costs.length} call${costs.length === 1 ? "" : "s"}, $${spent.toFixed(4)})`, r.status === "failed" && r.retryable, costs));
  const { reshoot, dropped } = checkReply(b.spec, r.value);
  const value: Reshoot = {
    failure_classes: r.value.failure_classes,
    reshoot,
    open_risks: r.value.open_risks,
    dropped,
    outcome,
    model: MODELS.ultra,
    thinking: THINKING,
    tokens: costs.reduce((n, e) => n + e.prompt_tokens + e.completion_tokens, 0),
    cost_usd: spent,
  };
  return NextResponse.json(done(value, [...r.warnings, ...dropped.map((d) => `reshoot item dropped: ${d}`)], costs));
}
