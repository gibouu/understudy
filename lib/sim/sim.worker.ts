/**
 * The MuJoCo worker: loads the WebAssembly engine once, writes the SO-101 MJCF
 * and meshes into its file system once, builds the model and steps it at the
 * stage's speed (real time unless told otherwise). The main thread gets
 * geometry once (loaded) and poses every tick.
 *
 * Ownership rules (Embind objects live on the wasm heap and are never
 * garbage-collected): the engine is created once per worker; a load builds
 * its model and data in local variables and swaps them in atomically, then
 * deletes what it replaced; loads are serialized, a second load while one is
 * running is refused.
 */
import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import { graspIndex, isAttached, type Grasp } from "./grasp";
import { solveIk, type Approach } from "./ik";
import { environment, forgetTilt, run, type Environment, type Rollout, type Tick } from "./interpreter";
import { Liquid, LIQUID_STEP_S } from "./liquid";
import { decodeName, sampleWaypoints, toNumbers } from "./names";
import {
  GEOM_MESH,
  type Frame,
  type FromWorker,
  type GeomMeta,
  type MeshMeta,
  type SimMeta,
  type ToWorker,
  type Waypoint,
} from "./protocol";
import { G_M_S2, mountSo101, park, SO101_MESH_BUNDLE, SO101_MESHES, SO101_XML, stageXml } from "./so101";

type WorkerCtx = {
  postMessage: (message: FromWorker, transfer?: Transferable[]) => void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};
const ctx = self as unknown as WorkerCtx;

type Runtime = { mujoco: MainModule; model: MjModel; data: MjData; meta: SimMeta; env: Environment; grasps: Grasp[]; liquid: Liquid | null };

/** Simulated seconds of backlog we are willing to catch up per tick; beyond it time is dropped and reported. */
const MAX_BACKLOG_S = 0.25;
/**
 * With a liquid, two of its steps at most: a liquid step that overruns the frame would otherwise make every
 * tick catch up a quarter second of them, and the stage would stall instead of running slower than real time.
 */
const MAX_LIQUID_BACKLOG_S = 2 * LIQUID_STEP_S;
const TICK_MS = 1000 / 60;
/**
 * Wall-clock milliseconds a tick may spend stepping. A speed that asks for more physics than the CPU does in a frame
 * (a liquid at 2x) then runs as fast as it can at a steady frame rate, instead of in ever longer ticks; the backlog
 * left over waits for the next tick, up to the cap.
 */
const TICK_BUDGET_MS = 12;

let enginePromise: Promise<MainModule> | null = null;
/** the SO-101's files, fetched and written into the engine's file system once per worker */
let so101Promise: Promise<void> | null = null;
let loading: Promise<void> | null = null;
let runtime: Runtime | null = null;
/** a setGravity that arrived while a load was in flight; applied when the load completes */
let wantedGravity: number | null = null;
/** mjtJoint.mjJNT_FREE */
const FREE_JOINT = 0;
let playing: { waypoints: Waypoint[]; loop: boolean; start: number } | null = null;
/** a program running in real time: the tick advances it one physics step at a time */
let running: { id: number; it: Generator<Tick, Rollout> } | null = null;
let simTime = 0;
let backlog = 0;
let dropped = 0;
let lastWall = 0;
/** simulated seconds per wall-clock second; the physics steps the same, only the pace changes */
let speed = 1;
let timer: ReturnType<typeof setInterval> | null = null;

const post = (m: FromWorker, transfer?: Transferable[]) => ctx.postMessage(m, transfer);
const status = (message: string, progress?: number) => post({ type: "status", message, progress });

function errorText(err: unknown, mujoco?: MainModule | null): string {
  if (err instanceof Error) return err.message;
  const m = mujoco as unknown as { getExceptionMessage?: (e: unknown) => string[] } | undefined;
  if (typeof err === "number" && m?.getExceptionMessage) {
    try {
      return m.getExceptionMessage(err).join(": ");
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

ctx.onmessage = async (e) => {
  const msg = e.data;
  const id = "id" in msg ? msg.id : undefined;
  try {
    switch (msg.type) {
      case "load":
        if (loading) throw new Error("a load is already in progress");
        wantedGravity = null; // the load's own gravity is the latest instruction
        loading = load(msg.id, msg.mujocoBase, msg.assetBase, environment(msg.spec, msg.scenario), msg.gravityG).finally(() => {
          loading = null;
        });
        await loading;
        break;
      case "setCtrl":
        playing = null;
        cancelRun("the arm was driven by hand");
        if (runtime) forgetTilt(runtime.data);
        setCtrl(msg.ctrl);
        break;
      case "play":
        cancelRun("the arm was driven by hand");
        if (runtime) forgetTilt(runtime.data);
        playing = { waypoints: msg.waypoints, loop: msg.loop ?? false, start: simTime };
        break;
      case "stop":
        playing = null;
        cancelRun("stopped");
        break;
      case "reset":
        reset(msg.seed);
        break;
      case "setGravity":
        setGravity(msg.g);
        break;
      case "setSpeed":
        speed = Math.max(0.25, Math.min(8, msg.speed));
        break;
      case "nudge":
        nudge(msg.body, msg.velocity);
        break;
      case "jacobian":
        jacobian(msg.id, msg.site);
        break;
      case "ik":
        ik(msg.id, msg.target, msg.approach, msg.site);
        break;
      case "run": {
        if (!runtime) throw new Error("model not loaded");
        cancelRun("a newer program replaced it");
        playing = null;
        // a reset and a gravity sent with the run apply in the same task as its start: no tick falls between them
        if (msg.reset) reset(msg.reset.seed);
        if (msg.gravityG !== undefined) setGravity(msg.gravityG);
        const { mujoco, model, data, env, liquid } = runtime;
        running = { id: msg.id, it: run({ mujoco, model, data, liquid }, env, msg.program, msg.mode, { from: msg.from }) };
        break;
      }
    }
  } catch (err) {
    post({ type: "error", id, message: errorText(err, runtime?.mujoco) });
  }
};

async function engine(mujocoBase: string): Promise<MainModule> {
  enginePromise ??= (async () => {
    status("loading MuJoCo WebAssembly");
    // The Emscripten loader carries Node-only branches (import('module'), require('fs'))
    // that bundlers cannot resolve, so it is served as a static file and imported at runtime.
    const loader = (await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ `${mujocoBase}/mujoco.js`
    )) as { default: (options?: { locateFile?: (p: string) => string }) => Promise<MainModule> };
    return loader.default({ locateFile: (p: string) => `${mujocoBase}/${p}` });
  })().catch((err: unknown) => {
    enginePromise = null; // a failed initialization may be retried
    throw err;
  });
  return enginePromise;
}

/** The arm's files, fetched once: a later load in this worker only compiles. */
function so101(mujoco: MainModule, assetBase: string): Promise<void> {
  so101Promise ??= (async () => {
    status("engine ready; fetching the SO-101", 0.05);
    const res = await fetch(`${assetBase}/${SO101_XML}`);
    if (!res.ok) throw new Error(`${SO101_XML}: HTTP ${res.status}`);
    const xml = new Uint8Array(await res.arrayBuffer());
    mountSo101(mujoco, xml, await fetchMeshes(assetBase, mujoco));
  })().catch((err: unknown) => {
    so101Promise = null; // a failed fetch may be retried
    throw err;
  });
  return so101Promise;
}

/** `gravityG` overrides the scenario's gravity (the /stage switch). */
async function load(id: number, mujocoBase: string, assetBase: string, env: Environment, gravityG = env.gravity_g) {
  const mujoco = await engine(mujocoBase);
  await so101(mujoco, assetBase);
  let model: MjModel | null = null;
  let data: MjData | null = null;
  try {
    status("compiling the model", 0.7);
    model = mujoco.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: gravityG, graspable: env.graspable }));
    data = new mujoco.MjData(model);
    park(mujoco, model, data);
    const liquid = env.liquid ? new Liquid(mujoco, model, data, env.liquid, { gravity_g: gravityG }) : null;
    const meta: SimMeta = {
      ...extractMeta(model),
      gravity_g: gravityG,
      liquid: env.liquid && liquid ? { particles: liquid.count, spacing_m: env.liquid.spacing_m, ml: env.liquid.fills.reduce((s, f) => s + f.ml, 0), warnings: env.liquid.warnings } : null,
    };

    const previous = runtime;
    runtime = { mujoco, model, data, meta: { ...meta, meshes: [] }, env, grasps: env.graspable.map((b) => graspIndex(mujoco, model!, b)), liquid };
    if (wantedGravity !== null) {
      // the user changed gravity while this load was in flight
      const g = wantedGravity;
      wantedGravity = null;
      setGravity(g);
      meta.gravity_g = g;
    }
    model = null; // ownership moved into runtime
    data = null;
    if (previous) {
      previous.data.delete();
      previous.model.delete();
    }
    playing = null;
    cancelRun("the model was reloaded");
    simTime = 0;
    backlog = 0;
    dropped = 0;
    lastWall = performance.now();

    status(`model ready: ${meta.nq} dof, ${meta.ngeom} geoms, ${meta.meshes.length} meshes`, 1);
    post({ type: "loaded", id, meta }, meta.meshes.flatMap((m) => [m.vertices.buffer, m.faces.buffer]));
    timer ??= setInterval(tick, TICK_MS);
  } finally {
    if (data) data.delete(); // only on failure: a partial allocation
    if (model) model.delete();
  }
}

/** Mesh bundle first (one gzipped request, decompressed here), per-file fallback. */
async function fetchMeshes(assetBase: string, mujoco: MainModule): Promise<{ name: string; bytes: Uint8Array }[]> {
  if (typeof DecompressionStream === "function") {
    try {
      const res = await fetch(`${assetBase}/${SO101_MESH_BUNDLE}`);
      if (res.ok && res.body) {
        const buf = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
        const entries = readBundle(buf);
        status(`meshes ready: ${entries.length} files, ${(buf.byteLength / 1e6).toFixed(1)} MB unpacked`, 0.65);
        return entries;
      }
      status(`mesh bundle HTTP ${res.status}; fetching files`, 0.1);
    } catch (err) {
      status(`mesh bundle unavailable (${errorText(err, mujoco)}); fetching files`, 0.1);
    }
  }
  let fetched = 0;
  // allSettled: every download is reported before a failure propagates
  const results = await Promise.allSettled(
    SO101_MESHES.map(async (name) => {
      const res = await fetch(`${assetBase}/assets/${name}`);
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      fetched++;
      status(`fetched ${fetched}/${SO101_MESHES.length} meshes`, 0.05 + 0.6 * (fetched / SO101_MESHES.length));
      return { name, bytes };
    }),
  );
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length) throw new Error(failed.map((r) => errorText(r.reason, mujoco)).join("; "));
  return results.map((r) => (r as PromiseFulfilledResult<{ name: string; bytes: Uint8Array }>).value);
}

function readBundle(buf: ArrayBuffer): { name: string; bytes: Uint8Array }[] {
  // Validated before anything reaches the VFS: a bad bundle must fall back, not half-load.
  if (buf.byteLength < 4) throw new Error("mesh bundle too short");
  const headerLength = new DataView(buf).getUint32(0, true);
  if (headerLength === 0 || 4 + headerLength > buf.byteLength) throw new Error("mesh bundle header out of bounds");
  const index: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLength)));
  if (!Array.isArray(index)) throw new Error("mesh bundle index is not a list");
  const base = 4 + headerLength;
  const payload = buf.byteLength - base;
  const seen = new Set<string>();
  const entries = index.map((e: unknown) => {
    const { name, offset, length } = (e ?? {}) as { name?: unknown; offset?: unknown; length?: unknown };
    if (typeof name !== "string" || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) {
      throw new Error("mesh bundle entry malformed");
    }
    const o = offset as number;
    const n = length as number;
    if (o < 0 || n <= 0 || o + n > payload) throw new Error(`mesh bundle entry ${name} out of bounds`);
    if (!(SO101_MESHES as readonly string[]).includes(name)) throw new Error(`mesh bundle has an unexpected entry ${name}`);
    if (seen.has(name)) throw new Error(`mesh bundle lists ${name} twice`);
    seen.add(name);
    return { name, bytes: new Uint8Array(buf.slice(base + o, base + o + n)) };
  });
  const missing = SO101_MESHES.filter((m) => !seen.has(m));
  if (missing.length) throw new Error(`mesh bundle is missing ${missing.join(", ")}`);
  return entries;
}

function extractMeta(m: MjModel): SimMeta {
  const names = toNumbers(m.names);
  const name = (adrs: unknown, i: number) => decodeName(names, toNumbers(adrs)[i]);
  const nq = m.nq as number;
  const nv = m.nv as number;
  const nu = m.nu as number;
  const ngeom = m.ngeom as number;
  const nsite = m.nsite as number;
  const nmesh = m.nmesh as number;
  const nbody = m.nbody as number;
  const njnt = m.njnt as number;
  const timestep = (m.opt as { timestep: number }).timestep;

  const jntRange = toNumbers(m.jnt_range);
  const jntQposadr = toNumbers(m.jnt_qposadr);
  const joints = Array.from({ length: njnt }, (_, i) => ({
    name: name(m.name_jntadr, i),
    qposadr: jntQposadr[i],
    range: [jntRange[2 * i], jntRange[2 * i + 1]] as [number, number],
  }));
  const ctrlRange = toNumbers(m.actuator_ctrlrange);
  const actuators = Array.from({ length: nu }, (_, i) => ({
    name: name(m.name_actuatoradr, i),
    ctrlrange: [ctrlRange[2 * i], ctrlRange[2 * i + 1]] as [number, number],
  }));
  const sites = Array.from({ length: nsite }, (_, i) => ({ name: name(m.name_siteadr, i), id: i }));
  const bodies = Array.from({ length: nbody }, (_, i) => ({ name: name(m.name_bodyadr, i), id: i }));

  const gType = toNumbers(m.geom_type);
  const gSize = toNumbers(m.geom_size);
  const gRgba = toNumbers(m.geom_rgba);
  const gGroup = toNumbers(m.geom_group);
  const gBody = toNumbers(m.geom_bodyid);
  const gData = toNumbers(m.geom_dataid);
  const gMat = toNumbers((m as unknown as { geom_matid?: unknown }).geom_matid);
  const matRgba = toNumbers((m as unknown as { mat_rgba?: unknown }).mat_rgba);
  const rgbaOf = (i: number): [number, number, number, number] => {
    const mat = gMat[i] ?? -1;
    const useMat = mat >= 0 && matRgba.length >= 4 * mat + 4;
    const src = useMat ? matRgba : gRgba;
    const o = useMat ? 4 * mat : 4 * i;
    return [src[o], src[o + 1], src[o + 2], src[o + 3]];
  };
  const geoms: GeomMeta[] = Array.from({ length: ngeom }, (_, i) => ({
    id: i,
    name: name(m.name_geomadr, i),
    type: gType[i],
    size: [gSize[3 * i], gSize[3 * i + 1], gSize[3 * i + 2]],
    rgba: rgbaOf(i),
    group: gGroup[i],
    bodyId: gBody[i],
    meshId: gType[i] === GEOM_MESH ? gData[i] : -1,
  }));

  const vert = toNumbers(m.mesh_vert);
  const vertAdr = toNumbers(m.mesh_vertadr);
  const vertNum = toNumbers(m.mesh_vertnum);
  const face = toNumbers(m.mesh_face);
  const faceAdr = toNumbers(m.mesh_faceadr);
  const faceNum = toNumbers(m.mesh_facenum);
  const used = new Set(geoms.filter((g) => g.meshId >= 0 && g.group < 3).map((g) => g.meshId));
  const meshes: MeshMeta[] = [];
  for (let id = 0; id < nmesh; id++) {
    if (!used.has(id)) continue;
    const v0 = 3 * vertAdr[id];
    const vn = 3 * vertNum[id];
    const vertices = new Float32Array(vn);
    for (let k = 0; k < vn; k++) vertices[k] = vert[v0 + k];
    const f0 = 3 * faceAdr[id];
    const fn = 3 * faceNum[id];
    const faces = new Int32Array(fn);
    for (let k = 0; k < fn; k++) faces[k] = face[f0 + k];
    meshes.push({ id, name: name(m.name_meshadr, id), vertices, faces });
  }

  return { gravity_g: 1, nq, nv, nu, ngeom, nsite, timestep, joints, actuators, sites, bodies, geoms, meshes, liquid: null };
}

function setCtrl(values: number[]) {
  if (!runtime) return;
  const ctrl = runtime.data.ctrl as unknown;
  if (ArrayBuffer.isView(ctrl)) {
    const view = ctrl as unknown as Float64Array;
    for (let i = 0; i < Math.min(values.length, view.length); i++) view[i] = values[i];
  } else {
    const vec = ctrl as { set: (i: number, v: number) => boolean; size: () => number };
    for (let i = 0; i < Math.min(values.length, vec.size()); i++) vec.set(i, values[i]);
  }
}

/** Gravity is a model option MuJoCo reads every step, so it changes without a recompile. */
function setGravity(g: number) {
  // a load in flight builds its own model: remember the change for it, whether or
  // not an older runtime is still answering meanwhile
  if (loading || !runtime) wantedGravity = g;
  if (!runtime) return;
  const opt = runtime.model.opt as { gravity: unknown };
  const clamped = Math.max(0, Math.min(2, g));
  const gz = -(G_M_S2 * clamped);
  if (ArrayBuffer.isView(opt.gravity)) (opt.gravity as unknown as Float64Array)[2] = gz;
  else (opt.gravity as { set: (i: number, v: number) => boolean }).set(2, gz);
  runtime.liquid?.setGravity(clamped);
  runtime.meta.gravity_g = g;
}

/** Give a free body a velocity (m/s); in orbit it keeps drifting, on Earth it falls back. */
function nudge(body: string, velocity: [number, number, number]) {
  if (!runtime) return;
  const { mujoco, model, data, meta } = runtime;
  const b = meta.bodies.find((x) => x.name === body);
  if (!b) throw new Error(`no body named ${body}`);
  const jntAdr = toNumbers(model.body_jntadr)[b.id];
  if (jntAdr === undefined || jntAdr < 0) throw new Error(`${body} has no joint to push`);
  // only a free joint has three linear velocities first; a hinge would take the next three joints' dofs
  if (toNumbers(model.jnt_type)[jntAdr] !== FREE_JOINT) throw new Error(`${body} is not a free body`);
  const dofAdr = toNumbers(model.jnt_dofadr)[jntAdr];
  if (dofAdr === undefined || dofAdr < 0) throw new Error(`${body} has no joint to push`);
  const qvel = data.qvel as unknown;
  const set = (i: number, v: number) => {
    if (ArrayBuffer.isView(qvel)) (qvel as unknown as Float64Array)[i] = v;
    else (qvel as { set: (i: number, v: number) => boolean }).set(i, v);
  };
  set(dofAdr, velocity[0]);
  set(dofAdr + 1, velocity[1]);
  set(dofAdr + 2, velocity[2]);
  mujoco.mj_forward(model, data);
}

function reset(seed?: number) {
  if (!runtime) return;
  playing = null;
  cancelRun("the physics was reset"); // mj_resetData also switches every weld back off
  runtime.mujoco.mj_resetData(runtime.model, runtime.data);
  park(runtime.mujoco, runtime.model, runtime.data);
  runtime.liquid?.fill(runtime.model, runtime.data, seed);
  simTime = 0;
  backlog = 0;
}

/**
 * Pacing at `speed` times real time with an accumulator: fractional timesteps
 * carry over, so three 5 ms steps per 16.7 ms tick do not drift. A backlog
 * beyond the cap (a backgrounded tab), scaled by the speed, is dropped and
 * reported in the frame. The speed changes how many fixed steps a tick takes,
 * never the steps themselves, so a rollout is the same at any speed; a tick
 * stops stepping once it has spent TICK_BUDGET_MS. A rollout that ends in a tick is answered after the tick's frame,
 * so the frames a caller collects for it (Frame.run) reach its last state.
 */
function tick() {
  if (!runtime) return;
  const { mujoco, model, data, meta, liquid } = runtime;
  const now = performance.now();
  backlog += (speed * (now - lastWall)) / 1000;
  lastWall = now;
  const cap = (liquid ? MAX_LIQUID_BACKLOG_S : MAX_BACKLOG_S) * Math.max(1, speed);
  if (backlog > cap) {
    dropped += backlog - cap;
    backlog = cap;
  }
  const dt = meta.timestep;
  const runId = running?.id;
  let finished: Extract<FromWorker, { type: "run" }> | null = null;
  let steps = 0;
  while (backlog >= dt && (steps === 0 || performance.now() - now < TICK_BUDGET_MS)) {
    if (running) {
      const { id, it } = running;
      try {
        const r = it.next();
        if (r.done) {
          finished = { type: "run", id, result: r.value };
          running = null;
        }
      } catch (err) {
        // the interpreter turns spec gaps into failed rollouts; anything else still reaches the caller
        post({ type: "error", id, message: errorText(err, mujoco) });
        running = null;
      }
    } else if (playing) {
      const wp = playing.waypoints;
      const span = wp.length ? wp[wp.length - 1].t : 0;
      let t = simTime - playing.start;
      if (playing.loop && span > 0) t = t % span;
      setCtrl(sampleWaypoints(wp, t));
      if (!playing.loop && t >= span) playing = null;
    }
    mujoco.mj_step(model, data);
    liquid?.advance(model, data, dt);
    simTime += dt;
    backlog -= dt;
    steps++;
  }
  // No mj_forward here: the derived state (poses, contacts) stays the one mj_step computed before integrating, as
  // between every other step and as in runToEnd. A refresh at the end of a tick would let the program see fresh
  // poses on a tick's first step only, and solve its constraints once more, so the rollout would depend on how steps
  // fall into ticks (the speed, the timer). The frame is then one 5 ms step behind the joints, which no eye sees.
  const frame: Frame = {
    t: simTime,
    run: runId,
    dropped_s: dropped,
    qpos: Float64Array.from(toNumbers(data.qpos)),
    ctrl: Float64Array.from(toNumbers(data.ctrl)),
    geomXpos: Float64Array.from(toNumbers(data.geom_xpos)),
    geomXmat: Float64Array.from(toNumbers(data.geom_xmat)),
    siteXpos: Float64Array.from(toNumbers(data.site_xpos)),
    attached: runtime.grasps.find((g) => isAttached(data, g))?.body ?? null,
    liquid: liquid ? { positions: liquid.fluid.copyPositions(), where: liquid.where(data), step_ms: liquid.stepMs } : undefined,
  };
  post({ type: "frame", frame }, [
    frame.qpos.buffer,
    frame.ctrl.buffer,
    frame.geomXpos.buffer,
    frame.geomXmat.buffer,
    frame.siteXpos.buffer,
    ...(frame.liquid ? [frame.liquid.positions.buffer] : []),
  ]);
  if (finished) post(finished);
}

/** On a scratch copy of the current joints, its kinematics refreshed: the live state is a step behind them (tick). */
function jacobian(id: number, site: string) {
  if (!runtime) throw new Error("model not loaded");
  const { mujoco, model, data, meta } = runtime;
  const s = meta.sites.find((x) => x.name === site);
  if (!s) throw new Error(`no site named ${site}`);
  const nv = meta.nv;
  const scratch = new mujoco.MjData(model);
  const jacp = new mujoco.DoubleBuffer(3 * nv);
  const jacr = new mujoco.DoubleBuffer(3 * nv);
  try {
    // views after every allocation above: an allocation can grow the heap and detach a view taken before it
    (scratch.qpos as Float64Array).set(data.qpos as Float64Array);
    mujoco.mj_kinematics(model, scratch);
    mujoco.mj_comPos(model, scratch);
    mujoco.mj_jacSite(model, scratch, jacp, jacr, s.id);
    post({
      type: "jacobian",
      id,
      site,
      nv,
      jacp: Float64Array.from(toNumbers(jacp.GetView())),
      jacr: Float64Array.from(toNumbers(jacr.GetView())),
    });
  } finally {
    jacp.delete();
    jacr.delete();
    scratch.delete();
  }
}

/** IK on a scratch copy of the current state, seeded with the arm where it is now. */
function ik(id: number, target: [number, number, number], approach: Approach, site?: string) {
  if (!runtime) throw new Error("model not loaded");
  const { mujoco, model, data } = runtime;
  const scratch = new mujoco.MjData(model);
  try {
    const qpos = Array.from(toNumbers(data.qpos));
    const view = scratch.qpos as unknown;
    if (ArrayBuffer.isView(view)) (view as unknown as Float64Array).set(qpos);
    else qpos.forEach((v, i) => (view as { set: (i: number, v: number) => boolean }).set(i, v));
    post({ type: "ik", id, result: solveIk(mujoco, model, scratch, target, approach, undefined, site) });
  } finally {
    scratch.delete();
  }
}

function cancelRun(message: string) {
  if (!running) return;
  post({ type: "error", id: running.id, message: `program cancelled: ${message}` });
  running = null;
}
