/**
 * A ceiling on what live Token Factory calls cost in all, across every
 * function instance and deployment: UNDERSTUDY_BUDGET_USD, US$250 unless set,
 * for testing and judging. One running total in the store
 * (lib/store/redis.ts), in micro-dollars at list price (lib/providers/price.ts).
 *
 * Before every billed call, callModel (lib/providers/call.ts) reserves the
 * most the call can cost (its answer budget in full, its prompt over-counted)
 * with one atomic INCRBY; a reservation that would take the total past the
 * cap is given back and the call is not made. Once the call answers, the
 * reservation is settled to what it cost. So concurrent calls on any number
 * of instances cannot spend past the cap, and a call is never made unless
 * its cost is counted first: a settlement the store refuses leaves the
 * reservation, which over-counts. The spend guard (lib/unlock/check.ts) reads
 * the total too, so a spent budget replays a step and says why before any
 * call is tried.
 *
 * Without a store, a deployment (production or preview) cannot know what was
 * spent, so it makes no live call: the samples, the space showcase and the
 * 1-minute demo play their recordings and keep working. Locally, without a
 * store, every call goes through. Tavily is not counted: the cap is on Token
 * Factory only.
 */
import catalog from "@/tests/fixtures/models.json";
import { usdOf } from "@/lib/providers/price";
import type { LedgerEntry } from "@/lib/spec/stage-result";
import { command, hasStore } from "@/lib/store/redis";
import { deployed } from "./cap";

export const BUDGET_ENV = "UNDERSTUDY_BUDGET_USD";
export const DEFAULT_BUDGET_USD = 250;
export const SPENT_KEY = "understudy:budget:spent_microusd";

const MICRO = 1_000_000;
/** what a video part counts for in a reservation: a 2-minute proxy at 4 fps is under this many tokens */
export const VIDEO_TOKENS = 120_000;
/** a chat template's own tokens around the messages, over-counted */
const TEMPLATE_TOKENS = 1_000;
/**
 * The guard (lib/unlock/check.ts) counts the budget as spent once less than this is left: a request
 * makes a few reserved calls of a few cents each, so one that the guard lets through is not then
 * refused by a reservation halfway, and answers from its recording instead.
 */
export const MARGIN_USD = 0.5;

export type Budget =
  | { state: "open" }
  | { state: "left" | "spent"; cap_usd: number; spent_usd: number; left_usd: number }
  | { state: "unknown"; why: string };

export function budgetCap(): number {
  const n = Number(process.env[BUDGET_ENV]?.trim() || DEFAULT_BUDGET_USD);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BUDGET_USD;
}

const round = (usd: number) => Math.round(usd * 100) / 100;

/** What is left of the budget, reservations of calls under way counted; "unknown" when it cannot be read, which the guard treats as spent. */
export async function readBudget(): Promise<Budget> {
  if (!hasStore()) return deployed() ? { state: "unknown", why: "no store for the live budget on this deployment" } : { state: "open" };
  let raw: unknown;
  try {
    raw = await command(["GET", SPENT_KEY]);
  } catch (err) {
    console.error(`budget: the running total could not be read (${(err as Error).message})`);
    return { state: "unknown", why: "the live budget could not be read" };
  }
  const micro = raw === null ? 0 : Number(raw);
  if (!Number.isFinite(micro)) return { state: "unknown", why: "the live budget's total is not a number" };
  const cap = budgetCap();
  const spent = micro / MICRO;
  return { state: cap - spent < Math.min(MARGIN_USD, cap) || spent >= cap ? "spent" : "left", cap_usd: cap, spent_usd: round(spent), left_usd: round(Math.max(0, cap - spent)) };
}

/** the dearest list price per token, for a model the catalogue does not price: never counted as free */
const DEAREST = catalog.models.reduce(
  (worst, m) => {
    const p = m.pricing as { prompt?: string; completion?: string };
    return { prompt: Math.max(worst.prompt, Number(p.prompt) || 0), completion: Math.max(worst.completion, Number(p.completion) || 0) };
  },
  { prompt: 0, completion: 0 },
);

/** USD of one call at list price, or at the dearest price when its model has none. */
export const costOf = (e: LedgerEntry): number => e.usd ?? usdOf(e) ?? e.prompt_tokens * DEAREST.prompt + e.completion_tokens * DEAREST.completion;

const microOf = (e: LedgerEntry) => Math.max(0, Math.ceil(costOf(e) * MICRO));

/** At most what a prompt can count: a token per UTF-8 byte of text (a byte-level tokenizer never makes more), VIDEO_TOKENS per video part. */
export function promptTokensAtMost(messages: unknown): number {
  let tokens = TEMPLATE_TOKENS;
  const walk = (v: unknown): void => {
    if (typeof v === "string") tokens += Buffer.byteLength(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      if ((v as { type?: unknown }).type === "video_url") tokens += VIDEO_TOKENS;
      else Object.values(v).forEach(walk);
    }
  };
  walk(messages);
  return tokens;
}

/** A reservation for one call: settle it with what the call cost, or with nothing when it was not billed. */
export type Hold = { ok: true; micro: number } | { ok: false; why: "spent" | "unknown" };

const OPEN: Hold = { ok: true, micro: 0 };

/**
 * Reserves the most a call can cost, `attempts` times over (the SDK may send a request again after a
 * lost answer, and each may be billed); refused when that would pass the cap, or when the total cannot be counted.
 */
export async function reserve(model: string, promptTokens: number, maxTokens: number, attempts = 1): Promise<Hold> {
  if (!hasStore()) return deployed() ? { ok: false, why: "unknown" } : OPEN;
  const micro = attempts * microOf({ model, prompt_tokens: promptTokens, completion_tokens: maxTokens, seconds: 0 });
  let total: number;
  try {
    total = Number(await command(["INCRBY", SPENT_KEY, micro]));
  } catch (err) {
    console.error(`budget: no room could be reserved for a ${model} call (${(err as Error).message}), so it is not made`);
    return { ok: false, why: "unknown" };
  }
  if (total <= budgetCap() * MICRO) return { ok: true, micro };
  await giveBack(micro);
  return { ok: false, why: "spent" };
}

async function giveBack(micro: number) {
  try {
    await command(["DECRBY", SPENT_KEY, micro]);
  } catch (err) {
    // the total stays over-counted by this reservation, never under
    console.error(`budget: a reservation of ${micro} micro-USD was not given back (${(err as Error).message})`);
  }
}

/** Settles a reservation to what the call cost (`null`: not billed). Never throws; a refused settlement keeps the reservation counted. */
export async function settle(hold: Hold, e: LedgerEntry | null): Promise<void> {
  if (!hold.ok || !hasStore()) return;
  const delta = (e ? microOf(e) : 0) - hold.micro;
  if (delta === 0) return;
  try {
    await command(["INCRBY", SPENT_KEY, delta]);
  } catch (err) {
    console.error(`budget: a call's cost was not settled (${(err as Error).message}); its reservation of ${hold.micro} micro-USD stays counted`);
  }
}

