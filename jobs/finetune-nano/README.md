# Nano LoRA on Nebius AI Cloud (issue #97)

A LoRA of Nemotron 3 Nano 30B-A3B on the patch-loop repairs in `bench/finetune/`, trained in a Nebius Serverless AI Job and served for the evaluation by a Serverless AI Endpoint, both on one H100 in eu-north1. Budget approved by gib on 26 October 2026: US$30. `docs/FINETUNE.md` explains the choice.

| File | Runs in | Does |
|---|---|---|
| `train.sh` | the job, image `nvcr.io/nvidia/nemo-automodel:26.10.00` | fetches the dataset and these files from this repository at a pinned commit, the model at a pinned revision, trains, copies the adapter to the bucket and prints its tensor names |
| `prepare.py` | the job | checks the dataset against `manifest.json`, sets the chat template's thinking default to off, writes the final config |
| `lora.yaml` | the job | NVIDIA's single-GPU Nano LoRA recipe with our data, 3 epochs, rank 16 |
| `serve.sh` | the endpoint, image `vllm/vllm-openai:v0.18.0-cu130` | serves `nano-base` and `nano-ft` (the adapter) from one engine |

Checked before any spend: `prepare.py` on the committed dataset and the model's template at the pinned revision; every training example renders as the thinking-off generation prompt, then the answer, then `<|im_end|>`, so the loss falls on the answer alone and the prompt is the one the endpoint builds. Not checked yet (the smoke run shows it): memory on one H100, the AutoModel container's entry point, and whether vLLM loads the adapter's tensor names.

## Spend

H100 US$4.50 per GPU-hour, no separate CPU or RAM line for that platform ([compute pricing](https://docs.nebius.com/compute/resources/pricing.md)); disks and the bucket cost cents.

| Step | Cap | Expected |
|---|---|---|
| Smoke job, 10 steps | `--timeout 1h`: US$4.50 | about 30 minutes, mostly the 60 GB download |
| Full job, 3 epochs | `--timeout 3h`: US$13.50 | about 1 hour |
| Endpoint | stopped by hand after the evaluation | about 1.5 hours: US$7 |

Worst case with the caps about US$25; every resource is deleted at the end.

## Commands

After `nebius profile create` (gib), from a shell with the profile:

```bash
REF=<commit of gibouu/understudy with bench/finetune and this folder>
PROJECT_ID=<the eu-north1 project>
SUBNET_ID=$(nebius vpc subnet list --parent-id "$PROJECT_ID" --format json | jq -r '.items[0].metadata.id')
BUCKET_ID=$(nebius storage bucket create --name "understudy-ft-$(date +%s)" --parent-id "$PROJECT_ID" --format json | jq -r '.metadata.id')
FETCH="python3 -c 'import sys, urllib.request as u; u.urlretrieve(sys.argv[1], sys.argv[2])'"
JOB=(nebius ai job create --parent-id "$PROJECT_ID" --subnet-id "$SUBNET_ID"
  --image nvcr.io/nvidia/nemo-automodel:26.10.00 --platform gpu-h100-sxm --preset 1gpu-16vcpu-200gb --disk-size 250Gi
  --volume "$BUCKET_ID:/mnt/data:rw" --env "UNDERSTUDY_REF=$REF" --container-command bash
  --args "-c \"$FETCH https://raw.githubusercontent.com/gibouu/understudy/$REF/jobs/finetune-nano/train.sh /tmp/train.sh && bash /tmp/train.sh\"")

# 1. smoke: 10 steps, checks memory, the entry point and the adapter's tensor names
"${JOB[@]}" --name nano-lora-smoke --env RUN=smoke --env MAX_STEPS=10 --timeout 1h
nebius ai logs <job-id>

# 2. the full run
"${JOB[@]}" --name nano-lora --env RUN=full --timeout 3h

# 3. the endpoint (token auth at the Nebius gateway; the token stays in a file outside the repo)
nebius ai endpoint create --name nano-eval --parent-id "$PROJECT_ID" --subnet-id "$SUBNET_ID" \
  --image vllm/vllm-openai:v0.18.0-cu130 --platform gpu-h100-sxm --preset 1gpu-16vcpu-200gb --disk-size 250Gi --shm-size 16Gi \
  --volume "$BUCKET_ID:/mnt/data:ro" --env RUN=full --container-port 8000 --public --auth token --token "$(cat <token file>)" \
  --container-command bash \
  --args "-c \"$FETCH https://raw.githubusercontent.com/gibouu/understudy/$REF/jobs/finetune-nano/serve.sh /tmp/serve.sh && bash /tmp/serve.sh\""

# 4. after the evaluation: delete everything
nebius ai endpoint delete <endpoint-id>
nebius ai job delete <job-id>
nebius storage bucket delete "$BUCKET_ID"
```

The flags follow the Nebius docs and the [train-and-serve example](https://github.com/nebius/serverless-ai-cookbook/blob/main/training/train-and-serve/README.md); how `--args` splits a quoted command is the first thing the smoke run confirms.
