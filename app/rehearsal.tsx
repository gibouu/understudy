"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
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
/** The paces a stage with a speed control offers, simulated seconds per second. */
const SPEEDS = [1, 2, 4];

type Row = { world: GravityName; result: Rollout | { error: string } | "running" };

/** What a rollout that followed a gesture path found, in words: a gesture's only check. */
const reachOf = (r: Rollout) => r.followed?.map((f) => describeReach(f)).join("; ");

/** Where the liquid ended, as the rollout logged it, when the scene has one. */
const liquidOf = (r: Rollout) => r.log.findLast((l) => l.includes(" liquid: "))?.split(" liquid: ")[1];

/**
 * `notes={false}` leaves out the Notes stage, which calls Token Factory (/space must never). Once the program passes
 * in the world a setting stands for, the stage is drawn in the setting the clip points to (its label and `hint`):
 * the station module after an orbit pass, the kitchen counter after an Earth pass. A setting picked by hand wins.
 *
 * Until the arm moves, a veil over the stage says what it waits for: the simulator loading, a setting being built,
 * a rehearsal starting. `autoplay` rehearses on Earth, then in orbit, by itself once the stage is loaded and on
 * screen, and again after a setting is picked while nothing plays. `speed` plays that many times faster than real
 * time and shows a control for it; the physics steps the same, so the results do not change.
 */
export function Rehearsal({
  spec,
  program,
  onFail,
  notes = true,
  hint,
  autoplay = false,
  speed: initialSpeed,
}: {
  spec: TaskSpec;
  program: Program;
  onFail: (f: Failure | null) => void;
  notes?: boolean;
  hint?: string;
  autoplay?: boolean;
  speed?: number;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<SimClient | null>(null);
  const rendererRef = useRef<StageRenderer | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** how far the simulator's load has come, 0 to 1, once the worker says */
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [ready, setReady] = useState(false);
  /** a rehearsal was asked for and the arm has not moved yet; `awaiting` is the frame handler's copy */
  const [starting, setStarting] = useState(false);
  const awaiting = useRef(false);
  /** a rehearsal to start as soon as the stage is loaded, idle and on screen */
  const [queued, setQueued] = useState(autoplay);
  const [inView, setInView] = useState(false);
  /** the setting being built, between the click and the build (the veil paints first) */
  const [building, setBuilding] = useState<Shown | undefined>(undefined);
  const [speed, setSpeed] = useState(initialSpeed ?? 1);
  /** the pace the stage keeps, simulated seconds per second over about a second: below the speed when the CPU cannot keep up (a liquid) */
  const [pace, setPace] = useState<number | undefined>(undefined);
  /** where the pace is measured from: a wall time and the simulated time then */
  const clock = useRef<{ wall: number; t: number } | null>(null);
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
    let last: Float64Array | null = null;
    const client = new SimClient()
      .on("status", (_, p) => alive && p !== undefined && setProgress(p))
      .on("error", (message) => alive && setError(message))
      .on("loaded", (m) => renderer.setMeta(m))
      .on("frame", (frame) => {
        renderer.update(frame);
        const now = performance.now();
        const from = clock.current;
        if (!from || frame.t < from.t) clock.current = { wall: now, t: frame.t }; // a reset starts the clock again
        else if (now - from.wall >= 1000) {
          clock.current = { wall: now, t: frame.t };
          if (alive) setPace((frame.t - from.t) / ((now - from.wall) / 1000));
        }
        // the first frame whose command differs from the one before: the arm has started to move
        const before = last;
        last = frame.ctrl;
        if (awaiting.current && before && frame.ctrl.some((c, i) => Math.abs(c - before[i]) > 1e-4)) {
          awaiting.current = false;
          if (alive) setStarting(false);
        }
      });
    clientRef.current = client;
    setReady(false);
    setError(null);
    setProgress(undefined);
    setPace(undefined);
    clock.current = null;
    setRows([]);
    setFailing(null);
    client
      .load({ spec })
      .then(() => alive && setReady(true))
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
      client.dispose();
      renderer.dispose();
    };
  }, [spec]);

  // after the effect above, so a fresh renderer and a fresh client get the setting and the speed too
  useEffect(() => rendererRef.current?.setSetting(shown, spec), [shown, spec]);
  useEffect(() => clientRef.current?.setSpeed(speed), [speed, spec]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    // a fast scroll can bring several entries in one call: the last is now
    const io = new IntersectionObserver((entries) => setInView(entries[entries.length - 1].isIntersecting), { threshold: 0.5 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const startQueued = useEffectEvent(() => {
    if (queued && ready && inView && !busy && !patching) void rehearse(WORLDS);
  });
  useEffect(() => startQueued(), [queued, ready, inView, busy, patching]);

  /** One rollout of `p` per world, each from the spec's start; `show` puts them in the table. */
  const play = useCallback(async (p: Program, worlds: GravityName[], show: boolean): Promise<Row[]> => {
    const client = clientRef.current;
    if (!client) throw new Error("the simulator is not loaded");
    const out: Row[] = [];
    let first: Failure | null = null;
    for (const world of worlds) {
      let result: Row["result"];
      try {
        // a rollout homes only the arm: the objects go back where the spec has them too, in the run's own message
        result = await client.run(p, "sensed", "home", { reset: {}, gravityG: GRAVITIES[world] });
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
    setQueued(false);
    setBusy(true);
    awaiting.current = true;
    setStarting(true);
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
    awaiting.current = false;
    setStarting(false);
    setBusy(false);
  }

  /**
   * A setting is built on the main thread: the veil paints first, then the setting is picked (and built by the
   * effect above). With `autoplay` an idle stage rehearses in it; a rehearsal already playing just goes on.
   */
  function pick(s: Shown) {
    if (s === shown && picked !== "auto") return;
    setBuilding(s);
    requestAnimationFrame(() =>
      setTimeout(() => {
        setPicked(s);
        setBuilding(undefined);
        if (autoplay && !busy) setQueued(true);
      }),
    );
  }

  /** what the stage waits for, said on the veil; null once the arm moves (or on an error, said in the corner) */
  const waiting = error
    ? null
    : !ready
      ? "Loading the simulator…"
      : building !== undefined
        ? `Loading the ${building ? SETTING_NAMES[building] : "bench"}…`
        : starting || (queued && inView)
          ? "Starting the rehearsal…"
          : null;
  /** the speed asked for, or the pace kept when it is well below (a liquid the CPU cannot step faster) */
  const kept = pace !== undefined && pace < 0.85 * speed ? Math.round(pace * 10) / 10 : speed;
  const paceLabel = kept === 1 ? "real time" : `${kept}× speed`;
  // the veil fades out with its last words on it
  const [said, setSaid] = useState(waiting);
  if (waiting && waiting !== said) setSaid(waiting);

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
      <div ref={stageRef} className="relative aspect-[4/3] w-full overflow-hidden rounded-xl border bg-[#f4f1ea]">
        <canvas ref={canvasRef} className="h-full w-full" />
        <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start gap-2 text-xs text-neutral-700">
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
            {error && <div className="rounded bg-white/90 px-2 py-1 text-red-700">error: {error}</div>}
            <SettingNote shown={shown} />
          </div>
          {initialSpeed !== undefined && <div className="shrink-0 rounded bg-white/80 px-2 py-1">{paceLabel}</div>}
        </div>
        <div
          role="status"
          aria-live="polite"
          className={`absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#f4f1ea]/75 transition-opacity duration-200 ${waiting ? "opacity-100" : "pointer-events-none opacity-0"}`}
        >
          <div className="flex items-center gap-3 rounded-lg bg-white/90 px-4 py-2.5 text-sm text-neutral-800 shadow-sm">
            <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" aria-hidden="true" />
            {waiting ?? said}
          </div>
          {!ready && (
            <div className="h-1 w-40 overflow-hidden rounded-full bg-neutral-300/70" aria-hidden="true">
              <div className="h-full rounded-full bg-neutral-900 transition-[width] duration-300" style={{ width: `${Math.round((progress ?? 0.02) * 100)}%` }} />
            </div>
          )}
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
        {initialSpeed !== undefined && (
          <div className="flex items-center gap-1" role="group" aria-label="Speed">
            <span className="mr-1 text-xs text-neutral-500">speed</span>
            {SPEEDS.map((x) => (
              <button key={x} aria-pressed={speed === x} className={`rounded border px-2 py-1.5 ${speed === x ? "bg-neutral-900 text-white" : ""}`} onClick={() => (setSpeed(x), setPace(undefined), (clock.current = null))}>
                {x}×
              </button>
            ))}
          </div>
        )}
      </div>
      <SettingSwitch shown={shown} onPick={pick} note={picked === "auto" && !shown ? `after a pass ${SETTING_WORLD[suggested] === "orbit" ? "in orbit" : "on Earth"}: the ${SETTING_NAMES[suggested]}` : undefined} />
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
