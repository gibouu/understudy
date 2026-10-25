# Research notes

Understudy rests on a month of internal research into robot demonstration data: what gets collected, what gets wasted, and what a buyer would need to know before paying for five hundred more repetitions. On 23 October 2026, at the start of the hackathon week, that research was consolidated into the digests below so the build could stand on checked facts. Every fact in them is tagged verified (seen on the cited page that day), likely, or unverified.

| File | What it establishes |
|---|---|
| `market-prior-art.md` | who collects human-demonstration data, what it costs, where the waste sits, and which papers already turn human video into robot behaviour |
| `nvidia-models.md` | the NVIDIA open models that matter here (Nemotron 3 and 3.5, Cosmos, GR00T, MimicGen), their licences, and which are hosted on Nebius Token Factory |
| `token-factory.md` | the Token Factory API, model catalog, prices, limits and credits, and Nebius AI Cloud's serverless jobs |
| `tooling.md` | the browser and simulation toolchain (MediaPipe, MuJoCo WebAssembly, LeRobot v2.1, GR00T's loader) with versions and licences |
| `design-review.md` | the adversarial review the first spec went through before the build, which shaped spec v2 |
| `market.md` | the market brief: what an hour of crew time costs and which robots work in orbit, what it costs to teach a robot, where demonstration data leaks, and a cost model for Understudy; 43 sources, every external number checked twice against its page on 25 October 2026 |

The measured behaviour of the models during the build (image caps, thinking toggles, token costs) is in `../FEEDBACK.md`.
