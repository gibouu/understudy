# Understudy: plan for the Nebius x NVIDIA Global AI Hackathon

## Context

gib's idea: turn ordinary footage of a person doing a task into a quality instruction set and training data for robots, cheaper than the data-collection centres that film humans at scale and never analyse the footage deeply. Input a human video, show the motion as tokens and articulations, let the AI ask what is really happening, then test the result for a robot in a simulated "animatronics" stage.

Deadline: **Friday 30 October 2026, 10:00 PT = 18:00 Paris** (seven days from today, Friday 23 October). Team: gib, Cam (main developer, TypeScript and Python), Leah. No physical robot. No Nebius or Tavily credentials yet.

A 20-agent planning workflow ran today (5 researchers, 5 designers, 4 judges, synthesis, 4 critics, hardening). Everything below uses only model IDs, packages and services it verified against live pages today, re-checked by hand for the two youngest facts. The full spec v2, research digests, judge scores and critic findings sit in the session scratchpad under `wf/` and get copied into the repo's `docs/` on day one.

Decisions already taken by gib (23 Oct): track **Physical AI**; city award **Paris**; hero clip is a **household stand-in for "capped tube into a rack"** (no lab access); the product must stay **task-agnostic**; no per-person assignment, a **task board** instead, Cam carries most of the development.

## The product in one paragraph

**Understudy** (an understudy learns a role by watching the lead, then rehearses it on stage). One phone clip of a person doing a tabletop task becomes: (1) motion tokens drawn over the video, (2) a task spec labelled by Nemotron 3.5 Super VL, (3) a robot program compiled by Nemotron 3 Nano whose compile errors ("I cannot execute this step without knowing X") become the interview that Nemotron 3 Super runs with the person who did the task, (4) a rehearsal of that program by a simulated SO-101 arm in MuJoCo, in the browser, under twelve perturbation scenarios written by Super, each run **blind** (nominal object pose) and **sensed** (perturbed pose known), which yields one new number per axis: how much pose error the task tolerates, i.e. the **perception budget**, (5) a reshoot list and risk notes from Nemotron 3 Ultra, and (6) a downloadable LeRobot v2.1 dataset skeleton in the exact layout GR00T N1.7 reads, with a quality report that says plainly what it is and is not.

Why a judge should care: collection is cheap and industrialised (Micro1 at about $15/h, Mecka, Scale, Figure); the waste is after collection: 20 to 30 percent of demos discarded, re-collection 30 to 50 percent of a campaign budget. Nobody asks the person who did the task, and nobody tests a task before buying 500 repetitions. Understudy is the briefing and QA layer in front of collection.

## What is verified (23 Oct 2026)

| Piece | Verified fact |
|---|---|
| Token Factory | `https://api.tokenfactory.nebius.com/v1`, OpenAI SDK with `base_url`, `image_url` and `video_url` content parts, `response_format` json_schema, dynamic rate limits (about 60 RPM / 400k TPM baseline), prefix caching |
| NVIDIA models hosted | `nvidia/Nemotron-3.5-Super-VL` (image + video, released 15 Oct), `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, `nvidia/nemotron-3-super-120b-a12b`, `nvidia/Nemotron-3-Ultra-550b-a55b`, `nvidia/Nemotron-3_5-Lightning`. No Cosmos, no GR00T on Token Factory |
| Credits | promo code `NEBIUS-DEVPOST-GLOBAL26` ($25 Token Factory) + Builder Program at dev.nebius.com/builders ($25 Token Factory + $25 Tavily); $1 trial; card required |
| Nebius AI Cloud | Serverless Jobs / Endpoints / Devlab, any container, L40S $1.35/h, H100 $4.50/h; account charges $25 to the card as balance |
| Simulator | `@mujoco/mujoco` 3.17.0, official DeepMind WebAssembly bindings, published 22 Oct 2026, Apache-2.0, single-threaded build needs no COOP/COEP; MuJoCo Menagerie `robotstudio_so101` (Apache-2.0) with `scene.xml` |
| Pose | `@mediapipe/tasks-vision` 1.1.1 (Apache-2.0): Pose 33 landmarks + Hand 21 per hand with world coordinates, VIDEO mode |
| Export | LeRobot v2.1 + `meta/modality.json` is what Isaac-GR00T N1.7 reads; its demo `cube_to_bowl_5` is an SO-101 (`so101_follower`, 6 floats `shoulder_pan.pos` to `gripper.pos`) |
| Rules | Nebius FAQ: simulation instead of a robot is allowed for Physical AI; "runs on Nebius" = a runtime Token Factory call or AI Cloud compute; the rest may live on Vercel; calling NVIDIA models via other hosts is disallowed |

## Input to output contract

**Upload:** one H.264 MP4, 10 s to 2 min, one person, one tabletop task, fixed phone, side or front view. HEVC/MOV rejected with the iPhone fix printed ("Settings > Camera > Formats > Most Compatible") next to "Try a sample clip". Frames decode in the browser; only 12 to 16 JPEG keyframes plus one montage (under 1 MB) leave it, inside the Label request, stored nowhere. No account. Session persists in IndexedDB keyed by the clip hash.

**Download:** `understudy-<slug>.zip` with `lerobot/` (v2.1 layout, up to four passing episodes, `so101_follower`, `modality.json`, `tasks.jsonl`, `episodes.jsonl`, `stats.json`) and `understudy/` (spec with per-field provenance, program, interview transcript, rehearsal report with the per-axis envelope, reshoot list, cost ledger, grounding sources, warnings, `QUALITY.md`, keyframes, pose, tokens).

**Spec schema (Zod):** `objects[{name, shape: cylinder|box|sphere, size_mm, symmetry, source}]`, `steps[{verb, object, target{fixture: pocket|zone|stack, frame}, via_points[{frame, xyz_mm, source}], preconditions[], success[predicate], tolerances{axis: band_mm}, source}]`, `anchor{t_s, confidence}`, `warnings[]`, `open_questions[]`. Every field carries a `source` (`vl#seg1`, `interview#2`, `pose#seg1`, `tavily:<url>`).

## Pipeline

| # | Stage | Where | Model | What |
|---|---|---|---|---|
| 1 | Watch | browser | MediaPipe | `<video>` + `requestVideoFrameCallback` at 10 fps / 640 px; Pose (`numPoses: 3`, largest torso) + Hands matched to wrists; gaps under 0.5 s interpolated; tokens; grasp anchor at the wrist-speed minimum; keyframes + montage |
| 2 | Label | `/api/label` | `nvidia/Nemotron-3.5-Super-VL` | keyframes + montage as base64 `image_url` with timestamps, JSON output: segments, objects, shape, size, symmetry, fixture relation per step. `video_url` of a 720p proxy only behind a flag that passed Friday's test |
| 3 | Compile | `/api/compile` | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | spec → program: `move_to(frame, offset, approach)`, `grasp(aperture)`, `release`, `wait_until(pred)`, `assert(pred)`, and `ask(question)` slots for what it cannot execute; reruns after every interview turn |
| 4 | Interview | `/api/interview` | `nvidia/nemotron-3-super-120b-a12b` | streamed `{question, chips, why, done, changes[]}`; only `ask` slots are asked; each question cites a measurement from this clip (aperture at t, offset, keyframe); groups: tolerances, grasp, success criteria, hazards, recovery; "I don't know" widens the band; ends at zero slots, seven turns, or "Rehearse now" |
| 5 | Ground | `/api/ground` | Tavily `search` + `extract`, Nano filter | hazards and preconditions with URLs as opt-in chips; 6 s budget; never blocks |
| 6 | Saboteur | `/api/saboteur` | Super | 12 perturbation scenarios with expected outcomes, axes chosen from object symmetry and the tightest constraint (pocket clearance, pose error, tilt, obstacle) |
| 7 | Rehearsal | Web Worker | MuJoCo WASM + three.js | reachability pre-check, then 12 × {sensed, blind} rollouts; grasp is a geometric weld gate (pads within tolerance of the object and aperture inside [size−δ, size+δ]); closed predicate enum (`contact_both_pads`, `height_above`, `inside_zone`, `no_collision`, `tilt_under`, `gripper_within`, `object_still`, `time_under`) |
| 8 | Notes | `/api/notes` | Super → Nano | worst failure as text → one `changes[]` patch → recompile → re-run (the fail, patch, pass moment of the video) |
| 9 | Reshoot | `/api/reshoot` | `nvidia/Nemotron-3-Ultra-550b-a55b` | failure classes (spec gap, footage gap, embodiment limit, simulator artefact), reshoot list, open risks; runs in the background; export never waits more than 90 s |
| 10 | Export | browser | parquet + mp4 writers | episodes at 480x360 15 fps, `modality.json`, templated captions, non-degenerate-range assert, ledger, zip |
| 11 | Validate (stretch) | Nebius Serverless Job | Python 3.12 + Isaac-GR00T loader | loads a real export; log goes in the README as the AI Cloud usage |

Every stage returns `StageResult<T>` (`idle | running | done{value, warnings} | failed{message}`) with Retry, Skip and Use-sample. `/api/health` (a 5-token Nano call + `GET /v1/models`) flips the page to replay mode with a banner if credits or a model ID are gone, so the demo URL keeps working through judging in December. About 18 requests and under $0.10 per session.

## Task-agnostic by construction

- The code never names a task. The VL labels each object as a primitive (cylinder, box, sphere) with a size and symmetry, and each step's target as one of three **fixtures**: `pocket` (insertion: rack, holder, carton, connector), `zone` (placement on a surface area: saucer, shelf, bin), `stack` (on top of another object). Anything else degrades to `zone` with a warning.
- The scene builder makes MuJoCo primitives from that: a pocket is a box with a hole of the labelled clearance; the perturbation axes follow from the fixture and symmetry (yaw dropped for symmetric objects, clearance and pose error for pockets, tilt for stacks).
- The interview questions come from compile `ask` slots, not a fixed questionnaire, so the hero clip and the cup clip get different questions.
- Three sample clips ship with the app and prove it: **marker or small bottle from a tray into a home-made cardboard rack** (the lab stand-in: cylinder into a hole a few millimetres wider), **cup onto saucer** (zone), **small box onto a shelf or stack** (stack). The pitch names the industries the same number serves: lab automation, food packaging, electronics insertion, kitting and pharmacy.

## Architecture and repo layout

```
phone clip ─► Browser (Next.js 16 client on Vercel)
  ├─ <video> frames ─► MediaPipe ─► tokens, anchor, keyframes, montage ─► IndexedDB session
  ├─ Web Worker: MuJoCo WASM interpreter ◄── program, scenarios ──► joint logs ─► three.js stage + 2x12 grid
  └─ parquet + mp4 + modality.json + ledger ─► zip
        │ Vercel route handlers (stateless, OpenAI SDK with Token Factory base_url, maxDuration 300, ?replay=1)
        │ /api/health label compile interview ground saboteur notes reshoot
        ▼
  Nebius Token Factory (4 Nemotron IDs from env)      Tavily      Nebius Serverless Job (validate, stretch)
```

`app/` (pages, `api/*/route.ts`, stage components with `ssr: false`), `lib/vision` (sampler, MediaPipe, tokens, anchor, keyframes), `lib/spec` (Zod schema, predicate enum, `StageResult`, lenient JSON parse, prompts with examples from several domains), `lib/sim` (worker, SO-101 assets with the Menagerie license, IK, interpreter, predicates, scene builder, render), `lib/export` (LeRobot writer), `lib/providers/tokenfactory.ts`, `jobs/validate_groot.py`, `tests/` (vitest + recorded prompt fixtures), `samples/` (three clips), `public/` (self-hosted MediaPipe and MuJoCo assets), `docs/` (SPEC, PLAN, SCRIPT, SUBMIT, FEEDBACK, LIMITATIONS, STAGE runbook), `LICENSE` Apache-2.0, `.env.example`, `AGENTS.md` + `CLAUDE.md` stub.

Stack: Next.js 16 app router on Vercel, TypeScript, pnpm, `openai` SDK (or AI SDK with the OpenAI-compatible provider) pointed at Token Factory, `@mediapipe/tasks-vision` 1.1.1, `@mujoco/mujoco` 3.17.0, `three`, `hyparquet-writer`, `mediabunny`, `zod`, `vitest`. Python only in `jobs/`.

## Alternatives considered (from the five-concept panel; judges' aggregate in brackets)

- **Innovator [145, winner]**: compile-errors-as-interview, blind vs sensed perception budget, model-written saboteur. Adopted as the spine.
- **Storyteller [145, tied]**: design backwards from five video moments (tokens blooming, a question changing the spec live, the robot rehearsing, the grid lighting up, fail → patch → pass). Grafted into the visual layer and the video script.
- **Ship-it realist [143]**: kinematic replay only, no physics. Kept as the Sunday 18:00 fallback: if MuJoCo WASM is not stepping the SO-101 by then, the stage replays via-points kinematically and every physics claim is removed.
- **Judge-maximizer [140]**: a fifth model (Lightning) for live captions. Cut: four models with one visible job each read better than five.
- **Business-builder [140]**: an on-screen savings calculator. Cut the savings figures (unsourceable); kept a measured cost ledger per session priced from `/v1/models?verbose=true`.
- Other calls: **SO-101 arm, not a humanoid** (matches the GR00T demo layout, 5 DoF + gripper, honest via-point replay instead of full-body retargeting); **keyframes, not the whole video, to the VL** (privacy, upload time, codec risk; `video_url` behind a flag); **one TypeScript interpreter, not a second Python sweep on AI Cloud** (two implementations would diverge; AI Cloud usage is the validation job or an honest "none"); **no Cosmos** (nothing hosted; a self-hosted critic of primitive renders adds cost, not evidence).

## Honesty line (goes in the README and the video)

A pass proves the clarified spec is executable by a scripted SO-101 program across the stated band in rigid-body physics with a geometric grasp, and that the success criteria are computable. It does not prove a learned policy would succeed or that a real grasp holds. The export is a format-valid skeleton for GR00T's loader, not training data. Limits: one 5-DoF arm plus gripper, geometric grasp (no friction), primitive objects, approximate sizes from a monocular clip.

## Execution plan: what happens right after approval

1. **Repo**: create public `gibouu/understudy` with Apache-2.0, description and topics; add `leahsouci`, `camcunningham`, `camcunninghamdd` as collaborators with push access; branch protection light (PR + green CI, squash merge, no direct push to main).
2. **Scaffold**: Next.js 16 + TypeScript + pnpm, the folder layout above, `.env.example` (`NEBIUS_API_KEY`, four model-ID vars, `TAVILY_API_KEY`, `UNDERSTUDY_UNLOCK_CODE`), vitest, GitHub Actions (`runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}`, concurrency with cancel-in-progress, timeout) running lint, typecheck, tests; `AGENTS.md` with the project section and the canonical block, `CLAUDE.md` stub.
3. **Docs**: `docs/SPEC.md` (spec v2 adapted to the household stand-in and the fixture vocabulary), `docs/PLAN.md` (this plan), `docs/SCRIPT.md` (video script), `docs/SUBMIT.md` (Devpost fields, feedback template, checklist), `docs/LIMITATIONS.md`, `docs/STAGE.md` (demo runbook), `README.md` skeleton in the house style (one-line pitch, what-it-does table, mermaid architecture, which model does what with exact IDs, setup under ten commands).
4. **Task board**: one GitHub issue per task below, labels `critical-path`, `parallel`, `words`, `video`, `review`, `stretch`, a milestone per day, and a pinned tracker issue; nobody assigned, anyone picks.
5. **Vercel**: link the project, set env placeholders, deploy the skeleton so a URL exists on day one.
6. **Build the critical path in order**, each piece as a short branch + PR with a Codex read-only review before merge (AGENTS.md §4b), replay fixtures recorded as soon as a stage works so the app demos without credits.

Things only gib can do (accounts, payment, devices): Token Factory sign-up with a card, redeem the promo code and join the Builder Program (Tavily key), create the AI Cloud project; keys into `~/.config/nebius-cli/accounts.ini` (chmod 600) and into Vercel env; add the teammates to the Devpost team; film the three sample clips (H.264 "Most Compatible", 1080p30, fixed phone, side view, 20 to 40 s, three takes each); choose the YouTube account.

## Task board by day (critical path marked CP; deadline Fri 18:00 Paris)

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

## Risks and mitigations

1. **Label input unverified** (video tokens, image limits): Friday-morning tests decide; keyframes + montage is the default, `video_url` only behind a passing flag.
2. **MuJoCo WASM is a one-day-old WIP package**: assets loaded on Friday, Sunday go/no-go, kinematic fallback with the physics wording removed.
3. **Structured output and thinking toggles**: lenient parse (strip `<think>`, first balanced JSON object, Zod with coercion and warnings), 400 retried without optional parameters, previous spec kept on a second failure.
4. **Real phone clips** (HEVC, portrait, several people, lost hands): codec reject with the fix, rotation via the video element, largest-torso selection, interpolation, 2D mode, touch task, sample clip one click away.
5. **Judge access until 15 December**: live path for sample clips, health probe to replay, model IDs in env, about $20 balance with auto top-up off, a 30 November check.
6. **Track fit at stage one**: Physical AI committed; the closed loop (Nano compiles, MuJoCo executes under perturbation, Super patches, Nano recompiles) plus blind vs sensed is the headline; `wait_until` reads sim state every step.
7. **Two developers on one critical path**: gib and Cam split by module boundary (vision + API routes vs sim worker + export), shared types published first (`lib/spec/schema.ts`, `lib/export/types.ts`), every PR reviewed by Codex before merge.

## Verification

- Unit tests (vitest): spec parse and coercion, predicate evaluation, IK convergence on known poses, via-point transforms under perturbation, LeRobot writer output validated against the `cube_to_bowl_5` field names, `stats.json` non-degenerate assert.
- Recorded prompt fixtures for every route so `?replay=1` runs the whole app offline and CI never spends credits.
- End to end on the three sample clips against the **live Vercel URL** from a clean browser (not local), with the ledger showing real Token Factory usage.
- The validation job's log proves the export loads in Isaac-GR00T's loader (or the README says "none" for AI Cloud).
- Codex read-only review on every non-trivial PR (AGENTS.md §4b); findings fixed or answered.
- Visual review in the app's browser pane after each stage lands (no annotation tooling).
- Submission checklist in `docs/SUBMIT.md` ticked: license visible in About, README highlights the four models and Token Factory, public YouTube link under three minutes, demo URL, repo URL, feedback section, Paris selected, secrets scan clean.

## Budget

Token Factory about $50 in credits (a session costs under $0.10); Tavily $25 in credits; Nebius AI Cloud about $15 of the $25 balance for the validation job (zero if cut). No other spend.
