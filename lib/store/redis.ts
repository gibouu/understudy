/**
 * The one store the app has: an Upstash for Redis database on its free plan
 * (Vercel Marketplace, auto-upgrade and eviction off), over Upstash's REST API
 * with plain fetch, no SDK. It holds the running total of live spend
 * (lib/unlock/budget.ts) and the sessions people agreed to give
 * (lib/keep/store.ts). The integration sets KV_REST_API_URL and
 * KV_REST_API_TOKEN; UPSTASH_REDIS_REST_* work as well.
 */
export type Command = (string | number)[];

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

function where(): { url: string; token: string } | null {
  // a blank variable (a copied .env.example) is no setting
  const url = process.env.KV_REST_API_URL?.trim() || process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.KV_REST_API_TOKEN?.trim() || process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

export const hasStore = () => where() !== null;

/** Runs the commands in one request, in order; any command's error fails them all. The token is never in a message. */
export async function pipeline(commands: Command[], timeoutMs = 3_000): Promise<unknown[]> {
  const at = where();
  if (!at) throw new StoreError("no store configured");
  let res: Response;
  try {
    res = await fetch(`${at.url}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${at.token}`, "content-type": "application/json" },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    const name = (err as Error).name;
    throw new StoreError(`store: ${name === "AbortError" || name === "TimeoutError" ? "timed out" : "network error"}`);
  }
  if (!res.ok) throw new StoreError(`store: HTTP ${res.status}`);
  const out = (await res.json().catch(() => null)) as { result?: unknown; error?: string }[] | null;
  if (!Array.isArray(out) || out.length !== commands.length) throw new StoreError("store: an answer that is not one result per command");
  const error = out.find((r) => r?.error !== undefined)?.error;
  if (error !== undefined) throw new StoreError(`store: ${String(error).slice(0, 120)}`);
  return out.map((r) => r.result);
}

export const command = async (c: Command, timeoutMs?: number) => (await pipeline([c], timeoutMs))[0];
