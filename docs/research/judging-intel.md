# Research digest: judging intel

Collected 23 October 2026 by a research agent with live page fetches; each fact is tagged verified (seen on the cited page), likely or unverified.

## Judging intel: Nebius x NVIDIA Global AI Hackathon (fetched 23 Oct 2026)

Devpost blocks WebFetch (403) but serves curl with a browser UA; everything below was read from the live pages unless marked otherwise. The judges' "Will It Ship" recording (56:40, youtu.be/LjCh-ZIyjx4) would not expose its transcript in this environment, so its content is taken from Devpost's own written recap.

### 1. The rules that actually bite (verified on /rules and the overview)

| Item | Rule |
|---|---|
| Deadline | Fri 30 Oct 2026 10:00 PT. Judging 1–15 Dec. Winners ~11 Jan 2027. |
| Platform test | Must run on Token Factory or AI Cloud AND use ≥1 NVIDIA open model. FAQ: calling an NVIDIA model through Token Factory satisfies it; the rest of the app (Vercel frontend, other backend) need not be on Nebius. Calling an NVIDIA model via HuggingFace/OpenRouter is explicitly rejected. |
| Stage one | Pass/fail: "genuine attempt at the track's stated goal, not a superficial rebrand" and "reasonably applies the required APIs". |
| Stage two | Four equal criteria, each scored 1–5 (per the "Here's how judging works" update). |
| Physical AI | FAQ: "no required hardware list… you can build with simulation tools like Isaac Sim". Video must contain ≥1 min of "the key application modules in action". Demo URL not required but the overview says it is welcome. Other NVIDIA open models (e.g. Alpamayo) allowed. |
| Repo | Public GitHub/GitLab/Bitbucket; OSI license file "detectable and visible at the top of the repository page (in the About section)"; README with setup + run guidance; must "highlight how you've used NVIDIA Nemotron… where Token Factory accelerated your workflow and any other Nebius Tools". |
| Video | < 3 min on public YouTube; judges "not required to watch beyond three minutes"; must show the project functioning; no third‑party trademarks or copyrighted music. |
| Demo access | Free of charge for judges until 15 Dec; a "test build" counts; "Judges are not required to test the Project and may choose to judge based solely on the text description, images, and video". Private sites must ship credentials in testing instructions. |
| Feedback | Required field; Most Valuable Feedback judged on "completeness, viability, and potential impact". |
| Pre-existing | Must be "significantly updated" during the period, with a written explanation. |
| Prizes | One Overall OR one Track award, plus one Bonus. City Winner requires in‑person attendance (Paris stop was 1 Oct, already past). |
| Teams | No maximum size; a Representative submits and receives the prize; winners are identity/role‑verified. |

### 2. What the organisers say wins (verified, Updates page)

- "How to build a winning project": name the project "like a human"; hide API keys (.env, check repo before submit); "make the required tools impossible to miss": name Token Factory and the NVIDIA model in the description, the Built With tags, and "with audio" in the video; treat the video "like a pitch, not a tutorial": problem, solution working, who it's for, how it uses Nebius and NVIDIA.
- Feedback guidance: for each of Token Factory, AI Cloud and each NVIDIA model: what you used it for, what worked, what needs work, how onboarding felt "zero to hello world", whether you'd build with it again and why. "Be specific; 'the docs were confusing' doesn't help anyone without naming the tool."
- "Will It Ship" recap (six judges, 20 Oct): solve a real problem for a real audience, talk to potential users; "aha moment" within two minutes in the product and 30 seconds in the demo; "one thing done well beats a big stack… every integration should support the main story"; put the action first, add light onboarding, "show which model is doing what"; "publish your limitations. Judges read documented failure cases as rigor"; "budget extra time for packaging".
- Track-pushing hint: Physical AI "a scripted demo is table stakes; hardware reacting live to real-world input is where this track can really shine" (expect simulation entries to be judged on whether the system reacts to input, not on a canned replay).
- Judge roster includes physical‑AI people: Johnny Nunez (NVIDIA Physical AI & Robotics), Evan Helda (Nebius Head of GTM Physical AI), Dhruv Diddi (Nebius Physical AI Ecosystem), Aditya Sahu (Jetson), Mikhail Rozhkov (Nebius Serverless). Tavily has three judges.

### 3. Credits, community, deadlines (verified, Resources page + Builder Program)

- $25 Token Factory via nebius.com/promo-code with activation code NEBIUS-DEVPOST-GLOBAL26; another $25 Token Factory + $25 Tavily + $100 LangSmith + Toloka/Tendem credits + $1 certification via dev.nebius.com/builders (office hours + Discord included). Tavily build‑session promo code BBDEVPOST; Tavily free tier is 1,000 credits/month without a card.
- No AI Cloud credit grant exists (FAQ) — Serverless Jobs/Endpoints run on your own billing. Forum threads show Token Factory onboarding needs a Visa/Mastercard.
- Nebius Discord discord.gg/eXYTGhgnhK, channel devpostglobalaihackathon; all organiser questions go there. Devpost Discord discord.com/invite/HP4BhW3hnp.
- Gallery is unpublished until the deadline, so no current submissions can be studied.

### 4. Models actually on Token Factory today (verified: tokenfactory.nebius.com/model-catalog.md and /api/public/models_info)

| Model ID | Type | Context | $/1M in/out | Region |
|---|---|---|---|---|
| nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B | text | 262K | 0.06 / 0.24 | eu-north1 |
| nvidia/Nemotron-3_5-Lightning | text, tool calling | 1M | 0.06 / 0.24 | eu-north1 |
| nvidia/nemotron-3-super-120b-a12b | text | 256K | 0.30 / 0.90 | us-central1 |
| nvidia/Nemotron-3-Ultra-550b-a55b | text | 1M | 1.00 / 3.00 | us-central1 |
| nvidia/Nemotron-3.5-Super-VL | image→text | 1M | 0.30 / 0.90 | us-north1 |

No Cosmos, GR00T, Sonic or Nemotron Nano Omni is hosted. `nvidia/Cosmos3-Super-Reasoner` was retired under the August 2026 deprecation and Nebius's own verification doc records it as "HTTP 409, model is stopped". Routing guidance is the track text itself ("Reach for Nemotron 3 Ultra when you need serious reasoning, and let Nano or Super handle the fast, everyday calls") plus Nebius's model page (Lightning for high‑volume agents/tool use, Super VL for visual information, Ultra for complex multi‑agent reasoning). Public serverless endpoints carry "no region guarantee".

### 5. Nebius Physical AI precedent you must position against

Nebius open-sourced the Physical AI Workbench (github.com/nebius/nebius-physical-ai, Apache‑2.0, pushed today). It already contains: hackathon quickstarts (Cosmos3 reasoner, Isaac Lab Franka → Token Factory scene plan), and `robot-sdg`, which "routes scene planning through Token Factory, then runs MuJoCo and physics acceptance" and exports LeRobotDataset v3 with wrist/workspace video. Its VLM‑eval runbook separates "outcome from agency" (a cube rising is not proof the arm grasped it) — judges from this team will apply exactly that rigor to a browser sim. Understudy differs by starting from human video and an interview; say so explicitly. GR00T's README confirms its data format is a LeRobot flavour plus `meta/modality.json`, so "GR00T‑ready" is defensible only if you emit that file. Cosmos Reason 2 weights are open (HF) and NVIDIA's cookbook documents self‑hosting on Nebius via Containers over VM; it costs real AI Cloud money.

### 6. Winner patterns from comparable Devpost contests (verified galleries)

| Contest | Scale | Winners and what they did |
|---|---|---|
| Agentic AI Unleashed: AWS x NVIDIA (Oct–Nov 2025, Nemotron Nano NIM) | 1,955 reg., 67 submissions, 41 solo | Grand: Nomi (team of 2): 2:30 video, GitHub Pages demo on sample data, 1,100‑word README with Built For, architecture diagram, "NVIDIA NIM Integration" code section, candid "Deployment Note" on a blocked permission. 2nd: Skyrchitect (solo): description has a "How it meets hackathon criteria" list naming each sponsor component; demo link was the repo. 3rd: Agent Builder (solo). |
| NemoClaw NVIDIA x ASUS @UCSC (May 2026) | 209 reg., 71 projects | Winners were teams of 3–4; videos 1:46–1:59. FactoryMind: simulated factory digital twin (Python + Three.js) with a Nemotron "leader" dispatching robots, live perturbations (order spikes, worker failure) — a no‑hardware physical‑AI winner. HydroClawNics: one real sensor pot + 200 simulated, one env var switches modes, a deterministic DEMO_MODE for free hosting. |
| Emergence x Nebius (Jul 2026) | 40 reg. | Winner tags include `nebius-token-factory`, `nemotron-3-super-120b`; story opens by killing its first hypothesis with data. |
| HP x NVIDIA (2025) | 1,401 reg. | 10 winners, 8 solo; README depth over polish. |

Common thread: sponsor tech named in tagline, Built With tags, a dedicated README section with the actual API call, a hosted front end even when the GPU path is mocked, and honest notes on what was blocked. Feedback sections are not public in galleries, so no winner pattern exists for them beyond the organiser guidance above.

### 7. Checklist

README: title + one‑line tagline; "Built for Nebius x NVIDIA Global AI Hackathon, Physical AI track"; architecture diagram with a "which model does what" table (Super VL keyframe labels, Ultra interview/spec, Nano/Lightning fast calls, Tavily grounding); "Nebius Token Factory" section with the exact OpenAI‑compatible call and model IDs; "Other Nebius services" (Serverless Jobs if used, else say none); setup in ≤10 commands with `.env.example`; "Limitations and failure cases"; "What is simulated vs real"; LICENSE file at repo root (MIT/Apache‑2.0) so GitHub's About shows it; no keys in history.

Video (≤3 min): 0:00–0:30 problem and one‑sentence pitch; by 0:30 the aha (human video → tokens/pose overlay); ≥1:00 continuous of modules in action (interview, spec, rehearsal under perturbations, export); say "Nemotron 3.5 Super VL on Nebius Token Factory" out loud; end with who it's for; own music or none; public YouTube.

Devpost description: What/Why/How headings; "How Understudy uses Nebius and NVIDIA" list; "How it meets the Physical AI track"; limitations; Built With tags: nebius-token-factory, nemotron-3-ultra, nemotron-3.5-super-vl, nemotron-3-nano, tavily, mujoco, mediapipe, lerobot, next.js, vercel; Try‑it‑out links: hosted demo + repo + sample video; thumbnail 3:2.

Feedback: one block per tool (Token Factory, Super VL, Ultra, Nano/Lightning, Tavily, Serverless if used): used for, worked, needs work, zero‑to‑hello‑world time, build again? why. Name concrete gaps (no hosted Cosmos/GR00T, region split EU/US, Nano Omni absent, card requirement).

### 8. Top five stage‑one killers

1. NVIDIA model not in the runtime path (mocked, or called via another provider).
2. Track mismatch: a chat app with a robot word in it; no embodied/sim loop reacting to input.
3. Repo not public or license not detected in About; README without run steps.
4. Video over 3 min, unlisted/private, music you don't own, or under 1 min of modules in action.
5. Submission form gaps: feedback empty, no demo/test build, API key committed, pre‑existing note missing.

## Recommendations
- Sign up today for Token Factory with a Visa/Mastercard, redeem NEBIUS-DEVPOST-GLOBAL26, join the Builder Program for the second $25 and the $25 Tavily credit, and join the Nebius Discord channel devpostglobalaihackathon; post the Physical AI simulation question there to get an organiser answer on record.
- Submit to the Physical AI track: the FAQ explicitly allows simulation, the judge roster has five physical-AI and robotics people, and a demo URL is optional there (but ship one anyway, it is 'welcome' and it protects the Design score).
- Use only models that exist on Token Factory: Nemotron-3.5-Super-VL for keyframe/pose semantic labels (the only NVIDIA vision model hosted), Nemotron-3-Ultra for the interview and task-spec synthesis, Nemotron-3-Nano or 3.5-Lightning for fast calls (both in eu-north1, cheapest). Drop the Cosmos Reason critic from the critical path: it is not hosted; if Leah or Cam wants a stretch task, self-host Cosmos-Reason2-8B via NVIDIA's Nebius cookbook on your own AI Cloud billing, otherwise document it under Limitations.
- Make the rehearsal react to input, not replay a script: expose sliders for object position, size, obstacles and let the sim re-run live; organisers wrote that a scripted demo is 'table stakes'. Log pass/fail per rollout with a physics check (grasp contact, lift height) so the spec is testable, mirroring Nebius's own outcome-vs-agency rigor.
- Position against Nebius's robot-sdg explicitly in README and video: theirs starts from text seeds, Understudy starts from a human video and an interview; cite MimicGen/DexMimicGen as the few-demos-to-many precedent. Emit a LeRobot v2/v3 dataset with meta/modality.json so the 'GR00T-ready' claim is literally true, and say which fields are real and which are placeholders.
- Keep Serverless Jobs optional and honest: there are no AI Cloud credits, and a card is needed. If budget allows, run one batch pose-extraction or batch sim-evaluation job with `nebius ai job create` and show its log in the video; if not, state in the feedback that the absence of AI Cloud credits kept you on Token Factory only (that is valuable feedback).
- Wire one real Tavily call into the spec-grounding step (SOP, tool spec, safety constraint lookup) and show it in the video; it is the only bonus a Physical AI entry can also win.
- Protect judge access through 15 Dec: deploy on Vercel with a per-IP rate limit and a cached 'sample session' that replays stored model outputs if the Token Factory budget is exhausted, and put a judge-only unlock code in the testing instructions; keep the repo public with LICENSE at root so GitHub's About shows it.
- Follow the winner README pattern: Built For line, architecture diagram, a 'which model does what' table, an exact Token Factory code block with model IDs, Limitations and failure cases, and a .env.example; put the same sponsor names in the tagline, Built With tags and the voice-over.
- Submit a complete draft by Tue 28 Oct and finalise Thu 29 Oct; organisers say packaging takes longer than expected and early submissions may get an eligibility check. Video plan: 0:00 problem, 0:30 human video turning into tokens, 1:00–2:30 continuous module footage with the interview, spec, perturbed rehearsals and export, close with audience and model credits; three people, three parallel streams: gib owns capture→spec→sim, one teammate owns video and README, one owns Tavily grounding and feedback writing.
- Skip the City Winner award unless someone on the team physically attended a Builders & Brews event; do not claim a city otherwise.

## Open questions
- Will the Physical AI judges accept a browser MuJoCo (WASM) rehearsal as 'key application modules in action', or do they expect Isaac Sim/Lab footage? Ask in the Discord channel and keep the answer in the README.
- Does a metered live demo with rate limits and a judge unlock code satisfy 'free of charge, without restriction' until 15 Dec? Two forum threads asked; no organiser reply yet.
- How many images per request does Nemotron-3.5-Super-VL accept and what is its effective latency from Vercel's region; the model serves from us-north1 while Nano/Lightning serve from eu-north1, so measure before fixing the pipeline.
- Is the $50 of Token Factory credit enough for the demo plus judging traffic? Ultra costs $1/$3 per 1M tokens; estimate tokens per session and decide where Ultra is really needed versus Super.
- Does this hackathon show Devpost's early-review icon (baseline eligibility check for submissions made a week before the deadline)? Check the Overview page when logged in.
- Do Leah and Cam already have Devpost accounts, and is gib registered as the Representative who will receive any prize and sign the affidavit?
- Was the 'Will It Ship' judges' detailed critique (Telltale, slash-agent, Mnemos, Assay) worth watching in person; the transcript could not be extracted here, so a 15-minute watch of chapters 4:00–17:30 and 52:45 is recommended.
- If a Cosmos Reason 2 self-host on Nebius AI Cloud is attempted, what is the hourly cost and can it be torn down before judging without breaking the demo?

## Facts
- [verified] Submission period ends Friday 30 Oct 2026 10:00 PT; judging 1–15 Dec 2026; winners announced on or around 11 Jan 2027. (https://nebiusglobalaihackathon.devpost.com/rules)
- [verified] Stage One is a pass/fail check that the project 'reasonably fits the theme and reasonably applies the required APIs/SDKs'; fit means 'a genuine attempt at the track's stated goal, not a superficial rebrand of an unrelated idea'. (https://nebiusglobalaihackathon.devpost.com/rules)
- [verified] Stage Two scores each of the four equally weighted criteria 1–5. (https://nebiusglobalaihackathon.devpost.com/updates/46204-here-s-how-judging-works)
- [verified] Physical AI submissions may use simulation (e.g. Isaac Sim) instead of hardware; there is no required hardware list. (https://nebiusglobalaihackathon.devpost.com/details/faqs)
- [verified] Calling an NVIDIA model through Token Factory satisfies the platform rule; the rest of the app need not run on Nebius; using the model via HuggingFace/OpenRouter does not qualify. (https://nebiusglobalaihackathon.devpost.com/details/faqs)
- [verified] Only Token Factory credits are offered ($25 via code NEBIUS-DEVPOST-GLOBAL26 plus $25 via the Builder Program); there is no separate AI Cloud credit grant. (https://nebiusglobalaihackathon.devpost.com/details/faqs)
- [verified] Builder Program includes $25 Token Factory, $25 Tavily, $100 LangSmith, $50 Toloka, $50 Tendem credits, a $1 certification, office hours and Discord. (https://dev.nebius.com/builders)
- [verified] Resources page: Nebius Discord discord.gg/eXYTGhgnhK; credits form at nebius.com/promo-code with the activation code; Builders & Brews Paris was Thu 1 Oct 2026. (https://nebiusglobalaihackathon.devpost.com/resources)
- [verified] No maximum team size; City Winner requires in-person attendance at that city's event. (https://nebiusglobalaihackathon.devpost.com/details/faqs)
- [verified] Each project is eligible for one Overall Award OR one Track Award, plus one Bonus Award; Best Use of Tavily requires a functional runtime Tavily API call. (https://nebiusglobalaihackathon.devpost.com/rules)
- [verified] Video must be under 3 minutes on public YouTube, show the project functioning, contain no third-party trademarks or copyrighted music; Physical AI entries need ≥1 minute of hardware or key application modules in action. (https://nebiusglobalaihackathon.devpost.com/rules)
- [verified] Repository license must be detectable and visible at the top of the repository page (About section); README must include setup instructions and clear run guidance and highlight Nemotron/NVIDIA model use, where Token Factory accelerated the workflow, and other Nebius tools. (https://nebiusglobalaihackathon.devpost.com/rules)
- [verified] Project must stay available free of charge for judges until the Judging Period ends (15 Dec); a test build counts; judges may judge solely from text, images and video. (https://nebiusglobalaihackathon.devpost.com/rules)
- [verified] Organiser tips: name the project like a human, hide API keys, name Token Factory and the NVIDIA model in description, Built With and with audio in the video, treat the video as a pitch; feedback must say what each tool was used for, what worked, what needs work, how onboarding felt, and whether you'd build with it again. (https://nebiusglobalaihackathon.devpost.com/updates/46205-how-to-build-a-winning-project)
- [verified] Judges' session recap: real problem for a real audience; aha within 2 minutes in product and 30 seconds in demo; one thing done well beats a big stack; show which model does what; documented failure cases read as rigor; budget time for packaging. (https://nebiusglobalaihackathon.devpost.com/updates/47163-recording-will-your-project-ship)
- [verified] Physical AI guidance from organisers: 'a scripted demo is table stakes; hardware reacting live to real-world input is where this track can really shine'. (https://nebiusglobalaihackathon.devpost.com/updates/46204-here-s-how-judging-works)
- [verified] Judges include Johnny Nunez (NVIDIA Physical AI & Robotics DevAdvocate), Evan Helda (Nebius Head of GTM Physical AI), Dhruv Diddi (Nebius Physical AI Ecosystem), Aditya Sahu (NVIDIA Jetson), Mikhail Rozhkov (Nebius Serverless AI) and three Tavily staff. (https://nebiusglobalaihackathon.devpost.com/)
- [verified] The 'Will It Ship' recording is 56:40 with chapters (4:00 criteria, 17:30 live reviews of Telltale, slash-agent, Mnemos, Assay, 52:45 last advice); Discord channel is devpostglobalaihackathon. (https://www.youtube.com/watch?v=LjCh-ZIyjx4)
- [verified] Token Factory currently hosts five NVIDIA models: Nemotron-3-Nano-30B-A3B, Nemotron-3_5-Lightning, nemotron-3-super-120b-a12b, Nemotron-3-Ultra-550b-a55b, and Nemotron-3.5-Super-VL (image-to-text); no Cosmos, GR00T, Sonic or Nano Omni. (https://tokenfactory.nebius.com/model-catalog.md)
- [verified] Pricing: Nano and Lightning $0.06/$0.24 per 1M tokens; Super and Super VL $0.30/$0.90; Ultra $1.00/$3.00. Nano and Lightning serve from eu-north1, Super/Ultra from us-central1, Super VL from us-north1. (https://tokenfactory.nebius.com/model-catalog.md)
- [verified] nvidia/Cosmos3-Super-Reasoner was a hosted Token Factory model but was retired (Nebius verification doc records HTTP 409 'model is stopped'); Nebius hackathon docs now mark the Cosmos3 recipe historical. (https://github.com/nebius/nebius-physical-ai/blob/main/docs/workbench/token-factory-deprecation-verification.md)
- [verified] Track text gives the routing rule: 'Reach for Nemotron 3 Ultra when you need serious reasoning, and let Nano or Super handle the fast, everyday calls'. (https://nebiusglobalaihackathon.devpost.com/)
- [verified] Nebius Physical AI Workbench (nebius/nebius-physical-ai, Apache-2.0) ships 'robot-sdg', which routes scene planning through Token Factory, runs MuJoCo with physics acceptance checks, and exports LeRobotDataset v3 episodes with camera video; blog of 21 Oct 2026 announces Cosmos Data Factory, Isaac Sim/Lab, GR00T and SONIC integration. (https://github.com/nebius/nebius-physical-ai/blob/main/docs/workbench/token-factory-robot-sdg.md)
- [verified] GR00T uses a LeRobot v2 dataset flavour with an additional meta/modality.json; GR00T N1.7 is available via LeRobot's groot policy type. (https://github.com/NVIDIA/Isaac-GR00T/blob/main/README.md)
- [verified] NVIDIA's Cosmos Cookbook documents deploying Cosmos Reason 2 on Nebius AI Cloud using Containers over VM; open weights exist as Cosmos-Reason2-2B/8B on Hugging Face. (https://nvidia-cosmos.github.io/cosmos-cookbook/getting_started/nebius/reason2/reason2_on_nebius.html)
- [verified] Nebius Serverless AI Cookbook has robotics examples (LeRobot ACT/Diffusion fine-tune job, SmolVLA for SO-101) and a community Isaac Sim example using 38 H100 jobs; jobs are created with `nebius ai job create` and billed per second. (https://github.com/nebius/serverless-ai-cookbook/blob/main/README.md)
- [verified] MuJoCo Menagerie contains robotstudio_so101, franka_emika_panda, franka_fr3 and unitree_g1; zalo/mujoco_wasm (493 stars, updated Aug 2026) simulates and renders MuJoCo in the browser. (https://api.github.com/repos/google-deepmind/mujoco_menagerie/contents/)
- [verified] MimicGen (arXiv 2310.17596) and DexMimicGen (arXiv 2410.24185) are NVIDIA data-generation systems that turn few human demos into many. (https://arxiv.org/abs/2310.17596)
- [verified] AWS x NVIDIA Agentic AI hackathon (Oct–Nov 2025): 1,955 registrants, 67 submissions, 41 solo; Grand Prize Nomi (team of 2) had a 2:30 video, a GitHub Pages demo on sample data and a README with architecture diagram and an 'NVIDIA NIM Integration' code section; 2nd Skyrchitect listed 'How it meets hackathon criteria' in its description. (https://nvidia-aws.devpost.com/project-gallery)
- [verified] NemoClaw NVIDIA x ASUS hackathon winners were teams of 3–4 with videos under 2 minutes; FactoryMind won with a simulated factory digital twin (Python + Three.js) driven by a Nemotron leader with live perturbations; HydroClawNics used one real sensor pot plus 200 simulated pods and a deterministic DEMO_MODE for free hosting. (https://nemoclaw.devpost.com/project-gallery)
- [verified] Devpost teammates are added on the Manage Team step by email or by sharing the invitation link; the form also has Built With tags (max 25), Try it out links, video link, and hackathon-specific fields (category, repo URL, license, feedback, pre-existing explanation). (https://help.devpost.com/article/126-know-your-submission-steps)
- [likely] Teammates need their own Devpost accounts to accept an invitation and appear on the submission. (https://help.devpost.com/article/121-teams-adding-teammates)
- [likely] Devpost reviews early submissions for baseline eligibility when a hackathon shows the review icon; whether this hackathon has it was not confirmed. (https://help.devpost.com/article/126-know-your-submission-steps)
- [verified] Token Factory onboarding requires a Visa/Mastercard and some countries are missing from the billing list; the question of whether a metered live demo with limits satisfies judge access was unanswered by organisers as of 22 Oct. (https://nebiusglobalaihackathon.devpost.com/forum_topics/45534-clarifying-free-judging-access-for-apps-with-metered-apis)
- [verified] Tavily free tier is 1,000 API credits/month with no credit card; build-session promo code BBDEVPOST. (https://www.tavily.com/pricing)
- [verified] The current hackathon's project gallery is unpublished until the deadline, so no live submissions could be studied. (https://nebiusglobalaihackathon.devpost.com/project-gallery)
- [verified] Token Factory public serverless endpoints carry 'no region guarantee'; rate limits are dynamic and grow with sustained use. (https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits)
- [unverified] MediaPipe pose and hand landmark models run in the browser via the Tasks Vision JS package. (https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js)