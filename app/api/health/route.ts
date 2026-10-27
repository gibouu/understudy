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
 */
import { connection, NextResponse } from "next/server";
import OpenAI from "openai";
import { liveModels, MODELS, notServed, tokenFactory, wantsReplay } from "@/lib/providers/tokenfactory";

export const maxDuration = 30;

type Health = {
  mode: "live" | "replay";
  reason?: string;
  models?: Record<string, boolean>;
  latency_ms?: number;
};

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

/** The model list, then a 5-token call to the compiling model. */
async function check(): Promise<Health> {
  const client = tokenFactory({ timeout: 8_000, maxRetries: 0 });
  if (!client) return { mode: "replay", reason: "no NEBIUS_API_KEY" };
  const started = Date.now();
  const { ok, why, models } = await liveModels(client);
  if (!ok) return { mode: "replay", reason: why, models };
  try {
    await client.chat.completions.create({
      model: MODELS.nano,
      messages: [{ role: "user", content: "Reply with the single word ok." }],
      max_tokens: 5,
    });
    return { mode: "live", models, latency_ms: Date.now() - started };
  } catch (err) {
    // listed but refused: the routes replay from their next request on
    if (err instanceof OpenAI.APIError && err.status === 404) notServed(MODELS.nano);
    const message = err instanceof Error ? err.message : String(err);
    return { mode: "replay", reason: message.slice(0, 200) };
  }
}
