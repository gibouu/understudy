import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MainModule, MjModel } from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import { DEMO_PROGRAMS, DEMO_SPEC } from "@/lib/sim/demo-spec";
import { environment, run } from "@/lib/sim/interpreter";
import { toNumbers } from "@/lib/sim/names";
import { buildScene } from "@/lib/sim/scene";
import { mountSo101, SO101_MESHES, SO101_XML, stageXml } from "@/lib/sim/so101";

const dir = path.join(process.cwd(), "assets", "so101");
const xml = new Uint8Array(readFileSync(path.join(dir, SO101_XML)));
const meshes = readdirSync(path.join(dir, "assets"))
  .filter((name) => name.endsWith(".stl"))
  .map((name) => ({ name, bytes: new Uint8Array(readFileSync(path.join(dir, "assets", name))) }));

/** One engine per way in: the file system and the working directory belong to an engine instance. */
async function engine(): Promise<MainModule> {
  const { default: loadMujoco } = await import("@mujoco/mujoco");
  return loadMujoco();
}

const FIELDS = ["mesh_vert", "mesh_face", "geom_size", "geom_pos", "body_mass", "body_inertia", "jnt_range"] as const;

describe("mountSo101", () => {
  let b: MainModule;
  let viaVfs: MjModel;
  let viaFs: MjModel;
  let mountMs = 0;
  const scene = stageXml(buildScene(DEMO_SPEC).worldbody);

  beforeAll(async () => {
    const a = await engine();
    const vfs = new a.MjVFS();
    vfs.addBuffer(SO101_XML, xml);
    for (const m of meshes) vfs.addBuffer(m.name, m.bytes);
    viaVfs = a.MjModel.from_xml_string(scene, vfs);
    vfs.delete();

    b = await engine();
    const t0 = performance.now();
    mountSo101(b, xml, meshes);
    mountMs = performance.now() - t0;
    viaFs = b.MjModel.from_xml_string(scene);
  }, 120_000);

  it("finds every mesh the MJCF names", () => {
    expect(meshes.map((m) => m.name).sort()).toEqual([...SO101_MESHES].sort());
    expect(viaFs.nmesh).toBe(SO101_MESHES.length);
  });

  it("compiles the same model as the virtual file system", () => {
    expect([viaFs.nq, viaFs.nv, viaFs.nu, viaFs.ngeom, viaFs.nbody]).toEqual([viaVfs.nq, viaVfs.nv, viaVfs.nu, viaVfs.ngeom, viaVfs.nbody]);
    for (const f of FIELDS) expect(Array.from(toNumbers(viaFs[f])), f).toEqual(Array.from(toNumbers(viaVfs[f])));
  });

  // the meshes never enter the wasm heap, so it is small when a program starts and can grow during it (a scratch
  // MjData for IK): a typed-array view kept from before then reads as detached, and writes through it are lost
  it("runs a program through a heap that grows mid-run", () => {
    const env = environment(DEMO_SPEC);
    const model = b.MjModel.from_xml_string(stageXml(env.worldbody, { gravity_g: env.gravity_g, graspable: env.graspable }));
    const data = new b.MjData(model);
    const it = run({ mujoco: b, model, data }, env, DEMO_PROGRAMS.hold_until_seated, "sensed");
    // every view the bindings hand out is on the wasm heap's buffer
    const heap = () => (data.qpos as Float64Array).buffer.byteLength;
    const before = heap();
    try {
      let r = it.next();
      for (let n = 0; !r.done; n++, r = it.next()) {
        // the arm is moving: grow the heap under it, as an IK solve's allocation can
        if (n === 20) new b.DoubleBuffer(before / 8).delete();
        b.mj_step(model, data);
      }
      expect(heap()).toBeGreaterThan(before);
      expect(r.value.pass, r.value.log.join("\n")).toBe(true);
    } finally {
      data.delete();
      model.delete();
    }
  }, 60_000);

  it("writes 17 MB of meshes in far less than the seconds addBuffer takes", () => {
    expect(mountMs).toBeLessThan(500);
  });
});
