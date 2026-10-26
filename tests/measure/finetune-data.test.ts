/**
 * The fine-tune dataset builder (finetune-data.ts), checked on the saved results; with
 * FINETUNE_BUILD=1 it writes the datasets to bench/finetune/ (no network, no spend):
 *
 *   FINETUNE_BUILD=1 node_modules/.bin/vitest run tests/measure/finetune-data.test.ts --reporter=verbose
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMujoco } from "./gravity-harness";
import { armIncluded, buildDataset, chat, fnv1a, heldOutCases, mayBeRounded, metaLine, pairLine, replayRun, type SavedResults, SPLIT_SALT } from "./finetune-data";
import { caseGrid } from "./patch-probes";
import { PATCH_SYSTEM } from "./patch-prompts";

const ROOT = process.cwd();
const RESULTS = path.join(ROOT, "bench/results/patch-loop.json");
const OUT = path.join(ROOT, "bench/finetune");
const load = () => JSON.parse(readFileSync(RESULTS, "utf8")) as SavedResults;

describe("fine-tune dataset (no network)", () => {
  it("holds out whole cases, a third per task, at distinct gravities, the same every time", () => {
    const failing = new Set(caseGrid().map((c) => c.id));
    const test = heldOutCases(failing);
    expect(heldOutCases(failing)).toEqual(test);
    for (const probe of ["insert", "place", "pour", "carry"]) {
      const mine = test.filter((id) => id.startsWith(`${probe}/`));
      const n = caseGrid().filter((c) => c.probe === probe).length;
      expect(mine.length).toBe(Math.round(n / 3));
      expect(new Set(mine.map((id) => id.split("/")[1])).size).toBe(mine.length);
    }
    expect(fnv1a("")).toBe(0x811c9dc5);
  });

  it("flags saved numbers that may have been rounded on save, and only those", () => {
    for (const v of [12.346, -4.125, 0.1235, 0.0001235]) expect(mayBeRounded(v)).toBe(true);
    for (const v of [56, -4, 4.1, 12.35, 0.05, 0.123, true, "4.125"]) expect(mayBeRounded(v)).toBe(false);
    expect(fnv1a(`${SPLIT_SALT}:a`)).not.toBe(fnv1a(`${SPLIT_SALT}:b`));
  });

  it("rebuilds the prompts of saved runs exactly: the replay reproduces every saved iteration", async () => {
    const mj = await loadMujoco();
    const results = load();
    // one run with an escalation, one with a retried no-op, one with a set-up patch, one per probe
    const runs = results.arms["r2-esc-on"].runs;
    const picks = [
      runs.find((r) => r.iterations.some((it) => it.patch_before?.escalated_after_noop)),
      results.arms["super-off-retry"].runs.find((r) => r.iterations.some((it) => it.patch_before?.retried_after_noop)),
      results.arms["r2-ctrl3-esc"].runs.find((r) => r.preflight && r.iterations.length > 2),
      ...["insert", "place", "pour", "carry"].map((p) => runs.find((r) => r.probe === p && r.iterations.length > 2)),
    ];
    for (const run of picks) {
      expect(run).toBeDefined();
      const { examples, mismatch } = replayRun(mj, results, run!);
      expect(mismatch, `${run!.arm} ${run!.case_id} seed ${run!.seed}`).toBeNull();
      const calls = run!.iterations.slice(1).flatMap((it) => [it.patch_before!, ...(it.patch_before!.escalated_after_noop ? [it.patch_before!.escalated_after_noop] : []), ...(it.patch_before!.retried_after_noop ? [it.patch_before!.retried_after_noop] : [])]);
      expect(examples.length).toBe(calls.filter((c) => c.call.ok && c.call.json_ok && c.set !== null).length);
      for (const e of examples) {
        expect(e.system).toBe(PATCH_SYSTEM);
        expect(e.user).toContain(`Failure note from the last rollout (attempt ${e.attempt - 1}):`);
        expect(e.user).toContain(`Return patch ${e.attempt} of at most 5.`);
        expect(JSON.parse(e.assistant)).toHaveProperty("set");
      }
      // the last patch of a run that passed is a repair
      if (run!.passed_at) expect(examples.at(-1)!.pass_after).toBe(true);
    }
  }, 60_000);

  it("never trains on another vendor's model, the liquid runs or distilled rules", () => {
    const results = load();
    const cfg = results.arms["r2-super-off"].config;
    expect(armIncluded({ config: cfg, runs: [] })).toBeNull();
    expect(armIncluded({ config: { ...cfg, model: "Qwen/Qwen3-32B" }, runs: [] })).toMatch(/Nemotron/);
    expect(armIncluded({ config: { ...cfg, escalate_model: "deepseek-ai/DeepSeek-V4-Pro" }, runs: [] })).toMatch(/Nemotron/);
    expect(armIncluded({ config: { ...cfg, model: "nvidia/Llama-3.1-405B-Instruct-FP8" }, runs: [] })).toMatch(/Nemotron/);
    expect(armIncluded(results.arms["r2-liquid-super-off"])).toMatch(/liquid/);
    expect(armIncluded(results.arms["r2-playbook3"])).toMatch(/rules/);
    expect(armIncluded(results.arms["r2-ctrl3"])).toBeNull();
  });
});

describe.skipIf(process.env.FINETUNE_BUILD !== "1")("fine-tune dataset (build)", () => {
  it(
    "writes bench/finetune/",
    async () => {
      const mj = await loadMujoco();
      const results = load();
      const t0 = performance.now();
      const built = buildDataset(mj, results, { onRun: (k, n) => (k % 250 === 0 || k === n) && console.log(`  replayed ${k}/${n} runs`) });
      // no held-out case reaches training, validation or the pairs
      const test = new Set(built.test_cases);
      for (const e of [...built.train, ...built.val, ...built.pairs.map((p) => p.prompt)]) expect(test.has(e.case_id)).toBe(false);
      const trainPrompts = new Set(built.train.map((e) => e.user));
      for (const e of built.val) expect(trainPrompts.has(e.user)).toBe(false);

      mkdirSync(OUT, { recursive: true });
      const files: Record<string, string> = {
        "train.jsonl": built.train.map((e) => JSON.stringify(chat(e))).join("\n") + "\n",
        "train.meta.jsonl": built.train.map((e) => JSON.stringify(metaLine(e))).join("\n") + "\n",
        "val.jsonl": built.val.map((e) => JSON.stringify(chat(e))).join("\n") + "\n",
        "val.meta.jsonl": built.val.map((e) => JSON.stringify(metaLine(e))).join("\n") + "\n",
        "pairs.jsonl": built.pairs.map((p) => JSON.stringify(pairLine(p))).join("\n") + "\n",
      };
      for (const [name, body] of Object.entries(files)) writeFileSync(path.join(OUT, name), body);
      const testCases = caseGrid().filter((c) => test.has(c.id)).map((c) => c.id);
      const manifest = {
        dataset: "patch-loop repairs, chat format",
        built_from: { file: "bench/results/patch-loop.json", sha256: createHash("sha256").update(readFileSync(RESULTS)).digest("hex") },
        builder: "tests/measure/finetune-data.ts (FINETUNE_BUILD=1 node_modules/.bin/vitest run tests/measure/finetune-data.test.ts)",
        split: { by: "case (probe/gravity/disturbance), every seed on one side", salt: SPLIT_SALT, test_cases: testCases, validation: "about 1 prompt in 20 of the training cases, by a hash of the prompt" },
        files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, { lines: body.split("\n").length - 1, bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") }])),
        ...built.stats,
        build_s: Math.round((performance.now() - t0) / 1000),
      };
      writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      console.log(JSON.stringify({ ...manifest, arms: undefined }, null, 2));
    },
    3600_000,
  );
});
