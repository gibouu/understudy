/**
 * A ceiling on live requests per route per minute (one request may make a few
 * model calls), behind the unlock code and the sample token. A request the
 * ceiling turns away replays. The count lives in this function instance's memory:
 * Vercel runs several instances under load and starts fresh ones, so the
 * ceiling bounds one instance, not the deployment. It applies on Vercel
 * deployments only; local runs and tests are not counted.
 */
export const LIVE_PER_MINUTE = { label: 8, compile: 40, notes: 20, variants: 12, ground: 8 } as const;

export type LiveRoute = keyof typeof LIVE_PER_MINUTE;

const WINDOW_MS = 60_000;
const recent = new Map<LiveRoute, number[]>();

/** A Vercel deployment, production or preview; local runs and tests are not one. */
export const deployed = () => process.env.VERCEL_ENV === "production" || process.env.VERCEL_ENV === "preview";

/** Takes one of the route's live calls for this minute; false when they are all taken. */
export function takeLiveCall(route: LiveRoute, now = Date.now()): boolean {
  if (!deployed()) return true;
  const calls = (recent.get(route) ?? []).filter((t) => now - t < WINDOW_MS);
  const ok = calls.length < LIVE_PER_MINUTE[route];
  if (ok) calls.push(now);
  recent.set(route, calls);
  return ok;
}

/** For tests: forget every call counted so far. */
export const forgetLiveCalls = () => recent.clear();
