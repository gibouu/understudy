"use client";

import { formFor, type Ask } from "@/lib/spec/answer";
import type { TaskSpec } from "@/lib/spec/schema";

/** One ask as a form field (lib/spec/answer.ts formFor): a number, a choice of checks, or chips for where it goes. */
export function AskField({ ask, spec, value, onChange }: { ask: Ask; spec: TaskSpec; value: string; onChange: (v: string) => void }) {
  const form = formFor(spec, ask.slot);
  // chips are buttons: inside a label, clicking the question would press the first one
  const Root = form.kind === "target" ? "div" : "label";
  return (
    <Root className="flex flex-col gap-1 text-sm" {...(form.kind === "target" ? { role: "group", "aria-label": ask.question } : {})}>
      <span>{ask.question}</span>
      {ask.why && <span className="text-xs text-neutral-500">{ask.why}</span>}
      {form.kind === "number" && (
        <span className="flex items-center gap-2">
          <input type="number" min={0} step="any" value={value} onChange={(e) => onChange(e.target.value)} className="w-28 rounded border px-2 py-1" />
          {form.unit}
        </span>
      )}
      {form.kind === "success" && (
        <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded border px-2 py-1">
          <option value="">choose…</option>
          {form.options.map((o, i) => (
            <option key={o.label} value={i}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {form.kind === "target" && (
        <span className="flex flex-wrap gap-2">
          {form.options.map((o, i) => (
            <button key={o.target.frame} type="button" aria-pressed={value === String(i)} onClick={() => onChange(String(i))} className={`rounded-full border px-3 py-1 ${value === String(i) ? "border-neutral-900 bg-neutral-900 text-white" : "hover:bg-neutral-50"}`}>
              {o.label}
            </button>
          ))}
        </span>
      )}
      {form.kind === "unsupported" && <span className="text-xs text-amber-700">This one can&apos;t be answered here yet ({ask.slot}).</span>}
    </Root>
  );
}
