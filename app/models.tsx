"use client";

import { useEffect, useState } from "react";
import type { LiveModels } from "@/app/api/models/route";
import { modelLabel } from "@/lib/providers/models";
import type { LedgerEntry } from "@/lib/spec/stage-result";

export type Role = keyof LiveModels;

/** what a line says before /api/models answers (it does on page load, well before any stage runs) */
const UNKNOWN: Record<Role, string> = { vl: "the vision model", nano: "the compiling model", super: "the reviewing model", ultra: "the largest model", stuck: "the deeper patcher" };

let asked: Promise<LiveModels | null> | undefined;

/** The model ID each role calls on this deployment (GET /api/models), read once per page; null until it answers. */
export function useLiveModels(): LiveModels | null {
  const [ids, setIds] = useState<LiveModels | null>(null);
  useEffect(() => {
    let alive = true;
    asked ??= fetch("/api/models")
      .then((r) => (r.ok ? (r.json() as Promise<LiveModels>) : null))
      .catch(() => null);
    asked.then((m) => alive && setIds(m));
    return () => {
      alive = false;
    };
  }, []);
  return ids;
}

/** The display name of the model each role calls, for the line a stage shows while it runs. */
export function useModels(): (role: Role) => string {
  const ids = useLiveModels();
  return (role) => (ids ? modelLabel(ids[role]) : UNKNOWN[role]);
}

/** The models that really answered, from a result's ledger ("Nemotron 3.5 Lightning"); Tavily's entries are searches, not models. */
export function answeredBy(ledger: LedgerEntry[] | undefined): string | undefined {
  const names = [...new Set((ledger ?? []).filter((e) => !e.model.startsWith("tavily/")).map((e) => modelLabel(e.model)))];
  return names.length ? names.join(" · ") : undefined;
}
