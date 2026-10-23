// Copies the MuJoCo WebAssembly binary next to our static files so the worker
// can load it from /mujoco/mujoco.wasm. Runs before `next dev` and `next build`
// (pnpm does not run pre-scripts, so package.json chains it explicitly).
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const destDir = path.join(process.cwd(), "public", "mujoco");
mkdirSync(destDir, { recursive: true });
// The loader (mujoco.js) is served as-is and imported at runtime by the worker: it
// carries Node-only branches that bundlers cannot resolve.
const packageDir = path.dirname(require.resolve("@mujoco/mujoco")); // the "." export is mujoco.js
for (const file of ["mujoco.js", "mujoco.wasm"]) {
  const src = path.join(packageDir, file);
  const dest = path.join(destDir, file);
  copyFileSync(src, dest);
  const mb = (statSync(dest).size / 1e6).toFixed(1);
  console.log(`copy-assets: ${file} (${mb} MB) -> public/mujoco/`);
}
