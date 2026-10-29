# Devpost submission

Hackathon: Nebius x NVIDIA Global AI Hackathon. Submitted on 29 October; Devpost takes edits until Friday 30 October 2026, 10:00 PT (18:00 Paris). Track: Physical AI. City: Paris (Builders and Brews).

This file matches `next/after-submit` as of #215. The HTML comments name the source of each number (README, `docs/LIMITATIONS.md`, `docs/MEASUREMENTS.md`, `docs/FAILURES.md`): they are for checking, not for pasting.

## Changed since the submitted text

The submitted text is this file as it was on `main` on 29 October. Field by field, what to paste again:

- **Built with:** add Upstash Redis (the spend cap and the consent store), three.js and WebCodecs (the export's MP4s).
- **What it does:** rewritten. New: the export from Try it with an MP4 per episode drawn again from the simulator; the scoreboard on Try it; the retarget-and-replay baseline as the first bar on Try it and on /space, with its result (as good or better on Earth on three of five clips, behind in orbit on all five); the playbook switch, off by default, measured to make first-try passes worse; similar tasks for a gesture. Gone: "Next, not on the site yet: a playbook … and an export from Try it with video", and the seed film's "1, 1, then 15 of 24" scoreboard line (the baseline comparison replaces it). Now in bullets, to read fast.
- **Inspiration:** the old "Why" paragraph, unchanged.
- **How we built it:** adds the baseline's rules, the playbook's tagging, the MP4s and the route deadline that cancels calls in flight (#189). The models wording is unchanged.
- **Challenges, Accomplishments, What we learned, What's next:** new in this file. If something was typed into Devpost directly, replace it with these. The negative results (the baseline, the playbook, the gripper opening) are in Accomplishments and What we learned.
- **Testing instructions:** adds "Score every version under perturbation" and "Download the dataset (.zip)" on Try it, and the playbook switch.
- **Additional info:** "Models and why" now uses the timings and token count in MEASUREMENTS (sections 6 and 13) instead of the earlier drafts' figures; "Approach" takes the #119 wording on fine-tuning; "Output quality" evidence now comes from MEASUREMENTS sections 12 and 14; "Tavily" says the Try it export writes `grounding.json`.
- **Not Devpost fields, updated here too:** the slide table's learning row (the playbook is on the site and does not carry over), and the checklist's Tavily line.

<!-- if #159 lands (toss and catch): add one line to "What it does" and drop it from "What's next", in README's wording, with its MEASUREMENTS section. -->
<!-- if #160 lands (contact task): same. -->
<!-- if simulator fixes land (#214 / #77, scene and IK; #218 / #81, ledger and liquid): re-check the scoreboard and baseline numbers below against README before pasting. -->

## Fields

- Project name: Understudy
- Tagline: Watch an astronaut do a task once, ask what the camera could not see, rehearse it on a simulated robot on Earth and in orbit, and fix what fails.
- Track: Physical AI
- Demo URL: https://understudy-rose.vercel.app
- Repository: https://github.com/gibouu/understudy
- Video: https://youtu.be/G0QQybVRwtQ (public, 2:57)
- Built with: Nebius Token Factory, nvidia/Nemotron-3.5-Super-VL, nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B, nvidia/nemotron-3-super-120b-a12b, nvidia/Nemotron-3-Ultra-550b-a55b, nvidia/Nemotron-3_5-Lightning, Tavily, MuJoCo, MediaPipe, three.js, WebCodecs, Next.js, Vercel, Upstash Redis, NASA public-domain footage
- Pre-existing project: no
- City: Paris

## Inspiration

On a station every crew hour is scarce: NASA prices one hour of ISS crew time at $130,000 for commercial activities. The robots meant to take over routine crew work need a clear task, a rehearsed program and labelled data, and crew procedures are already filmed by the hour. The same loop serves satellite servicing and refuelling. It started as a month of internal research into robot demonstration data on the ground, where teaching a robot is expensive (GR00T N1 took about 50,000 H100 GPU-hours to pretrain) and the waste comes after collection: in DROID one recorded trajectory in six was marked failed, one vendor's model puts re-collection at 30 to 50 percent of the original budget, and nobody asks the person who did the task what mattered. Understudy is the briefing and QA layer in front of collection, on the bench and in orbit. The hackathon week is where that research became software.
<!-- every number: README, "Why" and its table -->

## What it does

One phone clip of a person doing a hands-on task (an astronaut handling samples aboard a station, a technician at a bench) becomes a task spec checked with the person and a robot program that a simulated SO-101 arm rehearses in the browser, on Earth and in orbit.

- **Ask.** Every value the program would have to guess becomes a question; each answer recompiles it. Opt-in chips add advice from the web.
- **Rehearse and patch.** When a rehearsal fails, the simulator's notes go to the model, which returns one patch at a time, up to five, until it passes. <!-- README, Built: Notes --> Each patch shows its tokens and price.
- **Similar tasks.** The model suggests similar tasks; each is compiled and rehearsed too. For a gesture (a wave), three are built from the traced path with no model: the other side, slower, and bigger (or smaller when the path already fills the box in front of the arm). <!-- LIMITATIONS, Simulated versus real: Gestures -->
- **Perturb.** On Try it, the program that passed runs under twelve perturbations, blind and sensed, at 1 g and 0 g, for a perception budget per axis (the seed film in orbit: blind 5 of 12, sensed 10 of 12). <!-- README, Built: Perturb the world; LIMITATIONS, Honest limits --> Nemotron 3 Ultra writes a reshoot list: failure classes with their evidence, open risks, what to film again.
- **Score against a baseline.** A scoreboard runs every version of the program on those twelve, on Try it and on each NASA manipulation clip of the space showcase, after a baseline, "retarget and replay": a program written by fixed rules from the label, with no model and no answers. On Earth the baseline scores as well as our last version or better on three of the five NASA clips (24 against 24, 22 against 21, 24 against 22 of 24). In orbit it falls behind on all five (3 against 15, 0 against 19, 8 against 13, 0 against 22, 0 against 22). <!-- README, Built: Scoreboard; LIMITATIONS, Honest limits --> The answers and patches earn their keep where the object has to be held until it is constrained.
- **Playbook (off by default).** A switch sends the compiler six hand-written rules from earlier fixes, each with its evidence, only for their own kind of task. Measured, it makes things worse: on four NASA pocket clips, with rules learned on the other clips, the first program passed on Earth and in orbit in 0 of 32 compiles, against 6 of 32 for a matched control and 8 of 32 with the switch off. <!-- MEASUREMENTS §8, "The playbook on the site"; README, Built: Playbook -->
- **Export.** Once the program passes in both worlds, Try it downloads the run as a LeRobot v2.1 skeleton (joint states and actions at 15 fps) with, by default, one 480x360 MP4 per episode drawn again from the simulator state: a picture of the simulation, never footage. <!-- README, Built: Download the dataset; LIMITATIONS, Simulated versus real --> The 1-minute demo ends with the same skeleton, joint values only. Both are format-valid, not checked with GR00T's loader, and not training data.

The space showcase replays recorded NASA runs with no model call; a recorded session cost 1 to 7 calls, $0.0007 to $0.0059. <!-- README, "Why" table -->
<!-- if #159 lands: one bullet, README's wording. -->
<!-- if #160 lands: one bullet, README's wording. -->

## How we built it

Nemotron 3.5 Super VL watches a 480 px proxy of the clip and labels steps, objects and their sizes; Nemotron 3 Nano compiles the spec into a robot program and turns every value it would have to guess into a question, and each answer recompiles it; Tavily search and extract add advice from the web as opt-in chips; MuJoCo WebAssembly rehearses the program in a Web Worker at 1 g and 0 g; when it fails, Nemotron 3 Super reads the simulator's failure note and proposes one patch at a time, thinking only once the loop is stuck; a pass means the spec's own success conditions held at the end of each step. The perturbation grid gets its twelve scenarios from the patching model (or builds them from the spec with no model) and runs the 24 rollouts per gravity headless in about a second <!-- README, Built: Perturb the world -->; Nemotron 3 Ultra writes the reshoot list from the run's evidence. The baseline takes the object, carries it 20 mm over the target, lowers it and lets go, with no waits and no checks <!-- README, Built: Scoreboard -->. Playbook rules are plain text tagged by kind of task (pocket, zone, pour), sent only for a spec with a step of that kind; with the switch off, the request is the one from before the playbook. The export's MP4s are drawn again in the browser with three.js and encoded with WebCodecs (H.264, else VP9). A route's deadline cancels the calls still on their way, and every route answers from a recording when there is no key. We built on Nemotron 3 Nano and Nemotron 3 Super, which Token Factory retires on 9 November, before judging; the NASA showcase recordings were made on them. Everything live runs on the Nemotron models that stay (Nemotron 3.5 Lightning, Nemotron 3.5 Super VL, Nemotron 3 Ultra), not yet tested as fully; the results on the earlier ones are a good sign. Live spend is capped at US$250 for testing and judging, and a clip of your own is kept as training data only when you tick the consent box. All calls go through Nebius Token Factory.
<!-- US$250: LIMITATIONS, "Live budget and what is kept" -->

## Challenges we ran into

- **Gloved hands, far away.** On the ISS clip the hands are about twenty pixels wide and gloved, and MediaPipe found none. A sepia crop around each wrist finds them in 149 of 360 frames. <!-- MEASUREMENTS §2 -->
- **The vision model misreads the scene.** Super VL never named the seed film (0 of 35 labels) and called the plant pillows battery packs or hard drives in 23 of 35. The person's answers are there to fix that. <!-- MEASUREMENTS §6 -->
- **Models retired mid-week.** Token Factory retires Nano and Super on 9 November. Their replacements had to be measured on the same benches. Super VL with thinking on returned no answer within 4,096 tokens in 540 of 654 calls, so a stuck patch loop now goes to Ultra with thinking off. Super VL escalating to Ultra fixes 89%, against 94% for Super escalating to its own reasoning. <!-- MEASUREMENTS §12 -->
- **People's own clips.** 10 of 16 first label answers were rejected, each for a field written as null. After the fix, 16 of 16 were right on the first answer. <!-- MEASUREMENTS §14 -->
- **Liquid at 60 fps.** The pour is a particle fluid, capped at 600 particles to hold the frame rate. <!-- LIMITATIONS, Simulated versus real; MEASUREMENTS §5 -->

## Accomplishments that we're proud of

- **The loop works end to end, in a browser tab.** Clip, questions, rehearsal on Earth and in orbit, patches, perturbations, scoreboard, export. Every stage also replays from a recording, so the site works with no key.
- **Repair from the simulator's notes.** On the bench's probe programs, the escalating patcher fixed 94% of the solvable failures (91% of all) within five patches, at $0.0024 per fixed case. <!-- MEASUREMENTS §8 -->
- **A liquid model that holds up.** Its drain time is within 2.8% of Torricelli's law. <!-- MEASUREMENTS, headline numbers and §5 --> It also overturned a conclusion: with beads, pouring in orbit looked infeasible; with the liquid, turning the cup over in one second lands the water and keeps it there in 3 of 6 seeds. <!-- MEASUREMENTS §8, "The liquid model changes the pour" -->
- **People's own clips reach a rehearsal.** 101 of 104 kept labels have something to rehearse after one answer. <!-- MEASUREMENTS §16 -->
- **We published our negative results.** A scripted baseline matches or beats us on Earth on three of five clips. Our playbook makes first tries worse. The rehearsal ignores the gripper opening. Three failing rollouts are written up, each replayed by a test. <!-- FAILURES -->

## What we learned

- **A baseline keeps you honest.** Fixed rules with no model match or beat our last program on Earth on three of five clips. Ours wins in orbit, on all five, where a released object drifts unless the program holds it. <!-- README, Built: Scoreboard -->
- **The playbook does not carry over.** On the bench's knob programs, rules learned on Earth and Mars lifted the cheap model's first-try success on the Moon and in orbit by 28 points (5% to 33%). On the site's own compile, on four NASA pocket clips, rules from the other clips lowered it by 19 points against a matched control (0 of 32 against 6 of 32). They are specific to the clip they came from. <!-- MEASUREMENTS §8 -->
- **A pass says less than it looks.** The rehearsal does not read the gripper opening: a 5 mm grasp on a 25 mm object passes, and a box 120 mm across is held. <!-- FAILURES, case 3 -->
- **The simulator's notes, as text, carry most of a fix.** From the failure note alone, on the bench, Super fixed 69% of the solvable failures with thinking off and 94% when it escalated to reasoning. <!-- MEASUREMENTS §8 -->
- **Nemotron did not win on accuracy.** Against other models on Token Factory, it won on video: of the eleven models we tried, only Super VL and Muse Spark read a clip. <!-- MEASUREMENTS §10 -->

## What's next for Understudy

- The scoreboard's passes in the Try it export. <!-- README, Next -->
- Video in the 1-minute demo's export, and an export loaded by GR00T's loader. <!-- README, Next -->
- The Moon (0.1654 g) on Try it; it is on `/stage` today. <!-- README, Next -->
- The answers as tolerance bands. <!-- LIMITATIONS, Honest limits -->
- A grasp that reads the commanded opening, so a wrong aperture can fail. <!-- FAILURES, case 3 -->
- Playbook rules that carry over, measured against the same matched control.
<!-- if #159 does not land: gib may name the toss and catch here. -->
<!-- if #160 does not land: gib may name the contact task here. -->

## Testing instructions for judges

Chrome on a laptop, https://understudy-rose.vercel.app. No account and no key needed.

1. **Watch the 1-minute demo:** one recorded NASA run, step by step, with the arm rehearsing live in the browser and no model call. The last step downloads it as a LeRobot v2.1 skeleton (joint values, no video; format-valid, not checked with GR00T's loader, not training data).
2. **Space showcase:** recorded runs of NASA clips; the arm rehearses every version of the program in the browser, with no model call, so it works whatever the state of the credits. On a clip's page, "Score every version under perturbation" runs the baseline, then every version.
3. **Try it:** pick "ISS: seed film into a plant pillow". A sample answers from its recording where it has one and live otherwise, and each section names the model that answered. The recorded answers are filled in: click "Answer and recompile", then "Rehearse on Earth, then in orbit"; the Notes patches follow when it fails. Once it passes: "Perturb the world", then "Score every version under perturbation"; "Write the reshoot list"; and, in section 8, "Download the dataset (.zip)". The "Use the playbook" switch above the questions is off by default.
4. **Your own clip:** tick the consent box and enter the unlock code given in the submission (an MP4 or an iPhone .MOV, one person, fixed phone; the page says so if the browser cannot decode HEVC).

A live call that Token Factory refuses shows as failed on the page. Live calls stop at US$250 at list prices; after that every step replays its recording and says why. <!-- LIMITATIONS, Live budget -->

## Numbers for the slides and the video

Every number below was checked twice against its page on 25 October 2026; the sources and the cost model are in `docs/research/market.md`.

| Slide line | Number | Source |
|---|---|---|
| One hour of ISS crew time (NASA's reimbursable value, commercial activities) | $130,000 | NASA pricing policy |
| The ISS, per year | about $3 billion, a third of NASA's human spaceflight budget | NASA Inspector General, 2021 |
| Crew time on upkeep, 2017 to 2023 | 20% of scheduled operations hours, against 24% for science | NASA, ICES-2024-132 |
| Gateway crew aboard | as little as six weeks a year; the rest is caretaking without crew | NASA ISAAC project |
| Pretraining GR00T N1 | about 50,000 H100 GPU-hours | GR00T N1 paper |
| Synthetic data for GR00T N1 | 780,000 trajectories, worth 6,500 human hours, in 11 hours | GR00T N1 paper |
| Robot data behind pi0 | more than 10,000 hours | pi0 paper |
| Demonstrations marked failed at recording | about 1 in 6 (DROID) | DROID paper |
| Re-collection after the first policy evaluation | 30 to 50% of the original budget (one vendor's model) | Robotics Center, March 2026 |
| A recorded session in the space showcase | 1 to 7 calls, $0.0007 to $0.0059 (the seed film: 7 calls, $0.0040) | `public/showcase/*.json` |
| Failing rehearsals fixed from simulator notes (bench harness, small probe programs) | of solvable failures, within 5 patches: 69% (cheap model), 94% (escalating to reasoning; 91% of all failures), $0.0024 per fix | `docs/MEASUREMENTS.md` |
| Learning across tasks, Moon and orbit (bench harness) | rules learned on Earth and Mars: first try +28 points with the cheap model (5% to 33%), +18 with reasoning (48% to 67%), against matched controls. On the site's own compile the playbook does not carry over: 0 of 32 first tries against 6 of 32 for a matched control | `docs/MEASUREMENTS.md`, section 8 |
| A tube let go at the slot mouth | seats on Earth, Mars and the Moon; floats 30 mm up in orbit | `docs/MEASUREMENTS.md` |
| Liquid model against physics | pour time within 2.8% of Torricelli's law; surface tilt within 0.09° | `docs/MEASUREMENTS.md` |
| Saving on a 500-demonstration campaign | 3%, 10% or 25% of the collection budget if Understudy avoids a tenth, a quarter or half of re-collection; the share is a model, its inputs are measured (a naive program fails 86% of disturbed runs; fixing one costs $0.0024) | `docs/research/market.md`, section 5; `docs/MEASUREMENTS.md`, section 9 |

Say "one vendor's model" whenever the 30 to 50% figure is used: only one source has published it. The $0.0375 session in `docs/MEASUREMENTS.md` section 1 was measured with prototype prompts for stages the site does not have (the saboteur, the interview by Super, Ultra's reshoot list at 73% of it): do not quote it as the price of a session on the site.

## Pre-existing work (Devpost field)

The concept and the research behind Understudy come from a month of internal work that began in late September 2026, inside the Submission Period; no code existed before it. Everything in this repository was written from 23 October 2026 (see the commit history) on Nebius Token Factory with NVIDIA's Nemotron models.

## Checklist (from spec v2, section 15)

- **Track: Physical AI**, committed. "How it meets Physical AI": simulated SO-101 embodiment, the closed loop (rehearse, fail, patch from the simulator's notes, rehearse again), Earth and orbit gravity, `wait_until` per step.
- **README:** built-for line; architecture; which-model-does-what with exact IDs; the real `chat.completions.create` block; "Other Nebius services" (Job log or "none"); setup under ten commands; "Simulated versus real"; "Limitations and failure cases" with three documented failing rollouts (`docs/FAILURES.md`); prior art; testing instructions (Chrome on a laptop; sample clips answer from their recordings where they have one; the unlock code enables uploads).
- **License:** Apache-2.0 at root; Menagerie and MediaPipe notices; no CC-BY-NC components.
- **Feedback:** one block per tool (onboarding, Super VL, Nano, Super, Ultra, Tavily, Serverless Jobs): used for, worked, needs work, minutes to hello-world, build again; the v1 gap list plus Friday's findings.
- **Tavily bonus:** runtime `search` plus `extract` in `/api/ground`, request ids and credits on screen; the Try it export writes `grounding.json` when the web lookup ran.
- **Devpost:** Inspiration, What it does, How we built it, Challenges, Accomplishments, What we learned, What's next; Built With tags for Token Factory, the Nemotron models the routes call, Tavily, MuJoCo, MediaPipe, Next.js, Vercel; demo URL, repo, sample clips; not pre-existing; public YouTube under three minutes; secrets scan.

## Feedback section (Most Valuable Feedback award)

One block per tool, filled from `docs/FEEDBACK.md`: used for, what worked, what needs work, minutes to hello-world, would we build on it again. Tools: Token Factory onboarding and credits, Nemotron 3.5 Super VL, Nemotron 3 Nano, Nemotron 3 Super, Nemotron 3 Ultra, Tavily, Nebius Serverless Jobs.

## Elevator pitch (200 characters)

Watch an astronaut do a task once, ask what the camera missed, rehearse it on a simulated robot on Earth and in orbit, and fix what fails. Nemotron on Nebius Token Factory.

## Thumbnail

`docs/submission/thumbnail.jpg` (1800 x 1200, 3:2): the astronaut on the ISS, the robot's question from the recording, the simulated SO-101 doing the task at 0 g. Source and how it is made: `docs/submission/README.md`.

## Additional info (organiser questions), draft answers

- **Submitter type / organisation:** team; organisation "N/A" unless gib wants KUZOG named. **Country:** France. **Canada province:** N/A.
- **Track:** Physical AI. **New or existing before 26 August 2026:** new (research began late September, code from 23 October).
- **Repository:** https://github.com/gibouu/understudy. **Demo URL:** https://understudy-rose.vercel.app. **Video:** https://youtu.be/G0QQybVRwtQ.
- **Models and why:** `nvidia/Nemotron-3.5-Super-VL` because it is the hosted NVIDIA model that takes video, and one call labels a whole clip (the 36 s ISS clip is 6,379 tokens <!-- MEASUREMENTS §6 -->); `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` for the compile step that runs after every answer and writes the robot's questions (fast and cheap: 1.2 to 4.6 s a call in the recordings, one outlier aside <!-- MEASUREMENTS §13 -->); `nvidia/nemotron-3-super-120b-a12b` for the patches and the similar tasks (reasoning only when the patch loop is stuck; 0.7 to 1.1 s a patch with thinking off <!-- MEASUREMENTS §13 -->); `nvidia/Nemotron-3-Ultra-550b-a55b` for a stuck patch loop (a patch that changes nothing, or two failed patches), live, because Super VL, in Super's place since 27 October, cannot think within the patch budget. Token Factory retires Nano and Super on 9 November, so live calls use `nvidia/Nemotron-3_5-Lightning` and `nvidia/Nemotron-3.5-Super-VL` in their place; the showcase recordings were made on Nano and Super.
- **Output quality (1 to 10):** gib's call. Evidence: Lightning's first compile answer is clean in 93% of compiles, Nano's in 67% <!-- MEASUREMENTS §12 -->; on people's own clips, labels right on the first answer went from 6 of 16 to 16 of 16 after the null fix <!-- MEASUREMENTS §14 -->.
- **Approach:** out of the box, prompt-engineered, with structured output; no fine-tuning on the site. Token Factory fine-tunes no NVIDIA model; a Nemotron fine-tuned on our repairs would run on Nebius AI Cloud, and it stays off the site and out of this submission.
- **Comparison to other models** (measured in `docs/MEASUREMENTS.md` section 10): We ran other models through the same harness, cases and seeds on Token Factory. Repairing failed robot programs from simulator notes, Nemotron 3 Super with reasoning fixed 94% of 180 failures, level with gpt-oss-120b (92%), which cost less than half as much per fix, and below Meta's larger Muse Spark (100%, at 1.8 times Super's cost per fix); with reasoning off, Super (69%) trailed Qwen3.5 397B (87%), and the same-size Qwen3 30B wrote a clean first program more often than Nemotron 3 Nano (98% against 55 to 70%). Where Nemotron stood out was video: Nemotron 3.5 Super VL was one of only two models on Token Factory that read a clip (we tried every model there that takes images), and the cheaper and faster of the two, though Muse Spark read the scene better (it never called the plant pillows batteries or drives, which Super VL did in 23 of 35 labels; their rubric scores were level, 46% against 42%), and neither named the object in our hardest clip. So Nemotron did not win on accuracy; it won on video input and on covering all four jobs with one model family and one thinking switch, and every number is in docs/MEASUREMENTS.md.
- **Nebius capabilities:** the OpenAI-compatible Token Factory API with `video_url` input, structured outputs, prefix caching and the verbose model catalog (prices and limits used for the prices on the page). No Serverless Job runs behind the site; Token Factory fine-tuning trained a LoRA stand-in (Qwen3 30B, not a Nemotron) with no measured result yet (`docs/FINETUNE.md`).
- **Recommend (1 to 10), experience versus other clouds (1 to 10):** gib's call; evidence in `docs/FEEDBACK.md`.
- **Improvements wanted:** an image cap above 8 per request or a documented limit in the API error before the call; `reasoning_effort: none` emptying Nano's answer; unknown parameters accepted silently; image and video token counts in the usage object.
- **Hope from the Nemotron team:** a hosted Cosmos Reason or GR00T on Token Factory; fine-tuning for Nemotron.
- **Tavily:** yes: `/api/ground` runs `search` and `extract`, the opt-in chips on Try it carry their source URLs, and the Try it export writes them to `grounding.json`.
- **City:** Paris. **AI tools used:** Claude Code (Fable 5.1), OpenAI Codex for second-model review, Nemotron for the product itself. **Learning / career value:** to write in gib's words.
