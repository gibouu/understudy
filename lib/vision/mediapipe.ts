/**
 * MediaPipe Pose Landmarker and Hand Landmarker in VIDEO mode, loaded from the
 * self-hosted copies under public/mediapipe/ (sources and licences in its
 * README). Runs inside `mediapipe.worker.ts`; the page talks to it through
 * `detector.ts`.
 */
import { HandLandmarker, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { DetectedHand } from "./select";
import type { Point3, PoseTokens } from "./types";

const BASE = "/mediapipe";
/** The wasm copied from @mediapipe/tasks-vision 1.1.1; it must match the installed package. */
const WASM = {
  wasmLoaderPath: `${BASE}/wasm/vision_wasm_internal.js`,
  wasmBinaryPath: `${BASE}/wasm/vision_wasm_internal.wasm`,
};
const POSE_MODEL = `${BASE}/models/pose_landmarker_full.task`;
const HAND_MODEL = `${BASE}/models/hand_landmarker.task`;

export type Detections = {
  poses: PoseTokens[];
  hands: DetectedHand[];
  /** wall time of each model on this frame */
  ms: { pose: number; hand: number };
};

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
  return { pose, hand };
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
  const { pose, hand } = models;
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
      const t2 = performance.now();
      return {
        ms: { pose: t1 - t0, hand: t2 - t1 },
        poses: p.landmarks.map((image, i) => ({
          image: image.map(point),
          world: (p.worldLandmarks[i] ?? []).map(point),
          visibility: image.map((l) => l.visibility ?? 0),
        })),
        hands: h.landmarks.map((image, i) => ({
          image: image.map(point),
          world: (h.worldLandmarks[i] ?? []).map(point),
          score: h.handedness[i]?.[0]?.score ?? 0,
        })),
      };
    },
    close() {
      pose.close();
      hand.close();
    },
  };
}
