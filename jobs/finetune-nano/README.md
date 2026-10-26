# Nano LoRA on Nebius AI Cloud (issue #97)

A LoRA of Nemotron 3 Nano 30B-A3B on the patch-loop repairs in `bench/finetune/`, trained in a Nebius Serverless AI Job and served for the evaluation by a Serverless AI Endpoint, both on one H100 in eu-north1. Budget approved by gib on 26 October 2026: US$30. `docs/FINETUNE.md` explains the choice.

| File | Runs in | Does |
|---|---|---|
| `train.sh` | the job, image `nvcr.io/nvidia/nemo-automodel:26.10.00` | fetches the dataset and these files from this repository at a pinned commit, the model at a pinned revision, trains, copies the adapter to the bucket and prints its tensor names |
| `prepare.py` | the job | checks the dataset against `manifest.json`, sets the chat template's thinking default to off, writes the final config |
| `lora.yaml` | the job | NVIDIA's single-GPU Nano LoRA recipe with our data, 3 epochs, rank 16 |
| `serve.sh` | the endpoint, image `vllm/vllm-openai:v0.18.0-cu130` | serves `nano-base` and `nano-ft` (the adapter) from one engine |

Checked before any spend: `prepare.py` on the committed dataset and the model's template at the pinned revision; every training example renders as the thinking-off generation prompt, then the answer, then `<|im_end|>`, so the loss falls on the answer alone and the prompt is the one the endpoint builds. Not checked yet: memory on one H100 and the AutoModel container's entry point (the smoke job shows them), and whether vLLM loads the adapter (the smoke endpoint shows it).

## Spend

H100 US$4.50 per GPU-hour, no separate CPU or RAM line for that platform ([compute pricing](https://docs.nebius.com/compute/resources/pricing.md)); disks and the bucket cost cents. Every step has a stop: jobs a `--timeout` that Nebius enforces (1 hour at least); endpoints have no timeout in Nebius, so a watchdog on this Mac deletes them at a wall-clock deadline, keeps the Mac from idle sleep meanwhile (`caffeinate -i`) and retries the deletion until the endpoint is gone. A closed lid still suspends the watchdog, and the endpoint bills until the Mac wakes: keep the Mac open and awake while an endpoint lives, and run the evaluation in the same sitting.

| Step | Stop | Expected |
|---|---|---|
| 1. Smoke job, 10 steps | `--timeout 1h`: US$4.50 | about 30 minutes, mostly the 60 GB download |
| 2. Smoke endpoint: vLLM loads the smoke adapter and answers one request | watchdog 40 min: US$3.00 | about 20 minutes |
| 3. Full job, 3 epochs | `--timeout 2h`: US$9.00 | about 1 hour |
| 4. Evaluation endpoint | watchdog 2 h: US$9.00 | about 1.5 hours |

If every stop works: US$25.50 at most, under the US$30 approved. Two things can keep an endpoint billing past its stop, and no watchdog on this Mac can prevent them: the Mac asleep (a closed lid), and Nebius refusing the deletion (an outage, or the CLI login expired). The watchdog then keeps retrying and logs every failure to `$TMPDIR/understudy-ft-watchdog.log`; whoever runs the evaluation stays at the Mac, reads that log at each deadline, and deletes the endpoint from the console if the CLI cannot. The full job starts only after steps 1 and 2 pass, so a recipe or serving problem costs at most US$7.50.

## Commands

After `nebius profile create` (gib), from a shell with the profile:

```bash
REF=<commit of gibouu/understudy with bench/finetune and this folder>
PROJECT_ID=<the eu-north1 project>
SUBNET_ID=$(nebius vpc subnet list --parent-id "$PROJECT_ID" --format json | jq -r '.items[0].metadata.id')
BUCKET_ID=$(nebius storage bucket create --name "understudy-ft-$(date +%s)" --parent-id "$PROJECT_ID" --format json | jq -r '.metadata.id')
FETCH="python3 -c 'import sys, urllib.request as u; u.urlretrieve(sys.argv[1], sys.argv[2])'"
RAW=https://raw.githubusercontent.com/gibouu/understudy/$REF/jobs/finetune-nano
JOB=(nebius ai job create --parent-id "$PROJECT_ID" --subnet-id "$SUBNET_ID"
  --image nvcr.io/nvidia/nemo-automodel:26.10.00 --platform gpu-h100-sxm --preset 1gpu-16vcpu-200gb --disk-size 250Gi
  --volume "$BUCKET_ID:/mnt/data:rw" --env "UNDERSTUDY_REF=$REF" --container-command bash
  --args "-c \"$FETCH $RAW/train.sh /tmp/train.sh && bash /tmp/train.sh\"")
# --auth token with no --token: Nebius generates the token, so it never sits in a command line
ENDPOINT=(nebius ai endpoint create --parent-id "$PROJECT_ID" --subnet-id "$SUBNET_ID"
  --image vllm/vllm-openai:v0.18.0-cu130 --platform gpu-h100-sxm --preset 1gpu-16vcpu-200gb --disk-size 250Gi --shm-size 16Gi
  --volume "$BUCKET_ID:/mnt/data:ro" --container-port 8000 --public --auth token --container-command bash
  --args "-c \"$FETCH $RAW/serve.sh /tmp/serve.sh && bash /tmp/serve.sh\"" --format json)
# a watchdog on this Mac: at a wall-clock deadline, delete the endpoint and retry every 30 s until it is
# deleted or Nebius answers NotFound (its code, case-sensitive: a shell's "command not found" never matches);
# the CLI's absolute path is taken now, so a PATH change later cannot fake a deletion; caffeinate keeps the
# Mac from idle sleep until then (a closed lid still suspends it)
watchdog() {
  local cli deadline=$(( $(date +%s) + $2 * 60 ))
  cli=$(command -v nebius) || { echo "watchdog: no nebius CLI on PATH, endpoint $1 has no deadline" >&2; return 1; }
  nohup caffeinate -i sh -c "
    while [ \$(date +%s) -lt $deadline ]; do sleep 20; done
    until out=\$('$cli' ai endpoint delete $1 2>&1) || echo \"\$out\" | grep -q 'NotFound'; do echo \"\$(date -u +%FT%TZ) \$out\"; sleep 30; done
    echo \"\$(date -u +%FT%TZ) $1 deleted\"" >> "${TMPDIR:-/tmp}/understudy-ft-watchdog.log" 2>&1 &
}

# 1. smoke job: 10 steps; checks memory, the entry point, the --args quoting and the adapter's tensor names
"${JOB[@]}" --name nano-lora-smoke --env RUN=smoke --env MAX_STEPS=10 --timeout 1h
nebius ai logs <job-id>

# 2. smoke endpoint: vLLM must load the smoke adapter and answer as "nano-ft"
EP=$("${ENDPOINT[@]}" --name nano-smoke --env RUN=smoke | jq -r '.metadata.id'); watchdog "$EP" 40
#    then one request to nano-ft with chat_template_kwargs {enable_thinking: false}, and delete it
nebius ai endpoint delete "$EP"

# 3. the full run, only if 1 and 2 passed
"${JOB[@]}" --name nano-lora --env RUN=full --timeout 2h

# 4. the evaluation endpoint; the patch loop calls nano-base and nano-ft on it, then it goes
EP=$("${ENDPOINT[@]}" --name nano-eval --env RUN=full | jq -r '.metadata.id'); watchdog "$EP" 120
nebius ai endpoint delete "$EP"

# 5. clean up
nebius ai job delete <job-id>   # each job
nebius storage bucket delete "$BUCKET_ID"
```

The endpoint's generated token is read from `nebius ai endpoint get` into a file outside the repository (mode 600) and never printed; if `get` does not return it, a MysteryBox secret passed with `--token-secret` replaces it ([endpoint create](https://docs.nebius.com/cli/reference/ai/endpoint/create.md)). The flags follow the Nebius docs and the [train-and-serve example](https://github.com/nebius/serverless-ai-cookbook/blob/main/training/train-and-serve/README.md); how `--args` splits a quoted command is the first thing the smoke job confirms.
