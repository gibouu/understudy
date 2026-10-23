// Publishes runtime assets under public/ before `next dev` and `next build`
// (pnpm runs no pre-scripts, so package.json chains this explicitly; the
// outputs are gitignored):
//   public/mujoco/mujoco.js, mujoco.wasm   the engine, served as static files
//   public/so101/so101.xml + LICENSE        the Menagerie model
//   public/so101/meshes.bin.gz              one gzipped bundle of the meshes the MJCF references
//   public/so101/assets/*.stl               the same meshes, for browsers without DecompressionStream
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
