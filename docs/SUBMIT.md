# Devpost submission

Hackathon: Nebius x NVIDIA Global AI Hackathon. Submission closes Friday 30 October 2026, 10:00 PT (18:00 Paris). Track: Physical AI. City: Paris (Builders and Brews).

## Fields

- Project name: Understudy
- Tagline: Watch a person do a task once, interview them, rehearse it on a simulated robot, export the dataset.
- Track: Physical AI
- Demo URL: (Vercel production URL)
- Repository: https://github.com/gibouu/understudy
- Video: (public YouTube link, under three minutes)
- Built with: Nebius Token Factory, nvidia/Nemotron-3.5-Super-VL, nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B, nvidia/nemotron-3-super-120b-a12b, nvidia/Nemotron-3-Ultra-550b-a55b, Tavily, MuJoCo, MediaPipe, LeRobot, Next.js, Vercel
- Pre-existing project: no
- City: Paris

## Description (what, why, how)

Draft, to be finished on day five with the measured numbers:

**What.** Understudy turns one phone clip of a person doing a tabletop task into an interviewed task specification, a robot program rehearsed by a simulated SO-101 arm in the browser, a perception budget per axis (how much pose error the task survives blind versus with a pose estimate), a reshoot list, and a LeRobot v2.1 dataset skeleton in the layout GR00T reads.

**Why.** It started as a month of internal research into robot demonstration data. Collection is cheap and industrialised; the waste comes after: a fifth to a third of demos discarded, re-collection eating a third to a half of a campaign budget, and nobody asking the person who did the task what mattered. Understudy is the briefing and QA layer in front of collection. The hackathon week is where that research became software.

**How.** Nemotron 3.5 Super VL watches a 480p proxy of the clip and labels steps, objects and their sizes; Nemotron 3 Nano compiles the spec into a robot program and turns whatever it cannot execute into questions; Nemotron 3 Super asks them, citing measurements from the clip, and writes twelve perturbation scenarios; MuJoCo WebAssembly rehearses the program in a Web Worker, blind and sensed; Super patches the worst failure and Nano recompiles; Nemotron 3 Ultra writes the failure classes and the reshoot list. All calls go through Nebius Token Factory; the export loads in Isaac-GR00T's dataset loader.

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
