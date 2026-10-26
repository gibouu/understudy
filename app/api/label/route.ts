/**
 * POST /api/label {video, duration_s, hint?, clip_sha256?}: Super VL watches
 * the clip's proxy (480 wide, 4 fps H.264 as a data URI, made in the browser)
 * and returns a TaskSpec. `hint` is the one line the person types about what
 * they filmed. Replay (no key, or ?replay=1) answers from
 * tests/fixtures/label.json: the recording of the same clip, else the first.
 */
import { NextResponse } from "next/server";
import recordings from "@/tests/fixtures/label.json";
import { callModel, type UserPart } from "@/lib/providers/call";
import { MODELS, tokenFactory, wantsReplay } from "@/lib/providers/tokenfactory";
import { hintText, LABEL_PROMPT, tidyLabel } from "@/lib/spec/label";
import { TaskSpec } from "@/lib/spec/schema";
import { done, failed, type StageResult } from "@/lib/spec/stage-result";
import { validateSpec } from "@/lib/spec/validate";

export const maxDuration = 60;

/** Vercel refuses request bodies over 4.5 MB; a 2-minute proxy is well under this. */
const MAX_VIDEO_CHARS = 4_000_000;

type Recording = { clip_sha256: string; hint: string; result: StageResult<TaskSpec> };

function replay(sha?: string): StageResult<TaskSpec> {
  const all = recordings as Recording[];
  const exact = all.find((r) => r.clip_sha256 === sha);
  if (exact) return exact.result;
  const first = all[0]?.result;
  if (first?.status === "done") return done(first.value, [...first.warnings, "replay: recorded for another clip"], first.ledger);
  return failed("no recorded label", false);
}

export async function POST(req: Request): Promise<NextResponse<StageResult<TaskSpec>>> {
  const body = await req.json().catch(() => null);
  const sha = typeof body?.clip_sha256 === "string" && /^[0-9a-f]{64}$/.test(body.clip_sha256) ? body.clip_sha256 : undefined;
  // a re-ask resends the video: two 25 s attempts and no SDK retry stay inside maxDuration
  const client = wantsReplay(req) ? null : tokenFactory({ timeout: 25_000, maxRetries: 0 });
  if (!client) return NextResponse.json(replay(sha));

  const video = body?.video;
  const duration = Number(body?.duration_s);
  if (typeof video !== "string" || !video.startsWith("data:video/") || video.length > MAX_VIDEO_CHARS) {
    return NextResponse.json(failed("video must be an MP4 data URI under 4 MB", false), { status: 400 });
  }
  if (!(duration > 0 && duration <= 120)) return NextResponse.json(failed("duration_s must be between 0 and 120", false), { status: 400 });
  const hint = typeof body?.hint === "string" ? body.hint.trim().slice(0, 200) : "";

  const user: UserPart[] = [{ type: "text", text: LABEL_PROMPT }];
  if (hint) user.push({ type: "text", text: hintText(hint) });
  user.push({ type: "video_url", video_url: { url: video } });
  const result = await callModel(client, {
    role: "vl",
    user,
    maxTokens: 3000,
    schema: TaskSpec,
    normalize: (raw) => tidyLabel(raw, duration),
  });
  if (result.status !== "done") return NextResponse.json(result);
  const spec: TaskSpec = { ...result.value, provenance: { label_input: "video", clip_sha256: sha, model: MODELS.vl } };
  const warnings = [...result.warnings, ...validateSpec(spec).map((i) => `${i.path}: ${i.message}`)];
  return NextResponse.json(done(spec, warnings, result.ledger));
}
