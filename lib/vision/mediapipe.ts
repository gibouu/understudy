/**
 * MediaPipe Pose Landmarker and Hand Landmarker in VIDEO mode, loaded from the
 * self-hosted copies under public/mediapipe/ (sources and licences in its
 * README). Runs inside `mediapipe.worker.ts`; the page talks to it through
 * `detector.ts`.
 */
import { HandLandmarker, PoseLandmarker } from "@mediapipe/tasks-vision";
import { addHand, cropHandReach, missingWrists, uncrop, wristCrop } from "./crop";
import type { DetectedHand } from "./select";
import type { Point3, PoseTokens } from "./types";

const BASE = "/mediapipe";
/** Published by scripts/copy-assets.mjs from the installed @mediapipe/tasks-vision. */
const WASM = {
  wasmLoaderPath: `${BASE}/wasm/vision_wasm_internal.js`,
  wasmBinaryPath: `${BASE}/wasm/vision_wasm_internal.wasm`,
};
const POSE_MODEL = `${BASE}/models/pose_landmarker_full.task`;
const HAND_MODEL = `${BASE}/models/hand_landmarker.task`;
/** initial size of the crop canvas; it is resized per crop */
const MIN_CANVAS = 64;
/**
 * Colour remap applied to every wrist crop before the Hand Landmarker sees it.
 * The model is trained on bare skin and finds nothing on a nitrile glove; a
 * sepia tone makes a glove of any colour read as a hand (measured on the ISS
 * clip: 0 hands without it, both hands with it; bare hands are unaffected).
 */
export const CROP_FILTER = "sepia(1) saturate(1.4)";
/** detection and presence threshold on the crops (the full-frame pass keeps the default 0.5) */
export const CROP_CONFIDENCE = 0.3;

export type Detections = {
  poses: PoseTokens[];
  hands: DetectedHand[];
  /** wall time of each model on this frame; `hand` includes the crops */
  ms: { pose: number; hand: number };
  /** wrist crops the Hand Landmarker ran on, after the full frame (see crop.ts) */
  crops: number;
};

/** Most wrist crops per frame: two people's two hands. */
export const MAX_CROPS = 4;

export type Delegate = "GPU" | "CPU";

export type Landmarkers = {
  /** Runs both models on one frame. `t_s` must increase within a run. */
  detect(frame: ImageBitmap, t_s: number): Detections;
  /** Call before a new clip: VIDEO mode needs timestamps that never go back. */
  newRun(): void;
  delegate: Delegate;
  close(): void;
};

const point = ({ x, y, z }: Point3): Point3 => ({ x, y, z });

async function create(delegate: Delegate) {
  const pose = await PoseLandmarker.createFromOptions(WASM, {
    baseOptions: { modelAssetPath: POSE_MODEL, delegate },
    runningMode: "VIDEO",
    numPoses: 3,
  });
  const hand = await HandLandmarker.createFromOptions(WASM, {
    baseOptions: { modelAssetPath: HAND_MODEL, delegate },
    runningMode: "VIDEO",
    // two people's hands, so a neighbour's hand can be told apart from the selected person's
    numHands: 4,
  }).catch((e: unknown) => {
    pose.close();
    throw e;
  });
  // IMAGE mode for the wrist crops: each crop is a picture of its own, so the
  // VIDEO mode's hand tracking must not carry over between them
  const crop = await HandLandmarker.createFromOptions(WASM, {
    baseOptions: { modelAssetPath: HAND_MODEL, delegate },
    runningMode: "IMAGE",
    numHands: 2,
    // a crop is already aimed at a wrist and matchHands checks the distance, so a lower bar is safe
    minHandDetectionConfidence: CROP_CONFIDENCE,
    minHandPresenceConfidence: CROP_CONFIDENCE,
  }).catch((e: unknown) => {
    pose.close();
    hand.close();
    throw e;
  });
  return { pose, hand, crop };
}

export async function loadLandmarkers(): Promise<Landmarkers> {
  let delegate: Delegate = "GPU";
  let models: Awaited<ReturnType<typeof create>>;
  try {
    models = await create("GPU");
  } catch {
    delegate = "CPU";
    models = await create("CPU");
  }
  const { pose, hand, crop } = models;
  let canvas: OffscreenCanvas;
  let ctx: OffscreenCanvasRenderingContext2D | null;
  try {
    canvas = new OffscreenCanvas(MIN_CANVAS, MIN_CANVAS);
    ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D context for the wrist crops.");
  } catch (e) {
    pose.close();
    hand.close();
    crop.close();
    throw e;
  }
  // a browser without canvas filters just crops; resizing the canvas resets the filter, so it is set per crop
  const filtered = "filter" in ctx;
  let last = -1;
  let offset = 0;
  return {
    delegate,
    newRun() {
      offset = last + 1;
    },
    detect(frame, t_s) {
      const ts = Math.max(last + 1, offset + Math.round(t_s * 1000));
      last = ts;
      const t0 = performance.now();
      const p = pose.detectForVideo(frame, ts);
      const t1 = performance.now();
      const h = hand.detectForVideo(frame, ts);
      const poses: PoseTokens[] = p.landmarks.map((image, i) => ({
        image: image.map(point),
        world: (p.worldLandmarks[i] ?? []).map(point),
        visibility: image.map((l) => l.visibility ?? 0),
      }));
      const hands: DetectedHand[] = h.landmarks.map((image, i) => ({
        image: image.map(point),
        world: (h.worldLandmarks[i] ?? []).map(point),
        score: h.handedness[i]?.[0]?.score ?? 0,
      }));
      // Second look: a crop around every wrist the full frame gave no hand.
      const { width, height } = frame;
      const aspect = width / height;
      let crops = 0;
      const poseImages = poses.map((x) => x.image);
      for (const [p_i, person] of poses.entries()) {
        if (crops >= MAX_CROPS) break;
        for (const side of missingWrists(poseImages, p_i, hands.map((x) => x.image), aspect)) {
          if (crops >= MAX_CROPS) break;
          const win = wristCrop(person, side, width, height);
          if (!win) continue;
          crops++;
          canvas.width = win.side;
          canvas.height = win.side;
          if (filtered) ctx.filter = CROP_FILTER;
          ctx.drawImage(frame, win.x0, win.y0, win.side, win.side, 0, 0, win.side, win.side);
          const c = crop.detect(canvas);
          // one hand per crop: the acceptable detection nearest this wrist (a hand
          // nearer the person's other wrist is that wrist's, or a copy of it); a
          // copy of a hand already in the list is dropped before the next
          // person's wrists are judged against the list
          let best: DetectedHand | null = null;
          let bestReach = Infinity;
          c.landmarks.forEach((image, i) => {
            const mapped = image.map((l) => uncrop(l, win, width, height));
            const reach = cropHandReach(mapped, person.image, side, aspect);
            if (reach === null || reach >= bestReach) return;
            bestReach = reach;
            best = { image: mapped, world: (c.worldLandmarks[i] ?? []).map(point), score: c.handedness[i]?.[0]?.score ?? 0, cropped: true };
          });
          if (best) addHand(hands, best, aspect);
        }
      }
      const t2 = performance.now();
      return { ms: { pose: t1 - t0, hand: t2 - t1 }, poses, hands, crops };
    },
    close() {
      pose.close();
      hand.close();
      crop.close();
    },
  };
}
