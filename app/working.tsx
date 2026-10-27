"use client";

import { useEffect, useState } from "react";

/**
 * The line under a stage that is still running: what it is doing and why, the
 * seconds since it began, and how long it usually takes, so a slow stage never
 * looks frozen. `since` is Date.now() when the stage began; a new line for the
 * same stage (a frame count, say) keeps the clock running.
 */
export function Working({ note, since, usual }: { note: string; since: number; usual?: string }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [since]);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <p className="text-sm text-neutral-600" role="status">
      <span className="animate-pulse">{note}…</span>{" "}
      <span className="whitespace-nowrap tabular-nums text-neutral-500">
        {s} s{usual ? `, usually ${usual}` : ""}
      </span>
    </p>
  );
}
