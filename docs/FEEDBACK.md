# Feedback on Nebius Token Factory, Nebius AI Cloud and the NVIDIA models

Filled as we go. Every line is something we measured or hit ourselves; dates are 2026.

## Day-one smoke tests (23 Oct)

| Test | Model | Result | Latency | Notes |
|---|---|---|---|---|
| keyframes + montage as base64 image_url, response_format json_object | nvidia/Nemotron-3.5-Super-VL | | | |
| same with json_schema | nvidia/Nemotron-3.5-Super-VL | | | |
| video_url of a 720p proxy | nvidia/Nemotron-3.5-Super-VL | | | image and video token counts from usage |
| reasoning_effort none vs enable_thinking false | nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B | | | does the output contain <think>? 400 on unknown params? |
| same | nvidia/nemotron-3-super-120b-a12b | | | |
| GET /v1/models?verbose=true | | | | TPM / RPM caps and prices for the four IDs |

## Per tool

For each: used for, what worked, what needs work, minutes to hello-world, would we build on it again.

### Token Factory onboarding and credits
### Nemotron 3.5 Super VL
### Nemotron 3 Nano
### Nemotron 3 Super
### Nemotron 3 Ultra
### Tavily
### Nebius Serverless Jobs
