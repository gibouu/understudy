/**
 * The spend guard on live model calls (#35): a clip that is not one of the
 * samples, an upload or a camera take, is labelled live only with the code in
 * UNDERSTUDY_UNLOCK_CODE. Replays cost nothing and never reach this. Without
 * the variable (local dev) every clip goes through, and each call logs that.
 *
 * A sample is recognised by the SHA-256 the page sends, which the page
 * computes: whoever reads this can claim a sample's hash for another video.
 * The guard stops casual visitors spending credits on their own clips,
 * nothing more.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SAMPLES } from "@/lib/samples";
import { UNLOCK_NEEDED, UNLOCK_WRONG } from "./messages";

export const UNLOCK_ENV = "UNDERSTUDY_UNLOCK_CODE";

export type Refusal = { status: 401 | 403; message: string };

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

/** null when the clip may be labelled live; otherwise the refusal to send back. */
export async function checkUnlock(clipSha256: string | undefined, code: unknown): Promise<Refusal | null> {
  const expected = process.env[UNLOCK_ENV]?.trim();
  if (!expected) {
    console.info(`unlock: ${UNLOCK_ENV} is not set, so clips of your own are labelled live without a code`);
    return null;
  }
  if (clipSha256 && (await samples()).has(clipSha256)) return null;
  if (typeof code !== "string" || code.trim() === "") return { status: 401, message: UNLOCK_NEEDED };
  // equal-length digests, so the comparison takes the same time whatever was typed
  return timingSafeEqual(sha256(code.trim()), sha256(expected)) ? null : { status: 403, message: UNLOCK_WRONG };
}
