"use client";

import { useState } from "react";
import { applyChanges } from "@/lib/spec/apply";
import { chipChange, chipEffect, type Chip, type Grounding } from "@/lib/spec/ground";
import type { TaskSpec } from "@/lib/spec/schema";
import { failed, idle, running, type LedgerEntry, type StageResult } from "@/lib/spec/stage-result";
import { gateNote } from "@/lib/unlock/messages";
import { liveAuth } from "./capture";

/**
 * app/globals.css defines these with the landing page (#90). Until then the
 * page's own colours stand in, mixed toward the text colour so small text
 * keeps 4.5:1 contrast in light and dark mode.
 */
const PAPER = "var(--paper, var(--background))";
const INK = "var(--ink, var(--foreground))";
const ACCENT = "var(--accent, color-mix(in srgb, #c2410c 75%, var(--foreground)))";
const MUTED = "var(--muted, color-mix(in srgb, var(--foreground) 62%, var(--background)))";

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * Opt-in grounding: one click searches the web (Tavily), and each sentence
 * Nano kept comes back as a chip with its source. Nothing enters the spec
 * until the person adds a chip; `onSpec` then receives the changed spec.
 */
export function GroundChips({ spec, busy, onSpec }: { spec: TaskSpec; busy: boolean; onSpec: (next: TaskSpec) => void }) {
  const [result, setResult] = useState<StageResult<Grounding>>(idle());
  const [added, setAdded] = useState<number[]>([]);
  const [note, setNote] = useState("");

  async function look() {
    setResult(running("Tavily is searching and reading the top pages; Nano keeps the sentences that name this task"));
    try {
      const res = await fetch("/api/ground", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spec, ...liveAuth() }) });
      setResult((await res.json()) as StageResult<Grounding>);
    } catch (err) {
      setResult(failed((err as Error).message));
    }
  }

  function accept(i: number, chip: Chip) {
    const { spec: next, warnings } = applyChanges(spec, [chipChange(spec, chip)]);
    if (warnings.length) {
      setNote(warnings.join("; "));
      return;
    }
    setNote("");
    setAdded([...added, i]);
    onSpec(next);
  }

  return (
    <section className="rounded-xl border p-5" style={{ background: PAPER, color: INK }}>
      <header className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="font-medium">What the web says</h2>
        <span className="truncate text-xs" style={{ color: MUTED }}>
          Tavily · Nemotron 3 Nano
        </span>
      </header>

      {result.status === "idle" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm" style={{ color: MUTED }}>
            Optional. Searches the web for what to watch out for with these objects and keeps only the sentences that name them, each
            with its source. Nothing enters the spec unless you add it. The search sends the task&apos;s title and object names to Tavily.
          </p>
          <div>
            <button className="rounded px-3 py-1.5 text-sm" style={{ background: INK, color: PAPER }} onClick={look}>
              Look it up
            </button>
          </div>
        </div>
      )}

      {result.status === "running" && (
        <p className="animate-pulse text-sm" style={{ color: MUTED }}>
          {result.note}…
        </p>
      )}

      {result.status === "failed" && (
        <div className="flex items-baseline gap-3 text-sm">
          <p style={{ color: MUTED }}>Nothing from the web this time ({result.message}).</p>
          <button className="text-xs underline" style={{ color: MUTED }} onClick={look}>
            try again
          </button>
        </div>
      )}

      {result.status === "done" && (
        <div className="flex flex-col gap-3">
          {result.warnings.some((w) => w.startsWith("replay")) && (
            <p className="text-xs" style={{ color: ACCENT }}>
              {gateNote(result.warnings) ?? "replayed from a recording"}
            </p>
          )}
          {result.value.chips.length === 0 ? (
            <div className="flex items-baseline gap-3 text-sm">
              <p style={{ color: MUTED }}>No chips this time: {result.warnings.at(-1) ?? "Nano kept no sentence"}.</p>
              <button className="text-xs underline" style={{ color: MUTED }} onClick={look}>
                try again
              </button>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {result.value.chips.map((chip, i) => {
                const done = added.includes(i);
                return (
                  <li key={`${chip.url}#${i}`} className="flex flex-col gap-2 rounded-lg border p-3" style={done ? { borderColor: ACCENT } : undefined}>
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="uppercase tracking-wide" style={{ color: ACCENT }}>
                        {chip.kind}
                      </span>
                      <a href={chip.url} target="_blank" rel="noreferrer" className="truncate underline" style={{ color: MUTED }} title={chip.title || chip.url}>
                        {host(chip.url)}
                      </a>
                    </div>
                    <blockquote className="text-sm">&ldquo;{chip.text}&rdquo;</blockquote>
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        className="rounded border px-2.5 py-1 text-xs disabled:opacity-50"
                        style={done ? { borderColor: ACCENT, color: ACCENT } : { borderColor: INK }}
                        disabled={done || busy}
                        onClick={() => accept(i, chip)}
                      >
                        {done ? "Added" : "Add to spec"}
                      </button>
                      <span className="text-xs" style={{ color: MUTED }}>
                        {chipEffect(spec, chip)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {note && <p className="text-sm text-red-700">{note}</p>}
          <Spend ledger={result.ledger} query={result.value.query} warnings={result.warnings} />
        </div>
      )}
    </section>
  );
}

/** The calls behind the chips: Tavily's request ids and credits, Nano's tokens, and what the route noted. */
function Spend({ ledger = [], query, warnings }: { ledger?: LedgerEntry[]; query: string; warnings: string[] }) {
  const tavily = ledger.filter((e) => e.model.startsWith("tavily/"));
  const credits = tavily.reduce((n, e) => n + (e.credits ?? 0), 0);
  const tokens = ledger.filter((e) => !e.model.startsWith("tavily/")).reduce((n, e) => n + e.prompt_tokens + e.completion_tokens, 0);
  const notes = warnings.filter((w) => !w.startsWith("replay"));
  return (
    <details className="text-xs" style={{ color: MUTED }}>
      <summary className="cursor-pointer">
        {tavily.length ? `${tavily.length} Tavily call${tavily.length > 1 ? "s" : ""}, ${credits} credit${credits === 1 ? "" : "s"}` : "no Tavily call"}
        {tokens ? ` · Nano ${tokens} tokens` : ""}
      </summary>
      <div className="mt-2 flex flex-col gap-1 font-mono text-[11px]">
        <p>query: {query}</p>
        {tavily.map((e) => (
          <p key={e.request_id ?? e.model}>
            {e.model} · request {e.request_id ?? "?"} · {e.credits ?? "?"} credit{e.credits === 1 ? "" : "s"} · {e.seconds.toFixed(1)} s
          </p>
        ))}
        {notes.map((w) => (
          <p key={w}>{w}</p>
        ))}
      </div>
    </details>
  );
}
