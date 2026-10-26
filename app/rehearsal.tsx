"use client";

import { useEffect, useRef, useState } from "react";
import { SimClient } from "@/lib/sim/client";
import type { Rollout } from "@/lib/sim/interpreter";
import { StageRenderer } from "@/lib/sim/render";
import type { Failure } from "./program-view";
import { GRAVITIES, type GravityName, type Program, type TaskSpec } from "@/lib/spec/schema";

/** The two worlds the demo compares; the same program runs in both. */
const WORLDS: GravityName[] = ["earth", "orbit"];

type Row = { world: GravityName; result: Rollout | { error: string } | "running" };

export function Rehearsal({ spec, program, onFail }: { spec: TaskSpec; program: Program; onFail: (f: Failure | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<SimClient | null>(null);
  const [status, setStatus] = useState("starting");
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);

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

  async function rehearse(worlds: GravityName[]) {
    const client = clientRef.current;
    if (!client) return;
    setRows(worlds.map((world) => ({ world, result: "running" })));
    onFail(null);
    let first: Failure | null = null;
    for (const world of worlds) {
      // a rollout homes only the arm: put the objects back where the spec has them, too
      client.reset();
      client.setGravity(GRAVITIES[world]);
      let result: Row["result"];
      try {
        result = await client.run(program, "sensed", "home");
      } catch (err) {
        result = { error: (err as Error).message };
      }
      setRows((rs) => rs.map((r) => (r.world === world ? { world, result } : r)));
      if (!first && !("error" in result) && !result.pass && result.failed_step_id) {
        first = { step_id: result.failed_step_id, op: result.failed_op, world, why: result.why };
        onFail(first);
      }
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl border bg-[#f4f1ea]">
        <canvas ref={canvasRef} className="h-full w-full" />
        <div className="pointer-events-none absolute left-3 top-3 rounded bg-white/80 px-2 py-1 text-xs text-neutral-700">{status}</div>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        <button className="rounded bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-40" disabled={!ready} onClick={() => rehearse(WORLDS)}>
          Rehearse on Earth, then in orbit
        </button>
        <button className="rounded border px-3 py-1.5 disabled:opacity-40" disabled={!ready} onClick={() => (clientRef.current?.reset(), setRows([]), onFail(null))}>
          Reset
        </button>
        {WORLDS.map((w) => (
          <button key={w} className="rounded border px-3 py-1.5 disabled:opacity-40" disabled={!ready} onClick={() => rehearse([w])}>
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
    </div>
  );
}
