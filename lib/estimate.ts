/**
 * How long each stage of /try takes, from the times measured on 27 Oct 2026
 * (docs/MEASUREMENTS.md section 13): the deployed site and a local server,
 * the app's Chrome 152 browser on an Apple M4. The browser's proxy and the
 * model's watching grow with the clip; a compile does not. The page says
 * these beside a stage's clock ("usually 4 to 15 s") and adds them up front.
 */

export type Stage = "recorded" | "proxy" | "watch" | "trace" | "compile" | "notes";

type Range = readonly [number, number];

/** seconds = base + per_s × clip seconds, at the low and the high end of what was measured */
const MEASURED: Record<Exclude<Stage, "recorded">, { base: Range; per_s: Range }> = {
  // 0.1 to 1.4 s for 6 to 36 s at 720p, 0.4 to 0.5 s for 8 s at 1080p
  proxy: { base: [0.1, 1], per_s: [0.01, 0.04] },
  // upload and Super VL: 3.7 to 12.7 s for 8 s, 5.9 to 8.5 s for 10 s, 9.0 to 18.7 s for 36 s
  watch: { base: [3, 10], per_s: [0.15, 0.3] },
  // MediaPipe: 12 s for a 6 s wave, 50 s for 30 s of chess labelled as a gesture
  trace: { base: [3, 5], per_s: [1.2, 1.8] },
  // Nano: 1.5 to 4.6 s on the site; one call in 13 took 36 s in the recordings
  compile: { base: [1.5, 10], per_s: [0, 0] },
  // Super: 0.7 to 1.1 s for a cheap patch, 7.7 to 16.7 s once it thinks
  notes: { base: [1, 17], per_s: [0, 0] },
};

const at = (stage: keyof typeof MEASURED, d: number): Range => {
  const { base, per_s } = MEASURED[stage];
  return [base[0] + per_s[0] * d, base[1] + per_s[1] * d];
};

const up5 = (x: number) => Math.ceil(x / 5) * 5;

/** "usually 4 to 15 s" for a stage on a clip this long (10 s when unknown); nothing for a recording. */
export function usual(stage: Stage, duration_s: number | null): string | undefined {
  if (stage === "recorded") return undefined;
  const [lo, hi] = at(stage, duration_s ?? 10);
  return hi <= 5 ? "under 5 s" : `${Math.max(1, Math.floor(lo))} to ${up5(hi)} s`;
}

/** Up to the first program, for a clip of your own: the proxy, the watching and Nano's first compile. */
export function estimate(duration_s: number): string {
  const stages = ["proxy", "watch", "compile"] as const;
  const lo = stages.reduce((t, s) => t + at(s, duration_s)[0], 0);
  const hi = stages.reduce((t, s) => t + at(s, duration_s)[1], 0);
  return hi < 90 ? `${Math.max(5, Math.floor(lo / 5) * 5)} to ${up5(hi)} seconds` : `${Math.round(lo / 30) / 2 || 0.5} to ${Math.ceil(hi / 30) / 2} minutes`;
}
