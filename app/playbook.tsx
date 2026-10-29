"use client";

import { DEFAULT_ON, kindsOf, matchRules, PLAYBOOK, type SeenFailure } from "@/lib/spec/playbook";
import type { TaskSpec } from "@/lib/spec/schema";
import type { Failure } from "./program-view";

/** The switch and the rules left on; off until the person turns it on. */
export type PlaybookState = { on: boolean; rules: string[] };
export const PLAYBOOK_OFF: PlaybookState = { on: false, rules: [...DEFAULT_ON] };

/** The failure of the last rehearsal on screen, as the playbook names it: a check that did not hold has no class. */
const seen = (f: Failure | null): SeenFailure | undefined => (f ? (f.failure_class ?? "check_failed") : undefined);

/**
 * What /api/compile gets for the playbook: undefined with the switch off or no rule that matches, so the
 * request is the one from before the playbook (tests/spec/playbook-off.test.ts).
 */
export function playbookAsk(state: PlaybookState, spec: TaskSpec, failure: Failure | null): { rules: string[]; failure?: SeenFailure } | undefined {
  if (!state.on) return undefined;
  const rules = matchRules(spec, state.rules, seen(failure)).map((r) => r.id);
  if (!rules.length) return undefined;
  const f = seen(failure);
  return f ? { rules, failure: f } : { rules };
}

/** The switch, and every rule with its evidence; a rule for another kind of task is shown greyed, and never sent. */
export function Playbook({ spec, state, failure, busy, onChange, onRecompile }: { spec: TaskSpec; state: PlaybookState; failure: Failure | null; busy: boolean; onChange: (s: PlaybookState, recompile: boolean) => void; onRecompile: () => void }) {
  const kinds = kindsOf(spec);
  const sent = new Set(state.on ? matchRules(spec, state.rules, seen(failure)).map((r) => r.id) : []);
  return (
    <section className="rounded-xl border p-5" aria-label="Playbook">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={state.on} disabled={busy} onChange={(e) => onChange({ ...state, on: e.target.checked }, true)} />
        Use the playbook
      </label>
      <p className="mt-1 text-xs text-neutral-500">
        Rules kept from Notes patches that fixed a failed rehearsal of another clip, and two the bench distilled. Each is text with its evidence, not a trained weight; a rule goes to the compiler only for its own kind of task{failure ? ", and only for the failure of the last rehearsal" : ""}. Measured on four NASA pocket clips, they do not carry over: with the rules learned on the other clips the first program passed at 1 g and 0 g in 0 of 32 compiles, against 6 of 32 for the same request with its rules taken out (docs/MEASUREMENTS.md, section 8).
      </p>
      {state.on && (
        <>
          <ul className="mt-3 flex flex-col gap-2">
            {PLAYBOOK.map((r) => {
              const mine = kinds.has(r.fixture);
              return (
                <li key={r.id} className={`rounded border p-2 text-xs ${mine ? "" : "opacity-50"}`}>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={state.rules.includes(r.id)}
                      disabled={busy}
                      onChange={(e) => onChange({ ...state, rules: e.target.checked ? [...state.rules, r.id] : state.rules.filter((x) => x !== r.id) }, false)}
                    />
                    <span>
                      <span className="font-mono">playbook#{r.id}</span> · {r.fixture} · {r.failure_class.replace("_", " ")}
                      {r.axis ? ` · ${r.axis}` : ""}
                      {sent.has(r.id) ? <span className="ml-1 text-emerald-700">sent with this spec</span> : !mine ? <span className="ml-1">not for this kind of task</span> : null}
                      <span className="block text-neutral-700">
                        When {r.condition}: {r.hint}.
                      </span>
                      <span className="block text-neutral-500">
                        Learned on {r.evidence.clip} ({r.source}): {r.evidence.change}. Before: {r.evidence.before}. After: {r.evidence.after}.
                      </span>
                      {r.note && <span className="block text-amber-700">Off by default: {r.note}.</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <button className="mt-3 rounded border px-3 py-1.5 text-sm disabled:opacity-40" disabled={busy} onClick={onRecompile}>
            Recompile with these rules
          </button>
        </>
      )}
    </section>
  );
}
