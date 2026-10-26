/**
 * The patcher's prompts, shared by the live patch loop (patch-loop.test.ts) and the
 * fine-tune dataset builder (finetune-data.ts), which rebuilds every prompt a model saw
 * from the saved results. Change a prompt here and both follow; a change also makes the
 * saved results describe prompts that no longer exist, so re-run the arms.
 */
import { describeWorld, knobLines, type Knobs, PROBES, type ProbeId, type World } from "./patch-probes";

export const PATCH_SYSTEM = `You edit a small robot program after a failed rehearsal in a physics simulator. The program is a set of knobs with bounds. You get the task, the world, the knobs with their current values, the earlier attempts, and the simulator's failure note: what it measured in the failed rollout. Propose one patch: the knob values to change for the next rollout, the change most likely to make it pass. The success check is fixed and you cannot change it. Use only the listed knob names; keep numbers within bounds; booleans true or false; enum values exactly as listed.
Return one JSON object only: {"set":{<knob>:<value>,...},"why":<one sentence citing the measurement behind the change>,"expect":<one sentence: what the next rollout should show>}`;

export const PREFLIGHT_SYSTEM = `You set up a small robot program before its first rehearsal in a physics simulator. The program is a set of knobs with bounds, currently at their defaults. You get the task, the world and the knobs. If the defaults are likely to fail in this world, propose one patch: the knob values to change before the first rollout; otherwise return an empty set. Use only the listed knob names; keep numbers within bounds; booleans true or false; enum values exactly as listed.
Return one JSON object only: {"set":{<knob>:<value>,...},"why":<one sentence>,"expect":<one sentence: what the first rollout should show>}`;

export const PLAYBOOK_SYSTEM = `You maintain a playbook for a robot that rehearses short manipulation programs in a physics simulator under different gravities. You get repairs that worked: a program failed, a patch to its knobs made it pass. Write at most 8 general rules that a programmer could apply before the first rehearsal of these tasks in another world (another gravity, another disturbance). Each rule must be supported by the repairs: give the evidence (which probes and worlds, how many repairs). Prefer rules stated in physical terms (what to do when gravity is lower or absent, when the vehicle accelerates, when the object is offset) over rules that only restate one case.
Return one JSON object only: {"rules":[{"rule":string,"evidence":string}]}`;

export const PLAYBOOK_SYSTEM_V3 = `${PLAYBOOK_SYSTEM.split("\nReturn one JSON object only")[0]} Tag each rule with the one task it was learned on (insert, place, pour or carry), or "all" only when repairs on two or more tasks support it: a tagged rule is shown only for its task. All the repairs come from Earth 1 g and Mars 0.379 g; say in each rule what it assumes about gravity.
Return one JSON object only: {"rules":[{"task":"insert"|"place"|"pour"|"carry"|"all","rule":string,"evidence":string}]}`;

export type Rule = { rule: string; evidence: string; task?: string };
export type Book = { rules: Rule[]; version: number; empty?: boolean } | null;
/** the parts of a saved patch the next prompt reads */
export type PatchSeen = { set: Record<string, unknown> | null; rejected: string[]; clamps?: { name: string; requested: number; applied: number }[] };

/**
 * v1/v2: every rule for every task; v3: only the rules tagged with this task or "all", with the
 * gravity range they come from. empty: the matched control, the same section in the same places
 * (v3: only for the tasks that have rules) with "(none)" instead of the rules.
 */
export const rulesBlock = (rules: Rule[], probe: ProbeId, version: number, empty = false) => {
  const lines = (rs: Rule[]) => (empty ? "(none)" : rs.map((r, i) => `${i + 1}. ${r.rule}`).join("\n"));
  if (version < 3) return `Playbook (rules learned from earlier repairs on Earth and Mars):\n${lines(rules)}`;
  const mine = rules.filter((r) => r.task === probe || r.task === "all");
  return mine.length ? `Playbook for this task (rules learned from repairs at Earth 1 g and Mars 0.379 g only; untested in other gravities):\n${lines(mine)}` : null;
};

/** the factual one-liner of a note used in the attempt history */
export const outcomeLine = (note: string) => note.split("\n").find((l) => /^(Checks?|Count):/.test(l)) ?? note.split("\n").at(-1) ?? "";

const bookLines = (book: Book, probe: ProbeId) => {
  const b = book ? rulesBlock(book.rules, probe, book.version, book.empty) : null;
  return b ? [b] : [];
};

/** what happened to the last patch's values, for the next prompt (round 2: no more silent clamping) */
export function patchCheckLine(p: PatchSeen | undefined): string | null {
  if (!p) return null;
  const parts = [
    ...(p.clamps ?? []).map((c) => `${c.name} = ${c.requested} is outside its bounds and was clamped to ${c.applied}`),
    ...p.rejected.map((n) => `${n} was not applied (not a knob, or not a usable value)`),
  ];
  return parts.length ? `Your last patch: ${parts.join("; ")}.` : null;
}

/** one line per earlier attempt: the program (attempt 0) or the patch, and the check line of its note */
export const historyLine = (iter: number, knobs: Knobs, set: Record<string, unknown> | null | undefined, note: string, preflight = false) =>
  iter === 0 ? `- attempt 0${preflight ? " (after your set-up patch)" : ""}: ${JSON.stringify(knobs)} -> FAIL. ${outcomeLine(note)}` : `- attempt ${iter}: set ${JSON.stringify(set ?? {})} -> FAIL. ${outcomeLine(note)}`;

export function patchPrompt(probeId: ProbeId, world: World, knobs: Knobs, history: string[], note: string, attempt: number, book: Book, check: string | null, maxPatches: number): string {
  const probe = PROBES[probeId];
  return [
    `Task: ${probe.task}`,
    `World: ${describeWorld(world)}.`,
    ...bookLines(book, probeId),
    `Knobs (current values):\n${knobLines(probe, knobs)}`,
    `Attempts so far:\n${history.join("\n")}`,
    ...(check ? [check] : []),
    `Failure note from the last rollout (attempt ${attempt - 1}):\n${note}`,
    `Return patch ${attempt} of at most ${maxPatches}.`,
  ].join("\n\n");
}

/** the prompt that sends back a patch that changed nothing (arm super-off-retry) */
export const retryPrompt = (prompt: string, set: Record<string, unknown> | null) =>
  `${prompt}\n\nYour patch ${JSON.stringify(set ?? {})} changes no knob value: the next rollout would repeat the last one exactly. Propose a different change.`;

export function preflightPrompt(probeId: ProbeId, world: World, knobs: Knobs, book: Book): string {
  const probe = PROBES[probeId];
  return [`Task: ${probe.task}`, `World: ${describeWorld(world)}.`, ...bookLines(book, probeId), `Knobs (defaults):\n${knobLines(probe, knobs)}`, "No rollout has run yet. Return the patch to apply before the first rollout (an empty set keeps the defaults)."].join("\n\n");
}
