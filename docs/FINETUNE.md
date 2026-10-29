# Fine-tuning a Nemotron patcher

Goal (gib, 26 October 2026, issue #97): by the end of the week, a first small fine-tune of one Nemotron model on our own repairs, measured against the same model with our prompts on the same failures.

**Status, 27 October, 14:05 Paris:** the dataset is built from the saved patch-loop runs and the call log keeps every request and answer in full. The Nemotron Nano LoRA on AI Cloud (`jobs/finetune-nano/`) moves to issue #122. The stand-in on Token Factory, a LoRA of Qwen3 30B-A3B (section 5), is trained: job `ftjob-5c66a1b7020e4bd493d808e9a104853e` waited 11 hours in a queue, trained 40 steps in 49 minutes and cost US$12.20. It cannot be measured. Token Factory no longer deploys LoRA adapters: the cookbook's route answers HTTP 410, "LoRA adapter deployment is no longer available". A dedicated endpoint needs a custom-weights id, which only the beta that Support enables gives (section 5). Four other bases, approved by gib for loss curves only, trained side by side on 27 October for US$27.70 (section 6): on each, validation loss is lowest at epoch 3 or 4 and rises after it, and none of them can be served either. No tuned result exists; the baselines are in section 5, and what Token Factory would need to add is in section 7.

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

The manifest pins the source: `bench/results/patch-loop.json` gains arms (for example from #96), and a rebuild then changes only if a new arm is a Nemotron patcher. The held-out split is frozen too: the builder stops if the cases it would hold out differ from `split.test_cases` in the manifest (a new arm that makes a case fail for the first time would otherwise move it), and a check in the test suite holds every run to it.

## 3. Training and measurement plan

The job, its config and the endpoint script are in `jobs/finetune-nano/` with the exact commands, the spend caps (a 10-step smoke job, then a short endpoint that must load the smoke adapter, before the full run; a `--timeout` on every job and a deletion deadline on every endpoint; US$25.50 if every stop is reached) and what was checked before any spend.

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

Five LoRAs are trained, with loss curves only: none can be served, so none is measured against its base. The baselines are in section 5; the loss curves and why nothing can be served are in sections 5 and 6.

## 5. A stand-in on Token Factory

gib asked on 26 October for a fine-tune on Token Factory itself while Nemotron cannot be tuned there; the Nemotron Nano LoRA moves to issue #122, to be paid with the AI Builders credit he applied for.

**Why not Nemotron there.** Token Factory's fine-tuning list still has no NVIDIA model (checked again on 26 October, section 1).

**The model: `Qwen/Qwen3-30B-A3B-Instruct-2507`.** It is on the list with LoRA and full fine-tuning ([models](https://docs.tokenfactory.nebius.com/post-training/models.md)), it has Nano's shape (30B total, 3B active, US$0.10 and US$0.30 per 1M tokens), and #96 measured it on our harness as Nano's stand-in: a clean first program in 98% of compiles against Nano's 55 to 70%. `openai/gpt-oss-120b` (LoRA too) is the fallback.

**Cost.** No public page or API gives the supervised fine-tuning price (the docs, the public catalog and the API were searched; the API lists only speculative-draft training, 5.0 with no unit). The signed-in console does, under Billing, Prices, eu-north1, as read by the lead for gib on 26 October: LoRA or full fine-tuning of this model US$2.8 per 1M tokens up to 32K context (US$5 at 65K and 131K); a dedicated endpoint US$4.7 per GPU-hour on an H100 and US$5.6 on an H200; balance US$588.12, gib's cap for this work US$100. Token Factory wants at least 131,072 tokens a batch (a first create was refused with a 422 saying so), so at the shortest context, 8,192, the batch is 16 packed sequences, about 7 steps an epoch for our 0.90 million tokens: the job runs 5 epochs (about 35 steps) at a LoRA learning rate of 2e-4, rank 16. Estimate with a 10% margin for Qwen's tokenizer: 4.95 million tokens, US$13.85.

**Serving.** Serverless serves base models only and a tuned model needs custom weights on a dedicated endpoint, a beta Support enables on request ([custom weights](https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/custom-weights.md)); gib asked Support on 26 October at 13:55. Two routes that need no endpoint are tried first by `scripts/finetune-tf.mjs try-serve`: the checkpoint id on the serverless API, and the adapter registered as a LoRA model through `/v0/models`, the route of Token Factory's cookbook `AddLora.ipynb` (the console lists serverless LoRA prices for some models, not seen for this one). For an endpoint, `endpoint-create` reserves its lifetime on the ledger and starts a watchdog that deletes it at the deadline, as on the AI Cloud route.

**Guards.** `scripts/finetune-tf.mjs` refuses to create the job without the console's price and the current balance, and when the estimate would take the balance under the US$15 the live demo needs. It marks the job pending before the paid request, charges the estimate on the bench ledger as soon as the job starts and anything it trained beyond that once at the end; a create whose answer is lost blocks any other create until `adopt` takes the new job or `release --confirm-no-job` gives the reservation back, so a second paid job cannot start by accident (tested against a local stand-in for Token Factory, `tests/providers/finetune-tf.test.ts`).

**The baselines, measured before any training (US$0.22 on the ledger).** The closed loop on the 11 held-out cases, seeds 1 to 12, 5 patches, thinking off (`bench/results/finetune-eval.json`):

| Patcher, held-out cases | Fixed within 5 patches | Fixed on the first patch | Cost per fixed case |
|---|---|---|---|
| Nemotron 3 Nano, Token Factory | 29% [22 to 37] (38 of 132) | 8% | US$0.0014 |
| Qwen3 30B-A3B, Token Factory | 73% [65 to 80] (97 of 132) | 19% | US$0.0005 |
| Nemotron 3 Super, thinking off (seeds 1 to 6, section 3) | 70% [58 to 79] (46 of 66) | 26% | US$0.0014 |
| Nemotron 3 Super, thinking on (seeds 1 to 6, section 3) | 95% [87 to 98] (63 of 66) | 48% | US$0.0029 |

One patch: the model's patch is applied to the same program and rolled out (`tests/measure/finetune-single.test.ts`, `bench/results/finetune-single.json`); every recorded repair passes again first, so a fix is within reach of each prompt. On held-out repair prompts, the repairs recorded on the 11 held-out cases (`bench/finetune/heldout.jsonl`, 150 of the 318 such prompts, picked by a hash; never trained on):

| Model, thinking off | Pass with one patch | Spend |
|---|---|---|
| Nemotron 3 Nano | 9% [6 to 15] (14 of 150) | US$0.0133 |
| Nemotron 3 Super | 47% [39 to 55] (70 of 150) | US$0.0567 |
| Qwen3 30B-A3B | 35% [28 to 43] (53 of 150) | US$0.0192 |

On the 55 in-distribution validation prompts (`val.jsonl`): their cases and seeds are in training and the fine-tune job reports its validation loss on them, so they are no ground for a tuned-against-base claim:

| Model, thinking off | Pass with one patch | Spend |
|---|---|---|
| Nemotron 3 Nano | 20% [12 to 32] (11 of 55) | US$0.0044 |
| Nemotron 3 Super | 47% [35 to 60] (26 of 55) | US$0.0190 |
| Qwen3 30B-A3B | 60% [47 to 72] (33 of 55) | US$0.0066 |

What this says before any training. On the held-out cases plain Qwen3 30B-A3B repairs about as many failures as Super with thinking off within five patches (73% against 70%), at a third of its cost per fix, but its single patches are worse (35% against 47% held out, 19% against 26% first patches in the loop): it gets there by trying more. Nano is far behind both (the case for tuning Nano in #122). The in-distribution prompts flatter Qwen (60% against Super's 47%), which is why they are kept out of any claim. The headline comparison is the closed loop on the 11 held-out cases: a tuned Qwen has to beat 73% within 5 patches and 19% on the first patch, and 35% on the held-out single patches.

**The training.** Job `ftjob-5c66a1b7020e4bd493d808e9a104853e` was submitted on 26 October at 13:09 UTC; its training and validation files were processed by 13:12, and it then waited in a queue (no step, no error, no estimate) until training started at 00:24 UTC on 27 October; it completed at 01:13 UTC, 40 steps, and succeeded at 01:15. It trained 4,357,240 tokens: US$12.20 at US$2.8 per 1M (the ledger keeps the US$13.85 estimate charged at the start, which errs high). One checkpoint an epoch:

| Checkpoint | Train loss | Validation loss (the 55 in-distribution prompts) |
|---|---|---|
| step 8 | 1.381 | 0.789 |
| step 16 | 0.965 | 0.698 |
| step 24 | 0.718 | 0.654 |
| step 32 | 0.571 | 0.635 |
| step 40 | 0.494 | 0.631 |

The validation loss still falls, barely, at the last epoch: no sign of over-fitting on those prompts, which says nothing about the held-out cases.

**Serving.** `try-serve` on 27 October at 01:15 UTC: the checkpoint id on the serverless API answers 404 ("does not exist"), and the cookbook's `/v0/models/upload` route answers 404 too, so neither serves a LoRA of this model without an endpoint. A dedicated endpoint was then asked for directly, without waiting for Support (the lead's call for gib, 27 October): `endpoint-create --custom-weights-id ftckpt_6120136c-631d-41c6-ae65-10d6303a4dc8 --minutes 90` (the step-40 checkpoint, one H200, at most US$8.40) at 01:29 UTC. Token Factory refused it before creating anything, word for word:

> HTTP 422: {"detail":[{"type":"value_error","loc":["body","custom_weights_id"],"msg":"Value error, custom_weights_id must start with 'model-artifact_'","input":"ftckpt_6120136c-631d-41c6-ae65-10d6303a4dc8","ctx":{"error":{}}}]}

The checkpoint's other id (`ft:...`) has the same problem, and nothing in the public API makes a `model-artifact_` id (the live `openapi.json`, version 20261022, has no such route; the docs name only the custom-weights beta that Support enables on request). So the tuned model cannot be served on Token Factory until Support answers (asked on 26 October at 13:55 and 17:35 Paris), and it is not measured. The reservation was released: the attempt cost nothing. When an artifact id exists, the rest is ready: `endpoint-create` with it, the arm `ft-qwen-ft` on the 11 held-out cases (seeds 1 to 12) and the held-out one-patch check, then `endpoint-delete`.

**The documented serverless LoRA route, tried on 27 October at 06:08 UTC.** The `/v0/models/upload` route above came from an older cookbook notebook (`AddLora.ipynb`). The cookbook's fine-tuning notebook ([fine_tune_llama.ipynb](https://github.com/nebius/token-factory-cookbook/blob/main/post-training/fine-tuning-1/fine_tune_llama.ipynb), step 9, "Deploy Your LoRA Adapter") registers a finished job's checkpoint as a serverless LoRA model: `POST /v0/models` with `source` set to `<job id>:<checkpoint id>` and the base model's id, then `GET /v0/models/<name>` until its status is `active`. `try-serve` now uses that route. For our job and its step-40 checkpoint, Token Factory answered, word for word:

> HTTP 410: {"detail":"LoRA adapter deployment is no longer available"}

The page of models that can be fine-tuned says the same in its own words: "Deployment options currently only include via Dedicated endpoints" ([models](https://docs.tokenfactory.nebius.com/post-training/models.md)). `GET /v0/model_artifacts`, where a `model-artifact_` id would come from, answers 403: "You don't have access to the resource or it does not exist". `try-serve` ran again at 06:18 UTC and saved these answers, with the list of serverless models, in `bench/results/finetune-tf.json` (`serve`; the earlier attempts are in `serve_history`). All of it cost nothing: the ledger has each checkpoint-id call at US$0, refused with a 404.

**Spend on the stand-in:** US$12.20 for the training (US$13.85 on the ledger, its estimate), US$0.22 for the baselines, US$0 for serving.

## 6. Fine-tunes on other bases

On 27 October gib asked for several fine-tunes in parallel on the Token Factory balance, inside the same US$100 cap: Qwen3-14B, Meta-Llama-3.1-8B-Instruct, Qwen3-32B and Llama-3.3-70B-Instruct. In the signed-in console (Billing, Prices, eu-north1, read by the lead) these four have a training price and also a serverless "<model>-LoRa" serving price, so a tuned adapter on them looked servable without custom weights. Checked against the API before any spend (27 October, 06:00 to 06:10 UTC):

- All four are on the list of models that can be fine-tuned, with LoRA ([models](https://docs.tokenfactory.nebius.com/post-training/models.md)).
- None of the four is on `GET /v1/models`, which lists 30 serverless models today (saved in `bench/results/finetune-tf.json`, `serve.serverless_models`). Qwen3-32B and Llama-3.3-70B-Instruct left serverless on 31 August 2026 ([August 2026 deprecations](https://docs.tokenfactory.nebius.com/august-2026-deprecation-notice.md)). So the untuned base of each cannot be called for the comparison either.
- LoRA deployment answers HTTP 410 for every model (section 5). The console's "-LoRa" prices date from November 2025 and describe a route that is gone.

So a job on any of them gives a loss curve and nothing to measure. gib approved all four on 27 October for the loss curves alone, at an estimated US$31.67 (4.95 million tokens each with the 10% margin: Qwen3-14B and Llama-3.1-8B at US$0.4 per 1M, US$1.98 each; Qwen3-32B and Llama-3.3-70B at US$2.8, US$13.85 each). With the US$12.42 already spent, #97 stays under its US$100 cap. Same data and recipe as the Qwen3 30B-A3B job: LoRA rank 16, alpha 32, learning rate 2e-4, 16 packed sequences of 8,192 tokens a batch, 5 epochs.

| Base | Trained | Cost | Train loss, step 8 → 40 | Validation loss, step 8 → 40 (lowest) | Served | Tuned against base, held out (5 patches) |
|---|---|---|---|---|---|---|
| Qwen3-30B-A3B-Instruct-2507 | yes, 40 steps in 49 min | US$12.20 | 1.381 → 0.494 | 0.789 → 0.631 (0.631, step 40) | no: LoRA route 410, dedicated endpoint 422 (section 5) | not measured; base 73% [65 to 80] |
| Qwen3-14B | yes, 40 steps in 14 min | US$1.75 | 1.470 → 0.301 | 0.745 → 0.707 (0.620, step 24) | no: base not on serverless | not measurable |
| Llama-3.1-8B-Instruct | yes, 40 steps in 11 min | US$1.71 | 1.593 → 0.431 | 1.266 → 0.778 (0.757, step 32) | no: base not on serverless | not measurable |
| Qwen3-32B | yes, 40 steps in 25 min | US$12.25 | 1.143 → 0.252 | 0.732 → 0.730 (0.611, step 24) | no: base left serverless 31 August | not measurable |
| Llama-3.3-70B-Instruct | yes, 40 steps in 35 min | US$11.98 | 1.582 → 0.327 | 1.061 → 0.750 (0.707, step 24) | no: base left serverless 31 August | not measurable |

The curves, one checkpoint an epoch, as train loss / validation loss (the 55 in-distribution prompts); the lowest validation loss of each base is in bold:

| Checkpoint | Qwen3-30B-A3B | Qwen3-14B | Qwen3-32B | Llama-3.1-8B | Llama-3.3-70B |
|---|---|---|---|---|---|
| step 8, epoch 1 | 1.381 / 0.789 | 1.470 / 0.745 | 1.143 / 0.732 | 1.593 / 1.266 | 1.582 / 1.061 |
| step 16, epoch 2 | 0.965 / 0.698 | 0.953 / 0.663 | 0.801 / 0.647 | 1.210 / 0.888 | 1.093 / 0.760 |
| step 24, epoch 3 | 0.718 / 0.654 | 0.643 / **0.620** | 0.562 / **0.611** | 0.855 / 0.773 | 0.734 / **0.707** |
| step 32, epoch 4 | 0.571 / 0.635 | 0.435 / 0.667 | 0.377 / 0.673 | 0.616 / **0.757** | 0.499 / 0.724 |
| step 40, epoch 5 | 0.494 / **0.631** | 0.301 / 0.707 | 0.252 / 0.730 | 0.431 / 0.778 | 0.327 / 0.750 |

What the curves show, and no more. Train loss falls on every base through epoch 5. On the four dense bases, validation loss is lowest at epoch 3 (epoch 4 for Llama-3.1-8B) and rises after it while train loss keeps falling, the usual sign of overfitting the 881 training examples: 3 epochs would have done, at three fifths of the cost. The Qwen3-30B-A3B mixture of experts (3B active parameters) still improves at epoch 5. Loss is counted per token, and Qwen and Llama cut the same text into different tokens (4,374,855 trained against 4,279,940 over 5 epochs), so the figures compare within a family only. Within Qwen, the lowest validation losses are 0.611 (32B), 0.620 (14B) and 0.631 (30B-A3B): close, on 55 prompts. A lower loss on in-distribution prompts does not show that a model fixes more held-out cases; only serving it would.

The four jobs were created on 27 October between 06:35 and 06:36 UTC, one after the other, and all four succeeded: Qwen3-14B `ftjob-db1c38eb648e481f8c69673a9b9612c5`, Llama-3.1-8B-Instruct `ftjob-e0dc8224df894378a12ce14eec895d11`, Qwen3-32B `ftjob-17e9c5ff1aa0454e83691ee3d388db99`, Llama-3.3-70B-Instruct `ftjob-bddc214108794fffb9f9f5c87284a5df`. Their files were processed within a minute. All four then waited in the queue, shown as `running` with 0 steps, for about 5 hours 50 minutes; they started training within 30 seconds of each other at 12:25 UTC and completed between 12:36 and 13:01 UTC (each job's events, in its state file).

**Spend on the four:** US$27.70 for the training, the trained tokens at the console prices. The ledger keeps the US$31.67 of estimates charged at the start, which err high. No job trained more than its estimate, so no adjustment was charged. #97 has spent US$40.12 in all (US$45.74 on the ledger), under its US$100 cap.

The Llama 3.1 8B job was first refused under the name the list of models gives, `meta-llama/Meta-Llama-3.1-8B-Instruct`, word for word:

> 422 {"detail":"Error code: 422 - {'detail': \"Model doesn't exist or you don't have access to it\"}"}

No job had started (the account's job list showed none on its training file), so its reservation was released, and it was created under `meta-llama/Llama-3.1-8B-Instruct`, the name the cookbook's fine-tuning notebook uses.

Token Factory does not report a validation loss before training; the first figure is the first checkpoint's. `scripts/finetune-tf.mjs --model M` gives each base its own state file (`bench/results/finetune-tf-<base>.json`), lock and job, with the same guards as the first job: the price and balance asked for, the US$15 floor, the pending mark before the paid request, one job per base checked against the account's job list, and every charge on the ledger.

**Serverless model changes after the deadline.** Token Factory's November 2026 notice lists `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` and `nvidia/nemotron-3-super-120b-a12b`, which the app calls, among the models leaving serverless on 9 November 2026, with `nvidia/Nemotron-3_5-Lightning` and `nvidia/Nemotron-3.5-Super-VL` as the replacements it recommends ([November 2026 deprecations](https://docs.tokenfactory.nebius.com/model-deprecations-november-2026.md)). Dedicated endpoints are not affected. The judging ends before that date; a demo that runs after it needs the model ids moved.

## 7. What Token Factory should add

Each point is something this work ran into.

1. **Fine-tuning for Nemotron 3.** The hackathon's own models cannot be tuned on Token Factory: the list of models that can be fine-tuned has no NVIDIA entry, and the public catalog has `fine_tune: null` for every NVIDIA model (section 1). Our repairs had to train a Qwen stand-in, and the Nano LoRA had to move to AI Cloud (issue #122).
2. **Serverless serving for every model it can fine-tune.** Our Qwen3-30B-A3B-Instruct-2507 LoRA trained for US$12.20 and cannot be called: its checkpoint id answers 404 on the serverless API, and LoRA deployment answers 410 (section 5). The four other bases in section 6 trained for US$27.70, and neither they nor their adapters can be served.
3. **Custom weights as self-serve, not a beta granted by Support.** A dedicated endpoint for the tuned weights was refused with a 422 ("custom_weights_id must start with 'model-artifact_'"), `GET /v0/model_artifacts` answers 403, and no public route makes an artifact id. Support was asked on 26 October at 13:55 and 17:35 Paris; no answer by 27 October 07:15.
4. **Fine-tuning prices published outside the signed-in console.** No public page or API gives the supervised fine-tuning price; the API lists only the speculative-draft price, "5.0" with no unit (section 5). The script has to be given the price by hand (`--usd-per-mtok`), read in the console by a person.
5. **The queue made visible.** Our job showed `running` with 0 steps and no total or estimate from 13:09 to 00:24 UTC, 11 hours 15 minutes, before its first event "Training started" (`bench/results/finetune-tf.json`, the job's events). The four jobs of section 6 then waited the same way for about 5 hours 50 minutes, from 06:35 to 12:25 UTC. Both waits ended at about 25 minutes past the hour, at 00:24 and 12:25 UTC; two waits are too few to tell whether jobs start on a schedule. A `queued` status, a place in the queue or an estimated start would have told us to plan around it.
6. **One story across docs, cookbook and console.** The cookbook still documents `POST /v0/models` for LoRA deployment, and the console still lists "-LoRa" serving prices, for a route that now answers 410. The list of models that can be fine-tuned names `meta-llama/Meta-Llama-3.1-8B-Instruct`, which the fine-tuning API refuses with a 422; it takes `meta-llama/Llama-3.1-8B-Instruct` (section 6).

## Reproduce

Build the dataset on Apple silicon (no network, no spend, about 7 minutes on an M4):

```bash
FINETUNE_BUILD=1 node_modules/.bin/vitest run tests/measure/finetune-data.test.ts --reporter=verbose
```

Check the builder, the split and the call log without building:

```bash
node_modules/.bin/vitest run tests/measure/finetune-data.test.ts tests/providers/call-log.test.ts
```
