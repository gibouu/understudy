"use client";

import { SETTING_NAMES, SETTINGS, type SettingName } from "@/lib/sim/settings";

/** What the stage draws around the arm: a setting, or the bare bench (null). */
export type Shown = SettingName | null;

/** The manual switch under a stage. `note` says what happens without a pick (the setting a pass brings). */
export function SettingSwitch({ shown, onPick, note }: { shown: Shown; onPick: (s: Shown) => void; note?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Setting">
      <span className="text-xs text-neutral-500">shown on</span>
      {[null, ...SETTINGS].map((s) => (
        <button key={s ?? "bench"} aria-pressed={shown === s} className={`rounded border px-3 py-1 ${shown === s ? "bg-neutral-900 text-white" : ""}`} onClick={() => onPick(s)}>
          {s ? SETTING_NAMES[s] : "the bench"}
        </button>
      ))}
      {note && <span className="text-xs text-neutral-500">{note}</span>}
    </div>
  );
}

/** The honesty line, under the stage's status chip whenever a setting is drawn. */
export function SettingNote({ shown }: { shown: Shown }) {
  if (!shown) return null;
  return <div className="max-w-[75%] rounded bg-white/85 px-2 py-1">The {SETTING_NAMES[shown]} is decoration; the rehearsal ran on the bench.</div>;
}
