"use client";

import { useEffect, useRef, useState } from "react";
import type { SaboteurPlan } from "@/lib/saboteur/ask";
import { SCORE_WORLDS, scoreRollouts, tally, type ScoreWorld, type Tally } from "@/lib/saboteur/scoreboard";
import { SimClient } from "@/lib/sim/client";
import { GRAVITIES, type Program, type TaskSpec } from "@/lib/spec/schema";

export type Score = Partial<Record<ScoreWorld, Tally & { done: number; error?: string }>>;

/**
 * The scoreboard's runs (issue #55): `programs` in order (the baseline, then every version of the program, recorded on
 * /space or on this page on /try), each on the same twelve scenarios (`plan`, chosen for `spec`, the last version's),
 * blind and sensed, on Earth and then in orbit, through the headless batch in a worker of its own. Nothing runs until
 * `start`; no model is called. New scenarios or a new spec drop the bars of the old ones.
 */
export function useScoreboard(spec: TaskSpec, programs: Program[], plan: SaboteurPlan | null) {
  const [scores, setScores] = useState<Score[]>([]);
  const [busy, setBusy] = useState(false);
  const [ms, setMs] = useState<number | null>(null);
  const client = useRef<SimClient | null>(null);
  const gen = useRef(0);
  /** a run is under way: its partial bars go with its worker */
  const live = useRef(false);
  /** the spec and the twelve the bars were scored on: other ones (a new grid, an answer) show no bars until scored */
  const [scored, setScored] = useState<{ spec: TaskSpec; plan: SaboteurPlan } | null>(null);
  const current = scored?.spec === spec && scored.plan === plan;
  // the worker goes when the page is hidden or left (an Activity keeps the state, not the worker): a run on its way is
  // dropped and the button comes back
  useEffect(
    () => () => {
      gen.current++;
      client.current?.dispose();
      client.current = null;
      if (live.current) setScores([]);
      live.current = false;
      setBusy(false);
    },
    [],
  );

  async function start() {
    if (!plan || busy) return;
    const id = ++gen.current;
    const n = plan.scenarios.length;
    setBusy(true);
    live.current = true;
    setMs(null);
    setScores([]);
    setScored({ spec, plan });
    const sim = (client.current ??= new SimClient());
    const started = performance.now();
    for (const [v, program] of programs.entries()) {
      for (const world of SCORE_WORLDS) {
        const rollouts = scoreRollouts(plan.scenarios, world);
        const results: Parameters<typeof tally>[0] = rollouts.map(() => undefined);
        const put = (t: Score[ScoreWorld]) => id === gen.current && setScores((s) => Object.assign([...s], { [v]: { ...s[v], [world]: t } }));
        put({ ...tally(results, n), done: 0 });
        try {
          await sim.batch(spec, program, rollouts, {
            onResult: (r) => {
              results[r.index] = r;
              put({ ...tally(results, n), done: results.filter(Boolean).length });
            },
          });
        } catch (err) {
          if (id !== gen.current) return;
          // a worker that failed once answers nothing more: stop here, and the next click starts a fresh one
          put({ ...tally(results, n), done: results.filter(Boolean).length, error: (err as Error).message });
          sim.dispose();
          if (client.current === sim) client.current = null;
          live.current = false;
          setBusy(false);
          return;
        }
        if (id !== gen.current) return;
      }
    }
    setMs(performance.now() - started);
    live.current = false;
    setBusy(false);
  }

  return { scores: current ? scores : [], busy, ms: current ? ms : null, start };
}

/** One version's bars: per world, sensed passes then blind passes stacked out of 24, one cell per rollout. */
export function ScoreBars({ score, scenarios }: { score: Score | undefined; scenarios: number }) {
  if (!score) return null;
  return (
    <div className="flex flex-col gap-1.5" aria-label="Passes under perturbation">
      {SCORE_WORLDS.map((world) => {
        const t = score[world];
        if (!t) return null;
        const of = 2 * scenarios;
        const running = t.done < of && !t.error;
        return (
          <div key={world} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-sm sm:grid-cols-[4.5rem_minmax(0,16rem)_auto]">
            <span className="text-muted">
              {world === "earth" ? "Earth" : "Orbit"} <span className="tnum">{GRAVITIES[world]} g</span>
            </span>
            <span className="flex h-3.5 gap-px" role="img" aria-label={`${t.sensed} sensed and ${t.blind} blind passes of ${of}`}>
              {Array.from({ length: of }, (_, k) => (
                <span key={k} className={`flex-1 rounded-[1px] ${k < t.sensed ? "bg-ok" : k < t.sensed + t.blind ? "bg-ok/45" : running ? "animate-pulse bg-hair" : "bg-hair"}`} />
              ))}
            </span>
            <span className="tnum col-start-2 text-neutral-700 sm:col-start-auto">
              {running ? `${t.done} of ${of}…` : `${t.sensed + t.blind}/${of}`} <span className="text-muted">· sensed {t.sensed}, blind {t.blind}</span>
              {t.errors > 0 && <span className="text-bad"> · {t.errors} could not be set up</span>}
              {t.error && <span className="text-bad"> · {t.error}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Above the versions: what the scoreboard runs, the button, and what it does not show. */
export function ScoreboardHead({ plan, by, why, busy, ms, ran, start }: { plan: SaboteurPlan | null; by?: string; why?: string; busy: boolean; ms: number | null; ran: boolean; start: () => void }) {
  if (!plan) return why ? <p className="text-sm text-muted">No perturbation scoreboard for this clip: {why}.</p> : null;
  return (
    <div className="flex max-w-3xl flex-col gap-2">
      <p className="text-[17px] leading-relaxed">
        When it was recorded, each version below was rehearsed once per world, on its own spec. The scoreboard runs every version on the same twelve changes to the world, {plan.source === "model" ? `the ones ${by ?? "the patching model"} chose for this task when the perturbation grid was recorded` : "built from the spec with no model"}, each <b>blind</b> (the program is told the poses the spec has while the world is moved) and <b>sensed</b> (it is told where things really are), on Earth and in orbit: 24 rollouts per world per version, all on the last version’s spec, in your browser, with no model call. Before them runs a <b>baseline</b>, “retarget and replay”: a program written by fixed rules from the label’s steps as fitted to the bench, with no model and no answers (take the object, carry it over the target, lower it, let go; no waits, no checks), scored the same way.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={start} disabled={busy} className="self-start rounded-full border-2 border-ink bg-ink px-4 py-1.5 text-paper disabled:opacity-40">
          {busy ? "Scoring…" : ran ? "Score again" : "Score every version under perturbation"}
        </button>
        {ms !== null && <span className="tnum text-sm text-muted">{(ms / 1000).toFixed(1)} s in your browser</span>}
      </div>
      {ran && (
        <p className="text-sm text-muted">
          Dark: sensed passes; light: blind passes. A version that scores lower than the one before it is shown as it scored. A version that still asks a question, or reaches for a pose the arm cannot, fails every rollout at that point, as it did when recorded: its 0 of 24 says the program never got past that line, not that it lost to the perturbations. Rigid-body physics with a geometric grasp: this measures how much error a scripted program tolerates, not what a learned policy or a real arm would do.
        </p>
      )}
    </div>
  );
}
