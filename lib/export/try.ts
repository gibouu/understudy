/**
 * The export from Try it (issue #112): what the page did with one clip, kept as it happens (app/flow.tsx), and the
 * zip built from it once the program passes on Earth and in orbit. The episodes are the passing rollouts of that
 * program, as the stage played them; next to them go the spec, the program, the answers, every version, the model
 * calls the page made, the web lookup when there was one (`grounding.json`), and where the clip came from. With a
 * video encoder each episode also gets an MP4, drawn again in the browser from the simulator frames the stage kept.
 */
import type { GroundingRecord } from "@/lib/export/grounding";
import { clipSource } from "@/lib/export/source";
import { armFrame, EXPORT_FPS, sampleAt } from "@/lib/export/trace";
import type { EpisodeRecord } from "@/lib/export/types";
import type { DrawnFrames, EpisodeVideoEncoder } from "@/lib/export/video";
import { buildExportZip, type ExportResult } from "@/lib/export/zip";
import { instruction } from "@/lib/showcase/tour";
import type { Run } from "@/lib/showcase/session";
import type { Rollout } from "@/lib/sim/interpreter";
import type { Frame, SimMeta } from "@/lib/sim/protocol";
import type { Ask } from "@/lib/spec/answer";
import type { GravityName, Program, SpecChange, TaskSpec } from "@/lib/spec/schema";
import type { LedgerEntry } from "@/lib/spec/stage-result";

/** The dataset's frame rate: the video's, so every parquet row has its picture. */
export const TRY_FPS = EXPORT_FPS;

/**
 * How a version of the program came about: the first compile, a recompile after answers (`interview`), after a web
 * chip was added (`web`), when asked again, or a Notes patch.
 */
export type VersionSource = "compile" | "interview" | "web" | "recompile" | "notes";

export type TryVersion = {
  source: VersionSource;
  spec: TaskSpec;
  program: Program;
  /** what changed, in words */
  changes: string[];
  why: string;
  /** what the route said: a replay, a recording, a kept program */
  warnings: string[];
  /** a Notes patch: who wrote it and what it cost, as the patch line shows (a replay included) */
  patch?: { model: string; thinking: boolean; tokens: number; cost_usd: number };
};

/** One model call the page made, and for which stage. */
export type TryCall = LedgerEntry & { stage: "label" | "compile" | "notes" };

/** One round of questions and what was answered. */
export type TryTurn = { turn: number; asks: Pick<Ask, "slot" | "question" | "why">[]; answers: { slot: string; text: string; change: SpecChange }[] };

/**
 * One rollout the stage played, the patches' included. A pass keeps the simulator frames, one per dataset frame
 * at most (lib/export/trace.ts keepForSampling), and the model's description they are read with.
 */
export type TryRun = { program: Program; world: GravityName; result: Run; frames?: Frame[]; meta?: SimMeta };

/** Everything the page heard about one clip since it was picked. */
export type TryLog = { versions: TryVersion[]; runs: TryRun[]; turns: TryTurn[]; ledger: TryCall[] };

export const emptyLog = (): TryLog => ({ versions: [], runs: [], turns: [], ledger: [] });

/**
 * The log with `run` added. Only the newest pass of a program in a world keeps its frames (the one the export
 * uses): rehearsing again does not pile up simulator frames in the page.
 */
export function withRun(log: TryLog, run: TryRun): TryLog {
  const older = run.frames ? log.runs.map((r) => (r.frames && r.program === run.program && r.world === run.world ? { program: r.program, world: r.world, result: r.result } : r)) : log.runs;
  return { ...log, runs: [...older, run] };
}

/** What the simulator measured, as the showcase recordings keep it. */
export const runOf = (r: Rollout): Run => ({
  pass: r.pass,
  ...(r.failed_step_id !== undefined ? { failed_step_id: r.failed_step_id } : {}),
  ...(r.failed_op !== undefined ? { failed_op: r.failed_op } : {}),
  ...(r.failure_class !== undefined ? { failure_class: r.failure_class } : {}),
  ...(r.why !== undefined ? { why: r.why } : {}),
  t: Math.round(r.t * 1000) / 1000,
});

/** The last passing rollout of `program` in each world, Earth first: the episodes. Only runs that kept their frames. */
export function passingRuns(log: TryLog, program: Program): TryRun[] {
  const out: TryRun[] = [];
  for (const world of ["earth", "orbit"] as const) {
    const r = log.runs.findLast((x) => x.program === program && x.world === world && x.result.pass && x.frames?.length && x.meta);
    if (r) out.push(r);
  }
  return out;
}

/** Each version with the last result the stage measured for it in each world, when it was rehearsed. */
export function versionsWithResults(log: TryLog) {
  return log.versions.map((v, index) => {
    const last = (world: GravityName) => log.runs.findLast((r) => r.program === v.program && r.world === world)?.result ?? null;
    return { index, source: v.source, changes: v.changes, why: v.why, warnings: v.warnings, ...(v.patch ? { patch: v.patch } : {}), results: { earth: last("earth"), orbit: last("orbit") }, spec: v.spec, program: v.program };
  });
}

export type TryExportInput = {
  clip: { name: string; sample: boolean; duration_s: number | null };
  hint: string;
  /** what the model saw, before the fit, and what the fit said */
  label: TaskSpec | null;
  fit: string[];
  /** the spec and program that passed on Earth and in orbit */
  spec: TaskSpec;
  program: Program;
  log: TryLog;
  grounding: GroundingRecord | null;
  /** an MP4 per episode: the encoder (lib/export/video.ts) and the drawing of the frames (lib/export/render.ts) */
  video?: { encoder: EpisodeVideoEncoder; draw: (meta: SimMeta, frames: Frame[]) => DrawnFrames & { dispose(): void } };
};

/** The file-by-file account QUALITY.md opens with: only what this zip holds. */
export function contentsOf(episodes: number, video: boolean, grounding: boolean): { path: string; what: string }[] {
  const n = `${episodes} episode${episodes === 1 ? "" : "s"}`;
  return [
    { path: "lerobot/data/chunk-000/episode_*.parquet", what: `${n}, one per passing rollout of the program on Earth (1 g) and in orbit (0 g): joint states and commanded joint positions of the simulated SO-101, in radians, at ${TRY_FPS} fps` },
    ...(video
      ? [{ path: "lerobot/videos/chunk-000/observation.images.workspace/episode_*.mp4", what: `one video per episode, 480x360 at ${TRY_FPS} fps: the simulator's state at each dataset frame drawn again in the browser, on the bare bench from the stage's default camera, the arm drawn from its meshes and the objects as primitives; no camera ever filmed it` }]
      : []),
    { path: "lerobot/meta/", what: "info.json, tasks.jsonl, episodes.jsonl, stats.json, episodes_stats.jsonl and modality.json, in the LeRobot v2.1 layout Isaac-GR00T N1.7 reads" },
    { path: "lerobot/QUALITY.md", what: "this report" },
    { path: "understudy/spec.json, program.json", what: "the task spec and the program that passed" },
    { path: "understudy/label.json", what: "what the model saw in the clip, before the fit to the bench, and what the fit changed" },
    { path: "understudy/interview.json", what: "each round of questions the program asked and the answers given" },
    { path: "understudy/versions.json", what: "every version of the program on this page (compiles, recompiles, Notes patches) with what changed, each patch's model, tokens and price, and its last rehearsal result per world" },
    { path: "understudy/ledger.json", what: "the model calls this page made for the label, the compiles and the Notes patches, with tokens, seconds and price where known; a recording's calls when the page replayed one" },
    ...(grounding ? [{ path: "understudy/grounding.json", what: "the web lookup: the query, the pages read, each chip and whether it was added, every Tavily call with its request id and credits, and the filtering model's tokens" }] : []),
    { path: "understudy/clip.json", what: "the clip's name, length, the line typed about it, and its source and licence" },
    { path: "understudy/quality.json", what: "the numbers of this report" },
  ];
}

/** The zip: throws when no passing rollout kept its frames. */
export async function tryExport({ clip, hint, label, fit, spec, program, log, grounding, video }: TryExportInput): Promise<ExportResult> {
  const runs = passingRuns(log, program);
  if (runs.length === 0) throw new Error("no passing rollout of this program has been played on this page yet");
  const source = clip.sample ? clipSource(clip.name) : "upload";
  const task = instruction(spec);
  const episodes: EpisodeRecord[] = [];
  const drawers: { dispose(): void }[] = [];
  try {
    for (const [episode_index, r] of runs.entries()) {
      const sampled = sampleAt(r.frames!, TRY_FPS);
      const frames = sampled.map((f, k) => {
        const { state, action } = armFrame(r.meta!, f);
        return { t_s: k / TRY_FPS, state, action };
      });
      // drawn while the zip encodes this episode's MP4, one picture at a time
      const pictures = video ? video.draw(r.meta!, sampled) : undefined;
      if (pictures) drawers.push(pictures);
      episodes.push({
        episode_index,
        scenario_id: r.world,
        mode: "sensed",
        pass: true,
        fps: TRY_FPS,
        instruction: task,
        frames,
        ...(pictures ? { video: { width: video!.encoder.width, height: video!.encoder.height, frames: pictures } } : {}),
      });
    }
    return await buildExportZip(
      {
        robot_type: "so101_follower",
        codebase_version: "v2.1",
        episodes,
        understudy: {
          spec,
          program,
          label: { spec: label, fit },
          interview: log.turns,
          versions: versionsWithResults(log),
          ledger: log.ledger,
          ...(grounding ? { grounding } : {}),
          clip: { name: clip.sample ? clip.name : "upload", duration_s: clip.duration_s, hint, source },
        },
      },
      { spec, origin: "rehearsal", source, video: video?.encoder, contents: contentsOf(episodes.length, Boolean(video), Boolean(grounding)) },
    );
  } finally {
    // a drawer whose episode failed half-way still holds its renderer
    for (const d of drawers) d.dispose();
  }
}
