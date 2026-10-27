"use client";

import { useEffect, useState } from "react";

type Health = { mode: "live" | "replay"; reason?: string; latency_ms?: number };

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
        live on Nebius Token Factory · {health.latency_ms} ms
      </span>
    );
  }
  return (
    <span
      className="rounded-full border border-amber-600 px-3 py-1 text-xs text-amber-700"
      title={health.reason}
    >
      replay mode
    </span>
  );
}
