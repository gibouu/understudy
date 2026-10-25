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

Measured on 25 October 2026 during the experiments in `docs/MEASUREMENTS.md` (about 9,000 calls, US$13.73 at list prices, all logged in `bench/results/ledger.jsonl`).

For each: used for, what worked, what needs work, minutes to hello-world, would we build on it again.

### Token Factory onboarding and credits
### Nemotron 3.5 Super VL

- **Used for:** labelling a clip into a task spec, from a 480p video proxy sent as a `video_url` data URI.
- **Worked:** valid JSON in all but 4 of 105 label calls (one a truncation with thinking off); 2.4 to 3.9 s for a 36 s clip; about US$0.0024 per label.
- **Needs work:**
  - **Fine manipulation:** on the NASA ISS clip (an astronaut placing seed film into plant pillows) it never named the film as the object moved: 0 of 35 labels across seven input conditions. In 23 it called the pillows "battery packs" or "hard drives". A one-line context hint cut that to 1 of 5. Only a hint naming the task got the film named.
  - **Video tokens are fixed per clip:** 6,379 tokens for that clip at 2, 4 or 8 fps and at 480 or 960 px wide, so the service resamples the video. That is good for cost, but undocumented. Image inputs do scale with resolution.
  - **Thinking:** turning it on (4k budget) made labels worse and hit the budget with empty content in 3 of 10 runs.
- **Prompt caching:** reported 2,176 cached tokens on repeated video.
- **Build again:** yes, with a short task hint from the user.
### Nemotron 3 Nano

- **Used for:**
  - compiling a spec into a program with `ask` slots, about 5 calls per session
  - the health probe
- **Worked:** cheap (US$0.0017 per session for compiles) and valid JSON.
- **Needs work:**
  - **Thinking off is erratic for compiling:** some programs came back without their `ask` slots, and asks per compile ranged from 0 to 10. A rule with an example ("a missing value is an ask, not a warning") fixed most of it.
  - **It never asked for a via-point height:** 0 of 150 compiles.
  - **Default thinking eats small budgets:** a 5-token health call always returns empty, and a 3,000-token compile budget came back empty 3 of 3 times.
  - **Pretty-printing is slow:** indented JSON output makes compiles take 0.3 to 9.3 s.
### Nemotron 3 Super

- **Used for:**
  - the interview
  - the perturbation scenarios
  - the patches that repair a failing program
- **Worked:**
  - **Patching from the simulator's failure notes alone** (measured facts, never the answer), across four tasks at four gravities: Rates are of the solvable failures (180 of 186):
    - with thinking off, it fixed 69% of failing rehearsals within five patches, at US$0.0015 per fix
    - with thinking on (4k), 94%
    - starting with thinking off and escalating to thinking on when stuck, also 94% (91% of all failures), at US$0.0024 per fix
  - **Rules from earlier repairs:** two rules it distilled from 16 Earth and Mars repairs raised first-try success on the Moon and in orbit by 28 points with thinking off and 18 with thinking on, against matched controls.
  - **Infeasible tasks:** with thinking off it declared pouring beads in orbit infeasible in 12 of 12 runs, and never wrongly on a surface.
- **Needs work:**
  - **Stuck patches:** with thinking off, about a quarter of its patches changed nothing. It rarely used a measured offset ("4.1 mm from the pocket centre") to correct an insertion: 58 of 1,079 patches did, mostly late, and 38 had the wrong sign.
  - **Saboteur:** it sometimes returned 5 scenarios instead of 12, and twice left out gravity despite the rule.
  - **Interview:** in a single call per turn it dropped 39% of answers that carried the missing value. A separate call that turns each answer into spec changes fixed that, and recovery rose from 21% to 43%.
- **Prompt caching:** reported 0 cached tokens on interview turns that share a long prefix.
- **Build again:** yes.
### Nemotron 3 Ultra

- **Used for:** the reshoot list and failure classes, once per session, in the background.
- **Worked:**
  - **Patching:** with 16k of reasoning it fixed 94% of failing rehearsals, 80% on the first patch. That is the best first-patch rate of any configuration.
  - **Validity:** every output was valid JSON.
- **Needs work:**
  - **Cost:** it is 73% of a session's cost, US$0.027 of US$0.0375. Reasoning ran 4.6k to 10.1k tokens per call and drives all of the session's cost variance.
  - **Reasoning budget:** at a 4k budget, 138 of 239 patch calls ran out with no content. It needs 16k or thinking off.
- **Build again:** yes for the deep pass; thinking off is enough for patching.
### Tavily
### Nebius Serverless Jobs
