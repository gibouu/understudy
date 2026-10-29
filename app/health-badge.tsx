"use client";

import { useEffect, useState } from "react";

type Health = { mode: "live" | "replay"; reason?: string; latency_ms?: number; budget?: { cap_usd: number; left_usd: number } };

/** "$212 of $250 left" for the live budget (lib/unlock/budget.ts) */
const left = (b: NonNullable<Health["budget"]>) => `$${Math.floor(b.left_usd)} of $${b.cap_usd} left`;

export function HealthBadge() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health", { signal: AbortSignal.timeout(25_000) })
      .then((r) => r.json() as Promise<Health>)
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch((err: unknown) => {
        if (!cancelled) setHealth({ mode: "replay", reason: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!health) {
    return <span className="rounded-full border px-3 py-1 text-xs text-neutral-500">checking Token Factory…</span>;
  }
  if (health.mode === "live") {
    return (
      <span className="rounded-full border border-emerald-600 px-3 py-1 text-xs text-emerald-700">
        live on Nebius Token Factory · {health.latency_ms} ms{health.budget && ` · ${left(health.budget)}`}
      </span>
    );
  }
  return (
    <span
      className="rounded-full border border-amber-600 px-3 py-1 text-xs text-amber-700"
      title={health.reason}
    >
      replay mode{health.budget && health.budget.left_usd <= 0 ? " · the live budget for judging is spent" : ""}
    </span>
  );
}
