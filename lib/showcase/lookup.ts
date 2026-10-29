/**
 * The recordings in public/showcase, for the routes: /api/label answers a
 * sample's recorded label at once (`recorded: true`), /api/notes a
 * recorded patch for exactly the program and attempt it was made for, and
 * /api/variants and /api/compile a sample's pre-run similar tasks
 * (<clip>.variants.json). Read once per instance; next.config.ts ships the
 * files with these routes.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SAMPLES } from "@/lib/samples";
import type { NotePatch } from "@/lib/notes/patch";
import type { Program, TaskSpec } from "@/lib/spec/schema";
import { done, type LedgerEntry, type StageResult } from "@/lib/spec/stage-result";
import { RECORDED, recordedDay, recordedNote, same } from "./play";
import { LabelRecording, Session, VariantsRecording } from "./session";

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
          .filter((f) => f.endsWith(".json") && !f.endsWith(".variants.json"))
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
  // its recorded calls come along, so the page names the model that answered then
  return rec ? done(rec.label.spec, [recordedNote(rec, "label"), ...rec.label.warnings], rec.ledger.filter((c) => c.stage === "label")) : null;
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

let prerun: Promise<VariantsRecording[]> | undefined;

/** Every sample's pre-run similar tasks; a file that does not parse is skipped and logged, as above. */
function prerunAll(): Promise<VariantsRecording[]> {
  const dir = path.join(process.cwd(), "public", "showcase");
  prerun ??= readdir(dir)
    .catch(() => [] as string[])
    .then((files) =>
      Promise.all(
        files
          .filter((f) => f.endsWith(".variants.json"))
          .map(async (f) => {
            try {
              const rec = VariantsRecording.parse(JSON.parse(await readFile(path.join(dir, f), "utf8")));
              return SAMPLES.some((s) => s.name === rec.clip.name) ? rec : null;
            } catch (err) {
              console.warn(`showcase: ${f} is not a pre-run (${(err as Error).message})`);
              return null;
            }
          }),
      ),
    )
    .then((xs) => xs.filter((x): x is VariantsRecording => x !== null));
  return prerun;
}

const prerunNote = (rec: VariantsRecording) => `${RECORDED}${recordedDay(rec.recorded_at)}, ahead of time for this sample`;

/** The similar tasks suggested ahead of time for exactly this spec, numbered from 1, or null. */
export async function prerunVariants<T>(spec: TaskSpec): Promise<StageResult<T> | null> {
  const rec = (await prerunAll()).find((r) => same(r.spec, spec));
  if (!rec) return null;
  const { value, warnings, ledger } = rec.suggestions;
  return done(value as T, [prerunNote(rec), ...warnings], ledger as LedgerEntry[] | undefined);
}

/** The program written ahead of time for exactly this similar task's spec, or null. */
export async function prerunProgram(spec: TaskSpec): Promise<StageResult<Program> | null> {
  for (const rec of await prerunAll()) {
    const hit = rec.programs.find((p) => same(p.spec, spec));
    if (hit) return done(hit.result.value as Program, [prerunNote(rec), ...hit.result.warnings], hit.result.ledger as LedgerEntry[] | undefined);
  }
  return null;
}
