/**
 * What the reshoot list is written from, as the page last saw it: the
 * compiled program's rehearsal in every world (app/rehearsal.tsx) and each
 * patch the loop tried after it (app/patch-loop.tsx). A small store the
 * reshoot section reads (app/reshoot.tsx), so the stages that produce the
 * evidence do not have to hand it up through the page. A new rehearsal
 * starts it again; a patch for another program is ignored.
 */
import type { WorldRun } from "@/lib/notes/note";
import type { Program } from "@/lib/spec/schema";
import type { PatchTried } from "./reshoot";

export type Evidence = { program: Program; runs: WorldRun[]; patches: PatchTried[] };

let current: Evidence | null = null;
const listeners = new Set<() => void>();

function set(next: Evidence | null) {
  current = next;
  for (const l of listeners) l();
}

/** A rehearsal of `program` in every world: the patches heard before are stale. */
export function rehearsed(program: Program, runs: WorldRun[]) {
  set({ program, runs, patches: [] });
}

/** The patch loop starts again from `program`: its earlier patches are gone. */
export function patchesRestarted(program: Program) {
  if (current?.program === program && current.patches.length) set({ ...current, patches: [] });
}

/** One patch of `program` the loop tried, with its outcome. */
export function patched(program: Program, p: PatchTried) {
  if (current?.program !== program) return;
  set({ ...current, patches: [...current.patches.filter((x) => x.n !== p.n), p] });
}

export const evidence = () => current;

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests. */
export const forgetEvidence = () => set(null);
