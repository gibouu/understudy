# MediaPipe assets (self-hosted)

The Watch stage loads MediaPipe from files served by this app, never from a
CDN. `lib/vision/mediapipe.ts` points at them; the models run in a worker
(`lib/vision/mediapipe.worker.ts`). The files are not in git:
`scripts/copy-assets.mjs` (run by `pnpm dev` and `pnpm build`) copies the wasm
from the installed package and downloads the two models once, refusing any
file whose SHA-256 differs from the one pinned there.

| File | Source | Licence | SHA-256 |
|---|---|---|---|
| `wasm/vision_wasm_internal.js` | `@mediapipe/tasks-vision` on npm (1.1.1), `wasm/` | Apache-2.0 | `6522286aa32dd93eff17c3da002b0649516f87abfec7a80b5bfe5c9625caa5f8` |
| `wasm/vision_wasm_internal.wasm` | `@mediapipe/tasks-vision` on npm (1.1.1), `wasm/` | Apache-2.0 | `0e101a010e262ef8e78f22e3c95b60a9705fd06962753c9acd6356d9fb56b7bd` |
| `models/pose_landmarker_full.task` | https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task | Apache-2.0 ([model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf)) | `5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1` |
| `models/hand_landmarker.task` | https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task | Apache-2.0 ([model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf)) | `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1` |

The wasm hashes above are those of 1.1.1; the copy always follows the
installed version. To use a newer model, change its URL and hash in the script.

Only the SIMD build is shipped (every browser the app supports has wasm SIMD).
The worker is a classic worker, so the classic loader is the right one; the
package's `vision_wasm_module_internal.*` pair is for module workers.
