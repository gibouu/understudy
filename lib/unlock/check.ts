/**
 * The spend guard on live model calls (#35, #111). Every route that calls a
 * model asks liveGate() before it does; replays cost nothing and never reach
 * it. A call goes live:
 * - in /api/label, for a sample clip (recognised by its SHA-256), and then
 *   the answer carries a sample token (lib/unlock/token.ts);
 * - in the later routes, with that token, until it lapses;
 * - anywhere, with the code in UNDERSTUDY_UNLOCK_CODE;
 * and only while the route has live calls left this minute (lib/unlock/cap.ts),
 * and while Token Factory lists a model for every role the routes call (its
 * own or the replacement Token Factory names, lib/providers/tokenfactory.ts).
 * A model gone with no replacement replays every step, whatever the pass, so
 * a session replays from its recorded label on and its steps still match.
 * Otherwise the route answers from its recording and says why, except a
 * label of a clip of your own, which is refused so the page asks for the code.
 *
 * Without the code set, a production deployment (VERCEL_ENV=production) shuts
 * every live call except the sample sessions; anywhere else (local dev) every
 * call goes through, and each one logs that.
 *
 * A sample is recognised by the SHA-256 the page sends, which the page
 * computes: whoever reads this can claim a sample's hash for another video,
 * and so get a token. The guard stops casual visitors and a loop against an
 * open route from spending credits, nothing more.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { liveModels, tokenFactory } from "@/lib/providers/tokenfactory";
import { SAMPLES } from "@/lib/samples";
import type { StageResult } from "@/lib/spec/stage-result";
import { takeLiveCall, type LiveRoute } from "./cap";
import { LIVE_BUSY, LIVE_CLOSED, LIVE_EXPIRED, LIVE_NEEDS_PASS, LIVE_NO_SECRET, LIVE_RETIRED, LIVE_UNLISTED, LIVE_WRONG_CODE, UNLOCK_NEEDED, UNLOCK_WRONG } from "./messages";
import { readSampleToken, TOKEN_ENV, tokenSecret } from "./token";

export const UNLOCK_ENV = "UNDERSTUDY_UNLOCK_CODE";

export type Refusal = { status: 401 | 403; message: string };

/** live: call the model (`sample`: in a sample session; in /api/label, a sample clip, whose answer earns a token); otherwise replay with `why`, or send `refusal`. */
export type Gate = { live: true; sample: boolean } | { live: false; why: string; refusal?: Refusal };

/** What a request carries: the clip's hash (label only), the typed code, the token from the label. */
export type Pass = { clip_sha256?: string; unlock?: unknown; sample_token?: unknown };

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

let sampleHashes: Promise<Set<string>> | undefined;

/** Hashes of the clips under samples/, read once per instance; a missing file is skipped and logged. */
function samples(): Promise<Set<string>> {
  sampleHashes ??= Promise.all(
    SAMPLES.map((s) =>
      readFile(path.join(process.cwd(), "samples", `${s.name}.mp4`)).then(
        (bytes) => sha256(bytes).toString("hex"),
        (err: Error) => {
          console.warn(`unlock: sample ${s.name} is not readable here (${err.message}); it will need the code`);
          return "";
        },
      ),
    ),
  ).then((hashes) => new Set(hashes.filter(Boolean)));
  return sampleHashes;
}

/** equal-length digests, so the comparison takes the same time whatever was typed */
const codeIs = (code: unknown, expected: string) => typeof code === "string" && timingSafeEqual(sha256(code.trim()), sha256(expected));

const typed = (code: unknown) => typeof code === "string" && code.trim() !== "";

export async function liveGate(route: LiveRoute, pass: Pass): Promise<Gate> {
  // checked before the pass: with a model gone, a code or a token would only lead to a replay
  const tf = tokenFactory({ timeout: 8_000, maxRetries: 0 });
  const models = tf && (await liveModels(tf));
  if (models && !models.ok) return { live: false, why: models.listed ? LIVE_RETIRED : LIVE_UNLISTED };
  const expected = process.env[UNLOCK_ENV]?.trim();
  const token = route === "label" ? "none" : readSampleToken(pass.sample_token);
  const sample = route === "label" ? Boolean(pass.clip_sha256 && (await samples()).has(pass.clip_sha256)) : token === "valid";
  const open = !expected && process.env.VERCEL_ENV !== "production";
  if (open) console.info(`unlock: ${UNLOCK_ENV} is not set, so ${route} calls go live without a code`);

  if (sample || open || (expected && codeIs(pass.unlock, expected))) {
    if (route === "label" && sample && !open && !tokenSecret()) console.warn(`unlock: ${TOKEN_ENV} is not set, so this sample's later calls cannot be vouched for`);
    return takeLiveCall(route) ? { live: true, sample } : { live: false, why: LIVE_BUSY };
  }
  const closed = (): Gate => {
    console.warn(`unlock: ${UNLOCK_ENV} is not set on this production deployment, so a ${route} call outside a sample session replays`);
    return { live: false, why: LIVE_CLOSED };
  };
  if (route === "label") {
    if (!expected) return closed();
    const refusal: Refusal = typed(pass.unlock) ? { status: 403, message: UNLOCK_WRONG } : { status: 401, message: UNLOCK_NEEDED };
    return { live: false, why: refusal.message, refusal };
  }
  if (token === "expired") return { live: false, why: LIVE_EXPIRED };
  if (!expected) return closed();
  if (typed(pass.unlock)) return { live: false, why: LIVE_WRONG_CODE };
  return { live: false, why: tokenSecret() ? LIVE_NEEDS_PASS : LIVE_NO_SECRET };
}

/** A replay the gate chose: its reason goes first, so the page shows why no model was asked. */
export function explain<T>(result: StageResult<T>, gate: Gate | null): StageResult<T> {
  if (!gate || gate.live) return result;
  if (result.status === "done") return { ...result, warnings: [gate.why, ...result.warnings] };
  if (result.status === "failed") return { ...result, message: `${result.message} (${gate.why})` };
  return result;
}
