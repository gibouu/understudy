# Research digest: tooling

Collected 23 October 2026 by a research agent with live page fetches; each fact is tagged verified (seen on the cited page), likely or unverified.

## Tooling assessment for a seven-day "Understudy" build

Headline findings that change the seed plan:

- **MuJoCo now has official JavaScript/WASM bindings**: `@mujoco/mujoco` 3.17.0 on npm, published 2026-10-22, Apache-2.0, ESM, `MjModel.from_xml_string(...)`. zalo/mujoco_wasm is now "just a small demo suite" on top of them. Rendering is still yours (three.js in the official demo). This is the browser rehearsal stage; no Genesis/Isaac round-trip needed for the demo.
- **GR00T N1.7 consumes the LeRobot v2/v2.1 flavour, not v3.** Its `demo_data/cube_to_bowl_5` is `codebase_version: "v2.1"`, robot `so101_follower`, 6-dim state/action (`shoulder_pan, shoulder_lift, elbow_flex, wrist_flex, wrist_roll, gripper`), AV1 640x480 mp4, plus `meta/modality.json`. v3 datasets must be converted back. So export v2.1 + modality.json and call it "GR00T-ready" truthfully.
- **Token Factory hosts a video-capable Nemotron**: `nvidia/Nemotron-3.5-Super-VL` ($0.30/$0.90 per M tokens, third-party snapshot 2026-10-20) and `Nemotron 3 Nano Omni` (video+audio+image, Nebius's own page). Cosmos Reason 2 is **not** listed on Token Factory; self-host the 8B (Qwen3-VL based, 32 GB min) on a Nebius Serverless Endpoint with vLLM on an L40S if you want the critic. Note the Cosmos Reason 2 repo is in maintenance mode (Cosmos 3 is the successor).
- **Nebius trial credit is $1 for 30 days**; GPU jobs are L40S $1.35/GPU-h (+CPU/RAM), H100 $4.50/h, billed per second. Budget real money for any GR00T fine-tune (40 GB+ VRAM recommended).

### (1) Pose and hand extraction

| Option | Output | Speed / cost | Licence | Verdict |
|---|---|---|---|---|
| `@mediapipe/tasks-vision` 1.1.1 (2026-10-14) Pose Landmarker | 33 landmarks, normalised + **world (metres)** coords, lite/full/heavy, IMAGE/VIDEO/LIVE_STREAM, `numPoses`, optional segmentation mask | Laptop fps not published; Pixel 6 hand pipeline 12-17 ms | Apache-2.0 | **Use.** VIDEO mode over decoded frames |
| Hand Landmarker | 21 landmarks/hand, world landmarks, handedness, `numHands` | as above | Apache-2.0 | **Use** for gripper open/close |
| Holistic Landmarker (Web) | 33 pose + 478 face + 2x21 hands, world coords for pose and hands | one model call | Apache-2.0 | Alternative single call; heavier |
| TF.js `@tensorflow-models/pose-detection` 2.1.3 | MoveNet 17 kp (50+ fps), BlazePose 33 kp with `keypoints3D` in a 2x2x2 m hip-centred box | fast | Apache-2.0 | Fallback only |
| RTMPose / RTMW (mmpose, rtmlib ONNX) | 17 body or 133 whole-body kp; RTMPose-m 430+ fps GTX1660Ti, 90+ fps CPU | CPU-viable | likely Apache-2.0 | Server upgrade in a Nebius job |
| ViTPose / ViTPose++ (transformers) | COCO 17 (expert 5 = whole-body), top-down, needs RT-DETR detector | GPU | checkpoints usyd-community | Server upgrade |
| WiLoR / WiLoR-mini | 3D hand mesh (MANO) | GPU | **CC-BY-NC-ND** | Avoid (licence) |
| SAM 3 / 3.1 (2026-03-27) | text-prompted segmentation + video tracking | GPU, CUDA 12.6+ | SAM License | Object masks in a job; replaces Grounding DINO + SAM 2 |
| Depth Anything 3 (Nov 2025) | metric depth, poses; Small/Base/Metric-Large Apache-2.0 | <12 GB streaming | Apache-2.0 (small models) | Stretch |
| CoTracker3 | point tracks | GPU | CC-BY-NC | Avoid for a commercial pitch |
| FoundationPose | 6D pose, needs CAD or reference images, custom CUDA ops, Docker | heavy | NVIDIA Source Code License | Out of scope for 7 days |

### (2) Keyframes + pose to the VLM

- Base URL `https://api.tokenfactory.nebius.com/v1/`, `Authorization: Bearer $NEBIUS_API_KEY`, OpenAI SDKs work. Images via `image_url` (URL or base64). Nebius documents **no** max image count or resolution; model cards do: Nemotron Nano 12B v2 VL takes 4 images at 1k x 2k, video at 2 fps, 8-128 frames; Nemotron 3.5 Super VL takes video mp4 up to 2 min (vLLM recipe: 2 fps, 256 frames), 1M context; Nano Omni 1 fps / 128 frames at 1080p.
- Structured output: `response_format: {type: "json_schema", json_schema: ...}` (also `json_object`); look for the "JSON mode" tag on the model card and repeat the schema in the prompt.
- Pattern: send 8-16 keyframes as separate image parts, each preceded by a text part `t=12.4s` plus the compact pose summary for that frame (wrist xyz, gripper aperture); ask for an array of `{start_s, end_s, verb, object, grasp, preconditions, success_check}`. Frame grids (2x2 montage per image) stretch the 4-image limit on the smaller model.
- Cost: at $0.30/M input, even a 2,000-token image is $0.0006; a 16-frame call is under a cent. Per-image token counts are not published by Nebius.
- Rate limits adapt (+20 % per 15-min window at 80 % use, cap 20x base); honour `Retry-After`.

### (3) LeRobot format

| Item | v2.1 (what GR00T reads) | v3.0 (`lerobot` 0.6.1, Python >= 3.12) |
|---|---|---|
| Data | `data/chunk-000/episode_000000.parquet` | `data/chunk-000/file-000.parquet`, many episodes per file (100 MB target) |
| Video | `videos/chunk-000/observation.images.<cam>/episode_000000.mp4` | `videos/<cam>/chunk-000/file-000.mp4` (200 MB target) |
| Meta | `info.json`, `tasks.jsonl` (`{"task_index":0,"task":"..."}`), `episodes.jsonl`, `stats.json`, `episodes_stats.jsonl` | `info.json`, `stats.json`, `tasks.parquet` (docs still say `tasks.jsonl`), `episodes/*.parquet` |
| Language | integer `task_index` column per frame, text in tasks file | same, relational |
| GR00T extra | `meta/modality.json`: `state`/`action` slices (`single_arm` 0-5, `gripper` 5-6), `video` map, `annotation.human.task_description -> task_index` | convert with GR00T's script |

Writing from TypeScript is feasible for v2.1: parquet via `hyparquet-writer` 0.17.0 (MIT) or `parquet-wasm` 0.9.0; mp4 via WebCodecs + `mediabunny` 1.62.1 (MPL-2.0) or `mp4-muxer` 5.2.2 (MIT). The AV1 codec in GR00T's sample is not mandatory (the guide specifies only MP4). `stats.json` (mean/std/min/max per feature) is computable in TS; GR00T recomputes its own stats anyway. Keep a 50-line Python validator (`LeRobotDataset(root=...)`) as a Nebius job for the README's proof. Minimal useful set: LeRobot's own guidance is at least 50 episodes, 10 per object location, for ACT; a hackathon export of 10-20 perturbed sim rollouts of one task is honest as "seed data", not a training set.

### (4) Simulation options

| Option | Effort | Fidelity | Risk | Links |
|---|---|---|---|---|
| **`@mujoco/mujoco` 3.17.0 + three.js 0.186.1** | 2-3 days (load MJCF + meshes into the virtual FS, step, mirror `xpos/xquat` to three meshes) | real contacts, real robot | "WIP" bindings, mt build needs COOP/COEP; Chrome-first | github.com/google-deepmind/mujoco/tree/main/wasm, demo zalo.github.io/mujoco_wasm |
| Three.js + `urdf-loader` 0.13.1 + `closed-chain-ik` (DLS) + Rapier 0.21.0 | 1-2 days | kinematic + toy physics | no real grasp physics; IK lib installs from GitHub | github.com/gkjohnson/urdf-loaders, github.com/gkjohnson/closed-chain-ik-js |
| Genesis 1.4.5 or Isaac Lab headless in a Nebius Serverless Job, video back to Blob | 2-4 days + docker | high | Python 3.10-3.13 only (your 3.15 is out), job minimum timeout 1 h, logs not in REST API, outputs only via mounted bucket | github.com/Genesis-Embodied-AI/Genesis |

Robot models: Menagerie `robotstudio_so101` (6 DoF, Apache-2.0), `franka_emika_panda`, `unitree_g1` (29 DoF, BSD-3); TheRobotStudio ships `Simulation/SO101/so101_new_calib.urdf` and `.xml` with assets (Apache-2.0).

### (5) Retargeting

- Simple case (days-realistic): wrist world landmark (pose 15/16) smoothed, gripper = thumb-tip to index-tip distance thresholded; damped-least-squares IK on the SO-101 or Panda in MuJoCo (own 60-line Jacobian solver or `closed-chain-ik`). Orientation from the hand plane normal.
- `dex_retargeting` 0.5.0 (MIT, pinocchio): vector/position/DexPilot optimisers, `detect_from_video.py` example; dexterous hands only, Python.
- GMR (MIT): SMPL-X/BVH to Unitree G1 at 35-70 fps on CPU with mink IK; monocular video needs GVHMR first. Humanoid path is a Python job, not browser.
- human2humanoid (H2O/OmniH2O): H1 only, IsaacGym, CC-BY-NC, authors won't support other robots. Skip.

### (6) Vercel and app patterns

- 4.5 MB request/response body limit; Hobby 300 s max duration, Pro 800 s. Blob client uploads bypass it (`upload()` from `@vercel/blob/client` 2.8.2, `handleUpload` route needs `BLOB_READ_WRITE_TOKEN`; multipart for >100 MB; `onUploadCompleted` needs a tunnel locally).
- Frame extraction: WebCodecs `VideoDecoder` + canvas (or `mediabunny`) in the browser; avoid `@ffmpeg/core` (GPL-2.0-or-later, 2 GB limit, mt needs COOP/COEP which also conflicts with nothing here but adds deploy headers).
- Chat: `ai` 7.0.150 + `@ai-sdk/openai-compatible` 3.0.77 with `createOpenAICompatible({name:'nebius', baseURL, apiKey})` and `supportsStructuredOutputs: true`; `streamText` with `Output.object({schema})`, `partialOutputStream`, `useObject` on the client.
- Tavily: `@tavily/core` 0.7.14, `POST https://api.tavily.com/search`, 1,000 free credits/month, no card; basic = 1 credit.

### Recommended MINIMAL stack

| Component | Library | Version | Why |
|---|---|---|---|
| App | Next.js on Vercel | 16.4.2 | gib's stack; stateless |
| Upload | `@vercel/blob/client` | 2.8.2 | beats 4.5 MB limit |
| Frames | WebCodecs + canvas | browser | no GPL, no server bytes |
| Pose/hands | `@mediapipe/tasks-vision` | 1.1.1 | 33 + 2x21 world landmarks in-browser |
| VLM labels | Token Factory `nvidia/Nemotron-3.5-Super-VL` | hosted | NVIDIA + Nebius requirement in one call |
| Interview + spec | Token Factory `nvidia/nemotron-3-super-120b-a12b` | hosted | JSON schema output |
| SDK | `ai` + `@ai-sdk/openai-compatible` | 7.0.150 / 3.0.77 | streaming structured output |
| Sim | `@mujoco/mujoco` + `three` | 3.17.0 / 0.186.1 | official WASM physics, SO-101 from Menagerie |
| Retarget | own DLS IK | - | wrist + gripper only |
| Export | `hyparquet-writer` + `mediabunny` | 0.17.0 / 1.62.1 | v2.1 + modality.json in TS |
| Grounding | `@tavily/core` | 0.7.14 | $3k bonus |

### STRETCH stack

| Component | Library | Version | Why |
|---|---|---|---|
| Critic | Cosmos-Reason2-8B on Nebius Serverless Endpoint, vLLM >= 0.11 on `gpu-l40s-a` | 2026-04 weights | physical-plausibility reasoning over rollouts |
| Batch pose | RTMW via rtmlib, Serverless Job | mmpose main | 133 kp upgrade |
| Objects | SAM 3.1 in a job | 2026-03-27 | text-prompted masks |
| Depth | Depth Anything 3 Metric-Large | Apache-2.0 | metric wrist trajectories |
| Humanoid | GMR + GVHMR to Unitree G1 | MIT | second embodiment |
| Validation | `lerobot` 0.6.1 job | Python 3.12 | load dataset, prove validity |
| Fine-tune proof | Isaac-GR00T N1.7 `launch_finetune.py` on H100 | $4.50/h | 1-epoch run screenshot |

## Recommendations
- Build the browser critical path first and alone (gib): Blob client upload -> WebCodecs frame extraction -> MediaPipe Pose+Hand (VIDEO mode, world landmarks) -> keyframes+pose to nvidia/Nemotron-3.5-Super-VL with response_format json_schema -> interview with nvidia/nemotron-3-super-120b-a12b via @ai-sdk/openai-compatible streamText + Output.object -> @mujoco/mujoco 3.17.0 with Menagerie robotstudio_so101 -> v2.1 + modality.json export zip. Every stage is a verified, hosted, Apache-licensed piece.
- Sign up for Token Factory today and confirm in the dashboard that nvidia/Nemotron-3.5-Super-VL and Nano Omni accept image_url parts and carry the 'JSON mode' tag; the $1 trial credit will not cover a week, so put a card on the account on day one.
- Do not pitch v3 or GR00T-ready loosely: export LeRobot v2.1 (per-episode parquet + mp4 + tasks.jsonl + episodes.jsonl + stats.json) plus GR00T's meta/modality.json, mirroring demo_data/cube_to_bowl_5 field names, and prove it loads with a tiny lerobot 0.6.1 job on Nebius (Python 3.12 image, not your local 3.15).
- Use the official @mujoco/mujoco bindings, not zalo's fork; budget a day for loading MJCF plus mesh assets into the Emscripten FS and mirroring xpos/xquat to three.js meshes; avoid the mt build to skip COOP/COEP headers on Vercel.
- Retargeting in the minimal scope is wrist world position + hand-plane orientation + thumb-index aperture into a damped-least-squares IK you write yourself (about 60 lines) against MuJoCo's kinematics; keep dex-retargeting and GMR for a teammate's stretch track.
- Give teammates parallelisable tracks that cannot block the demo: (a) Nebius Serverless Job that runs RTMW/rtmlib and SAM 3.1 on the uploaded video and writes JSON to a bucket, (b) Cosmos-Reason2-8B on a Serverless Endpoint (vLLM, gpu-l40s-a) returning a plausibility critique over rendered rollout frames, (c) Tavily grounding of the task spec and the README/video.
- Avoid CC-BY-NC components in anything demonstrated for a commercial pitch (WiLoR, CoTracker3, Depth Anything V2 Base/Large, human2humanoid); prefer SAM 3.1, Depth Anything 3 Small/Base/Metric-Large, RTMPose, GMR.
- Extract frames with WebCodecs + canvas or mediabunny rather than ffmpeg.wasm so the shipped repo stays GPL-free and needs no cross-origin isolation headers.
- If a GR00T fine-tune is demanded for the video, run one epoch of launch_finetune.py on a single H100 ($4.50/h) with the sim export, screenshot the loss curve, and state plainly it is a proof of format compatibility, not a trained policy.

## Open questions
- Does Token Factory's OpenAI-compatible endpoint accept video (file or multi-frame) parts for Nemotron 3.5 Super VL and Nano Omni, or only image_url parts? Nebius documents only images; confirm after sign-up.
- What are Token Factory's actual per-image token counts and the rate limits on a new account? Neither is published; read x-ratelimit headers in the first calls.
- Is nvidia/Nemotron-Nano-12B-v2-VL hosted on Token Factory, or only the 3.5 Super VL and Nano Omni? Third-party catalogs disagree.
- Does @mujoco/mujoco 3.17.0 expose mj_jac* for Jacobian-based IK in the browser, or must IK be done by finite differences on mj_kinematics?
- Does Nebius Serverless Jobs' 1-hour minimum timeout bill the full hour for a 3-minute job, or per second of actual run time?
- Can the AI SDK openai-compatible provider pass image parts to Token Factory unchanged, or is a raw fetch with the OpenAI message format safer for the vision call?
- Will the judges accept a browser-only simulation as the 'key application modules in action' for the Physical AI video, or should the Cosmos critic or a Genesis job render be shown too?

## Facts
- [verified] @mediapipe/tasks-vision latest is 1.1.1, published 2026-10-14, Apache-2.0 (https://registry.npmjs.org/@mediapipe%2Ftasks-vision)
- [verified] MediaPipe Pose Landmarker outputs 33 landmarks with normalised and world coordinates, lite/full/heavy models, IMAGE/VIDEO/LIVE_STREAM modes, numPoses default 1, optional segmentation masks (https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker)
- [verified] MediaPipe Hand Landmarker outputs 21 landmarks per hand with world landmarks and handedness; Pixel 6 full pipeline 17.12 ms CPU / 12.27 ms GPU (https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker)
- [verified] MediaPipe Holistic Landmarker is available for Web/JS with 33 pose + 478 face + 42 hand landmarks, world coords for pose and hands (https://developers.google.com/edge/mediapipe/solutions/vision/holistic_landmarker)
- [unverified] MediaPipe pose/hand landmark fps on a laptop is roughly 25-30 fps with the GPU delegate ()
- [verified] TF.js pose-detection: MoveNet 17 keypoints at 50+ fps; BlazePose 33 keypoints with keypoints3D in a 2x2x2 m hip-centred space (https://github.com/tensorflow/tfjs-models/tree/master/pose-detection)
- [verified] RTMPose-m runs 430+ fps on GTX 1660 Ti and 90+ fps on an i7-11700 CPU; RTMW provides 133 whole-body keypoints; rtmlib runs ONNX without PyTorch (https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose)
- [verified] ViTPose and ViTPose++ are in transformers (usyd-community checkpoints), top-down, need a person detector; expert index 5 is COCO-WholeBody (https://huggingface.co/docs/transformers/model_doc/vitpose)
- [verified] WiLoR models are CC-BY-NC-ND and require MANO; WiLoR-mini pip package exists for demos (https://github.com/rolpotamias/WiLoR)
- [verified] SAM 3.1 released 2026-03-27 does text-prompted segmentation and tracking in video, licensed under the SAM License, needs CUDA 12.6+ and Python 3.12+ (https://github.com/facebookresearch/sam3)
- [verified] SAM 2.1 checkpoints are Apache-2.0 and support video object segmentation (https://github.com/facebookresearch/sam2)
- [verified] CoTracker3 (Oct 2024) is mostly CC-BY-NC and recommends a GPU (https://github.com/facebookresearch/co-tracker)
- [verified] Depth Anything 3 (Nov 2025): Small, Base, Metric-Large and Mono-Large are Apache-2.0; Large/Giant/Nested are CC-BY-NC; streaming mode under 12 GB VRAM (https://github.com/ByteDance-Seed/Depth-Anything-3)
- [verified] Depth Anything V2: only the Small model is Apache-2.0; Base/Large are CC-BY-NC-4.0 (https://github.com/DepthAnything/Depth-Anything-V2)
- [verified] FoundationPose needs a CAD model or reference images, custom CUDA ops, Docker, and is under the NVIDIA Source Code License (https://github.com/NVlabs/FoundationPose)
- [verified] Token Factory base URL is https://api.tokenfactory.nebius.com/v1/ with Bearer NEBIUS_API_KEY, OpenAI SDK compatible (https://docs.tokenfactory.nebius.com/)
- [verified] Token Factory vision: images via image_url (URL or base64); no documented max image count or resolution (https://docs.tokenfactory.nebius.com/api-reference/examples/vision-capabilities.md)
- [verified] Token Factory structured output uses response_format json_schema or json_object; models carry a 'JSON mode' tag; docs recommend also putting the schema in the prompt (https://docs.tokenfactory.nebius.com/ai-models-inference/json.md)
- [verified] Token Factory rate limits auto-scale +20 % per 15-minute window at >=80 % usage, up to 20x base; use Retry-After on 429 (https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits.md)
- [verified] New Token Factory accounts get $1 trial credit valid 30 days; billing is prepaid balance (https://docs.tokenfactory.nebius.com/other-capabilities/billing-new.md)
- [verified] Nebius lists Nemotron 3 Nano 30B, Nemotron 3 Nano Omni, Nemotron 3 Super 120B (id nvidia/nemotron-3-super-120b-a12b) and Nemotron 3 Ultra 550B on Token Factory; no Cosmos (https://nebius.com/services/token-factory/nemotron)
- [likely] Token Factory prices (snapshot 2026-10-20): nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B $0.06/$0.24, nvidia/Nemotron-3_5-Lightning $0.06/$0.24, nvidia/nemotron-3-super-120b-a12b $0.30/$0.90, nvidia/Nemotron-3.5-Super-VL $0.30/$0.90, nvidia/Nemotron-3-Ultra-550b-a55b $1.00/$3.00 per M tokens (https://benchlm.ai/hosts/nebius)
- [verified] NVIDIA Nemotron 3.5 Super VL: 120B total / 12B active, inputs text+images+video (mp4 up to 2 min), 1M context, OpenMDW-1.1 licence, HF release 2026-10-15, vLLM recipe 2 fps / 256 frames (https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16)
- [verified] Nemotron 3 Nano Omni: video/audio/image/text in, 256k context, video mp4 up to 2 min, 1 fps / 128 frames at 1080p, NVIDIA open model agreement, vLLM 0.20.0 (https://huggingface.co/nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-FP8)
- [verified] Nemotron Nano 12B v2 VL: up to 4 images at 1k x 2k, 128K tokens, video frames at 2 fps min 8 max 128, NVIDIA Open Model License (https://huggingface.co/nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-BF16)
- [verified] Cosmos Reason 2 (2B/8B/32B) is Qwen3-VL based, vLLM >= 0.11, 2B needs 24 GB and 8B 32 GB VRAM, code Apache-2.0, weights NVIDIA Open Model License; repo in limited maintenance, Cosmos 3 is the successor (https://github.com/nvidia-cosmos/cosmos-reason2)
- [likely] Cosmos Reason 2 is not hosted on Token Factory (https://benchlm.ai/hosts/nebius)
- [verified] LeRobot v3.0 is file-based: data/ and videos/ shards with many episodes per file, meta/info.json, stats.json, tasks, episodes/ chunked parquet; finalize() is required; lerobot >= 0.4.0 (https://huggingface.co/docs/lerobot/lerobot-dataset-v3)
- [verified] lerobot source: DEFAULT_TASKS_PATH meta/tasks.parquet (legacy meta/tasks.jsonl), chunk size 1000, data files 100 MB, video files 200 MB (https://raw.githubusercontent.com/huggingface/lerobot/main/src/lerobot/datasets/utils.py)
- [verified] lerobot 0.6.1 on PyPI (2026-08-03) requires Python >= 3.12 (https://pypi.org/pypi/lerobot/json)
- [verified] GR00T N1.7 (Cosmos-Reason2-2B backbone) reads a LeRobot v2 flavour plus meta/modality.json; v3 datasets must be converted; fine-tune recommends 40 GB+ VRAM (H100/L40), inference 16 GB+; code Apache-2.0 (https://github.com/NVIDIA/Isaac-GR00T)
- [verified] GR00T data guide: tasks.jsonl rows {task_index, task}, episodes.jsonl {episode_index, tasks, length}, modality.json with state/action start-end slices, video original_key, annotation.human.task_description column storing task_index; videos as MP4 under videos/chunk-* (https://raw.githubusercontent.com/NVIDIA/Isaac-GR00T/main/getting_started/data_preparation.md)
- [verified] GR00T demo cube_to_bowl_5: codebase_version v2.1, robot so101_follower, 6-dim state/action named shoulder_pan.pos..gripper.pos, two AV1 640x480 30 fps cameras, modality.json single_arm 0-5 / gripper 5-6 (https://raw.githubusercontent.com/NVIDIA/Isaac-GR00T/main/demo_data/cube_to_bowl_5/meta/info.json)
- [verified] GR00T modality config for a single arm + gripper: state/action keys arm, gripper; language key annotation.human.task_description; action horizon via delta_indices (https://raw.githubusercontent.com/NVIDIA/Isaac-GR00T/main/getting_started/data_config.md)
- [verified] LeRobot recommends recording at least 50 episodes, 10 per object location, before training ACT (https://huggingface.co/docs/lerobot/il_robots)
- [verified] Parquet writers in JS: hyparquet-writer 0.17.0 (MIT), parquet-wasm 0.9.0, @dsnp/parquetjs 1.9.4; MP4 muxers: mediabunny 1.62.1 (MPL-2.0), mp4-muxer 5.2.2 (MIT) (https://registry.npmjs.org/hyparquet-writer)
- [verified] Official MuJoCo JS bindings: npm @mujoco/mujoco 3.17.0 published 2026-10-22, Apache-2.0, ESM import loadMujoco, MjModel.from_xml_string, mt build needs cross-origin isolation, marked WIP, three.js demo (https://raw.githubusercontent.com/google-deepmind/mujoco/main/wasm/README.md)
- [verified] MuJoCo 3.17.0 released 2026-10-22 (https://mujoco.readthedocs.io/en/stable/changelog.html)
- [verified] zalo/mujoco_wasm is now a demo suite on the official bindings (MIT), demo at zalo.github.io/mujoco_wasm (https://github.com/zalo/mujoco_wasm)
- [verified] MuJoCo Menagerie has robotstudio_so101 (6 DoF, Apache-2.0), trs_so_arm100, franka_emika_panda (Apache-2.0), franka_fr3, unitree_g1 (29 DoF, BSD-3), robotiq_2f85, each with scene.xml (https://github.com/google-deepmind/mujoco_menagerie)
- [verified] TheRobotStudio SO-ARM100 ships Simulation/SO101 with so101_new_calib.urdf, so101_new_calib.xml and assets, Apache-2.0 (https://api.github.com/repos/TheRobotStudio/SO-ARM100/contents/Simulation/SO101)
- [verified] urdf-loader 0.13.1 (2026-07-08, Apache-2.0) loads URDF into three.js; closed-chain-ik is a damped-least-squares IK solver that works with urdf-loader and installs from GitHub (https://github.com/gkjohnson/closed-chain-ik-js)
- [verified] three 0.186.1 and @dimforge/rapier3d 0.21.0 (Apache-2.0) are the current npm versions (https://registry.npmjs.org/three)
- [verified] Genesis genesis-world 1.4.5 (2026-10-22), Apache-2.0, loads URDF/MJCF, requires Python >=3.10,<3.14 (https://github.com/Genesis-Embodied-AI/Genesis)
- [verified] dex_retargeting 0.5.0 (MIT, pinocchio) offers vector/position/DexPilot optimisers and a detect_from_video.py example for dexterous hands (https://github.com/dexsuite/dex-retargeting)
- [verified] GMR (MIT) retargets SMPL-X/BVH to Unitree G1 at 35-70 fps on CPU with mink IK; monocular video supported via a separate GVHMR install (https://github.com/YanjieZe/GMR)
- [verified] human2humanoid (H2O/OmniH2O) targets Unitree H1 only, needs IsaacGym, CC-BY-NC 4.0 (https://github.com/LeCAR-Lab/human2humanoid)
- [verified] Nebius Serverless Jobs: container image + command, platform (e.g. gpu-l40s-a) + preset (1gpu-8vcpu-32gb), timeout 1h-168h, volumes incl. s3:// buckets, --env-secret, logs via CLI/console only, REST POST https://api.nebius.cloud/ai/v1/jobs (https://docs.nebius.com/serverless/jobs/manage.md)
- [verified] Nebius GPU prices from 2026-10-01: H100 $4.50/h, H200 $5.40/h, B200 $8.50/h, L40S $1.35/h GPU-only plus CPU/RAM, per-second billing (https://docs.nebius.com/compute/resources/pricing.md)
- [verified] Nebius platforms: gpu-l40s-a presets 1gpu-8vcpu-32gb..1gpu-40vcpu-160gb; gpu-h100-sxm and gpu-h200-sxm 1 or 8 GPU presets (https://docs.nebius.com/compute/virtual-machines/types.md)
- [verified] Nebius Serverless Endpoint tutorial serves vllm/vllm-openai:v0.18.0-cu130 on gpu-l40s-a 1gpu-8vcpu-32gb, port 8000, OpenAI-compatible, managed https URL with bearer token (https://docs.nebius.com/serverless/tutorials/deploy-model.md)
- [verified] Vercel Functions: 4.5 MB request/response body limit; Hobby max duration 300 s, Pro 800 s (1800 s beta); 2 GB memory Hobby (https://vercel.com/docs/functions/limitations)
- [verified] Vercel Blob client uploads bypass 4.5 MB; upload() from @vercel/blob/client with a handleUpload route (needs BLOB_READ_WRITE_TOKEN); onUploadCompleted needs a tunnel locally; multipart recommended >100 MB; files up to 5 TB (https://vercel.com/docs/vercel-blob/client-upload)
- [verified] @vercel/blob 2.8.2, next 16.4.2, ai 7.0.150, @ai-sdk/openai-compatible 3.0.77 (2026-10-22), @tavily/core 0.7.14 are current on npm (https://registry.npmjs.org/ai)
- [verified] @ffmpeg/ffmpeg 0.12.15 is MIT but @ffmpeg/core and core-mt are GPL-2.0-or-later; input limit 2 GB; mt is ~2x faster but less stable (https://ffmpegwasm.netlify.app/docs/faq)
- [likely] ffmpeg.wasm multi-threaded core requires SharedArrayBuffer and COOP/COEP headers ()
- [verified] AI SDK openai-compatible: createOpenAICompatible({name, apiKey, baseURL}), supportsStructuredOutputs flag, tool calling, multimodal input provider-dependent (https://ai-sdk.dev/providers/openai-compatible-providers)
- [verified] AI SDK structured output: generateText/streamText with Output.object/array/choice/json, partialOutputStream and elementStream, useObject hook on the client (https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
- [verified] Tavily: POST https://api.tavily.com/search with Bearer key; basic 1 credit, advanced 2; 1,000 free credits/month, no credit card; JS SDK @tavily/core (https://docs.tavily.com/documentation/api-credits)
- [verified] MimicGen released 48,000+ generated demonstrations across 12 tasks; code NVIDIA Source Code License, datasets CC-BY 4.0 (https://github.com/NVlabs/mimicgen)
- [verified] GVHMR recovers world-grounded human motion from monocular video; SimpleVO replaced DPVO as default in March 2025 (https://github.com/zju3dv/GVHMR)
- [likely] The hackathon requires Token Factory or AI Cloud plus at least one NVIDIA open model; deadline 30 Oct 2026 10:00 PT; judging 1-15 Dec (https://www.startupgrantsindia.com/nebius-nvidia-global-ai-hackathon)