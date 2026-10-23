/**
 * Encodes the workspace camera of one episode to an MP4 in the browser.
 *
 * WebCodecs only exists in the browser, so the writer takes the encoder as an
 * `EpisodeVideoEncoder` and the tests hand it a stub. The codec is probed once
 * per export: H.264 when the browser can encode it, else VP9. Both go in MP4:
 * WebM stores millisecond timecodes, so 1/15 s frames land up to 333 µs off,
 * beyond the 100 µs LeRobot tolerates when it syncs video to the parquet.
 */
import {
  BufferTarget,
  canEncodeVideo,
  Mp4OutputFormat,
  Output,
  QUALITY_MEDIUM,
  VideoSample,
  VideoSampleSource,
} from "mediabunny";

export const VIDEO_KEY = "observation.images.workspace";
export const VIDEO_WIDTH = 480;
export const VIDEO_HEIGHT = 360;
export const VIDEO_FPS = 15;

export type VideoFormat = {
  /** codec name as LeRobot writes it in info.json (ffmpeg's names) */
  codec: "h264" | "vp9";
};

export type VideoFrames = ImageBitmap[] | Blob[];

export interface EpisodeVideoEncoder {
  readonly format: VideoFormat;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** one MP4 per episode, frames at `fps` starting at t = 0 */
  encode(frames: VideoFrames): Promise<Uint8Array>;
}

const QUALITY = QUALITY_MEDIUM;
const CANDIDATES = [
  { format: { codec: "h264" }, mediabunny: "avc" },
  { format: { codec: "vp9" }, mediabunny: "vp9" },
] as const;

/**
 * Browser-only. Probes with the configuration the encoder will use (mediabunny's
 * `canEncodeVideo` runs `VideoEncoder.isConfigSupported` with its own codec
 * string). Throws when the browser can encode neither H.264 nor VP9.
 */
export async function createBrowserVideoEncoder({
  width = VIDEO_WIDTH,
  height = VIDEO_HEIGHT,
  fps = VIDEO_FPS,
} = {}): Promise<EpisodeVideoEncoder> {
  let chosen: (typeof CANDIDATES)[number] | undefined;
  for (const c of CANDIDATES) {
    if (await canEncodeVideo(c.mediabunny, { width, height, quality: QUALITY })) {
      chosen = c;
      break;
    }
  }
  if (!chosen) throw new Error("this browser can encode neither H.264 nor VP9 video");
  const codec = chosen.mediabunny;

  return {
    format: chosen.format,
    width,
    height,
    fps,
    async encode(frames) {
      const target = new BufferTarget();
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
      const source = new VideoSampleSource({ codec, quality: QUALITY });
      output.addVideoTrack(source, { frameRate: fps });
      try {
        await output.start();
        for (let i = 0; i < frames.length; i++) {
          const frame = frames[i];
          const bitmap = frame instanceof Blob ? await createImageBitmap(frame) : frame;
          try {
            const sample = new VideoSample(bitmap, { timestamp: i / fps, duration: 1 / fps });
            try {
              await source.add(sample);
            } finally {
              sample.close();
            }
          } finally {
            if (frame instanceof Blob) bitmap.close();
          }
        }
        source.close();
        await output.finalize();
      } catch (error) {
        if (output.state !== "finalized" && output.state !== "canceled") await output.cancel();
        throw error;
      }
      if (!target.buffer) throw new Error("video encoder produced no output");
      return new Uint8Array(target.buffer);
    },
  };
}
