# Limitations and what the rehearsal does and does not prove

**What a pass proves:** the clarified spec is executable by a scripted SO-101 program across the stated band in rigid-body physics with a geometric grasp, and the success criteria are computable; not that a learned policy would succeed or a real grasp holds. If Sunday's go/no-go fails, the stage becomes a kinematic replay and all physics claims are removed.

## Honest limits

Every piece exists (MediaPipe; GPT-4V for Robotics, SeeDo, GF-VLA; MimicGen, DexMimicGen, GR00T-Mimic; IWSDS 2026, AmbResVLM; GR00T-Dreams, Nebius robot-sdg). New is the loop and its measurement: a cheap model plays the robot and its compile errors are the questionnaire; the answers become tolerance bands; a reasoning model turns bands into falsifying scenarios chosen from object symmetry; the simulator runs them blind and sensed, so the output is a perception requirement per axis, a spec with per-field provenance and a reshoot list on a GR00T-layout skeleton. The answers are the demonstrator's claims; the rehearsal checks whether a scripted program can honour them, not whether they are true. Limits: one 5-DoF arm plus gripper, geometric grasp, primitive objects, approximate calibration, a format-valid skeleton.

## Simulated versus real

- One 5-DoF arm plus a gripper (SO-101 from MuJoCo Menagerie); no humanoid, no dexterous hand.
- Hands: MediaPipe's hand model returns nothing on nitrile gloves and on hands under about thirty pixels. The sepia wrist crop recovers hands in many frames of the ISS clip, not all; where it does not, the pose model's wrist carries the motion and the hand aperture is an interview question, not a measurement.
- Grasp is a geometric weld gate: no friction, no slip, no deformation.
- Gestures (a wave, a signal): the path is the pose model's estimate of the centre of one hand (its wrist, index and pinky landmarks) in the person's frontal plane (depth is dropped), scaled by the ratio of the arm lengths into a plane in front of the robot and centred there. The only check is that the point between the pads passes within the stated distance of each point of the path, in order and at most a quarter of a second after the point's own time; a gesture has no task success. When a joint would have to turn faster than 2 rad/s the arm follows slower than the clip, and the page says by how much; that cap was chosen from the simulation, not from a real servo.
- The demo scene stands in for the NASA seed film clip with primitives: the film is a stiff 15 x 6 x 40 mm strip (a real film is far thinner and flexible, too thin for the gripper) and the plant pillow a rigid box with a pocket 5 mm wider than the strip.
- Objects are primitives sized from a monocular clip; sizes are approximate and are the first thing the interview checks.
- The exported dataset is a format-valid LeRobot v2.1 skeleton for GR00T's loader with scripted, primitive-rendered episodes. It is not training data and the quality report says so.
- A pass does not predict that a learned policy or a real robot would succeed.
- The station module and the kitchen counter drawn around the arm once a program passes are decoration: three.js scenery with no part in the physics. The rehearsal always runs on the bench, and the setting says so on the stage.

## Orbit mode

Orbit mode is rigid-body physics with gravity set to 0 g (the Moon preset uses 0.1654 g). It models one thing well: a released object keeps its velocity instead of resting, so a program must constrain an object before it lets go. It does not model air currents, tethers and cable drag, contact with floating neighbours, the arm's own reaction forces on a free-flying base, flight rules, or any certification. A drifting object in the rehearsal is a model of the failure, not a flight test.
