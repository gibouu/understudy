/**
 * The quality report that travels with every export. It says what the data is
 * (scripted episodes, primitive-rendered only when the export holds video) and flags any state or action
 * dimension that never moves, since a model trained on it would learn nothing
 * there.
 */
import type { Envelope, SignedBand, TaskSpec } from "@/lib/spec/schema";
import { sourceMarkdown, type ClipSource } from "@/lib/export/source";
import { SO101_JOINTS, type EpisodeRecord, type QualityReport } from "@/lib/export/types";

/** A dimension whose range is at or below this is degenerate. */
export const DEGENERATE_RANGE = 1e-6;

/** rehearsal: rollouts of the simulated arm; synthetic: lib/export/synthetic, joint keyframes and no physics. */
export type EpisodeOrigin = "rehearsal" | "synthetic";

const ORIGIN_TEXT: Record<EpisodeOrigin, { kind: string; how: string; units: string }> = {
  rehearsal: {
    kind: "scripted, primitive-rendered",
    how: "These episodes come from a scripted SO-101 program rehearsed in rigid-body simulation with a geometric grasp, rendered from primitives.",
    units: "radians (MuJoCo joint positions)",
  },
  synthetic: {
    kind: "synthetic, scripted",
    how: "These episodes are a scripted joint-space trajectory interpolated between keyframes: no physics, no grasp, no rendering.",
    units: "radians (scripted SO-101 joint keyframes)",
  },
};

/** Rehearsed episodes are rendered only when the export holds their video; without it they are joint values alone (#168). */
function originText(origin: EpisodeOrigin, rendered: boolean) {
  if (origin === "synthetic" || rendered) return ORIGIN_TEXT[origin];
  return {
    ...ORIGIN_TEXT.rehearsal,
    kind: "scripted",
    how: "These episodes come from a scripted SO-101 program rehearsed in rigid-body simulation with a geometric grasp: joint states and actions only, no video.",
  };
}

export function headline(episodeCount: number, origin: EpisodeOrigin = "rehearsal", rendered = false): string {
  const noun = episodeCount === 1 ? "episode" : "episodes";
  return `${episodeCount} ${originText(origin, rendered).kind} ${noun}; a format-valid skeleton, not training data`;
}

/**
 * Names like `observation.state.gripper.pos` for every dimension whose range,
 * in the float32 values the parquet holds, is at most DEGENERATE_RANGE.
 */
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
        const v = Math.fround(pick(f)[d]);
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
  origin?: EpisodeOrigin;
  /** the export holds a video of each episode */
  rendered?: boolean;
};

export function buildQualityReport({
  episodes,
  envelope,
  spec,
  loaderValidated = false,
  origin = "rehearsal",
  rendered = false,
}: QualityInput): QualityReport {
  return {
    headline: headline(episodes.length, origin, rendered),
    envelope_per_axis: Object.fromEntries(Object.entries(envelope ?? {}).filter(([, v]) => v !== undefined)),
    spec_coverage_by_source: spec ? specCoverageBySource(spec) : {},
    degenerate_dimensions: degenerateDimensions(episodes),
    loader_validated: loaderValidated,
  };
}

const unitOf = (axis: string) => (axis.endsWith("_deg") ? "deg" : axis.endsWith("_mm") ? "mm" : "");
/** "-4 to +8 mm (fails at -6 / +10)": the passing range per side, then the first failures seen. */
const band = (b: SignedBand, unit: string) => {
  if (b.pass_neg === null && b.pass_pos === null) return "none passed";
  const lo = b.pass_neg === null ? "?" : `${b.pass_neg}`;
  const hi = b.pass_pos === null ? "?" : `+${b.pass_pos}`;
  const fails =
    b.fail_neg !== null || b.fail_pos !== null
      ? ` (fails at ${b.fail_neg ?? "?"} / ${b.fail_pos === null ? "?" : `+${b.fail_pos}`})`
      : "";
  return `${lo} to ${hi} ${unit}`.trim() + fails;
};

export type QualityMarkdownOptions = {
  /** what the joint values are, as the rehearsal recorded them */
  jointUnits?: string;
  /** must match the origin the report was built with */
  origin?: EpisodeOrigin;
  /** must match the report's too */
  rendered?: boolean;
  /** where the clip came from (#61): a sample's source and licence, or "upload"; the section is left out when unknown */
  source?: ClipSource;
  /** what the zip holds, file by file (or folder by folder), said under "What this export holds" */
  contents?: { path: string; what: string }[];
};

/** QUALITY.md, written next to the dataset. */
export function renderQualityMarkdown(
  report: QualityReport,
  episodes: EpisodeRecord[],
  { origin = "rehearsal", rendered = false, jointUnits = ORIGIN_TEXT[origin].units, source, contents }: QualityMarkdownOptions = {},
): string {
  const lines: string[] = ["# Quality report", "", `**${report.headline}.**`, ""];
  if (source !== undefined) lines.push(...sourceMarkdown(source));
  if (contents?.length) {
    lines.push("## What this export holds", "");
    for (const c of contents) lines.push(`- \`${c.path}\`: ${c.what}`);
    lines.push("");
  }

  lines.push(
    `${originText(origin, rendered).how} They fill the LeRobot v2.1 layout Isaac-GR00T reads, to show the format; they are not demonstrations to train a policy on.`,
    "",
  );
  lines.push(
    report.loader_validated
      ? "Loader-validated with Isaac-GR00T."
      : "Not loader-validated: `validate_groot.py` has not run on this export.",
    "",
  );
  lines.push(
    `Joint values are written as recorded: ${jointUnits}. Isaac-GR00T's \`cube_to_bowl_5\` stores LeRobot's normalised range instead (-100 to 100, gripper 0 to 100); nothing here is converted.`,
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

  lines.push("## Envelope per axis", "", "Sampled evidence: the largest offset that still passed and the smallest that failed, per side and per mode. A symmetric band exists only where both sides were sampled.", "");
  const axes = Object.entries(report.envelope_per_axis);
  if (axes.length === 0) {
    lines.push("No perturbation scenarios were run.", "");
  } else {
    lines.push("| axis | sensed | blind |", "|---|---|---|");
    for (const [axis, { sensed, blind }] of axes) {
      const unit = unitOf(axis);
      lines.push(`| ${axis} | ${band(sensed, unit)} | ${band(blind, unit)} |`);
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
