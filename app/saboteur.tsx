"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { BatchResult } from "@/lib/sim/batch";
import { SimClient } from "@/lib/sim/client";
import type { SaboteurPlan } from "@/lib/saboteur/ask";
import { bandText, budgetOf, type Cell } from "@/lib/saboteur/grid";
import { GRAVITIES, MODES, type GravityName, type Mode, type Program, type Scenario, type TaskSpec } from "@/lib/spec/schema";
import { failed, idle, running, type StageResult } from "@/lib/spec/stage-result";
import { gateNote } from "@/lib/unlock/messages";
import { liveAuth } from "./capture";
import { answeredBy, useModels } from "./models";
import { usePassed } from "./passed";
import { Pulse } from "./working";

/** The same two worlds as the rehearsal above. */
const WORLDS: GravityName[] = ["earth", "orbit"];

type Grid = { results: (BatchResult | undefined)[]; ms?: number; error?: string };

async function post<T>(url: string, body: unknown): Promise<StageResult<T>> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...liveAuth(), ...(body as object) }) });
    return (await res.json()) as StageResult<T>;
  } catch (err) {
    return failed((err as Error).message);
  }
}

const unit = (s: Scenario) => (s.axis.endsWith("_deg") ? "°" : " mm");
const axisName: Record<string, string> = { x_mm: "x", y_mm: "y", z_mm: "z", yaw_deg: "yaw", tilt_deg: "tilt", clearance_mm: "clearance" };
const offsetText = (s: Scenario) => `${s.offset > 0 ? "+" : "−"}${Math.abs(s.offset)}${unit(s)}`;

/**
 * Below the rehearsal: twelve perturbations of the world (/api/saboteur: the patching model's, or built from the
 * spec with no model), each run blind (the program is told the poses the spec has, the world is moved) and sensed
 * (it is told the true ones), on Earth and in orbit, through the headless batch (lib/sim/batch.ts) in a worker of
 * its own. It runs what passed the rehearsal of `program` in both worlds, a patch included (app/passed.ts); nothing until then.
 * `onPlan` hears the twelve once they are chosen (null when none came), with the spec they were chosen for: the
 * scoreboard below runs on them (app/try-scoreboard.tsx).
 */
export function Saboteur({ spec, program: given, onPlan }: { spec: TaskSpec; program: Program; onPlan?: (plan: SaboteurPlan | null, spec: TaskSpec) => void }) {
  const say = useModels();
  const program = usePassed(given);
  const [plan, setPlan] = useState<StageResult<SaboteurPlan>>(idle());
  const [grids, setGrids] = useState<Partial<Record<GravityName, Grid>>>({});
  const [busy, setBusy] = useState(false);
  const clientRef = useRef<SimClient | null>(null);
  /** bumped when the spec or the program changes, or the section goes: results on their way are dropped */
  const gen = useRef(0);

  // a grid reset by a new spec or program: the scoreboard below loses its twelve too
  const dropPlan = useEffectEvent(() => onPlan?.(null, spec));
  useEffect(() => {
    gen.current++;
    dropPlan();
    setPlan(idle());
    setGrids({});
    setBusy(false);
  }, [spec, program]);
  // the worker goes with the section; a batch still running is dropped
  useEffect(
    () => () => {
      gen.current++;
      clientRef.current?.dispose();
      clientRef.current = null;
    },
    [],
  );

  async function sabotage() {
    if (!program || busy) return;
    const id = gen.current;
    setBusy(true);
    setGrids({});
    setPlan(running(`${say("super")} is choosing twelve ways to perturb the world`));
    onPlan?.(null, spec);
    const p = await post<SaboteurPlan>("/api/saboteur", { spec });
    if (id !== gen.current) return;
    setPlan(p);
    onPlan?.(p.status === "done" ? p.value : null, spec);
    if (p.status !== "done") return setBusy(false);
    const client = (clientRef.current ??= new SimClient());
    const scenarios = p.value.scenarios;
    for (const world of WORLDS) {
      const rollouts = scenarios.flatMap((scenario) => MODES.map((mode) => ({ scenario, mode, gravity_g: GRAVITIES[world] })));
      setGrids((g) => ({ ...g, [world]: { results: rollouts.map(() => undefined) } }));
      try {
        const { ms } = await client.batch(spec, program, rollouts, {
          onResult: (r) => id === gen.current && setGrids((g) => ({ ...g, [world]: { ...g[world]!, results: g[world]!.results.map((x, i) => (i === r.index ? r : x)) } })),
        });
        if (id !== gen.current) return;
        setGrids((g) => ({ ...g, [world]: { ...g[world]!, ms } }));
      } catch (err) {
        if (id !== gen.current) return;
        setGrids((g) => ({ ...g, [world]: { ...g[world]!, error: (err as Error).message } }));
      }
    }
    setBusy(false);
  }

  const by = plan.status === "done" ? (plan.value.source === "model" ? (answeredBy(plan.ledger) ?? say("super")) : "no model: built from the spec") : null;
  const replayed = plan.status === "done" && plan.warnings.some((w) => w.startsWith("replay"));

  const name = (id: string) => spec.objects.find((o) => o.id === id)?.name ?? id;

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-neutral-600">
        Twelve changes to the world, each run twice: <b>blind</b>, where the program is told the poses the spec has while the world is moved, and <b>sensed</b>, where it is told where things really are. Blind says how much pose error the task survives without perception; sensed, what is left when the robot sees.
      </p>
      {!program && <p className="text-neutral-500">Rehearse the program above first: the saboteur perturbs a program that passes on Earth and in orbit.</p>}
      <div>
        <button className="rounded bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-40" disabled={!program || busy} onClick={sabotage}>
          {plan.status === "idle" ? "Perturb the world" : "Perturb again"}
        </button>
      </div>
      {plan.status === "running" && (
        <p className="text-neutral-600" role="status">
          <Pulse />
          {plan.note}…
        </p>
      )}
      {plan.status === "failed" && <p className="text-red-700">{plan.message}</p>}
      {plan.status === "done" && (
        <div className="flex flex-col gap-1 text-xs text-neutral-500">
          <p>
            Scenarios: {by}. The tightest constraint is a band of {plan.value.focus.band_mm} mm, {plan.value.focus.band_from}.
          </p>
          {replayed && gateNote(plan.warnings) && <p className="text-amber-700">{gateNote(plan.warnings)}</p>}
          {replayed && <p className="text-amber-700">{plan.value.source === "spec" ? "No usable recording for this task: the scenarios are built from the spec, with no model." : "The model's scenarios are replayed from a recording."}</p>}
          {plan.warnings.filter((w) => !w.startsWith("replay") && w !== gateNote(plan.warnings)).map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}
      {plan.status === "done" && WORLDS.map((world) => grids[world] && <WorldGrid key={world} world={world} scenarios={plan.value.scenarios} grid={grids[world]!} name={name} />)}
      {plan.status === "done" && WORLDS.every((w) => grids[w]?.ms !== undefined) && <Budget scenarios={plan.value.scenarios} grids={grids} name={name} />}
      {plan.status === "done" && (
        <p className="text-xs text-neutral-500">
          Rigid-body physics with a geometric grasp: the grid measures how much error this scripted program tolerates, not what a learned policy or a real arm would do.
        </p>
      )}
    </div>
  );
}

function WorldGrid({ world, scenarios, grid, name }: { world: GravityName; scenarios: Scenario[]; grid: Grid; name: (id: string) => string }) {
  const at = (i: number, mode: Mode) => grid.results[2 * i + MODES.indexOf(mode)];
  const done = grid.results.filter(Boolean).length;
  return (
    <div className="flex flex-col gap-1">
      <p className="font-medium">
        {world} · {GRAVITIES[world]} g{" "}
        <span className="font-normal text-neutral-500">
          {grid.error ? <span className="text-red-700">error: {grid.error}</span> : grid.ms !== undefined ? `${done} rollouts in ${(grid.ms / 1000).toFixed(1)} s` : `${done} of ${grid.results.length} rollouts…`}
        </span>
      </p>
      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-0.5 text-xs">
          <thead>
            <tr>
              <th />
              {scenarios.map((s) => (
                <th key={s.id} className="min-w-12 px-0.5 align-bottom font-normal leading-tight text-neutral-600" title={`${s.name}: ${s.why}${s.expected !== "unknown" ? ` (expected blind: ${s.expected})` : ""}`}>
                  <div className="mx-auto max-w-14 truncate">{name(s.object)}</div>
                  <div>
                    {axisName[s.axis] ?? s.axis}
                    {s.axis === "tilt_deg" ? ` ${s.tilt_axis ?? "x"}` : ""}
                  </div>
                  <div className="tabular-nums">{offsetText(s)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(["blind", "sensed"] as const).map((mode) => (
              <tr key={mode}>
                <th className="pr-2 text-left font-normal text-neutral-600">{mode}</th>
                {scenarios.map((s, i) => {
                  const r = at(i, mode);
                  const pass = r?.rollout?.pass;
                  const text = !r ? "" : r.error ? "!" : pass ? "✓" : "✗";
                  const why = !r ? "running" : r.error ? r.error : pass ? `pass in ${r.rollout!.t.toFixed(1)} s` : (r.rollout!.why ?? "fail");
                  return (
                    <td key={s.id} title={`${s.name}, ${mode}: ${why}`} className={`h-7 rounded text-center font-medium ${!r ? "animate-pulse bg-neutral-100" : r.error ? "bg-amber-100 text-amber-800" : pass ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}`}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Per axis: how far each mode got from zero on each side before its first failure, in each world. Only what was run. */
function Budget({ scenarios, grids, name }: { scenarios: Scenario[]; grids: Partial<Record<GravityName, Grid>>; name: (id: string) => string }) {
  const per = WORLDS.map((world) => {
    const cells: Cell[] = (grids[world]?.results ?? []).flatMap((r, k) => (r?.rollout ? [{ scenario: scenarios[Math.floor(k / 2)], mode: r.mode, pass: r.rollout.pass }] : []));
    return budgetOf(cells);
  });
  const rows = per[0];
  return (
    <div className="flex flex-col gap-1">
      <p className="font-medium">Perception budget per axis</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-neutral-500">
            <tr>
              <th className="py-1 pr-3 font-normal">axis</th>
              {WORLDS.map((w) => (
                <th key={w} className="py-1 pr-3 font-normal" colSpan={2}>
                  {w} · {GRAVITIES[w]} g: blind / sensed
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const key = (x: typeof b) => `${x.object}|${x.axis}|${x.tilt_axis ?? ""}`;
              return (
                <tr key={key(b)} className="border-t align-top">
                  <td className="py-1 pr-3">
                    {name(b.object)} {axisName[b.axis] ?? b.axis}
                    {b.tilt_axis ? ` about ${b.tilt_axis}` : ""}
                  </td>
                  {per.flatMap((bs, w) => {
                    const m = bs.find((x) => key(x) === key(b));
                    return (["blind", "sensed"] as const).map((mode) => (
                      <td key={`${w}-${mode}`} className="py-1 pr-3 text-neutral-700">
                        {m ? bandText(m[mode], m.unit) : "–"}
                      </td>
                    ));
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-neutral-500">Each side counts from zero up to the first failure; a pass further out after a failure does not widen it.</p>
    </div>
  );
}
