/**
 * The recordings in public/showcase, for the routes: /api/label answers a
 * sample's recorded label at once (`recorded: true`), and /api/notes a
 * recorded patch for exactly the program and attempt it was made for. Read
 * once per instance; next.config.ts ships the files with both routes.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SAMPLES } from "@/lib/samples";
import type { NotePatch } from "@/lib/notes/patch";
import type { Program, TaskSpec } from "@/lib/spec/schema";
import { done, type StageResult } from "@/lib/spec/stage-result";
import { recordedNote, same } from "./play";
import { LabelRecording, Session } from "./session";

type Kept = Session | LabelRecording;

let all: Promise<Kept[]> | undefined;

/** Every recording of a sample; one that does not parse is skipped and logged, so a bad file costs a live call, not the page. */
function recordings(): Promise<Kept[]> {
  const dir = path.join(process.cwd(), "public", "showcase");
  all ??= readdir(dir)
    .catch(() => [] as string[])
    .then((files) =>
      Promise.all(
        files
          .filter((f) => f.endsWith(".json"))
          .map(async (f): Promise<Kept | null> => {
            try {
              const raw = JSON.parse(await readFile(path.join(dir, f), "utf8"));
              const rec = f.endsWith(".label.json") ? LabelRecording.parse(raw) : Session.parse(raw);
              return SAMPLES.some((s) => s.name === rec.clip.name) ? rec : null;
            } catch (err) {
              console.warn(`showcase: ${f} is not a recording (${(err as Error).message})`);
              return null;
            }
          }),
      ),
    )
    .then((xs) => xs.filter((x): x is Kept => x !== null));
  return all;
}

/** The label Super VL gave a sample clip when it was recorded, or null. */
export async function recordedLabel(sha256: string): Promise<StageResult<TaskSpec> | null> {
  const rec = (await recordings()).find((r) => r.clip.sha256 === sha256);
  return rec ? done(rec.label.spec, [recordedNote(rec, "label"), ...rec.label.warnings]) : null;
}

/**
 * The patch recorded for this program as attempt `attempt` (0-based): the
 * Notes iteration whose previous version is this program, after `attempt`
 * Notes iterations. The spec must be the one it was rehearsed against.
 */
export async function recordedPatch(spec: TaskSpec, program: Program, attempt: number): Promise<StageResult<NotePatch> | null> {
  for (const rec of await recordings()) {
    if (!("iterations" in rec)) continue;
    const notes = rec.iterations.flatMap((it, i) => (it.source === "notes" ? [i] : []));
    const i = notes[attempt];
    const it = rec.iterations[i];
    if (i === undefined || !it.patch || !same(rec.iterations[i - 1].program, program) || !same(it.spec, spec)) continue;
    return done(it.patch, [recordedNote(rec, "notes")]);
  }
  return null;
}
