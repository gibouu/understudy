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

To be written on day five from the README's opening and `docs/SPEC.md` sections 2, 4 and 13. Keep the honesty line from `docs/LIMITATIONS.md`.

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
