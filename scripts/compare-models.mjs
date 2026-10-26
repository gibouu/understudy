// Nemotron against other models (issue #96): the comparators, how each one's reasoning is switched,
// and the study's budget. Shared by scripts/bench-compare-probe.mjs, scripts/bench-label.mjs (--model),
// tests/measure/compile-compare.test.ts and tests/measure/patch-loop.test.ts (the cmp-* arms).
//
// The product calls only Nemotron. These models are called only by the bench, all through Token
// Factory (the same API, keys and billing), never another host.
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The catalogue as listed live on 26 October 2026 (GET /v1/models?verbose=true): prices and modalities. */
export const COMPARE_CATALOGUE = path.join(ROOT, "tests/fixtures/models-compare.json");

/** Every ledger script of this study, capped together. */
export const COMPARE_SCRIPTS = ["compare-probe", "compare-compile", "compare-patch", "compare-label"];
/** The study's own cap (issue #96), under the ledger's global cap. */
export const COMPARE_CAP_USD = 25;

export const ENABLE_THINKING_OFF = { extra_body: { chat_template_kwargs: { enable_thinking: false } } };

/**
 * The comparators, matched by size class (total and active parameters, from the catalogue's descriptions or
 * the model's name). `off` is the request change that gives the least hidden reasoning the model allows, `on`
 * its default; both were checked in bench/results/compare-probe.json. A model whose reasoning cannot be
 * switched off says so in `off_note` and has `always_reasons`: its "off" arms get the token budget of an
 * "on" arm, since the reasoning has to fit in it (cost counts the tokens used, not the budget).
 */
export const COMPARATORS = {
  "Qwen/Qwen3-30B-A3B-Instruct-2507": {
    short: "qwen3-30b",
    name: "Qwen3 30B-A3B Instruct 2507",
    size: "30B total, 3B active",
    stands_in_for: "nano",
    off: ENABLE_THINKING_OFF,
    on: null,
    off_note: "an instruct model: it has no hidden reasoning to switch",
  },
  "openai/gpt-oss-120b": {
    short: "gpt-oss-120b",
    name: "gpt-oss-120b",
    size: "117B total, 5.1B active",
    stands_in_for: "super",
    off: { reasoning_effort: "low" },
    on: {},
    off_note: "reasoning cannot be switched off (enable_thinking is ignored); off here means reasoning_effort low",
    always_reasons: true,
  },
  "Qwen/Qwen3.5-397B-A17B": {
    short: "qwen3.5-397b",
    name: "Qwen3.5 397B-A17B",
    size: "397B total, 17B active",
    stands_in_for: "super",
    off: ENABLE_THINKING_OFF,
    on: {},
    off_note: null,
  },
  "meta-models/muse-spark-open": {
    short: "muse-spark",
    name: "Muse Spark (open)",
    size: "816B total, about 42B active",
    stands_in_for: "ultra",
    off: { reasoning_effort: "low" },
    on: {},
    off_note: "reasoning cannot be switched off (enable_thinking false made it longer; effort none is refused); off here means reasoning_effort low",
    always_reasons: true,
    video: true,
  },
};
