/**
 * Tavily over two plain POSTs, no SDK: `search` at basic depth (1 credit) and
 * `extract` at basic depth (1 credit per 5 URLs that succeed). Both send
 * `include_usage`, so every call returns the credits it cost and a request id,
 * and each becomes one ledger entry next to the Nemotron calls. The key never
 * leaves the Authorization header; errors carry the HTTP status only.
 */
import type { LedgerEntry } from "@/lib/spec/stage-result";

export const TAVILY_BASE_URL = "https://api.tavily.com";

export function hasTavilyKey(): boolean {
  return Boolean(process.env.TAVILY_API_KEY);
}

export class TavilyError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "TavilyError";
  }
}

export type SearchHit = { url: string; title: string; content: string; score: number };
export type Page = { url: string; content: string };

type Reply = Record<string, unknown> & { usage?: { credits?: unknown }; request_id?: unknown };

async function call(endpoint: "search" | "extract", body: Record<string, unknown>, signal?: AbortSignal): Promise<{ data: Reply; entry: LedgerEntry }> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new TavilyError("no TAVILY_API_KEY");
  const started = Date.now();
  const res = await fetch(`${TAVILY_BASE_URL}/${endpoint}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body, include_usage: true }),
    signal,
  });
  if (!res.ok) throw new TavilyError(`tavily ${endpoint}: HTTP ${res.status}`, res.status);
  const data = (await res.json()) as Reply;
  const credits = data.usage?.credits;
  return {
    data,
    entry: {
      model: `tavily/${endpoint}`,
      prompt_tokens: 0,
      completion_tokens: 0,
      seconds: (Date.now() - started) / 1000,
      credits: typeof credits === "number" ? credits : undefined,
      request_id: typeof data.request_id === "string" ? data.request_id : undefined,
    },
  };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Basic search: results sorted by relevance, each with a snippet in `content`. */
export async function search(query: string, o: { maxResults: number; excludeDomains?: string[]; signal?: AbortSignal }): Promise<{ hits: SearchHit[]; entry: LedgerEntry }> {
  const body = { query, search_depth: "basic", max_results: o.maxResults, ...(o.excludeDomains?.length ? { exclude_domains: o.excludeDomains } : {}) };
  const { data, entry } = await call("search", body, o.signal);
  const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
  const hits = results
    .filter((r) => /^https?:\/\//.test(str(r.url)))
    .map((r) => ({ url: str(r.url), title: str(r.title), content: str(r.content), score: typeof r.score === "number" ? r.score : 0 }));
  return { hits, entry };
}

/**
 * Basic extract of a few URLs. With `query`, Tavily returns only the
 * `chunksPerSource` passages of each page that match it, not the whole page.
 * `timeoutS` is Tavily's own deadline (1 to 60 s). A URL it could not read is
 * listed in `failed`, even on a 200.
 */
export async function extract(
  urls: string[],
  o: { query?: string; chunksPerSource?: number; timeoutS?: number; signal?: AbortSignal },
): Promise<{ pages: Page[]; failed: string[]; entry: LedgerEntry }> {
  const body: Record<string, unknown> = { urls, extract_depth: "basic", format: "markdown" };
  if (o.query) Object.assign(body, { query: o.query, chunks_per_source: o.chunksPerSource ?? 3 });
  if (o.timeoutS !== undefined) body.timeout = Math.min(60, Math.max(1, Math.round(o.timeoutS * 10) / 10));
  const { data, entry } = await call("extract", body, o.signal);
  const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
  const failed = Array.isArray(data.failed_results) ? (data.failed_results as Record<string, unknown>[]).map((r) => str(r.url)) : [];
  return { pages: results.map((r) => ({ url: str(r.url), content: str(r.raw_content) })).filter((p) => p.url && p.content), failed, entry };
}
