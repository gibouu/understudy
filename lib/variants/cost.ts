/**
 * What a section's model calls cost, at the list prices of
 * lib/providers/price.ts. A model missing from the catalogue stays unpriced
 * instead of counting as free.
 */
import { usdOf } from "@/lib/providers/price";
import type { LedgerEntry } from "@/lib/spec/stage-result";

/** Calls, priced total and how many calls had no price. */
export function costOf(ledger: LedgerEntry[] = []): { calls: number; usd: number; unpriced: number } {
  let usd = 0;
  let unpriced = 0;
  for (const e of ledger) {
    const u = e.usd ?? usdOf(e);
    if (u === undefined) unpriced++;
    else usd += u;
  }
  return { calls: ledger.length, usd, unpriced };
}
