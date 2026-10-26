#!/usr/bin/env bash
# The evaluation endpoint (issue #97): a Nebius Serverless AI Endpoint on 1x H100, image
# vllm/vllm-openai:v0.18.0-cu130 (vLLM lists LoRA support for NemotronHForCausalLM from 0.18),
# the run bucket mounted read-only at /mnt/data, token auth at the Nebius gateway.
#
# One engine serves both sides of the comparison, so serving differences cancel out:
#   model "nano-base"  Nemotron 3 Nano 30B-A3B, BF16, no adapter
#   model "nano-ft"    the same weights with the LoRA adapter from the job
# Env: RUN (the job's output folder in the bucket).
set -euo pipefail
RUN=${RUN:?the folder the training job wrote}
MODEL=nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16
MODEL_REVISION=${MODEL_REVISION:-bf77c3174f68ad409e1c2aa60daeb46e32d1c606}
RANK=$(python3 -c "import json; print(json.load(open('/mnt/data/$RUN/adapter/adapter_config.json'))['r'])")
exec vllm serve "$MODEL" \
  --revision "$MODEL_REVISION" \
  --served-model-name nano-base \
  --trust-remote-code \
  --max-model-len 4096 \
  --enable-lora \
  --max-loras 1 \
  --max-lora-rank "$RANK" \
  --lora-modules "nano-ft=/mnt/data/$RUN/adapter" \
  --host 0.0.0.0 --port 8000
