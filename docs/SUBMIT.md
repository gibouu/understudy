# Devpost submission

Hackathon: Nebius x NVIDIA Global AI Hackathon. Submission closes Friday 30 October 2026, 10:00 PT (18:00 Paris). Track: Physical AI. City: Paris (Builders and Brews).

## Fields

- Project name: Understudy
- Tagline: Watch an astronaut do a task once, interview them, rehearse it on a simulated robot on Earth and in orbit, and export the dataset.
- Track: Physical AI
- Demo URL: (Vercel production URL)
- Repository: https://github.com/gibouu/understudy
- Video: (public YouTube link, under three minutes)
- Built with: Nebius Token Factory, nvidia/Nemotron-3.5-Super-VL, nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B, nvidia/nemotron-3-super-120b-a12b, nvidia/Nemotron-3-Ultra-550b-a55b, Tavily, MuJoCo, MediaPipe, LeRobot, Next.js, Vercel, NASA public-domain footage
- Pre-existing project: no
- City: Paris

## Description (what, why, how)

Draft, to be finished on day five with the measured numbers:

**What.** Understudy turns one clip of a person doing a hands-on task, an astronaut handling samples aboard a station or a technician at a bench, into an interviewed task specification, a robot program rehearsed by a simulated SO-101 arm in the browser under Earth, Moon and orbit gravity, a perception budget per axis and per gravity (how much pose error the task survives blind versus with a pose estimate), a reshoot list, and a LeRobot v2.1 dataset skeleton in the layout GR00T reads.

**Why.** On a station every crew hour is scarce: NASA prices one hour of ISS crew time at $130,000 for commercial activities. The robots meant to take over routine crew work need a clear task, a rehearsed program and labelled data, and crew procedures are already filmed by the hour. The same loop serves satellite servicing and refuelling. It started as a month of internal research into robot demonstration data on the ground, where teaching a robot is expensive (GR00T N1 took about 50,000 H100 GPU-hours to pretrain) and the waste comes after collection: in DROID one recorded trajectory in six was marked failed, one vendor's model puts re-collection at 30 to 50 percent of the original budget, and nobody asks the person who did the task what mattered. Understudy is the briefing and QA layer in front of collection, on the bench and in orbit. The hackathon week is where that research became software.

**How.** Nemotron 3.5 Super VL watches a 480p proxy of the clip and labels steps, objects and their sizes; Nemotron 3 Nano compiles the spec into a robot program and turns whatever it cannot execute into questions; Nemotron 3 Super asks them, citing measurements from the clip, and writes twelve perturbation scenarios; MuJoCo WebAssembly rehearses the program in a Web Worker, blind and sensed; Super patches the worst failure and Nano recompiles; Nemotron 3 Ultra writes the failure classes and the reshoot list. All calls go through Nebius Token Factory; the export loads in Isaac-GR00T's dataset loader.

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
| An Understudy session | $0.0375 on average, 17 calls, 71 s (measured, 3 runs) | `docs/MEASUREMENTS.md` |
| Failing rehearsals fixed from simulator notes | 69% (cheap model), 94% (escalating to reasoning), $0.0024 per fix | `docs/MEASUREMENTS.md` |
| Learning across tasks, Moon and orbit | rules learned on Earth and Mars: first try +28 points with the cheap model (5% to 33%), +18 with reasoning (48% to 67%), against matched controls | `docs/MEASUREMENTS.md` |
| A tube let go at the slot mouth | seats on Earth, Mars and the Moon; floats 30 mm up in orbit | `docs/MEASUREMENTS.md` |
| Liquid model against physics | pour time within 2.8% of Torricelli's law; surface tilt within 0.09° | `docs/MEASUREMENTS.md` |
| Saving on a 500-demonstration campaign | 3%, 10% or 25% of the collection budget if Understudy avoids a tenth, a quarter or half of re-collection; the share is a model, its inputs are measured (a naive program fails 86% of disturbed runs; fixing one costs $0.0024) | `docs/research/market.md`, section 5; `docs/MEASUREMENTS.md`, section 9 |

Say "one vendor's model" whenever the 30 to 50% figure is used: only one source has published it.

## Pre-existing work (Devpost field)

The concept and the research behind Understudy come from a month of internal work that began in late September 2026, inside the Submission Period; no code existed before it. Everything in this repository was written from 23 October 2026 (see the commit history) on Nebius Token Factory with NVIDIA's Nemotron models.

## Testing instructions for judges

Chrome on a laptop. Open the demo URL, click "Try a sample clip", and follow the stages; the sample clips run live against Token Factory and the cost ledger shows it. Uploading your own clip needs the unlock code given in the submission (H.264 MP4, one person, fixed phone). If credits are gone the page says so and replays recorded sessions.

## Checklist (from spec v2, section 15)

- **Track: Physical AI**, committed. "How it meets Physical AI": simulated SO-101 embodiment, the closed loop, blind/sensed, `wait_until` per step, GR00T-layout output.
- **README:** built-for line; architecture; which-model-does-what with exact IDs; the real `chat.completions.create` block; "Other Nebius services" (Job log or "none"); setup under ten commands; "Simulated versus real"; "Limitations and failure cases" with three documented failing rollouts; prior art; testing instructions (Chrome on a laptop; sample clips run live; the unlock code enables uploads).
- **License:** Apache-2.0 at root; Menagerie and MediaPipe notices; no CC-BY-NC components.
- **Feedback:** one block per tool (onboarding, Super VL, Nano, Super, Ultra, Tavily, Serverless Jobs): used for, worked, needs work, minutes to hello-world, build again; the v1 gap list plus Friday's findings.
- **Tavily bonus:** runtime `search` plus `extract` in `/api/ground`, request ids and credits in `grounding.json`, on screen.
- **Devpost:** What/Why/How; Built With tags for Token Factory, the four Nemotron models, Tavily, MuJoCo, MediaPipe, LeRobot, Next.js, Vercel; demo URL, repo, sample clips; not pre-existing; public YouTube under three minutes; secrets scan.

## Feedback section (Most Valuable Feedback award)

One block per tool, filled from `docs/FEEDBACK.md`: used for, what worked, what needs work, minutes to hello-world, would we build on it again. Tools: Token Factory onboarding and credits, Nemotron 3.5 Super VL, Nemotron 3 Nano, Nemotron 3 Super, Nemotron 3 Ultra, Tavily, Nebius Serverless Jobs.

## Elevator pitch (200 characters)

Watch an astronaut do a task once, interview them, rehearse it on a simulated robot on Earth and in orbit, and export the dataset. Nemotron on Nebius Token Factory.

## Thumbnail

`docs/submission/thumbnail.jpg` (1800 x 1200, 3:2).

## Additional info (organiser questions), draft answers

- **Submitter type / organisation:** team; organisation "N/A" unless gib wants KUZOG named. **Country:** France. **Canada province:** N/A.
- **Track:** Physical AI. **New or existing before 26 August 2026:** new (research began late September, code from 23 October).
- **Repository:** https://github.com/gibouu/understudy. **Demo URL:** the Vercel production URL once Vercel Authentication is off.
- **Models and why:** `nvidia/Nemotron-3.5-Super-VL` because it is the hosted NVIDIA model that takes video, and one call labels a whole clip (30 s = 5,024 input tokens); `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` for the compile step that runs after every answer (1 s, cheap); `nvidia/nemotron-3-super-120b-a12b` for the interview, the perturbation scenarios and the patches (reasoning, 0.8 s with thinking off); `nvidia/Nemotron-3-Ultra-550b-a55b` once per session in the background for failure classes and the reshoot list.
- **Output quality (1 to 10):** to rate on day five from the hero clip; day-one evidence: valid JSON in both JSON modes on every call once thinking is off.
- **Approach:** out of the box, prompt-engineered, with structured output; no fine-tuning (no NVIDIA model is fine-tunable on Token Factory today).
- **Comparison to other models:** to fill on day five.
- **Nebius capabilities:** the OpenAI-compatible Token Factory API with `video_url` input, structured outputs, prefix caching and the verbose model catalog (prices and limits used for the on-screen ledger); a Serverless Job for the GR00T loader validation and the batch sweep if they ship.
- **Recommend (1 to 10), experience versus other clouds (1 to 10):** gib's call; evidence in `docs/FEEDBACK.md`.
- **Improvements wanted:** an image cap above 8 per request or a documented limit in the API error before the call; `reasoning_effort: none` emptying Nano's answer; unknown parameters accepted silently; image and video token counts in the usage object.
- **Hope from the Nemotron team:** a hosted Cosmos Reason or GR00T on Token Factory; fine-tuning for Nemotron.
- **Tavily:** yes once `/api/ground` ships (issue #29); otherwise no.
- **City:** Paris. **AI tools used:** Claude Code (Fable 5.1), OpenAI Codex for second-model review, Nemotron for the product itself. **Learning / career value:** to write in gib's words.
