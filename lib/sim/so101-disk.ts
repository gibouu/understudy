/**
 * The SO-101 from the repository's assets/so101, for node (tests, harnesses, the showcase recorder): the same files
 * the worker fetches, written into the engine's file system by mountSo101. Compile with
 * `MjModel.from_xml_string(stageXml(...))`, no virtual file system.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MainModule } from "@mujoco/mujoco";
import { mountSo101, SO101_XML } from "./so101";

/** Write the MJCF and its meshes from `<root>/assets/so101` into this engine's file system (a few ms, against about 4 s through MjVFS.addBuffer). */
export function mountSo101FromDisk(mujoco: MainModule, root = process.cwd()) {
  const dir = path.join(root, "assets", "so101");
  const meshes = readdirSync(path.join(dir, "assets"))
    .filter((name) => name.endsWith(".stl"))
    .map((name) => ({ name, bytes: new Uint8Array(readFileSync(path.join(dir, "assets", name))) }));
  mountSo101(mujoco, new Uint8Array(readFileSync(path.join(dir, SO101_XML))), meshes);
}

/** A fresh engine with the SO-101 mounted. */
export async function loadSo101(root = process.cwd()): Promise<MainModule> {
  const { default: loadMujoco } = await import("@mujoco/mujoco");
  const mujoco = await loadMujoco();
  mountSo101FromDisk(mujoco, root);
  return mujoco;
}
