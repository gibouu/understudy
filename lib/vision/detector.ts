/**
 * The page's handle on the MediaPipe worker: frames go in as transferred
 * ImageBitmaps, detections come back in order.
 */
import type { Delegate, Detections } from "./mediapipe";

export type WorkerRequest =
  | { type: "load" }
  | { type: "run" }
  | { type: "detect"; id: number; frame: ImageBitmap; t_s: number; focus: { x: number; y: number } | null };

export type WorkerReply =
  | { type: "loaded"; delegate: Delegate }
  | { type: "detections"; id: number; detections: Detections }
  | { type: "error"; id?: number; message: string };

export type Detector = {
  delegate: Delegate;
  /**
   * Transfers `frame` to the worker. `t_s` must increase within a run. `focus`
   * is the tracked person's hip, so wrist crops go to them first.
   */
  detect(frame: ImageBitmap, t_s: number, focus?: { x: number; y: number } | null): Promise<Detections>;
  /** Call before a new clip. */
  newRun(): void;
  /** false once the worker failed or was closed */
  alive(): boolean;
  close(): void;
};

export function startDetector(): Promise<Detector> {
  const worker = new Worker(new URL("./mediapipe.worker.ts", import.meta.url), { type: "module" });
  const post = (msg: WorkerRequest, transfer: Transferable[] = []) => worker.postMessage(msg, transfer);
  const pending = new Map<number, { resolve: (d: Detections) => void; reject: (e: Error) => void }>();
  let nextId = 0;
  let alive = true;

  return new Promise((resolve, reject) => {
    // after a worker-level failure the worker is of no further use
    const failAll = (message: string) => {
      const error = new Error(message);
      alive = false;
      worker.terminate();
      reject(error);
      for (const p of pending.values()) p.reject(error);
      pending.clear();
    };
    worker.onerror = (e) => failAll(e.message || "The MediaPipe worker failed to start.");
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      if (data.type === "loaded") {
        resolve({
          delegate: data.delegate,
          detect(frame, t_s, focus = null) {
            const id = nextId++;
            return new Promise((res, rej) => {
              pending.set(id, { resolve: res, reject: rej });
              post({ type: "detect", id, frame, t_s, focus }, [frame]);
            });
          },
          newRun: () => post({ type: "run" }),
          alive: () => alive,
          close: () => failAll("The MediaPipe worker was closed."),
        });
      } else if (data.type === "detections") {
        pending.get(data.id)?.resolve(data.detections);
        pending.delete(data.id);
      } else if (data.id === undefined) {
        failAll(data.message);
      } else {
        pending.get(data.id)?.reject(new Error(data.message));
        pending.delete(data.id);
      }
    };
    post({ type: "load" });
  });
}
