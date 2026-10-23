/**
 * Plays a `<video>` and hands frames to `onFrame` at a fixed media-time rate,
 * each drawn `width` pixels wide into an ImageBitmap. `requestVideoFrameCallback`
 * reports each presented frame with its media time; a frame is sampled when it
 * reaches the next 1/fps step. The video element applies the clip's rotation
 * metadata, so the frames come out upright with no extra work.
 *
 * `onFrame` is asynchronous (the models run in a worker), so the video keeps
 * playing at `rate` (2x: a clip is watched in half its length when the models
 * keep up) while earlier frames are processed. When `maxInFlight` frames are
 * still waiting, the video pauses until one finishes: a slow machine watches
 * more slowly instead of skipping samples.
 */
export type SampleProgress = {
  t_s: number;
  duration_s: number;
  /** frames handed to onFrame */
  samples: number;
  /** 1/fps steps the video went past without presenting a frame (clips under `fps`) */
  skipped: number;
  /** times the video waited for the models */
  waits: number;
};

export type SampleOptions = {
  fps?: number;
  width?: number;
  rate?: number;
  maxInFlight?: number;
  /** Takes ownership of `frame` (transfer or close it). */
  onFrame: (frame: ImageBitmap, t_s: number) => Promise<void>;
  onProgress?: (p: SampleProgress) => void;
  signal?: AbortSignal;
};

export type SampleResult = SampleProgress & { width: number; height: number; aborted: boolean };

export async function sampleVideo(
  video: HTMLVideoElement,
  { fps = 10, width = 640, rate = 2, maxInFlight = 4, onFrame, onProgress, signal }: SampleOptions,
): Promise<SampleResult> {
  if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) {
    throw new Error("This browser cannot step through video frames; use a recent Chrome, Edge, Safari or Firefox.");
  }
  const decodeError = () => new Error("The video could not be decoded.");
  if (video.error) throw decodeError();
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise<void>((resolve, reject) => {
      const off = () => {
        video.removeEventListener("loadedmetadata", onMeta);
        video.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onMeta);
      };
      // an abort settles the wait too; the check below then leaves the video alone
      const onMeta = () => {
        off();
        resolve();
      };
      const onError = () => {
        off();
        reject(decodeError());
      };
      video.addEventListener("loadedmetadata", onMeta);
      video.addEventListener("error", onError);
      signal?.addEventListener("abort", onMeta);
    });
  }
  if (signal?.aborted) {
    return { t_s: 0, duration_s: 0, samples: 0, skipped: 0, waits: 0, width, height: 0, aborted: true };
  }
  const height = Math.round((width * video.videoHeight) / video.videoWidth);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas context.");

  const step = 1 / fps;
  const progress: SampleProgress = {
    t_s: 0,
    duration_s: video.duration,
    samples: 0,
    skipped: 0,
    waits: 0,
  };
  let next = 0;
  let handle = 0;
  let inFlight = 0;
  let waiting = false;
  let ended = false;
  let settled = false;

  video.muted = true;
  video.pause();
  video.currentTime = 0;
  video.playbackRate = rate;

  return new Promise<SampleResult>((resolve, reject) => {
    const stop = () => {
      settled = true;
      video.cancelVideoFrameCallback(handle);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      video.pause();
      video.playbackRate = 1;
    };
    const finish = (aborted: boolean) => {
      if (settled) return;
      stop();
      resolve({ ...progress, width, height, aborted });
    };
    const fail = (e: unknown) => {
      if (settled) return;
      stop();
      reject(e);
    };
    // pause() during a pending play() rejects it with an AbortError; that is expected here
    const play = () =>
      video.play().catch((e: unknown) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) fail(e);
      });
    const onEnded = () => {
      ended = true;
      if (inFlight === 0) finish(false);
    };
    const onAbort = () => finish(true);
    const onError = () => fail(decodeError());
    const done = () => {
      inFlight--;
      if (settled) return;
      if (ended && inFlight === 0) finish(false);
      else if (waiting && inFlight < maxInFlight) {
        waiting = false;
        play();
      }
    };

    const onVideoFrame: VideoFrameRequestCallback = (_now, meta) => {
      const t = meta.mediaTime;
      if (t + 1e-3 >= next) {
        progress.skipped += Math.floor((t + 1e-3 - next) / step);
        ctx.drawImage(video, 0, 0, width, height);
        inFlight++;
        progress.samples++;
        onFrame(canvas.transferToImageBitmap(), t).then(done, fail);
        if (inFlight >= maxInFlight && !video.ended) {
          waiting = true;
          progress.waits++;
          video.pause();
        }
        next = (Math.floor((t + 1e-3) / step) + 1) * step;
      }
      progress.t_s = t;
      onProgress?.({ ...progress });
      handle = video.requestVideoFrameCallback(onVideoFrame);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    video.addEventListener("ended", onEnded, { once: true });
    video.addEventListener("error", onError, { once: true });
    handle = video.requestVideoFrameCallback(onVideoFrame);
    play();
  });
}
