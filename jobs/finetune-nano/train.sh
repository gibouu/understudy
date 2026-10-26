#!/usr/bin/env bash
# The Nano LoRA job (issue #97): a Nebius Serverless AI Job on 1x H100 (gpu-h100-sxm,
# 1gpu-16vcpu-200gb, eu-north1), image nvcr.io/nvidia/nemo-automodel:26.10.00, the run bucket
# mounted read-write at /mnt/data. Everything it reads is public: the dataset and these scripts
# from gibouu/understudy at UNDERSTUDY_REF, the model from Hugging Face at MODEL_REVISION.
#
# Env: UNDERSTUDY_REF (commit holding bench/finetune), RUN (output folder in the bucket),
#      MAX_STEPS (optional: a smoke run that stops and saves after N steps).
# Out: /mnt/data/$RUN/checkpoints (AutoModel's), /mnt/data/$RUN/adapter (the last PEFT
#      adapter, for vLLM), /mnt/data/$RUN/train.log.
set -euo pipefail
REF=${UNDERSTUDY_REF:?the gibouu/understudy commit that holds bench/finetune}
RUN=${RUN:?a folder name for this run in the bucket}
MODEL=nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16
MODEL_REVISION=${MODEL_REVISION:-bf77c3174f68ad409e1c2aa60daeb46e32d1c606}
OUT=/mnt/data/$RUN
WORK=/tmp/ft
mkdir -p "$OUT" "$WORK"
exec > >(tee -a "$OUT/train.log") 2>&1
cd "$WORK"

echo "== $(date -u +%FT%TZ) run $RUN, understudy $REF, $MODEL@$MODEL_REVISION, max_steps ${MAX_STEPS:-all}"
nvidia-smi --query-gpu=name,memory.total --format=csv
# python, not curl: the image is sure to have it
python - "$REF" <<'PY'
import sys, urllib.request
for f in ("bench/finetune/train.jsonl", "bench/finetune/val.jsonl", "bench/finetune/manifest.json", "jobs/finetune-nano/lora.yaml", "jobs/finetune-nano/prepare.py"):
    urllib.request.urlretrieve(f"https://raw.githubusercontent.com/gibouu/understudy/{sys.argv[1]}/{f}", f.split("/")[-1])
PY

echo "== $(date -u +%FT%TZ) model download"
python -c "from huggingface_hub import snapshot_download; snapshot_download('$MODEL', revision='$MODEL_REVISION', local_dir='$WORK/model')"
python prepare.py --model-dir "$WORK/model" --checkpoint-dir "$OUT/checkpoints" ${MAX_STEPS:+--max-steps "$MAX_STEPS"} > final.yaml
cp final.yaml "$OUT/final.yaml"

echo "== $(date -u +%FT%TZ) training"
OMP_NUM_THREADS=8 MKL_NUM_THREADS=8 automodel final.yaml --nproc-per-node 1

echo "== $(date -u +%FT%TZ) adapter"
# the newest checkpoint's PEFT adapter, copied whole to $OUT/adapter for vLLM's --lora-modules
ADAPTER_CONFIG=$(find "$OUT/checkpoints" -name adapter_config.json -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)
if [ -z "$ADAPTER_CONFIG" ]; then echo "no adapter_config.json under $OUT/checkpoints"; find "$OUT/checkpoints" -maxdepth 4 | head -50; exit 1; fi
rm -rf "$OUT/adapter" && cp -r "$(dirname "$ADAPTER_CONFIG")" "$OUT/adapter"
cat "$OUT/adapter/adapter_config.json"
# the tensor names, to check against vLLM's module names before paying for an endpoint
python - "$OUT/adapter" <<'PY'
import glob, sys
from safetensors import safe_open
for path in sorted(glob.glob(f"{sys.argv[1]}/*.safetensors")):
    with safe_open(path, "pt") as f:
        keys = list(f.keys())
    print(path, len(keys), "tensors")
    for k in keys[:12] + ["..."] + keys[-6:]:
        print("  ", k)
PY
echo "== $(date -u +%FT%TZ) done"
