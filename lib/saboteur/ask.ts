/**
 * The one patching-model call behind /api/saboteur, and what the route
 * answers whatever the model does: the model's twelve when they pass
 * `scenarioProblems` (it is asked once more with the problems when they do
 * not, by callModel), else the twelve built from the spec with no model,
 * with the reason. So the grid always has twelve to run.
 */
import type OpenAI from "openai";
import { z } from "zod";
import { callModel, type CallOptions } from "@/lib/providers/call";
import { Scenario, type TaskSpec } from "@/lib/spec/schema";
import { done, failed, type LedgerEntry, type StageResult } from "@/lib/spec/stage-result";
import type { Normalizer } from "@/lib/spec/parse";
import { fallbackScenarios, focusOf, forGrid, SCENARIO_COUNT, scenarioProblems, type Focus } from "./grid";
import { SABOTEUR_SYSTEM, userMessage } from "./prompt";

export const SaboteurReply = z.object({ scenarios: z.array(Scenario).max(40) });
export type SaboteurReply = z.infer<typeof SaboteurReply>;

/** What the page runs: twelve scenarios, who wrote them, and the step and band they are about. */
export const SaboteurPlan = z.object({
  scenarios: z.array(Scenario),
  /** "model": the patching model wrote them; "spec": built from the spec with no model */
  source: z.enum(["model", "spec"]),
  focus: z.object({ step_id: z.string(), object: z.string(), target: z.string(), fixture: z.string(), band_mm: z.number(), band_from: z.string() }),
});
export type SaboteurPlan = z.infer<typeof SaboteurPlan>;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Near-misses seen from JSON-mode models: a bare list, a missing name or expectation, an offset written as text. */
export const normalizeReply: Normalizer = (raw) => {
  const warnings: string[] = [];
  const list = Array.isArray(raw) ? raw : isRec(raw) && Array.isArray(raw.scenarios) ? raw.scenarios : null;
  if (!list) return { data: raw, warnings };
  const scenarios = list.map((s) => {
    if (!isRec(s)) return s;
    const out: Record<string, unknown> = { ...s };
    if (typeof out.offset === "string" && Number.isFinite(Number(out.offset))) out.offset = Number(out.offset);
    if (out.name === undefined && typeof out.id === "string") out.name = out.id;
    if (!["pass", "fail", "unknown"].includes(out.expected as string)) out.expected = "unknown";
    if (out.tilt_axis !== undefined && out.axis !== "tilt_deg") delete out.tilt_axis;
    delete out.gravity_g; // gravity is the page's to set
    return out;
  });
  return { data: { scenarios }, warnings };
};

const focusJson = (f: Focus): SaboteurPlan["focus"] => ({ step_id: f.step_id, object: f.object.id, target: f.target.id, fixture: f.fixture, band_mm: f.band_mm, band_from: f.band_from });

export function saboteurCall(spec: TaskSpec, focus: Focus): CallOptions<SaboteurReply> {
  return {
    role: "super",
    system: SABOTEUR_SYSTEM,
    user: userMessage(spec, focus),
    maxTokens: 2500,
    schema: SaboteurReply,
    normalize: normalizeReply,
    shape: `{"scenarios":[{"id","name","axis","offset","object","tilt_axis"?,"expected","why"}]} with exactly 12 entries`,
    check: (reply) => scenarioProblems(spec, forGrid(reply.scenarios)),
  };
}

/** The twelve built from the spec, with `why` first among the warnings; failed only when the spec has nothing to perturb. */
export function fromSpec(spec: TaskSpec, why: string[], ledger?: LedgerEntry[]): StageResult<SaboteurPlan> {
  const focus = focusOf(spec);
  if (!focus) return failed("the spec has no step that puts an object somewhere, so there is nothing for the saboteur to perturb", false);
  const scenarios = forGrid(fallbackScenarios(spec));
  // the builder checks every world it adds; a spec with too little to vary still says how many it found
  if (scenarios.length < SCENARIO_COUNT) why = [...why, `only ${scenarios.length} scenarios could be built from this spec`];
  return done({ scenarios, source: "spec", focus: focusJson(focus) }, [...why, `the ${scenarios.length} scenarios are built from the spec, with no model`], ledger);
}

/** A reply (live or recorded) as the plan the page runs: the model's twelve if they pass every check, else the spec's. */
export function planOf(spec: TaskSpec, result: StageResult<SaboteurReply>, extra: string[] = []): StageResult<SaboteurPlan> {
  const focus = focusOf(spec);
  if (!focus) return fromSpec(spec, extra);
  const ledger = result.status === "done" ? result.ledger : undefined;
  if (result.status !== "done") return fromSpec(spec, [...extra, `the model gave no scenarios (${result.status === "failed" ? result.message : result.status})`], ledger);
  const scenarios = forGrid(result.value.scenarios);
  const problems = scenarioProblems(spec, scenarios);
  if (problems.length) return fromSpec(spec, [...extra, `the model's scenarios still had problems after one more ask: ${problems.slice(0, 3).join("; ")}`], ledger);
  return done({ scenarios, source: "model", focus: focusJson(focus) }, [...extra, ...result.warnings], ledger);
}

/** `ledger` receives every billed call, the ones of a failed answer included; `signal` stops the calls at the route's deadline. */
export async function askSaboteur(client: OpenAI, spec: TaskSpec, ledger: LedgerEntry[] = [], signal?: AbortSignal): Promise<StageResult<SaboteurReply>> {
  const focus = focusOf(spec);
  if (!focus) return failed("nothing to perturb", false);
  return callModel(client, { ...saboteurCall(spec, focus), ledger, signal });
}
