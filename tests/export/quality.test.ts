import { describe, expect, it } from "vitest";
import { buildQualityReport, degenerateDimensions, renderQualityMarkdown, specCoverageBySource } from "@/lib/export/quality";
import { syntheticEpisodes } from "@/lib/export/synthetic";
import { TaskSpec } from "@/lib/spec/schema";

describe("degenerate dimensions", () => {
  it("are none on the synthetic episodes", () => {
    expect(degenerateDimensions(syntheticEpisodes())).toEqual([]);
  });

  it("fire on a constant joint, in state and action", () => {
    const eps = syntheticEpisodes();
    for (const ep of eps) {
      for (const f of ep.frames) {
        f.state[4] = 0.25;
        f.action[4] = 0.25;
      }
    }
    expect(degenerateDimensions(eps)).toEqual(["observation.state.wrist_roll.pos", "action.wrist_roll.pos"]);
    const report = buildQualityReport({ episodes: eps });
    expect(report.degenerate_dimensions).toHaveLength(2);
    const md = renderQualityMarkdown(report, eps);
    expect(md).toContain("**Do not train.**");
    expect(md).toContain("`action.wrist_roll.pos`");
  });
});

describe("degenerate dimensions in float32", () => {
  it("fire when values differ only below float32 precision", () => {
    const eps = syntheticEpisodes();
    for (const ep of eps) ep.frames.forEach((f, i) => (f.state[0] = i % 2 ? 100 : 100.000002));
    expect(degenerateDimensions(eps)).toEqual(["observation.state.shoulder_pan.pos"]);
  });
});

describe("QUALITY.md", () => {
  const spec = TaskSpec.parse({
    version: 1,
    title: "t",
    summary: "s",
    objects: [
      { id: "a", name: "a", shape: "box", size_mm: [10, 10, 10], symmetry: "none", role: "manipulated", source: "vl#seg1" },
      { id: "b", name: "b", shape: "box", size_mm: [50, 50, 10], symmetry: "none", role: "fixture", source: "interview#2" },
    ],
    steps: [
      {
        id: "s1",
        verb: "place",
        object: "a",
        t_start_s: 0,
        t_end_s: 1,
        source: "vl#seg2",
        via_points: [
          { frame: "b", xyz_mm: [0, 0, 20], source: "pose#seg2" },
          { frame: "b", xyz_mm: [0, 0, 5] },
        ],
      },
    ],
  });

  it("counts spec values by source kind", () => {
    expect(specCoverageBySource(spec)).toEqual({ vl: 2, interview: 1, pose: 1, default: 1 });
  });

  it("prints the headline, envelope, coverage and validation status", () => {
    const episodes = syntheticEpisodes();
    const report = buildQualityReport({
      episodes,
      spec,
      envelope: {
        x_mm: {
          sensed: { pass_neg: -4, pass_pos: 8, fail_neg: -6, fail_pos: 10 },
          blind: { pass_neg: null, pass_pos: null, fail_neg: -2, fail_pos: 2 },
        },
        yaw_deg: {
          sensed: { pass_neg: -15, pass_pos: 15, fail_neg: null, fail_pos: null },
          blind: { pass_neg: -15, pass_pos: 15, fail_neg: null, fail_pos: null },
        },
      },
    });
    expect(report.headline).toBe("4 scripted, primitive-rendered episodes; a format-valid skeleton, not training data");
    expect(report.loader_validated).toBe(false);
    const md = renderQualityMarkdown(report, episodes);
    expect(md).toContain(`**${report.headline}.**`);
    expect(md).toContain("| x_mm | -4 to +8 mm (fails at -6 / +10) | none passed |");
    expect(md).toContain("| yaw_deg | -15 to +15 deg | -15 to +15 deg |");
    expect(md).toContain("| vl | 2 | 40% |");
    expect(md).toContain("Not loader-validated");
    expect(md).not.toContain("Loader-validated with Isaac-GR00T");
    expect(md).toContain("Every state and action dimension moves");
    expect(md).toContain("| 2 | x_mm+8 | blind | no | 60 |");
  });

  it("describes synthetic episodes without physics claims", () => {
    const episodes = syntheticEpisodes();
    const report = buildQualityReport({ episodes, origin: "synthetic" });
    expect(report.headline).toBe("4 synthetic, scripted episodes; a format-valid skeleton, not training data");
    const md = renderQualityMarkdown(report, episodes, { origin: "synthetic" });
    expect(md).toContain("no physics, no grasp, no rendering");
    expect(md).not.toContain("rigid-body");
    expect(md).not.toContain("MuJoCo");
  });

  it("claims loader validation only when told", () => {
    const episodes = syntheticEpisodes();
    const md = renderQualityMarkdown(buildQualityReport({ episodes, loaderValidated: true }), episodes);
    expect(md).toContain("Loader-validated with Isaac-GR00T.");
  });
});
