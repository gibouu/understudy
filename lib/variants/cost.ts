/**
 * What model calls cost at Token Factory's list prices (tests/fixtures/models.json,
 * GET /v1/models?verbose=true), with the formula of scripts/bench-ledger.mjs
 * costOf(). A model missing from the catalogue stays unpriced instead of
 * counting as free.
 */
import catalog from "@/tests/fixtures/models.json";
import type { LedgerEntry } from "@/lib/spec/stage-result";

const PRICES = new Map(
  catalog.models.flatMap((m) => {
    const p = m.pricing as { prompt?: string; completion?: string; input_cache_read?: string | null };
    const price = { prompt: Number(p.prompt), completion: Number(p.completion), cache_read: p.input_cache_read == null ? null : Number(p.input_cache_read) };
    return Number.isFinite(price.prompt) && Number.isFinite(price.completion) ? [[m.id, price] as const] : [];
  }),
);

export function usdOf(e: LedgerEntry): number | undefined {
  if (e.usd !== undefined) return e.usd;
  const p = PRICES.get(e.model);
  if (!p) return undefined;
  const cached = e.cached_tokens ?? 0;
  return (e.prompt_tokens - cached) * p.prompt + cached * (p.cache_read ?? p.prompt) + e.completion_tokens * p.completion;
}

/** Calls, priced total and how many calls had no price. */
export function costOf(ledger: LedgerEntry[] = []): { calls: number; usd: number; unpriced: number } {
  let usd = 0;
  let unpriced = 0;
  for (const e of ledger) {
    const u = usdOf(e);
    if (u === undefined) unpriced++;
    else usd += u;
  }
  return { calls: ledger.length, usd, unpriced };
}
