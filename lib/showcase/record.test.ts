/**
 * The /space recordings, checked and made.
 *
 * Without SHOWCASE_RECORD (CI, `pnpm test`): every public/showcase/<clip>.json
 * parses, belongs to a clip in lib/samples.ts, and each iteration's program,
 * rehearsed again in node, passes and fails where the recording says, with
 * every pass leaving its objects seated where their steps put them. The
 * browser runs the same deterministic physics, so this is what /space shows.
 * No network.
 *
 * Every public/showcase/<clip>.label.json (a clip recorded up to its label)
 * parses and is the clip's own.
 *
 * With SHOWCASE_RECORD the live path runs once per named clip and rewrites
 * its JSON and poster, or its .label.json when the fit finds nothing to
 * rehearse. It spends Token Factory credits, at most SHOWCASE_CAP_USD per
 * clip (default 1):
 *
 *   SHOWCASE_RECORD=iss-veggie-seed-film UNDERSTUDY_ENV_FILE=.env.local \
 *     node_modules/.bin/vitest run lib/showcase/record.test.ts
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SAMPLES } from "@/lib/samples";
import { TaskSpec } from "@/lib/spec/schema";
import { answerFor, DEFAULT_ANSWERS } from "./answers";
import { loadEngine, rollouts, type Engine } from "./rehearse";
import { LabelRecording, RECORDED_ON, Session, type Call } from "./session";

/** Every call names the model its stage is recorded on; a recording made on a replacement is refused. */
function onRecordedModels(ledger: Call[], models?: { vl: string; nano: string; super: string }) {
  expect(ledger.filter((c) => c.stage !== "playbook").map((c) => `${c.stage} ${c.model}`)).toEqual(ledger.filter((c) => c.stage !== "playbook").map((c) => `${c.stage} ${RECORDED_ON[c.stage as keyof typeof RECORDED_ON]}`));
  if (models) expect(models).toEqual({ vl: RECORDED_ON.label, nano: RECORDED_ON.compile, super: RECORDED_ON.notes });
}

const ROOT = process.cwd();
const DIR = path.join(ROOT, "public", "showcase");
const RECORD = (process.env.SHOWCASE_RECORD ?? "").split(",").filter(Boolean);
const all = existsSync(DIR) ? readdirSync(DIR) : [];
const files = all.filter((f) => f.endsWith(".json") && !f.endsWith(".label.json") && !f.endsWith(".variants.json"));
const labelFiles = all.filter((f) => f.endsWith(".label.json"));

let engine: Engine;
beforeAll(async () => {
  engine = await loadEngine(ROOT);
}, 60_000);

describe.runIf(RECORD.length > 0)("record the showcase (live, spends credits)", () => {
  it.each(RECORD)("%s", async (name) => {
    const sample = SAMPLES.find((s) => s.name === name);
    if (!sample) throw new Error(`${name} is not in lib/samples.ts`);
    process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");
    if (!process.env.NEBIUS_API_KEY) throw new Error("NEBIUS_API_KEY missing from the env file");
    const { notesHook, poster, recordClip } = await import("./record");
    // SHOWCASE_TRACED=<file>: a gesture clip finished from its .label.json and the page's trace, {traced, fit, by}
    const trace = process.env.SHOWCASE_TRACED ? JSON.parse(readFileSync(process.env.SHOWCASE_TRACED, "utf8")) : undefined;
    const traced = trace && { ...trace, label: LabelRecording.parse(JSON.parse(readFileSync(path.join(DIR, `${name}.label.json`), "utf8"))) };
    const session = await recordClip({ root: ROOT, sample, engine, capUsd: Number(process.env.SHOWCASE_CAP_USD ?? 1), notes: notesHook(), traced, log: (l) => console.log(l) });
    const [full, labelOnly] = [path.join(DIR, `${name}.json`), path.join(DIR, `${name}.label.json`)];
    if ("stops" in session) {
      // one kind of recording per clip: /space would otherwise show an older story
      rmSync(full, { force: true });
      rmSync(path.join(DIR, `${name}.jpg`), { force: true });
      writeFileSync(labelOnly, JSON.stringify(session, null, 1) + "\n");
      console.log(`${name}: up to the label (${session.stops}), ${session.ledger.length} calls, US$${session.total_usd.toFixed(4)}`);
      return;
    }
    rmSync(labelOnly, { force: true });
    writeFileSync(full, JSON.stringify(session, null, 1) + "\n");
    poster(ROOT, sample, session, path.join(DIR, `${name}.jpg`));
    console.log(`${name}: ${session.iterations.length} iterations, ${session.ledger.length} calls, US$${session.total_usd.toFixed(4)}`);
    // up to five patches, each of which may think for ~40 s and be asked twice
  }, 900_000);
});

// a recording run may turn a full recording into a label-only one or back; the next run checks what it wrote
describe.skipIf(RECORD.length > 0)("the showcase recordings", () => {
  it.each(files)("%s replays: same clip, same results in node", (file) => {
    const session = Session.parse(JSON.parse(readFileSync(path.join(DIR, file), "utf8")));
    expect(SAMPLES.map((s) => s.name)).toContain(session.clip.name);
    expect(file).toBe(`${session.clip.name}.json`);
    expect(existsSync(path.join(DIR, `${session.clip.name}.jpg`))).toBe(true);
    // /api/label answers this recording, and a sample token, to whoever sends this hash
    expect(createHash("sha256").update(readFileSync(path.join(ROOT, "samples", `${session.clip.name}.mp4`))).digest("hex")).toBe(session.clip.sha256);
    for (const it of session.iterations) if (it.patch) expect(it.patch.program).toEqual(it.program);
    onRecordedModels(session.ledger, session.models);
    for (const it of session.iterations) if (it.patch) expect(it.patch.model).toBe(RECORDED_ON.notes);
    expect(session.total_usd).toBeCloseTo(session.ledger.reduce((a, c) => a + c.usd, 0), 6);
    // the interview's programs are the compile turns' programs
    const compiled = session.iterations.filter((it) => it.source === "compile" || it.source === "interview");
    expect(compiled.map((it) => it.program)).toEqual(session.turns.map((t) => t.program));
    for (const [i, it] of session.iterations.entries()) {
      for (const { world, rollout: again } of rollouts(engine, it.spec, it.program)) {
        const { pass, failed_step_id, failed_op } = it.results[world];
        expect({ iteration: i, world, pass: again.pass, failed_step_id: again.failed_step_id, failed_op: again.failed_op }).toEqual({ iteration: i, world, pass, failed_step_id, failed_op });
        // a pass is only shown when the simulator also finds every object seated where its last step puts it, checked by the program or not
        const targeted = it.spec.objects.filter((o) => o.role === "manipulated" && it.spec.steps.some((s) => s.object === o.id && s.target && s.target.frame !== "world"));
        const unseated = pass
          ? targeted.flatMap((o) => {
              const seated = again.end?.find((e) => e.object === o.id)?.seated;
              return seated?.ok ? [] : [`${o.id}: ${seated ? seated.why : "no seated reading"}`];
            })
          : [];
        expect({ iteration: i, world, unseated }).toEqual({ iteration: i, world, unseated: [] });
      }
    }
  }, 60_000);
});

describe.runIf(labelFiles.length > 0 && RECORD.length === 0)("the label-only recordings", () => {
  it.each(labelFiles)("%s is its clip's label, and the clip has no full recording", (file) => {
    const rec = LabelRecording.parse(JSON.parse(readFileSync(path.join(DIR, file), "utf8")));
    expect(file).toBe(`${rec.clip.name}.label.json`);
    expect(SAMPLES.map((s) => s.name)).toContain(rec.clip.name);
    expect(createHash("sha256").update(readFileSync(path.join(ROOT, "samples", `${rec.clip.name}.mp4`))).digest("hex")).toBe(rec.clip.sha256);
    expect(files).not.toContain(`${rec.clip.name}.json`);
    expect(rec.total_usd).toBeCloseTo(rec.ledger.reduce((a, c) => a + c.usd, 0), 6);
    onRecordedModels(rec.ledger, rec.models);
  });
});

describe.skipIf(RECORD.length > 0)("which run was kept (#152)", () => {
  const chosen = files.map((f) => Session.parse(JSON.parse(readFileSync(path.join(DIR, f), "utf8")))).filter((s) => s.selection?.run !== undefined);
  const passes = (s: Session) => s.iterations.at(-1)!.results.earth.pass && s.iterations.at(-1)!.results.orbit.pass;

  it("every clip with kept runs says which one it shows", () => {
    const dir = path.join(ROOT, "bench", "rerecord");
    const archived = existsSync(dir) ? readdirSync(dir).filter((f) => !f.includes(".")) : [];
    expect(archived.sort()).toEqual(chosen.map((s) => s.clip.name).sort());
  });

  it.each(chosen.map((s) => [s.clip.name, s] as const))("%s is the run it says, of the runs kept under bench/rerecord", (name, session) => {
    const dir = path.join(ROOT, "bench", "rerecord", name);
    const runs = readdirSync(dir).filter((f) => /^run-\d+\.json$/.test(f));
    // every run is kept, so the count on the page can be checked
    expect(runs.map((f) => Number(/\d+/.exec(f)![0])).sort((a, b) => a - b)).toEqual(Array.from({ length: session.selection!.runs }, (_, i) => i + 1));
    const kept = Session.parse(JSON.parse(readFileSync(path.join(dir, `run-${session.selection!.run}.json`), "utf8")));
    expect({ ...session, selection: undefined }).toEqual({ ...kept, selection: undefined });
    for (const f of runs) {
      const run = Session.parse(JSON.parse(readFileSync(path.join(dir, f), "utf8")));
      expect(run.clip).toEqual(session.clip);
      onRecordedModels(run.ledger, run.models);
      // "the first that passes": every run before the kept one failed somewhere, and the kept one passes
      const n = Number(/\d+/.exec(f)![0]);
      if (session.selection!.kept.startsWith("the first that passes")) expect({ run: n, passes: passes(run) }).toEqual({ run: n, passes: n === session.selection!.run });
    }
  });
});

describe("the recorder's guards (no network)", () => {
  const sample = SAMPLES[0];
  const withKey = async <T,>(key: string | undefined, fn: () => Promise<T>) => {
    const saved = process.env.NEBIUS_API_KEY;
    if (key === undefined) delete process.env.NEBIUS_API_KEY;
    else process.env.NEBIUS_API_KEY = key;
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.NEBIUS_API_KEY;
      else process.env.NEBIUS_API_KEY = saved;
    }
  };

  it("refuses to record without a key: the routes would replay their fixtures", async () => {
    const { recordClip } = await import("./record");
    await withKey(undefined, () => expect(recordClip({ root: ROOT, sample, engine, capUsd: 1 })).rejects.toThrow(/NEBIUS_API_KEY is not set/));
  });

  /** The routes set to these models while `fn` runs: once the live routes call replacements, the recorder refuses before anything else. */
  const withModels = async <T,>(set: { vl: string; nano: string; super: string }, fn: () => Promise<T>) => {
    const { MODELS } = await import("@/lib/providers/tokenfactory");
    const m = MODELS as { vl: string; nano: string; super: string };
    const saved = { vl: m.vl, nano: m.nano, super: m.super };
    Object.assign(m, set);
    try {
      return await fn();
    } finally {
      Object.assign(m, saved);
    }
  };
  const ORIGINALS = { vl: RECORDED_ON.label, nano: RECORDED_ON.compile, super: RECORDED_ON.notes };

  it("refuses to record when the routes would call a replacement for Nano or Super", async () => {
    const { recordClip } = await import("./record");
    await withModels({ ...ORIGINALS, nano: "nvidia/Nemotron-3_5-Lightning" }, () =>
      withKey("not-a-real-key", () => expect(recordClip({ root: ROOT, sample, engine, capUsd: 1 })).rejects.toThrow(/nano=nvidia\/Nemotron-3_5-Lightning.*UNDERSTUDY_KEEP_RETIRED=1/)),
    );
  });

  it("stops before a stage whose cheapest request has no room under the cap", async () => {
    const { recordClip, leastUsd } = await import("./record");
    await withModels(ORIGINALS, () => withKey("not-a-real-key", async () => {
      await expect(recordClip({ root: ROOT, sample, engine, capUsd: leastUsd("label") / 2 })).rejects.toThrow(/label reserves at least US\$.* over the US\$.* cap/);
      await expect(recordClip({ root: ROOT, sample, engine, capUsd: 0 })).rejects.toThrow(/positive number/);
    }));
  });

  it("records a patch only from a live call, and one recording per notes hook", async () => {
    const { notesHook } = await import("./record");
    // read now, not at load: a recording run may have replaced the file the inventory listed
    const first = readdirSync(DIR).find((f) => f.endsWith(".json") && !f.endsWith(".label.json") && !f.endsWith(".variants.json"))!;
    const session = Session.parse(JSON.parse(readFileSync(path.join(DIR, first), "utf8")));
    const interviewed = session.iterations.filter((x) => x.source !== "notes");
    // with no key /api/notes answers from its fixtures, or not at all: neither may be recorded
    await withKey(undefined, () => expect(notesHook()(interviewed.at(-1)!, interviewed, engine)).rejects.toThrow(/^notes patch 1\b/));
    const patched = [...interviewed, { ...interviewed.at(-1)!, source: "notes" as const }];
    await expect(notesHook()(patched.at(-1)!, patched, engine)).rejects.toThrow(/one clip's patches/);
  });

  it("prices a stage's cheapest request at the model the route will call, so an override cannot slip past the cap", async () => {
    const { leastUsd } = await import("./record");
    const nano = leastUsd("compile", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B");
    const ultra = leastUsd("compile", "nvidia/Nemotron-3-Ultra-550b-a55b");
    expect(ultra).toBeGreaterThan(nano);
    expect(() => leastUsd("compile", "no/such-model")).toThrow(/no list price/);
  });
});

describe("the recorded answers", () => {
  const spec = TaskSpec.parse({
    version: 1,
    title: "block into holder",
    summary: "",
    objects: [
      { id: "block", name: "block", shape: "box", size_mm: [20, 20, 30], symmetry: "none", role: "manipulated" },
      { id: "holder", name: "holder", shape: "box", size_mm: [60, 60, 20], symmetry: "none", role: "fixture" },
    ],
    steps: [{ id: "s2", verb: "insert", object: "block", target: { fixture: "pocket", frame: "holder" }, t_start_s: 0, t_end_s: 1 }],
  });

  it("answers clearance, tolerance and success through the flow's forms", () => {
    expect(answerFor(spec, "objects[holder].pocket_clearance_mm", 1, DEFAULT_ANSWERS)?.change).toEqual({ path: "objects[holder].pocket_clearance_mm", value: DEFAULT_ANSWERS.clearance_mm, source: "interview#1" });
    expect(answerFor(spec, "steps[s2].tolerances.yaw_deg", 2, DEFAULT_ANSWERS)?.text).toBe(`${DEFAULT_ANSWERS.tolerance_deg} °`);
    const success = answerFor(spec, "steps[s2].success", 1, DEFAULT_ANSWERS);
    expect(success?.text).toBe("the block ends up in the holder and stays there");
    expect(success?.change.value).toEqual([
      { kind: "inside_zone", object: "block", target: "holder" },
      { kind: "object_still", object: "block" },
    ]);
  });

  it("leaves what it has no answer for unanswered", () => {
    expect(answerFor(spec, "steps[s2].via_points", 1, DEFAULT_ANSWERS)).toBeNull();
    expect(answerFor(spec, "steps[s2].timeout_s", 1, DEFAULT_ANSWERS)).toBeNull();
  });
});
