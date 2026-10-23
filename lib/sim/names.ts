/** Pure helpers shared by the worker and the tests. */
import type { Waypoint } from "./protocol";

/** MuJoCo stores all names in one NUL-separated byte buffer; `adr` is the start offset. */
export function decodeName(names: ArrayLike<number>, adr: number): string {
  if (adr < 0 || adr >= names.length) return "";
  let end = adr;
  while (end < names.length && names[end] !== 0) end++;
  let s = "";
  for (let i = adr; i < end; i++) s += String.fromCharCode(names[i]);
  return s;
}

/** Linear interpolation between waypoints; clamps before the first and after the last. */
export function sampleWaypoints(waypoints: Waypoint[], t: number): number[] {
  if (waypoints.length === 0) return [];
  if (t <= waypoints[0].t) return [...waypoints[0].q];
  const last = waypoints[waypoints.length - 1];
  if (t >= last.t) return [...last.q];
  let i = 1;
  while (i < waypoints.length && waypoints[i].t < t) i++;
  const a = waypoints[i - 1];
  const b = waypoints[i];
  const span = b.t - a.t;
  const u = span > 0 ? (t - a.t) / span : 1;
  return a.q.map((qa, k) => qa + (b.q[k] - qa) * u);
}

/** Bindings expose numeric fields as typed-array views or as vector handles; read either. */
export function toNumbers(view: unknown): ArrayLike<number> {
  if (ArrayBuffer.isView(view)) return view as unknown as ArrayLike<number>;
  const v = view as { size?: () => number; get?: (i: number) => number | undefined };
  if (typeof v?.size === "function" && typeof v?.get === "function") {
    const n = v.size();
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = v.get(i) ?? 0;
    return out;
  }
  if (Array.isArray(view)) return view as number[];
  return [];
}
