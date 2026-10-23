import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { syntheticEpisodes } from "@/lib/export/synthetic";
import { buildExportZip, understudyFiles } from "@/lib/export/zip";
import { parseJson, stubVideoEncoder, text, withVideo } from "./helpers";

describe("export zip", () => {
  it("lists the expected paths", async () => {
    const { zip, paths, quality } = await buildExportZip(
      {
        robot_type: "so101_follower",
        codebase_version: "v2.1",
        episodes: withVideo(syntheticEpisodes()),
        understudy: { spec: { title: "t" }, "report.md": "# report\n" },
      },
      { video: stubVideoEncoder() },
    );
    const entries = unzipSync(zip);
    const expected = [
      "lerobot/QUALITY.md",
      "lerobot/data/chunk-000/episode_000000.parquet",
      "lerobot/data/chunk-000/episode_000001.parquet",
      "lerobot/data/chunk-000/episode_000002.parquet",
      "lerobot/data/chunk-000/episode_000003.parquet",
      "lerobot/meta/episodes.jsonl",
      "lerobot/meta/episodes_stats.jsonl",
      "lerobot/meta/info.json",
      "lerobot/meta/modality.json",
      "lerobot/meta/stats.json",
      "lerobot/meta/tasks.jsonl",
      "lerobot/videos/chunk-000/observation.images.workspace/episode_000000.mp4",
      "lerobot/videos/chunk-000/observation.images.workspace/episode_000001.mp4",
      "lerobot/videos/chunk-000/observation.images.workspace/episode_000002.mp4",
      "lerobot/videos/chunk-000/observation.images.workspace/episode_000003.mp4",
      "understudy/quality.json",
      "understudy/report.md",
      "understudy/spec.json",
    ];
    expect(Object.keys(entries).sort()).toEqual(expected);
    expect(paths).toEqual(expected);
    expect(text(entries["lerobot/QUALITY.md"])).toContain(quality.headline);
    expect(parseJson(entries["understudy/spec.json"])).toEqual({ title: "t" });
    expect(parseJson(entries["understudy/quality.json"]).degenerate_dimensions).toEqual([]);
    expect(text(entries["understudy/report.md"])).toBe("# report\n");
  });

  it("refuses names that escape their folder", () => {
    expect(() => understudyFiles({ "../evil": 1 })).toThrow(/unsafe/);
    expect(() => understudyFiles({ "/abs.json": 1 })).toThrow(/unsafe/);
  });
});
