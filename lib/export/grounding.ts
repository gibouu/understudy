/**
 * `understudy/grounding.json` (issues #29, #112): what the opt-in web search
 * found and what it cost, from the Tavily ledger the chips show
 * (app/ground-chips.tsx): the query, the pages read, each chip and whether it
 * was added to the spec, every Tavily call with its request id and credits,
 * and the filtering model's tokens. An export built from a session that
 * looked something up writes it; one that did not has no such file.
 */
import type { Chip, Grounding } from "@/lib/spec/ground";
import type { LedgerEntry, StageResult } from "@/lib/spec/stage-result";

export type GroundingRecord = {
  query: string;
  pages: Grounding["pages"];
  chips: (Chip & { added: boolean })[];
  tavily: { request_id: string | null; credits: number | null; seconds: number; call: string }[];
  /** the model that kept the sentences, and its tokens */
  filter: { model: string; prompt_tokens: number; completion_tokens: number; seconds: number }[];
  /** what the route noted, a replay's reason included */
  warnings: string[];
};

/** The record for a finished lookup and the chips added from it; null before one has finished. */
export function groundingRecord(result: StageResult<Grounding>, added: readonly number[]): GroundingRecord | null {
  if (result.status !== "done") return null;
  const ledger: LedgerEntry[] = result.ledger ?? [];
  return {
    query: result.value.query,
    pages: result.value.pages,
    chips: result.value.chips.map((c, i) => ({ ...c, added: added.includes(i) })),
    tavily: ledger.filter((e) => e.model.startsWith("tavily/")).map((e) => ({ call: e.model, request_id: e.request_id ?? null, credits: e.credits ?? null, seconds: e.seconds })),
    filter: ledger.filter((e) => !e.model.startsWith("tavily/")).map((e) => ({ model: e.model, prompt_tokens: e.prompt_tokens, completion_tokens: e.completion_tokens, seconds: e.seconds })),
    warnings: result.warnings,
  };
}
