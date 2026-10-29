# Measurements

What Understudy does today, measured on 25 October 2026 (section 10 on 26 October) rather than estimated. Every number below comes from a script or a test in this repository, and its raw output sits in `bench/results/`. The commands to reproduce each one are at the end.

Machine for the local runs: Apple M4, Node 24, one thread, MuJoCo WebAssembly 3.17. Model calls: Nebius Token Factory at the list prices saved in `tests/fixtures/models.json` on 23 October 2026. Spend for every paid call is logged in `bench/results/ledger.jsonl`, with a hard cap of US$90.

## Headline numbers

| What | Measured | Section |
|---|---|---|
| One full session on Token Factory | 16.7 calls, 51k tokens, US$0.0375 (US$0.028 to US$0.052 over 3 runs), 71 s | 1 |
| Hands found on the gloved, far-camera ISS clip | 149 of 360 frames from wrist crops; 0 before | 2 |
| Arm accuracy | median tip error 0.27 mm, max 1.9 mm, over 436 targets | 3 |
| Rehearsal speed, headless | 24 rollouts per gravity, all 12 scenario worlds, in 0.3 s in node (a fixed 3 s move per rollout, scene build included); about a second per 24 on the page's clock, running the real programs | 3 |
| A tube let go at the slot mouth | seats on Earth, Mars and the Moon; floats 30 mm up in orbit, indefinitely | 4 |
| Lateral push that topples a standing tube | 1.59 m/s² on Earth, 0.27 m/s² on the Moon | 4 |
| Liquid model against physics | drain time within 2.8% of Torricelli's law; surface tilt within 0.09° of atan(a/g) | 5 |
| Interview recovering missing details | 21% with the first design, 43% with a separate answer-to-change call | 7 |
| Failing rehearsals fixed from simulator notes alone | 69% (Super), 94% (Super with reasoning, or escalating to it when stuck) within 5 patches | 8 |
| Learning across tasks, Moon and orbit | rules learned on Earth and Mars add 28 points of first-try success with the cheap model (5% to 33%) and 18 with reasoning (48% to 67%), against matched controls; no measurable change within five patches. On the site's own compile (four NASA pocket clips, Nemotron 3.5 Lightning) the playbook does not carry over: first try 0 of 32 with the rules learned on the other clips, against 6 of 32 for the matched control (-19 points) and 8 of 32 with it off | 8 |
| Retarget-and-replay baseline against the last recorded version, 24 rollouts per gravity | Earth: as good or better on 3 of the 5 NASA manipulation clips; orbit: behind on all 5 (3 against 15 of 24 on the seed film) | 17 |
| Pouring with a real liquid model | far harder to fix than beads (48% against 88%), and pouring in orbit turns out feasible | 8 |
| Nemotron against other models on Token Factory | patching: Super with reasoning 94%, gpt-oss-120b 92% at under half the cost per fix, Muse Spark 100%; Super with reasoning off 69% against Qwen3.5 397B's 87%. Compiling: Nano's first program clean in 55 to 70% of compiles, the same-size Qwen3 30B's in 98%. Video: of the eleven models we tried, only Super VL and Muse Spark read it, Super VL at a third of the cost | 10 |

## 1. What a session costs

`scripts/bench-session.mjs` runs one session's model calls against Token Factory: Super VL labels the 36 s ISS clip, Nano compiles, Super interviews (up to 5 questions, canned answers) with a Nano recompile after each answer, Super writes the perturbation scenarios, Super patches one failure and Nano recompiles, Ultra writes the reshoot list. The routes are not built yet, so the prompts are prototypes of realistic size and shape.

| Stage | Model | Calls | Cost | Latency |
|---|---|---|---|---|
| Label | Super VL | 1 | US$0.0022 | 2.9 s |
| Compile (first, then after each answer) | Nano | 5.3 | US$0.0017 | 24.6 s |
| Interview | Super | 5.3 | US$0.0037 | 7.1 s |
| Saboteur | Super | 1 | US$0.0014 | 4.3 s |
| Notes (patch, recompile) | Super, Nano | 2 | US$0.0011 | 6.8 s |
| Reshoot | Ultra | 1 | US$0.0274 | 24.9 s |
| **Session** | | **16.7** | **US$0.0375** | **71 s** |

Ultra's reshoot list is 73% of the cost and most of its variance (4.6k to 10.1k reasoning tokens). No call returned an error or invalid JSON, and none came back empty apart from the 5-token health probe, which Nano spends on reasoning. Found on the way: the saboteur sometimes wrote 5 scenarios instead of 12 and twice left gravity out; Nano with thinking off sometimes compiled a program without its `ask` slots.

## 2. Hands on far, gloved footage

`scripts/bench-hands.mjs` runs the watch page headless on every frame at 10 fps. The full-frame Hand Landmarker finds no hand on the ISS clip: the hands are about twenty pixels wide and gloved. A sepia-toned crop around each wrist (PR #62) finds them.

| Clip | Frames | Hands from a wrist crop |
|---|---|---|
| ISS seed film, gloved, far camera | 360 | 149 |
| ISS chess, bare hands, near camera | 301 | 0 (the full frame finds them) |

## 3. The arm and the rehearsal speed

`tests/measure/arm.test.ts`.

- **Accuracy.** Over 436 solved targets on a 25 mm grid at three heights, the tip lands at a median 0.27 mm from the target, 0.84 mm at the 95th percentile, 1.88 mm at worst, checked by independent forward kinematics. A reachable target solves in 0.1 ms.
- **Reach.** Top-down grasps reach 56 to 58% of a 30 by 50 cm table grid at 2 cm height and none at 12 cm; side grasps reach 3% at most, because the wrist has no yaw.
- **Misses.** A target the arm cannot reach costs 65 to 90 ms, because the solver tries all 82 starting poses. Beyond 0.47 m from the pan joint, the length of the whole chain, no pose can reach. There the solver skips the starts that differ only in wrist roll, a third of the work, and the shortfall it reports moves by at most 1.8 mm (816 such targets). Stopping a search once its error stopped improving was tried and dropped: it lost 5 of 841 reaches on a wider grid. The two isolated holes on the centre line, (0.10, 0, 0.06) m from the top and (0.25, 0, 0.12) m from the front, are joint limits, not the solver. 3,000 random starts found no solution for either, and the best ones sit at the wrist-flex limit (+1.66 rad) and the elbow limit (+1.69 rad).
- **Speed.** A 3 s rollout of the arm in the demo scene takes about 5 ms. All 24 rollouts of one gravity, with the 12 scenario worlds compiled, take 0.28 s on Earth, 0.28 s on the Moon and 0.25 s in orbit, about 250 times real time, in node, scene build included. Each is a fixed 3 s move to an IK pose 50 mm above the pocket, with no interpreter, grasp or success check. On the page the grid's line says about a second per 24 (1.1 to 1.3 s for the seed film, 29 October): a different workload, the clip's real program with its grasps and checks, in the browser's worker, which hands control back between rollouts and posts each result; loading the engine and the meshes is not on that clock. Played visibly in the browser at real time the same grid takes 72 s per gravity, so the fast path needs a headless batch mode in the worker.
- **Scenarios.** All 12 perturbation scenarios build and load next to the arm; 11 change the world measurably; the twelfth, a yaw on the symmetric tube, is flagged as a no-op.
- **Tilts.** A tilted object is raised until its lowest point is where it stood untilted. Before this fix, the rack tilted 5° started 2.54 mm inside the table, and the tube tilted 8° 0.7 mm inside; the tilt runs in `bench/results/arm-scenario-coverage.json` predate the fix.

## 4. Gravity, pouring and motion

`tests/measure/gravity.test.ts`, rigid bodies and a particle stand-in for liquid in MuJoCo, at Earth (1 g), Mars (0.379 g), the Moon (0.1654 g) and orbit (0 g). One rule explains most results: with gravity above zero, a released object follows the same path at every gravity, only on a slower clock (times scale as 1/√g). Gravity changes the outcome through what does not scale with it: a residual hand-off velocity, a motion of fixed duration, a vehicle's acceleration, and at 0 g the absence of any force that settles things.

| Measurement | Earth | Mars | Moon | Orbit |
|---|---|---|---|---|
| Tube released with a 5 mm/s hand-off error, displacement after 2 s | 0.09 mm, resting | 0.12 mm | 0.16 mm | 10 mm, still moving |
| Tube let go at the slot mouth, 30 mm above the pocket floor | seated in 0.074 s | 0.120 s | 0.184 s | never: floats 30 mm up |
| Tube held until seated | seated | seated | seated | seated |
| Lateral offset that still seats in a 3 mm clearance (stiff contacts) | 1.5 mm | 1.5 mm | 1.5 mm | none |
| 80 water-density beads poured 80 mm across and 60 mm down | 100% land, 90% by 1.40 s | 100%, 1.58 s | 100%, 1.85 s | 0% land |
| Lateral push that topples a standing 17 by 100 mm tube | 1.59 m/s² | 0.61 m/s² | 0.27 m/s² | |

In orbit, 0.02 g of thrust toward an open cup's base empties all 80 beads in 3 s; the same thrust sideways loses none from a 50 mm cup. MuJoCo's soft contacts make some quantities look gravity-dependent when they are not; the table uses stiff contacts where that matters, and the pour's "time to stop moving" is left out because it varies by seed.

## 5. The liquid model

MuJoCo models drag from a surrounding medium, not a liquid you can pour. `lib/sim/fluid.ts` is a position-based fluid solver (Macklin and Müller, 2013) in TypeScript, one-way coupled to MuJoCo through `lib/sim/fluid-mujoco.ts`: it reads the cup's walls from MuJoCo every step and takes gravity from the same setting. It runs in the browser worker and in Node. `tests/sim/fluid.test.ts` checks it against physics with known answers.

| Check | Theory | Measured |
|---|---|---|
| Drain time, Mars against Earth | 1.624 | 1.664 (t50), 1.620 (t90) |
| Drain time, Moon against Earth | 2.459 | 2.527 (t50), 2.466 (t90) |
| Surface tilt, Earth, 0.3 g lateral | 16.70° | 16.67° |
| Surface tilt, Moon, 0.3 g lateral | 61.13° | 61.16° |
| Orbit: liquid drained | 0% | 0%, the blob stays coherent |
| Cup tilted 120° by MuJoCo, landed in the target | | 100% at 1 g, 0% at 0 g |

A throw at 0 g against a wall checks that the liquid really behaves as one (mean compression 0.1%, spread 8 times along the wall) while a control with the pressure solve off fails the same check (350% compression). On this dam break, where the only walls are the bounds, about 1,200 particles fit a 60 fps frame next to MuJoCo on an M4. In the app's pour the cup's walls rotate and contacts are swept, and a particle costs two to three times as much: during the Earth pour the liquid step took 11 to 13 ms median (p90 about 20) with 594 particles and 17.5 to 22 ms (p90 28 to 32) with 1,000, in Node on an M4 under load, while the dam-break baseline ran 5.6 to 9.3 ms in the same runs (7.5 idle). So the app caps the liquid at 600 particles (`MAX_PARTICLES` in `lib/sim/liquid.ts`); on /stage, 594 to 600 particles held 58 to 63 frames a second with nothing dropped. Limits: one-way coupling, 4 to 5 mm particles, volume about 5% low, surface tension not calibrated to water; the remaining limits (density near redundant or rotated walls, particles interacting across the outer corner of a thick wall) are listed at the top of `lib/sim/fluid.ts`. Codex reviewed the solver in three rounds; its 18 findings are fixed, each with a regression test that fails on the earlier code, and two further limits were removed after the review (an exact fallback for fast thin rotating solids, and a hashed grid so one stray particle no longer slows every frame).

## 6. Labelling the hero clip

`scripts/bench-label.mjs`, Super VL on the ISS clip, 5 runs per condition, scored against a ground truth written by watching the frames (verb, main object, fixture type, step count, size).

- In 0 of 35 labels across seven input conditions (frame rate, width, keyframes, thinking on) does the model name the seed film as the object moved; 23 of 35 call the pillows battery packs or hard drives.
- A plausible one-line hint, "aboard the ISS, plant growth experiment", cuts the battery reading from 5 of 5 to 1 of 5 for 17 tokens. Only a hint that names the task gets the film named (4 of 5).
- Frame rate and width do not change the token count (6,379 tokens for the clip at 2, 4 or 8 fps and at 480 or 960 px): Token Factory resamples the video. Thinking on made labels worse and cost twice as much.
- Keyframes report a manipulation that never happened on the chess clip in 4 of 5 runs; the video never does.

## 7. The interview

`scripts/bench-interview.mjs`, 10 ground-truth task specs (four of them space tasks), each with five details removed: fit, grasp aperture, success criterion, a via-point height, a precondition. Nano compiles the degraded spec, Super asks, an oracle answers from the ground truth, Nano recompiles; up to 7 questions; 3 runs per spec.

| Design | Recovered after 1 question | after 3 | after 7 | Cost per recovered detail |
|---|---|---|---|---|
| First design, one call per turn | 13% | 15% | 21% | US$0.0065 |
| Super with thinking on | 14% | 30% | 36% | US$0.0064 |
| A separate call turns each answer into spec changes | 17% | 30% | 43% | US$0.0040 |

In the first design 48 of 124 answers that carried the missing value produced no change to the spec; the separate call loses 7 of 126. The compiler never asks for a via-point height, the schema has two homes for clearance, and the app's change applier rejects batches over fixable shapes; these are the next improvements.

## 8. The self-improvement loop

`tests/measure/patch-loop.test.ts` (live only), four probes (insert, place, pour, carry under vehicle acceleration) at four gravities with disturbances: 36 cases, 3 seeds. Each starts from a naive program; on a failure the model gets the task, the knobs with their bounds and a note of measured facts (never the answer), and returns a patch; the simulator re-runs; at most 5 patches.

A naive program, written the way a person would do the task, fails in 93 of 108 runs (86%) at iteration 0: the disturbances (a hand-off velocity, an offset, a vehicle burst, orbit) break it. In 90 of those 93 a passing program exists, and the fix rates below count only those solvable failures (180 runs over six seeds). Six seeds per case, fix rates with Wilson 95% intervals:

| Patcher | Fixed within 5 patches | Fixed on the first patch | Cost per fixed case | Model time per fixed case |
|---|---|---|---|---|
| Super, thinking off | 69% [62 to 76] (125 of 180) | 26% | US$0.0015 | 12 s |
| Super, thinking on (4k) | 94% [89 to 97] (169 of 180) | 50% | US$0.0032 | 23 s |
| Escalation: Super off, then Super on when stuck | 94% [89 to 97] (169 of 180) | 28% | US$0.0024 | 16 s |
| Escalation to Ultra, thinking off | 91% [86 to 94] (164 of 180) | 27% | US$0.0023 | 9 s |
| Ultra, 16k reasoning (3 seeds) | 94% [88 to 98] | 80% | US$0.045 | 39 s |

The learning curve for the escalating patcher, share of failing rehearsals fixed after each patch: 0%, 28%, 56%, 81%, 87%, 94%. The cheap model alone stalls on lateral offsets: of its 1,079 patches on offset inserts, 58 set the correction to exactly minus the measured offset (such as the note's "4.1 mm from the pocket centre"), mostly late, and 38 used the wrong sign. Escalation takes insert from 40% (24 of 60) to 97% (58 of 60).

**Learning across tasks.** Rules distilled by Super from 16 Earth and Mars repairs, tagged by task and shown only for their own task, were given to the patcher on the Moon and in orbit. The playbook arms make one set-up call before the first rollout, so each is compared with a matched control: the same set-up call, the same number of editing calls, the same cases and seeds, and an empty rules section (120 runs per arm, Wilson 95% intervals for the rates, Newcombe for the lift):

| Patcher | First try: rules vs control | Lift | Within 5 patches: rules vs control | Lift |
|---|---|---|---|---|
| Super, thinking off | 33% vs 5% | +28 points [18 to 37] | 85% vs 79% | +6 [-4 to 16] |
| Super, thinking on | 67% vs 48% | +18 points [6 to 30] | 100% vs 100% | +0 [-3 to 3] |
| Escalation | 33% vs 5% | +28 points [18 to 37] | 94% vs 93% | +2 [-5 to 8] |

The rules make the first try right more often; within five patches the loop gets there anyway, and no lift is distinguishable from zero. With reasoning, the set-up call alone does much of the work: it takes the first try from 5% to 48% without any rules. The cheap model never uses the set-up call (0 of 120 changed anything). Declaring the orbit bead pour infeasible happens before the first rollout in 11 of 12 runs, and by the fourth patch in the twelfth, with the rules and without them alike, so it is not their doing.

**The liquid model changes the pour.** Re-run on the liquid solver (600 particles, one-way coupled), the same loop fixes far fewer pours: 19% [10 to 32] with Super thinking off and 48% [34 to 62] with thinking on, against 79% and 88% with beads. Most failures sit at 75 to 88% of the water in the target, lost along the lip as the water wets the walls. And in orbit, turning the cup over in one second and waiting lands the water and keeps it there in 3 of 6 seeds, so "pouring in orbit is infeasible" was an artefact of the bead model. No patcher found that throw. This is the reason to keep the liquid model: it changes conclusions, not only numbers.

**The playbook on the site (29 October).** `tests/measure/playbook.test.ts`, live: the site's own compile route, unchanged, with Nemotron 3.5 Lightning, on each NASA manipulation clip's answered spec (its interview iteration in `public/showcase/<clip>.json`), the program rehearsed at once at 1 g and 0 g with no Notes patch; first try = it passes in both. Arms with the same calls: off (no playbook); carry-over (the default-on rules of `lib/spec/playbook.ts` learned on the other clips; the route keeps those of the clip's kind of task); matched control (the carry-over request with its rules replaced by "(no rules)"); own (every default-on rule, the clip's own included). 8 runs per arm and clip, Wilson 95% intervals:

| Arm | First try, four pocket clips | |
|---|---|---|
| Off | 8 of 32 (25%) | [13 to 42] |
| Matched control | 6 of 32 (19%) | [9 to 35] |
| Carry-over rules | 0 of 32 (0%) | [0 to 11] |
| Own rules | 4 of 32 (13%) | [5 to 28] |

The carry-over rules lower first-try success by 19 points against the matched control [-35 to -4]: the 5 s wait and the release 2 mm above the floor, learned on the seed film, leave the fluid bag turning in orbit (8 of 8 off, 0 of 8 with them). With its own clip's rule the compiler sometimes applies it (seed film 4 of 8, the chess clip 4 of 8 against 0 of 8 off), so the rules are read; they are specific to the clip they came from. The pipette fails in every arm: at the lift out of reach, or with its own rule mostly at the insert. Seed film and the second seed film fail in orbit with the playbook off too: Lightning's programs do not repeat the recorded Nano passes. 5 of 144 compiles came back unusable, all on the second seed film. Spend: US$0.056 for the 144 measured compiles (`bench/results/playbook.json`), US$0.065 on the ledger with a one-run smoke test and the two recordings. Four clips, eight runs: enough to see the harm, not to rank rules.

Limits: the program is 2 to 4 bounded knobs, not the full interpreter; the failure notes are written by the probes (measured facts, never knob names or answers, checked by a test); seeds mostly vary the model's sampling. Spend: US$10.60 for the two rounds and US$1.28 for the matched controls.

## 9. What this changes in the savings model

The market brief (`docs/research/market.md`, section 5) prices the saving on a 500-demonstration campaign from one vendor's re-collection figure (30 to 50% of the original budget) and a share of that re-collection avoided. That share is still a model: it can only be measured on a real collection campaign, before and after. What is now measured is everything around it:

- **What finding a failure costs.** A naive, human-like program fails 86% of the disturbed runs above, and the simulator finds each of those failures in a single probe rollout, with no robot and no operator. The arm's physics runs a 24-rollout grid in 0.3 s per gravity (section 3); timing the full detection with the interpreter's checks waits for the interpreter.
- **What fixing one costs.** The escalating patcher fixes 94% of the solvable failures (91% of all of them) within five patches, for US$0.0024 of model calls per fixed case and about 16 s of model time.
- **What a session costs.** US$0.0375 on average for the whole session, measured.
- **What the bench cannot see.** Orbit and the Moon turn passing programs into failing ones (a tube let go at the slot mouth seats on Earth and floats in orbit; a free-standing tube topples at a sixth of the push on the Moon), and the liquid model turns an "infeasible" task into a feasible one. Each of those would otherwise surface on the real system.

So the saving per failure the rehearsal catches is the cost of finding it on hardware, minus about a quarter of a cent. Whether that adds up to the 3, 10 or 25% of a campaign budget in the brief's scenarios depends on how many of a campaign's re-collections come from failures of this kind, and that needs a real campaign to measure.

## 10. Nemotron against other models

Devpost asks how Nemotron compares with other models on our tasks. Here other models go through the same harness, cases and seeds as sections 6 to 8, measured on 26 October 2026. Only the bench calls them, and always through Token Factory itself (the same API and billing); the product keeps calling only Nemotron.

**The models.** We listed the catalogue live (`GET /v1/models?verbose=true`, 30 models, saved as `tests/fixtures/models-compare.json`) and ran four of the non-NVIDIA models whose size the catalogue states (issue #96 asked for three or four, within US$25): one near each Nemotron size class, plus a larger open model with a clean thinking switch. The Ultra-sized one, Muse Spark, is also the only non-NVIDIA model there that reads video:

| Model | Size (total, active) | Price per million tokens, in / out | Compared with | Why this one |
|---|---|---|---|---|
| Qwen3 30B-A3B Instruct 2507 | 30B, 3B | $0.10 / $0.30 | Nano (30B, 3B; $0.06 / $0.24) | the same shape as Nano; compiling |
| gpt-oss-120b | 117B, 5.1B | $0.15 / $0.60 | Super (120B, 12B; $0.30 / $0.90) | the same total size as Super; patching and compiling |
| Qwen3.5 397B-A17B | 397B, 17B | $0.60 / $3.60 | Super and Ultra | the largest open model with a clean thinking switch; patching and compiling |
| Muse Spark (open) | 816B, about 42B | $1.25 / $4.25 | Ultra (550B, 55B; $1.00 / $3.00) and Super VL ($0.30 / $0.90) | the only non-NVIDIA model on Token Factory that reads video; patching, compiling, labelling |

`scripts/bench-compare-probe.mjs` checked each one's reasoning switch and video input (`bench/results/compare-probe.json`). We sent a 6 s clip to all ten models the catalogue lists with image input and to Qwen3.5 397B, whose description mentions video: only Super VL and Muse Spark read it, and the other nine answered "This model does not support video input". gpt-oss-120b and Muse Spark cannot turn reasoning off (gpt-oss ignores `enable_thinking`; Muse Spark refuses `reasoning_effort: none` and reasons longer with `enable_thinking: false`), so their "off" is `reasoning_effort: low`, with the 4,096-token budget of an "on" arm so that the reasoning fits; the patching table names every budget, and the labelling budgets are under its table. Left out: GLM-5.3 (750B), which did not finish an answer to a one-line question within 3,000 tokens whatever switch we sent, more than three times the loop's 800-token "off" budget; DeepSeek V4 Pro and Kimi K3, because the catalogue gives no size to match them by. Not run, for the three-or-four limit and the budget, though the catalogue states their sizes: Qwen3 235B-A22B (US$0.20 / $0.60, cheaper than Super), GLM-5.3-Flash (320B, 18B active), MiniMax-M3 (428B), Hermes 4 405B, Reflection Beam (501B, 23B active), Gemma 3 27B and Qwen3.8 27B.

**Patching** (Super's job). The self-improvement loop of section 8, round 2: the same 36 cases, 6 seeds, the same 180 solvable failures, at most 5 patches, the same prompts and failure notes. The Nemotron rows are section 8's.

| Patcher | Fixed within 5 patches | Fixed on the first patch | Cost per fixed case | Model time per fixed case | Answers cut off / unparseable / failed calls |
|---|---|---|---|---|---|
| Nemotron 3 Super, thinking off (800 tokens) | 69% [62 to 76] (125 of 180) | 26% | US$0.0015 | 12 s | 1 / 1 / 3 of 601 |
| Nemotron 3 Super, thinking on (4096 tokens) | 94% [89 to 97] (169 of 180) | 50% | US$0.0032 | 23 s | 4 / 4 / 0 of 401 |
| Nemotron 3 Super off (800), then Nemotron 3 Super on (4096) when stuck | 94% [89 to 97] (169 of 180) | 28% | US$0.0024 | 16 s | 3 / 3 / 1 of 504 |
| Nemotron 3 Super off (800), then Nemotron 3 Ultra off (800) when stuck | 91% [86 to 94] (164 of 180) | 27% | US$0.0023 | 9 s | 0 / 0 / 0 of 514 |
| gpt-oss-120b, reasoning low (4096 tokens) | 85% [79 to 89] (153 of 180) | 38% | US$0.0008 | 4 s | 0 / 3 / 0 of 449 |
| gpt-oss-120b, thinking on (4096 tokens) | 92% [87 to 95] (165 of 180) | 65% | US$0.0014 | 6 s | 0 / 3 / 0 of 353 |
| Qwen3.5 397B-A17B, thinking off (800 tokens) | 87% [81 to 91] (156 of 180) | 36% | US$0.0028 | 5 s | 0 / 0 / 0 of 457 |
| Muse Spark (open), reasoning low (4096 tokens) | 100% [98 to 100] (180 of 180) | 90% | US$0.0056 | 9 s | 0 / 0 / 0 of 232 |
| Muse Spark (open), thinking on (4096 tokens) | 98% [94 to 99] (176 of 180) | 89% | US$0.0193 | 27 s | 0 / 0 / 0 of 253 |

By task, fixed of the solvable failures:

| Patcher | insert | place | pour | carry |
|---|---|---|---|---|
| Nemotron 3 Super, thinking off (800 tokens) | 24/60 | 39/48 | 38/48 | 24/24 |
| Nemotron 3 Super, thinking on (4096 tokens) | 55/60 | 48/48 | 42/48 | 24/24 |
| Nemotron 3 Super off (800), then Nemotron 3 Super on (4096) when stuck | 58/60 | 47/48 | 40/48 | 24/24 |
| Nemotron 3 Super off (800), then Nemotron 3 Ultra off (800) when stuck | 58/60 | 41/48 | 41/48 | 24/24 |
| gpt-oss-120b, reasoning low (4096 tokens) | 57/60 | 47/48 | 25/48 | 24/24 |
| gpt-oss-120b, thinking on (4096 tokens) | 60/60 | 48/48 | 33/48 | 24/24 |
| Qwen3.5 397B-A17B, thinking off (800 tokens) | 54/60 | 43/48 | 35/48 | 24/24 |
| Muse Spark (open), reasoning low (4096 tokens) | 60/60 | 48/48 | 48/48 | 24/24 |
| Muse Spark (open), thinking on (4096 tokens) | 60/60 | 48/48 | 44/48 | 24/24 |

- **With reasoning on, Super ties the open model of its size.** gpt-oss-120b fixes 92% [87 to 95] against Super's 94% [89 to 97]. It gets more right on the first patch (65% against 50%) for less than half the cost per fix (US$0.0014 against US$0.0032).
- **With reasoning off, Super loses.** Qwen3.5 397B, on the same 800-token budget with thinking off, fixes 87% [81 to 91] against Super's 69% [62 to 76], at about twice Super's cost per fix. gpt-oss-120b at its lowest effort fixes 85%, but it never stops reasoning, so that is not a like-for-like "off".
- **The Ultra-sized model wins outright.** Muse Spark at low effort fixes all 180 [98 to 100], 90% on the first patch, for US$0.0056 per fix: 2.4 times the cost of Super escalating to reasoning, and an eighth of Nemotron Ultra with 16k reasoning (94%, 80% on the first patch, US$0.045, section 8, 3 seeds). With its default reasoning it fixes 98% for US$0.019 per fix, so more reasoning bought nothing here.
- **Where Super is better than gpt-oss: the orbit pour.** In the one case where the right patch is to report the bead pour infeasible (section 8), Super with reasoning gets there in 8 of 12 runs, gpt-oss-120b in 1 or 2 of 12, Muse Spark in 12 of 12 at low effort (8 of 12 with its default reasoning). These are 10 of gpt-oss's 15 lost pours with its default reasoning, and 11 of its 23 at low effort.
- Model time is the time per fixed case on Token Factory on the day (the Nemotron arms ran on 25 October, the others on 26 October; the same goes for the labels' time), so it mixes model speed with how loaded each model's endpoint was.
- **Qwen3.5 397B has no thinking-on row.** Token Factory stopped serving it between its thinking-off arm (finished 10:35 UTC) and its thinking-on arm (10:45 UTC), and every call returned HTTP 404; the harness now stops at the first 404. When it came back (11:26 UTC) we started the arm again with Super's 4,096-token budget: 40 of its first 41 answers were cut off at the budget with no patch, so we stopped it after 12 runs. With 16,000 tokens, as Ultra needed in section 8, the arm would have cost more than the study's cap had left (`bench/results/compare-patch.json`, `notes`).

**Compiling** (Nano's job). The product's own compile route (`app/api/compile/route.ts`, unchanged: its prompt, its ready-made moves, its one repair round, its post-processing), with another model in Nano's place, on the ten interview specs of section 7, each fitted to the robot's bench as the app does. Each spec runs complete (nothing to ask) and degraded (section 7's five fields removed; the route can ask about two of them: the fit and the success check), 3 runs each, 60 compiles per model (`tests/measure/compile-compare.test.ts`). The bench gives the route's client a 240 s timeout instead of 25 s, so a slow model is measured on what it writes; the last column counts the calls the route itself would have timed out.

| Compiler | Program back | First answer clean | Problems left after the repair round | Asked for the missing fit itself | Asked for the missing success check itself | Asks written for a complete spec (mean) | Rehearsal passes at 1 g (complete spec) | Cost per compile | Model time per compile (median) | Calls over the route's 25 s |
|---|---|---|---|---|---|---|---|---|---|---|
| Nemotron 3 Nano | 93% | 70% [57 to 80] (42 of 60) | 4 of 56 | 23% [12 to 41] (7 of 30) | 0% [0 to 11] (0 of 30) | 1.2 | 3 of 30 | US$0.00028 | 2.8 s | 0 of 78 |
| Qwen3 30B-A3B Instruct 2507 | 100% | 98% [91 to 100] (59 of 60) | 0 of 60 | 0% [0 to 11] (0 of 30) | 30% [17 to 48] (9 of 30) | 0.4 | 6 of 30 | US$0.00029 | 2.1 s | 0 of 61 |
| gpt-oss-120b | 100% | 95% [86 to 98] (57 of 60) | 0 of 60 | 0% [0 to 11] (0 of 30) | 63% [46 to 78] (19 of 30) | 0.0 | 5 of 30 | US$0.00065 | 1.7 s | 0 of 63 |
| Qwen3.5 397B-A17B | 100% | 97% [89 to 99] (58 of 60) | 0 of 60 | 13% [5 to 30] (4 of 30) | 60% [42 to 75] (18 of 30) | 0.2 | 6 of 30 | US$0.00228 | 2.8 s | 0 of 62 |
| Muse Spark (open) | 100% | 100% [94 to 100] (60 of 60) | 0 of 60 | 100% [89 to 100] (30 of 30) | 100% [89 to 100] (30 of 30) | 0.0 | 6 of 30 | US$0.00674 | 15.2 s | 1 of 60 |

- **Nano loses to the model of its own shape.** Qwen3 30B-A3B, the same 30B with 3B active, writes a first program that parses, matches the schema and passes the lint in 98% of compiles; Nano does in 70% [57 to 80] (55% in a first run of the same 60, set aside because of a scoring fix, `superseded` in `bench/results/compare-compile.json`). Nano returned no program at all in 4 of 60 compiles (a `warnings` string where the schema wants a list, a step given as a string) and left problems the repair round did not fix in 4 more. Qwen3 30B costs about the same per compile.
- **Asking for what is missing.** Muse Spark asks for every missing fit and success check itself (30 of 30 each). The other three open models (Qwen3 30B, gpt-oss-120b, Qwen3.5 397B) ask for the success check in 30 to 63% of compiles and for the fit in at most 13%. Nano never asks for the success check itself (0 of 30) and never for a pocket's clearance (0 of 21). On the three specs whose missing fit is a zone or stack tolerance band it asks for the band in 7 of 9 compiles (3 of 9 in its first run), where the other three ask in none; but it also asks for one in 5 of 8 compiles of the same specs complete, with the band set (5 of 9 in its first run), so this is a habit on those specs more than spotting the gap. It writes about one ask per complete spec, for fields that are already set, which the route drops. The route adds a pocket's clearance and a step's success check whenever the program does not ask for them, so the person is asked either way; a missing zone tolerance band has no such safety net.
- **The rehearsal does not separate the compilers.** Programs for the complete specs pass at 1 g in 5 or 6 of 30 for every model, Nano included in its first run; in its rerun, 3, after four of its complete-spec compiles returned no program. The route hands every model the same ready-made moves, and most failures are the bench fit's: an approach out of the arm's reach, or a pocket check that the moves miss by a few millimetres.
- Time and cost per compile: Nano and Qwen3 30B are the cheapest (US$0.0003); Muse Spark costs 24 times more and takes 15 s, and one of its 60 calls went past the route's 25 s. During the first Nano run its endpoint was slow (16 of 87 calls over 25 s); during the rerun none was.

**Labelling** (Super VL's job). Section 6's ISS seed-film clip, the same seven input conditions, 5 runs each (35 labels), the same prompt and rubric (`node scripts/bench-label.mjs --model meta-models/muse-spark-open`, results in `bench/results/compare-label.json`). The budgets differ: Super VL had 3,000 tokens with thinking off and 4,000 with it on (condition f); Muse Spark, which cannot stop reasoning, had 8,000 in every condition, with `reasoning_effort: low` where Super VL had thinking off. Its cost and time below include that reasoning.

| Labeller | Rubric score | Names the seed film | Calls the pillows batteries or drives | Insert or pocket verb | Pocket fixture | Step count | Size | Cut off | Cost per label | Time per label (median) |
|---|---|---|---|---|---|---|---|---|---|---|
| Nemotron 3.5 Super VL | 42% | 0 of 35 | 23 of 35 | 16 | 12 | 13 | 32 | 2 | US$0.0028 | 4.1 s |
| Muse Spark (open) | 46% | 2 of 35 | 0 of 35 | 28 | 22 | 3 | 25 | 1 | US$0.0092 | 12.5 s |

Rubric score by condition (a 4 fps, b 8 fps, c 2 fps, d keyframes, e one-line hint, f thinking on, g 960 px):

| Labeller | a | b | c | d | e | f | g |
|---|---|---|---|---|---|---|---|
| Nemotron 3.5 Super VL | 40% | 40% | 40% | 52% | 36% | 28% | 56% |
| Muse Spark (open) | 40% | 48% | 56% | 40% | 48% | 40% | 48% |

- Muse Spark never reads the plant pillows as batteries or drives (0 of 35, against Super VL's 23), and finds the insert verb and the pocket more often. But it calls the seed film a sample vial, pouch or pipette: the rubric's pattern credits it twice, for a "sample cassette strip" and a "seed-fluid container", and neither is the film. Its rubric score is level with Super VL's (46% against 42%), and it gets the step count and the size wrong more often.
- Super VL costs a third as much per label and answers three times faster.

**Where Nemotron wins and where it loses.** On accuracy, Nemotron wins none of the three jobs. gpt-oss-120b, the open model of Super's size, repairs failing rehearsals as well as Super with reasoning, for less than half the cost per fix. With reasoning off, Super falls well behind a larger open model (69% against 87%). Muse Spark, the size of Ultra, fixes every failure, nine in ten on the first patch, for 2.4 times the cost of Super's escalation and an eighth of Ultra's. Nano writes a clean first program far less often than the open model of its own shape. Nemotron wins on video and on a few behaviours that matter here. Super VL is one of only two models on Token Factory that read video (of the eleven we tried), and the cheaper and faster of the two, though Muse Spark reads the scene better (it never calls the plant pillows batteries or drives) and neither names the seed film on our hardest clip. Super reports the infeasible orbit pour far more often than gpt-oss. And one family covers watching, compiling, interviewing and patching on one host, with one thinking switch. Within Nemotron, the next thing to measure is Super as the compiler.

**For the Devpost question** ("How did Nemotron's performance compare to other models you've used for similar tasks?"):

> We ran other models through the same harness, cases and seeds on Token Factory. Repairing failed robot programs from simulator notes, Nemotron 3 Super with reasoning fixed 94% of 180 failures, level with gpt-oss-120b (92%), which cost less than half as much per fix, and below Meta's larger Muse Spark (100%, at 1.8 times Super's cost per fix); with reasoning off, Super (69%) trailed Qwen3.5 397B (87%), and the same-size Qwen3 30B wrote a clean first program more often than Nemotron 3 Nano (98% against 55 to 70%). Where Nemotron stood out was video: Nemotron 3.5 Super VL was one of only two models on Token Factory that read a clip (we tried every model there that takes images), and the cheaper and faster of the two, though Muse Spark read the scene better (it never called the plant pillows batteries or drives, which Super VL did in 23 of 35 labels; their rubric scores were level, 46% against 42%), and neither named the object in our hardest clip. So Nemotron did not win on accuracy; it won on video input and on covering all four jobs with one model family and one thinking switch, and every number is in docs/MEASUREMENTS.md.

**Limits and spend.** Two days (the Nemotron rows for patching and labelling were measured on 25 October, everything else on 26 October), one host, list prices; the "off" switch differs by model family, and each row says which one it used. Section 10's ledger scripts (`compare-*`) charged US$15.97 under their own cap of US$25. Of that, US$8.82 are worst-case estimates for calls made while Token Factory had withdrawn Qwen3.5 397B: 571 refused with HTTP 404 and 3 in flight when we stopped that run. A refused call does no work, so the bill for this section should be nearer US$7.15, including the US$0.68 of the stopped second Qwen3.5 attempt.

## 11. Following a gesture

`samples/iss-wave.mp4` (6 s at 30 fps, an astronaut waving to the camera) traced in the browser by `lib/vision/trace.ts` on 26 October. In the recorded label, Super VL calls 1 to 3.2 s one gesture of the right hand, the first wave; another run on the same clip called it 1 to 4 s and added a microphone grasp beside it, so the window varies from run to run. MediaPipe pose sees the hand in 66 of 66 frames of that window, on an arm of 481 mm. The landmarks are kept in `tests/fixtures/vision/wave.json`, and `tests/sim/wave-fixture.test.ts` replays them through the scaling and the arm.

- A wave turns back several times a second: sampled at 10 fps it aliases into jitter (on the first sample clip the path came out half as wide), so the trace samples at the clip's 30 fps. A three-sample average weighted 1, 2, 1 takes off frame-to-frame jitter and keeps 90% of a 3 Hz swing.
- In a palm wave the hand turns about the wrist, so the hand's centre (the mean of the pose model's wrist, index and pinky landmarks) travels further than the wrist across: 226 mm against 173 mm here (280 and 288 mm high). The path follows the hand's centre, which is what the gripper stands for, and averages three landmarks instead of one.
- Scaled at 520 mm per metre (the SO-101's 250 mm arm over the person's 481 mm), the path was 112% of the box's height, as the hand comes down at the end, so it is shrunk a further 11% (464 mm per metre in all, the figure the trace prints): 105 mm across and 130 mm high in front of the arm.
- MuJoCo (5 ms step, the SO-101's position actuators), point between the pads against the 66 points, reach 5 mm, each point within 0.25 s of its own time. At the clip's own pace a joint would have to turn at 6.7 rad/s; the arm is held to 2 rad/s, so it follows at 0.30x:

| World | Reached within 5 mm | Farthest | First within reach, latest |
|---|---|---|---|
| Earth, Node (`tests/sim/wave-fixture.test.ts`) | 66 of 66 | 0.3 mm | 0 s |
| Orbit (0 g), Node | 66 of 66 | 0.3 mm | 0 s |
| Earth, browser worker, three runs | 66 of 66 | 0.5 to 0.8 mm | |
| Orbit, browser worker, three runs | 66 of 66 | 0.4 to 0.6 mm | |

On the first sample clip (a slower palm wave, replaced because an agency placard and flags were in view, so these numbers are no longer reproducible from the repository), at the clip's own pace the joints turned at up to 2.9 rad/s and the arm reached 238 of 240 points within 5 mm, the farthest 5.2 mm off; held to 2 rad/s it reached all 240 within 1.1 mm. That is where the cap comes from; it was chosen in the simulator, not from a real servo. The reach box, 240 mm across and z 200 to 330 mm in the plane x = 220 mm, is checked corner by corner and with a circle that fills it, at 1 g and 0 g (`tests/sim/follow.test.ts`). Live spend for this section, about US$0.04: Super VL labels of the two sample clips and of two camera takes while the label prompt and clean-up were tuned, and three Nano compiles before a program made only of gestures stopped needing a model.

## 12. The models Token Factory retires on 9 November 2026

Token Factory's notice [Model Deprecations: November 2026](https://docs.tokenfactory.nebius.com/model-deprecations-november-2026), read on 27 October: Nemotron 3 Nano (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`) and Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) leave Serverless on 9 November 2026, before judging ends. It names Nemotron 3.5 Lightning (`nvidia/Nemotron-3_5-Lightning`) and Nemotron 3.5 Super VL (`nvidia/Nemotron-3.5-Super-VL`) as their replacements, and a retired ID answers HTTP 404 `model_not_found`. Super VL and Ultra are not on the notice. Sections 4 to 11 were measured on Nano and Super, and the ISS examples are recordings made on them. Since 27 October a clip of your own runs on the replacements. Both sides of each table below were run on 27 October with the same harness, cases and seeds.

**Compiling** (Nano's job): section 10's harness, the route's own prompt as it is today, 20 specs, 3 runs each.

| Compiler | Program returned | Clean first answer | Rehearsal passes, ground-truth specs | Slowest call | Cost per compile |
|---|---|---|---|---|---|
| Nemotron 3 Nano | 93% [84 to 97] (56 of 60) | 67% [54 to 77] | 6 of 29 | 14.2 s | US$0.00035 |
| Nemotron 3.5 Lightning | 100% [94 to 100] (60 of 60) | 93% [84 to 97] | 6 of 30 | 2.9 s | US$0.00029 |

Lightning writes no `ask` of its own: Nano wrote 25 on the 27 degraded specs it compiled, 6 of them about a removed field. The route adds the asks the rehearsal needs (51 on Lightning's 30 degraded specs), so the robot still asks its questions.

**Patching** (Super's job): section 8's round-2 loop, the same 180 solvable failures, 6 seeds, at most 5 patches.

| Patcher | Fixed within 5 patches | Fixed on the first patch | Cost per fixed case | Model time per fixed case | Answers cut off / unparseable / failed calls |
|---|---|---|---|---|---|
| Nemotron 3 Super, thinking off (800 tokens) | 69% [62 to 75] (124 of 180) | 24% | US$0.0022 | 8 s | 0 / 0 / 2 of 603 |
| Nemotron 3.5 Super VL, thinking off (800 tokens) | 76% [69 to 81] (136 of 180) | 38% | US$0.0015 | 5 s | 1 / 1 / 0 of 506 |
| Nemotron 3 Super, thinking on (4096 tokens) | 94% [89 to 97] (169 of 180) | 47% | US$0.0033 | 14 s | 3 / 3 / 0 of 397 |
| Nemotron 3.5 Super VL, thinking on (4096 tokens) | 50% [43 to 57] (90 of 180) | 26% | US$0.0272 | 33 s | 540 / 540 / 0 of 654 |
| Super off, then Super on when stuck (the app until 27 October) | 94% [90 to 97] (170 of 180) | 27% | US$0.0024 | 12 s | 4 / 4 / 0 of 505 |
| Super VL off, then Nemotron 3 Ultra off when stuck (the app since) | 89% [83 to 93] (160 of 180) | 32% | US$0.0022 | 6 s | 0 / 0 / 0 of 481 |

Super VL patches better than Super with thinking off. With thinking on it used all 4,096 tokens without returning an answer in 83% of its calls (540 of 654), fixed half the failures, and cost twelve times as much per fix; a live preview hit that twice. So with Super VL as the patcher, the stuck loop asks Nemotron 3 Ultra with thinking off (`app/api/notes/route.ts`): 89% against Super's 94%, the intervals overlapping, at a slightly lower cost per fix. Ultra is not on the notice either.

**When a model goes.** The spend gate reads Token Factory's model list, at most every five minutes per function instance. If a model the routes call is missing, every route replays its recording with the reason "Token Factory no longer serves a model this demo calls", and `/api/health` reports replay. On 27 October, on a preview deployment with Nano's ID set to one that does not exist, label, questions, recompile, rehearsal, patch loop, variants and web lookup all replayed with that line, and nothing failed. Each instance reads the list on its own, so for up to five minutes a session can be live on one step and replay the next; that step says why.

Spend for this section: US$4.30 on the bench ledger (scripts `compare-compile` for both compile runs, `patch-successor` and `patch-successor-base`), under the US$5 set for this check.

## 13. How long /try takes

Measured on 27 October 2026 in the app's browser (Chrome 152, Electron) on an Apple M4, from the moment "Watch the clip" is pressed: the stage lines' changes timed every 100 ms in the page. The sample rows are the deployed site, https://understudy-rose.vercel.app/try, live (a sample clip needs no code); each sample ran once or twice. The deployed page cannot open a file from this Mac without a file picker, so the 8 s 1080p phone-style clip (H.264 High, 30 fps, 12 Mbit/s, with sound, made from `samples/iss-glovebox-pipette.mp4` scaled up) ran on a local server of the same branch, still calling Token Factory live: the proxy runs in the browser either way, and Super VL sees the same 480 px, 4 fps copy whatever the phone filmed.

| Clip | Where | Proxy in the browser | Super VL (upload and watch) | Tracing the hand (MediaPipe) | Nano's first program | To the program |
|---|---|---|---|---|---|---|
| 36 s ISS, 720p (`iss-veggie-seed-film`) | deployed | 0.7 s | 17.4 s | | 4.6 s | 22.7 s |
| 36 s ISS, 720p (`iss-veggie-seed-film-2`), two runs | deployed | 0.6 to 1.4 s | 9.0 to 18.7 s | | 1.5 to 4.3 s | 11.2 to 24.5 s |
| 10.8 s ISS, 720p (`iss-glovebox-pipette`), two runs | deployed | 0.1 to 0.3 s | 6.7 to 8.5 s | | 1.7 to 3.0 s | 10.0 to 10.9 s |
| 10.2 s ISS, 720p (`iss-fluid-bag-foam`) | deployed | 0.3 s | 5.9 s | | 2.0 s | 8.3 s |
| 8 s phone-style, 1080p, three runs | local server, live models | 0.4 to 0.5 s | 3.7 to 12.7 s | | 1.8 to 3.0 s | 6.1 to 16.0 s |
| 6 s ISS wave, 720p (`iss-wave`) | deployed | 0.1 s | 5.2 s | 12.1 s (3.8 s to load MediaPipe, then 180 frames) | 0.2 s (no model) | 17.7 s |
| 30 s ISS chess, 720p (`dev-clip`), labelled as a gesture that run | deployed | 0.8 s | 8.4 s | 50.2 s | 0.2 s (no model) | 60.3 s |

Each model call in today's recordings (`public/showcase/*.json`, from node on the same Mac): Super VL 1.7 to 7.0 s (median 5.7 s, 8 calls); Nano 1.2 to 4.6 s but for one call of 35.7 s (13 calls); Super's patches 0.7 to 1.1 s with thinking off and 7.7 to 16.7 s with it on (13 calls). Each interview answer is one more Nano call.

What the page says comes from these rows (`lib/estimate.ts`): beside each stage's clock, "usually" a range that grows with the clip for the proxy (0.1 + 0.01 s to 1 + 0.04 s per clip second), Super VL (3 + 0.15 s to 10 + 0.3 s per clip second) and the trace (3 + 1.2 s to 5 + 1.8 s per clip second), and 1.5 to 10 s for Nano and 1 to 17 s for a patch; before "Watch the clip", for a clip of your own, the proxy, Super VL and Nano's first program added up: "This takes about 5 to 25 seconds for your own video" for 8 s, 10 to 35 seconds for 36 s, 20 to 65 seconds for the longest the page takes (120 s). On this Mac the proxy was the shortest stage; on a slower one its clock now shows how long it takes.

A sample with a recording skips all of this: on a local server each of the six reached its program 0.05 to 0.10 s after "Watch the clip", and veggie's two Notes patches came back in 0.4 s each; the rehearsals still run in the browser. The five new recordings were made on 27 October with Nemotron 3.5 Super VL, Nemotron 3 Nano and Nemotron 3 Super, which leave Token Factory serverless on 9 November: US$0.031 for the five kept, about US$0.04 with three runs that stopped (Nano's first answer did not parse once, Super VL's label failed its schema twice). The wave's hand path was traced once in the browser against its recorded label and handed to the recorder, which cannot run MediaPipe. Where they end: the drink bag passes after the interview, chess and the first seed film pass after Notes, the wave's path is followed on Earth and in orbit; the pipette and the second seed film still failed after five patches. Both were then re-recorded the same day on the same models with the same answers (#152, every run in `bench/rerecord/`): the pipette's runs 1 to 3 still failed after five patches (run 1 on Earth and in orbit, runs 2 and 3 in orbit) and run 4 passes after one Notes patch; the second seed film's run 1 failed on Earth and in orbit after five patches and run 2 passes after the interview, with no patch. `public/showcase/<clip>.json` holds the kept run and says on the page which it is, out of how many ([FAILURES.md](FAILURES.md), cases 1 and 2, use the kept runs).

## 14. Clips of your own: first answers that did not parse

On the Vercel preview of #140, 2 of 4 first compiles of an uploaded clip failed their schema check, and the page said so. Issue #149 measured the own-clip path on 27 October in node through the routes themselves (`tests/bench/own-clips.test.ts`). It used the models the deployment calls, Nemotron 3.5 Super VL for the label and Nemotron 3.5 Lightning for the compile, and kept every request and raw answer in `bench/results/own-clips-*.json`.

**The clips.** None is a sample, so each one runs live as a person's upload would. All four are 1080p, 30 fps, H.264 High at 12 Mbit/s with sound, cut and scaled from the NASA samples with ffmpeg:
- an 8 s landscape clip from `iss-glovebox-pipette` (2 to 10 s);
- an 8 s portrait clip (1080 × 1920, the middle 405 px of the frame) from `iss-veggie-seed-film-2` (4 to 12 s);
- an 8 s portrait clip from `iss-fluid-bag-foam` (1 to 9 s);
- a 12 s landscape clip from `iss-veggie-seed-film` (10 to 22 s).

Each clip ran 4 times: twice with the line a person might type, twice with none, as the page starts. The proxy was made with ffmpeg at the browser's 480 px and 4 fps.

**Before (main at 0f26296).**
- Labels: 10 of 16 first answers were rejected, and each second answer parsed, so a label took two Super VL calls (mean 4.4 s, up to 8.9 s). Every rejection was a field written as `null` instead of left out: a step's `target` in 9 labels, its `object` in 8, and once each `pocket_clearance_mm`, `pose` and `gesture`. In 8 of the 10, a `retract` step named no object: the hand pulling back holds nothing. One `pose` also had no `xyz_mm`. When the second answer has the same nulls, the label fails outright: that happened twice in three runs while recording `iss-veggie-seed-film-2` (section 13).
- Compiles: the 16 first compiles, then each of the 16 fitted specs compiled 3 more times, so 64 first answers from Lightning. 52 were fine. 10 had a problem the route's check sends back, and the second call fixed it: a step that never releases (6), a `follow` op in a step that is not a gesture (2), a move outside its target's frame (2). 2 did not parse, both for the same spec, and both were the same slip. Lightning closed the steps array one place late, as `"steps": [{…}, {…}, "warnings"]}`, so the key `"warnings"` became a step and its value was lost. Asked again with only the error, Lightning returned the same answer word for word, and the route failed. That makes 2 of 48 repeat compiles failed, about 4%. The page's two failures (`steps.2: expected object, received string`, and a step with neither `step_id` nor `ops`) are the same slip.
- No answer came near the limit: every compile finished with `stop`, the longest at 1,370 of 3,000 tokens. `max_tokens` is not the cause.

**The fix.**
- `normalizeSpec` reads `null` as unset, since no field of a spec takes null. The exception is an insert's or a place's `target`: there `null` is a gap, so it stays an error and the model is asked again. It also leaves out a `pose` without its three coordinates. The label clean-up (`tidyLabel`) then leaves out a bare `retract` that names no object once the hand has let go. That is judged on the clean-up's sorted, non-overlapping timeline: the last grasp or let-go before it is a release, a place or an insert, and it has no destination, path or checks of its own (the fit drops retracts anyway). Seven of the eight object-less retracts measured were bare; the eighth named a destination and is still asked about. No insert or place had a null target.
- `normalizeProgram` puts a program key caught inside `steps` back where it belongs, whether it is a bare `"warnings"` or a record of program keys, and reads a step written as a JSON string, as it already read ops.
- When an answer is unusable, the retry message now repeats the answer's shape (`CallOptions.shape`), so a slip the normalizer does not know is less likely to come back unchanged.

`tests/bench/own-clips-replay.test.ts` reads every kept first answer again: 15 of the 16 labels (all but that eighth retract) and all 64 programs now parse, and so do all 16 first labels from the live run after the fix. On main the same test fails on 10 labels and 2 programs.

**After, live, same clips and lines, the same 16 specs.**

| | Before | After |
|---|---|---|
| Labels right on the first answer | 6 of 16 | 16 of 16 |
| Label time, mean (max) | 4.4 s (8.9 s) | 2.7 s (4.5 s) |
| Compiles of the 16 specs, 3 each, that failed | 2 of 48 | 0 of 48 |
| ... that needed a second call | 9 of 48 | 3 of 48 (all check problems) |

What is still open: 5 of 16 labels after (3 of 16 before) describe the task as a move and a release with no insert or place step, so the fit finds nothing to rehearse (issue #150). Spend for this section: US$0.10.

## 15. Clips of your own: labels with nothing to rehearse

After #149, a quarter of the labels of people's own clips still gave "nothing to rehearse" (issue #150): the fit keeps one insert or place step onto a named object, and those labels had none. #150 added two clips to section 14's four, made the same way from the samples: an 8 s portrait clip from `iss-glovebox-pipette` (1 to 9 s) and a 10 s landscape clip from `iss-fluid-bag-foam` (0 to 10 s). It labelled all six 4 times each on main (`own-clips-label-main150.json`), and read again every label kept since section 14: 104 in all, every raw answer in `bench/results/own-clips-label-*.json`.

**What the labels without a place said.** Of the 14 among the 56 labels made with main's prompt:
- 7 put the object down as a move onto a named object, then a release of it ("grasp the drink bag, move it to the work surface, release it");
- 3 had a move that named no target ("grasp, move, release");
- 2 never let go (moves only), and 2 were one step or a retract.

The first kind is a place written in two steps, so the label already says where the object went and that the hand let go of it there.

**The fix.**
- `fitToBench` reads a move of an object onto another named object, followed by its release with no grasp between, as a place there, and says so in its warnings ("steps s2 and s3: a move onto work_surface, then a release, read as a place there"). The release's own target wins when it names another object. Labels that have an insert or place are fitted as before.
- The fit takes the first insert or place onto another named object. One label inserted the bag "into itself" before placing it on the foam, which used to hide the place.
- Either one outranks a gesture beside it, as a place already did.
- A label prompt rule ("putting something down is one place or insert step, not a move and a release") was tried on 48 runs. It made Super VL write place more and release less, but it did not leave more labels rehearsable: 40 of 48 with the fit rule, against 49 of 56 without the prompt rule. So it was not kept.

**Before → after, the same 104 labels fitted again** (`tests/bench/own-clips-replay.test.ts`):

| Labels | Something to rehearse, main's fit | With #150's fit |
|---|---|---|
| Section 14's 16 runs before #149 | 13 | 15 |
| Section 14's 16 runs after #149 | 11 | 14 |
| Six clips × 4 on main (`main150`) | 18 | 20 |
| The same, labelled with the prompt rule (`after150`, `final150`) | 37 of 48 | 40 of 48 |
| All 104 | 79 (76%) | 89 (86%) |

Live, labels of the same clip vary more from run to run than either change moves them. Three arms of 24 gave 18, 20 and 18 rehearsable, so only the same labels fitted twice show the fit's effect. The 15 that remain need the person: a move with no target, or a clip whose label never lets go. Section 16 asks "where does it go?" in the interview for the 12 of them that pick something up (#155).

The 72 compiles in these runs had 2 failures, both Lightning answers that went wrong: one wrote `"steps": [1]`, and one put the key `"warnings[]"` inside steps, the same slip as section 14 spelled differently. `normalizeProgram` now puts that one back too. Spend for this section: US$0.12.

## 16. Clips of your own: asking where it goes

After #154, 15 of the 104 kept labels still had nothing to rehearse (section 15). In 12, the label says what the hand picked up but not where it went: a move with no target, or a clip that never lets go. The other 3 never pick anything up (a single reach). Issue #155 asks the person, who knows.

**How it works.** The fit keeps the grasp and a place step with no target, and the scene's other named objects stay in the spec as the answers to choose from, plus a spot on the bench. The compile route writes that program itself, with no model: no moves, and one ask, "Where does the drink bag go?". The page shows it in the same interview form as the other asks, as chips: the scene's objects, then "somewhere else on the bench". The answer sets the place step's target through `applyChanges`. The fit then runs again on the answered spec, lays out the chosen object like any target, and Nano compiles as usual.

**Measured on the same 104 labels** (`tests/bench/own-clips-replay.test.ts`, the bench chip as the answer):

| | Labels |
|---|---|
| Something to rehearse, #154's fit | 89 |
| Asked where it goes | 12 |
| Something to rehearse after one answer | 101 (97%) |
| Nothing picked up, so nothing to ask | 3 |

Live, for the 12, on Nemotron 3.5 Lightning: the route asked where with no model, and after the answer Lightning compiled every one, asking next what counts as done. Answered with the recorder's defaults and rehearsed in node, before any Notes patch, 5 of the 12 pass on Earth and in orbit and 1 on Earth only. The other 6 fail as other clips do: a thin object the pads do not hold, a reach 10 mm too far, an object still settling. Notes patches those on the page. In only 2 of the 12 did the label name the real destination (the cartridge, the equipment tray), so for the other 10 the right answer is the bench. Spend: about US$0.02.

## 17. The baseline on the scoreboard

The scoreboard's first bar (#55) is "retarget and replay": a program written by fixed rules from the label's steps as first fitted to the bench, with no model and no answers (take the object, carry it 20 mm over the target, lower it onto it or into the pocket, let go; no waits, no checks; `lib/saboteur/baseline.ts`). It is our rule set, one stand-in for the standard approach, not a published method and not a retargeted human trajectory. It runs on each clip's twelve replayed perturbations, blind and sensed, on the last recorded version's spec, as every version does. Source: `tests/saboteur/baseline.test.ts` and `tests/saboteur/scoreboard.test.ts`, headless in node, no model call (29 October, after the tilt fix of #77, which moved six of these counts by one or two, on the second seed film, the fluid bag and the chess clip: a tilted object no longer starts inside the table); the page gives the same counts (seed film and fluid bag checked in the browser).

| Clip | Baseline, Earth | Last version, Earth | Baseline, orbit | Last version, orbit |
|---|---|---|---|---|
| `iss-veggie-seed-film` | 24 | 24 (second Notes patch) | 3 | 15 |
| `iss-veggie-seed-film-2` | 22 | 21 (after the interview) | 0 | 19 |
| `iss-glovebox-pipette` | 0 | 21 (Notes patch) | 0 | 22 |
| `iss-fluid-bag-foam` | 24 | 22 (after the interview) | 8 | 13 |
| `dev-clip` (chess) | 0 | 23 (Notes patch) | 0 | 22 |

Passes out of 24 per gravity. On the pipette and the chess clip the baseline stops at a move 50 mm above the object, out of reach by 8.1 and 11.1 mm, as their first compiles do. Where it does move, it does as well on Earth as the last version or better, and in orbit, where an object let go has to be held until it is constrained, it falls behind on every clip. The wave has nothing to perturb and no baseline.

```bash
node_modules/.bin/vitest run tests/saboteur/baseline.test.ts tests/saboteur/scoreboard.test.ts --silent=false
```

## 18. Contact on a stand-in: force-limited following

Issue #160: an on-body clip (lip balm, cream) rehearsed as the arm applying the held object to someone else, gently. There is no person in the simulation: the stand-in is a fixed primitive with a size (role `surface`), and the step is the new `apply` verb with a `contact` block (surface, path in the surface's frame, force limit, reach, coverage). The `contact` op (`lib/sim/contact.ts`) goes to a stand-off 30 mm out along the surface normal, comes in at 40 mm/s and from 25 mm out at 8 mm/s until MuJoCo reports a contact of at least 0.05 N, follows the path at 15 mm/s while a force loop moves the commanded depth by the error against half the limit and a second loop shifts the commanded point across the path by the measured distance from the contact to it, then leaves at 8 mm/s. Every number below is read from MuJoCo each 5 ms step: the normal force of every contact between the held object and the stand-in (`mj_contactForce`), where those contacts are, any contact between the arm itself and the stand-in, and the speed of the held object's contact point along the normal within 15 mm of the surface.

Setup (`tests/sim/contact.test.ts`): the applicator is a 16 x 70 mm cylinder on a block, gripped from the front; the force limit is the default 2 N (a setting, not a safety figure), the reach 3 mm and the coverage wanted 90%. Two stand-ins: a 70 x 200 x 50 mm box on the table, the path an S of 126 mm across its top face, and a 160 mm sphere, the path an 82 mm arc over its top (27° from the top at its ends). Each of 20 seeds moves the stand-in by up to 15 mm in x and y, 5 mm in z and 15° in yaw, and the applicator's block by up to 5 mm; the program is told the true poses (sensed). One hand-written program, no model.

| Stand-in, gravity | Pass | 95% Wilson | Coverage, lowest | Peak force, highest (limit 2 N) | Mean force while following | Time in contact, mean | Approach / retreat speed within 15 mm, highest |
|---|---|---|---|---|---|---|---|
| Box, 1 g | 20 of 20 | 84 to 100% | 100% | 1.23 N | 0.99 N | 9.0 s of 8.8 s of path | 8.2 / 11.7 mm/s |
| Box, 0 g | 20 of 20 | 84 to 100% | 100% | 1.22 N | 0.99 N | 9.0 s | 8.4 / 12.0 mm/s |
| Sphere, 1 g | 0 of 20 | 0 to 16% | 94% | 2.41 N | 0.98 N | 6.0 s of 5.8 s of path | 12.5 / 10.2 mm/s |
| Sphere, 0 g | 0 of 20 | 0 to 16% | 94% | 2.41 N | 0.97 N | 6.0 s | 13.8 / 10.4 mm/s |

The arm itself never touched a stand-in. On the flat face the force peaks at most 0.23 N above its 1 N target. On the sphere the mean holds at the target but the peak goes over the 2 N limit on every seed, by 0.28 to 0.41 N, so the curved stand-in fails 0 of 20 at both gravities: force-limited following works here on a flat face and not on a curved one. That is the result as measured, not tuned away. An earlier run that cut the path into samples before moving them onto the sphere (so its samples sat closer together than 1 mm on the surface) passed 17 and 20 of 20 with peaks of 2.04 and 2.00 N: the margin on a curved surface is that thin. Time in contact is longer than the path because the contact starts on the approach and lasts through a 0.4 s dwell at the end. The move out to the stand-off is measured too: a stand-in in the way of it fails the step (`tests/sim/contact.test.ts`), and on the sphere that move brings the applicator within 15 mm of the surface at up to 12.5 and 13.8 mm/s, faster than the 8 mm/s of the approach proper (the speeds are measured, not limited, and the step does not fail on them). Speed and coverage are measured against the surface where MuJoCo has it, not where the program was told it is.

What it took, on the box as placed with no seed: before the loop across the path, the contact ran 2.6 to 4.5 mm off the path (the held object sits a few mm off its commanded pose under the contact's own push, and MuJoCo puts the contact of a tipped cap partway between its centre and its rim), and covered 39 to 41% within 3 mm. Without the slow zone starting 10 mm before the 15 mm where speed is measured, the approach crossed it at 40 mm/s, as a position actuator lags its command.

## Reproduce

Run from the repository root. Paid scripts read the key from the file named by `UNDERSTUDY_ENV_FILE` (never printed) and log every call to `bench/results/ledger.jsonl`; `node scripts/bench-ledger.mjs` prints the spend. Since 27 October the Nano and Super roles call their replacements (section 12): add `UNDERSTUDY_KEEP_RETIRED=1` to rerun a Nano or Super row while Token Factory still serves them, until 9 November 2026.

```bash
pnpm test
```

```bash
MEASURE_WRITE=1 node_modules/.bin/vitest run tests/measure tests/sim/fluid.test.ts --reporter=verbose
```

```bash
BROWSER_PATH=<chromium or edge binary> node scripts/bench-hands.mjs
```

```bash
UNDERSTUDY_ENV_FILE=.env.local node scripts/bench-session.mjs
```

```bash
UNDERSTUDY_ENV_FILE=.env.local node scripts/bench-label.mjs --runs 5
```

```bash
UNDERSTUDY_ENV_FILE=.env.local node scripts/bench-interview.mjs --passes main,thinking,v2-split --runs 3
```

```bash
BENCH_LIVE=1 UNDERSTUDY_ENV_FILE=.env.local PATCH_SCRIPT=patch-loop-r2 PATCH_SEEDS=1,2,3,4,5,6 PATCH_ARMS=r2-super-off,r2-super-on,r2-esc-on node_modules/.bin/vitest run tests/measure/patch-loop.test.ts --reporter=verbose
```

`PATCH_ARMS=` with no arms reprints every patch-loop table from the saved results without spending anything.

Section 8, the playbook on the site (under its own US$0.25 cap on the ledger):

```bash
BENCH_LIVE=1 UNDERSTUDY_ENV_FILE=.env.local PLAYBOOK_RUNS=8 node_modules/.bin/vitest run tests/measure/playbook.test.ts --reporter=verbose
```

Section 10 (other models; every call is charged to the ledger under the comparison's own US$25 cap):

```bash
UNDERSTUDY_ENV_FILE=.env.local node scripts/bench-compare-probe.mjs
```

```bash
BENCH_LIVE=1 UNDERSTUDY_ENV_FILE=.env.local PATCH_OUT=compare-patch.json PATCH_SCRIPT=compare-patch PATCH_SEEDS=1,2,3,4,5,6 PATCH_CONCURRENCY=4 PATCH_ARMS=cmp-gpt-oss-120b-off,cmp-gpt-oss-120b-on,cmp-qwen3.5-397b-off,cmp-muse-spark-off,cmp-muse-spark-on node_modules/.bin/vitest run tests/measure/patch-loop.test.ts --reporter=verbose
```

```bash
BENCH_LIVE=1 UNDERSTUDY_ENV_FILE=.env.local COMPILE_RUNS=3 COMPILE_CONCURRENCY=3 COMPILE_MODELS=nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B,Qwen/Qwen3-30B-A3B-Instruct-2507,openai/gpt-oss-120b,Qwen/Qwen3.5-397B-A17B,meta-models/muse-spark-open node_modules/.bin/vitest run tests/measure/compile-compare.test.ts --reporter=verbose
```

```bash
UNDERSTUDY_ENV_FILE=.env.local node scripts/bench-label.mjs --runs 5 --clips iss --conditions a,b,c,d,e,f,g --model meta-models/muse-spark-open
```

```bash
node scripts/compare-report.mjs --json bench/results/compare-summary.json
```

The last one prints section 10's tables from the saved results without spending anything. Token Factory withdrew Qwen3.5 397B for a while on 26 October; if a model named here is not served when you run these, the command stops at its first 404 and the report leaves the stopped run out.

Section 12, the replacements against the models they replace. The compile bench names the models it compares; the patch bench reads the Super role, which is Super VL by default and Super with `UNDERSTUDY_KEEP_RETIRED=1`:

```bash
BENCH_LIVE=1 UNDERSTUDY_ENV_FILE=.env.local COMPILE_OUT=successor-compile.json COMPILE_RUNS=3 COMPILE_CONCURRENCY=3 COMPILE_MODELS=nvidia/Nemotron-3_5-Lightning,nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B node_modules/.bin/vitest run tests/measure/compile-compare.test.ts --reporter=verbose
```

```bash
BENCH_LIVE=1 UNDERSTUDY_ENV_FILE=.env.local PATCH_OUT=patch-successor.json PATCH_SCRIPT=patch-successor PATCH_SEEDS=1,2,3,4,5,6 PATCH_CONCURRENCY=4 PATCH_ARMS=r2-super-off,r2-super-on,r2-esc-ultra node_modules/.bin/vitest run tests/measure/patch-loop.test.ts --reporter=verbose
```

```bash
BENCH_LIVE=1 UNDERSTUDY_KEEP_RETIRED=1 UNDERSTUDY_ENV_FILE=.env.local PATCH_OUT=patch-successor-base.json PATCH_SCRIPT=patch-successor-base PATCH_SEEDS=1,2,3,4,5,6 PATCH_CONCURRENCY=4 PATCH_ARMS=r2-super-off,r2-esc-on,r2-super-on node_modules/.bin/vitest run tests/measure/patch-loop.test.ts --reporter=verbose
```
