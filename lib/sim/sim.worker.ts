/**
 * The MuJoCo worker: loads the WebAssembly engine, puts the SO-101 MJCF and
 * meshes into the virtual file system, builds the model and steps it in real
 * time. The main thread gets geometry once (loaded) and poses every tick.
 */
import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
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
import { SO101_MESHES, SO101_XML, stageXml } from "./so101";

type WorkerCtx = {
  postMessage: (message: FromWorker, transfer?: Transferable[]) => void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};
const ctx = self as unknown as WorkerCtx;

let mujoco: MainModule | null = null;
let model: MjModel | null = null;
let data: MjData | null = null;
let meta: SimMeta | null = null;
let playing: { waypoints: Waypoint[]; loop: boolean; start: number } | null = null;
let simTime = 0;
let lastWall = 0;
let timer: ReturnType<typeof setInterval> | null = null;

const post = (m: FromWorker, transfer?: Transferable[]) => ctx.postMessage(m, transfer);
const status = (message: string, progress?: number) => post({ type: "status", message, progress });

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  const m = mujoco as unknown as { getExceptionMessage?: (e: unknown) => string[] } | null;
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
  try {
    switch (msg.type) {
      case "load":
        await load(msg.mujocoBase, msg.assetBase);
        break;
      case "setCtrl":
        playing = null;
        setCtrl(msg.ctrl);
        break;
      case "play":
        playing = { waypoints: msg.waypoints, loop: msg.loop ?? false, start: simTime };
        break;
      case "stop":
        playing = null;
        break;
      case "reset":
        reset();
        break;
      case "jacobian":
        jacobian(msg.site);
        break;
    }
  } catch (err) {
    post({ type: "error", message: errorText(err) });
  }
};

async function load(mujocoBase: string, assetBase: string) {
  status("loading MuJoCo WebAssembly");
  // The Emscripten loader carries Node-only branches (import('module'), require('fs'))
  // that bundlers cannot resolve, so it is served as a static file and imported at runtime.
  const loader = (await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ `${mujocoBase}/mujoco.js`
  )) as { default: (options?: { locateFile?: (p: string) => string }) => Promise<MainModule> };
  mujoco = await loader.default({
    locateFile: (p: string) => `${mujocoBase}/${p}`,
  });
  status(`MuJoCo ${String((mujoco as unknown as { mjVERSION_HEADER?: number }).mjVERSION_HEADER ?? "")} ready; fetching the SO-101`, 0.05);

  const vfs = new mujoco.MjVFS();
  const xml = await (await fetch(`${assetBase}/${SO101_XML}`)).text();
  vfs.addBuffer(SO101_XML, new TextEncoder().encode(xml));
  let fetched = 0;
  await Promise.all(
    SO101_MESHES.map(async (file) => {
      const res = await fetch(`${assetBase}/assets/${file}`);
      if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
      vfs.addBuffer(file, new Uint8Array(await res.arrayBuffer()));
      fetched++;
      status(`fetched ${fetched}/${SO101_MESHES.length} meshes`, 0.05 + 0.6 * (fetched / SO101_MESHES.length));
    }),
  );

  status("compiling the model", 0.7);
  model = mujoco.MjModel.from_xml_string(stageXml(), vfs);
  data = new mujoco.MjData(model);
  mujoco.mj_forward(model, data);
  meta = extractMeta(model);
  vfs.delete();

  status(`model ready: ${meta.nq} dof, ${meta.ngeom} geoms, ${meta.meshes.length} meshes`, 1);
  const transfer = meta.meshes.flatMap((m) => [m.vertices.buffer, m.faces.buffer]);
  post({ type: "loaded", meta }, transfer);
  // Buffers were transferred; keep a copy-free reference count sane by dropping them here.
  meta = { ...meta, meshes: [] };

  lastWall = performance.now();
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 1000 / 60);
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
    const src = mat >= 0 && matRgba.length >= 4 * mat + 4 ? matRgba : gRgba;
    const o = mat >= 0 && src === matRgba ? 4 * mat : 4 * i;
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

  return { nq, nv, nu, ngeom, nsite, timestep, joints, actuators, sites, bodies, geoms, meshes };
}

function setCtrl(values: number[]) {
  if (!data) return;
  const ctrl = data.ctrl as unknown;
  if (ArrayBuffer.isView(ctrl)) {
    const view = ctrl as unknown as Float64Array;
    for (let i = 0; i < Math.min(values.length, view.length); i++) view[i] = values[i];
  } else {
    const vec = ctrl as { set: (i: number, v: number) => boolean; size: () => number };
    for (let i = 0; i < Math.min(values.length, vec.size()); i++) vec.set(i, values[i]);
  }
}

function reset() {
  if (!mujoco || !model || !data) return;
  playing = null;
  mujoco.mj_resetData(model, data);
  mujoco.mj_forward(model, data);
  simTime = 0;
}

function tick() {
  if (!mujoco || !model || !data || !meta) return;
  const now = performance.now();
  const wallDt = Math.min((now - lastWall) / 1000, 0.1);
  lastWall = now;
  const steps = Math.max(1, Math.round(wallDt / meta.timestep));
  for (let s = 0; s < steps; s++) {
    if (playing) {
      const wp = playing.waypoints;
      const span = wp.length ? wp[wp.length - 1].t : 0;
      let t = simTime - playing.start;
      if (playing.loop && span > 0) t = t % span;
      setCtrl(sampleWaypoints(wp, t));
      if (!playing.loop && t >= span) playing = null;
    }
    mujoco.mj_step(model, data);
    simTime += meta.timestep;
  }
  const frame: Frame = {
    t: simTime,
    qpos: Float64Array.from(toNumbers(data.qpos)),
    ctrl: Float64Array.from(toNumbers(data.ctrl)),
    geomXpos: Float64Array.from(toNumbers(data.geom_xpos)),
    geomXmat: Float64Array.from(toNumbers(data.geom_xmat)),
    siteXpos: Float64Array.from(toNumbers(data.site_xpos)),
  };
  post({ type: "frame", frame }, [
    frame.qpos.buffer,
    frame.ctrl.buffer,
    frame.geomXpos.buffer,
    frame.geomXmat.buffer,
    frame.siteXpos.buffer,
  ]);
}

function jacobian(site: string) {
  if (!mujoco || !model || !data || !meta) throw new Error("model not loaded");
  const s = meta.sites.find((x) => x.name === site);
  if (!s) throw new Error(`no site named ${site}`);
  const nv = meta.nv;
  const jacp = new mujoco.DoubleBuffer(3 * nv);
  const jacr = new mujoco.DoubleBuffer(3 * nv);
  try {
    mujoco.mj_jacSite(model, data, jacp, jacr, s.id);
    post({
      type: "jacobian",
      site,
      nv,
      jacp: Float64Array.from(toNumbers(jacp.GetView())),
      jacr: Float64Array.from(toNumbers(jacr.GetView())),
    });
  } finally {
    jacp.delete();
    jacr.delete();
  }
}
