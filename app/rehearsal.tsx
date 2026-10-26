"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorldRun } from "@/lib/notes/note";
import { SimClient } from "@/lib/sim/client";
import { describeReach } from "@/lib/sim/gesture";
import type { Rollout } from "@/lib/sim/interpreter";
import { StageRenderer } from "@/lib/sim/render";
import { SETTING_NAMES, SETTING_WORLD, settingFor } from "@/lib/sim/settings";
import { PatchLoop } from "./patch-loop";
import { SettingNote, SettingSwitch, type Shown } from "./setting-switch";
import type { Failure } from "./program-view";
import { GRAVITIES, type GravityName, type Program, type TaskSpec } from "@/lib/spec/schema";

/** The two worlds the demo compares; the same program runs in both. */
const WORLDS: GravityName[] = ["earth", "orbit"];

type Row = { world: GravityName; result: Rollout | { error: string } | "running" };

/** What a rollout that followed a gesture path found, in words: a gesture's only check. */
const reachOf = (r: Rollout) => r.followed?.map((f) => describeReach(f)).join("; ");

/** Where the liquid ended, as the rollout logged it, when the scene has one. */
const liquidOf = (r: Rollout) => r.log.findLast((l) => l.includes(" liquid: "))?.split(" liquid: ")[1];

/**
 * `notes={false}` leaves out the Notes stage, which calls Token Factory (/space must never). Once the program passes
 * in the world a setting stands for, the stage is drawn in the setting the clip points to (its label and `hint`):
 * the station module after an orbit pass, the kitchen counter after an Earth pass. A setting picked by hand wins.
 */
export function Rehearsal({ spec, program, onFail, notes = true, hint }: { spec: TaskSpec; program: Program; onFail: (f: Failure | null) => void; notes?: boolean; hint?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<SimClient | null>(null);
  const rendererRef = useRef<StageRenderer | null>(null);
  const [status, setStatus] = useState("starting");
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  /** the last rehearsal in every world, when it failed somewhere a patch can reach; `n` keys a fresh patch loop */
  const [failing, setFailing] = useState<{ program: Program; runs: WorldRun[]; n: number } | null>(null);
  const [patching, setPatching] = useState(false);
  /** a gesture handles nothing: there is no task to succeed at, only a path to follow */
  const gesture = spec.steps.find((s) => s.verb === "gesture" && s.gesture);
  /** the worlds where the last program played on this stage passed (`ran`: the prop, or a patch of it) */
  const [passed, setPassed] = useState<{ program: Program; ran: Program; worlds: GravityName[] } | null>(null);
  const [picked, setPicked] = useState<Shown | "auto">("auto");
  const suggested = useMemo(() => settingFor(spec.title, spec.summary, hint), [spec, hint]);
  const earned = passed?.program === program && passed.worlds.includes(SETTING_WORLD[suggested]);
  const shown = picked !== "auto" ? picked : earned ? suggested : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let alive = true; // Strict Mode disposes and re-runs this effect; the first client must stay silent
    const renderer = new StageRenderer(canvas);
    rendererRef.current = renderer;
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

  // after the effect above, so a fresh renderer gets the setting too
  useEffect(() => rendererRef.current?.setSetting(shown, spec), [shown, spec]);

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
      // the stage now shows this rollout, a patch's included: the setting follows what it shows
      const won = typeof result === "object" && !("error" in result) && result.pass;
      setPassed((prev) => {
        const kept = prev?.program === program && prev.ran === p ? prev.worlds.filter((w) => w !== world) : [];
        return { program, ran: p, worlds: won ? [...kept, world] : kept };
      });
      if (!show) continue;
      setRows((rs) => rs.map((r) => (r.world === world ? { world, result } : r)));
      if (!first && !("error" in result) && !result.pass && result.failed_step_id) {
        first = { step_id: result.failed_step_id, op: result.failed_op, world, why: result.why };
        onFail(first);
      }
    }
    return out;
  }, [onFail, program]);

  async function rehearse(worlds: GravityName[]) {
    if (!clientRef.current || busy || patching) return;
    setBusy(true);
    setRows(worlds.map((world) => ({ world, result: "running" })));
    setFailing(null);
    onFail(null);
    const out = await play(program, worlds, true);
    const runs = out.flatMap(({ world, result }) => (typeof result === "object" && !("error" in result) ? [{ world, rollout: result }] : []));
    // a spec gap (an unanswered question, an unknown object) is the interview's to fix, not a patch's; a gesture's
    // program is its path, so there is nothing for a patch to change
    if (!gesture && worlds.length === WORLDS.length && runs.length === WORLDS.length && runs.some((r) => !r.rollout.pass) && runs.every((r) => r.rollout.pass || r.rollout.failure_class !== "spec_gap")) {
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
        <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-col items-start gap-1 text-xs text-neutral-700">
          <div className="rounded bg-white/80 px-2 py-1">{status}</div>
          <SettingNote shown={shown} />
        </div>
      </div>
      {gesture && (
        <p className="text-sm text-neutral-600">
          This clip is a gesture: the arm handles nothing, so there is no task to succeed at. The only check is that the point between the gripper&apos;s pads comes within {gesture.gesture!.reach_mm} mm of each point of the hand&apos;s path, in order, at most a quarter of a second behind it. When the clip is faster than the arm&apos;s joints turn, the arm follows it slower and says by how much.
        </p>
      )}
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
      <SettingSwitch shown={shown} onPick={setPicked} note={picked === "auto" && !shown ? `after a pass ${SETTING_WORLD[suggested] === "orbit" ? "in orbit" : "on Earth"}: the ${SETTING_NAMES[suggested]}` : undefined} />
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
                  {result === "running" ? "running…" : "error" in result ? <span className="text-red-700">error</span> : result.pass ? <span className="text-emerald-700">{gesture ? "path followed" : "pass"}</span> : <span className="text-red-700">fail{result.failed_step_id ? ` at ${result.failed_step_id}` : ""}</span>}
                </td>
                <td className="py-1.5 text-neutral-600">
                  {result === "running" ? "" : "error" in result ? result.error : result.pass ? (reachOf(result) ? `${reachOf(result)}; done in ${result.t.toFixed(1)} s` : `done in ${result.t.toFixed(1)} s`) : result.why}
                  {result !== "running" && !("error" in result) && liquidOf(result) ? `. Liquid: ${liquidOf(result)}.` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {notes && failing?.program === program && <PatchLoop key={failing.n} spec={spec} program={program} first={failing.runs} rehearse={rehearsePatch} onBusy={setPatching} />}
    </div>
  );
}
