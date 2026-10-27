/**
 * GET /api/health: tells the page whether the live path is available.
 * live   = key present, Token Factory lists a model for every role the routes
 *          call (its own, or the replacement Token Factory names once it has
 *          retired it), and a 5-token call to the compiling model answered
 * replay = anything else (no key, ?replay=1, a model gone with no replacement,
 *          credits gone, Token Factory down)
 * The routes make the same model check in their spend gate (lib/unlock/check.ts),
 * so when this says replay every step replays its recording, and the demo URL
 * keeps working through judging. `replaced` names any retired model answered by
 * its replacement. Each upstream call has an 8 s deadline and no retries so the
 * route always answers inside its 30 s.
 */
import { connection, NextResponse } from "next/server";
import OpenAI from "openai";
import { current, liveModels, MODELS, notServed, tokenFactory, wantsReplay, type ModelRole } from "@/lib/providers/tokenfactory";

export const maxDuration = 30;

type Health = {
  mode: "live" | "replay";
  reason?: string;
  /** the model each role calls, or null when Token Factory lists neither it nor a replacement */
  models?: Record<ModelRole, string | null>;
  /** retired models answered by their replacement, as "Nemotron 3 Nano → Nemotron 3.5 Lightning" */
  replaced?: string[];
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
  const served = await liveModels(client);
  const { models, replaced } = served;
  if (!served.ok) return NextResponse.json({ mode: "replay", reason: served.why, models, replaced });
  const nano = current(MODELS.nano);
  try {
    await client.chat.completions.create({
      model: nano,
      messages: [{ role: "user", content: "Reply with the single word ok." }],
      max_tokens: 5,
    });
    return NextResponse.json({ mode: "live", models, replaced, latency_ms: Date.now() - started });
  } catch (err) {
    // listed but refused: the routes stop calling it from their next request
    if (err instanceof OpenAI.APIError && err.status === 404) notServed(nano);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ mode: "replay", reason: message.slice(0, 200), models, replaced });
  }
}
