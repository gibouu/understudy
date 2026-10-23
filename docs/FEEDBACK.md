# Feedback on Nebius Token Factory, Nebius AI Cloud and the NVIDIA models

Filled as we go. Every line is something we measured or hit ourselves; dates are 2026.

## Day-one smoke tests (23 Oct)

Run with `node scripts/smoke-tokenfactory.mjs` against the 30 s dev clip (`samples/dev-clip.mp4`), results in the table; prices from `tests/fixtures/models.json`.

| Test | Model | Result | Latency | Notes |
|---|---|---|---|---|
| 14 keyframes + montage, `json_object` | `nvidia/Nemotron-3.5-Super-VL` | HTTP 400 "At most 8 image(s) may be provided in one prompt" | | the cap is per request; the same with `json_schema` |
| 6 keyframes + montage, thinking off, `json_object` | Super VL | ok, 2,760 in / 324 out, valid JSON | 1.9 s | the keyframe fallback: 7 images |
| 6 keyframes + montage, thinking off, `json_schema` | Super VL | ok, 2,760 in / 325 out, valid JSON | 1.8 s | |
| 10 s video proxy (480p, 4 fps, 72 KB) as a `video_url` data URI, thinking ON | Super VL | finish `length`, 1,500 reasoning tokens, empty content | 4.4 s | default thinking eats the whole budget |
| same, thinking off, `json_object` | Super VL | ok, 1,824 in / 237 out, valid JSON | 1.3 s | **the chosen Label input** |
| same, thinking off, `json_schema` | Super VL | ok, 1,824 in / 326 out, valid JSON | 1.5 s | |
| same, `reasoning_effort: none` | Super VL | ok, 318 out, valid JSON | 1.3 s | |
| same, thinking on, 6k budget | Super VL | ok, 3,239 reasoning + 162 content | 9.0 s | not worth it for labels |
| full 30 s clip proxy (154 KB), thinking off | Super VL | ok, 5,024 in / 781 out, valid JSON | 3.3 s | about 170 input tokens per second of clip; a 2-minute clip is about 20k tokens, under a cent |
| compile prompt, default | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | ok, 983 out, valid JSON | 3.7 s | thinking on by default; reasoning not itemised in usage |
| compile prompt, `reasoning_effort: none` | Nano | **empty content** | 0.5 s | do not use on Nano |
| compile prompt, `enable_thinking: false` | Nano | ok, 251 out, valid JSON | 1.0 s | **the Nano setting** |
| compile prompt, unknown parameter | Nano | accepted silently; finish `length` at 1,200 tokens (thinking) | 4.1 s | typos never 400 |
| compile prompt, default | `nvidia/nemotron-3-super-120b-a12b` | ok, 615 reasoning + 74 content, valid JSON | 4.5 s | |
| compile prompt, `reasoning_effort: none` | Super | ok, 59 out, valid JSON | 0.8 s | |
| compile prompt, `enable_thinking: false` | Super | ok, 60 out, valid JSON | 0.9 s | **the Super setting** (same flag as Nano) |
| compile prompt, unknown parameter | Super | accepted silently | 4.0 s | |
| `GET /v1/models?verbose=true` | | 30 models, our four present with `pricing`, `per_request_limits`, `supported_features` | | saved as `tests/fixtures/models.json` |

Decisions frozen in `lib/providers/tokenfactory.ts`: Label input is a 480p 4 fps H.264 proxy of the whole clip (under 2 minutes) as a `video_url` data URI with thinking off, keyframes (7 plus a montage) as the fallback; every call to the three models passes `chat_template_kwargs.enable_thinking: false` unless it wants reasoning; `reasoning_effort` is never used because, for this prompt and budget, it emptied Nano's answer. With thinking on, output length varied several-fold between runs of the same prompt (one Nano run finished at 983 tokens, another hit the 1,200 budget), which is the second reason to turn it off for the fast calls. Reasoning, when on, arrives in `reasoning_content`, not inside the text, so the parser's think-tag handling is a safety net only.

## Per tool

For each: used for, what worked, what needs work, minutes to hello-world, would we build on it again.

### Token Factory onboarding and credits
### Nemotron 3.5 Super VL
### Nemotron 3 Nano
### Nemotron 3 Super
### Nemotron 3 Ultra
### Tavily
### Nebius Serverless Jobs
