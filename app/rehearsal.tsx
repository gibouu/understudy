"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorldRun } from "@/lib/notes/note";
import { SimClient } from "@/lib/sim/client";
import type { Rollout } from "@/lib/sim/interpreter";
import { StageRenderer } from "@/lib/sim/render";
import { PatchLoop } from "./patch-loop";
import type { Failure } from "./program-view";
import { GRAVITIES, type GravityName, type Program, type TaskSpec } from "@/lib/spec/schema";

/** The two worlds the demo compares; the same program runs in both. */
const WORLDS: GravityName[] = ["earth", "orbit"];

type Row = { world: GravityName; result: Rollout | { error: string } | "running" };

/** `notes={false}` leaves out the Notes stage, which calls Token Factory (/space must never). */
export function Rehearsal({ spec, program, onFail, notes = true }: { spec: TaskSpec; program: Program; onFail: (f: Failure | null) => void; notes?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<SimClient | null>(null);
  const [status, setStatus] = useState("starting");
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  /** the last rehearsal in every world, when it failed somewhere a patch can reach; `n` keys a fresh patch loop */
  const [failing, setFailing] = useState<{ program: Program; runs: WorldRun[]; n: number } | null>(null);
  const [patching, setPatching] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let alive = true; // Strict Mode disposes and re-runs this effect; the first client must stay silent
    const renderer = new StageRenderer(canvas);
    const client = new SimClient()
      .on("status", (message) => alive && setStatus(message))
      .on("error", (message) => alive && setStatus(`error: ${message}`))
      .on("loaded", (m) => renderer.setMeta(m))
      .on("frame", (frame) => renderer.update(frame));
    clientRef.current = client;
    setReady(false);
    setRows([]);
    setFailing(null);
    client
      .load({ spec })
      .then(() => alive && (setReady(true), setStatus("ready")))
      .catch((err: Error) => alive && setStatus(`error: ${err.message}`));
    return () => {
      alive = false;
      client.dispose();
      renderer.dispose();
    };
  }, [spec]);

  /** One rollout of `p` per world, each from the spec's start; `show` puts them in the table. */
  const play = useCallback(async (p: Program, worlds: GravityName[], show: boolean): Promise<Row[]> => {
    const client = clientRef.current;
    if (!client) throw new Error("the simulator is not loaded");
    const out: Row[] = [];
    let first: Failure | null = null;
    for (const world of worlds) {
      // a rollout homes only the arm: put the objects back where the spec has them, too
      client.reset();
      client.setGravity(GRAVITIES[world]);
      let result: Row["result"];
      try {
        result = await client.run(p, "sensed", "home");
      } catch (err) {
        result = { error: (err as Error).message };
      }
      out.push({ world, result });
      if (!show) continue;
      setRows((rs) => rs.map((r) => (r.world === world ? { world, result } : r)));
      if (!first && !("error" in result) && !result.pass && result.failed_step_id) {
        first = { step_id: result.failed_step_id, op: result.failed_op, world, why: result.why };
        onFail(first);
      }
    }
    return out;
  }, [onFail]);

  async function rehearse(worlds: GravityName[]) {
    if (!clientRef.current || busy || patching) return;
    setBusy(true);
    setRows(worlds.map((world) => ({ world, result: "running" })));
    setFailing(null);
    onFail(null);
    const out = await play(program, worlds, true);
    const runs = out.flatMap(({ world, result }) => (typeof result === "object" && !("error" in result) ? [{ world, rollout: result }] : []));
    // a spec gap (an unanswered question, an unknown object) is the interview's to fix, not a patch's
    if (worlds.length === WORLDS.length && runs.length === WORLDS.length && runs.some((r) => !r.rollout.pass) && runs.every((r) => r.rollout.pass || r.rollout.failure_class !== "spec_gap")) {
      setFailing((f) => ({ program, runs, n: (f?.n ?? 0) + 1 }));
    }
    setBusy(false);
  }

  const rehearsePatch = useCallback(
    async (p: Program): Promise<WorldRun[]> =>
      (await play(p, WORLDS, false)).map(({ world, result }) => {
        if (typeof result !== "object" || "error" in result) throw new Error(typeof result === "object" ? result.error : "the rollout did not finish");
        return { world, rollout: result };
      }),
    [play],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl border bg-[#f4f1ea]">
        <canvas ref={canvasRef} className="h-full w-full" />
        <div className="pointer-events-none absolute left-3 top-3 rounded bg-white/80 px-2 py-1 text-xs text-neutral-700">{status}</div>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        <button className="rounded bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-40" disabled={!ready || busy || patching} onClick={() => rehearse(WORLDS)}>
          Rehearse on Earth, then in orbit
        </button>
        <button className="rounded border px-3 py-1.5 disabled:opacity-40" disabled={!ready || busy || patching} onClick={() => (clientRef.current?.reset(), setRows([]), onFail(null))}>
          Reset
        </button>
        {WORLDS.map((w) => (
          <button key={w} className="rounded border px-3 py-1.5 disabled:opacity-40" disabled={!ready || busy || patching} onClick={() => rehearse([w])}>
            {w} ({GRAVITIES[w]} g)
          </button>
        ))}
      </div>
      {rows.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-neutral-500">
            <tr>
              <th className="py-1 pr-4 font-normal">world</th>
              <th className="py-1 pr-4 font-normal">result</th>
              <th className="py-1 font-normal">why</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ world, result }) => (
              <tr key={world} className="border-t align-top">
                <td className="py-1.5 pr-4">
                  {world} · {GRAVITIES[world]} g
                </td>
                <td className="py-1.5 pr-4 font-medium">
                  {result === "running" ? "running…" : "error" in result ? <span className="text-red-700">error</span> : result.pass ? <span className="text-emerald-700">pass</span> : <span className="text-red-700">fail{result.failed_step_id ? ` at ${result.failed_step_id}` : ""}</span>}
                </td>
                <td className="py-1.5 text-neutral-600">{result === "running" ? "" : "error" in result ? result.error : result.pass ? `done in ${result.t.toFixed(1)} s` : result.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {notes && failing?.program === program && <PatchLoop key={failing.n} spec={spec} program={program} first={failing.runs} rehearse={rehearsePatch} onBusy={setPatching} />}
    </div>
  );
}
