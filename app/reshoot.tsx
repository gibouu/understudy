"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { modelLabel } from "@/lib/providers/models";
import { evidence, subscribe, type Evidence } from "@/lib/reshoot/evidence";
import { CLASS_LABELS, finalOutcome, PAGE_WAIT_MS, type Reshoot as List } from "@/lib/reshoot/reshoot";
import type { Program, TaskSpec } from "@/lib/spec/schema";
import { failed, idle, running, type StageResult } from "@/lib/spec/stage-result";
import { gateNote } from "@/lib/unlock/messages";
import { liveAuth } from "./capture";
import { useModels } from "./models";
import { Working } from "./working";

/**
 * The reshoot list (issue #33), after the rehearsal and the patch loop: Ultra sorts what failed into
 * spec gaps, footage gaps, embodiment limits and simulator artefacts, each with evidence from the run,
 * lists what to film or ask again for the fields that came from the clip or the person, and the open
 * risks. Written from the last rehearsal of `program` in both worlds and the patches tried after it
 * (lib/reshoot/evidence.ts). The page waits at most 90 s for it.
 */
export function Reshoot({ spec, program }: { spec: TaskSpec; program: Program }) {
  const say = useModels();
  const seen = useSyncExternalStore(subscribe, evidence, () => null);
  const ev = seen?.program === program ? seen : null;
  const [result, setResult] = useState<StageResult<List>>(idle());
  const [since, setSince] = useState(0);
  /** the evidence the shown list was asked for: a newer rehearsal or patch makes it stale */
  const [askedFor, setAskedFor] = useState<Evidence | null>(null);
  const gen = useRef(0);

  if (!ev) return null;
  const stale = askedFor !== null && askedFor !== ev;

  async function ask(e: Evidence) {
    const id = ++gen.current;
    setAskedFor(e);
    setSince(Date.now());
    setResult(running());
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PAGE_WAIT_MS);
    let r: StageResult<List>;
    try {
      const res = await fetch("/api/reshoot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...liveAuth(), spec, program: e.program, runs: e.runs, patches: e.patches }),
        signal: ctrl.signal,
      });
      r = (await res.json()) as StageResult<List>;
    } catch (err) {
      r = failed(ctrl.signal.aborted ? `no answer within ${PAGE_WAIT_MS / 1000} s: the page went on without it` : (err as Error).message);
    } finally {
      clearTimeout(timer);
    }
    if (id === gen.current) setResult(r);
  }

  const list = result.status === "done" ? result.value : null;
  const replayed = result.status === "done" && result.warnings.some((w) => w.startsWith("replay")) ? (gateNote(result.warnings) ?? "replayed from a recording") : null;
  return (
    <section className="rounded-xl border p-5">
      <header className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="font-medium">Reshoot list</h2>
        <span className="truncate text-xs text-neutral-500">{list ? modelLabel(list.model) : say("ultra")}</span>
      </header>
      <p className="text-sm text-neutral-600">
        {say("ultra")} reads what the simulator measured{ev.patches.length ? ` and the ${ev.patches.length} patch${ev.patches.length > 1 ? "es" : ""} tried` : ""}, says why each failure happened (a gap in the spec, a gap in the footage, a limit of the arm, or the simulator itself), what to film or ask again for the fields that came from the clip or from your answers, and what this rehearsal does not cover.
      </p>
      <p className="mt-1 text-xs text-neutral-500">Written for: {finalOutcome(ev)}</p>
      <div className="mt-3">
        <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40" disabled={result.status === "running"} onClick={() => ask(ev)}>
          {list || result.status === "failed" ? "Ask again" : "Write the reshoot list"}
        </button>
        {stale && result.status !== "running" && <span className="ml-3 text-xs text-amber-700">The run changed since this list was written.</span>}
      </div>
      {result.status === "running" && (
        <div className="mt-3">
          <Working note={`${say("ultra")} is reading the rehearsal, to say what to reshoot`} since={since} usual={`under ${PAGE_WAIT_MS / 1000} s`} />
        </div>
      )}
      {result.status === "failed" && <p className="mt-3 text-sm text-red-700">{result.message}</p>}
      {list && (
        <div className="mt-4 flex flex-col gap-4 text-sm">
          {replayed && <p className="text-xs text-amber-700">{replayed}</p>}
          <div>
            <p className="font-medium">Why it failed</p>
            {list.failure_classes.length === 0 ? (
              <p className="text-neutral-600">No failure to classify.</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1.5">
                {list.failure_classes.map((c, i) => (
                  <li key={i}>
                    <span className="mr-2 rounded-full border px-2 py-0.5 text-xs">{CLASS_LABELS[c.class]}</span>
                    {c.evidence}
                    {c.fields.length > 0 && <span className="ml-1 font-mono text-xs text-neutral-500">({c.fields.join(", ")})</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="font-medium">Reshoot or ask again</p>
            {list.reshoot.length === 0 ? (
              <p className="text-neutral-600">Nothing that came from the clip or from your answers needs another take.</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-2">
                {list.reshoot.map((r) => (
                  <li key={r.field}>
                    <p>
                      <span className="font-mono text-xs">{r.field}</span>{" "}
                      <span className="text-xs text-neutral-500">
                        {r.origin === "video" ? "from the clip" : "from your answer"} ({r.source})
                      </span>
                    </p>
                    <p>{r.ask}</p>
                    <p className="text-neutral-600">{r.why}</p>
                  </li>
                ))}
              </ul>
            )}
            {list.dropped.length > 0 && <p className="mt-1 text-xs text-neutral-500">Left out, as not from the clip or an answer: {list.dropped.join("; ")}.</p>}
          </div>
          {list.open_risks.length > 0 && (
            <div>
              <p className="font-medium">Open risks</p>
              <ul className="mt-1 list-disc pl-5">
                {list.open_risks.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-neutral-500">
            {modelLabel(list.model)}, thinking {list.thinking ? "on" : "off"} · {list.tokens.toLocaleString()} tokens · ${list.cost_usd.toFixed(4)}
          </p>
        </div>
      )}
    </section>
  );
}
