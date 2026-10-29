/**
 * The progress scoreboard (issue #55): every version of a recorded program
 * (first compile, after the answers, each Notes patch) run on the same twelve
 * scenarios, blind and sensed, on Earth and in orbit, so "how it improved" is
 * measured under perturbation and not only on the nominal world. Every version
 * runs on the same world: the last version's spec, the task as the answers
 * clarified it, with the twelve chosen for that spec. A version that scores
 * lower than the one before it is shown as it scored.
 */
import type { BatchResult, BatchRollout } from "@/lib/sim/batch";
import { GRAVITIES, MODES, type Scenario, type TaskSpec } from "@/lib/spec/schema";
import type { Session } from "@/lib/showcase/session";

/** The two worlds the rehearsal and the grid run. */
export const SCORE_WORLDS = ["earth", "orbit"] as const;
export type ScoreWorld = (typeof SCORE_WORLDS)[number];

/** One version in one world: passes per mode out of the scenarios run, and rollouts that could not be set up. */
export type Tally = { blind: number; sensed: number; errors: number; scenarios: number };

/** The spec every version is scored on: the last version's, the task as the answers clarified it. */
export function scoredSpec(session: Session): TaskSpec {
  return session.iterations[session.iterations.length - 1].spec;
}

/** Every scenario blind and sensed at the gravity of `world`: 24 rollouts for twelve scenarios. */
export function scoreRollouts(scenarios: Scenario[], world: ScoreWorld): BatchRollout[] {
  return scenarios.flatMap((scenario) => MODES.map((mode) => ({ scenario, mode, gravity_g: GRAVITIES[world] })));
}

/** Passes per mode of one world's batch; a rollout that could not be set up counts as an error, never a pass. */
export function tally(results: (BatchResult | undefined)[], scenarios: number): Tally {
  const t: Tally = { blind: 0, sensed: 0, errors: 0, scenarios };
  for (const r of results) {
    if (!r) continue;
    if (!r.rollout) t.errors++;
    else if (r.rollout.pass) t[r.mode]++;
  }
  return t;
}
