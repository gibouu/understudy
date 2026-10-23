// Publishes runtime assets under public/ before `next dev` and `next build`
// (pnpm runs no pre-scripts, so package.json chains this explicitly; the
// outputs are gitignored):
//   public/mujoco/mujoco.js, mujoco.wasm   the engine, served as static files
//   public/so101/so101.xml + LICENSE        the Menagerie model
//   public/so101/meshes.bin.gz              one gzipped bundle of the meshes the MJCF references
//   public/so101/assets/*.stl               the same meshes, for browsers without DecompressionStream
//   public/mediapipe/wasm/, models/         MediaPipe tasks-vision wasm and the pose and hand models
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { gzipSync } from "node:zlib";

const root = process.cwd();
const mb = (n) => (n / 1e6).toFixed(1);

// MuJoCo engine
const require = createRequire(import.meta.url);
const packageDir = path.dirname(require.resolve("@mujoco/mujoco")); // the "." export is mujoco.js
const mujocoDir = path.join(root, "public", "mujoco");
mkdirSync(mujocoDir, { recursive: true });
for (const file of ["mujoco.js", "mujoco.wasm"]) {
  const dest = path.join(mujocoDir, file);
  copyFileSync(path.join(packageDir, file), dest);
  console.log(`copy-assets: ${file} (${mb(statSync(dest).size)} MB) -> public/mujoco/`);
}

// SO-101 model
const srcDir = path.join(root, "assets", "so101");
const outDir = path.join(root, "public", "so101");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, "assets"), { recursive: true });
for (const file of ["so101.xml", "LICENSE", "README.md"]) {
  copyFileSync(path.join(srcDir, file), path.join(outDir, file));
}
const xml = readFileSync(path.join(srcDir, "so101.xml"), "utf8");
const referenced = [...xml.matchAll(/<mesh\b[^>]*\bfile="([^"]+)"/g)].map((m) => m[1]);
const available = new Set(readdirSync(path.join(srcDir, "assets")));
const missing = referenced.filter((f) => !available.has(f));
if (missing.length) throw new Error(`copy-assets: meshes referenced by so101.xml are missing: ${missing.join(", ")}`);

const parts = [];
const index = [];
let offset = 0;
for (const file of referenced) {
  const bytes = readFileSync(path.join(srcDir, "assets", file));
  copyFileSync(path.join(srcDir, "assets", file), path.join(outDir, "assets", file));
  index.push({ name: file, offset, length: bytes.length });
  parts.push(bytes);
  offset += bytes.length;
}
const header = Buffer.from(JSON.stringify(index), "utf8");
const headerLength = Buffer.alloc(4);
headerLength.writeUInt32LE(header.length, 0);
const bundle = Buffer.concat([headerLength, header, ...parts]);
const gz = gzipSync(bundle, { level: 9 });
writeFileSync(path.join(outDir, "meshes.bin.gz"), gz);
console.log(`copy-assets: so101 ${referenced.length} meshes, ${mb(bundle.length)} MB raw -> meshes.bin.gz ${mb(gz.length)} MB`);

// MediaPipe: the wasm from the installed @mediapipe/tasks-vision (so it always
// matches the package), the two .task models downloaded once from their
// published URLs and checked against pinned hashes. Sources and licences in
// public/mediapipe/README.md.
const tasksVisionDir = path.dirname(require.resolve("@mediapipe/tasks-vision"));
const mediapipeDir = path.join(root, "public", "mediapipe");
mkdirSync(path.join(mediapipeDir, "wasm"), { recursive: true });
mkdirSync(path.join(mediapipeDir, "models"), { recursive: true });
for (const file of ["vision_wasm_internal.js", "vision_wasm_internal.wasm"]) {
  copyFileSync(path.join(tasksVisionDir, "wasm", file), path.join(mediapipeDir, "wasm", file));
}
console.log("copy-assets: MediaPipe wasm -> public/mediapipe/wasm/");

const MODELS = [
  {
    file: "pose_landmarker_full.task",
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
    sha256: "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1",
  },
  {
    file: "hand_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    sha256: "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
  },
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const { file, url, sha256: expected } of MODELS) {
  const dest = path.join(mediapipeDir, "models", file);
  if (existsSync(dest) && sha256(readFileSync(dest)) === expected) continue;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`copy-assets: ${url} answered HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== expected) throw new Error(`copy-assets: ${file} has SHA-256 ${got}, expected ${expected}`);
  writeFileSync(dest, bytes);
  console.log(`copy-assets: ${file} (${mb(bytes.length)} MB) downloaded -> public/mediapipe/models/`);
}
