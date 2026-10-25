/**
 * Worker that owns the MediaPipe landmarkers, so the models never block
 * the page while the video plays. Protocol in `detector.ts`.
 */
import { loadLandmarkers, type Landmarkers } from "./mediapipe";
import type { WorkerReply, WorkerRequest } from "./detector";

type Scope = {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply): void;
};
const scope = self as unknown as Scope;

let landmarkers: Promise<Landmarkers> | null = null;

scope.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      landmarkers ??= loadLandmarkers();
      scope.postMessage({ type: "loaded", delegate: (await landmarkers).delegate });
    } else if (data.type === "run") {
      (await landmarkers!).newRun();
    } else if (data.type === "detect") {
      try {
        const detections = (await landmarkers!).detect(data.frame, data.t_s);
        scope.postMessage({ type: "detections", id: data.id, detections });
      } finally {
        data.frame.close();
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    scope.postMessage({ type: "error", id: data.type === "detect" ? data.id : undefined, message });
  }
};
