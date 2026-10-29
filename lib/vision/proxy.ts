/**
 * The Label input, made in the browser: the clip re-encoded as a 480-wide,
 * 4 fps H.264 MP4 with no audio (VIDEO_PROXY), as a data URI, plus the
 * clip's duration and SHA-256 so replay can find its recording.
 */
import { ALL_FORMATS, BlobSource, BufferTarget, Input } from "mediabunny";
import { VIDEO_PROXY } from "@/lib/providers/tokenfactory";
import { problemOf, setUpProxy } from "@/lib/vision/clip";

export type Proxy = { video: string; duration_s: number; clip_sha256: string; bytes: number };

export async function makeProxy(clip: Blob): Promise<Proxy> {
  const input = new Input({ source: new BlobSource(clip), formats: ALL_FORMATS });
  const duration_s = await input.computeDuration();
  if (duration_s > VIDEO_PROXY.maxSeconds) throw new Error(`the clip is ${Math.round(duration_s)} s; at most ${VIDEO_PROXY.maxSeconds} s`);
  const target = new BufferTarget();
  const { conversion, video } = await setUpProxy(input, target);
  const codec = async () => (await input.getPrimaryVideoTrack())?.codec ?? null;
  if (video !== "ok" || !conversion) throw new Error(problemOf({ bytes: clip.size, duration_s, codec: await codec(), video }) ?? "this browser cannot make the H.264 copy of the clip");
  try {
    await conversion.execute();
  } catch {
    // the decoder said yes, then failed on the frames (a profile it cannot do, say): the same sentence as a refusal
    throw new Error(problemOf({ bytes: clip.size, duration_s, codec: await codec(), video: "undecodable" }) ?? "this browser could not decode the clip");
  }
  const bytes = new Uint8Array(target.buffer!);
  return {
    video: await dataUri(new Blob([bytes], { type: "video/mp4" })),
    duration_s,
    clip_sha256: await clipSha256(clip),
    bytes: bytes.length,
  };
}

/** Hex SHA-256 of the clip as picked: the key its replay recording is stored under. */
export async function clipSha256(clip: Blob): Promise<string> {
  const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", await clip.arrayBuffer()));
  return Array.from(sha, (b) => b.toString(16).padStart(2, "0")).join("");
}

function dataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
