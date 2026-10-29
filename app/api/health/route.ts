/**
 * GET /api/health: tells the page whether the live path is available.
 * live   = key present, Token Factory lists the model of every role the routes
 *          call, and a 5-token call to the compiling model answered
 * replay = anything else (no key, ?replay=1, a model renamed or retired,
 *          credits gone, Token Factory down)
 * The routes make the same model check in their spend gate (lib/unlock/check.ts),
 * so when this says replay because a model is gone, every step replays its
 * recording, and the demo URL keeps working through judging. Each upstream call
 * has an 8 s deadline and no retries so the route always answers inside its 30 s.
 * The probe's answer serves every request on the instance for a minute (#129):
 * the 5-token call is paid and the page calls this route with no code.
 * `budget` is what the live budget for judging has left (lib/unlock/budget.ts),
 * read with the probe; once it is spent, or cannot be read, the answer is
 * replay with the reason, and no probe is paid for.
 */
import { connection, NextResponse } from "next/server";
import OpenAI from "openai";
import { errorText, liveModels, MODELS, notServed, tokenFactory, usageOf, wantsReplay } from "@/lib/providers/tokenfactory";
import { readBudget, reserve, settle } from "@/lib/unlock/budget";
import { LIVE_NO_BUDGET, LIVE_SPENT } from "@/lib/unlock/messages";

export const maxDuration = 30;

type Health = {
  mode: "live" | "replay";
  reason?: string;
  models?: Record<string, boolean>;
  latency_ms?: number;
  budget?: { cap_usd: number; spent_usd: number; left_usd: number };
};

/** a gate line without its "replay: " */
const reason = (line: string) => line.replace(/^replay: /, "");

/** How long one probe's answer serves every request on this instance. */
const PROBE_FOR_MS = 60_000;
let probe: { until: number; result: Promise<Health> } | undefined;

export async function GET(req: Request): Promise<NextResponse<Health>> {
  // Render at request time: with cache components a route handler is
  // prerendered at build unless it opts into the request.
  await connection();
  if (wantsReplay(req)) {
    return NextResponse.json({
      mode: "replay",
      reason: process.env.NEBIUS_API_KEY ? "replay requested" : "no NEBIUS_API_KEY",
    });
  }
  const now = Date.now();
  // requests that arrive while the probe runs wait for it rather than start their own
  if (!probe || now >= probe.until) {
    const entry = { until: now + PROBE_FOR_MS, result: check() };
    // a probe that throws (a client that cannot be built) is not kept: the next request tries again
    entry.result = entry.result.catch((): Health => {
      if (probe === entry) probe = undefined;
      return { mode: "replay", reason: "the health check failed" };
    });
    probe = entry;
  }
  return NextResponse.json(await probe.result);
}

/** The live budget, the model list, then a 5-token call to the compiling model. */
async function check(): Promise<Health> {
  const client = tokenFactory({ timeout: 8_000, maxRetries: 0 });
  if (!client) return { mode: "replay", reason: "no NEBIUS_API_KEY" };
  const b = await readBudget();
  if (b.state === "unknown") return { mode: "replay", reason: reason(LIVE_NO_BUDGET) };
  const budget = b.state === "open" ? undefined : { cap_usd: b.cap_usd, spent_usd: b.spent_usd, left_usd: b.left_usd };
  if (b.state === "spent") return { mode: "replay", reason: reason(LIVE_SPENT), budget };
  const started = Date.now();
  const { ok, why, models } = await liveModels(client);
  if (!ok) return { mode: "replay", reason: why, models, budget };
  // the probe is a billed call too: reserved like any other (lib/unlock/budget.ts)
  const hold = await reserve(MODELS.nano, 100, 5, 1);
  if (!hold.ok) return { mode: "replay", reason: reason(hold.why === "spent" ? LIVE_SPENT : LIVE_NO_BUDGET), budget };
  try {
    const res = await client.chat.completions.create({
      model: MODELS.nano,
      messages: [{ role: "user", content: "Reply with the single word ok." }],
      max_tokens: 5,
    });
    const u = usageOf(res);
    if (res.usage) await settle(hold, { model: MODELS.nano, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, cached_tokens: u.cached_tokens, seconds: (Date.now() - started) / 1000 });
    return { mode: "live", models, latency_ms: Date.now() - started, budget };
  } catch (err) {
    // listed but refused: the routes replay from their next request on
    if (err instanceof OpenAI.APIError && err.status === 404) notServed(MODELS.nano);
    return { mode: "replay", reason: errorText(err).slice(0, 200) };
  }
}
