/** Main-thread handle on the MuJoCo worker. */
import type { Frame, FromWorker, SimMeta, ToWorker, Waypoint } from "./protocol";
import { SO101_ASSET_BASE } from "./so101";

export type SimEvents = {
  status: (message: string, progress?: number) => void;
  loaded: (meta: SimMeta) => void;
  frame: (frame: Frame) => void;
  error: (message: string) => void;
};

export class SimClient {
  private worker: Worker;
  private listeners: Partial<SimEvents> = {};
  private jacobianWaiters: ((r: Extract<FromWorker, { type: "jacobian" }>) => void)[] = [];
  meta: SimMeta | null = null;

  constructor() {
    this.worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.dispatch(e.data);
    this.worker.onerror = (e) => this.listeners.error?.(e.message || "worker error");
  }

  on<K extends keyof SimEvents>(event: K, fn: SimEvents[K]) {
    this.listeners[event] = fn;
    return this;
  }

  /** `mujocoBase` serves mujoco.js and mujoco.wasm (copied there by scripts/copy-assets.mjs). */
  load(mujocoBase = "/mujoco", assetBase = SO101_ASSET_BASE) {
    this.send({ type: "load", mujocoBase, assetBase });
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
  jacobian(site: string) {
    return new Promise<Extract<FromWorker, { type: "jacobian" }>>((resolve) => {
      this.jacobianWaiters.push(resolve);
      this.send({ type: "jacobian", site });
    });
  }
  dispose() {
    this.worker.terminate();
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
        this.listeners.loaded?.(msg.meta);
        break;
      case "frame":
        this.listeners.frame?.(msg.frame);
        break;
      case "jacobian":
        this.jacobianWaiters.shift()?.(msg);
        break;
      case "error":
        this.listeners.error?.(msg.message);
        break;
    }
  }
}
