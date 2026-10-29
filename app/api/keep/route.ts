/**
 * POST /api/keep {session, consent: true, kind, data}: keeps one record of a
 * session the person gave for training, with the consent box ticked on /try
 * (lib/keep/record.ts). Calls no model and spends nothing. Without a store, or
 * with it full or unreachable, nothing is kept and the page carries on. The
 * count of records per minute bounds this function instance only, as the live
 * cap does (lib/unlock/cap.ts).
 */
import { NextResponse } from "next/server";
import { KeepRequest } from "@/lib/keep/record";
import { keepRecord, type Kept } from "@/lib/keep/store";
import { hasStore } from "@/lib/store/redis";

export const maxDuration = 15;

const KEEPS_PER_MINUTE = 60;
const recent: number[] = [];

export async function POST(req: Request): Promise<NextResponse<Kept>> {
  const parsed = KeepRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ kept: false, why: "not a record with consent" }, { status: 400 });
  if (!hasStore()) return NextResponse.json({ kept: false, why: "no store on this deployment" });
  const now = Date.now();
  while (recent.length && now - recent[0] >= 60_000) recent.shift();
  if (recent.length >= KEEPS_PER_MINUTE) return NextResponse.json({ kept: false, why: "too many records this minute" }, { status: 429 });
  recent.push(now);
  try {
    return NextResponse.json(await keepRecord(parsed.data, now));
  } catch (err) {
    console.error(`keep: a ${parsed.data.kind} record was not kept (${(err as Error).message})`);
    return NextResponse.json({ kept: false, why: "the store did not answer" });
  }
}
