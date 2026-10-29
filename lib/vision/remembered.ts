/**
 * Labels of your own clips, kept in this browser (IndexedDB): the same clip
 * with the same line labels at once the next time, instead of waiting on
 * Super VL again. Only a live answer is kept, never a replay or a sample's
 * token; a sample's own line answers from its recording anyway.
 * Storage can be missing or refused (a private window): every call then
 * does nothing and the label goes live, as before.
 */
import { get, set } from "idb-keyval";
import { RECORDED, recordedDay } from "@/lib/showcase/play";
import type { TaskSpec } from "@/lib/spec/schema";
import type { StageResult } from "@/lib/spec/stage-result";

type Kept = { result: Extract<StageResult<TaskSpec>, { status: "done" }>; at: string };

/** the line as sent, case and all: "part A" and "part a" can name different objects */
const key = (sha256: string, line: string) => `understudy:label:${sha256}:${line.trim()}`;

export async function rememberedLabel(sha256: string, line: string): Promise<StageResult<TaskSpec> | null> {
  try {
    const kept = (await get(key(sha256, line))) as Kept | undefined;
    if (kept?.result.status !== "done") return null;
    return { ...kept.result, warnings: [`${RECORDED}${recordedDay(kept.at)}, in this browser`, ...kept.result.warnings] };
  } catch {
    return null;
  }
}

export async function rememberLabel(sha256: string, line: string, result: StageResult<TaskSpec>): Promise<void> {
  if (result.status !== "done" || result.warnings.some((w) => w.startsWith("replay"))) return;
  // the label only: a sample token expires within the hour and is never kept (lib/unlock/token.ts)
  const { value, warnings, ledger } = result;
  try {
    await set(key(sha256, line), { result: { status: "done", value, warnings, ledger }, at: new Date().toISOString() } satisfies Kept);
  } catch {
    // nowhere to keep it: the next run labels live
  }
}
