/**
 * List prices per token from tests/fixtures/models.json (GET /v1/models?verbose=true,
 * fetched by hand), so a route can say what a call cost. A model missing from the
 * catalogue is left unpriced rather than charged $0.
 */
import catalog from "@/tests/fixtures/models.json";
import type { LedgerEntry } from "@/lib/spec/stage-result";

type Price = { prompt: number; completion: number; cache_read: number | null };

const PRICES = new Map<string, Price>(
  catalog.models.flatMap((m) => {
    const p = m.pricing as { prompt?: string; completion?: string; input_cache_read?: string | null };
    const price = { prompt: Number(p.prompt), completion: Number(p.completion), cache_read: p.input_cache_read == null ? null : Number(p.input_cache_read) };
    return Number.isFinite(price.prompt) && Number.isFinite(price.completion) ? [[m.id, price] as const] : [];
  }),
);

/** USD of one call at list prices, the formula of scripts/bench-ledger.mjs costOf(). */
export function usdOf(e: LedgerEntry): number | undefined {
  const p = PRICES.get(e.model);
  if (!p) return undefined;
  const cached = e.cached_tokens ?? 0;
  return (e.prompt_tokens - cached) * p.prompt + cached * (p.cache_read ?? p.prompt) + e.completion_tokens * p.completion;
}

export const priced = (ledger: LedgerEntry[]): LedgerEntry[] => ledger.map((e) => ({ ...e, usd: e.usd ?? usdOf(e) }));
