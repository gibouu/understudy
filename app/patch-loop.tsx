"use client";

import { useEffect, useRef, useState } from "react";
import { outcomeLine, type WorldRun } from "@/lib/notes/note";
import { MAX_PATCHES, type Attempt, type NotePatch } from "@/lib/notes/patch";
import { GRAVITIES, type Program, type TaskSpec } from "@/lib/spec/schema";
import { failed, type StageResult } from "@/lib/spec/stage-result";
import { usual } from "@/lib/estimate";
import { gateNote } from "@/lib/unlock/messages";
import { liveAuth } from "./capture";
import { Working } from "./working";

/** `replayed`: what the patch line says when it came from a recording, the spend guard's reason when that is why */
type Iteration = { n: number; state: "asking" | "rehearsing" | "done" | "failed"; at: number; patch?: NotePatch; replayed?: string; runs?: WorldRun[]; message?: string };

const WHY_THINKING = { noop: "thinking on: the cheap patch changed nothing", two_failed: "thinking on: two patches failed" } as const;

/**
 * The Notes stage: Super reads what the simulator measured in the failed rehearsal and changes the
 * numbers of the failing step; each patch is rehearsed again in every world, at most MAX_PATCHES
 * times, until the program passes everywhere. `rehearse` runs one program in the page's stage.
 * Keyed by the rehearsal it patches, so a new one starts from scratch.
 */
export function PatchLoop({ spec, program, first, rehearse, onBusy, onPatch, disabled = false }: { spec: TaskSpec; program: Program; first: WorldRun[]; rehearse: (p: Program) => Promise<WorldRun[]>; onBusy: (busy: boolean) => void; onPatch?: (r: StageResult<NotePatch>) => void; disabled?: boolean }) {
  const [its, setIts] = useState<Iteration[]>([]);
  const [busy, setBusy] = useState(false);
  /** bumped on unmount (a new rehearsal or program mounts a fresh loop): a reply for an old one is dropped */
  const gen = useRef(0);

  useEffect(
    () => () => {
      gen.current++;
      onBusy(false);
    },
    [onBusy],
  );

  async function patch() {
    const id = ++gen.current;
    const update = (n: number, it: Partial<Iteration>) => setIts((xs) => xs.map((x) => (x.n === n ? { ...x, ...it } : x)));
    setBusy(true);
    onBusy(true);
    setIts([]);
    const history: Attempt[] = [];
    let current = program;
    let last = first;
    for (let n = 1; n <= MAX_PATCHES; n++) {
      setIts((xs) => [...xs, { n, state: "asking", at: Date.now() }]);
      const r = await post<NotePatch>("/api/notes", { spec, program: current, runs: last, first: outcomeLine(first), history });
      if (id !== gen.current) return;
      onPatch?.(r);
      if (r.status !== "done") {
        update(n, { state: "failed", message: r.status === "failed" ? r.message : "no answer" });
        break;
      }
      const p = r.value;
      update(n, { state: "rehearsing", at: Date.now(), patch: p, replayed: r.warnings.some((w) => w.startsWith("replay")) ? (gateNote(r.warnings) ?? "replayed from a recording") : undefined });
      let runs: WorldRun[];
      try {
        runs = p.noop ? last : await rehearse(p.program);
      } catch (err) {
        if (id === gen.current) update(n, { state: "failed", message: (err as Error).message });
        break;
      }
      if (id !== gen.current) return;
      update(n, { state: "done", runs });
      history.push({ set: p.set, thinking: p.thinking, clamps: p.clamps, rejected: p.rejected, outcome: outcomeLine(runs) });
      current = p.program;
      last = runs;
      if (runs.every((w) => w.rollout.pass)) break;
    }
    setBusy(false);
    onBusy(false);
  }

  const passed = its.find((x) => x.state === "done" && x.runs?.every((w) => w.rollout.pass));
  const spent = its.reduce((usd, x) => usd + (x.patch?.cost_usd ?? 0), 0);
  return (
    <div className="mt-2 flex flex-col gap-3 border-t pt-4">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-sm font-medium">Notes: patch the failing step</p>
        <span className="truncate text-xs text-neutral-500">Nemotron 3 Super</span>
      </div>
      <p className="text-sm text-neutral-600">
        Super reads what the simulator measured and changes the numbers of the step that failed. Each patch is rehearsed again on Earth and in orbit, up to {MAX_PATCHES} times. It thinks only when the cheap answer gets stuck.
      </p>
      <div>
        <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40" disabled={busy || disabled} onClick={patch}>
          {its.length ? "Patch again from the compiled program" : "Patch it"}
        </button>
      </div>
      {its.length > 0 && (
        <ol className="flex flex-col gap-2 text-sm">
          {its.map((x) => (
            <li key={x.n} className={`rounded-lg border p-3 ${x === passed ? "border-emerald-500/60 bg-emerald-500/10" : ""}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">Patch {x.n}</span>
                {x.patch && (
                  <span className="text-xs text-neutral-500">
                    {x.patch.thinking ? (x.patch.escalation ? WHY_THINKING[x.patch.escalation] : "thinking on") : "thinking off"} · {x.patch.tokens.toLocaleString()} tokens · ${x.patch.cost_usd.toFixed(4)}
                    {x.replayed ? ` · ${x.replayed}` : ""}
                  </span>
                )}
              </div>
              {x.state === "asking" && <Working note="Nemotron 3 Super is reading what the simulator measured, to change the numbers of the step that failed" since={x.at} usual={usual("notes", null)} />}
              {x.state === "failed" && <p className="text-red-700">{x.message}</p>}
              {x.patch && (
                <div className="mt-1 flex flex-col gap-1">
                  <p className="font-mono text-xs">
                    {x.patch.noop ? "no change" : x.patch.changes.map((c) => `${c.name}: ${c.from} → ${c.to}`).join(", ")}
                    {x.patch.clamps.map((c) => ` (${c.name} ${c.requested} clamped to ${c.applied})`).join("")}
                    {x.patch.rejected.length > 0 && ` (not applied: ${x.patch.rejected.join(", ")})`}
                  </p>
                  {x.patch.why && <p className="text-neutral-600">{x.patch.why}</p>}
                </div>
              )}
              {x.state === "rehearsing" && <Working note="Rehearsing the patch on Earth, then in orbit, in your browser" since={x.at} />}
              {x.runs && (
                <ul className="mt-1 flex flex-col gap-0.5 text-xs">
                  {x.runs.map(({ world, rollout: r }) => (
                    <li key={world}>
                      {world} · {GRAVITIES[world]} g: {r.pass ? <span className="font-medium text-emerald-700">pass</span> : <span className="font-medium text-red-700">fail{r.failed_step_id ? ` at ${r.failed_step_id}` : ""}</span>}
                      {!r.pass && r.why && <span className="text-neutral-600"> · {r.why}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {x === passed && <p className="mt-1 text-xs font-medium text-emerald-700">Passes on Earth and in orbit: this is the program.</p>}
            </li>
          ))}
        </ol>
      )}
      {its.length > 0 && !busy && (
        <p className="text-xs text-neutral-500">
          {passed ? `Fixed in ${passed.n} patch${passed.n > 1 ? "es" : ""}` : `Not fixed in ${its.length} patch${its.length > 1 ? "es" : ""}`}, ${spent.toFixed(4)} of model calls.
        </p>
      )}
    </div>
  );
}

async function post<T>(url: string, body: unknown): Promise<StageResult<T>> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...liveAuth(), ...(body as object) }) });
    return (await res.json()) as StageResult<T>;
  } catch (err) {
    return failed((err as Error).message);
  }
}
