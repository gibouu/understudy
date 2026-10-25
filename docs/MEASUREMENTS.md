# Measurements

What Understudy does today, measured on 25 October 2026 rather than estimated. Every number below comes from a script or a test in this repository, and its raw output sits in `bench/results/`. The commands to reproduce each one are at the end.

Machine for the local runs: Apple M4, Node 24, one thread, MuJoCo WebAssembly 3.17. Model calls: Nebius Token Factory at the list prices saved in `tests/fixtures/models.json` on 23 October 2026. Spend for every paid call is logged in `bench/results/ledger.jsonl`, with a hard cap of US$90.

## Headline numbers

| What | Measured | Section |
|---|---|---|
| One full session on Token Factory | 16.7 calls, 51k tokens, US$0.0375 (US$0.028 to US$0.052 over 3 runs), 71 s | 1 |
| Hands found on the gloved, far-camera ISS clip | 149 of 360 frames from wrist crops; 0 before | 2 |
| Arm accuracy | median tip error 0.27 mm, max 1.9 mm, over 436 targets | 3 |
| Rehearsal speed, headless | 24 rollouts per gravity, all 12 scenario worlds, in 0.3 s | 3 |
| A tube let go at the slot mouth | seats on Earth, Mars and the Moon; floats 30 mm up in orbit, indefinitely | 4 |
| Lateral push that topples a standing tube | 1.59 m/s² on Earth, 0.27 m/s² on the Moon | 4 |
| Liquid model against physics | drain time within 2.8% of Torricelli's law; surface tilt within 0.09° of atan(a/g) | 5 |
| Interview recovering missing details | 21% with the first design, 43% with a separate answer-to-change call | 7 |
| Failing rehearsals fixed from simulator notes alone | 69% (Super), 94% (Super with reasoning, or escalating to it when stuck) within 5 patches | 8 |
| Learning across tasks, Moon and orbit | first-try success 5% to 67%, five-patch success 93% to 100%, with 2 rules learned on Earth and Mars | 8 |
| Pouring with a real liquid model | far harder to fix than beads (48% against 88%), and pouring in orbit turns out feasible | 8 |

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

Ultra's reshoot list is 73% of the cost and most of its variance (4.6k to 10.1k reasoning tokens). No call returned an error, an empty answer or invalid JSON. Found on the way: the saboteur sometimes wrote 5 scenarios instead of 12 and twice left gravity out; Nano with thinking off sometimes compiled a program without its `ask` slots.

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
- **Speed.** A 3 s rollout of the arm in the demo scene takes about 5 ms. All 24 rollouts of one gravity, with the 12 scenario worlds compiled, take 0.28 s on Earth, 0.28 s on the Moon and 0.25 s in orbit, about 250 times real time. Played visibly in the browser at real time the same grid takes 72 s per gravity, so the fast path needs a headless batch mode in the worker.
- **Scenarios.** All 12 perturbation scenarios build and load next to the arm; 11 change the world measurably; the twelfth, a yaw on the symmetric tube, is flagged as a no-op.

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

A throw at 0 g against a wall checks that the liquid really behaves as one (mean compression 0.1%, spread 8 times along the wall) while a control with the pressure solve off fails the same check (350% compression). About 1,200 particles fit a 60 fps frame next to MuJoCo on an M4. Limits: one-way coupling, 4 to 5 mm particles, volume about 5% low, surface tension not calibrated to water; the remaining limits (density near redundant or rotated walls, particles interacting across the outer corner of a thick wall) are listed at the top of `lib/sim/fluid.ts`. Codex reviewed the solver in three rounds; its 18 findings are fixed, each with a regression test that fails on the earlier code, and two further limits were removed after the review (an exact fallback for fast thin rotating solids, and a hashed grid so one stray particle no longer slows every frame).

## 6. Labelling the hero clip

`scripts/bench-label.mjs`, Super VL on the ISS clip, 5 runs per condition, scored against a ground truth written by watching the frames (verb, main object, fixture type, step count, size).

- In 0 of 35 labels across seven input conditions (frame rate, width, keyframes, thinking on) does the model name the seed film as the object moved; 26 of 35 call the pillows battery packs or hard drives.
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

A naive program, written the way a person would do the task, fails in 90 of 108 runs at iteration 0: the disturbances (a hand-off velocity, an offset, a vehicle burst, orbit) break it. Six seeds per case, fix rates with Wilson 95% intervals:

| Patcher | Fixed within 5 patches | Fixed on the first patch | Cost per fixed case | Model time per fixed case |
|---|---|---|---|---|
| Super, thinking off | 69% [62 to 76] (125 of 180) | 26% | US$0.0015 | 12 s |
| Super, thinking on (4k) | 94% [89 to 97] (169 of 180) | 50% | US$0.0032 | 23 s |
| Escalation: Super off, then Super on when stuck | 94% [89 to 97] (169 of 180) | 28% | US$0.0024 | 16 s |
| Escalation to Ultra, thinking off | 91% [86 to 94] (164 of 180) | 27% | US$0.0023 | 9 s |
| Ultra, 16k reasoning (3 seeds) | 94% [88 to 98] | 80% | US$0.045 | 39 s |

The learning curve for the escalating patcher, share of failing rehearsals fixed after each patch: 0%, 28%, 56%, 81%, 87%, 94%. The cheap model alone stalls on lateral offsets (it never used the measured "4.1 mm from the pocket centre"); escalation takes insert from 45% to 97%.

**Learning across tasks.** Rules distilled by Super from 16 Earth and Mars repairs, tagged by task and shown only for their own task, were given to the patcher on the Moon and in orbit (120 runs per arm):

| Patcher | Rules | First try | Within 5 patches |
|---|---|---|---|
| Super, thinking on | none | 5% | 93% [87 to 97] |
| Super, thinking on | 2 tagged rules | 67% | 100% [97 to 100] |
| Super, thinking off | none | 5% | 82% [74 to 88] |
| Super, thinking off | 2 tagged rules | 33% | 85% [78 to 90] |

With the rules and reasoning, Super declares the orbit pour infeasible before the first rollout in 12 of 12 runs, for the bead model.

**The liquid model changes the pour.** Re-run on the liquid solver (600 particles, one-way coupled), the same loop fixes far fewer pours: 19% [10 to 32] with Super thinking off and 48% [34 to 62] with thinking on, against 79% and 88% with beads. Most failures sit at 75 to 88% of the water in the target, lost along the lip as the water wets the walls. And in orbit, turning the cup over in one second and waiting lands the water and keeps it there in 3 of 6 seeds, so "pouring in orbit is infeasible" was an artefact of the bead model. No patcher found that throw. This is the reason to keep the liquid model: it changes conclusions, not only numbers.

Limits: the program is 2 to 4 bounded knobs, not the full interpreter; the failure notes are written by the probes (measured facts, never knob names or answers, checked by a test); seeds mostly vary the model's sampling. Spend for both rounds: US$10.60.

## 9. What this changes in the savings model

The market brief (`docs/research/market.md`, section 5) prices the saving on a 500-demonstration campaign from one vendor's re-collection figure (30 to 50% of the original budget) and a share of that re-collection avoided. That share is still a model: it can only be measured on a real collection campaign, before and after. What is now measured is everything around it:

- **What finding a failure costs.** A naive, human-like program fails 83% of the disturbed scenarios above. The rehearsal finds those failures in 0.3 s per gravity, with no robot and no operator.
- **What fixing one costs.** The escalating patcher fixes 94% of them within five patches, for US$0.0024 of model calls per fixed case and about 16 s of model time.
- **What a session costs.** US$0.0375 on average for the whole session, measured.
- **What the bench cannot see.** Orbit and the Moon turn passing programs into failing ones (a tube let go at the slot mouth seats on Earth and floats in orbit; a free-standing tube topples at a sixth of the push on the Moon), and the liquid model turns an "infeasible" task into a feasible one. Each of those would otherwise surface on the real system.

So the saving per failure the rehearsal catches is the cost of finding it on hardware, minus about a quarter of a cent. Whether that adds up to the 3, 10 or 25% of a campaign budget in the brief's scenarios depends on how many of a campaign's re-collections come from failures of this kind, and that needs a real campaign to measure.

## Reproduce

Run from the repository root. Paid scripts read the key from the file named by `UNDERSTUDY_ENV_FILE` (never printed) and log every call to `bench/results/ledger.jsonl`; `node scripts/bench-ledger.mjs` prints the spend.

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
