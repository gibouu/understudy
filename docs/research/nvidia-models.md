# Research digest: nvidia models

Collected 23 October 2026 by a research agent with live page fetches; each fact is tagged verified (seen on the cited page), likely or unverified.

## Headline

Only five NVIDIA models are hosted on Nebius Token Factory today (verified from the catalog JSON at `tokenfactory.nebius.com/api/public/models_info`), and exactly one of them sees pixels: **`nvidia/Nemotron-3.5-Super-VL`** (text + image + video in, 1M context, $0.30 / $0.90 per M tokens, OpenMDW-1.1). Every Cosmos, GR00T, Nemotron-Nano-VL and Nemotron-Omni model must be self-hosted with vLLM on a Nebius GPU. Token Factory's own dedicated endpoints only serve "supported models"; custom weights are a beta "on request", so do not plan on uploading Cosmos there.

The NVIDIA robotics stack moved a lot in 2026: Cosmos Reason 1/2 and Predict/Transfer 2.5 are superseded by **Cosmos 3** (May 2026, unified reasoning + generation + action, OpenMDW-1.1), GR00T is at **N1.7** (Cosmos-Reason2-2B backbone, repo pushed 22 Oct 2026), and MuJoCo now ships **official DeepMind WebAssembly bindings** on npm (`@mujoco/mujoco` 3.17.0, published 22 Oct 2026, Apache-2.0). The seed hypotheses hold with two corrections: the "Nemotron VLM on Token Factory" is Nemotron 3.5 Super VL, not Nemotron 3; and Cosmos Reason is self-host only.

## Table 1: Nebius Token Factory, NVIDIA models (verified)

| Token Factory model id | Type | Context | Price in/out per M | Licence | Verdict |
|---|---|---|---|---|---|
| `nvidia/Nemotron-3.5-Super-VL` | image2text; use_cases list text, image, **video**, reasoning, function calling | 1024K | $0.30 / $0.90 | OpenMDW-1.1 | The one VLM. Keyframes + pose JSON go here for semantic labels. HF card: 120B-A12B, C-RADIO encoder, MP4 up to 2 min, 256 frames at 2 fps with video-pruning 0.5 (that is EVS), `enable_thinking` toggle. Released 15 Oct 2026. |
| `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | text | 262K | $0.06 / $0.24 | NVIDIA Open Model License | Cheap structured extraction, JSON mode, tool calls. |
| `nvidia/Nemotron-3_5-Lightning` | text, 30B-A3B | 1024K | $0.06 / $0.24 | OpenMDW-1.1 | Same price as Nano, 1M context, MTP; text only. |
| `nvidia/nemotron-3-super-120b-a12b` | text | 256K | $0.30 / $0.90 | NVIDIA Open Model License | Interview + task-spec synthesis. |
| `nvidia/Nemotron-3-Ultra-550b-a55b` | text | 1024K | $1 / $3 | OpenMDW-1.1 | Only if Super's spec quality is not enough. |

Other hosted vision models with video in their use cases: `meta-models/muse-spark-open`, `MiniMaxAI/MiniMax-M3.1-Flash`, `openbmb/MiniCPM-V-4_5` (none NVIDIA). Rate limits are dynamic (baseline example 60 RPM / 400K TPM, auto-scaling x1.2 per 15 min window). Fine-tuning on Token Factory lists DeepSeek, Gemma 4, GPT-OSS and Qwen only, no Nemotron (likely; page partially read). The vision API doc shows `image_url` by URL or base64 and does **not** document video input, so test `video_url` or frame-as-images on day one.

## Table 2: NVIDIA open models relevant to human-video to robot data

| Model | Size, inputs | Hosted? | Licence | Usefulness |
|---|---|---|---|---|
| **Cosmos-Reason2** 2B / 8B / 32B (Qwen3-VL base) | video at 4 fps, 256K ctx; 8B needs 32 GB GPU; `vllm serve` >= 0.11 | Self-host (vLLM) | Weights: NVIDIA Open Model License; code Apache-2.0 | Best fit for the rollout critic (physical plausibility, temporal reasoning, embodied planning). Repo is in "limited maintenance" since Cosmos 3 (June 2026) but works. Pick 8B. |
| **Cosmos-Reason1-7B** (Qwen2.5-VL base) | video 4 fps | Self-host | NVIDIA Open Model License | Older; has an explicit "physical plausibility critic" update (June 2025). Use Reason2 instead. |
| **Cosmos 3** Super 64B / Nano 16B / Edge 4B (May and July 2026) | Mixture-of-Transformers: Reasoner tower (text+image+video to text) and Generator tower (video/audio/action out, action JSON). Nano on H100 / RTX Pro 6000 via vLLM-Omni; Edge on Jetson | Self-host | OpenMDW-1.1 (code and weights, commercial OK) | The current flagship and the judges' likely reference. Cosmos3-Nano-Policy-DROID is a policy checkpoint (RoboArena #1). Higher setup risk than Reason2 in seven days; mention it, use it only if vLLM-Omni comes up quickly. |
| **Cosmos-Predict2.5-2B** (also 14B on HF) | text+image/video to 5 s 720p clip; 32.5 GB VRAM; ~229 s per clip on H100 | Self-host | NVIDIA Open Model License | World-model video generation; too slow for a live demo, fine for an offline "synthetic variations" batch job. Collection archived in favour of Cosmos 3. |
| **Cosmos-Transfer2.5-2B** | text + up to 4 control videos (edge, blur, seg, depth) to 720p; 65 GB VRAM; ~12 min per clip on H100 NVL | Self-host | NVIDIA Open Model License | Sim-to-real augmentation of MuJoCo renders; impressive but one H100-NVL and 12 min per clip: optional stretch. |
| **GR00T N1.7** 3B (Isaac-GR00T repo, N1.6 and N1.5 branches) | RGB views, proprio, language, embodiment id; Cosmos-Reason2-2B backbone, SigLip2, flow-matching DiT; inference 16 GB+, fine-tune 40 GB+ | Self-host | Code Apache-2.0; weights NVIDIA Open Model License | Export target. Trains on a LeRobot v2 flavour + `meta/modality.json`, embodiment tags (`LIBERO_PANDA`, `OXE_DROID_...`), `NEW_EMBODIMENT` with `--modality-config-path`; LeRobot v3 converter; sim fine-tuning documented (LIBERO, SimplerEnv, RoboCasa, RoboLab). `nvidia/SO_ARM_Starter_Gr00tN17` exists on HF as an SO-arm reference dataset. |
| **Nemotron Nano 12B v2 VL** (Oct 2025) | video 2 fps, 8 to 128 frames, 128K, video-pruning (EVS) | Self-host | NVIDIA Open Model License | Good single-GPU VLM if Token Factory video fails; else redundant. |
| **Nemotron 3 Nano Omni 30B-A3B** (Apr 2026) | video + audio + image, 2 min clips, 128 to 256 frames, EVS 0.5, 256K; 1x H100 BF16 or L40S FP8 | Self-host | NVIDIA Open Model Agreement | Only if you want audio narration of the demonstrator understood. |
| **GEAR-SONIC** (Nov 2025) | SMPL motion reference to Unitree G1 29-DoF joint actions; Isaac Lab | Self-host | Weights NVIDIA Open Model License; code Apache-2.0 | The natural "human motion to humanoid" bridge, but needs Isaac Lab and SMPL from video: stretch, not critical path. |
| Audio2Face-3D v3.0 | audio to face motion | Self-host | NVIDIA Open Model License | Not relevant. |
| GR00T-H | surgical, non-commercial | n/a | NVIDIA noncommercial | Not relevant. |

## Table 3: Research precedents, planners, perception

| Item | Status | Licence | Verdict |
|---|---|---|---|
| **MimicGen** (NVlabs, v1.0.1 Sep 2024, pushed Oct 2026) | robosuite / robomimic sim envs, 48k demos over 12 tasks | NVIDIA Source Code License: non-commercial (research or evaluation only); datasets CC-BY 4.0 | Cite as the "few demos to many" precedent; do not vendor the code into a commercial pitch. |
| **DexMimicGen** (ICRA 2025, requires robosuite) | bimanual, dexterous | Same licence | Precedent only. |
| **Isaac Lab Mimic** (`isaaclab_mimic`) | MimicGen in Isaac Lab | Apache-2.0 | The permissive implementation if you ever need it. |
| **OKAMI** (UT Austin RPL, Oct 2024; Yuke Zhu is UT Austin + NVIDIA, likely) | single RGB-D video to humanoid plan, object-aware retargeting; needs HaMeR, SLAHMR, MANO/SMPL-X, OpenAI key | No LICENSE file in repo | Closest paper to the idea; pipeline is too heavy for seven days. Cite it. |
| **RoboLab** (NVlabs, Apache-2.0, news Aug to Oct 2026) | 120-task Isaac Lab benchmark, policy as server, client in sim | Apache-2.0 | Shows NVIDIA's own "evaluate a policy in sim via server-client" pattern; your browser rehearsal is a lightweight analogue. |
| **Isaac Lab 3.0.0** | BSD-3; Newton physics by default, kit-less Docker `nvcr.io/nvidia/isaac-lab:3.0.0-kitless` needs no Isaac Sim EULA, headless Newton needs no RTX; base image with Isaac Sim requires the NVIDIA SLA | BSD-3 (Mimic ext Apache-2.0) | Feasible on a Nebius GPU for a batch job but heavy; keep MuJoCo. |
| **Isaac Sim** (`isaac-sim/IsaacSim`, pushed 22 Oct 2026) | Code Apache-2.0 with proprietary components; container `nvcr.io/nvidia/isaac-sim:6.2.0`, `runheadless.sh`, `ACCEPT_EULA=Y`, `--network=host` | Mixed | Skip. |
| **cuRobo** | IK and motion planning, CUDA | Apache-2.0 (pushed Sep 2026) | Useful for retargeting human wrist poses to arm joint trajectories on the GPU job; browser IK can be simpler. |
| **FoundationPose / FoundationStereo** | 6D pose, stereo depth | NVIDIA Source Code License, non-commercial | Research-only; mention, do not depend on. |

## Table 4: MuJoCo Menagerie embodiments (repo Apache-2.0, per-model licences, pushed 20 Oct 2026)

| Robot | Directory | Licence |
|---|---|---|
| Unitree G1 / H1 | `unitree_g1`, `unitree_h1` | BSD-3 |
| Franka Panda / FR3 | `franka_emika_panda`, `franka_fr3` | Apache-2.0 |
| SO-100 / SO-101 | `trs_so_arm100`, `robotstudio_so101` | Apache-2.0 |
| Kinova Gen3 | `kinova_gen3` | BSD-3 |
| UR5e | `universal_robots_ur5e` | BSD-3 |
| Robotiq 2F-85 | `robotiq_2f85` | BSD-2 |
| Shadow Hand, Leap Hand, ALOHA | `shadow_hand`, `leap_hand`, `aloha` | Apache-2.0, MIT, BSD-3 |

## MuJoCo in the browser (2026)

- **Official**: `@mujoco/mujoco` on npm, "canonical JavaScript and TypeScript bindings", maintained by Google DeepMind, Apache-2.0; versions 3.15.0 (5 Oct), 3.16.0 (14 Oct), 3.17.0 (22 Oct 2026). ESM, ships `.wasm`, single-threaded default plus `/mt` build needing COOP/COEP headers (relevant on Vercel: set the two headers). README still says "WIP", Chrome on Linux is the main dev target, macOS tested in CI, Windows experimental. Source lives in `google-deepmind/mujoco/wasm`.
- `mujoco-js` 0.0.7 (Mar 2026) is an earlier official package; prefer `@mujoco/mujoco`.
- `zalo/mujoco_wasm` (MIT, pushed 23 Aug 2026) is now a three.js demo suite on top of the official bindings (MuJoCo 3.12); demo at zalo.github.io/mujoco_wasm. Good starting point for the viewer.

## What this means for Understudy

1. Both hard requirements are met by a single runtime call to `nvidia/Nemotron-3.5-Super-VL` on Token Factory; Nemotron 3 Super on Token Factory covers the interview. No GPU needed for the demo-critical path.
2. The critic is Cosmos-Reason2-8B via `vllm serve` on one Nebius H100 or L40S (48 GB); that is the "Nebius AI Cloud compute" story and a second NVIDIA model.
3. Export LeRobot v2 + `meta/modality.json` + `NEW_EMBODIMENT` config, and say "post-training-ready for GR00T N1.7"; do not claim you fine-tuned GR00T.
4. Rehearsal stage: `@mujoco/mujoco` 3.17 + `robotstudio_so101` (or `trs_so_arm100`) in the browser; G1 for the humanoid screenshot.
5. Cite MimicGen / DexMimicGen / OKAMI as precedents; their licences (non-commercial, none) rule out reuse of code.

## Recommendations
- Make `nvidia/Nemotron-3.5-Super-VL` on Token Factory the single demo-critical NVIDIA call: keyframes (and the MediaPipe pose JSON) in, semantic step labels out. It satisfies both hard requirements in one request and costs $0.30/$0.90 per M tokens.
- Day-one spike (30 min): hit `https://api.tokenfactory.nebius.com/v1/chat/completions` with Nemotron-3.5-Super-VL using (a) a `video_url` part and (b) 8 to 16 `image_url` frames. The docs only document images; the catalog says video. Build the frame-sampling path in the browser regardless, since it stays under Vercel's 4.5 MB body limit.
- Run the interview and task-spec synthesis on `nvidia/nemotron-3-super-120b-a12b` (reasoning on, JSON mode); fall back to `nvidia/Nemotron-3_5-Lightning` for cheap structured extraction. Reserve Ultra for a single 'final spec audit' call if budget allows.
- Self-host Cosmos-Reason2-8B with `vllm serve` on one Nebius GPU (L40S 48 GB or H100) as the rollout critic; it is the only NVIDIA model trained explicitly as a physical-plausibility critic that fits one GPU in one afternoon. Mention Cosmos 3 Nano as the upgrade path; attempt it only if vLLM-Omni comes up on the first try.
- Use the official `@mujoco/mujoco` 3.17.0 npm bindings for the browser rehearsal stage, loading `robotstudio_so101` (or `trs_so_arm100`) and `unitree_g1` from Menagerie; set COOP/COEP headers on Vercel only if you need the multithreaded build. Start from zalo/mujoco_wasm's three.js viewer.
- Export exactly what Isaac-GR00T N1.7 consumes: LeRobot v2 layout plus `meta/modality.json` and a `NEW_EMBODIMENT` modality config; validate it with the repo's loader on the GPU box and show the validation in the video. Say 'post-training-ready for GR00T N1.7'; do not claim a fine-tune.
- Give a teammate the Nebius Serverless Job: Python `mujoco` batch that replays the retargeted trajectory under N perturbations and writes success flags plus MP4s; the critic call runs over those MP4s. Optionally run cuRobo (Apache-2.0) there for IK retargeting.
- Cite MimicGen, DexMimicGen and OKAMI as precedents in the README and pitch; do not vendor MimicGen/DexMimicGen code (non-commercial licence) or OKAMI (no licence). If you ever need MimicGen-style augmentation, use `isaaclab_mimic` (Apache-2.0).
- Skip Isaac Sim, Isaac Lab, Cosmos Predict/Transfer and GEAR-SONIC for the seven-day build; list them as the roadmap (Transfer 2.5 for sim-to-real augmentation, SONIC for G1 whole-body). For 'Most Valuable Feedback', note the gap: no Cosmos or GR00T on Token Factory and no documented video input in the vision API.

## Open questions
- Does Token Factory's OpenAI-compatible endpoint accept video for nvidia/Nemotron-3.5-Super-VL (video_url, base64 MP4, size limit)? The catalog lists 'video' as a use case; the vision docs show images only. Needs a live test with a key.
- Does the hackathon's 'Nemotron 3 Nano / Super / Ultra' requirement accept Nemotron 3.5 Super VL (OpenMDW-1.1, released 15 Oct 2026)? Almost certainly yes as an 'other NVIDIA open-weight model', but confirm with organizers or hedge by also calling Nemotron 3 Super.
- Are Cosmos-Reason2 weights gated behind a Hugging Face login/terms click (the Cosmos-Transfer2.5 card is)? If so, one teammate must accept the NVIDIA Open Model License on HF before the Serverless Job can pull them.
- How much Nebius GPU credit does the hackathon grant, and can a single L40S/H100 stay up for the demo window so the critic responds live? If not, pre-compute critic verdicts and replay them.
- Is the GR00T N1.7 dataset loader tolerant of a single third-person camera plus a 6-DoF SO-101 state/action vector with NEW_EMBODIMENT, or does it require specific video keys? Validate with the repo's loader before claiming compatibility.
- Which Token Factory region hosts Nemotron-3.5-Super-VL (us-north1) and does a Paris-based Vercel function see acceptable latency for interactive video analysis?
- Cosmos 3 Nano Reasoner via vLLM-Omni on a single H100: untested here; if it works in under an hour it is a stronger story than Reason2.

## Facts
- [verified] Token Factory public catalog (30 models) is served at /api/public/models_info and /model-catalog.md; NVIDIA entries are Nemotron-3.5-Super-VL, Nemotron-3-Nano-30B-A3B, Nemotron-3-Super-120b-a12b, Nemotron-3-Ultra-550b-a55b, Nemotron-3.5-Lightning; no Cosmos, GR00T, Nemotron-Nano-VL or Omni. (https://tokenfactory.nebius.com/api/public/models_info)
- [verified] nvidia/Nemotron-3.5-Super-VL on Token Factory: image2text, use_cases include text, image, video, reasoning, function_calling; context 1024K; $0.30 input / $0.90 output per M tokens; licence OpenMDW-1.1; region us-north1. (https://tokenfactory.nebius.com/model-catalog.md)
- [verified] Token Factory NVIDIA text models: Nemotron-3-Nano-30B-A3B 262K $0.06/$0.24 (NVIDIA Open Model License); nemotron-3-super-120b-a12b 256K $0.30/$0.90; Nemotron-3-Ultra-550b-a55b 1024K $1/$3 (OpenMDW-1.1); Nemotron-3_5-Lightning 30B-A3B 1024K $0.06/$0.24 (OpenMDW v1.1), text only. (https://tokenfactory.nebius.com/model-catalog.md)
- [verified] Token Factory dedicated endpoints serve 'supported models' per GPU-hour; custom model weights are beta and 'available on request' via support. (https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/custom-weights.md)
- [verified] Token Factory vision API example passes images as image_url (URL or base64); the page documents no video input. (https://docs.tokenfactory.nebius.com/api-reference/examples/vision-capabilities.md)
- [verified] Token Factory rate limits are dynamic: baseline example 60 RPM / 400K TPM, +20% per 15-min window at >=80% use, up to 20x; Batch API has higher limits; base URL https://api.tokenfactory.nebius.com/v1/. (https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits.md)
- [likely] Token Factory fine-tuning model list covers DeepSeek, Gemma 4, GPT-OSS (Unsloth) and Qwen families; no Nemotron seen in the portion read. (https://docs.tokenfactory.nebius.com/post-training/models.md)
- [verified] NVIDIA-Nemotron-3.5-Super-VL-120B-A12B: Mamba-2/Transformer hybrid MoE, 120B total / 12B active, C-RADIO vision encoder, MP4 video up to 2 min, up to 256 frames at 2 fps with video pruning rate 0.5, 1M context, enable_thinking reasoning toggle, OpenMDW-1.1, released 15 Oct 2026, 4x H100 for self-hosting, vLLM and SGLang. (https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16)
- [verified] NVIDIA-Nemotron-3-Nano-30B-A3B: Mamba2-Transformer hybrid MoE, 30B total / 3.5B active, 1M context (256K default config), reasoning on by default via enable_thinking, released 15 Dec 2025, NVIDIA Nemotron Open Model License, vLLM >= 0.12 / SGLang / TRT-LLM. (https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16)
- [verified] NVIDIA-Nemotron-3-Super-120B-A12B: LatentMoE hybrid (Mamba-2 + MoE + attention, MTP), 120B / 12B active, 1M context, enable_thinking, released 11 Mar 2026, NVIDIA Nemotron Open Model License, minimum 8x H100-80GB. (https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16)
- [verified] NVIDIA-Nemotron-3-Ultra-550B-A55B: LatentMoE, 550B / 55B active, 1M context, enable_thinking, OpenMDW License Agreement 1.1, released 4 Jun 2026, minimum 8x B200 or 16x H100. (https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16)
- [verified] NVIDIA-Nemotron-3.5-Lightning-30B-A3B: 30B / ~3B active MoE, 1M context, thinking on by default, OpenMDW 1.1, released 11 Aug 2026, text in / text out only. (https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4)
- [verified] NVIDIA-Nemotron-Nano-12B-v2-VL: 12.6B, CRadioV2-H encoder, video sampled at 2 fps, 8 to 128 frames, video pruning rate setting, 128K context, NVIDIA Open Model License Agreement, released 28 Oct 2025, vLLM/TRT-LLM/SGLang. (https://huggingface.co/nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-BF16)
- [verified] Nemotron-3-Nano-Omni-30B-A3B-Reasoning: video+audio+image+text in, text out; MP4 up to 2 min, 1080p 1 fps 128 frames or 720p 2 fps 256 frames; video-pruning-rate 0.5 halves video prefill; 256K context; NVIDIA Open Model Agreement; released 28 Apr 2026; vLLM 0.20; BF16 needs 1x H100, FP8 1x L40S, NVFP4 1x RTX 5090. (https://huggingface.co/nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16)
- [verified] Cosmos-Reason1-7B: Qwen2.5-VL-7B base, video at 4 fps recommended, NVIDIA Open Model License, initial release 17 May 2025, 10 Jun 2025 update 'Enhanced critic capability for physical plausibility', vLLM runtime, uses include embodied planning and data curation. (https://huggingface.co/nvidia/Cosmos-Reason1-7B)
- [verified] Cosmos-Reason2: 2B, 8B and 32B (32B released 29 Apr 2026); Qwen3-VL base; 4 fps video; 256K input tokens; 8B needs >= 32 GB GPU, 2B 24 GB; vllm serve >= 0.11 and Transformers; weights NVIDIA Open Model License, code Apache-2.0; repo in limited maintenance since Cosmos 3 launch 1 Jun 2026. (https://github.com/nvidia-cosmos/cosmos-reason2)
- [verified] Cosmos-Reason2-8B card: 8.77B params, released 19 Dec 2025, update 10 Mar 2026, >= 32 GB GPU, benchmarks Robotics 56.90 vs Qwen3-VL-8B 53.08. (https://huggingface.co/nvidia/Cosmos-Reason2-8B)
- [verified] Cosmos 3 (repo github.com/nvidia/cosmos, 12k stars, pushed 21 Oct 2026): three omnimodal Mixture-of-Transformers models Super 64B, Nano 16B, Edge 4B; Reasoner tower (text/image/video to text) and Generator tower (video, audio, action JSON out); inference via Diffusers, Transformers, vLLM, vLLM-Omni, SGLang, TRT-LLM, NIM; Nano on RTX Pro 6000/H100/B200, Edge on Jetson; code and models OpenMDW-1.1. (https://github.com/nvidia/cosmos)
- [verified] Cosmos3-Nano: 16B, inputs text/image/video/action, outputs video/image/audio/action/text, OpenMDW1.1, released 31 May 2026, H200 recommended for vLLM-Omni serving. (https://huggingface.co/nvidia/Cosmos3-Nano)
- [verified] Cosmos3-Edge: 4B, Jetson benchmarks (AGX Thor, T3000, T2000, AGX Orin), OpenMDW1.1, released 20 Jul 2026, updated 25 Aug 2026. (https://huggingface.co/nvidia/Cosmos3-Edge)
- [verified] Cosmos3-Super: 64B, 8 GPUs recommended (2x H200 works, ~3 min per video), OpenMDW1.1, released 31 May 2026. (https://huggingface.co/nvidia/Cosmos3-Super)
- [verified] Cosmos3-Nano-Policy-DROID: 16B policy checkpoint, language + visual observations to action trajectories (JSON), served via cosmos-framework Docker policy server and evaluated in RoboLab; ranked #1 on RoboArena per card; OpenMDW 1.1; released 31 May 2026. (https://huggingface.co/nvidia/Cosmos3-Nano-Policy-DROID)
- [verified] Cosmos-Predict2.5-2B: text+image/video to 5-second 720p 16 fps video, 32.54 GB VRAM, 228.8 s per generation on H100 SXM, NVIDIA Open Model License, released 6 Oct 2025; a Cosmos-Predict2.5-14B also exists on HF (listing). (https://huggingface.co/nvidia/Cosmos-Predict2.5-2B)
- [verified] Cosmos-Transfer2.5-2B: diffusion transformer conditioned on up to four control videos (Canny edge, blurred RGB, segmentation, depth), 720p 16 fps, 65.4 GB VRAM, 719 s on H100 NVL, NVIDIA Open Model License, released 6 Oct 2025; collection archived in favour of Cosmos 3. (https://huggingface.co/nvidia/Cosmos-Transfer2.5-2B)
- [verified] Isaac-GR00T repo: N1.7 is GA (N1.6 branch n1d6, N1.5 n1d5); LeRobot v2 flavour plus meta/modality.json; embodiment tags such as LIBERO_PANDA and OXE_DROID_RELATIVE_EEF_RELATIVE_JOINT; custom robots use NEW_EMBODIMENT with --modality-config-path; LeRobot v3 conversion script; sim fine-tuning guides for LIBERO and SimplerEnv; inference 16 GB+ VRAM, fine-tuning 40 GB+ (H100/L40); code Apache-2.0, weights NVIDIA Open Model License; repo pushed 22 Oct 2026. (https://github.com/NVIDIA/Isaac-GR00T)
- [verified] GR00T-N1.7-3B card: 3B, Cosmos-Reason2-2B VLM backbone, SigLip2 vision, flow-matching DiT action head, inputs RGB frames + proprioception + language + embodiment id, NVIDIA Open Model License Agreement, 35.9 Hz with TensorRT on H100, 4.6 Hz on Jetson Orin; HF entry last modified 23 Apr 2026. (https://huggingface.co/nvidia/GR00T-N1.7-3B)
- [verified] nvidia/SO_ARM_Starter_Gr00tN17 exists on Hugging Face (modified 5 May 2026), an SO-arm starter checkpoint/dataset for GR00T N1.7. (https://huggingface.co/api/models?author=nvidia&search=GR00T)
- [verified] GEAR-SONIC: humanoid behavior foundation model via motion tracking; Unitree G1 29-DoF; input SMPL motion reference (4 or 10 frames, 20 ms spacing) to 64-d latent to joint actions; evaluated in Isaac Lab; weights NVIDIA Open Model License, code Apache-2.0 (NVlabs/GR00T-WholeBodyControl, pushed 13 Oct 2026); paper arXiv 2511.07820 (Nov 2025). (https://huggingface.co/nvidia/GEAR-SONIC)
- [verified] MimicGen: NVIDIA Source Code License for code (use limited to non-commercial 'research or evaluation purposes only'), datasets CC-BY 4.0, 48k+ demos over 12 tasks, v1.0.1 19 Sep 2024; repo pushed 21 Oct 2026. (https://github.com/NVlabs/mimicgen)
- [verified] DexMimicGen (ICRA 2025, arXiv 2410.24185): requires robosuite; code under NVIDIA Source Code License (links to MimicGen LICENSE), datasets CC-BY 4.0; repo pushed 6 Dec 2025. (https://github.com/NVlabs/dexmimicgen)
- [likely] MimicGen environments run on robosuite (MuJoCo). (https://github.com/NVlabs/dexmimicgen)
- [verified] OKAMI (arXiv 2410.11792, submitted 15 Oct 2024; authors Jinhan Li, Yifeng Zhu, Yuqi Xie, Zhenyu Jiang, Mingyo Seo, Georgios Pavlakos, Yuke Zhu): single RGB-D video to manipulation plan with object-aware retargeting; rollouts train visuomotor policies at 79.2% success; repo UT-Austin-RPL/OKAMI has no LICENSE file, needs HaMeR/SLAHMR/MANO/SMPL-X and an OpenAI key; last push 18 Jun 2025. (https://arxiv.org/abs/2410.11792)
- [likely] Yuke Zhu (OKAMI senior author) holds a joint UT Austin / NVIDIA affiliation, which is the NVIDIA link to OKAMI. (https://arxiv.org/abs/2410.11792)
- [verified] Isaac Lab 3.0.0: BSD-3 licence (isaaclab_mimic Apache-2.0); Newton physics default, Isaac Sim optional extra; Docker images nvcr.io/nvidia/isaac-lab:3.0.0 (needs NVIDIA SLA acceptance) and 3.0.0-kitless (no Isaac Sim EULA); headless Newton needs no RTX; viser/rerun web viewers; CUDA GPU compute capability 7.5+, driver 595.58.03+; repo pushed 23 Oct 2026. (https://isaac-sim.github.io/IsaacLab/main/source/isaaclab/installation.html)
- [verified] Isaac Sim repo LICENSE: software in the repository under Apache 2.0, but building or using it requires additional components under other terms; container nvcr.io/nvidia/isaac-sim:6.2.0 runs headless via runheadless.sh with ACCEPT_EULA=Y (NVIDIA Omniverse License Agreement) and --network=host for livestream. (https://docs.isaacsim.omniverse.nvidia.com/latest/installation/install_container.html)
- [verified] RoboLab (NVlabs): Apache-2.0 task-based evaluation benchmark on Isaac Lab (RoboLab-120 tasks, policy-as-server client integration, parallel envs, episode videos); news items Aug to Oct 2026; repo pushed 22 Oct 2026. (https://github.com/NVlabs/RoboLab)
- [verified] cuRobo (NVlabs/curobo) is Apache-2.0, pushed 10 Sep 2026. (https://api.github.com/repos/NVlabs/curobo)
- [verified] FoundationPose and FoundationStereo LICENSE files restrict use to non-commercial 'research or evaluation purposes only' (NVIDIA Source Code License). (https://raw.githubusercontent.com/NVlabs/FoundationPose/main/LICENSE)
- [verified] Audio2Face-3D v3.0: audio to 3D facial motion, NVIDIA Open Model License, released 24 Sep 2025; no robotics relevance. (https://huggingface.co/nvidia/Audio2Face-3D-v3.0)
- [verified] OpenMDW-1.1 is a permissive licence for 'Model Materials' (weights, code, data, docs) granting permission 'free of charge, to deal in the Model Materials without restriction' with notice retention; no restriction on outputs; no OSI claim. (https://openmdw.ai/license/1-1/)
- [verified] MuJoCo Menagerie: repo Apache-2.0 with per-model licences; directories unitree_g1, unitree_h1 (BSD-3), franka_emika_panda, franka_fr3 (Apache-2.0), trs_so_arm100 and robotstudio_so101 (Apache-2.0), kinova_gen3 (BSD-3), universal_robots_ur5e (BSD-3), robotiq_2f85 (BSD-2), shadow_hand (Apache-2.0), leap_hand (MIT), aloha (BSD-3); repo pushed 20 Oct 2026. (https://github.com/google-deepmind/mujoco_menagerie)
- [verified] @mujoco/mujoco on npm: 'canonical JavaScript and TypeScript bindings' maintained by Google DeepMind, Apache-2.0, source in google-deepmind/mujoco/wasm; versions 3.15.0 (5 Oct 2026), 3.16.0 (14 Oct 2026), 3.17.0 (22 Oct 2026); ESM with bundled .wasm; single-threaded default and /mt build requiring COOP/COEP headers; README marks bindings WIP, Linux/Chrome primary, macOS CI-tested, Windows experimental. (https://registry.npmjs.org/@mujoco/mujoco)
- [verified] mujoco-js 0.0.7 (Mar 2026) is an earlier official DeepMind package ('The official MuJoCo WebAssembly module', repo directory wasm/package). (https://registry.npmjs.org/mujoco-js)
- [verified] zalo/mujoco_wasm (MIT, 493 stars, pushed 23 Aug 2026) is now a three.js demo suite on top of the official @mujoco/mujoco bindings (MuJoCo 3.12), demo at https://zalo.github.io/mujoco_wasm/; fork of stillonearth/MuJoCo-WASM (last push Oct 2023). (https://github.com/zalo/mujoco_wasm)
- [verified] Nebius Token Factory 'Model flavors': Base and -fast suffix; GPU types L40, H100, H200, B200; API supports the full set of vLLM parameters. (https://docs.tokenfactory.nebius.com/ai-models-inference/overview.md)