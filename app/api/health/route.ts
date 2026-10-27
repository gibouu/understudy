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
 */
import { connection, NextResponse } from "next/server";
import OpenAI from "openai";
import { errorText, liveModels, MODELS, notServed, tokenFactory, wantsReplay } from "@/lib/providers/tokenfactory";

export const maxDuration = 30;

type Health = {
  mode: "live" | "replay";
  reason?: string;
  models?: Record<string, boolean>;
  latency_ms?: number;
};

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
  const client = tokenFactory({ timeout: 8_000, maxRetries: 0 });
  if (!client) return NextResponse.json({ mode: "replay", reason: "no NEBIUS_API_KEY" });
  const started = Date.now();
  const { ok, why, models } = await liveModels(client);
  if (!ok) return NextResponse.json({ mode: "replay", reason: why, models });
  try {
    await client.chat.completions.create({
      model: MODELS.nano,
      messages: [{ role: "user", content: "Reply with the single word ok." }],
      max_tokens: 5,
    });
    return NextResponse.json({ mode: "live", models, latency_ms: Date.now() - started });
  } catch (err) {
    // listed but refused: the routes replay from their next request on
    if (err instanceof OpenAI.APIError && err.status === 404) notServed(MODELS.nano);
    return NextResponse.json({ mode: "replay", reason: errorText(err).slice(0, 200) });
  }
}
