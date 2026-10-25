# Understudy market brief: rehearsing robot tasks before data collection

**Rehearse the robot task before paying to collect it.**

Nebius x NVIDIA Global AI Hackathon, Physical AI track | Built in Paris, 23 to 30 October 2026 | 71 s of model time per session, no robot | US$0.0375 per session in model calls, measured

Robots learn manipulation from human demonstrations, and collecting them is slow and costly. In DROID, about one trajectory in six was marked failed at recording.<sup>1</sup> One vendor's cost model (Robotics Center, March 2026) puts re-collection after the first policy evaluation at 30 to 50 per cent of the original budget.<sup>2</sup> Understudy turns one clip of a person at work into a task spec, completed by interviewing that person, then into a robot program and a rehearsal on a simulated SO-101 arm. The rehearsal is designed to run 12 perturbation scenarios, each blind (no camera feedback) and sensed (with it), under Earth, Moon and orbit gravity, and to return a reshoot list before any data is collected. A session measured on 25 October 2026 cost US$0.0375 in model calls on average. In rehearsal, the model fixed 94% of failing programs from the simulator's notes alone, at US$0.0024 per fix. If that avoids a quarter of re-collection, a 500-demonstration campaign would save about 10% of its original collection budget; that share can only be measured on a real campaign. Understudy does not train a policy or replace collection: it is the briefing and quality layer in front of it.

## 1. Crew time is the budget

On the International Space Station, the costly input is the astronaut's hour. NASA's pricing policy for commercial activities on the station sets a reimbursable value of US$130,000 per hour of crew time.<sup>3</sup> The station costs NASA about US$3 billion a year, roughly a third of its human spaceflight budget.<sup>4</sup> In 2013, after exercise and planning, 6.5 working hours a day remained. NASA planned 25 per cent of them for visiting-vehicle traffic, 13 per cent for maintenance and 7 per cent for medical operations.<sup>5</sup> A NASA review of station data from October 2017 to December 2023 put upkeep at 20 per cent of scheduled operations hours, against 24 per cent for science.<sup>6</sup>

Robots already take some of this work:

- In 2017 JAXA sent the Int-Ball camera robot to cut crew photography, then about 10% of working hours, to zero.<sup>7</sup>
- NASA's Astrobee free-flyers have logged over 1,200 hours in more than 160 test sessions over five years.<sup>8</sup>
- In March 2024 GITAI said its 1.5-metre dual-arm S2 had completed all planned servicing and assembly tasks outside the station and reached technology readiness level 7. It aims to cut the cost of labour in space 100-fold.<sup>9</sup>

GITAI's slides for DARPA's LunA-10 lunar study use the same US$130,000 figure and price robot work by the hour.<sup>10</sup> NASA credits the station's Dextre robot with fewer spacewalks and more crew time for science.<sup>11</sup> Each new task must still be taught.

## 2. What comes next

Analyst figures give context for the space setting of the demo. They do not size Understudy's own market, which is demonstration data (section 3):

- Novaspace (August 2026) forecasts about $3 billion of cumulative revenue from emerging in-orbit services over the next ten years. Refuelling leads at $1.2 billion, followed by backpacking life extension at $860 million.<sup>12</sup> In 2022, NSR forecast in-orbit services revenue of $14.3 billion through 2031, covering satellite servicing, debris removal and space situational awareness.<sup>13</sup>
- One firm's estimate: Grand View Research (November 2025) sizes the space robotics market at $5.0 billion in 2024, rising to $8.5 billion by 2030.<sup>14</sup>

Funded robotic programs include:

- DARPA's RSGS servicer launched on Northrop Grumman's Mission Robotic Vehicle on 21 July 2026. It carries two seven-joint arms and has an expected life of over ten years.<sup>15</sup>
- JAXA contracted Astroscale Japan, for about ¥13.2 billion including tax, to attempt to remove and deorbit a Japanese rocket upper stage using a robotic arm.<sup>16</sup>
- The Canadian Space Agency awarded MDA Space C$1 billion to design and build Canadarm3 for the NASA-led lunar Gateway, with the contract expected to run until March 2030.<sup>17</sup>

NASA's autonomous caretaking project for spacecraft (ISAAC) notes that Gateway may have crew aboard as little as six weeks a year. It developed remote and autonomous caretaking for the periods without crew.<sup>18</sup> Robotic missions also carry cost risk. NASA's OSAM-1 refuelling demonstration had a US$2.05 billion price tag, which its Inspector General expected it to exceed.<sup>19</sup> Understudy's orbit rehearsal will test a task program at 0 g in simulation, so that program errors surface on the ground rather than in orbit.

## 3. What it costs to teach a robot today

**The data.** Physical Intelligence pre-trained its pi0 model on over 10,000 hours of robot data.<sup>20</sup> Research labs gathered the DROID dataset with 50 data collectors over 12 months: 76,000 trajectories, or 350 hours of interaction data.<sup>21</sup> In the ALOHA setup, one episode lasts 8 to 14 seconds. Yet 10 to 20 minutes of data takes 30 to 60 minutes of wall-clock time, because of resets and operator mistakes.<sup>22</sup>

**The labour.** Tesla offered motion-capture collectors US$25.25 to US$48 an hour in 2024.<sup>23</sup> In China, home collectors are advertised 30 yuan an hour, about 17 yuan in effective pay.<sup>24, 25</sup> Intermediaries resell the data to robot companies at 300 to 500 yuan per hour.<sup>24</sup>

**Who pays for demonstration data today.** In April 2026, the chief executive of the data vendor Micro1 told MIT Technology Review that robotics companies spend over US$100 million a year buying real-world data.<sup>26</sup> Mecka, which supplies real-world data from body sensors and iPhones, passed an annualised run-rate of US$100 million in June 2026, according to BetaKit.<sup>27</sup> Scale AI says it has completed more than 100,000 production hours at its San Francisco lab for its Physical AI data engine.<sup>28</sup> On 24 October 2026 the Hugging Face Hub held 82,365 datasets tagged LeRobot, the format Understudy's export will use.<sup>29</sup>

**The compute.** NVIDIA's GR00T N1 used roughly 50,000 H100 GPU-hours for pretraining, on up to 1,024 GPUs.<sup>30</sup> OpenVLA took 21,500 A100-hours to train. Adapting it to a new task with LoRA, a light fine-tuning method, takes 10 to 15 hours on one A100.<sup>31</sup>

**The multipliers.** Simulation, and learning from deployment, now multiply scarce demonstrations:

- NVIDIA generated 780,000 simulated trajectories, equal to 6,500 hours of human demonstrations, in 11 hours.<sup>30</sup>
- NVIDIA says it generated synthetic training data for GR00T N1.5 in 36 hours, against nearly three months of manual collection.<sup>32</sup>
- DexMimicGen turned 60 human demonstrations into 21,000. On a real humanoid sorting cans, 40 generated demonstrations from 4 human ones raised success from 0% to 90%.<sup>33, 34</sup>
- Learning from deployment, not simulation: Physical Intelligence's pi\*0.6 adds the robot's own real-world experience and expert corrections to its demonstrations. Physical Intelligence reports that on some of its hardest tasks, it more than doubles throughput and roughly halves failures.<sup>35</sup>

These multipliers start from human demonstrations. MimicGen-style tools reuse the motions of the source demonstrations, so a flawed source demonstration can be repeated across the data generated from it.

## 4. Where the money leaks

Losses appear at three points, each after the money is spent:

- **At recording.** In DROID, collectors marked roughly 16,000 trajectories as not successful, against 76,000 successes. That is about one in six recorded.<sup>1</sup>
- **At filtering.** One vendor's cost model (Robotics Center, March 2026) puts discards at 20% to 30% of episodes, and at 40% to 60% while new operators ramp up.<sup>2</sup>
- **At the first policy evaluation.** The same model puts re-collection at 30% to 50% of the original collection budget.<sup>2</sup>

On the robomimic Transport task with camera images, policies trained with the same algorithm reached 72 per cent success on data from proficient operators. On 300 demonstrations from six operators of mixed skill, they reached 42 per cent; the two datasets also differ in size.<sup>36</sup> Resets and operator mistakes are another cause, as the ALOHA timings in section 3 show.<sup>22</sup>

Curation recovers part of the loss:

- Filtering with Demo-SCORE raised absolute success by over 15 to 35 points.<sup>37</sup>
- CUPID showed that a curated subset of under a third of the data can train state-of-the-art diffusion policies on simulated RoboMimic tasks.<sup>38</sup>
- In AgiBot World, 528 human-verified trajectories beat a mixed set of 1,010 by 0.18 in completion score.<sup>39</sup>

All of these fixes run after collection, on data already paid for. One vendor guide recommends a pilot run, at 2 to 5 per cent of the budget, and a written task specification with an explicit success condition before collecting.<sup>40</sup> A pilot uses the robot and operators, while Understudy rehearses the program in simulation from one clip, before either is booked.

## 5. What Understudy changes

Understudy sits in front of collection. It is built to brief the task and rehearse the program before the first operator hour is paid, and to list what to reshoot. It will also add two outputs. The perception budget will show how far the task survives without camera feedback and how far with it. The orbit rehearsal will show how the same program behaves at Moon and orbit gravity.

| Step | Today | With Understudy | Basis |
|---|---|---|---|
| 1. Brief the task | Written by the team; no published cost | Interviewed task spec with per-field provenance from one clip: 17 calls, US$0.0375 in model calls, measured | Product measurement, 23 Oct 2026<sup>41</sup> |
| 2. Check before collecting | One vendor guide recommends a pilot run (2-5% of budget) and a written task spec before collecting | Planned: 24 rollouts per gravity (12 scenarios, blind and sensed) at Earth, Moon (0.1654 g) and orbit (0 g), reshoot list, perception budget. Built: gravity as a scenario axis on the simulated arm | Vendor guide<sup>40</sup>; product facts<sup>42</sup> |
| 3. Record | About 1 in 6 recorded trajectories marked failed by the collector | Unchanged in this model | DROID<sup>1</sup> |
| 4. Filter | 20-30% of episodes discarded | Unchanged in this model | One vendor's cost model (Robotics Center, March 2026)<sup>2</sup> |
| 5. Re-collect after first policy evaluation | 30-50% of the original budget | 10%, 25% or 50% of that re-collection avoided (assumed) | One vendor's cost model (Robotics Center, March 2026)<sup>2</sup>; share avoided assumed |
| 6. Fine-tune | 10-15 h on one A100 per task with LoRA | Unchanged: Understudy does not train a policy | OpenVLA<sup>31</sup> |
| 7. Export | No published figure | Planned: LeRobot v2.1 skeleton in the layout Isaac-GR00T reads; format-valid, not training data | Product plan |

**Assumptions**

1. Collection cost is proportional to the number of demonstrations.
2. Re-collection is 30, 40 and 50 per cent of the original budget in the three scenarios. The central value is the midpoint of the vendor range.
3. Understudy avoids 10, 25 and 50 per cent of that re-collection. This share has not been measured yet.
4. Recording failures and filtering discards stay as they are today. The saving covers operator collection hours only. It excludes hardware, the team's engineering time and compute.
5. One Understudy session per task, at the list prices measured on 23 October 2026.

**Saving on a campaign of 500 demonstrations**

The 500-demonstration example follows two anchors. Physical Intelligence found 1 to 20 hours of robot data enough to fine-tune pi0 to a new task.<sup>43</sup> One vendor's cost model (Robotics Center, March 2026) prices a production-grade dataset of 500 or more demonstrations.<sup>2</sup>

- Conservative: re-collection at 30%, one tenth avoided. This would save 3% of the original collection budget (2.3% of total spend including re-collection), or 15 demonstrations.
- Central: re-collection at 40%, one quarter avoided. This would save 10% of the original collection budget (7.1% of total spend including re-collection), or 50 demonstrations.
- Optimistic: re-collection at 50%, half avoided. This would save 25% of the original collection budget (16.7% of total spend including re-collection), or 125 demonstrations.

In dollars, using two anchors from one vendor's cost model (Robotics Center, March 2026):<sup>2</sup>

- At US$3.75 to US$20 per usable demonstration in a mature operation: 15 demonstrations come to US$56 to US$300, 50 to US$188 to US$1,000, and 125 to US$469 to US$2,500. The vendor says first projects typically cost two to three times as much.
- At US$50,000 to US$200,000 for a dataset of 500 or more demonstrations: 3% comes to US$1,500 to US$6,000, 10% to US$5,000 to US$20,000, and 25% to US$12,500 to US$50,000. This anchor covers equipment, staffing and data processing, but not researchers' engineering time. It includes hardware, which the saving estimate otherwise excludes.

Against this, an Understudy session costs US$0.0375 in model calls on average (measured), and fixing a failing program in rehearsal US$0.0024 (measured, see `docs/MEASUREMENTS.md`). The saving covers operator collection hours only. It excludes hardware, the team's engineering time and compute. It also leaves out any gain from fewer recording failures or discards, any change in policy success, and the value of the perception budget and orbit rehearsal.

## 6. The learning curve

Every program version will be scored on the same 24 rollouts: 12 perturbation scenarios, each run blind and sensed. Scores will be kept apart for each gravity: 1 g, 0.1654 g and 0 g. Because the rollouts never change, scores will be comparable from one iteration to the next.

1. **Iteration 0:** the human trajectory, retargeted to the arm and replayed with no interview.
2. **Iteration 1:** the program compiled from the interviewed task spec.
3. **Iteration 2 onward:** Understudy will write up the worst failed rollout as a note: its metrics, the failed check and a joint-log excerpt. Each note will become a patch, made of one call to the Nemotron Super model, which proposes the change, and one recompile by the Nemotron Nano model, estimated at under a cent.
4. **Next clip:** a patch that fixed a failure will become a playbook rule, applied to the next clip from its first iteration.

The loop is designed to compound through step 4: each clip leaves rules behind, so the next clip should start closer to a passing program. Ten patches on one clip would add under ten cents to a session estimated at under US$0.10 in model calls.

The demo will use NASA public-domain footage of an astronaut placing seed film into the ISS Veggie plant pillows. The same program will run on Earth and in orbit, where a released object drifts instead of resting. The scoreboard will show passes out of 24 per iteration and per gravity, with the perception budget per axis.

**What is measured and what is planned.** Measured on 25 October 2026 (`docs/MEASUREMENTS.md`): a full session costs US$0.0375 in model calls on average; on four tasks at four gravities, a naive program fails 86% of runs and the loop fixes 94% of those within five patches when it escalates to reasoning; rules learned on Earth and Mars add 28 points of first-try success on the Moon and in orbit against a matched control. Those runs use a small program of bounded knobs; the full interpreter, the 24-rollout scoreboard and the iteration log for the sample clips are being built this week.

## 7. Sources

On 25 October 2026 every external number below was checked twice against its page: once for the value, once for whether the sentence citing it says more than the source. Rows 41 and 42 are the team's own measurements and plans.

| # | Claim | Value | URL | Date |
|---|---|---|---|---|
| 1 | DROID failures at recording | ~16k not successful vs 76k successful | https://arxiv.org/html/2403.12945v2 | 2025-04-22 |
| 2 | One vendor's cost model (Robotics Center, March 2026) | 20-30% discarded (40-60% in ramp-up); re-collection 30-50% of budget; $3.75-$20 per usable demo in a mature operation (first projects 2-3x as much); $50k-$200k for a 500+ demo dataset including equipment, staffing and data processing, excluding researchers' engineering time | https://roboticscenter.ai/blog/robot-data-collection-cost | 2026-03-31 |
| 3 | ISS crew time, reimbursable value in NASA's pricing policy for commercial activities | $130,000 per hour | https://www.nasa.gov/leo-economy/commercial-use/pricing-policy/ | 2021-04-29 (updated 2024-10-30) |
| 4 | ISS annual cost to NASA | About $3 billion; a third of human spaceflight budget | https://oig.nasa.gov/docs/IG-22-005.pdf | 2021-11-30 |
| 5 | Planned shares of 6.5 daily work hours | 25% vehicle traffic, 13% maintenance, 7% medical | https://oig.nasa.gov/docs/IG-13-019.pdf | 2013-07-08 |
| 6 | ISS scheduled operations hours, Oct 2017 to Dec 2023 (NASA review, ICES-2024-132) | Upkeep 20%, science 24% of scheduled operations hours | https://ntrs.nasa.gov/api/citations/20240008337/downloads/ICES2024_132_ISSReviewPres.pdf | 2024-07-24 |
| 7 | Crew photography time before Int-Ball (JAXA release) | About 10% of working hours; goal of zero | https://iss.jaxa.jp/en/kiboexp/news/170714_int_ball_en.html | 2017-07-14 |
| 8 | Astrobee operations on the ISS | Over 1,200 hours, over 160 test sessions, five years | https://ntrs.nasa.gov/api/citations/20240005009 | 2024-04-22 |
| 9 | GITAI S2 outside the ISS (announced March 2024) | 1.5 m dual arm; TRL 7 (GITAI); 100x labour-cost goal | https://gitai.tech/?p=7143 | 2024-03-19 |
| 10 | GITAI slides for DARPA's LunA-10 study: astronaut cost; robot work priced by the hour | $130K per hour | https://www.darpa.mil/sites/default/files/attachment/2024-12/gitai-luna-10.pdf | 2024-04 (posted 2024-12) |
| 11 | Dextre's purpose (NASA page on the station's Mobile Servicing System) | Fewer spacewalks, more time for science | https://www.nasa.gov/international-space-station/mobile-servicing-system/ | 2023-09-27 |
| 12 | Emerging in-orbit services revenue, next decade (Novaspace) | About $3 billion; refuelling $1.2 billion; backpacking life extension $860 million | https://nova.space/?p=26937 | 2026-08-10 |
| 13 | In-orbit services revenue forecast (NSR): satellite servicing, debris removal, space situational awareness | $14.3 billion through 2031 | https://www.advanced-television.com/2022/02/15/forecast-14-3bn-in-iosm-revenue-to-2031/ | 2022-02-15 |
| 14 | Space robotics market (Grand View Research, one firm's estimate) | $5.0 billion (2024) to $8.5 billion (2030) | https://www.grandviewresearch.com/industry-analysis/space-robotics-market | 2025-11 |
| 15 | DARPA RSGS servicer | Launched 21 July 2026; two 7-joint arms; 10+ year life | https://www.darpa.mil/news/2026/robotic-servicing-of-geosynchronous-satellites-lifts-off | 2026-07-21 |
| 16 | JAXA ADRAS-J2 contract with Astroscale Japan | About ¥13.2 billion, tax included | https://astroscale.com/en/news/astroscale-japan-secures-contract-for-phase-ii-of-jaxas-commercial-removal | 2024-08-20 |
| 17 | Canadarm3 contract to MDA Space (Canadian Space Agency) | C$1 billion, expected to run until March 2030 | https://mda.space/article/mda-space-awarded-1b-contract-to-design-and-deliver-canadarm3-flight-system | 2024-06-27 |
| 18 | Gateway crew presence (NASA ISAAC caretaking project) | As little as six weeks a year | https://www.nasa.gov/?p=96240 | 2025-06-30 |
| 19 | OSAM-1 price tag (Inspector General) | $2.05 billion, expected to be exceeded | https://oig.nasa.gov/wp-content/uploads/2023/10/ig-24-002.pdf | 2023-10-04 |
| 20 | pi0 pretraining data | Over 10,000 hours | https://arxiv.org/html/2410.24164v1 | 2024-10-31 |
| 21 | DROID collection effort | 76k trajectories, 350 h, 50 collectors, 12 months | https://arxiv.org/abs/2403.12945 | 2024-03-19 |
| 22 | ALOHA episode and wall-clock time | 8-14 s per episode; 10-20 min of data in 30-60 min | https://arxiv.org/pdf/2304.13705 | 2023-04-23 |
| 23 | Tesla motion-capture pay | $25.25-$48 per hour | https://decrypt.co/245399/tesla-bot-robotics-job-motion-capture-suit | 2024-08-19 |
| 24 | China home data collection | 30 yuan/h to collector; 300-500 yuan/h to buyer | https://eu.36kr.com/en/p/3893319165360899 | 2026-07-13 |
| 25 | China home collectors' pay (IT桔子 via 36Kr) | 30 yuan/h advertised; about 17 yuan/h effective | https://www.36kr.com/p/3846872305650184 | 2026-06-10 |
| 26 | Spend on real-world data (Micro1 chief executive's estimate, MIT Technology Review) | Over $100 million a year | https://www.technologyreview.com/2026/04/01/1134863/humanoid-data-training-gig-economy-2026-breakthrough-technology/ | 2026-04-01 |
| 27 | Mecka annualised run-rate (BetaKit) | Over $100 million, June 2026 | https://betakit.com/mecka-ai-reveals-60-million-usd-series-b-round-backed-by-sequoia-nvidia/ | 2026-10-07 |
| 28 | Scale AI Physical AI data engine | Over 100,000 production hours at its San Francisco lab | https://scale.com/blog/physical-ai | 2025-09-24 |
| 29 | LeRobot-tagged datasets on the Hugging Face Hub | 82,365 | https://huggingface.co/api/datasets?filter=LeRobot | 2026-10-24 |
| 30 | GR00T N1 compute and synthetic data | ~50,000 H100 GPU-hours on up to 1,024 GPUs; 780,000 trajectories = 6,500 h, made in 11 h | https://arxiv.org/html/2503.14734 | 2025-03-18 |
| 31 | OpenVLA training and fine-tuning | 21,500 A100-hours; LoRA 10-15 h on one A100 | https://arxiv.org/html/2406.09246v3 | 2024-06-13 |
| 32 | GR00T-Dreams data for GR00T N1.5 | 36 hours vs nearly three months | https://developer.nvidia.com/blog/enhance-robot-learning-with-synthetic-trajectory-data-generated-by-world-foundation-models | 2025-06-16 |
| 33 | DexMimicGen generation | 60 human demos to 21,000 | https://arxiv.org/abs/2410.24185 | 2024-10-31 |
| 34 | DexMimicGen real can sorting | 0% to 90% success; 4 human demos to 40 | https://arxiv.org/html/2410.24185v2 | 2025-03-06 |
| 35 | pi\*0.6 learning from experience | Over 2x throughput, about half the failures, hardest tasks | https://arxiv.org/abs/2511.14759 | 2025-11-18 |
| 36 | Proficient vs mixed-skill operator data (robomimic, Transport task) | 72% proficient vs 42% mixed (300 demos, 6 operators), camera-image inputs, same algorithm | https://robomimic.github.io/study/ | 2021 |
| 37 | Demo-SCORE filtering | Over 15-35 points absolute success | https://arxiv.org/abs/2503.03707 | 2025-07-22 |
| 38 | CUPID curation | Curated subset under a third of the data; state-of-the-art diffusion policies on simulated RoboMimic | https://arxiv.org/abs/2506.19121 | 2025-09-23 |
| 39 | AgiBot World verified data | +0.18 completion score (528 verified vs 1,010 mixed) | https://arxiv.org/html/2503.06669 | 2025-03 |
| 40 | Vendor guide: pilot and task spec before collecting (Claru) | Pilot at 2-5% of budget; written spec with an explicit success condition | https://claru.ai/guides/how-to-create-a-robot-demonstration-dataset | 2026 |
| 41 | Understudy session (measured) | 16.7 calls, US$0.0375 on average (US$0.028 to US$0.052 over 3 runs), 71 s; label call 6,379 tokens | Team measurement, `docs/MEASUREMENTS.md` and `bench/results/session.json` | 2026-10-25 |
| 42 | Understudy rehearsal and repair loop (measured) | naive program fails 93 of 108 runs (86%) at four gravities; escalating patcher fixes 94% [89 to 97] within 5 patches at US$0.0024 per fix; rules learned on Earth and Mars add 28 points of first-try success on the Moon and in orbit (matched control) | Team measurement, `docs/MEASUREMENTS.md` and `bench/results/patch-loop.json` | 2026-10-25 |
| 43 | Robot data needed to fine-tune pi0 to a new task | 1 to 20 hours | https://pi.website/blog/openpi | 2025-02-04 |
