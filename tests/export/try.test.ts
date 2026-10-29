import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { GroundingRecord } from "@/lib/export/grounding";
import { keepForSampling, sampleAt } from "@/lib/export/trace";
import { emptyLog, passingRuns, TRY_FPS, tryExport, versionsWithResults, withRun, type TryLog } from "@/lib/export/try";
import { DEMO_PROGRAMS, DEMO_SPEC } from "@/lib/sim/demo-spec";
import type { Frame, SimMeta } from "@/lib/sim/protocol";
import { SO101_JOINT_NAMES } from "@/lib/sim/so101";
import { parseJson, parseJsonl, stubVideoEncoder, text } from "./helpers";

const meta = {
  joints: SO101_JOINT_NAMES.map((name, i) => ({ name, qposadr: i, range: [-3, 3] })),
  actuators: SO101_JOINT_NAMES.map((name) => ({ name, ctrlrange: [-3, 3] })),
} as unknown as SimMeta;

/** A rollout's frames as the worker posts them, at uneven times, every joint moving. */
function posted(seconds: number, step = 0.013): Frame[] {
  const out: Frame[] = [];
  for (let k = 0; k * step <= seconds + 1e-9; k++) {
    const t = k * step;
    const q = new Float64Array(6).map((_, i) => Math.sin(t + i));
    out.push({ t, qpos: q, ctrl: q.map((v) => v * 0.9) } as unknown as Frame);
  }
  return out;
}

const kept = (frames: Frame[]) => {
  const k: Frame[] = [];
  for (const f of frames) keepForSampling(k, f, TRY_FPS);
  return k;
};

const pass = { pass: true, t: 4 };
const fail = { pass: false, failed_step_id: "s2", why: "the film drifted", t: 3 };

function log(): TryLog {
  const first = DEMO_PROGRAMS.release_early;
  const last = DEMO_PROGRAMS.hold_until_seated;
  return {
    ...emptyLog(),
    versions: [
      { source: "compile", spec: DEMO_SPEC, program: first, changes: [], why: "", warnings: [] },
      { source: "notes", spec: DEMO_SPEC, program: last, changes: ["hold_s: 0 -> 1"], why: "hold it", warnings: [] },
    ],
    runs: [
      { program: first, world: "earth", result: pass, frames: kept(posted(2)), meta },
      { program: first, world: "orbit", result: fail },
      { program: last, world: "earth", result: pass, frames: kept(posted(3)), meta },
      { program: last, world: "orbit", result: pass, frames: kept(posted(2.5)), meta },
    ],
    ledger: [{ stage: "compile", model: "nvidia/x", prompt_tokens: 10, completion_tokens: 5, seconds: 1 }],
  };
}

const base = { clip: { name: "iss-veggie-seed-film", sample: true, duration_s: 36 }, hint: "seed film", label: DEMO_SPEC, fit: ["fitted"], spec: DEMO_SPEC };

describe("keepForSampling", () => {
  it("keeps exactly what sampleAt picks from the whole stream", () => {
    for (const step of [0.002, 0.013, 1 / 15, 0.1]) {
      const all = posted(3, step);
      expect(sampleAt(kept(all), TRY_FPS)).toEqual(sampleAt(all, TRY_FPS));
    }
  });

  it("holds about one frame per sample", () => {
    expect(kept(posted(3, 0.002)).length).toBeLessThanOrEqual(3 * TRY_FPS + 2);
  });
});

describe("tryExport", () => {
  it("writes the passing rollouts of the program that passed, Earth then orbit, and the session next to them", async () => {
    const program = DEMO_PROGRAMS.hold_until_seated;
    const l = log();
    expect(passingRuns(l, program).map((r) => r.world)).toEqual(["earth", "orbit"]);
    const { zip, paths, quality } = await tryExport({ ...base, program, log: l, grounding: null });
    const files = unzipSync(zip);
    expect(paths.filter((p) => p.endsWith(".parquet"))).toHaveLength(2);
    expect(paths.some((p) => p.endsWith(".mp4"))).toBe(false);
    expect(paths).not.toContain("understudy/grounding.json");
    for (const f of ["spec", "program", "label", "interview", "versions", "ledger", "clip", "quality"]) expect(paths).toContain(`understudy/${f}.json`);
    expect(quality.headline).toBe("2 scripted episodes; a format-valid skeleton, not training data");
    const episodes = parseJsonl(files["lerobot/meta/episodes.jsonl"]);
    expect(episodes.map((e: { scenario_id: string }) => e.scenario_id)).toEqual(["earth", "orbit"]);
    // the last posted frames at 2.990 s and 2.496 s, at 15 fps, frame 0 included
    expect(episodes.map((e: { length: number }) => e.length)).toEqual([45, 38]);
    const versions = parseJson(files["understudy/versions.json"]);
    expect(versions.map((v: { results: { orbit: { pass: boolean } | null } }) => v.results.orbit?.pass)).toEqual([false, true]);
    const clip = parseJson(files["understudy/clip.json"]);
    expect(clip.source.licence).toBe("Public domain (work of NASA)");
    const md = text(files["lerobot/QUALITY.md"]);
    expect(md).toContain("## What this export holds");
    expect(md).toContain("joint states and actions only, no video");
    expect(md).not.toContain("videos/");
    expect(md).not.toContain("grounding.json");
    expect(md).toContain("Not loader-validated");
  });

  it("writes grounding.json when the person looked something up, and an upload's source as upload", async () => {
    const grounding: GroundingRecord = { query: "q", pages: [], chips: [], tavily: [{ call: "tavily/search", request_id: "r1", credits: 1, seconds: 1 }], filter: [], warnings: [] };
    const { zip, paths } = await tryExport({ ...base, clip: { name: "upload", sample: false, duration_s: 10 }, program: DEMO_PROGRAMS.hold_until_seated, log: log(), grounding });
    const files = unzipSync(zip);
    expect(paths).toContain("understudy/grounding.json");
    expect(parseJson(files["understudy/grounding.json"]).tavily[0].request_id).toBe("r1");
    expect(parseJson(files["understudy/clip.json"]).source).toBe("upload");
    expect(text(files["lerobot/QUALITY.md"])).toContain("understudy/grounding.json");
  });

  it("with a video encoder, draws one picture per parquet row and writes an MP4 per episode", async () => {
    const encoder = stubVideoEncoder();
    const drawn: number[] = [];
    let disposed = 0;
    const { paths, quality, zip } = await tryExport({
      ...base,
      program: DEMO_PROGRAMS.hold_until_seated,
      log: log(),
      grounding: null,
      video: { encoder, draw: (_, frames) => (drawn.push(frames.length), { length: frames.length, draw: async () => ({}) as ImageBitmap, dispose: () => disposed++ }) },
    });
    expect(drawn).toEqual([45, 38]);
    expect(encoder.calls).toEqual([45, 38]);
    expect(disposed).toBe(2);
    expect(paths.filter((p) => p.endsWith(".mp4"))).toHaveLength(2);
    expect(quality.headline).toBe("2 scripted, primitive-rendered episodes; a format-valid skeleton, not training data");
    expect(text(unzipSync(zip)["lerobot/QUALITY.md"])).toContain("no camera ever filmed it");
  });

  it("refuses a program with no passing rollout that kept its frames", async () => {
    await expect(tryExport({ ...base, program: DEMO_PROGRAMS.release_early, log: { ...log(), runs: log().runs.map((r) => ({ ...r, frames: undefined })) }, grounding: null })).rejects.toThrow(/no passing rollout/);
  });

  it("gives each version the last result measured for it", () => {
    const v = versionsWithResults(log());
    expect(v[0].results).toEqual({ earth: pass, orbit: fail });
  });

  it("keeps the frames of only the newest pass of a program in a world", () => {
    const program = DEMO_PROGRAMS.hold_until_seated;
    let l = log();
    l = withRun(l, { program, world: "earth", result: pass, frames: kept(posted(1)), meta });
    expect(l.runs.filter((r) => r.program === program && r.world === "earth" && r.frames)).toHaveLength(1);
    expect(l.runs.filter((r) => r.program === program && r.world === "orbit" && r.frames)).toHaveLength(1);
    expect(passingRuns(l, program)[0].frames).toHaveLength(16);
  });
});
