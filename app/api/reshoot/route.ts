/**
 * POST /api/reshoot {spec, program, runs, patches}: the reshoot list (issue
 * #33). `runs` is the compiled program's rehearsal in every world, `patches`
 * the patch loop's attempts with their outcomes, if it ran. Nemotron 3 Ultra,
 * thinking on (the 90 s the page waits allow it: lib/reshoot/reshoot.ts THINKING), returns failure classes with evidence from the run, reshoot
 * items for fields that came from the clip or from the person's answers, and
 * open risks (lib/reshoot/reshoot.ts); the reply is validated with zod and
 * its reshoot items checked against the spec's sources. `unlock` or
 * `sample_token` lets it go live (lib/unlock/check.ts; it counts against the
 * Notes route's live calls per minute, the stage it follows). Replay (no key,
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
import { explain, liveGate } from "@/lib/unlock/check";

// one Ultra call (11 s measured with thinking on), re-asked once if it does not parse; the page stops waiting at 90 s
export const maxDuration = 120;

type Recording = { spec_title: string; outcome: string; result: StageResult<Reshoot> };

function replay(title: string, outcome: string): StageResult<Reshoot> {
  const same = (recordings as Recording[]).filter((r) => r.spec_title === title && r.result.status === "done");
  const hit = same.find((r) => r.outcome === outcome) ?? same[0];
  // another task's list would cite another run's evidence: none is better
  if (!hit || hit.result.status !== "done") return failed("no recorded reshoot list for this task", false);
  const note = hit.outcome === outcome ? [] : ["replay: recorded after a rehearsal with another outcome"];
  return done(hit.result.value, ["replay: recorded reshoot list", ...note, ...hit.result.warnings], hit.result.ledger);
}

export async function POST(req: Request): Promise<NextResponse<StageResult<Reshoot>>> {
  const body = await req.json().catch(() => null);
  const parsed = ReshootBody.safeParse(body);
  if (!parsed.success) return NextResponse.json(failed(`invalid request: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, false), { status: 400 });
  const b = parsed.data;
  const outcome = finalOutcome(b);
  if (wantsReplay(req)) return NextResponse.json(replay(b.spec.title, outcome));
  const gate = await liveGate("notes", body);
  if (!gate.live) return NextResponse.json(explain(replay(b.spec.title, outcome), gate));
  const client = tokenFactory({ timeout: 80_000, maxRetries: 0 });
  if (!client) return NextResponse.json(replay(b.spec.title, outcome));

  const ledger: LedgerEntry[] = [];
  const r = await callModel(client, { role: "ultra", system: RESHOOT_SYSTEM, user: reshootPrompt(b.spec, b), maxTokens: MAX_TOKENS, schema: ReshootReply, normalize: normalizeReply, shape: REPLY_SHAPE, thinking: THINKING, ledger });
  const costs = priced(ledger);
  const spent = costs.reduce((n, e) => n + (e.usd ?? 0), 0);
  if (r.status !== "done") return NextResponse.json(failed(`${r.status === "failed" ? r.message : "no answer"} (${costs.length} call${costs.length === 1 ? "" : "s"}, $${spent.toFixed(4)})`, r.status === "failed" && r.retryable));
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
