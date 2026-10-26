# Fine-tuning a Nemotron patcher

Goal (gib, 26 October 2026, issue #97): by the end of the week, a first small fine-tune of one Nemotron model on our own repairs, measured against the same model with our prompts on the same failures.

**Status, 26 October:** the dataset is built from the saved patch-loop runs and the call log now keeps every request and answer in full. gib approved up to US$30 of AI Cloud (one H100, eu-north1) for the Nano LoRA and its evaluation endpoint. The job is ready in `jobs/finetune-nano/` and waits for the AI Cloud account, billing and CLI login, which are gib's. No training has run and nothing has been spent.

## 1. Where to fine-tune on Nebius

Checked on 26 October 2026 on the pages linked; the live Token Factory API was read with GET requests only (no job, no endpoint created).

| Option | Model | Training | Serving the tuned model | Cost | Blocker |
|---|---|---|---|---|---|
| Token Factory fine-tuning | none of the Nemotron models | managed LoRA or full SFT | dedicated endpoint | not published | **No NVIDIA model is on the list** [1] [2] |
| **AI Cloud Serverless Job, then Serverless Endpoint** | **Nemotron 3 Nano 30B-A3B** | LoRA, NeMo AutoModel single-GPU recipe [6], 1x H100 80 GB | vLLM on 1x H100 [8] [9] | H100 US$4.50/GPU-h on demand, preemptible from US$0.79 [5] | paid by card (credits are Token Factory only [11]); H100 quota in eu-north1 |
| Token Factory dedicated endpoint with our weights | Nano (template exists) | trained as above, merged | Token Factory, same API as today | per GPU-hour, price not published [3] | custom weights are a beta enabled by Support, no timeline [4] |
| AI Cloud, 8 GPUs | Nemotron 3 Super 120B | LoRA "requires 8x80GB" [7] | 8x H100 | US$36/h on demand | cost; H100 and H200 come as 1 or 8 GPUs only [5] |

What each source says:

1. **Token Factory fine-tunes Qwen, Llama, gpt-oss, DeepSeek and Gemma, no NVIDIA model.** The list of supported models has no NVIDIA entry ([post-training/models](https://docs.tokenfactory.nebius.com/post-training/models.md)); in the public catalog every NVIDIA model has `fine_tune: null` ([models_info](https://tokenfactory.nebius.com/api/public/models_info)). The fine-tuning API is OpenAI-compatible: chat JSONL with `messages`, `lora`, `lora_r` 8 to 128, `n_epochs` 1 to 20, context 8k to 128k ([how-to](https://docs.tokenfactory.nebius.com/post-training/how-to-fine-tune.md), [datasets](https://docs.tokenfactory.nebius.com/post-training/datasets.md), and the live `openapi.json`, version 20261022).
2. Serverless (per-token) inference serves base models only; a tuned model needs a dedicated endpoint, billed per GPU-hour by the minute, price not published ([dedicated endpoints](https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/overview.md)).
3. `GET /v0/dedicated_endpoints/templates` lists `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` (fp8) on 1, 2 or 4 H100 in eu-north1 and 1 to 8 H200 in us-central1, and the create request takes a `custom_weights_id`. The public catalog does not tag Nano as a dedicated-endpoint model; the API is the stronger evidence that a Nano endpoint can be created.
4. "Custom model weights" is "currently in beta and available on request" through Support ([custom weights](https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/custom-weights.md)). Asking costs nothing and could run in parallel.
5. AI Cloud GPU prices per GPU-hour: H100 US$4.50 (eu-north1 only), H200 US$5.40, RTX PRO 6000 US$1.80, preemptible (dynamic spot) from US$0.79 ([nebius.com/prices](https://nebius.com/prices), [compute pricing](https://docs.nebius.com/compute/resources/pricing.md)). H100 and H200 come only as 1-GPU or 8-GPU presets ([VM types](https://docs.nebius.com/compute/virtual-machines/types.md)). The L40S line in `docs/research/token-factory.md` (US$1.35) is the GPU alone; the 1-GPU preset is about US$1.55.
6. NVIDIA's NeMo AutoModel has a single-GPU BF16 LoRA recipe for Nano ([nemotron_nano_v3_singlegpu_lora.yaml](https://github.com/NVIDIA-NeMo/Automodel/blob/main/examples/llm_finetune/nemotron/nemotron_nano_v3_singlegpu_lora.yaml)); its CI runs it on one H100. Axolotl has Nemotron-H examples, Nano QLoRA at 4,096 tokens in chat format ([axolotl nemotron-h](https://github.com/axolotl-ai-cloud/axolotl/tree/main/examples/nemotron-h)).
7. LoRA of Super needs 8x 80 GB in NVIDIA's recipe (same AutoModel examples folder).
8. The Nano model card serves it with vLLM 0.12 or later at tensor parallel 1, H100 80 GB among the tested GPUs ([model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16)); vLLM lists LoRA support for `NemotronHForCausalLM`, MoE included ([supported models](https://github.com/vllm-project/vllm/blob/main/docs/models/supported_models.md)). Merging the adapter into the weights is the fallback.
9. Nebius Serverless AI runs any container as a Job (1 to 168 h, preemptible allowed, [jobs](https://docs.nebius.com/serverless/jobs/manage.md)) or an Endpoint with an HTTPS URL ([deploy a model](https://docs.nebius.com/serverless/tutorials/deploy-model.md)); the [serverless-ai-cookbook](https://github.com/nebius/serverless-ai-cookbook) has a train-then-serve example (LoRA job, adapter to Object Storage, vLLM endpoint loading it). There is no Nemotron template.
10. Hackathon rules: "runs on Nebius" is a Token Factory call or AI Cloud compute (Serverless Jobs, Endpoints, DevPods); NVIDIA models through other hosts are disallowed; nothing is said about fine-tuned models ([rules](https://nebiusglobalaihackathon.devpost.com/rules), [FAQ](https://nebiusglobalaihackathon.devpost.com/details/faqs)). A Nano adapter served on a Nebius endpoint stays on Nebius.
11. The promo credits are Token Factory credits; the FAQ names no AI Cloud grant ([FAQ](https://nebiusglobalaihackathon.devpost.com/details/faqs)). AI Cloud time goes on the card.

Not verified: whether the Nebius Axolotl image or vLLM 0.18 handles a Nano adapter (a merged model avoids the question); the memory of LoRA at our sequence length on one H100 (the training prompts were billed at a median 884 tokens and at most 1,260, the answers at a median 111 and at most 213: under 1,500 tokens an example, shorter than the 4,096 tested by Axolotl); how fast a new AI Cloud account gets H100 quota; how long Support takes for custom weights.

**Recommendation.** Nano on AI Cloud: one LoRA job on 1x H100, then one vLLM endpoint on 1x H100 for the evaluation only, stopped right after. Estimate (ours, not a quote): the training set is about 0.9 million tokens, so 3 epochs are about 2.7 million tokens; at 1,500 to 5,000 tokens/s that is 10 to 30 minutes of training plus about 30 minutes of download and set-up: about 1 GPU-hour, 2 at most (US$4.50 to US$9 on demand). The endpoint for the evaluation: about 2 hours (US$9). With a retry, **about US$30 in all, on the card**; preemptible H100s would cut the training part to about US$2 but may be interrupted. The base model's side of the comparison runs on Token Factory serverless and costs cents.

**Decision (gib, 26 October):** approved, up to US$30 of AI Cloud (H100, eu-north1) for the Nano LoRA and its evaluation endpoint. Still open and free: asking Token Factory Support to enable custom weights for a Nano dedicated endpoint, which would put the tuned model behind the same API as the others.

## 2. The dataset

### What is logged

| Source | Holds | Missing for training |
|---|---|---|
| `bench/results/patch-loop.json` | 3,021 runs in 25 arms: knobs, every patch (`set`, `why`, `expect`, cut at 400 characters), metrics, verdicts, tokens, cost per call | the prompts, the raw answers, the reasoning |
| `bench/results/ledger.jsonl` | 10,761 charges (one per paid call or failed attempt): model, tokens, cost | everything else |
| `bench/results/interview.json`, `label.json`, `session.json` | outcomes per turn | prompts and answers |

**Added (issue #78):** `scripts/call-log.mjs` writes one JSONL record per model call to `bench/calls/<script>-<start>-<pid>.jsonl`: the stage, the model and settings, the full messages, the full answer and reasoning, usage and cost, a session id and the parent call. The patch loop adds a verdict record after each rollout (pass, score before and after, failure class, the knobs that changed), linked by the call's id, and saves that id in the results file next to the call. `bench-session`, `bench-interview` and `bench-label` log their calls too. Keys are redacted from every line and media never enters the log: every base64 data URI anywhere in a record, request, answer or error, becomes its type, size and hash. A record that cannot be written is reported once on stderr and never stops a paid run. Sessions in the app are not logged yet: that needs the opt-in for user clips that #78 asks for, and somewhere to keep the records.

### How the old runs become examples

The results file has no prompts, but every prompt can be rebuilt. The failure note is written by the probe from the rollout, the rollout is set by the case, the seed and the knobs, and all three are saved. `tests/measure/finetune-data.ts` replays every run in MuJoCo and rebuilds each prompt with the same builders as the live loop (`tests/measure/patch-prompts.ts`, moved out of the test so both use one copy). A run joins the dataset only if the replay reproduces every saved iteration (the knobs, the verdict, the score, the failure class and all metrics at their saved precision) and none of its patches holds a number with as many digits as the save keeps: such a number may have been rounded when it was saved, and a later prompt that quotes it would differ from what the model saw. An answer whose `why` or `expect` reached the 400-character save limit is left out, since it was probably cut. Fidelity is checked a second way: two calls to the same model with the same rebuilt prompt must have been billed the same number of prompt tokens. Replay is exact on the machine type that ran the loop (Apple silicon, macOS), which is where the dataset was built. On Linux x86 (the CI runner) the bead pours, chaotic and full of contacts, drift from the last floating-point bit until it shows at the saved precision; the check then drops those runs rather than mislabel them, so build the dataset on a Mac.

Result on the saved file: 1,150 runs had something to rebuild (training cases with at least one patch, in a case and seed that some run repaired); all 1,150 replayed exactly. Their patches hold 621 numbers that are not whole, none at the saved precision. A longer number whose extra digits round away (1.0004 saved as 1) cannot be seen, but nine such numbers in ten would show at the limit, so with none there the chance that one slipped through is small; the call log removes the question for new runs. They contain 2,857 usable calls. 459 rebuilt prompts were sent more than once to the same model with the same thinking setting, and every one of them was billed the same number of prompt tokens each time.

Left out on purpose: arms of another vendor's model (from the comparison in #96, so no other model's answers train Nemotron), the liquid pour (its solver changed after those runs, so they do not replay), and prompts that carry a distilled playbook (its rules were distilled from Earth and Mars repairs that include held-out cases). The matched controls, whose playbook section reads "(none)", stay in. The set-up (preflight) calls are a different stage and are not in the supervised set.

### Examples, split and files

- **Supervised example:** system prompt, the rebuilt patch prompt (task, world, knobs with bounds, attempts so far, the failure note) and the patch whose next rollout passed, as the JSON object the model was asked for. The answers come from Super and Ultra, with thinking off and on (only the final answer is kept; the reasoning was never saved). Training Nano on them is distillation from the larger models. Identical (prompt, answer) pairs appear once.
- **Preference pairs:** for one prompt, a patch that passed against a patch that did not, for DPO later (Token Factory's API offers supervised and speculative-draft training only).
- **Split by case:** a case is probe x gravity x disturbance; every seed of a case is on one side, so no held-out failure has a twin in training. Per task, a third of the cases that have solvable failures are held out, in the order of a fixed hash of the case id (FNV-1a, salt `understudy-ft-v1`), at distinct gravities and disturbances. No case was picked by hand.
- **Validation:** 1 prompt in 20 of the training cases, by a hash of the prompt, for the training job's loss.

| | Cases | Examples | By task (insert / place / pour / carry) | By patcher |
|---|---|---|---|---|
| Training | the 20 other cases with solvable failures | 881 repairs | 312 / 257 / 209 / 103 | Super off 404, Super on 299, Ultra off 94, Ultra on 84 |
| Validation | same cases, other prompts | 55 repairs | 11 / 13 / 10 / 21 | |
| Preference pairs | training prompts only | 524 | | |
| Held out | insert: Earth -6 mm with hand-off, Moon -6 mm with hand-off, orbit +4 mm; place: Earth 0.2 g burst, Moon 0.05 g burst, orbit no hand-off; pour: Earth nominal, Moon target +30 mm, orbit nominal; carry: Moon cup with 0.05 g burst, orbit tube with 0.02 g burst | none | 11 cases | |

Training by gravity: orbit 394, Mars 213, Moon 204, Earth 70 (Earth has the fewest: 3 of its 5 failing cases are held out, and the set-up and control arms ran only on the Moon and in orbit). 944 patches passed their next rollout; 8 duplicates were dropped. The prompts are a median 884 tokens and the answers 111: an epoch is 0.90 million tokens (802,047 prompt and 97,554 answer tokens, as billed).

Files (`bench/finetune/`, rebuilt by the command below, synthetic data only: no clip, no person, no key):

| File | Lines | What |
|---|---|---|
| `train.jsonl`, `val.jsonl` | 881, 55 | `{"messages":[system, user, assistant]}`, the format of Token Factory, TRL and NeMo AutoModel's `ChatDataset` |
| `train.meta.jsonl`, `val.meta.jsonl` | same | line by line: case, seed, arm, attempt, patcher, model, verdict and scores |
| `pairs.jsonl` | 524 | `{"prompt":[system, user], "chosen":[assistant], "rejected":[assistant]}`, TRL's conversational preference format |
| `manifest.json` | | the split, the SHA-256 of the source file and of each output, and the counts above |

The manifest pins the source: `bench/results/patch-loop.json` gains arms (for example from #96), and a rebuild then changes only if a new arm is a Nemotron patcher.

## 3. Training and measurement plan

The job, its config and the endpoint script are in `jobs/finetune-nano/` with the exact commands, the spend caps (a 10-step smoke run first, `--timeout` on every job, the endpoint deleted after the evaluation) and what was checked before any spend.

1. **Train:** NVIDIA's `nemotron_nano_v3_singlegpu_lora.yaml` (NeMo AutoModel) in a Nebius Serverless Job on 1x H100, in NVIDIA's `nemo-automodel:26.10.00` container, with these changes (`jobs/finetune-nano/lora.yaml`): AutoModel's `ChatDataset` on `train.jsonl` and `val.jsonl`, `mask_history` and `mask_generation_prompt` (loss on the answer only), `seq_length: 2048` (the longest training example is under 1,500 tokens), 3 epochs, LoRA rank 16 and alpha 32 as in NVIDIA's chat recipe `customizer_nemotron_nano_peft.yaml`, learning rate 1e-4, a checkpoint each epoch in the bucket. The patcher runs with thinking off, and Nano's template turns thinking on unless told otherwise; the container's AutoModel release (r0.7.0) cannot pass template arguments (`chat_template_kwargs` arrived on its main branch on 26 October), so `prepare.py` flips the template's own default to off. Checked offline: every training example then renders as the thinking-off generation prompt, the answer and `<|im_end|>`.
2. **Serve:** a Serverless Endpoint with vLLM 0.18 on 1x H100 (`jobs/finetune-nano/serve.sh`), token auth, serving the base weights as `nano-base` and the adapter as `nano-ft` from one engine, so the serving cancels out of the comparison; deleted as soon as the evaluation ends.
3. **Measure:** the patch loop on the held-out cases only, seeds 1 to 12 (none of them in training at any seed), 5 patches, thinking off, three arms with the same prompts: `nano-base` and `nano-ft` on the endpoint (the comparison), and Nano on Token Factory as the product calls it today (fp8, for reference). Reported: fix rate of the solvable failures within 5 patches and on the first patch, with Wilson 95% intervals and Newcombe's interval for the difference; cost per fixed case (tokens at list price for the base; endpoint hours at US$4.50 for the tuned model, and what that would be at full use); model time per fix. Super with thinking off on the same cases (seeds 1 to 6, already saved) is the reference.
   The held-out cases are about as hard as the whole grid. In the saved round-2 runs (seeds 1 to 6, 66 solvable failures, all failing at iteration 0):

   | Patcher on the held-out cases | Fixed within 5 patches | Fixed on the first patch | Cost per fixed case |
   |---|---|---|---|
   | Super, thinking off | 70% [58 to 79] (46 of 66) | 26% | US$0.0014 |
   | Super, thinking on (4k) | 95% [87 to 98] (63 of 66) | 48% | US$0.0029 |
   | Escalation: Super off, then on | 95% [87 to 98] (63 of 66) | 29% | US$0.0020 |

   Over the whole grid the same patchers fix 69% and 94% (`docs/MEASUREMENTS.md`, section 8).
4. The arms need two small changes to `tests/measure/patch-loop.test.ts`: a Nano role and a model served at another base URL. The comparison in #96 is editing the same file, so these land after it.

## 4. Result

None yet: no training has run.

## Reproduce

Build the dataset on Apple silicon (no network, no spend, about 7 minutes on an M4):

```bash
FINETUNE_BUILD=1 node_modules/.bin/vitest run tests/measure/finetune-data.test.ts --reporter=verbose
```

Check the builder, the split and the call log without building:

```bash
node_modules/.bin/vitest run tests/measure/finetune-data.test.ts tests/providers/call-log.test.ts
```
