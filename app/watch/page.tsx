"use client";

/**
 * Dev page for the Watch stage: play a clip, run MediaPipe pose and hands on
 * frames sampled at 10 fps, draw the selected person's skeleton over the video
 * and keep the landmarks per frame as tokens. Nothing leaves the browser.
 */
import { useEffect, useRef, useState } from "react";
import { startDetector, type Detector } from "@/lib/vision/detector";
import { sampleVideo, type SampleProgress } from "@/lib/vision/sampler";
import { assembleFrame, fillHandGaps, wristSpeed } from "@/lib/vision/select";
import { COLOURS, drawSkeleton } from "@/lib/vision/skeleton";
import type { HandGap, TokenFrame, WatchTokens } from "@/lib/vision/types";
import { done, failed, idle, running, type StageResult } from "@/lib/spec/stage-result";

/** Clips under samples/ (sources and licences in samples/README.md); the ISS clip is the hero. */
const SAMPLES = [
  { name: "iss-veggie-seed-film", label: "ISS: seed film into a plant pillow (NASA, 36 s)" },
  { name: "dev-clip", label: "ISS: chess (dev clip, 30 s)" },
] as const;
const FPS = 10;
/** sampled frame width; wider than the models need so a wrist crop keeps real pixels (lib/vision/crop.ts) */
const SAMPLE_WIDTH = 960;

type Readout = { frame: number; t_s: number; left: number | null; right: number | null };

const clock = (s: number) =>
  `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const speed = (v: number | null) => (v === null ? "–" : `${v.toFixed(2)} m/s`);

/** Index of the last frame at or before `t`. */
/** The skeleton's colour beside a label in ink: the colours themselves are too light to read as text (#121). */
function Swatch({ colour }: { colour: string }) {
  return <span aria-hidden="true" className="mr-1.5 inline-block size-2 rounded-full align-middle" style={{ background: colour }} />;
}

function frameAt(frames: TokenFrame[], t: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  if (hi < 0 || frames[0].t_s > t) return -1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (frames[m].t_s <= t) lo = m;
    else hi = m - 1;
  }
  return lo;
}

export default function WatchPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const detector = useRef<Promise<Detector> | null>(null);
  const frames = useRef<TokenFrame[]>([]);
  /** the blob URL on screen, revoked when replaced or on unmount */
  const blobUrl = useRef<string | null>(null);
  /** bumped on every pick, so a slow sample download cannot replace a newer pick */
  const pick = useRef(0);
  const [src, setSrc] = useState<string | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [stage, setStage] = useState<StageResult<WatchTokens>>(idle());
  const [progress, setProgress] = useState<SampleProgress | null>(null);
  const [gaps, setGaps] = useState<HandGap[]>([]);
  const [readout, setReadout] = useState<Readout | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [delegate, setDelegate] = useState<string | null>(null);
  const detectMs = useRef<{ pose: number; hand: number } | null>(null);
  const [cost, setCost] = useState<{ pose: number; hand: number } | null>(null);
  /** frames whose hand came from a wrist crop rather than the full frame (far camera, gloves) */
  const [cropped, setCropped] = useState<number | null>(null);

  /** Draw frame `i` on the overlay; refresh the readout at most every 200 ms (`force` skips the wait). */
  const lastReadout = useRef(0);
  function show(i: number, force = false) {
    const ctx = overlayRef.current?.getContext("2d");
    if (!ctx) return;
    const list = frames.current;
    drawSkeleton(ctx, list[i] ?? null);
    if (i < 0) return;
    const now = performance.now();
    if (!force && now - lastReadout.current < 200) return;
    lastReadout.current = now;
    setReadout({
      frame: i + 1,
      t_s: list[i].t_s,
      left: wristSpeed(list, i, "left"),
      right: wristSpeed(list, i, "right"),
    });
  }

  // Watch the clip once: sample, detect, select, draw.
  useEffect(() => {
    const video = videoRef.current;
    if (!src || !video) return;
    const abort = new AbortController();
    frames.current = [];
    setGaps([]);
    setReadout(null);
    setElapsed(null);
    setProgress(null);
    setCropped(null);
    let lm: Detector | null = null;
    (async () => {
      setStage(running("Loading MediaPipe"));
      // reuse the worker only while it is alive; a dead one never answers
      const reuse = await detector.current?.catch(() => null);
      if (abort.signal.aborted) return;
      if (!reuse?.alive()) detector.current = startDetector();
      const ready = await detector.current!;
      lm = ready;
      if (abort.signal.aborted) return;
      setDelegate(ready.delegate);
      ready.newRun();
      setStage(running("Watching", 0));
      let lastSamples = -1;
      detectMs.current = null;
      const startedAt = performance.now();
      const result = await sampleVideo(video, {
        fps: FPS,
        width: SAMPLE_WIDTH,
        signal: abort.signal,
        async onFrame(bitmap, t) {
          const { width, height } = bitmap;
          setSize((s) => (s?.width === width && s.height === height ? s : { width, height }));
          // the worker tracks the person (frames reach it in order) and crops for them
          const { poses, hands, person, cropHands, ms } = await ready.detect(bitmap, t);
          if (abort.signal.aborted) return;
          const next = assembleFrame(t, poses, hands, person, width / height, cropHands);
          detectMs.current =
            detectMs.current === null
              ? ms
              : { pose: 0.9 * detectMs.current.pose + 0.1 * ms.pose, hand: 0.9 * detectMs.current.hand + 0.1 * ms.hand };
          frames.current.push(next);
          show(frames.current.length - 1);
        },
        onProgress(p) {
          if (p.samples === lastSamples || p.samples % 3 !== 0) return;
          lastSamples = p.samples;
          setProgress(p);
          setCost(detectMs.current);
          if (p.samples % 6 === 0) setGaps(fillHandGaps(frames.current).gaps);
        },
      });
      if (result.aborted) return;
      setElapsed((performance.now() - startedAt) / 1000);
      setProgress(result);
      setCost(detectMs.current);
      const filled = fillHandGaps(frames.current);
      frames.current = filled.frames;
      setCropped(filled.frames.filter((f) => f.left_hand?.cropped || f.right_hand?.cropped).length);
      setGaps(filled.gaps);
      setStage(
        done(
          {
            frames: filled.frames,
            gaps: filled.gaps,
            fps: FPS,
            width: result.width,
            height: result.height,
            duration_s: result.duration_s,
          },
          filled.gaps.map(
            (g) => `${g.side} hand unseen from ${clock(g.start_s)} to ${clock(g.end_s)}`,
          ),
        ),
      );
      video.currentTime = 0;
    })().catch((e: unknown) => {
      if (abort.signal.aborted) return;
      // a worker that failed is gone; the next clip starts a fresh one
      if (!lm?.alive()) detector.current = null;
      setStage(failed(e instanceof Error ? e.message : String(e)));
    });
    return () => abort.abort();
  }, [src]);

  // Stop the worker when the page goes away.
  useEffect(
    () => () => {
      detector.current?.then((d) => d.close()).catch(() => {});
      detector.current = null;
      if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
      // a sample download still in flight must not create a URL after this
      pick.current++;
    },
    [],
  );

  // After watching: replay the stored tokens over normal playback.
  const watched = stage.status === "done";
  useEffect(() => {
    const video = videoRef.current;
    if (!watched || !video) return;
    let handle = 0;
    const draw = () => show(frameAt(frames.current, video.currentTime), video.paused);
    const onFrame = () => {
      draw();
      handle = video.requestVideoFrameCallback(onFrame);
    };
    handle = video.requestVideoFrameCallback(onFrame);
    video.addEventListener("seeked", draw);
    draw();
    return () => {
      video.cancelVideoFrameCallback(handle);
      video.removeEventListener("seeked", draw);
    };
  }, [watched]);

  function choose(clip: Blob, id: number) {
    if (id !== pick.current) return;
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    blobUrl.current = URL.createObjectURL(clip);
    setSrc(blobUrl.current);
  }

  function loadSample(name: string) {
    const id = ++pick.current;
    fetch(`/samples/${name}.mp4`)
      .then((r) => {
        if (!r.ok) throw new Error(`The sample clip did not load (HTTP ${r.status}).`);
        return r.blob();
      })
      .then((b) => choose(b, id))
      .catch((e: Error) => {
        if (id === pick.current) setStage(failed(e.message));
      });
  }

  const pct = progress && progress.duration_s ? (100 * progress.t_s) / progress.duration_s : 0;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Watch</h1>
        <p className="text-sm text-neutral-600">
          Dev page for stage 1. MediaPipe pose and hand landmarks, sampled at {FPS} fps, run in
          this browser; the clip is never uploaded.
        </p>
      </header>

      <section className="flex flex-wrap items-center gap-3 text-sm">
        <label className="cursor-pointer rounded-lg border px-3 py-2 hover:bg-neutral-500/10">
          Choose an H.264 MP4
          <input
            type="file"
            accept="video/mp4"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) choose(file, ++pick.current);
              e.target.value = "";
            }}
          />
        </label>
        {SAMPLES.map((clip) => (
          <button
            key={clip.name}
            type="button"
            className="rounded-lg border px-3 py-2 hover:bg-neutral-500/10"
            onClick={() => loadSample(clip.name)}
          >
            {clip.label}
          </button>
        ))}
        <span className="text-neutral-500">
          {stage.status === "idle" && "Pick a clip to start."}
          {stage.status === "running" && `${stage.note}…`}
          {stage.status === "done" && "Watched. Play the clip to see the stored tokens."}
        </span>
      </section>

      {stage.status === "failed" && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          {stage.message}
          {stage.message.includes("decoded") &&
            " If this is an iPhone clip, it may be HEVC: Settings > Camera > Formats > Most Compatible, then film again."}
        </p>
      )}

      {gaps.length > 0 && (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-medium">Hand lost for more than half a second</p>
          <ul className="mt-1 list-disc pl-5">
            {gaps.map((g) => (
              <li key={`${g.side}-${g.start_s}`}>
                {g.side} hand, {clock(g.start_s)} to {clock(g.end_s)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div
        className="relative w-full overflow-hidden rounded-xl bg-neutral-900"
        style={{ aspectRatio: size ? `${size.width} / ${size.height}` : "16 / 9" }}
      >
        <video
          ref={videoRef}
          src={src ?? undefined}
          className="absolute inset-0 h-full w-full"
          playsInline
          muted
          controls={watched}
          onError={() =>
            src && setStage(failed("The video could not be decoded.", false))
          }
        />
        <canvas
          ref={overlayRef}
          width={size?.width ?? 640}
          height={size?.height ?? 360}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-500/20" aria-label="progress">
        <div
          className="h-full bg-foreground transition-[width]"
          style={{ width: `${watched ? 100 : pct}%` }}
        />
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-[auto_1fr_auto_1fr]">
        <dt className="text-neutral-500">frames</dt>
        <dd data-testid="frames">
          {readout?.frame ?? 0} / {stage.status === "done" ? stage.value.frames.length : (progress?.samples ?? 0)}
        </dd>
        <dt className="text-neutral-500">time</dt>
        <dd>{readout ? clock(readout.t_s) : "–"}</dd>
        <dt className="text-neutral-500">
          <Swatch colour={COLOURS.left} />
          left wrist
        </dt>
        <dd>{speed(readout?.left ?? null)}</dd>
        <dt className="text-neutral-500">
          <Swatch colour={COLOURS.right} />
          right wrist
        </dt>
        <dd>{speed(readout?.right ?? null)}</dd>
        <dt className="text-neutral-500">samples</dt>
        <dd>
          {progress
            ? `${progress.samples} sampled, ${progress.skipped} skipped, ${progress.waits} waits`
            : "–"}
        </dd>
        <dt className="text-neutral-500">watch time</dt>
        <dd data-testid="watch-time">
          {elapsed !== null && progress
            ? `${elapsed.toFixed(1)} s for ${progress.duration_s.toFixed(1)} s (${(elapsed / progress.duration_s).toFixed(2)}x)`
            : "–"}
        </dd>
        <dt className="text-neutral-500">MediaPipe</dt>
        <dd>
          {delegate ?? "–"}
          {cost && `, pose ${cost.pose.toFixed(0)} ms + hands ${cost.hand.toFixed(0)} ms`}
        </dd>
        <dt className="text-neutral-500">wrist crops</dt>
        <dd data-testid="wrist-crops">
          {stage.status === "done" && cropped !== null
            ? `hands found by zooming on the wrist in ${cropped} of ${stage.value.frames.length} frames`
            : "–"}
        </dd>
      </dl>
    </main>
  );
}
