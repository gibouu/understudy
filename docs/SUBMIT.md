# Devpost submission

Hackathon: Nebius x NVIDIA Global AI Hackathon. Submission closes Friday 30 October 2026, 10:00 PT (18:00 Paris). Track: Physical AI. City: Paris (Builders and Brews).

## Fields

- Project name: Understudy
- Tagline: Watch an astronaut do a task once, ask what the camera could not see, rehearse it on a simulated robot on Earth and in orbit, and fix what fails.
- Track: Physical AI
- Demo URL: (Vercel production URL)
- Repository: https://github.com/gibouu/understudy
- Video: (public YouTube link, under three minutes)
- Built with: Nebius Token Factory, nvidia/Nemotron-3.5-Super-VL, nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B, nvidia/nemotron-3-super-120b-a12b, nvidia/Nemotron-3-Ultra-550b-a55b, nvidia/Nemotron-3_5-Lightning, Tavily, MuJoCo, MediaPipe, Next.js, Vercel, NASA public-domain footage
- Pre-existing project: no
- City: Paris

## Answers that named a stage the site does not have (fix the form, 27 October)

Checked against `main` on 27 October: the site has no Saboteur stage (no twelve-scenario grid, no blind versus sensed runs), no reshoot list from Nemotron Ultra, no export on Try it (the 1-minute demo, added later, ends with a download: see below), no interview by Super (the questions are Nano's `ask` slots, answered on the page), no scoreboard on 24 rollouts and no playbook. Each answer below said otherwise before this change and is rewritten in this file; if it is already typed into Devpost, replace it there with the text here.

| Devpost field | What it said | Now |
|---|---|---|
| Tagline and elevator pitch | "interview them … and export the dataset" | "ask what the camera could not see … and fix what fails" |
| Description, What | perception budget per axis and per gravity, a reshoot list, a LeRobot v2.1 skeleton, Moon gravity | Earth and orbit, the patch loop, similar tasks, prices; the rest named as next |
| Description, How | Super asks the questions and writes twelve scenarios; rehearsal blind and sensed; Ultra writes the reshoot list; the export loads in GR00T's loader | Nano's questions, Tavily chips, 1 g and 0 g, Super's patches, Ultra for a stuck loop |
| Built with | LeRobot | removed; `nvidia/Nemotron-3_5-Lightning` added |
| How it meets Physical AI | blind/sensed, GR00T-layout output | the rehearse, fail, patch loop, Earth and orbit |
| Models and why | Super for the interview and the perturbation scenarios; Ultra for failure classes and the reshoot list | Super for patches and similar tasks; Ultra for a stuck patch loop |
| Nebius capabilities | a Serverless Job for the GR00T loader validation | no Serverless Job behind the site |
| Tavily | "yes once `/api/ground` ships" | yes, on Try it |
| Session cost (any answer, slide or caption) | $0.0375, 17 calls, which includes the saboteur and Ultra's reshoot list | the showcase sessions: 1 to 7 calls, $0.0007 to $0.0059 |
| Testing instructions | "Try a sample clip", the cost ledger | the space showcase and Try it, as they are |

Outside this file: the thumbnail (`docs/submission/thumbnail.html`, and the `thumbnail.jpg` / `thumbnail.png` made from it) and the home page (`app/page.tsx`) now say only what the site does: watch, ask, rehearse at 1 g and 0 g, patch; a recorded session costs 1 to 7 calls, US$0.0007 to US$0.0059. "Approach: no fine-tuning" stays true of the site, but if the fine-tune answer of PR #136 goes into Devpost the two must agree.

## Description (what, why, how)

Draft, to be finished on day five with the measured numbers:

**What.** Understudy turns one clip of a person doing a hands-on task, an astronaut handling samples aboard a station or a technician at a bench, into a task specification checked with the person, a robot program rehearsed by a simulated SO-101 arm in the browser on Earth and in orbit, and, when the rehearsal fails, the patches the model wrote from the simulator's notes until it passed, up to five. It suggests similar tasks and rehearses them too, and the patches, the similar tasks and the recorded sessions show what their model calls cost. The 1-minute demo ends by downloading the rollouts it played as a LeRobot v2.1 skeleton in the layout GR00T reads (joint values, no video; format-valid, not training data). Next, not on the site yet: perturbation scenarios run blind and sensed for a perception budget per axis, and a reshoot list.

**Why.** On a station every crew hour is scarce: NASA prices one hour of ISS crew time at $130,000 for commercial activities. The robots meant to take over routine crew work need a clear task, a rehearsed program and labelled data, and crew procedures are already filmed by the hour. The same loop serves satellite servicing and refuelling. It started as a month of internal research into robot demonstration data on the ground, where teaching a robot is expensive (GR00T N1 took about 50,000 H100 GPU-hours to pretrain) and the waste comes after collection: in DROID one recorded trajectory in six was marked failed, one vendor's model puts re-collection at 30 to 50 percent of the original budget, and nobody asks the person who did the task what mattered. Understudy is the briefing and QA layer in front of collection, on the bench and in orbit. The hackathon week is where that research became software.

**How.** Nemotron 3.5 Super VL watches a 480 px proxy of the clip and labels steps, objects and their sizes; Nemotron 3 Nano compiles the spec into a robot program and turns every value it would have to guess into a question, and each answer recompiles it; Tavily search and extract add advice from the web as opt-in chips; MuJoCo WebAssembly rehearses the program in a Web Worker at 1 g and 0 g; when it fails, Nemotron 3 Super reads the simulator's failure note and proposes one patch at a time, thinking only once the loop is stuck. Since 27 October live calls use the replacements Token Factory names for the retiring models (Nemotron 3.5 Lightning for Nano, Super VL for Super), and a stuck loop goes to Nemotron 3 Ultra; the showcase recordings were made on Nano and Super. All calls go through Nebius Token Factory.

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
| Learning across tasks, Moon and orbit (bench harness; no playbook on the site yet) | rules learned on Earth and Mars: first try +28 points with the cheap model (5% to 33%), +18 with reasoning (48% to 67%), against matched controls | `docs/MEASUREMENTS.md` |
| A tube let go at the slot mouth | seats on Earth, Mars and the Moon; floats 30 mm up in orbit | `docs/MEASUREMENTS.md` |
| Liquid model against physics | pour time within 2.8% of Torricelli's law; surface tilt within 0.09° | `docs/MEASUREMENTS.md` |
| Saving on a 500-demonstration campaign | 3%, 10% or 25% of the collection budget if Understudy avoids a tenth, a quarter or half of re-collection; the share is a model, its inputs are measured (a naive program fails 86% of disturbed runs; fixing one costs $0.0024) | `docs/research/market.md`, section 5; `docs/MEASUREMENTS.md`, section 9 |

Say "one vendor's model" whenever the 30 to 50% figure is used: only one source has published it. The $0.0375 session in `docs/MEASUREMENTS.md` section 1 was measured with prototype prompts for stages the site does not have (the saboteur, the interview by Super, Ultra's reshoot list at 73% of it): do not quote it as the price of a session on the site.

## Pre-existing work (Devpost field)

The concept and the research behind Understudy come from a month of internal work that began in late September 2026, inside the Submission Period; no code existed before it. Everything in this repository was written from 23 October 2026 (see the commit history) on Nebius Token Factory with NVIDIA's Nemotron models.

## Testing instructions for judges

Chrome on a laptop. Open the demo URL. "Watch the 1-minute demo" plays one recorded NASA run step by step in under a minute, with the arm rehearsing live in the browser and no model call; its last step downloads that run as a LeRobot v2.1 skeleton in the layout Isaac-GR00T N1.7 reads: `meta/info.json`, `modality.json` and one parquet file per passing rollout, with joint states and actions in radians at 15 fps and no video, plus `QUALITY.md` and the run's spec, program, interview, versions and ledger. It is format-valid, not checked with GR00T's loader, and not training data. "Space showcase" plays recorded runs of NASA clips, with the arm rehearsing every version of the program in the browser and no model call. "Try it" runs a sample clip or one of your own through the stages: what the model saw, the robot's questions, the rehearsal on Earth and in orbit, the Notes patches when it fails, and similar tasks; a sample answers from its recording where it has one and live otherwise, and each section names the model that answered. Uploading your own clip needs the unlock code given in the submission (H.264 MP4, one person, fixed phone). A live call that Token Factory refuses shows as failed on the page; the space showcase never calls a model, so it works whatever the state of the credits.

## Checklist (from spec v2, section 15)

- **Track: Physical AI**, committed. "How it meets Physical AI": simulated SO-101 embodiment, the closed loop (rehearse, fail, patch from the simulator's notes, rehearse again), Earth and orbit gravity, `wait_until` per step.
- **README:** built-for line; architecture; which-model-does-what with exact IDs; the real `chat.completions.create` block; "Other Nebius services" (Job log or "none"); setup under ten commands; "Simulated versus real"; "Limitations and failure cases" with three documented failing rollouts; prior art; testing instructions (Chrome on a laptop; sample clips answer from their recordings where they have one; the unlock code enables uploads).
- **License:** Apache-2.0 at root; Menagerie and MediaPipe notices; no CC-BY-NC components.
- **Feedback:** one block per tool (onboarding, Super VL, Nano, Super, Ultra, Tavily, Serverless Jobs): used for, worked, needs work, minutes to hello-world, build again; the v1 gap list plus Friday's findings.
- **Tavily bonus:** runtime `search` plus `extract` in `/api/ground`, request ids and credits in `grounding.json`, on screen.
- **Devpost:** What/Why/How; Built With tags for Token Factory, the Nemotron models the routes call, Tavily, MuJoCo, MediaPipe, Next.js, Vercel; demo URL, repo, sample clips; not pre-existing; public YouTube under three minutes; secrets scan.

## Feedback section (Most Valuable Feedback award)

One block per tool, filled from `docs/FEEDBACK.md`: used for, what worked, what needs work, minutes to hello-world, would we build on it again. Tools: Token Factory onboarding and credits, Nemotron 3.5 Super VL, Nemotron 3 Nano, Nemotron 3 Super, Nemotron 3 Ultra, Tavily, Nebius Serverless Jobs.

## Elevator pitch (200 characters)

Watch an astronaut do a task once, ask what the camera missed, rehearse it on a simulated robot on Earth and in orbit, and fix what fails. Nemotron on Nebius Token Factory.

## Thumbnail

`docs/submission/thumbnail.jpg` (1800 x 1200, 3:2).

## Additional info (organiser questions), draft answers

- **Submitter type / organisation:** team; organisation "N/A" unless gib wants KUZOG named. **Country:** France. **Canada province:** N/A.
- **Track:** Physical AI. **New or existing before 26 August 2026:** new (research began late September, code from 23 October).
- **Repository:** https://github.com/gibouu/understudy. **Demo URL:** the Vercel production URL once Vercel Authentication is off.
- **Models and why:** `nvidia/Nemotron-3.5-Super-VL` because it is the hosted NVIDIA model that takes video, and one call labels a whole clip (30 s = 5,024 input tokens); `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` for the compile step that runs after every answer and writes the robot's questions (1 s, cheap); `nvidia/nemotron-3-super-120b-a12b` for the patches and the similar tasks (reasoning only when the patch loop is stuck, 0.8 s with thinking off); `nvidia/Nemotron-3-Ultra-550b-a55b` for a patch loop stuck after two failed patches, live, because Super VL, in Super's place since 27 October, cannot think within the patch budget. Token Factory retires Nano and Super on 9 November, so live calls use `nvidia/Nemotron-3_5-Lightning` and `nvidia/Nemotron-3.5-Super-VL` in their place; the showcase recordings were made on Nano and Super.
- **Output quality (1 to 10):** to rate on day five from the hero clip; day-one evidence: valid JSON in both JSON modes on every call once thinking is off.
- **Approach:** out of the box, prompt-engineered, with structured output; no fine-tuning (no NVIDIA model is fine-tunable on Token Factory today).
- **Comparison to other models** (measured in `docs/MEASUREMENTS.md` section 10): We ran other models through the same harness, cases and seeds on Token Factory. Repairing failed robot programs from simulator notes, Nemotron 3 Super with reasoning fixed 94% of 180 failures, level with gpt-oss-120b (92%), which cost less than half as much per fix, and below Meta's larger Muse Spark (100%, at 1.8 times Super's cost per fix); with reasoning off, Super (69%) trailed Qwen3.5 397B (87%), and the same-size Qwen3 30B wrote a clean first program more often than Nemotron 3 Nano (98% against 55 to 70%). Where Nemotron stood out was video: Nemotron 3.5 Super VL was one of only two models on Token Factory that read a clip (we tried every model there that takes images), and the cheaper and faster of the two, though Muse Spark read the scene better (it never called the plant pillows batteries or drives, which Super VL did in 23 of 35 labels; their rubric scores were level, 46% against 42%), and neither named the object in our hardest clip. So Nemotron did not win on accuracy; it won on video input and on covering all four jobs with one model family and one thinking switch, and every number is in docs/MEASUREMENTS.md.
- **Nebius capabilities:** the OpenAI-compatible Token Factory API with `video_url` input, structured outputs, prefix caching and the verbose model catalog (prices and limits used for the prices on the page). No Serverless Job runs behind the site; Token Factory fine-tuning trained a LoRA stand-in with no measured result yet (`docs/FINETUNE.md`).
- **Recommend (1 to 10), experience versus other clouds (1 to 10):** gib's call; evidence in `docs/FEEDBACK.md`.
- **Improvements wanted:** an image cap above 8 per request or a documented limit in the API error before the call; `reasoning_effort: none` emptying Nano's answer; unknown parameters accepted silently; image and video token counts in the usage object.
- **Hope from the Nemotron team:** a hosted Cosmos Reason or GR00T on Token Factory; fine-tuning for Nemotron.
- **Tavily:** yes: `/api/ground` runs `search` and `extract`, and the opt-in chips on Try it carry their source URLs.
- **City:** Paris. **AI tools used:** Claude Code (Fable 5.1), OpenAI Codex for second-model review, Nemotron for the product itself. **Learning / career value:** to write in gib's words.
