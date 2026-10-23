import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { describe, expect, it } from "vitest";
import {
  buildLeRobot,
  datasetStats,
  episodeDataPath,
  episodeVideoPath,
  featureStats,
} from "@/lib/export/lerobot";
import { SYNTHETIC_INSTRUCTION, syntheticEpisodes } from "@/lib/export/synthetic";
import { SO101_JOINTS, type EpisodeRecord } from "@/lib/export/types";
import { grootJson, grootJsonl, keys, parseJson, parseJsonl, stubVideoEncoder, withVideo } from "./helpers";

const toArrayBuffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe("meta/ files against Isaac-GR00T cube_to_bowl_5", async () => {
  const video = stubVideoEncoder();
  const files = await buildLeRobot(withVideo(syntheticEpisodes()), { video });

  it("info.json has the demo's keys, feature keys and joint names", () => {
    const ours = parseJson(files["meta/info.json"]);
    const theirs = grootJson("info.json");
    expect(keys(ours)).toEqual(keys(theirs));
    expect(ours.codebase_version).toBe("v2.1");
    expect(ours.robot_type).toBe("so101_follower");
    expect(ours.data_path).toBe(theirs.data_path);
    expect(ours.video_path).toBe(theirs.video_path);
    for (const f of ["action", "observation.state", "timestamp", "frame_index", "episode_index", "index", "task_index"]) {
      expect(ours.features[f]).toEqual(theirs.features[f]);
    }
    const ourVideo = ours.features["observation.images.workspace"];
    const theirVideo = theirs.features["observation.images.front"];
    expect(keys(ourVideo)).toEqual(keys(theirVideo));
    expect(keys(ourVideo.info)).toEqual(keys(theirVideo.info));
    expect(ourVideo.shape).toEqual([360, 480, 3]);
    expect(ourVideo.info["video.fps"]).toBe(15);
    expect(ours.features["observation.state"].names).toEqual([...SO101_JOINTS]);
    expect(ours).toMatchObject({ total_episodes: 4, total_frames: 240, total_tasks: 1, fps: 15, total_chunks: 1, total_videos: 4 });
  });

  it("tasks.jsonl has the demo's keys and one row per instruction", () => {
    const ours = parseJsonl(files["meta/tasks.jsonl"]);
    expect(keys(ours[0])).toEqual(keys(grootJsonl("tasks.jsonl")[0]));
    expect(ours).toEqual([{ task_index: 0, task: SYNTHETIC_INSTRUCTION }]);
  });

  it("episodes.jsonl has the demo's keys plus scenario, mode and pass", () => {
    const ours = parseJsonl(files["meta/episodes.jsonl"]);
    expect(keys(ours[0])).toEqual([...keys(grootJsonl("episodes.jsonl")[0]), "mode", "pass", "scenario_id"].sort());
    expect(ours[2]).toEqual({
      episode_index: 2,
      tasks: [SYNTHETIC_INSTRUCTION],
      length: 60,
      scenario_id: "x_mm+8",
      mode: "blind",
      pass: false,
    });
  });

  it("modality.json matches the demo except for the camera name", () => {
    const ours = parseJson(files["meta/modality.json"]);
    const theirs = grootJson("modality.json");
    expect(keys(ours)).toEqual(keys(theirs));
    expect(ours.state).toEqual(theirs.state);
    expect(ours.action).toEqual(theirs.action);
    expect(ours.annotation).toEqual(theirs.annotation);
    expect(ours.video).toEqual({ workspace: { original_key: "observation.images.workspace" } });
  });

  it("stats.json has the demo's features and statistics", () => {
    const ours = parseJson(files["meta/stats.json"]);
    const theirs = grootJson("stats.json");
    expect(keys(ours)).toEqual(keys(theirs));
    for (const f of keys(theirs)) {
      expect(keys(ours[f])).toEqual(keys(theirs[f]));
      expect(ours[f].mean).toHaveLength(theirs[f].mean.length);
    }
  });

  it("writes one video per episode from all its frames", () => {
    expect(video.calls).toEqual([60, 60, 60, 60]);
    expect(files[episodeVideoPath(3)]).toBeDefined();
    expect(episodeVideoPath(3)).toBe("videos/chunk-000/observation.images.workspace/episode_000003.mp4");
  });
});

describe("parquet", async () => {
  const episodes = syntheticEpisodes();
  const files = await buildLeRobot(episodes);

  it("round-trips through hyparquet with LeRobot's columns and row counts", async () => {
    let index = 0;
    for (const ep of episodes) {
      const path = episodeDataPath(ep.episode_index);
      expect(path).toBe(`data/chunk-000/episode_00000${ep.episode_index}.parquet`);
      const buffer = toArrayBuffer(files[path]);
      const rows = await parquetReadObjects({ file: buffer });
      expect(rows).toHaveLength(ep.frames.length);
      expect(Object.keys(rows[0])).toEqual([
        "action",
        "observation.state",
        "timestamp",
        "frame_index",
        "episode_index",
        "index",
        "task_index",
      ]);
      rows.forEach((row, i) => {
        expect(row.frame_index).toBe(BigInt(i));
        expect(row.episode_index).toBe(BigInt(ep.episode_index));
        expect(row.index).toBe(BigInt(index + i));
        expect(row.task_index).toBe(BigInt(0));
        expect(row.timestamp).toBeCloseTo(i / 15, 6);
        expect(row["observation.state"]).toEqual(ep.frames[i].state.map(Math.fround));
        expect(row.action).toEqual(ep.frames[i].action.map(Math.fround));
      });
      index += ep.frames.length;
      const leaves = parquetMetadata(buffer).schema.filter((s) => s.type).map((s) => s.type);
      expect(leaves).toEqual(["FLOAT", "FLOAT", "FLOAT", "INT64", "INT64", "INT64", "INT64"]);
    }
  });

  it("without a video encoder declares no video", () => {
    const info = parseJson(files["meta/info.json"]);
    expect(info.video_path).toBeNull();
    expect(info.total_videos).toBe(0);
    expect(info.features["observation.images.workspace"]).toBeUndefined();
    expect(parseJson(files["meta/modality.json"]).video).toEqual({});
    expect(Object.keys(files).some((p) => p.startsWith("videos/"))).toBe(false);
  });
});

describe("stats", () => {
  it("are correct on a known trajectory", () => {
    const s = featureStats([[1], [2], [3], [4]]);
    expect(s.mean).toEqual([2.5]);
    expect(s.std[0]).toBeCloseTo(Math.sqrt(1.25), 12);
    expect(s.min).toEqual([1]);
    expect(s.max).toEqual([4]);
    expect(s.q01[0]).toBeCloseTo(1.03, 12);
    expect(s.q99[0]).toBeCloseTo(3.97, 12);
  });

  it("cover state, action and timestamp across episodes", () => {
    const ramp = (k: number) => [k, 2 * k, 1 - k, 0.5, k * k, 10] as [number, number, number, number, number, number];
    const ep: EpisodeRecord = {
      episode_index: 0,
      scenario_id: "s",
      mode: "sensed",
      pass: true,
      fps: 2,
      instruction: "x",
      frames: [0, 1, 2].map((k) => ({ t_s: k / 2, state: ramp(k), action: ramp(k + 1) })),
    };
    const stats = datasetStats([ep]);
    expect(stats["observation.state"].mean).toEqual([1, 2, 0, 0.5, 5 / 3, 10]);
    expect(stats["observation.state"].min).toEqual([0, 0, -1, 0.5, 0, 10]);
    expect(stats["observation.state"].max).toEqual([2, 4, 1, 0.5, 4, 10]);
    expect(stats["observation.state"].std[0]).toBeCloseTo(Math.sqrt(2 / 3), 12);
    expect(stats["observation.state"].std[3]).toBe(0);
    expect(stats.action.mean[0]).toBe(2);
    expect(stats.timestamp.mean).toEqual([0.5]);
    expect(stats.timestamp.max).toEqual([1]);
  });
});

describe("validation", () => {
  it("rejects episode indices that do not run from 0", async () => {
    const eps = syntheticEpisodes().slice(1);
    await expect(buildLeRobot(eps)).rejects.toThrow(/0\.\.2/);
  });
  it("rejects a frame with five joints", async () => {
    const [ep] = syntheticEpisodes();
    ep.frames[3].state = ep.frames[3].state.slice(0, 5) as never;
    await expect(buildLeRobot([ep])).rejects.toThrow(/frame 3: state/);
  });
  it("rejects episodes missing video when an encoder is given", async () => {
    await expect(buildLeRobot(syntheticEpisodes(), { video: stubVideoEncoder() })).rejects.toThrow(/video frames/);
  });
  it("numbers tasks by first appearance", async () => {
    const eps = syntheticEpisodes();
    eps[1].instruction = "another instruction";
    const files = await buildLeRobot(eps);
    expect(parseJsonl(files["meta/tasks.jsonl"]).map((t) => t.task)).toEqual([SYNTHETIC_INSTRUCTION, "another instruction"]);
    const rows = await parquetReadObjects({ file: toArrayBuffer(files[episodeDataPath(1)]) });
    expect(rows[0].task_index).toBe(BigInt(1));
    const episodesMeta = parseJsonl(files["meta/episodes.jsonl"]);
    expect(episodesMeta[1].tasks).toEqual(["another instruction"]);
  });
});
