"use client";

/**
 * Which program last passed the rehearsal on Earth and in orbit, per program the rehearsal was given: the program
 * itself or a patch of it. app/rehearsal.tsx reports it, app/saboteur.tsx reads it, so the page between them
 * (app/flow.tsx) passes nothing along.
 */
import { useSyncExternalStore } from "react";
import type { Program } from "@/lib/spec/schema";

const passed = new WeakMap<Program, Program>();
const listeners = new Set<() => void>();
let version = 0;

export function reportPassed(base: Program, ran: Program) {
  if (passed.get(base) === ran) return;
  passed.set(base, ran);
  version++;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
const current = () => version;
const initial = () => 0;

/** The program that passed for `base`, or null until one has. */
export function usePassed(base: Program): Program | null {
  useSyncExternalStore(subscribe, current, initial);
  return passed.get(base) ?? null;
}
