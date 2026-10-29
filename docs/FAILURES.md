# Three failing rollouts

Issue #24 names three classes of failure: an insertion collision, an unreachable target, a wrong aperture. The first two are below as recorded failing rollouts of a scripted SO-101 program. The third cannot fail in this rehearsal, because it does not simulate a commanded aperture; case 3 shows that with two constructed rollouts that pass, and gives the nearest failure it does produce, a grasp that misses. Each case is replayed with no model call by `tests/sim/failures.test.ts`, which asserts the simulator's reasons exactly as quoted here, the recorded model output quoted here, and the sizes and measurements given here, so they cannot drift from the code:

```bash
node_modules/.bin/vitest run tests/sim/failures.test.ts --silent=false
```

What a failure here shows is what a pass shows, turned round: whether a scripted program executes the clarified spec in rigid-body physics with a geometric grasp ([LIMITATIONS.md](LIMITATIONS.md)). None of them says how a real arm or a learned policy would do. No screenshots: the repository draws the arm only in the browser (three.js), and nothing here renders a frame headlessly.

Where a failure carries a `failure_class`, the simulator set it (`embodiment_limit` or `spec_gap`, `lib/sim/interpreter.ts`); a failed check carries none. The patching model returns no class of its own: what it thought is in its `why`, quoted as recorded.

## 1. Insertion collision (recorded program, recorded scenario)

**What was run.** The last recorded version of `public/showcase/iss-veggie-seed-film-2.json` (the program after the answers, which passes on the nominal bench at 1 g and 0 g), on its own spec: a packet of 40 x 6 x 40 mm lowered, still held, into a pocket 10 mm wider than it (`pocket_clearance_mm: 10`, an answer). The world is the scenario `tray-x+6`, "tray 6 mm off on x", one of the twelve the patching model (`nvidia/Nemotron-3.5-Super-VL`) wrote for this spec, recorded in `tests/fixtures/saboteur.json`. The program runs **blind**: it is told the spec's pose of the tray while the tray is 6 mm away. The scoreboard on `/space/iss-veggie-seed-film-2` runs this same rollout: the last version on the twelve, blind and sensed, at 1 g and 0 g.

**What the simulator said**, at 1 g (s2, op 3, `assert inside_zone`):

> obj2 is 5.8 mm from obj1's centre, not inside it

At 0 g, blind: "obj2 is 5.7 mm from obj1's centre, not inside it". Sensed (told the tray's true pose), it passes in both worlds.

**Where it ended.** Still held, its bottom 0.1 mm above the pocket floor, its centre 5.8 mm off the pocket's centre on x. Square to the pocket, it would touch the wall at 5 mm off centre, so its footprint overlaps the wall by 0.8 mm: the arm pressed the held packet down past the rim's edge, which a rigid wall would not allow and MuJoCo's soft contacts do. The program has no `no_collision` check, so the contact is not what fails; the seat check is.

**What the patching model said.** When it wrote the scenario, before any rollout: `expected: "fail"`, "past the band: packet hits the rim". The rollout fails as it predicted, though the packet ends on the floor against the wall rather than on the rim. No patch exists for it: the grid and the scoreboard measure, they do not patch.

## 2. Unreachable target (recorded run, recorded patch)

**What was run.** `public/showcase/iss-glovebox-pipette.json`, the program after the answers (iteration 1, on the spec those answers made: a 25 x 25 x 40 mm object into a cartridge pocket 10 mm wider), on the nominal bench, sensed, at 1 g and 0 g.

**What the simulator said**, at 1 g (s1, op 4, the lift after the grasp; `failure_class: "embodiment_limit"`):

> move_to pipette + (0, 0, 50) mm from top: out of reach by 8.1 mm

At 0 g: "move_to pipette + (0, 0, 50) mm from top: out of reach by 8.4 mm". The interview could not fix it: its answers set the pocket's clearance, the success check and a tolerance, not the lift.

**What the patching model did.** `nvidia/nemotron-3-super-120b-a12b`, thinking off, one call (1,315 tokens, US$0.00045), recorded in the next iteration. Its reason:

> The pipette was out of reach by ~8.2 mm when trying to lift to z=50 mm, indicating the target height exceeds the arm's capability.

Its patch: `s1.op4.z_mm` from 50 to 41.9 (nothing clamped), expecting that "Lowering the lift target to z=41.9 mm will place the pipette within reach while keeping its bottom above the cartridge pocket floor." The patched program passes at 1 g and 0 g. The same failure, by 11.1 mm, stops the first two versions of `dev-clip.json`, and the same model fixed it the same way (50 to 38.9).

This is the kept run of four (`bench/rerecord/iss-glovebox-pipette/`); in the three before it, five patches did not make the program pass.

## 3. Wrong aperture: what the rehearsal can show of it

**There is no failing rollout for a wrong commanded aperture, because the rehearsal does not simulate one.** A `grasp` op carries `aperture_mm`, and the interpreter does not read it: the jaws close until both touch the object and the moving jaw has stopped, and then the object is welded to the gripper (`lib/sim/grasp.ts`; `lib/notes/knobs.ts` says the same, which is why the aperture is no patch knob). Two constructed cases, made on purpose for this page and asserted by the test:

- the kept glovebox program with its grasp at 5 mm instead of 25 mm, for a 25 mm object: the rollout passes, at the same simulated time and with the same log apart from the grasp line;
- the same program with the object made 120 mm on a side (and the cartridge 160 mm, so its pocket can still be built): "grasp pipette: held", and the rollout passes. The gate asks that each jaw touch the object (`jawsTouch` in `lib/sim/grasp.ts`), not that the object be between them.

So a grasp aperture in a program, whether the compiler wrote it or an answer gave it, is kept with the program and not checked by the rehearsal. The nearest failure the simulator does produce is a grasp that misses.

**What was run.** The last recorded version of `public/showcase/dev-clip.json` (after its Notes patch; a 40 mm cylinder placed on a board), on the scenario `obj2-tilt-x+10`, "piece tilted 10 deg about x", written by the patching model (`nvidia/Nemotron-3.5-Super-VL`) and recorded in `tests/fixtures/saboteur.json`; at 0 g, sensed and blind alike.

**What the simulator said** (s1, op 4, `assert contact_both_pads`, after the log line "grasp obj2: missed"):

> the pads are not both on obj2

The jaws closed on the tilted piece and pushed it away instead of holding it: at the end it is not held, moves at 69.7 mm/s and is 365.8 mm from the board's centre. At 1 g, sensed, the same program on the same tilt passes.

**What the patching model said.** When it wrote the scenario: `expected: "unknown"`, "tilted cylinder may seat unevenly in microgravity". It failed at the grasp, before any seating. No patch exists for it.

## Prior art

Plans and programs written by models, and simulators that judge them, are not new. Microsoft's GPT-4V task planner turns human video into a symbolic plan with grasp types and waypoints, and its authors report hallucinations and recommend a human in the loop ([arXiv 2311.12015](https://arxiv.org/abs/2311.12015)); SeeDo does the same for pick-and-place from keyframes ([arXiv 2410.08792](https://arxiv.org/abs/2410.08792)); ReKep, VoxPoser and Code-as-Policies write constraints or policy code from language and RGB-D ([arXiv 2409.01652](https://arxiv.org/abs/2409.01652)); RoboGen and GenSim have language models build simulated tasks and their supervision ([arXiv 2311.01455](https://arxiv.org/abs/2311.01455)). UMI checks each handheld demonstration against the robot's kinematics ([umi-gripper.github.io](https://umi-gripper.github.io/)), the same question as the unreachable target above; 1X builds a learned simulator to evaluate policies across many scenarios ([1X world model](https://www.1x.tech/discover/1x-world-model)); Cosmos Reason 1 is a physical-plausibility critic ([model card](https://huggingface.co/nvidia/Cosmos-Reason1-7B)) and Gemini Robotics-ER 2 detects success from video ([docs](https://ai.google.dev/gemini-api/docs/robotics-overview)). MimicGen and DexMimicGen multiply a few demonstrations in simulation ([arXiv 2410.24185](https://arxiv.org/abs/2410.24185)). What Understudy adds is narrower: the simulator states a failure as measured text (the check, its reading, where the object ended), that text goes to the model that patches the program, and each patch, its reason and its cost are kept beside the version it produced, as in case 2 above. The sources are collected in [docs/research/market-prior-art.md](research/market-prior-art.md).
