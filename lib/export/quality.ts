/**
 * The quality report that travels with every export. It says what the data is
 * (scripted, primitive-rendered episodes) and flags any state or action
 * dimension that never moves, since a model trained on it would learn nothing
 * there.
 */
import type { Envelope, TaskSpec } from "@/lib/spec/schema";
import { SO101_JOINTS, type EpisodeRecord, type QualityReport } from "@/lib/export/types";

/** A dimension whose range is at or below this is degenerate. */
export const DEGENERATE_RANGE = 1e-6;

export function headline(episodeCount: number): string {
  const noun = episodeCount === 1 ? "episode" : "episodes";
  return `${episodeCount} scripted, primitive-rendered ${noun}; a format-valid skeleton, not training data`;
}

/** Names like `observation.state.gripper.pos` for every dimension with max - min <= DEGENERATE_RANGE. */
export function degenerateDimensions(episodes: EpisodeRecord[]): string[] {
  const frames = episodes.flatMap((ep) => ep.frames);
  const out: string[] = [];
  for (const [feature, pick] of [
    ["observation.state", (f: (typeof frames)[number]) => f.state],
    ["action", (f: (typeof frames)[number]) => f.action],
  ] as const) {
    SO101_JOINTS.forEach((joint, d) => {
      let min = Infinity;
      let max = -Infinity;
      for (const f of frames) {
        const v = pick(f)[d];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (!(max - min > DEGENERATE_RANGE)) out.push(`${feature}.${joint}`);
    });
  }
  return out;
}

/** `vl#seg1` -> `vl`, `tavily:https://...` -> `tavily`, `user#edit` -> `user`. */
export function sourceKind(source: string): string {
  return source.split(/[#:]/, 1)[0] || "default";
}

/** How many spec values (objects, steps, via-points) came from each kind of source. */
export function specCoverageBySource(spec: TaskSpec): Record<string, number> {
  const sources = [
    ...spec.objects.map((o) => o.source),
    ...spec.steps.flatMap((s) => [s.source, ...s.via_points.map((v) => v.source)]),
  ];
  const out: Record<string, number> = {};
  for (const s of sources) {
    const kind = sourceKind(s);
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

export type QualityInput = {
  episodes: EpisodeRecord[];
  /** only the axes the saboteur ran */
  envelope?: Partial<Envelope>;
  spec?: TaskSpec;
  /** true only once validate_groot.py has loaded this export */
  loaderValidated?: boolean;
};

export function buildQualityReport({ episodes, envelope, spec, loaderValidated = false }: QualityInput): QualityReport {
  return {
    headline: headline(episodes.length),
    envelope_per_axis: Object.fromEntries(Object.entries(envelope ?? {}).filter(([, v]) => v !== undefined)),
    spec_coverage_by_source: spec ? specCoverageBySource(spec) : {},
    degenerate_dimensions: degenerateDimensions(episodes),
    loader_validated: loaderValidated,
  };
}

const unitOf = (axis: string) => (axis.endsWith("_deg") ? "deg" : axis.endsWith("_mm") ? "mm" : "");
const cell = (v: number | null, unit: string) => (v === null ? "none passed" : `±${v} ${unit}`.trim());

export type QualityMarkdownOptions = {
  /** what the joint values are, as the rehearsal recorded them */
  jointUnits?: string;
};

/** QUALITY.md, written next to the dataset. */
export function renderQualityMarkdown(
  report: QualityReport,
  episodes: EpisodeRecord[],
  { jointUnits = "radians (MuJoCo joint positions)" }: QualityMarkdownOptions = {},
): string {
  const lines: string[] = ["# Quality report", "", `**${report.headline}.**`, ""];

  lines.push(
    "These episodes come from a scripted SO-101 program rehearsed in rigid-body simulation with a geometric grasp, rendered from primitives. They fill the LeRobot v2.1 layout Isaac-GR00T reads, to show the format; they are not demonstrations to train a policy on.",
    "",
  );
  lines.push(
    report.loader_validated
      ? "Loader-validated with Isaac-GR00T."
      : "Not loader-validated: `validate_groot.py` has not run on this export.",
    "",
  );
  lines.push(
    `Joint values are written as the rehearsal recorded them: ${jointUnits}. Isaac-GR00T's \`cube_to_bowl_5\` stores LeRobot's normalised range instead (-100 to 100, gripper 0 to 100); nothing here is converted.`,
    "",
  );

  lines.push("## Degenerate dimensions", "");
  if (report.degenerate_dimensions.length === 0) {
    lines.push("Every state and action dimension moves (range above 1e-6).", "");
  } else {
    lines.push("**Do not train.** These dimensions never move across the export:", "");
    for (const d of report.degenerate_dimensions) lines.push(`- \`${d}\``);
    lines.push("");
  }

  lines.push("## Episodes", "", "| episode | scenario | mode | pass | frames |", "|---|---|---|---|---|");
  for (const ep of episodes) {
    lines.push(`| ${ep.episode_index} | ${ep.scenario_id} | ${ep.mode} | ${ep.pass ? "yes" : "no"} | ${ep.frames.length} |`);
  }
  lines.push("");

  lines.push("## Envelope per axis", "", "The largest offset that still passed, per mode.", "");
  const axes = Object.entries(report.envelope_per_axis);
  if (axes.length === 0) {
    lines.push("No perturbation scenarios were run.", "");
  } else {
    lines.push("| axis | sensed | blind |", "|---|---|---|");
    for (const [axis, { sensed, blind }] of axes) {
      const unit = unitOf(axis);
      lines.push(`| ${axis} | ${cell(sensed, unit)} | ${cell(blind, unit)} |`);
    }
    lines.push("");
  }

  lines.push("## Spec coverage by source", "", "Where each object, step and via-point of the task spec came from.", "");
  const sources = Object.entries(report.spec_coverage_by_source);
  if (sources.length === 0) {
    lines.push("No task spec was attached to this export.", "");
  } else {
    const total = sources.reduce((s, [, n]) => s + n, 0);
    lines.push("| source | values | share |", "|---|---|---|");
    for (const [source, n] of sources.sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${source} | ${n} | ${Math.round((100 * n) / total)}% |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
