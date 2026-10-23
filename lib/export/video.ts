/**
 * Encodes the workspace camera of one episode to a video file in the browser.
 *
 * WebCodecs only exists in the browser, so the writer takes the encoder as an
 * `EpisodeVideoEncoder` and the tests hand it a stub. The codec is probed once
 * per export: H.264 in MP4 when `avc1` is supported, else VP9 in WebM.
 */
import {
  BufferTarget,
  Mp4OutputFormat,
  Output,
  QUALITY_MEDIUM,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
} from "mediabunny";

export const VIDEO_KEY = "observation.images.workspace";
export const VIDEO_WIDTH = 480;
export const VIDEO_HEIGHT = 360;
export const VIDEO_FPS = 15;

export type VideoFormat = {
  /** codec name as LeRobot writes it in info.json (ffmpeg's names) */
  codec: "h264" | "vp9";
  extension: "mp4" | "webm";
};

export type VideoFrames = ImageBitmap[] | Blob[];

export interface EpisodeVideoEncoder {
  readonly format: VideoFormat;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** one file per episode, frames at `fps` starting at t = 0 */
  encode(frames: VideoFrames): Promise<Uint8Array>;
}

/** Codec strings for the probe: H.264 baseline level 3.1, VP9 profile 0 8-bit. */
const PROBES = [
  { format: { codec: "h264", extension: "mp4" }, webcodecs: "avc1.42001f", mediabunny: "avc" },
  { format: { codec: "vp9", extension: "webm" }, webcodecs: "vp09.00.10.08", mediabunny: "vp9" },
] as const;

/** First supported probe, or null when WebCodecs is missing or supports neither. */
async function probe(width: number, height: number, fps: number) {
  if (typeof VideoEncoder === "undefined") return null;
  for (const p of PROBES) {
    const { supported } = await VideoEncoder.isConfigSupported({
      codec: p.webcodecs,
      width,
      height,
      framerate: fps,
    });
    if (supported) return p;
  }
  return null;
}

/** Browser-only. Throws when the browser can encode neither H.264 nor VP9. */
export async function createBrowserVideoEncoder({
  width = VIDEO_WIDTH,
  height = VIDEO_HEIGHT,
  fps = VIDEO_FPS,
} = {}): Promise<EpisodeVideoEncoder> {
  const chosen = await probe(width, height, fps);
  if (!chosen) throw new Error("this browser can encode neither H.264 (avc1) nor VP9 video");

  return {
    format: chosen.format,
    width,
    height,
    fps,
    async encode(frames) {
      const target = new BufferTarget();
      const output = new Output({
        format:
          chosen.format.extension === "mp4"
            ? new Mp4OutputFormat({ fastStart: "in-memory" })
            : new WebMOutputFormat(),
        target,
      });
      const source = new VideoSampleSource({ codec: chosen.mediabunny, quality: QUALITY_MEDIUM });
      output.addVideoTrack(source, { frameRate: fps });
      await output.start();
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const bitmap = frame instanceof Blob ? await createImageBitmap(frame) : frame;
        const sample = new VideoSample(bitmap, { timestamp: i / fps, duration: 1 / fps });
        await source.add(sample);
        sample.close();
        if (frame instanceof Blob) bitmap.close();
      }
      source.close();
      await output.finalize();
      if (!target.buffer) throw new Error("video encoder produced no output");
      return new Uint8Array(target.buffer);
    },
  };
}
