/**
 * The page's side of a session given for training (#78): a random session id,
 * made when a clip of your own is chosen with the consent box ticked, and the
 * records sent to /api/keep under it. No box, a sample, or a new clip without
 * the box: no id, and nothing is sent. A record carries the id that was
 * current when its request began, and is dropped when that is no longer the
 * current one (the box unticked, another clip chosen). A record that is not
 * kept never stops the flow.
 */
import type { StageResult } from "@/lib/spec/stage-result";
import type { KeepKind } from "@/lib/keep/record";

let session: string | undefined;

/** A new clip: a fresh id when the person consented and the clip is their own, none otherwise. */
export function startSession(consented: boolean): string | undefined {
  session = consented ? crypto.randomUUID() : undefined;
  return session;
}

/** The id records are kept under now; a request takes it as it begins. */
export const keeping = () => session;

/** `at`: the id the step began under (keeping() then); nothing is sent unless it is still the current one. */
export function keep(kind: KeepKind, data: unknown, at: string | undefined): void {
  if (!at || at !== session) return;
  void fetch("/api/keep", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: at, consent: true, kind, data }) }).catch(() => {});
}

const ROUTES: Record<string, KeepKind> = { "/api/label": "label", "/api/compile": "compile", "/api/ground": "ground", "/api/notes": "notes", "/api/variants": "variants" };

/** One model route's request and answer; a label's video goes in a record of its own, the clip. */
export function keepCall(url: string, body: unknown, result: StageResult<unknown>, at: string | undefined): void {
  const kind = ROUTES[url];
  if (!at || at !== session || !kind) return;
  const { video, ...request } = (body ?? {}) as { video?: unknown };
  if (typeof video === "string") keep("clip", { clip_sha256: (request as { clip_sha256?: string }).clip_sha256, video }, at);
  keep(kind, { request, result }, at);
}
