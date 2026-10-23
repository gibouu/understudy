# Research digest: market prior art

Collected 23 October 2026 by a research agent with live page fetches; each fact is tagged verified (seen on the cited page), likely or unverified.

## Market and prior art: human demonstration video to robot training data (23 Oct 2026)

**Headline.** Human-video collection for robots has become a real market in 18 months: Micro1, Mecka ($100M+ ARR, $60M Series B led by Sequoia with NVIDIA, Oct 2026), XDOF (~$1.2B valuation talks), Scale AI (100k+ hours), Encord, Human Archive (YC W26), Figure's Index app (264k downloads, 30 min of video uploaded per second), Generalist (270k+ hours, 10k+ hours/week) and 30-40 Chinese state-backed centres. Collection labour is cheap ($4-30/h for ego video, $25-50/h for teleop). The scarce, expensive thing is what the lead suspected: **structured annotation and QA**. Encord's head of robot learning says dense annotation ("right hand tightens bolt") is worth ~100x "junky ego data" but costs ~20x to produce; Micro1 says only about half of submitted videos pass review; Figure runs a five-stage filter/fraud/dedupe/rebalance/annotate pipeline before Helix sees anything. Nobody sells an inspectable task spec plus a sim stress test as the product.

### (a) Who collects human demonstrations, and what it costs

| Player | What they collect | Reported cost / pay / scale | Labels | Status |
|---|---|---|---|---|
| Tesla Optimus "Data Collection Operator" | Mocap suit + VR headset, >7 h/day walking, 5'7"-5'11" | $25.25-$48/h, Palo Alto, 3 shifts (Aug 2024) | Operators also analyse data and write daily reports | verified |
| Micro1 | iPhone strapped to forehead, home chores, >=10 h video/week | $15/h (Nigeria), $15-30/h PH posting; tens of thousands of hours; robotics firms spend ">$100M/yr" on such data (CEO) | AI + human review, ~half rejected, then annotated by "hundreds" | verified (MIT TR Apr 2026) |
| Mecka AI (EgoVerse) | Egocentric video + body sensors + phone, paid participants, in-house 3D reconstruction | >$100M ARR Jun 2026, target $300M; $128M raised | Motion tracking only disclosed | verified |
| XDOF | Teleoperation data (GELLO rigs); ABC dataset 3,553 h released, single workstation | ~$50M ARR, $70M A (Jun 2026), ~20 clients | Annotation tooling in-house | likely (TechCrunch via aggregators) |
| Scale AI Robotics | Teleop, "Scale Harness" robotless egocentric, bespoke platforms; 1,000+ h/day | >100,000 h (MIT TR) | "Multi-modal grounding annotations", internal policy fine-tune eval | verified |
| Encord | Teleop + egocentric + UMI in own facilities (San Leandro, ~12 pilots) and factories; EEG trial with Zander Labs | Dense annotation ~20x cost, ~100x value (their claim) | Dense action captions, RGB/depth/LiDAR/F-T sync, JSON output | verified |
| Human Archive (YC W26) | Camera rigs, tactile gloves, IMUs; up to 8,000 h/day capacity; India/China ops | $8.2M raised (date unverified) | QA pipelines, annotation software | verified (YC page) |
| Figure Index | Phone app, Creators record chores; 44k WAU; $15M paid to Creators | 30 min video/s uploaded | Hierarchical text captions per episode after filter/fraud/dedupe/rebalance | verified (25 Aug 2026) |
| Generalist GEN-0/1.5 | "1,000s of devices and robots", thousands of homes | 270,000+ h, 10,000+ h/week (Nov 2025); GEN-1.5 one-shot from 12 s demo | n/a | verified |
| AgiBot (Shanghai) | 100 identical robots teleoperated, ~1M trajectories; AgiBot World 2026 (Apr 2026) free-form teleop + 1:1 digital twin | Operators ~150-250 usable points/day, 200 operators (secondary source) | Task descriptions, atomic skill labels, 2D boxes, error-recovery trajectories | mixed: dataset verified, labour figures unverified |
| Chinese UMI collectors | Wear sensors in factories/supermarkets; >=30 centres by end-2025 | ~20 yuan/h (~$2.80), 200 yuan/day | "Thousands of datasets per basic skill" | verified (The Standard, Aug 2026) |
| Physical Intelligence pi0 | Own teleop on 8 robot types | hours not disclosed | Text instructions | verified |
| 1X world model | Thousands of hours EVE data; learned simulator for policy eval | 100+ h released | n/a | verified (Sep 2024) |
| Apple EgoDex | Vision Pro, 829 h, 194 tasks, 3D hand pose | CC-BY-NC-ND | NL descriptions as HDF5 attrs | verified |
| Meta Ego4D / Ego-Exo4D / Aria | 3,670 h / 1,286 h (564 h cooking); expert commentary, atomic action descriptions, keystep + proficiency benchmarks; Aria Gen 2 kit by application | licence-gated | Narrations, state-change, keysteps | verified |
| Stanford UMI | Handheld GoPro gripper, ~111 demos/h vs 35 teleop | "low-cost", no figure | Kinematic validity check per demo | verified |
| LeRobot | 190 datasets; v3 format: parquet + mp4 + meta/tasks.jsonl (task strings per episode) | open | Task string only | verified |
| NVIDIA GR00T-Mimic / Dreams | Vision Pro teleop in Isaac Lab -> 780k synthetic trajectories (6.5k h equiv) in 11 h; Dreams: Cosmos-Predict2 + IDM -> LeRobot format | Apache-2.0 | n/a | verified |
| Sanctuary, Dyna, Mimic, UBTech | Teleop/glove data; details not public | none found | n/a | unverified |

**Where cost sits (vendor numbers, March 2026, Robotics Center):** operator $25-50/h, 30-60 usable demos/h; per usable demo $3.75 (pick-place) to $20 (dexterous); QA/supervision $0.40-2.00/demo; 20-30% discarded; language annotation $0.25-1.00/episode by human vs $0.05-0.10 VLM-assisted; re-collection after first evaluation 30-50% of budget; all-in 500+ demo project $50k-200k. Collection is a solved commodity; **waste (rejects, re-collection) and semantic labels are the margin.**

### (b) Research that learns from human video, and what it does not do

| System | Input | Output | Does NOT produce |
|---|---|---|---|
| OKAMI (UT Austin, 2024) | single RGB-D human video | object-aware retargeted humanoid plan, 79% policy | inspectable spec, interview, perturbation test |
| EgoMimic / EgoZero (Aria glasses) | ego video + 3D hands | co-trained or zero-robot-data policy (70%, 20 min/task) | explicit steps or success checks |
| Phantom / Masquerade / H2R | human video inpainted into robot video | policies, zero-shot up to 92% | semantics; pure visual domain shift |
| R+X, Vid2Robot, Gen2Act | video retrieval / prompt / generated human video | end-to-end actions | task graph |
| HumanPlus, DexCap, VideoDex, MimicPlay | mocap/shadowing/play video | low-level skills, latent plans | labels, QA |
| MimicGen / DexMimicGen | ~200 (60) source demos | 50k (21k) sim demos | human-video front end; needs object poses and segmented demos |
| GR00T-Dreams (DreamGen) | one teleop task | 22 new behaviours via video world model + IDM | explicit spec; actions are pseudo-labels |
| Humanoid Everyday (Oct 2025), AgiBot World 2026 | robot datasets | 10.3k trajs / hundreds of hours with atomic labels | human-video pipeline |
| H2R-Bench (Aug 2026) | benchmark | finds world models still fail embodiment consistency | - |

Common pattern: video -> policy or video -> edited video. None interviews the demonstrator, none emits a human-readable spec, none stress-tests under perturbations before export.

### (c) VLM/LLM -> explicit task specification

| Work | From | To | Gap vs Understudy |
|---|---|---|---|
| Microsoft GPT-4V task planning (2023) | human video | symbolic plan + grasp type, waypoints; authors say hallucinations need human supervision | no dialogue, no sim test |
| SeeDo "VLM See, Robot Do" (2024) | human demo video | pick-and-place plan via keyframes + VLM | pick-place only |
| GF-VLA / HANDSOME (Polimi 2024-Jan 2026) | one RGB(-D) demo | scene graphs -> behaviour trees, 90% dual-arm assembly | closest academic precedent; no interview, no export |
| ReKep, VoxPoser, Code-as-Policies | language + RGB-D | keypoint constraints / value maps / code | start from language, not video |
| Gemini Robotics-ER 2 (Jul 2026) | video + text | points, boxes, trajectories, success detection, progress | API component, not a product |
| Cosmos Reason 1 | video + text | physical plausibility critic (Jun 2025 update), curation | the critic Understudy can call |
| IWSDS 2026 dialogue-LfD agent; AmbResVLM; iLearnRobot | operator dialogue | clarification of commands | interview exists in literature but not fused with video spec + sim |

### (d) Honest novelty

**Not new:** pose extraction from video (MediaPipe, EgoDex); VLM plan-from-video (GPT-4V, SeeDo, GF-VLA); sim augmentation from few demos (MimicGen, DexMimicGen, GR00T-Mimic); LLM-built sim tasks (RoboGen, GenSim); a VLM critic (Cosmos Reason); clarifying dialogue with a demonstrator (IWSDS 2026); LeRobot export (GR00T-Dreams does it). A judge who knows the field will recognise each piece.

**New, and defensible for a hackathon:** (1) the *product framing* as the annotation/QA layer sold to the people who already collect video, not a policy; (2) the *interview* as the annotation mechanism: the demonstrator is the cheapest oracle for preconditions, tolerances and success criteria, and no data vendor captures that today (Micro1 workers are not even told what the data is for); (3) the spec as a *first-class, editable artefact* that is then *falsified in sim* under perturbations before export, so rejects and re-collection (30-50% of budget) happen at the spec level rather than after a $50k campaign; (4) attaching the spec, the perturbation results and the interview transcript to each LeRobot episode (tasks.jsonl carries only a string today). The 20x annotation cost claim from Encord is the number to quote.

**Honesty required:** retargeting a human trajectory to an SO-101 and replaying it in MuJoCo under perturbations is a plausibility check, not policy training; say so. Do not claim "fine-tune-ready for GR00T" unless the export validates with lerobot.

### (e) Ten real-audience use cases (strongest first)

1. **Robotics startup bootstrapping a task** (UMI/SO-101 teams): upload 5 phone videos, get a spec + perturbation report + LeRobot skeleton before spending on teleop; pays because re-collection is 30-50% of budget.
2. **Data vendor QA** (Micro1/Mecka-type): run every submitted chore video through spec extraction + interview to cut the ~50% reject rate and produce the dense captions buyers pay 20x for.
3. **Integrator quoting an automation cell**: film the operator, get a step list with grasps, tolerances, cycle time and failure modes to price the cell and pick the gripper.
4. Lab automation (pipetting, plate handling): spec with preconditions and success checks for a protocol, exported alongside SOP references.
5. Food prep chains (Dyna-style plating, scooping): perturbation test for tray position and portion variance.
6. Warehouse carton pick/inspect/seal: obstacles and object-size perturbations.
7. Home-robot teams (Figure/1X-style tidy tasks): convert in-home Creator video into inspectable episodes.
8. Academic labs publishing LeRobot datasets: add language + spec metadata for free.
9. Training-content / SOP authors in manufacturing: the spec doubles as a human work instruction.
10. Insurers / safety reviewers: the spec's hazards and grounded SOP citations (Tavily) document a procedure before automation.

## Recommendations
- Position Understudy as the annotation-and-QA layer for existing human-video collections, not as a policy-learning system; the judges' pass/fail check and the 'Potential Impact' criterion both favour a product that plugs into Micro1/Mecka/Figure-Index-style pipelines, and the Encord '20x cost, 100x value' quote is the one-line market case.
- Make the interview the headline novelty: no vendor captures preconditions, tolerances and success criteria from the demonstrator; show the spec changing as answers arrive, and attach the transcript to the exported episode.
- Cite GF-VLA / HANDSOME (Polimi) and the Microsoft GPT-4V task-planning paper as closest prior art in the README and state the difference plainly (interview + sim falsification + export); judges reward honest positioning over claims of firsts.
- Export must validate with lerobot (v3 layout, meta/tasks.jsonl) and carry extra per-episode metadata (spec JSON, perturbation results, interview); run `lerobot` loading as the acceptance test and say 'GR00T-compatible format', not 'fine-tune-ready', unless a fine-tune is actually run on Nebius.
- Use Cosmos Reason as the rollout critic (its model card lists a physical-plausibility critic mode and commercial licence); check Token Factory's catalogue for a hosted Cosmos Reason / Nemotron VLM before building around it, and have a Serverless Endpoint fallback.
- Sim feasibility is confirmed: MuJoCo 3.12 official WASM bindings exist and Menagerie has SO101 (Apache-2.0), Panda and G1; keep the sim as a perturbation stress test of the spec (object pose, size, obstacle), not a training loop.
- For the demo and video, lead with use case 1 or 2 (startup bootstrapping a task; vendor QA cutting the ~50% reject rate) and quantify against the vendor cost model (re-collection 30-50% of budget, $50k-200k per 500-demo project).
- Reserve Tavily for grounding the spec in SOPs/tool specs (lab protocols, food-safety steps); it is a credible runtime call tied to the safety/success-check fields rather than a bolt-on.

## Open questions
- Does Nebius Token Factory host a Nemotron vision-language model and/or Cosmos Reason today (Oct 2026), and at what context length for keyframes + pose tokens? Not checked in this brief.
- Which Cosmos Reason generation is current (the Reason1 collection is archived and points to a 'cosmos3' collection); is the physical-plausibility critic mode retained?
- Primary sources for AgiBot/Chinese centre labour figures (200 operators, 150-250 points/day, 17-hour shifts) were not reachable; treat as unverified in any public material.
- Micro1's exact reject rate (~50%) and the 160,000 hours/month figure came via search snippets, not the MIT TR page itself; verify before quoting.
- Human Archive's $8.2M round date and the LA Times '$80 for two hours' Micro1 example were not verified on primary pages.
- UBTech, Sanctuary and 1X 2026 data-collection practices: nothing public found; do not name them as competitors in the pitch.
- Does the lerobot CLI accept arbitrary extra per-episode metadata without breaking GR00T N1.x fine-tuning loaders? Needs a quick test on the actual export.

## Facts
- [verified] Tesla Data Collection Operator role: $25.25-$48/h, mocap suit + VR headset, walk >7 h/day, height 5'7"-5'11", Palo Alto, duties include data analysis and daily reports (Aug 2024) (https://decrypt.co/245399/tesla-bot-robotics-job-motion-capture-suit)
- [verified] Micro1 workers strap an iPhone to the forehead and film chores; one worker paid $15/h; videos reviewed by AI and a human; CEO estimates robotics firms spend >$100M/yr on such data; Scale AI reported >100,000 hours; Encord recruits its own recorders; DoorDash pays drivers to film chores (MIT Technology Review, 1 Apr 2026) (https://www.technologyreview.com/2026/04/01/1134863/humanoid-data-training-gig-economy-2026-breakthrough-technology)
- [verified] Micro1 claims >$100M ARR (Dec 2025) and is building the 'world's largest robotics pre-training dataset' from hundreds of generalists recording object interactions at home (https://techcrunch.com/2025/12/04/micro1-a-scale-ai-competitor-touts-crossing-100m-arr)
- [likely] Micro1 pays $15-30/h (PH posting), ~4,000 workers in 71 countries, 160,000 hours/month, only about half of videos pass review (https://www.technologyreview.com/2026/04/01/1134863/humanoid-data-training-gig-economy-2026-breakthrough-technology)
- [verified] Mecka AI: $60M Series B led by Sequoia with NVIDIA, M12, Qualcomm Ventures, Samsung (7 Oct 2026); egocentric video + body sensors + smartphones from paid participants; in-house motion tracking and 3D reconstruction; ARR >$100M as of June 2026, target $300M; $128M disclosed total (https://dealroom.co/news/160699-mecka-raises-60m-series-b-to-turn-human-motion-into-robot-training-data/)
- [likely] XDOF (teleoperation data, GELLO rigs, Berkeley founders) reportedly in Series B talks at ~$1.2B valuation (Sep 2026), ~$50M ARR, ~20 clients, $70M Series A June 2026; ABC dataset 3,553 h released from a single workstation (https://dealroom.co/news/149061-xdof-nears-1-2b-series-b-just-months-after-70m-series-a/)
- [verified] Scale AI Robotics offers teleop demos, 'Scale Harness' robotless egocentric collection, bespoke platforms; 1,000+ hours/day; partners Physical Intelligence, Generalist, Dyna, Cobot, Walden (https://scale.com/robotics)
- [verified] Encord head of robot learning estimates dense annotation ('right hand tightens bolt') is worth ~100x junky ego data and costs ~20x more; ~12 pilots at San Leandro facility; EEG trial with Zander Labs (TechCrunch, 26 Jul 2026) (https://techcrunch.com/2026/07/26/are-brain-waves-the-next-unlock-for-physical-ai/)
- [verified] Human Archive (YC W26): physical AI data lab, team 100, up to 8,000 hours/day capacity, HA-Multi (tactile gloves, IMUs, wrist cams) and HA-Ego datasets, offices SF/China/India (https://www.ycombinator.com/companies/human-archive)
- [verified] Figure Index app (25 Aug 2026): 264,000 downloads, 108 countries, 44,000+ WAU, Creators paid $15M to date, 30 minutes of video uploaded per second, five-stage pipeline (filter, fraud, dedupe, rebalance, annotate) with hierarchical text captions per episode (https://www.figure.ai/news/introducing-index)
- [verified] Figure Project Go-Big (18 Sep 2025): Helix navigation trained only on egocentric human video, no robot demonstrations; Brookfield owns >100,000 residential units (https://www.figure.ai/news/project-go-big)
- [verified] Generalist GEN-0 (4 Nov 2025): trained on >270,000 hours of real-world manipulation data, collecting >10,000 hours/week, thousands of homes/warehouses; GEN-1.5 (Aug 2026) one-shot from 12 s of demonstration (https://generalistai.com/blog/gen-0)
- [verified] AgiBot World 2026 released 7 Apr 2026: free-form teleoperation on G2, 1:1 digital twin sim data, labels include task descriptions, action sequences, atomic skill labels, 2D boxes, error-recovery trajectories (https://www.therobotreport.com/agibot-world-2026-dataset-open-source-accelerate-embodied-ai-development/)
- [unverified] AgiBot Shanghai facility: ~200 teleoperators, 150-250 usable data points per operator per day, >4M data points; estimated $0.51 per data point at Chinese wages vs $2.55 at US wages (https://liveinthefuture.org/stories/robot-data-factory-economics)
- [verified] China: >=30 data-collection centres by end-2025; 'UMI data collectors' recruited via social media at ~20 yuan/h or 200 yuan/day wearing sensors in factories, supermarkets and homes; <5% of 23,000 humanoids shipped H1 2026 can do practical factory tasks (The Standard, 19 Aug 2026) (https://www.thestandard.com.hk/china/article/340377/Chinas-embodied-AI-boom-fuels-demand-for-human-collected-training-data)
- [verified] Robot data cost model (31 Mar 2026): operator $25-50/h, 30-60 usable demos/h, per usable demo $3.75-$20, QA $0.40-2.00/demo, 20-30% discarded, language annotation $0.25-1.00 human vs $0.05-0.10 VLM-assisted, re-collection 30-50% of budget, 500+ demo project $50k-200k (https://roboticscenter.ai/blog/robot-data-collection-cost)
- [verified] Physical Intelligence pi0 trained on own data from 8 robot types; hours not disclosed (https://www.pi.website/blog/pi0)
- [verified] 1X world model (17 Sep 2024): learned simulator from thousands of hours of EVE data, goal is policy evaluation across millions of scenarios, 100+ h released (https://www.1x.tech/discover/1x-world-model)
- [verified] Apple EgoDex: 829 h, 194 tasks, Vision Pro 3D hand tracking, CC-BY-NC-ND, mp4 + hdf5 with NL descriptions (https://github.com/apple/ml-egodex)
- [verified] Ego4D 3,670 h, 923 participants, 9 countries; Ego-Exo4D 1,286 h (564 h cooking), expert commentary, atomic action descriptions, keystep and proficiency benchmarks; licence-gated (https://ego-exo4d-data.org/)
- [verified] Project Aria: Aria Gen 2 research kit by rolling application, 200+ partners, Aria Digital Twin and Everyday Activities datasets (https://www.projectaria.com/)
- [verified] UMI: handheld GoPro gripper, ~30 s per demo, 111 demos/h vs 231 bare hand vs 35 space-mouse teleop, each demo auto-checked against robot kinematics; no dollar cost stated (https://umi-gripper.github.io/)
- [verified] DexCap: EMF gloves + SLAM cameras + backpack PC, ~40 min battery, ~3x faster than teleop, retargeting for LEAP hand; no cost stated (https://dex-cap.github.io/)
- [verified] LeRobot org hosts 190 datasets; LeRobotDataset v3 = parquet + mp4 shards + meta/info.json, stats.json, tasks.jsonl (NL task to int id), episodes parquet; record with --dataset.single_task (https://huggingface.co/docs/lerobot/lerobot-dataset-v3)
- [verified] GR00T-Mimic blueprint: Vision Pro teleop in Isaac Lab, 780K synthetic trajectories (6.5K h equivalent) in 11 h, +40% GR00T N1 with synthetic+real, Cosmos Transfer for photorealism (https://developer.nvidia.com/blog/building-a-synthetic-motion-generation-pipeline-for-humanoid-robot-learning/)
- [verified] GR00T-Dreams repo (Apache-2.0): fine-tune Cosmos-Predict2, generate robot videos, extract actions with fine-tuned IDM, convert to LeRobot format (franka, gr1, so100, robocasa), fine-tune GR00T N1; DreamGen paper: 22 new behaviours from one teleop task (https://github.com/NVIDIA/GR00T-Dreams)
- [verified] Cosmos-Reason1-7B: video+text in, text out, NVIDIA Open Model License (commercial), use cases include data curation/annotation and robot planning; June 2025 update added physical-plausibility critic; collection archived, points to a 'cosmos3' collection (https://huggingface.co/nvidia/Cosmos-Reason1-7B)
- [verified] Gemini Robotics-ER 2 (gemini-robotics-er-2-preview, updated Jul 2026): points, boxes, trajectories, task planning, success detection and progress from video; ER 1.6 deprecated 31 Aug 2026 (https://ai.google.dev/gemini-api/docs/robotics-overview)
- [verified] OKAMI: single RGB-D human video -> object-aware retargeted humanoid plan, 79.2% closed-loop policy success (https://arxiv.org/abs/2410.11792)
- [verified] EgoMimic: Aria glasses ego video + 3D hands co-trained with robot data; claims one hour of hand data worth more than one hour of robot data (https://arxiv.org/abs/2410.24221)
- [verified] EgoZero: Aria glasses, zero robot data, 70% success on 7 tasks with ~20 min data per task, Franka Panda (https://arxiv.org/abs/2505.20290)
- [verified] Phantom: human video with arm inpainted and robot overlaid, zero-shot up to 92% (CoRL 2025); Masquerade (Aug 2025) same idea for in-the-wild ego video; H2R (May 2025) retargets hands to simulated arms for pre-training (https://arxiv.org/abs/2503.00779)
- [verified] R+X: VLM retrieves clips from long unlabelled ego video, KAT in-context imitation executes (ICRA 2025); Vid2Robot: end-to-end video-conditioned policy (RSS 2024); Gen2Act: generated human video conditions robot policy (https://arxiv.org/abs/2407.12957)
- [verified] HumanPlus: 33-DoF humanoid shadowing from RGB, 60-100% with up to 40 demos; MimicPlay: latent plans from human play + small teleop set (CoRL 2023); VideoDex: internet video priors for dexterous hand (CoRL 2022) (https://arxiv.org/abs/2406.10454)
- [verified] MimicGen: ~200 human demos -> 50K+ demos across 18 tasks; DexMimicGen: 60 source demos -> 21K demos, real-to-sim-to-real can-sorting (https://arxiv.org/abs/2410.24185)
- [verified] Humanoid Everyday (Oct 2025): 10.3k trajectories, 260 tasks, RGB/depth/LiDAR/tactile, NL annotations; H2R-Bench (Aug 2026): world models still fail embodiment consistency when turning human video into robot video (http://export.arxiv.org/api/query?search_query=ti:H2R+AND+cat:cs.RO&max_results=8)
- [verified] GPT-4V(ision) for Robotics (Microsoft, 2023): human video -> text description -> symbolic task plan + grasp types, waypoints; authors report hallucinations and recommend human supervision in the pipeline (https://arxiv.org/abs/2311.12015)
- [verified] SeeDo / VLM See, Robot Do (Oct 2024): keyframe selection + perception + VLM reasoning -> robot task plan, pick-and-place only (https://arxiv.org/abs/2410.08792)
- [verified] GF-VLA lineage (Politecnico di Milano, Oct 2024 to Jan 2026): single RGB(-D) human demo -> information-theoretic scene graphs -> behaviour trees for dual-arm assembly, ~90% success; HANDSOME dataset (http://export.arxiv.org/api/query?search_query=all:%22GF-VLA%22+OR+all:%22behavior%20tree%22+AND+all:%22human%20demonstration%22+AND+all:%22scene%20graph%22&max_results=6)
- [verified] ReKep (keypoint constraints as Python cost functions), VoxPoser (3D value maps), Code-as-Policies (policy code) all start from language + RGB-D, not human video (https://arxiv.org/abs/2409.01652)
- [verified] RoboGen (ICML 2024) and GenSim (ICLR 2024) use LLMs to propose tasks, build sim scenes and generate training supervision; GenSim expanded a benchmark 10x to 100+ tasks (https://arxiv.org/abs/2311.01455)
- [verified] IWSDS 2026 paper (Garcia Anakabe et al.) adds a state-graph dialogue agent that guides operators during learning-from-demonstration under ambiguity and operator errors; AmbResVLM clarifying dialogue raised success 69.6% to 97.1% (https://aclanthology.org/2026.iwsds-1.26)
- [verified] mujoco_wasm (MIT): MuJoCo 3.12.0 via official @mujoco/mujoco WebAssembly bindings, three.js demo, models loaded from XML into MEMFS (https://github.com/zalo/mujoco_wasm)
- [verified] MuJoCo Menagerie includes The Robot Studio SO101 (Apache-2.0), trs_so_arm100, Franka Panda (Apache-2.0), Unitree G1 (BSD-3) (https://github.com/google-deepmind/mujoco_menagerie)
- [verified] Dyna Robotics sells Dyna-2.1 physical agent for laundry, plating, cartons, hotel rooms; no data-collection or pricing disclosed (https://www.dyna.co/)
- [verified] Mimic (Zurich): glove/VR teleop + egocentric hand video (MAPLE with ETH/Microsoft) + internet video pre-training; 16-DoF tendon hand; up to 93.3% task success claimed (https://www.mimicrobotics.com/)
- [unverified] Sanctuary AI: no public teleop data numbers; pivoted to selling software for other robot platforms (2026); UBTech data operations: nothing found (https://www.sanctuary.ai/)
- [likely] Chinese Beijing humanoid data training centre uses VR teleoperation; >40 state-backed centres planned with 24 operating; RealMan Beijing centre 3,000 m2 with 108 robots (https://www.robotics247.com/article/realman_robotics_launches_humanoid_robotics_data_training_center_in_beijing/supply_chain)