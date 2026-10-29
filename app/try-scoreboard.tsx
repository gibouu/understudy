"use client";

import { useMemo } from "react";
import type { TryVersion } from "@/lib/export/try";
import type { SaboteurPlan } from "@/lib/saboteur/ask";
import { baselineProgram } from "@/lib/saboteur/baseline";
import type { TaskSpec } from "@/lib/spec/schema";
import { ScoreBars, useScoreboard } from "./scoreboard";

const SOURCE: Record<TryVersion["source"], string> = {
  compile: "first compile",
  interview: "after your answers",
  web: "after a web chip",
  recompile: "asked again",
  notes: "Notes patch",
};

/**
 * The scoreboard on Try it (issue #55), below the grid: the baseline (retarget and replay, from the label as first
 * fitted, no model and no answers), then every version of the program on this page, each run on the grid's twelve
 * (`plan`, on `spec`, the spec the grid ran on), blind and sensed, on Earth and in orbit, in a worker of its own.
 * No model call. Nothing until the grid has its twelve and the button is pressed.
 */
export function TryScoreboard({ spec, plan, label, versions }: { spec: TaskSpec; plan: SaboteurPlan | null; label: TaskSpec | null; versions: TryVersion[] }) {
  const baseline = useMemo(() => (label ? baselineProgram(label, spec) : { why: "the label was not fitted to the bench on this page" }), [label, spec]);
  const programs = useMemo(() => [...("program" in baseline ? [baseline.program] : []), ...versions.map((v) => v.program)], [baseline, versions]);
  const board = useScoreboard(spec, programs, plan);
  const offset = "program" in baseline ? 1 : 0;
  const n = plan?.scenarios.length ?? 12;

  if (!plan) return <p className="text-sm text-neutral-500">Perturb the world above first: the scoreboard runs every version of the program on the same twelve changes.</p>;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-neutral-600">
        Every version of the program on this page, and first a baseline, run on the grid&apos;s twelve changes, each <b>blind</b> and <b>sensed</b>, on Earth and in orbit: 24 rollouts per world per version, all on the spec the grid ran on, in your browser, with no model call. The <b>baseline</b> is &ldquo;retarget and replay&rdquo;: a program written by fixed rules from the label&apos;s steps as first fitted to the bench, with no model and no answers (take the object, carry it over the target, lower it, let go; no waits, no checks). Every rollout passes only where the spec&apos;s success holds.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={board.start} disabled={board.busy} className="rounded bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-40">
          {board.busy ? "Scoring…" : board.scores.length ? "Score again" : "Score every version under perturbation"}
        </button>
        {board.ms !== null && <span className="text-neutral-500">{(board.ms / 1000).toFixed(1)} s in your browser</span>}
      </div>
      <ol className="flex flex-col divide-y border-y">
        <li className="flex flex-col gap-1.5 py-3">
          <span className="font-medium">Baseline: retarget and replay</span>
          {"program" in baseline ? <ScoreBars score={board.scores[0]} scenarios={n} /> : <span className="text-neutral-500">Not built for this clip: {baseline.why}.</span>}
        </li>
        {versions.map((v, i) => (
          <li key={i} className="flex flex-col gap-1.5 py-3">
            <span className="font-medium">
              {i}. {SOURCE[v.source]}
              {v.changes.length > 0 && <span className="font-normal text-neutral-500"> · {v.changes.join("; ").slice(0, 160)}</span>}
            </span>
            <ScoreBars score={board.scores[i + offset]} scenarios={n} />
          </li>
        ))}
      </ol>
      {board.scores.length > 0 && (
        <p className="text-xs text-neutral-500">
          Dark: sensed passes; light: blind passes. A version that scores lower than the one before it is shown as it scored. A version that still asks a question, or reaches for a pose the arm cannot, fails every rollout at that point: its 0 of 24 says the program never got past that line. Rigid-body physics with a geometric grasp: this measures how much error a scripted program tolerates, not what a learned policy or a real arm would do.
        </p>
      )}
    </div>
  );
}
