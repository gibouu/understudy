/**
 * Keeps a record of a session given for training (lib/keep/record.ts) in the
 * store (lib/store/redis.ts): appended to the session's list, the session
 * listed with the time it was first seen. The store is Upstash's free plan
 * (256 MB, eviction off), shared with the live budget's total, so what is kept
 * stops at KEEP_MAX_BYTES, each record counted with RECORD_OVERHEAD for its
 * keys and Redis's own bookkeeping, and the budget always has room to count.
 */
import { pipeline } from "@/lib/store/redis";
import { MAX_RECORD_CHARS, scrub, type KeepRequest } from "./record";

export const KEEP_PREFIX = "understudy:keep";
export const SESSIONS_KEY = `${KEEP_PREFIX}:sessions`;
export const BYTES_KEY = `${KEEP_PREFIX}:bytes`;
export const KEEP_MAX_BYTES = 120 * 1024 * 1024;
/** more than a list entry, a new list key and a sorted-set member take in Redis */
export const RECORD_OVERHEAD = 512;

export type Kept = { kept: true } | { kept: false; why: string };

export async function keepRecord(r: KeepRequest, now = Date.now()): Promise<Kept> {
  const line = JSON.stringify({ kind: r.kind, at: new Date(now).toISOString(), data: scrub(r.data) });
  if (line.length > MAX_RECORD_CHARS) return { kept: false, why: "the record is too large" };
  const bytes = Buffer.byteLength(line) + RECORD_OVERHEAD;
  // the room is taken first, atomically, and given back when it is not there
  const [total] = (await pipeline([["INCRBY", BYTES_KEY, bytes]])) as number[];
  if (total > KEEP_MAX_BYTES) {
    await pipeline([["DECRBY", BYTES_KEY, bytes]]);
    return { kept: false, why: "the store for kept sessions is full" };
  }
  await pipeline([
    ["RPUSH", `${KEEP_PREFIX}:${r.session}`, line],
    ["ZADD", SESSIONS_KEY, "NX", now, r.session],
  ]);
  return { kept: true };
}
