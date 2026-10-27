/**
 * Playing a recording on /try (app/flow.tsx): the compile Nano gave for
 * exactly this spec, the answers given to its asks, and the line that says
 * when the clip was recorded and by which model. A spec the recording never
 * saw finds nothing here, and the page asks the live route. Nothing here
 * reads files, so the page can use it.
 */
import { modelLabel } from "@/lib/providers/models";
import { formFor } from "@/lib/spec/answer";
import type { TaskSpec } from "@/lib/spec/schema";
import type { Call, Session, Turn } from "./session";

/** What a route answer says when it came from a recording; it starts with "replay", so every reader treats it as replayed. */
export const RECORDED = "replay: recorded on ";

/** JSON with sorted keys: two specs built with their fields in another order are still the same spec. */
export function canonical(x: unknown): string {
  return JSON.stringify(x, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
}

export const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** The recorded compile of exactly this spec: turns[i] was compiled from iterations[i].spec (lib/showcase/record.ts). */
export function turnFor(session: Session, spec: TaskSpec): Turn | null {
  const i = session.turns.findIndex((_, k) => same(session.iterations[k]?.spec, spec));
  return i < 0 ? null : session.turns[i];
}

/** The recorded answers to a turn's asks, as the flow's form holds them: a number as typed, a success check by its option's index. */
export function formAnswers(spec: TaskSpec, turn: Turn): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of turn.answers) {
    const form = formFor(spec, a.slot);
    if (form.kind === "number") out[a.slot] = String(a.change.value);
    if (form.kind === "success") {
      const i = form.options.findIndex((o) => same(o.predicates, a.change.value));
      if (i >= 0) out[a.slot] = String(i);
    }
  }
  return out;
}

/** "27 Oct 2026", in UTC so the server and the page say the same day. */
export const recordedDay = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** The route answer's first warning: "replay: recorded on 27 Oct 2026, Nemotron 3 Nano", naming the models that answered that stage. */
export function recordedNote(rec: { recorded_at: string; ledger: Call[] }, stage: Call["stage"]): string {
  const by = recordedBy(rec, stage);
  return `${RECORDED}${recordedDay(rec.recorded_at)}${by ? `, ${by}` : ""}`;
}

/** The models a recording's stage was answered by, "Nemotron 3 Nano"; undefined when no model answered it (a gesture's program). */
export function recordedBy(rec: { ledger: Call[] }, stage: Call["stage"]): string | undefined {
  const models = [...new Set(rec.ledger.filter((c) => c.stage === stage).map((c) => modelLabel(c.model)))];
  return models.length ? models.join(" · ") : undefined;
}

/** The note in words for the page, without its "replay: " prefix; undefined when the answer was not recorded. */
export const recordedLine = (warnings: string[]) => warnings.find((w) => w.startsWith(RECORDED))?.slice("replay: ".length);
