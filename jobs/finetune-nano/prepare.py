"""Prepare the Nano LoRA job (issue #97): check the dataset, build the chat template, write the config.

Run by train.sh inside the job, in a folder holding train.jsonl, val.jsonl, manifest.json,
lora.yaml and the model snapshot. Fails before any training if a file does not match the
manifest that the dataset builder wrote (tests/measure/finetune-data.test.ts).

The patcher is served with thinking off. Nano's template turns thinking on unless the caller says
otherwise; ChatDataset in the NeMo AutoModel release of the 26.10 container cannot pass template
arguments, so the template's own default is flipped to off. A stored assistant turn renders the
same either way ("<think></think>" and the answer); the default decides the generation prompt that
mask_generation_prompt leaves out of the loss, and with thinking off it is the one the served
model is given: "<|im_start|>assistant\\n<think></think>".

  python prepare.py --model-dir DIR --checkpoint-dir DIR [--max-steps N] > final.yaml
"""

import argparse
import hashlib
import json
import os
import sys

import yaml

THINKING_DEFAULT = "{%- set enable_thinking = enable_thinking if enable_thinking is defined else True %}"


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def thinking_off(template: str) -> str:
    if template.count(THINKING_DEFAULT) != 1:
        raise SystemExit("the chat template's thinking default is not where it was: check the model revision")
    return template.replace(THINKING_DEFAULT, THINKING_DEFAULT.replace("else True", "else False"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--checkpoint-dir", required=True)
    ap.add_argument("--max-steps", type=int, default=0, help="a smoke run: stop and save after N steps")
    a = ap.parse_args()

    manifest = json.load(open("manifest.json"))
    for name in ("train.jsonl", "val.jsonl"):
        want = manifest["files"][name]["sha256"]
        if sha256(name) != want:
            raise SystemExit(f"{name} does not match manifest.json")
    print(f"dataset ok: {manifest['files']['train.jsonl']['lines']} train, {manifest['files']['val.jsonl']['lines']} val", file=sys.stderr)

    template = thinking_off(open(os.path.join(a.model_dir, "chat_template.jinja")).read())
    cfg = yaml.safe_load(open("lora.yaml"))
    cfg["model"]["pretrained_model_name_or_path"] = a.model_dir
    cfg["checkpoint"]["checkpoint_dir"] = a.checkpoint_dir
    for key, name in (("dataset", "train.jsonl"), ("validation_dataset", "val.jsonl")):
        cfg[key]["path_or_dataset_id"] = os.path.abspath(name)
        cfg[key]["chat_template"] = template
    if a.max_steps:
        cfg["step_scheduler"]["max_steps"] = a.max_steps
        cfg["step_scheduler"]["ckpt_every_steps"] = a.max_steps
        cfg["step_scheduler"]["val_every_steps"] = a.max_steps
    yaml.safe_dump(cfg, sys.stdout, sort_keys=False, width=1 << 20)


if __name__ == "__main__":
    main()
