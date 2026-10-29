/**
 * Labels of your own clips, kept in this browser (IndexedDB): the same clip
 * with the same line labels at once the next time, instead of waiting on
 * Super VL again. Only a live answer is kept; a replay is already instant.
 * Storage can be missing or refused (a private window): every call then
 * does nothing and the label goes live, as before.
 */
import { get, set } from "idb-keyval";
import { RECORDED, recordedDay } from "@/lib/showcase/play";
import type { TaskSpec } from "@/lib/spec/schema";
import type { StageResult } from "@/lib/spec/stage-result";

type Kept = { result: Extract<StageResult<TaskSpec>, { status: "done" }>; at: string };

const key = (sha256: string, line: string) => `understudy:label:${sha256}:${line.trim().toLowerCase()}`;

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
  try {
    await set(key(sha256, line), { result, at: new Date().toISOString() } satisfies Kept);
  } catch {
    // nowhere to keep it: the next run labels live
  }
}
