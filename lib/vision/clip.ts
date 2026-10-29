/**
 * Whether this browser can turn a picked clip into the Label proxy, said
 * before anything runs. Phones film MP4 or QuickTime (.MOV); iPhones film
 * HEVC by default, which some browsers cannot decode (Firefox, Chrome on
 * Windows without the HEVC extension). The container and codec are read
 * from the file itself, never from its name or MIME type: Windows and
 * Firefox often give a .mov file no type at all. The verdict is the one
 * `makeProxy` will reach: the same conversion is set up, not run.
 */
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output } from "mediabunny";
import { VIDEO_PROXY } from "@/lib/providers/tokenfactory";

/** The file picker's filter. MIME types and extensions both, since a .mov may arrive with no type. */
export const CLIP_ACCEPT = "video/mp4,video/quicktime,video/x-m4v,.mp4,.m4v,.mov";

/** Larger than this, reading the whole clip in the browser (for its SHA-256) risks the tab. */
export const MAX_CLIP_BYTES = 1024 * 1024 * 1024;

/** The proxy conversion (480 wide, 4 fps, H.264, no sound), set up on `input`; `makeProxy` executes it. */
export function proxyConversion(input: Input, target: BufferTarget = new BufferTarget()): Promise<Conversion> {
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  return Conversion.init({
    input,
    output,
    video: { width: VIDEO_PROXY.width, frameRate: VIDEO_PROXY.fps, codec: "avc" },
    audio: { discard: true },
  });
}

/** What the proxy conversion decided for the clip's video: made, or why not. */
export type VideoVerdict = "ok" | "undecodable" | "unencodable" | "unknown";

/** What `makeProxy` needs to know about a clip, read from its header (no frame is decoded). */
export type ClipFacts = { bytes: number; duration_s: number; codec: string | null; video: VideoVerdict };

const FIX_HEVC =
  'Export it as H.264 ("Most Compatible": on an iPhone, Settings > Camera > Formats > Most Compatible, then film it again), or film yourself here.';

const tooLarge = (bytes: number) =>
  `This clip is ${Math.round(bytes / 1024 / 1024)} MB, too large to read in the browser (at most ${MAX_CLIP_BYTES / 1024 / 1024} MB). Trim it, or film a shorter one.`;

/** The sentence a clip that cannot become a proxy gets on the page, or null when it can. */
export function problemOf(f: ClipFacts): string | null {
  if (f.bytes > MAX_CLIP_BYTES) return tooLarge(f.bytes);
  if (f.codec === null || f.video === "unknown") return "This file has no video this page can read. Upload an MP4 or MOV in H.264, or film yourself here.";
  if (f.video === "undecodable") {
    if (f.codec === "hevc") return `This browser cannot decode HEVC (H.265) video, the format iPhones film in by default. ${FIX_HEVC}`;
    return `This browser cannot decode ${f.codec.toUpperCase()} video. Upload an MP4 or MOV in H.264, or film yourself here.`;
  }
  if (f.video === "unencodable") return "This browser cannot encode the small H.264 copy the model is sent. Try Chrome or Safari, or pick a sample.";
  if (f.duration_s > VIDEO_PROXY.maxSeconds) return `This clip is ${Math.round(f.duration_s)} s long; at most ${VIDEO_PROXY.maxSeconds} s. Trim it first.`;
  return null;
}

/** The proxy conversion's verdict on the clip's video track. */
export function verdictOf(conversion: Conversion): VideoVerdict {
  const dropped = conversion.discardedTracks.find((d) => d.track.isVideoTrack());
  if (conversion.isValid && !dropped) return "ok";
  if (dropped?.reason === "undecodable_source_codec") return "undecodable";
  if (dropped?.reason === "no_encodable_target_codec") return "unencodable";
  return "unknown";
}

/**
 * The proxy conversion set up on `input`, and its verdict. Setting it up may
 * already decode a frame (when no resize is needed), so a decoder that throws
 * there counts as one that cannot decode the clip.
 */
export async function setUpProxy(input: Input, target?: BufferTarget): Promise<{ conversion: Conversion | null; video: VideoVerdict }> {
  try {
    const conversion = await proxyConversion(input, target);
    return { conversion, video: verdictOf(conversion) };
  } catch {
    return { conversion: null, video: "undecodable" };
  }
}

/** The clip's facts. Throws when the file is not a container mediabunny reads. */
export async function readClip(clip: Blob): Promise<ClipFacts> {
  const input = new Input({ source: new BlobSource(clip), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    const codec = track?.codec ?? null;
    const duration_s = await input.computeDuration();
    const video = track && codec ? (await setUpProxy(input)).video : "unknown";
    return { bytes: clip.size, duration_s, codec, video };
  } finally {
    input.dispose();
  }
}

/** `problemOf` for a picked file; a file that is not a video at all gets its own sentence. */
export async function clipProblem(clip: Blob, read: (clip: Blob) => Promise<ClipFacts> = readClip): Promise<string | null> {
  if (clip.size > MAX_CLIP_BYTES) return tooLarge(clip.size);
  try {
    return problemOf(await read(clip));
  } catch {
    return "This file is not a video this page can read. Upload an MP4 or MOV, or film yourself here.";
  }
}
