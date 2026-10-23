/**
 * LeRobot v2.1 writer, in memory. Mirrors the layout of Isaac-GR00T's demo
 * dataset `cube_to_bowl_5` (fixtures in tests/fixtures/groot/): one parquet per
 * episode, one video per episode, and the `meta/` files GR00T N1.7 reads,
 * including its `modality.json`.
 */
import { parquetWriteBuffer } from "hyparquet-writer";
import { SO101_JOINTS, type EpisodeRecord, type JointVector } from "@/lib/export/types";
import { VIDEO_KEY, type EpisodeVideoEncoder } from "@/lib/export/video";

export const CHUNKS_SIZE = 1000;
export const DATA_PATH = "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet";
const VIDEO_PATH = "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4";

/** Paths relative to the dataset root, contents as bytes. */
export type FileTree = Record<string, Uint8Array>;

export type FeatureStats = {
  mean: number[];
  std: number[];
  min: number[];
  max: number[];
  q01: number[];
  q99: number[];
};

const pad = (n: number, width: number) => String(n).padStart(width, "0");
const chunkOf = (episodeIndex: number) => Math.floor(episodeIndex / CHUNKS_SIZE);
const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(JSON.stringify(value, null, 4) + "\n");
const jsonl = (rows: unknown[]) => encoder.encode(rows.map((r) => JSON.stringify(r) + "\n").join(""));

export function episodeDataPath(episodeIndex: number): string {
  return `data/chunk-${pad(chunkOf(episodeIndex), 3)}/episode_${pad(episodeIndex, 6)}.parquet`;
}

export function episodeVideoPath(episodeIndex: number): string {
  return `videos/chunk-${pad(chunkOf(episodeIndex), 3)}/${VIDEO_KEY}/episode_${pad(episodeIndex, 6)}.mp4`;
}

/** Throws on anything LeRobot's loader would reject later, with the episode named. */
function validate(episodes: EpisodeRecord[]): void {
  if (episodes.length === 0) throw new Error("export needs at least one episode");
  const fps = episodes[0].fps;
  episodes.forEach((ep, i) => {
    const where = `episode ${ep.episode_index}`;
    if (ep.episode_index !== i) {
      throw new Error(`episode indices must run 0..${episodes.length - 1} in order; position ${i} holds ${ep.episode_index}`);
    }
    if (ep.fps !== fps) throw new Error(`${where} has fps ${ep.fps}, the first episode has ${fps}`);
    if (!(fps > 0)) throw new Error(`${where} has fps ${fps}`);
    if (ep.frames.length === 0) throw new Error(`${where} has no frames`);
    if (!ep.instruction.trim()) throw new Error(`${where} has an empty instruction`);
    ep.frames.forEach((f, j) => {
      for (const [name, v] of [["state", f.state], ["action", f.action]] as const) {
        if (v.length !== SO101_JOINTS.length || !v.every(Number.isFinite)) {
          throw new Error(`${where} frame ${j}: ${name} must be ${SO101_JOINTS.length} finite numbers`);
        }
      }
    });
  });
}

/** Task strings in order of first appearance; the index is the task_index. */
export function taskTable(episodes: EpisodeRecord[]): string[] {
  return [...new Set(episodes.map((ep) => ep.instruction))];
}

const LIST_FLOAT = (name: string) => [
  { name, repetition_type: "OPTIONAL", converted_type: "LIST", num_children: 1 },
  { name: "list", repetition_type: "REPEATED", num_children: 1 },
  { name: "element", type: "FLOAT", repetition_type: "OPTIONAL" },
] as const;
const SCALAR = (name: string, type: "FLOAT" | "INT64") =>
  ({ name, type, repetition_type: "OPTIONAL" }) as const;

/**
 * One episode as parquet, columns in LeRobot's order. `timestamp` is
 * frame_index / fps: LeRobot checks it against fps when it syncs video.
 */
export function episodeParquet(ep: EpisodeRecord, taskIndex: number, firstIndex: number): Uint8Array {
  const n = ep.frames.length;
  const ints = (f: (i: number) => number) => BigInt64Array.from({ length: n }, (_, i) => BigInt(f(i)));
  const buffer = parquetWriteBuffer({
    columnData: [
      { name: "action", data: ep.frames.map((f) => f.action) },
      { name: "observation.state", data: ep.frames.map((f) => f.state) },
      { name: "timestamp", data: Float32Array.from({ length: n }, (_, i) => i / ep.fps) },
      { name: "frame_index", data: ints((i) => i) },
      { name: "episode_index", data: ints(() => ep.episode_index) },
      { name: "index", data: ints((i) => firstIndex + i) },
      { name: "task_index", data: ints(() => taskIndex) },
    ],
    schema: [
      { name: "root", num_children: 7 },
      ...LIST_FLOAT("action"),
      ...LIST_FLOAT("observation.state"),
      SCALAR("timestamp", "FLOAT"),
      SCALAR("frame_index", "INT64"),
      SCALAR("episode_index", "INT64"),
      SCALAR("index", "INT64"),
      SCALAR("task_index", "INT64"),
    ],
  });
  return new Uint8Array(buffer);
}

/** numpy's default (linear) quantile of sorted values. */
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Per-dimension stats over rows of equal length; std is the population std (numpy's default). */
export function featureStats(rows: number[][]): FeatureStats {
  const dims = rows[0].length;
  const out: FeatureStats = { mean: [], std: [], min: [], max: [], q01: [], q99: [] };
  for (let d = 0; d < dims; d++) {
    const col = rows.map((r) => r[d]).sort((a, b) => a - b);
    const mean = col.reduce((s, v) => s + v, 0) / col.length;
    const variance = col.reduce((s, v) => s + (v - mean) ** 2, 0) / col.length;
    out.mean.push(mean);
    out.std.push(Math.sqrt(variance));
    out.min.push(col[0]);
    out.max.push(col[col.length - 1]);
    out.q01.push(quantile(col, 0.01));
    out.q99.push(quantile(col, 0.99));
  }
  return out;
}

/** Values as written to parquet: float32. */
const f32 = (v: JointVector | number[]) => v.map(Math.fround);

/** stats.json: the three features GR00T's demo carries stats for. */
export function datasetStats(episodes: EpisodeRecord[]): Record<string, FeatureStats> {
  const frames = episodes.flatMap((ep) => ep.frames);
  const timestamps = episodes.flatMap((ep) => ep.frames.map((_, i) => [Math.fround(i / ep.fps)]));
  return {
    action: featureStats(frames.map((f) => f32(f.action))),
    "observation.state": featureStats(frames.map((f) => f32(f.state))),
    timestamp: featureStats(timestamps),
  };
}

/**
 * episodes_stats.jsonl, which LeRobot's own v2.1 loader aggregates. GR00T's demo
 * ships without it; it costs nothing and keeps `LeRobotDataset` happy.
 */
function episodeStatsRows(episodes: EpisodeRecord[], taskIndex: Map<string, number>, firstIndex: number[]) {
  return episodes.map((ep, e) => {
    const n = ep.frames.length;
    const scalar = (f: (i: number) => number) => {
      const { mean, std, min, max } = featureStats(Array.from({ length: n }, (_, i) => [f(i)]));
      return { min, max, mean, std, count: [n] };
    };
    const vector = (rows: number[][]) => {
      const { mean, std, min, max } = featureStats(rows);
      return { min, max, mean, std, count: [n] };
    };
    return {
      episode_index: ep.episode_index,
      stats: {
        action: vector(ep.frames.map((f) => f32(f.action))),
        "observation.state": vector(ep.frames.map((f) => f32(f.state))),
        timestamp: scalar((i) => Math.fround(i / ep.fps)),
        frame_index: scalar((i) => i),
        episode_index: scalar(() => ep.episode_index),
        index: scalar((i) => firstIndex[e] + i),
        task_index: scalar(() => taskIndex.get(ep.instruction)!),
      },
    };
  });
}

const vectorFeature = { dtype: "float32", names: [...SO101_JOINTS], shape: [SO101_JOINTS.length] };
const scalarFeature = (dtype: "float32" | "int64") => ({ dtype, shape: [1], names: null });

function videoFeature(v: EpisodeVideoEncoder) {
  return {
    dtype: "video",
    shape: [v.height, v.width, 3],
    names: ["height", "width", "channels"],
    info: {
      "video.height": v.height,
      "video.width": v.width,
      "video.codec": v.format.codec,
      "video.pix_fmt": "yuv420p",
      "video.is_depth_map": false,
      "video.fps": v.fps,
      "video.channels": 3,
      has_audio: false,
    },
  };
}

/** info.json, keys in the order of GR00T's demo. */
export function infoJson(episodes: EpisodeRecord[], video?: EpisodeVideoEncoder) {
  const totalFrames = episodes.reduce((s, ep) => s + ep.frames.length, 0);
  return {
    codebase_version: "v2.1",
    robot_type: "so101_follower",
    total_episodes: episodes.length,
    total_frames: totalFrames,
    total_tasks: taskTable(episodes).length,
    chunks_size: CHUNKS_SIZE,
    fps: episodes[0].fps,
    splits: { train: `0:${episodes.length}` },
    data_path: DATA_PATH,
    video_path: video ? VIDEO_PATH : null,
    features: {
      action: vectorFeature,
      "observation.state": vectorFeature,
      ...(video ? { [VIDEO_KEY]: videoFeature(video) } : {}),
      timestamp: scalarFeature("float32"),
      frame_index: scalarFeature("int64"),
      episode_index: scalarFeature("int64"),
      index: scalarFeature("int64"),
      task_index: scalarFeature("int64"),
    },
    total_chunks: chunkOf(episodes.length - 1) + 1,
    total_videos: video ? episodes.length : 0,
  };
}

/** GR00T's modality.json: arm joints 0-5, gripper 5-6, the task text via task_index. */
export function modalityJson(hasVideo: boolean) {
  const slices = { single_arm: { start: 0, end: 5 }, gripper: { start: 5, end: 6 } };
  return {
    state: slices,
    action: slices,
    video: hasVideo ? { workspace: { original_key: VIDEO_KEY } } : {},
    annotation: { "human.task_description": { original_key: "task_index" } },
  };
}

export type BuildLeRobotOptions = {
  /** browser encoder from lib/export/video; without it the dataset has no video feature */
  video?: EpisodeVideoEncoder;
};

/**
 * The whole `lerobot/` tree. With a video encoder every episode must carry one
 * rendered frame per recorded frame at the encoder's size.
 */
export async function buildLeRobot(episodes: EpisodeRecord[], { video }: BuildLeRobotOptions = {}): Promise<FileTree> {
  validate(episodes);
  if (video && video.fps !== episodes[0].fps) {
    throw new Error(`video fps ${video.fps} differs from dataset fps ${episodes[0].fps}`);
  }
  const tasks = taskTable(episodes);
  const taskIndex = new Map(tasks.map((t, i) => [t, i]));
  const firstIndex: number[] = [];
  episodes.reduce((start, ep) => (firstIndex.push(start), start + ep.frames.length), 0);

  const files: FileTree = {};
  for (const [e, ep] of episodes.entries()) {
    files[episodeDataPath(ep.episode_index)] = episodeParquet(ep, taskIndex.get(ep.instruction)!, firstIndex[e]);
    if (video) {
      const v = ep.video;
      if (!v || v.frames.length !== ep.frames.length || v.width !== video.width || v.height !== video.height) {
        throw new Error(
          `episode ${ep.episode_index} needs ${ep.frames.length} video frames at ${video.width}x${video.height}`,
        );
      }
      files[episodeVideoPath(ep.episode_index)] = await video.encode(v.frames);
    }
  }

  files["meta/info.json"] = json(infoJson(episodes, video));
  files["meta/tasks.jsonl"] = jsonl(tasks.map((task, task_index) => ({ task_index, task })));
  files["meta/episodes.jsonl"] = jsonl(
    episodes.map((ep) => ({
      episode_index: ep.episode_index,
      tasks: [ep.instruction],
      length: ep.frames.length,
      scenario_id: ep.scenario_id,
      mode: ep.mode,
      pass: ep.pass,
    })),
  );
  files["meta/stats.json"] = json(datasetStats(episodes));
  files["meta/episodes_stats.jsonl"] = jsonl(episodeStatsRows(episodes, taskIndex, firstIndex));
  files["meta/modality.json"] = json(modalityJson(Boolean(video)));
  return files;
}
