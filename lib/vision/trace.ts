/**
 * The path of each gesture step, traced from the clip in the browser: the
 * frames in the step's time window decoded at TRACE_FPS (mediabunny, the same
 * frames on every run), MediaPipe pose and hands on each (lib/vision/detector.ts),
 * the hand that moved more followed (lib/vision/hand.ts), and its path scaled
 * into the arm's reach (lib/sim/gesture.ts). Super VL's label says a step is a gesture and which
 * hand made it; the coordinates are measured here, never asked of a model.
 * Nothing leaves the browser.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { scalePath } from "@/lib/sim/gesture";
import { GESTURE_REACH_MM, type Step, type TaskSpec } from "@/lib/spec/schema";
import { done, type StageResult } from "@/lib/spec/stage-result";
import { startDetector } from "./detector";
import { assembleFrame } from "./select";
import type { TokenFrame } from "./types";
import { armLength, busierHand, clipOrigin, handGaps, handSamples, sampleTimes } from "./hand";

/** a clip's own rate: a wave turns back three times a second, which 10 fps would alias */
export const TRACE_FPS = 30;
/** wide enough that a wrist crop keeps real pixels (lib/vision/crop.ts), as on /watch */
const TRACE_WIDTH = 960;

const untraced = (s: Step) => s.verb === "gesture" && (s.gesture?.path.length ?? 0) < 2;

/** True when a gesture step still has no path: the clip has to be traced before the spec can be rehearsed. */
export const needsTrace = (spec: TaskSpec) => spec.steps.some(untraced);

/** Fills the path of every gesture step that has none; `warnings` say what was measured and what was not. */
export async function traceGestures(spec: TaskSpec, clip: Blob, onProgress?: (done: number, total: number) => void): Promise<{ spec: TaskSpec; warnings: string[] }> {
  const todo = spec.steps.filter(untraced);
  if (todo.length === 0) return { spec, warnings: [] };
  const input = new Input({ source: new BlobSource(clip), formats: ALL_FORMATS });
  const frames: TokenFrame[] = [];
  try {
    await sample(input, todo, frames, onProgress);
  } finally {
    input.dispose();
  }

  const warnings: string[] = [];
  const steps = spec.steps.map((s): Step => {
    if (!untraced(s)) return s;
    const [t0, t1] = [s.t_start_s, s.t_end_s];
    const side = busierHand(frames, t0, t1);
    if (!side) {
      warnings.push(`step ${s.id}: MediaPipe did not see either hand between ${t0} and ${t1} s; no path`);
      return s;
    }
    if (s.gesture?.hand && s.gesture.hand !== side) warnings.push(`step ${s.id}: the label named the ${s.gesture.hand} hand; the ${side} hand moved more and is the one followed`);
    const samples = handSamples(frames, side, t0, t1);
    const arm = armLength(frames, side, t0, t1);
    const scaled = scalePath(samples, arm);
    const seenIn = `seen in ${samples.length} of ${frames.filter((f) => f.t_s >= t0 - 1e-9 && f.t_s <= t1 + 1e-9).length} frames`;
    warnings.push(`step ${s.id}: the ${side} hand, ${seenIn}${arm === null ? "" : `, on an arm of ${Math.round(arm * 1000)} mm`}, drawn at ${scaled.mm_per_m} mm per metre it moved`);
    for (const g of handGaps(samples, t0, t1)) warnings.push(`step ${s.id}: the hand was unseen from ${g.start_s.toFixed(1)} to ${g.end_s.toFixed(1)} s; the arm goes straight across`);
    warnings.push(...scaled.warnings.map((w) => `step ${s.id}: ${w}`));
    if (scaled.path.length < 2) return s;
    return {
      ...s,
      gesture: { hand: side, reach_mm: s.gesture?.reach_mm ?? GESTURE_REACH_MM, path: scaled.path },
      sources: { ...s.sources, "gesture.path": `pose#${t0}-${t1}s`, "gesture.hand": `pose#${t0}-${t1}s` },
    };
  });
  return { spec: { ...spec, steps }, warnings };
}

/** The frames of every step's window, decoded and run through MediaPipe in order, into `frames`. */
async function sample(input: Input, todo: Step[], frames: TokenFrame[], onProgress?: (done: number, total: number) => void) {
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("the clip has no video track to trace the hand on");
  // the label's clip seconds count from the proxy's start, which mediabunny's conversion puts at the track's first
  // timestamp, or 0 when that is negative (preroll is never shown)
  const origin = clipOrigin(await track.getFirstTimestamp());
  const end = await track.computeDuration();
  const times = sampleTimes(todo.map((s) => [s.t_start_s, s.t_end_s]), end - origin, TRACE_FPS);
  const detector = await startDetector();
  try {
    detector.newRun();
    const sink = new CanvasSink(track, { width: TRACE_WIDTH });
    let k = 0;
    let last = -Infinity;
    for await (const c of sink.canvasesAtTimestamps(times.map((t) => origin + t))) {
      onProgress?.(++k, times.length);
      // a clip slower than TRACE_FPS returns a frame twice: once is a measurement, twice is not
      if (!c || c.timestamp < origin || c.timestamp <= last) continue;
      last = c.timestamp;
      const t = Math.round((c.timestamp - origin) * 10000) / 10000;
      const bitmap = await createImageBitmap(c.canvas);
      const aspect = bitmap.width / bitmap.height;
      const d = await detector.detect(bitmap, t);
      frames.push(assembleFrame(t, d.poses, d.hands, d.person, aspect, d.cropHands));
    }
  } finally {
    detector.close();
  }
}

/**
 * For the flow, between the label and the fit: a label whose gesture steps still need a path gets them traced
 * (`onNote` says so while it runs); anything else passes through. A trace that fails leaves the steps without a
 * path, which the fit reports, and says why in `notes`.
 */
export async function withGesturePaths(r: StageResult<TaskSpec>, clip: Blob, onNote: (note: string) => void): Promise<{ result: StageResult<TaskSpec>; notes: string[] }> {
  if (r.status !== "done" || !needsTrace(r.value)) return { result: r, notes: [] };
  onNote("Super VL saw a gesture; MediaPipe is tracing the hand in your browser");
  try {
    const t = await traceGestures(r.value, clip, (k, n) => onNote(`MediaPipe is tracing the hand in your browser, frame ${k} of ${n}`));
    return { result: done(t.spec, r.warnings, r.ledger), notes: t.warnings };
  } catch (err) {
    return { result: r, notes: [`the hand could not be traced in this browser: ${(err as Error).message}`] };
  }
}
