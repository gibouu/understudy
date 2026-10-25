# Understudy, spec v2

Produced on 23 October 2026 by a 20-agent planning run (five research sweeps, five independent concepts, four judges, a synthesis, four critics, a hardening pass), then adapted to the decisions gib took the same day: the household stand-in for the hero clip, the fixture vocabulary that keeps the product task-agnostic, and a task board instead of a per-person schedule. The research digests and the critics' findings are in `docs/research/`. The day-by-day plan is `docs/PLAN.md`.

Model IDs, packages and services named here were verified against live pages on 23 October 2026; anything marked (UNVERIFIED) has its fallback stated beside it.

## 1. Name and one-liner

**Understudy** (unchanged). One clip of a person doing a hands-on task, aboard a station or on a bench, becomes an interviewed, provenance-tagged task spec; the spec compiles into an object-relative robot program whose via-points come from the clip; a simulated SO-101 runs it under model-written perturbations in two modes (sensed pose and blind) and under Earth, Moon and orbit gravity, to measure how much perception the task needs and whether it survives microgravity; the export is a GR00T-layout LeRobot skeleton with a reshoot list. Nemotron 3.5 Super VL, Nemotron 3 Nano, Super and Ultra on Nebius Token Factory watch, compile, ask and judge.

## 2. Problem, audience, why now

**Headline use (decided 24 Oct): civil space.** On a station every crew hour is scarce and every mistake is expensive; the robots meant to take over routine crew work (Canadarm2 and Dextre, Astrobee, GITAI's arm, the arms planned for commercial stations and lunar bases) need a clear task, a rehearsed program and labelled data, and NASA films crew procedures by the hour. Understudy turns one such clip into all three and rehearses the program at 1 g and at 0 g, because a bench-proven program can fail the moment a released object drifts. One sentence for satellite servicing and refuelling, where the stakes are a spacecraft. The ground story below stays as the mirror: same loop, same app.

Collection is an industry: Micro1 (>$100M ARR, recorders at about $15/h), Mecka ($60M Series B with NVIDIA), Scale, Figure Index. The waste comes after: $3.75 to $20 per usable demo, 20 to 30 percent discarded, re-collection 30 to 50 percent of a $50k to $200k campaign (Robotics Center, March 2026); Encord: dense annotation costs 20x and is worth 100x. Nobody asks the person who did the task, and nobody tests a task before buying 500 repetitions.

Understudy is a pre-collection briefing and QA layer with one new number: per perturbation axis, how far a scripted program survives blind (nominal pose) and with a pose estimate. "Insertion survives ±4 mm rack error blind, ±25 mm sensed" tells a QA desk whether the task needs perception, fixturing or a reshoot.

Audience: teams bootstrapping a task on an SO-101 or UMI rig from phone clips; vendor QA desks; integrators scoping a cell. Why now: Nemotron 3.5 Super VL on Token Factory (16 Oct) is the first hosted NVIDIA model taking images and video; official MuJoCo WebAssembly bindings reached npm on 22 Oct; GR00T N1.7 documents the LeRobot v2.1 plus `modality.json` layout.

## 3. Input to output contract

**Upload:** one H.264 MP4, 10 s to 2 min (longer clips are trimmed, said on screen), one person, one tabletop task, fixed phone, side or front view. HEVC or MOV is rejected with the fix printed ("iPhone: Settings > Camera > Formats > Most Compatible") beside a "Try the sample clip" button. Nothing is stored anywhere: the clip is decoded in the browser, which encodes a 480p 4 fps proxy (about 150 KB per 30 s) that leaves it only inside the Label request as a data URI; the fallback sends 7 JPEG keyframes plus a montage (Token Factory caps a request at 8 images). No account. The session persists in IndexedDB keyed by the clip's SHA-256 and resumes after a refresh; the same structure is the replay fixture.

**Download:** `understudy-<slug>.zip`: `lerobot/` (LeRobot v2.1 layout, up to four passing episodes, `so101_follower`, `modality.json`) and `understudy/` (spec, program, interview transcript, rehearsal report, reshoot list, ledger, grounding, warnings, `QUALITY.md`, keyframes, pose, tokens).

**Spec:** the v1 schema with a `source` on every field (`vl#seg1`, `interview#2`, `pose#seg1`, `tavily:<url>`), plus `anchor{t_s, confidence}`, `objects[].symmetry`, `steps[].via_points[{frame, xyz_mm, source}]`, `warnings[]`, `provenance.label_input`, and tolerances naming the perturbation axes.

Every stage returns `StageResult<T>` (`idle | running | done{value, warnings[]} | failed{message}`) with Retry, Skip (degraded defaults) and Use sample; Export always zips what exists.

### Task-agnostic by construction

The code never names a task. The vision model labels each object as a primitive (`cylinder`, `box`, `sphere`) with a size and a symmetry, and each step's target as one of three **fixtures**: `pocket` (insertion: rack, holder, carton, connector), `zone` (placement on a surface area: saucer, shelf, bin) or `stack` (on top of another object). Anything else degrades to `zone` with a warning. The scene builder turns that into MuJoCo primitives (a pocket is a box with a hole of the labelled clearance); the perturbation axes follow from the fixture and the symmetry (yaw dropped for symmetric objects, clearance and pose error for pockets, tilt for stacks); the interview questions come from compile `ask` slots, not a fixed questionnaire. Three sample clips ship with the app and prove it: a capped marker or small bottle from a tray into a home-made cardboard rack (the lab stand-in: a cylinder into a hole a few millimetres wider), a cup onto a saucer (zone), and a small box onto a shelf (stack). The same perception-budget number serves lab automation, food packaging, electronics insertion, kitting and pharmacy.

## 4. Pipeline stage by stage

| # | Stage | What happens | Model, latency |
|---|---|---|---|
| 1 | Watch | `<video>` + `requestVideoFrameCallback` (2x, 10 fps, 640 px, rotation handled by the element) → MediaPipe Pose (`numPoses: 3`, largest torso nearest centre, hip-tracked) and Hand (matched to that person's wrists; gaps ≤0.5 s interpolated; pose fallback; loss banner); 2D hands-only mode when pose is mostly missing → tokens → anchor at the wrist-speed minimum in the grasp span, with confidence and click-to-set; no grasp → touch task → 12-16 keyframes, one montage | browser, ≈0.5x clip |
| 2 | Label | the whole clip as a 480p 4 fps H.264 proxy (under 2 min, about 150 KB per 30 s) sent as a `video_url` data URI with thinking off → segments, objects, symmetry, sizes; times clamped, overlaps merged, sizes 5-300 mm else a warning and the first question; a VL grasp verb seeds GRASP if the state machine found none. Fallback: 7 keyframes + 1 montage as base64 `image_url` (Token Factory caps a request at 8 images). Measured 23 Oct: 30 s clip = 5,024 input tokens, 3.3 s | `nvidia/Nemotron-3.5-Super-VL`, `enable_thinking: false`, 1-4 s |
| 3 | Read-through | spec → `move_to(frame, offset, approach)`, gripper commands, `wait_until(pred)`, `assert(pred)`, `ask(q)`, via-points per segment; once per answer | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, thinking off, 2-5 s |
| 4 | Interview | `{question, chips, why, done, changes[]}` streamed in that key order | `nvidia/nemotron-3-super-120b-a12b`, 3-8 s per turn |
| 5 | Ground | Tavily `search` (basic) + `extract` top 2 → Nano keeps sentences naming a spec object or verb → opt-in chips with URL; 6 s budget; error → empty | Tavily + Nano |
| 6 | Saboteur | 12 scenarios with expected outcomes; axes from object symmetry and the tight constraint (rack pose error, slot clearance, tilt, obstacle; yaw dropped for symmetric objects) | Super, 5-10 s |
| 7 | Rehearsal | reachability pre-check → 12 × {sensed, blind} rollouts in a Web Worker | `@mujoco/mujoco` 3.17.0 + three.js, 1-3 s each |
| 8 | Notes | worst failure as text (metrics, failing predicate, joint-log excerpt) → one `changes[]` patch → Nano recompile → re-run | Super |
| 9 | Reshoot | failure classes (spec gap, footage gap, embodiment limit, simulator artefact with evidence); reshoot items only for video- or interview-sourced fields | `nvidia/Nemotron-3-Ultra-550b-a55b`, `max_tokens` 16k, background; Export after 90 s |
| 10 | Export | up to four passing episodes at 480x360, 15 fps (`avc1` probe, else VP9/WebM, which GR00T's loader does not read and `QUALITY.md` must flag as not loader-compatible) → parquet, `modality.json`, templated captions, degenerate-dimension assert, ledger, zip | browser |
| 11 (S) | Validate | `validate_groot.py` loads the export with Isaac-GR00T's loader | Serverless Job, Python file submitted directly (UNVERIFIED; fallback `python:3.12` container) |

`/api/health` at page load (a 5-token Nano call plus `GET /v1/models`) switches the page to replay with a banner on failure or a missing ID. Every route: `maxDuration = 300`, explicit `max_tokens`, `?replay=1`, model IDs from env. About 18 requests and under $0.10 per session.

## 5. The visual layer

Row 1: the video with a canvas skeleton of the selected person and the anchor marker. Row 2: token chips on a timeline; after Label they gain labels and a confidence tint; dotted chips mean "model unsure" and become the first questions. Row 3, after the first rollout: six joint-angle sparklines with a reachability flag. Spec panel: a `source` badge on every field. Stage: arm, objects, via-point ghost line, sensed/blind toggle, 2x12 grid; the selected scenario's offsets are editable and re-run. Narrow screens stack the rows; phones get a "best on a laptop" note and a working replay.

## 6. The interview

`nvidia/nemotron-3-super-120b-a12b`, `reasoning_effort: medium` with `extra_body.chat_template_kwargs.enable_thinking` as backup (UNVERIFIED; a 400 is retried without optional parameters), streamed with AI SDK `streamText` and `Output.object`; question and chips render as soon as they close. Each turn emits `changes[]` (`{path, value, source}`), not the full spec; the client applies it, highlights the paths and appends the turn to `interview.jsonl`. Only slots the compile failed are asked, and each question must cite a measurement from this clip (keyframe time, token span, aperture or offset), so the hero and cup clips yield different question sets. Groups: tolerances, grasp, success criteria, hazards (Tavily chips opt-in), recovery. "I don't know" becomes an `open_question` with a widened band. Parsing: strip `<think>`, first balanced JSON object, Zod with unknown predicates coerced to the nearest enum member plus a warning; a second failure keeps the previous spec. Ends at zero `ask` slots with a predicate per step, after seven turns, or on "Rehearse now".

## 7. The rehearsal stage

**Engine:** `@mujoco/mujoco` 3.17.0 single-threaded build in a Web Worker (no COOP/COEP); the main thread renders three.js from posted joint arrays, so the grid paints and the interview stays live. Menagerie `robotstudio_so101` as shipped, STLs written into MEMFS under exact paths Friday evening; the Menagerie scene file and the binding exports (`mj_jacSite`, `eq_active`, `from_xml_string`) are confirmed Friday (§21). The rack is a box with a 20 mm pocket for the 17 mm tube; obstacles are boxes.

**Embodiment honesty:** five arm joints plus gripper. IK solves position plus approach axis (five constraints) with `mj_jacSite` on a tip site, damped least squares; the approach is projected onto the reachable wrist-pitch plane and the angle recorded; a projection over 20° counts as an embodiment limit. A reachability pre-check per scenario reports unreachable targets as "embodiment limit".

**Via-points, not retargeting:** per VL segment, three to five wrist via-points in the anchored object or zone frame, timing-scaled, `source: pose#segN`; perturbations transform them per segment (the MimicGen mechanism). The ghost line is those via-points.

**Two modes:** sensed (the program receives the perturbed pose: reach, clearance, computability) and blind (nominal pose, perturbed world: how much pose error the task tolerates). The interview's band is judged blind; "inside, edge, beyond" means something only there. Scenarios may add `pose_noise_mm`. The report gives an envelope per axis and mode.

**Grasp:** a weld fires only when both pads are within ±x mm of the object centre along the pad normal and the commanded aperture lies inside [size−δ, size+δ]; otherwise the object stays free and falls. Tilt and zone are measured after release. The README calls it a geometric proxy: no friction, no slip. The natural demo failure is insertion: a few mm of rack error collides tube and pocket.

**Predicates** (closed enum): `contact_both_pads`, `height_above`, `inside_zone`, `no_collision`, `tilt_under`, `gripper_within`, `object_still`, `time_under`; pass means every step's predicates hold in order plus the agency rule (zone without prior sustained contact fails). `wait_until` reads sim state every step. Reactive turn (Wednesday stretch): on a mid-rollout predicate failure, one Nano call returns one recovery primitive, logged.

**Gravity:** a scenario carries `gravity_g` (1 Earth, 0.1654 Moon, 0 orbit); the stage sets `<option gravity>` after the arm's include so it wins, and the worker can change it at run time. The scoreboard (issue #55) will show the same 24 rollouts per gravity. In orbit a released object keeps its velocity, so `release` must come after the object is constrained (inside the pocket, on the zone with a hold) or `object_still` fails; that difference is the orbit demo.

**What a pass proves:** the clarified spec is executable by a scripted SO-101 program across the stated band in rigid-body physics with a geometric grasp, and the success criteria are computable; not that a learned policy would succeed or a real grasp holds. If Sunday's go/no-go fails, the stage becomes a kinematic replay and all physics claims are removed.

## 8. Data product

`lerobot/` is LeRobot v2.1, the flavour GR00T N1.7 reads: parquet with `observation.state` and `action` (6 floats, `shoulder_pan.pos` to `gripper.pos`), `timestamp`, `frame_index`, `episode_index`, `task_index`; `observation.images.workspace` at 15 fps; `tasks.jsonl` with one instruction string per task; scenario, mode and pass flag in `episodes.jsonl` extra fields; `stats.json` with an assert that every state and action dimension has a non-degenerate range, otherwise listed in `QUALITY.md` as "do not train"; units declared in `info.json` (match to `cube_to_bowl_5` UNVERIFIED); `modality.json` with `single_arm` 0-5, `gripper` 5-6, `annotation.human.task_description`.

Units: the simulator works in metres and radians, the spec in millimetres and degrees; the dataset's state and action units are declared in `info.json` after checking the value ranges of the GR00T demo dataset (export, issue #13). Frames: the world frame sits where the robot base meets the table (x away from the robot, y to its left, z up); an object frame sits at the object's centre with its yaw; via-points and `move_to` offsets name their frame.

`QUALITY.md` prints "N scripted, primitive-rendered episodes; a format-valid skeleton, not training data", the per-axis envelope, spec coverage by source, and "loader-validated with Isaac-GR00T" only if `validate_groot.py` ran. `ledger.json` holds measured tokens per model, Tavily credits, rollouts and seconds, priced from `/v1/models?verbose=true`; never a savings figure.

## 9. Model and service map

| Service / model | Role | Calls |
|---|---|---|
| `nvidia/Nemotron-3.5-Super-VL` | watches: segments, objects, symmetry, sizes from keyframes | 1 |
| `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | plays the robot: spec to program and `ask` slots; grounding filter; reactive turn (S) | 4-8 |
| `nvidia/nemotron-3-super-120b-a12b` | interviewer with chips; Saboteur; Notes patch | 5-9 |
| `nvidia/Nemotron-3-Ultra-550b-a55b` | failure classes, reshoot list, open risks; background | 1 |
| Tavily `search` + `extract` | hazards and preconditions with URLs, opt-in | 2 |
| Nebius Serverless Job (S) | GR00T loader validation of a real export | 0-1 |
| Vercel Blob (S) | video proxy only, deleted after Label | 0-1 |

Lightning is dropped: captions are templated, and four models with one visible job each read better than five. No Cosmos: none is hosted, and a self-hosted endpoint judging primitives adds cost, not evidence.

## 10. Architecture and repo layout

```
phone clip ─► Browser (Next.js 16 client, Vercel)
  ├─ <video> frames ─► MediaPipe ─► tokens, anchor, keyframes, montage ─► IndexedDB session
  ├─ Worker: MuJoCo WASM interpreter ◄── program, scenarios ──► joint logs ─► three.js, grid
  └─ parquet + mp4/webm + modality.json + ledger ─► zip
        │ Vercel routes (stateless, OpenAI SDK, base_url Token Factory; maxDuration 300; ?replay=1)
        │ /api/health label compile interview ground saboteur notes reshoot job(S)
        ▼
  Token Factory (4 Nemotron IDs from env)   Tavily   Nebius Serverless Job (S)
```

Repo: `app/` (`ssr:false` stage components, `api/*/route.ts`), `lib/vision`, `lib/spec` (Zod schema, predicate enum, `StageResult`, parse, prompts), `lib/sim` (worker, so101 with Menagerie LICENSE, ik, interpreter, predicates, render), `lib/export`, `lib/providers`, `jobs/validate_groot.py`, `tests/prompts/` recorded responses, `samples/`, `public/` self-hosted assets, `docs/`, `LICENSE` Apache-2.0.

## 11. Seven-day plan

The work is a task board, not a per-person table: every task below is a GitHub issue labelled `critical-path`, `parallel`, `words`, `video`, `stretch` or `review`, under a milestone per day. Nobody is assigned; anyone picks the top open critical-path issue. Cam carries most of the development; shared types (`lib/spec/schema.ts`, `lib/export/types.ts`) land first so parallel work does not collide. Deadline: Friday 30 October 2026, 10:00 PT = 18:00 Paris.
**Fri 23 (D1, setup and spikes)**
- CP: credentials in place; `curl /v1/models?verbose=true` confirms the four IDs
- CP: smoke tests against Super VL (keyframes + montage base64 with `json_object`; `json_schema`; `video_url`), Nano and Super (`reasoning_effort` vs `enable_thinking`, latency, `<think>` stripping, 400 behaviour) → results in `docs/FEEDBACK.md`; freeze the Label input path in `lib/providers/tokenfactory.ts`
- CP: frame sampler + MediaPipe pose and hand tokens on a sample clip, skeleton overlay
- CP: `@mujoco/mujoco` in a Worker: SO-101 scene and STLs into MEMFS, load, step, joints mirrored to three.js; confirm `mj_jacSite` is exported
- Scaffold, CI, docs, issues, Vercel deploy (me)
- Film the three clips; Devpost team; optional Discord question confirming sim-only Physical AI

**Sat 24 (D2, watch and label)**
- CP: tokens UI (chips timeline, anchor marker, person selection, hand-gap interpolation, 2D hands-only mode, touch task when no grasp)
- CP: keyframe and montage builder; `/api/label` with Zod validation, time clamping, size sanity (5 to 300 mm), replay fixtures
- CP: `lib/spec` schema, predicate enum, `StageResult`, lenient parse
- `lib/export` LeRobot v2.1 writer against fixtures (parquet, mp4, `modality.json`, `stats.json` assert)
- README skeleton; grounding prompt text

**Sun 25 (D3, compile, interview, sim go/no-go)**
- CP: `/api/compile` (Nano) with ten spec fixtures across domains; `ask` slots
- CP: `/api/interview` (Super) streamed with `changes[]`, chips, citation rule; IndexedDB session
- CP: scene builder from spec primitives (pocket, zone, stack); damped-least-squares IK on the SO-101 tip site with reachability pre-check; **18:00 go/no-go: physics stage or kinematic fallback**
- `jobs/validate_groot.py` as a Nebius Serverless Job (Python 3.12 image, lerobot 0.6.1, Isaac-GR00T loader)
- Devpost text draft

**Mon 26 (D4, rehearsal end to end)**
- CP: program interpreter (via-points per segment, sensed and blind modes, weld gate, predicates in order, agency rule); one rendered rollout; first end-to-end run recorded as fixtures; `?replay=1` live on the deployment
- `docs/LIMITATIONS.md`, prior art paragraph; run the three clips, file bugs
- Video storyboard and voice-over text; first screen captures

**Tue 27 (D5, saboteur, notes, grounding; 22:00 content freeze)**
- CP: `/api/saboteur` (Super) → 2x12 grid in the Worker; editable scenario offsets and re-run; `/api/notes` fail → patch → recompile → pass; `/api/ground` (Tavily + Nano filter) opt-in chips
- CP: end to end on the hero clip, ledger strip visible
- Devpost draft submitted; testing instructions; rough cut of the video

**Wed 28 (D6, export, hardening, video v1)**
- CP: `/api/reshoot` (Ultra) in the background; export wiring and zip; `/api/health`, replay banner, upload unlock code; deploy; secrets scan
- Stretch: reactive recovery turn (one Nano call on a mid-rollout predicate failure); `video_url` flag; validation job log in the README
- README and FEEDBACK final; video v1 recorded on the live path; YouTube unlisted

**Thu 29 (D7, fixes only)**
- Cross-browser pass (Chrome, Firefox, Windows); **Devpost submitted with a placeholder video by 12:00**, real link by evening; no deploys after 20:00
- Judge-access test from a second account on a clean browser; thumbnail, tags, Paris selected; video v2 public

**Fri 30**: link check by 16:00, hands off at 17:00.

Cut order if the schedule slips: reactive turn, `video_url` flag, validation job, IndexedDB resume, scenario editing, Notes loop, then physics (kinematic replay with claims removed).

## 12. Risks

1. **Label input:** the video proxy is the measured default (23 Oct: 30 s = 5,024 input tokens, 3.3 s); 7 keyframes plus a montage is the fallback when the browser cannot encode the proxy.
2. **MuJoCo WASM and IK:** assets loaded Friday; Sunday go/no-go; five-constraint IK with reachability pre-check; kinematic fallback with the physics wording removed.
3. **Structured output and thinking:** lenient parse only; `json_schema` per model after a passing test; 400 retried; `<think>` stripped.
4. **Clip variety:** codec reject with the fix; person selection; hand gaps; 2D mode; touch task; sample clip one click away.
5. **Judge access through 15 Dec:** live path for sample clips, health probe to replay, model IDs in env, about $20 balance, Nov 30 check.
6. **Schedule:** 58-hour path, Tuesday 22:00 content freeze, ordered cut list, video from captures as modules land.
7. **Track fit:** Physical AI committed; the closed loop (Nano compiles, MuJoCo executes under perturbation, Super patches, Nano recompiles, re-run) plus blind/sensed is the headline; Discord answer quoted.

## 13. Novelty claim

Every piece exists (MediaPipe; GPT-4V for Robotics, SeeDo, GF-VLA; MimicGen, DexMimicGen, GR00T-Mimic; IWSDS 2026, AmbResVLM; GR00T-Dreams, Nebius robot-sdg). New is the loop and its measurement: a cheap model plays the robot and its compile errors are the questionnaire; the answers become tolerance bands; a reasoning model turns bands into falsifying scenarios chosen from object symmetry; the simulator runs them blind and sensed, so the output is a perception requirement per axis, a spec with per-field provenance and a reshoot list on a GR00T-layout skeleton. The answers are the demonstrator's claims; the rehearsal checks whether a scripted program can honour them, not whether they are true. Limits: one 5-DoF arm plus gripper, geometric grasp, primitive objects, approximate calibration, a format-valid skeleton.

## 14. Three-minute demo video script

Recorded on the live path with the ledger strip visible; plain-text captions, no logos, no music.

- **0:00-0:15** Phone clip of a hand moving a tube into a rack. VO: the discard and re-collection numbers.
- **0:15-0:35** Clip in the browser; skeleton, chips, anchor marker. VO: "MediaPipe turns motion into tokens."
- **0:35-0:55** Labels land on chips; caption `nvidia/Nemotron-3.5-Super-VL` on Nebius Token Factory; ledger visible.
- **0:55-1:30** Nano's program with red `ask` slots; question one cites "aperture 61 mm at t=1.3 s"; a chip click flashes the changed path; an opt-in Tavily card. VO: "Nano plays the robot. What it cannot execute, Super asks the person who did it."
- **1:30-1:50** SO-101 runs the program with the via-point ghost line. VO: "Rehearsed on a real robot model in MuJoCo, in the browser."
- **1:50-2:25** 2x12 grid: blind row fails at 6 mm rack error, sensed row survives 25 mm. Edit a scenario, re-run: tube hits the pocket wall. Super proposes "raise the pre-insert via-point"; Nano recompiles; pass. VO: "Blind, four millimetres. With a pose estimate, the whole tray. That is the perception budget."
- **2:25-2:45** Ultra's reshoot list; the zip; Job log if produced. Caption `nvidia/Nemotron-3-Ultra-550b-a55b`.
- **2:45-3:00** Limits card; model credits.

## 15. Submission checklist

- **Track: Physical AI**, committed. "How it meets Physical AI": simulated SO-101 embodiment, the closed loop, blind/sensed, `wait_until` per step, GR00T-layout output.
- **README:** built-for line; architecture; which-model-does-what with exact IDs; the real `chat.completions.create` block; "Other Nebius services" (Job log or "none"); setup under ten commands; "Simulated versus real"; "Limitations and failure cases" with three documented failing rollouts; prior art; testing instructions (Chrome on a laptop; sample clips run live; the unlock code enables uploads).
- **License:** Apache-2.0 at root; Menagerie and MediaPipe notices; no CC-BY-NC components.
- **Feedback:** one block per tool (onboarding, Super VL, Nano, Super, Ultra, Tavily, Serverless Jobs): used for, worked, needs work, minutes to hello-world, build again; the v1 gap list plus Friday's findings.
- **Tavily bonus:** runtime `search` plus `extract` in `/api/ground`, request ids and credits in `grounding.json`, on screen.
- **Devpost:** What/Why/How; Built With tags for Token Factory, the four Nemotron models, Tavily, MuJoCo, MediaPipe, LeRobot, Next.js, Vercel; demo URL, repo, sample clips; not pre-existing; public YouTube under three minutes; secrets scan.

## 16. Self-scores

- **Technological implementation: 8.** Four Nemotron models with distinct inspectable jobs, physics in a Worker, via-points, blind/sensed evaluation; minus for the geometric grasp.
- **Design: 8.** One loop with defined failure states, resume, every number sourced, fail-patch-pass on screen.
- **Potential impact: 8.** The per-axis perception envelope is a number a QA desk acts on; the ledger is measured cost.
- **Quality of idea: 9.** "The robot's compile errors are the interview" plus blind versus sensed make perturbations measure the spec.
- **Feasibility: 8.** 58 hours on verified services, replay from Monday.

## 17. Alternatives considered

Unchanged from v1. v2 additionally rejected the full video pipeline through Blob (privacy, upload time, codec risk) in favour of keyframes, and a Python sweep (two implementations would diverge) in favour of one TypeScript interpreter and a validation-only Job.

## 18. Decisions taken (gib, 23 October 2026)

1. Track: Physical AI. 2. Name: Understudy. 3. Robot: SO-101 only. 4. Hero clip: a household stand-in for the lab task (a capped marker or small bottle from a tray into a cardboard rack with holes a few millimetres wider); secondary clips cup onto saucer and a small box onto a shelf; the product stays task-agnostic (section 3). 5. Tavily: yes, opt-in chips. 6. City award: Paris. 7. AI Cloud: the validation job only (about $15), or an honest "none" in the README. 8. Ultra: yes, in the background. 9. License: Apache-2.0. 10. Team: a task board, no per-person assignment; Cam carries most of the development. 11. Reactive turn and the video flag: Wednesday stretches. 12. Balance: about $20 top-up, auto top-up off. 13. Headline (24 Oct): civil space (stations, lunar), with one sentence on satellite servicing; orbit mode (gravity as a scenario axis) is the differentiator; the name stays Understudy; the hero clip is NASA public-domain footage of an astronaut placing seed film into the plant pillows of the ISS Veggie facility (`samples/iss-veggie-seed-film.mp4`, 36 s); the household clips become the secondary clips.

## 19. First 24 hours

1. **09:00** Skills call; tracks assigned; filming settings to Leah; Cam's Python answer decides the Job.
2. **09:30** Token Factory sign-up with card; key into `~/.config/nebius-cli/accounts.ini` (chmod 600); promo code via Top up; Builder Program; credit expiry noted. AI Cloud project; service-account file to Cam.
3. **10:00** `curl /v1/models?verbose=true` for the four IDs. Against Super VL, with any public MP4: (a) keyframes + montage as base64 `image_url` with `json_object`, (b) `json_schema`, (c) `video_url`; the first pass becomes the default. Against Nano and Super: `reasoning_effort: none` versus `enable_thinking: false`, latency, `<think>`, 400 behaviour. Results into `docs/FEEDBACK.md`.
4. **12:30** Freeze the Label input and parse path in `lib/providers/tokenfactory.ts`.
5. **13:00** Scaffold; Apache-2.0; `.env.example`; public repo; Vercel env; publish `schema.ts` and `export/types.ts` (episode record: timestamps, positions, commands, scenario, mode, pass).
6. **14:30** `<video>` frame sampler deployed; upload → `/api/label` → raw segments.
7. **18:00** `@mujoco/mujoco@3.17.0` in a Worker; SO-101 STLs into MEMFS; load, step once; confirm `mj_jacSite` and `eq_active`.
8. **Evening** Push, deploy, verify from a clean browser.

## 20. Changes from v1

Critics: S schedule-breaker, G stage-one-gatekeeper, R robotics-skeptic, D demo-day-saboteur; c critical, m major, n minor.

| Finding | Change |
|---|---|
| 90 h path, no prompt hours, visual layer unscheduled (S c, m, m) | 58 h path with prompt hours; piano roll, trails, gauges, sliders, diff flash, transcode, Lightning cut; §5 reduced; cut list in §11 |
| Video not recordable by day 6; buffer misplaced (S c, n) | Content freeze Tue 22:00; captures as modules land; placeholder submission Thu 12:00 |
| Label and JSON paths unverified (S c; G n; D m) | Friday-morning tests; keyframes+montage default, `video_url` a flag; lenient parse only |
| Rehearsal too big, 6D IK stalls; weld trivial; anchoring fragile (S c; R m, m, n) | §7: five-constraint IK, reachability pre-check, meshes kept, STLs Friday, geometric weld gate, insertion failure, anchor with confidence |
| Export MP4s unscheduled; degenerate dims; captions (S m; D n; R m) | §8: episode record Friday, four episodes, codec probe, non-degenerate assert, one instruction per task |
| Leah's Tavily route live; grounding junk (S m; D m) | gib writes `/api/ground`; allowlist dropped; Nano filter; opt-in chips; never blocks |
| iPhone HEVC/MOV; raw file to Blob; private video public (S m; D c, m, n) | H.264 only, filming instruction, `<video>` decoding, reject message; no upload by default; flag proxy deleted |
| Cam's Python track; two interpreters; Friday ordering (S m, n; R n) | Skills call first; sweep and REST job cut; file Job with Monday stop; gib creates the AI Cloud project |
| Main thread blocked; cold start (S m; D m, m) | Worker from Sunday, sequential rollouts; lazy loading, self-hosted assets, progress bar |
| Rate limit impossible; DEMO_MODE bypasses the runtime call; December drift (S n; D m, c; G m, n) | Live path default for sample clips, ledger visible; code for uploads only; bounded balance; replay from Monday, `/api/health`, IDs in env, Nov 30 top-up |
| Track hedged; agent runtime thin (G m; R n) | Physical AI committed; Discord question Friday; closed-loop headline; reactive turn as stretch |
| Credits, trademarks, thinking toggle (G n) | Expiry recorded; text captions; both toggles tested |
| Grid cannot falsify; trajectory unused; insensitive axes (R c, m, m) | Sensed and blind modes, `pose_noise_mm`, perception-budget headline; via-points from pose; axes from symmetry, envelope per axis |
| Questionnaire feel; Notes frames; Ultra classes (R n) | Questions cite a measurement; Notes text-only; "simulator artefact" class |
| No failure states; pose or grasp missing; long calls (D c, c, c, n) | `StageResult<T>`; 2D mode, touch task, VL seeds GRASP; `maxDuration` 300, streaming, `max_tokens`, Ultra in background, `changes[]` |
| Multiple people; hand drops; refresh; mobile; VL sanity (D m, m, m, n, n) | `numPoses: 3`, wrist-matched hands, interpolation; IndexedDB resume; stacked layout; clamps and warnings |

## 21. Accepted risks

- **MediaPipe on the main thread.** Playback paces inference and `requestVideoFrameCallback` yields between frames; a worker costs two hours needed elsewhere. A two-minute clip may take two minutes on an integrated GPU.
- **No hand ROI crop, no click-to-switch person.** Interpolation, the pose fallback and the largest-torso rule cover the hero clips; the crop is added only if the hero clip loses over 30 percent of hand frames.
- **Soft rate limiting only.** Sample clips run live without a code, so a bot could drain the $20 balance before judging; the health probe then shows the replay and the Nov 30 check tops up. A hard per-IP limit needs a store this app lacks.
- **Export renders on the main thread** after the grid, behind a progress bar.
- **Safari, Windows and phones** are not verified for the stage; "Chrome on a laptop" is stated.
- **Five interview groups stay fixed;** the citation rule and compile-driven slot selection make the questions clip-specific.
- **No batch sweep on AI Cloud.** It went with the Python interpreter; the AI Cloud story is the validation Job or an honest "none".
- **Thinking on Super VL.** If `enable_thinking` passthrough fails, Label runs with default thinking under a `max_tokens` budget.
- **Scene file and binding exports** come from the critic's read of the sources (UNVERIFIED by us), confirmed in Friday's spike.

## 22. How it improves: baseline, iterations, playbook, sweep

Decided 23 October after the first review of the pitch: a judge needs to see a curve, not a single fail-patch-pass moment, and a credible account of what "learning" means here.

**Iterations on one clip (issue #55).** The same 12 scenarios, sensed and blind, run after every version of the program. Iteration 0 is the standard approach, the program compiled from the raw label with defaults and the via-points straight from the human trajectory: retarget and replay. Iteration 1 is after the interview. Iteration 2 and later follow each Notes patch. Every iteration records its pass count out of 24, its perception budget per axis, its tokens and seconds, and the changes that produced it, in `understudy/iterations.json` and in `QUALITY.md`. The stage shows one bar per iteration, sensed and blind stacked. This is the measurement of "improved compared to the standard": same clip, same rollouts, three numbers.

**Learning across clips (issue #56).** Each patch that turned a failing scenario into a passing one becomes a playbook rule: fixture type, failure class, axis, the condition it applies under, the patch, and the evidence (clip, scenario, before and after). The compile step for the next clip receives the matching rules, so its iteration 0 starts higher; the program marks what it applied with `source: playbook#<id>`; the UI lists rules with their evidence and lets the user disable one. The three sample clips run in sequence in the video so the third clip's starting score is visibly higher than the first's. Rules are inspectable text, not weights; the README says so.

**Search instead of guesswork (issue #57, stretch).** Super proposes five candidate patches for the worst failure; a Nebius Serverless Job runs the same TypeScript interpreter under Node with MuJoCo across all 24 rollouts per candidate and returns the ranking; the best candidate becomes the next iteration. This is the project's Nebius AI Cloud usage and a genuine fit for the Physical AI track (simulation at scale off the browser). It falls back to the single-patch loop.

**The honest reinforcement story.** No policy is trained in this week and the README says so. The loop is closed-loop optimisation with the simulator as the reward signal and the model as the policy editor, and the exported episodes carry pass and fail labels per scenario, which is the success signal a reinforcement or imitation fine-tune needs later.

