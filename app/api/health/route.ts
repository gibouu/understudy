/**
 * GET /api/health: tells the page whether the live path is available.
 * live   = key present, the four model IDs are listed, a 5-token Nano call answered
 * replay = anything else (no key, ?replay=1, a model renamed, credits gone, Token Factory down)
 * The page shows a banner and serves recorded sessions in replay mode, so the
 * demo URL keeps working through judging. Each upstream call has an 8 s
 * deadline and no retries so the route always answers inside its 30 s.
 */
import { connection, NextResponse } from "next/server";
import { MODELS, tokenFactory, wantsReplay } from "@/lib/providers/tokenfactory";

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
  try {
    const list = await client.models.list();
    const ids = new Set<string>();
    for await (const m of list) ids.add(m.id);
    const models = Object.fromEntries(
      Object.entries(MODELS).map(([role, id]) => [role, ids.has(id)]),
    );
    const missing = Object.entries(models)
      .filter(([, ok]) => !ok)
      .map(([role]) => `${role}=${MODELS[role as keyof typeof MODELS]}`);
    if (missing.length) {
      return NextResponse.json({ mode: "replay", reason: `missing ${missing.join(", ")}`, models });
    }
    await client.chat.completions.create({
      model: MODELS.nano,
      messages: [{ role: "user", content: "Reply with the single word ok." }],
      max_tokens: 5,
    });
    return NextResponse.json({ mode: "live", models, latency_ms: Date.now() - started });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ mode: "replay", reason: message.slice(0, 200) });
  }
}
