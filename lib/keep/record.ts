/**
 * What a session given for training keeps (#78): one record per step, sent by
 * the page (app/keep.ts) to /api/keep only once the person ticked the consent
 * box for a clip of their own. Shared by the page and the route; the samples
 * are never kept.
 */
import { z } from "zod";

export const CONSENT_LINE = "Clips you submit, with what the models made of them, may be kept and used to improve Understudy and to train models.";

/** clip: the proxy sent to the model; the others: a route's request and answer, or what the browser measured */
export const KEEP_KINDS = ["clip", "label", "compile", "answers", "ground", "rehearsal", "notes", "variants"] as const;
export type KeepKind = (typeof KEEP_KINDS)[number];

/** Vercel refuses bodies over 4.5 MB; the clip's proxy is under 4 MB (app/api/label/route.ts). */
export const MAX_RECORD_CHARS = 4_400_000;

export const KeepRequest = z.object({
  session: z.uuid(),
  consent: z.literal(true),
  kind: z.enum(KEEP_KINDS),
  data: z.unknown(),
});
export type KeepRequest = z.infer<typeof KeepRequest>;

/** what passes the spend guard is never kept, wherever it sits */
const SECRET_KEYS = new Set(["unlock", "sample_token"]);

export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => !SECRET_KEYS.has(k)).map(([k, v]) => [k, scrub(v)]));
  return value;
}
