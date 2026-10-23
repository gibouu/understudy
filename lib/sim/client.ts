/** Main-thread handle on the MuJoCo worker. Requests carry ids; errors reach their caller. */
import type { Frame, FromWorker, SimMeta, ToWorker, Waypoint } from "./protocol";
import { SO101_ASSET_BASE } from "./so101";

export type SimEvents = {
  status: (message: string, progress?: number) => void;
  loaded: (meta: SimMeta) => void;
  frame: (frame: Frame) => void;
  error: (message: string) => void;
};

type JacobianResult = Extract<FromWorker, { type: "jacobian" }>;
type Pending = { resolve: (v: never) => void; reject: (e: Error) => void };

export class SimClient {
  private worker: Worker;
  private listeners: Partial<SimEvents> = {};
  private pending = new Map<number, Pending>();
  private nextId = 1;
  meta: SimMeta | null = null;

  constructor() {
    this.worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.dispatch(e.data);
    this.worker.onerror = (e) => {
      const message = e.message || "worker error";
      this.rejectAll(new Error(message));
      this.listeners.error?.(message);
    };
  }

  on<K extends keyof SimEvents>(event: K, fn: SimEvents[K]) {
    this.listeners[event] = fn;
    return this;
  }

  /** `mujocoBase` serves mujoco.js and mujoco.wasm (copied there by scripts/copy-assets.mjs). */
  load(mujocoBase = "/mujoco", assetBase = SO101_ASSET_BASE): Promise<SimMeta> {
    return this.request<SimMeta>((id) => ({ type: "load", id, mujocoBase, assetBase }));
  }
  setCtrl(ctrl: number[]) {
    this.send({ type: "setCtrl", ctrl });
  }
  play(waypoints: Waypoint[], loop = false) {
    this.send({ type: "play", waypoints, loop });
  }
  stop() {
    this.send({ type: "stop" });
  }
  reset() {
    this.send({ type: "reset" });
  }
  jacobian(site: string): Promise<JacobianResult> {
    return this.request<JacobianResult>((id) => ({ type: "jacobian", id, site }));
  }
  dispose() {
    this.rejectAll(new Error("sim client disposed"));
    this.worker.terminate();
  }

  private request<T>(build: (id: number) => ToWorker): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.send(build(id));
    });
  }

  private settle(id: number | undefined, value: unknown, error?: Error) {
    if (id === undefined) return false;
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    if (error) p.reject(error);
    else p.resolve(value as never);
    return true;
  }

  private rejectAll(error: Error) {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  private send(msg: ToWorker) {
    this.worker.postMessage(msg);
  }

  private dispatch(msg: FromWorker) {
    switch (msg.type) {
      case "status":
        this.listeners.status?.(msg.message, msg.progress);
        break;
      case "loaded":
        this.meta = msg.meta;
        this.settle(msg.id, msg.meta);
        this.listeners.loaded?.(msg.meta);
        break;
      case "frame":
        this.listeners.frame?.(msg.frame);
        break;
      case "jacobian":
        this.settle(msg.id, msg);
        break;
      case "error":
        if (!this.settle(msg.id, undefined, new Error(msg.message))) this.listeners.error?.(msg.message);
        break;
    }
  }
}
