/**
 * POST /api/variants {spec, request?, first?}: similar tasks for the spec the
 * arm just rehearsed. Without a request Super suggests five (it is asked again
 * when fewer than three fit the bench); with one line from the person it
 * writes one, or says what the arm cannot do yet. Each idea is checked and
 * fitted to the bench here (lib/variants/validate.ts) and comes back with its
 * spec ready for /api/compile, numbered from `first`; ideas that cannot be
 * rehearsed come back under `not_yet` with the reason. `unlock` or
 * `sample_token` lets it go live (lib/unlock/check.ts). Replay (no key,
 * ?replay=1, or no way past the spend guard) answers from
 * tests/fixtures/variants.json: Super's
 * recorded reply to the same request, for this task's title if there is one,
 * checked against the spec posted now. A sample's first suggestions, and the
 * program for each, were run ahead of time (lib/showcase/prerun.ts) and
 * answer at once. A spec of gestures alone gets its similar tasks built from
 * the traced path, with no model, live or replayed alike (lib/variants/gesture.ts).
 */
import { NextResponse } from "next/server";
import recordings from "@/tests/fixtures/variants.json";
import { tokenFactory, wantsReplay } from "@/lib/providers/tokenfactory";
import { TaskSpec } from "@/lib/spec/schema";
import { done, failed, type LedgerEntry, type StageResult } from "@/lib/spec/stage-result";
import { askSuper, cleanRequest } from "@/lib/variants/ask";
import { GESTURE_VARIANTS_NOTE, gestureVariants, gesturesOnly } from "@/lib/variants/gesture";
import { VariantReply } from "@/lib/variants/parse";
import { MAX_REQUEST_CHARS } from "@/lib/variants/prompt";
import { checkReply, type Checked } from "@/lib/variants/validate";
import { budgetRefused, explain, liveGate } from "@/lib/unlock/check";
import { prerunVariants } from "@/lib/showcase/lookup";

export const maxDuration = 60;

type Recording = { request: string | null; spec_title: string; result: StageResult<unknown> };

const key = (request?: string | null) => (request ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function replay(spec: TaskSpec, request?: string): StageResult<VariantReply> {
  const all = (recordings as Recording[]).filter((r) => key(r.request) === key(request) && r.result.status === "done");
  const hit = all.find((r) => r.spec_title === spec.title) ?? all[0];
  if (!hit || hit.result.status !== "done") {
    const asked = (recordings as Recording[]).flatMap((r) => (r.request ? [`"${r.request}"`] : []));
    return failed(request ? `replay has recorded answers only for ${asked.join(", ") || "no request"}` : "no recorded suggestions", false);
  }
  const value = VariantReply.parse(hit.result.value);
  const warnings = [...hit.result.warnings, ...(hit.spec_title === spec.title ? [] : ["replay: recorded for another task"])];
  return done(value, ["replay: recorded answer", ...warnings], hit.result.ledger);
}

export async function POST(req: Request): Promise<NextResponse<StageResult<Checked>>> {
  const body = await req.json().catch(() => null);
  const spec = TaskSpec.safeParse(body?.spec);
  if (!spec.success) return NextResponse.json(failed(`invalid spec: ${spec.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, false), { status: 400 });
  const request = cleanRequest(body?.request, MAX_REQUEST_CHARS);
  const first = Number.isInteger(body?.first) && body.first >= 1 && body.first < 10_000 ? (body.first as number) : 1;
  // a sample's first suggestions were run ahead of time: they answer at once, live or not ("Suggest more" asks Super)
  if (!request && first === 1) {
    const pre = await prerunVariants<Checked>(spec.data);
    if (pre) return NextResponse.json(pre);
  }
  if (gesturesOnly(spec.data)) {
    if (!request) return NextResponse.json(done(gestureVariants(spec.data, first), [GESTURE_VARIANTS_NOTE]));
    return NextResponse.json(done<Checked>({ variants: [], not_yet: [{ idea: request, why: "a gesture's similar tasks are built from its traced path; a line is not read for one yet" }] }, [GESTURE_VARIANTS_NOTE]));
  }

  const gate = wantsReplay(req) ? null : await liveGate("variants", body);
  const client = gate?.live ? tokenFactory({ timeout: 25_000, maxRetries: 1 }) : null;
  // a failed answer still cost its calls: the page counts them from this
  const billed: LedgerEntry[] = [];
  const asked = client ? await askSuper(client, spec.data, request, billed) : explain(replay(spec.data, request), gate);
  // turned away by the live budget halfway: the recording answers, as if the guard had said so
  const refused = budgetRefused(asked);
  const result = refused ? explain(replay(spec.data, request), refused) : asked;
  if (result.status !== "done") return NextResponse.json({ ...result, ledger: billed });
  let checked: Checked;
  try {
    checked = checkReply(spec.data, result.value, first);
  } catch (err) {
    // the calls were made: a checker bug must not hide what they cost
    return NextResponse.json({ ...failed<Checked>(`the variants could not be checked: ${(err as Error).message}`.slice(0, 300), false), ledger: result.ledger });
  }
  // a request gets one variant: the first that fits
  if (request && checked.variants.length > 1) checked.variants = checked.variants.slice(0, 1);
  return NextResponse.json(done(checked, result.warnings, result.ledger));
}
