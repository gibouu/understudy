# Devpost: the fine-tuning answer

Ready to paste into the Devpost fine-tuning question: the text between the two rules. Every number in it is traced in the table below.

---

Yes: five LoRA fine-tunes on Nebius Token Factory, all finished (status `succeeded`), for loss curves only.

The data is our own: 881 training repairs and 55 validation repairs, rebuilt from saved runs of Understudy's patch loop, where a model reads why a simulated SO-101 rehearsal failed and patches the robot program. A repair counts only if the next rollout passed. Eleven cases are held out, picked by a fixed hash.

Token Factory cannot fine-tune any NVIDIA model, so the bases are Qwen3 30B-A3B (Nemotron Nano's shape), Qwen3 14B, Qwen3 32B, Llama 3.1 8B and Llama 3.3 70B: LoRA rank 16, 5 epochs, 40 steps each. Training cost US$39.90 (US$12.20 for the first, US$27.70 for the other four); the whole fine-tuning effort, baselines included, spent US$40.12 of a US$100 cap.

What we learned: on the dense bases validation loss is lowest at epoch 3 (epoch 4 for Llama 3.1 8B) and rises after it while train loss keeps falling, so 3 epochs would have done; the 30B-A3B mixture of experts still improves at epoch 5.

What we cannot claim: no tuned model was measured. Token Factory answers HTTP 410 to LoRA deployment ("LoRA adapter deployment is no longer available"), a dedicated endpoint needs custom weights that only Support enables, and four of the bases are no longer on serverless. The product runs on Nemotron, untuned. Loss curves and every refusal word for word: https://github.com/gibouu/understudy/blob/main/docs/FINETUNE.md

---

## Where each number comes from

| Claim | Source |
|---|---|
| five jobs, all `succeeded`, 40 steps each | `job.status` and the step-40 checkpoint in `bench/results/finetune-tf.json` and the four `bench/results/finetune-tf-<base>.json`; `docs/FINETUNE.md` sections 5 and 6 |
| 881 training, 55 validation repairs; 11 held-out cases by hash | `docs/FINETUNE.md` section 2 (table "Examples, split and files"), `bench/finetune/manifest.json` |
| no NVIDIA model can be fine-tuned on Token Factory | `docs/FINETUNE.md` section 1, source 1 |
| LoRA rank 16, 5 epochs | `docs/FINETUNE.md` sections 5 and 6 |
| US$12.20 (Qwen3 30B-A3B) | 4,357,240 trained tokens (`job.trained_tokens`, `finetune-tf.json`) x US$2.8 per 1M; `docs/FINETUNE.md` section 5 |
| US$27.70 (four bases) | trained tokens x console price: Qwen3 14B 4,374,855 x 0.4 = 1.75; Llama 3.1 8B 4,279,940 x 0.4 = 1.71; Qwen3 32B 4,374,855 x 2.8 = 12.25; Llama 3.3 70B 4,279,940 x 2.8 = 11.98; `docs/FINETUNE.md` section 6 |
| US$39.90 training | 12.20 + 27.70 |
| US$40.12 of a US$100 cap | 39.90 + US$0.22 of baselines; `docs/FINETUNE.md` section 6, "Spend on the four". The ledger holds US$45.74 (`finetune-tf` 45.52 + `finetune-eval` 0.22 in `bench/results/ledger.jsonl`), because it keeps the estimates charged at the start, which err high |
| lowest validation loss at epoch 3 (epoch 4 for Llama 3.1 8B); 30B-A3B still falls at epoch 5 | `checkpoints` in each state file; `docs/FINETUNE.md` section 6, the curves table |
| HTTP 410, custom weights through Support, bases off serverless | `serve` in `bench/results/finetune-tf.json`; `docs/FINETUNE.md` sections 5 and 6 |

Before pasting, check `docs/SUBMIT.md`: its "Approach" line still says "no fine-tuning", which this answer contradicts.
