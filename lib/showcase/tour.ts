/**
 * The 1-minute demo at /demo: which recording it plays, which versions of its program it rehearses, and the export
 * it builds from the rollouts it showed. Nothing here reads files or calls a model.
 */
import type { GroundingRecord } from "@/lib/export/grounding";
import { clipSource } from "@/lib/export/source";
import { buildExportZip, type ExportResult } from "@/lib/export/zip";
import { resample, type TraceFrame } from "@/lib/export/trace";
import type { EpisodeRecord } from "@/lib/export/types";
import type { GravityName, TaskSpec } from "@/lib/spec/schema";
import type { Recorded } from "./load";
import type { Session } from "./session";

/** The dataset's frame rate, as #34 sets it for the full export. */
export const TOUR_FPS = 15;

const passesBoth = (r: Session["iterations"][number]["results"]) => r.earth.pass && r.orbit.pass;

/** A recording shows the whole loop when the robot asked something, a Notes patch came after, and its last version passes in both worlds. */
function whole(s: Session): boolean {
  return s.turns.some((t) => t.asks.length > 0) && s.iterations.some((x) => x.source === "notes") && passesBoth(s.iterations.at(-1)!.results);
}

/**
 * The recording the tour plays, chosen by what it shows and never by its task: the whole loop, best with a version
 * that passes on Earth and fails in orbit (the point of rehearsing in two worlds); else the whole loop; else the first.
 */
export function tourPick(all: Recorded[]): Recorded | undefined {
  const orbitOnly = (s: Session) => s.iterations.some((x) => x.results.earth.pass && !x.results.orbit.pass);
  return all.find((r) => whole(r.session) && orbitOnly(r.session)) ?? all.find((r) => whole(r.session)) ?? all[0];
}

/**
 * The two versions the tour rehearses: the first one that fails without stopping at an open question (what the
 * answers made), and the last one. `patches` are the Notes iterations between them.
 */
export function tourVersions(s: Session): { first: number; last: number; patches: number[] } {
  const last = s.iterations.length - 1;
  const gap = (x: Session["iterations"][number]) => [x.results.earth, x.results.orbit].some((r) => r.failure_class === "spec_gap" && r.why?.startsWith("unanswered: "));
  const found = s.iterations.findIndex((x, i) => i < last && !gap(x) && !passesBoth(x.results));
  const first = found < 0 ? last : found;
  const patches = s.iterations.flatMap((x, i) => (i > first && x.source === "notes" ? [i] : []));
  return { first, last, patches };
}

/** One instruction for the dataset's task table, from the spec's first step that puts an object somewhere. */
export function instruction(spec: TaskSpec): string {
  const name = (id: string) => spec.objects.find((o) => o.id === id)?.name ?? id;
  const s = spec.steps.find((x) => x.object !== undefined && x.target && x.target.frame !== x.object);
  if (!s) return spec.title;
  return `${s.verb} the ${name(s.object!)} ${s.target!.fixture === "pocket" ? "into" : "onto"} the ${name(s.target!.frame)}`;
}

export type TourRun = { world: GravityName; trace: TraceFrame[] };

/**
 * The download: every passing rollout the stage played of the last version, as LeRobot v2.1 episodes, and next to
 * them what the recording holds (the spec, the program, the interview, the ledger). No video: the frames are not kept.
 * The clip's source and licence (#61) go in QUALITY.md and next to the clip in recording.json; `grounding`, when the
 * session looked something up on the web (#112), becomes grounding.json.
 */
export async function tourExport(session: Session, runs: TourRun[], grounding?: GroundingRecord | null): Promise<ExportResult> {
  const source = clipSource(session.clip.name);
  const it = session.iterations.at(-1)!;
  const task = instruction(it.spec);
  const episodes: EpisodeRecord[] = runs.map((r, episode_index) => ({
    episode_index,
    scenario_id: r.world,
    mode: "sensed",
    pass: true,
    fps: TOUR_FPS,
    instruction: task,
    frames: resample(r.trace, TOUR_FPS),
  }));
  return buildExportZip(
    {
      robot_type: "so101_follower",
      codebase_version: "v2.1",
      episodes,
      understudy: {
        spec: it.spec,
        program: it.program,
        interview: session.turns.map((t) => ({ asks: t.asks, answers: t.answers.map(({ slot, text }) => ({ slot, text })) })),
        versions: session.iterations.map((x) => ({ source: x.source, changes: x.changes, why: x.why, results: x.results })),
        ledger: session.ledger,
        ...(grounding ? { grounding } : {}),
        recording: { clip: session.clip, source, hint: session.hint, recorded_at: session.recorded_at, models: session.models, total_usd: session.total_usd },
      },
    },
    { spec: it.spec, origin: "rehearsal", source },
  );
}
