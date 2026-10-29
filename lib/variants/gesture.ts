/**
 * Similar tasks for a spec of gestures alone (#132), built from the traced
 * path with no model: the same path on the arm's other side (mirrored about
 * the centre of the box it is drawn in), slower (every point later), and
 * bigger (scaled about the path's own centre, then fitted to the box; a path
 * that already fills the box is made smaller instead, and the card says why).
 * Each is a change to the step's gesture block alone, rehearsed like any
 * variant, and its program is written by the compile route with no model
 * either (lib/sim/gesture.ts gestureProgram). Code never names a gesture: the
 * label does.
 */
import { BOX_Y_MM, BOX_Z_MM } from "@/lib/sim/gesture";
import type { PathPoint, SpecChange, Step, TaskSpec } from "@/lib/spec/schema";
import { MAX_VARIANTS, type NotYet } from "./parse";
import type { Checked, Variant } from "./validate";

/**
 * Slower: this many times slower than the arm can follow the clip at all. The arm is held to 2 rad/s a joint
 * (lib/sim/interpreter.ts FOLLOW_JOINT_RAD_S), so it already follows a quick path slower than the clip, and only
 * a path slower than that changes what it does. How fast it can follow is worked out from the hand's speed, with
 * no simulator here: FOLLOW_MM_S below. The card says at what speed the arm followed, against the clip.
 */
export const SLOWER = 1.5;
/**
 * The hand speed along the path (mm/s) the arm keeps up with under that cap, measured in the rehearsal: iss-wave's
 * path peaks at 800 mm/s and was followed at 0.46x (370 mm/s), tests/sim/follow.test.ts's swing peaks at 1,484 mm/s
 * and was followed at 0.26x (380 mm/s). Taken lower, so a slower path is slower than the arm's own pace.
 */
export const FOLLOW_MM_S = 300;
/** Bigger: this many times as large, at most; smaller, when there is no room for bigger. */
export const BIGGER = 1.5;
export const SMALLER = 0.6;
/** Bigger by less than this is not worth a rehearsal: the path nearly fills the box already. */
const MIN_GROWTH = 1.1;
/** A path whose mirror image is within this of it everywhere (mm) is its own mirror. */
const SAME_MM = 2;

export const GESTURE_VARIANTS_NOTE = "every step is a gesture: its similar tasks are built from the traced path, with no model";

/** to 0.1, and never -0 */
const r1 = (x: number) => Math.round(x * 10) / 10 || 0;
const [Y0, Y1] = BOX_Y_MM;
const [Z0, Z1] = BOX_Z_MM;

export const gesturesOnly = (spec: TaskSpec) => spec.steps.length > 0 && spec.steps.every((s) => s.verb === "gesture");

/** The other side: y mirrored about the centre of the box, so the path stays inside it. */
export function mirrorPath(path: PathPoint[]): PathPoint[] {
  const c = (Y0 + Y1) / 2;
  return path.map((p) => ({ t_s: p.t_s, xyz_mm: [p.xyz_mm[0], r1(2 * c - p.xyz_mm[1]), p.xyz_mm[2]] }));
}

/** Every point `k` times later, unrounded, so times that moved forward still do. */
export function timeScale(path: PathPoint[], k: number): PathPoint[] {
  if (!(k >= 1)) throw new Error(`a time scale under 1 can run two points together: ${k}`);
  return path.map((p) => ({ t_s: p.t_s * k, xyz_mm: p.xyz_mm }));
}

const span = (xs: number[]) => [Math.min(...xs), Math.max(...xs)] as const;

/** The fastest the hand moves along a path between two points, mm/s. */
export function peakSpeed(path: PathPoint[]): number {
  return Math.max(0, ...path.slice(1).map((q, k) => Math.hypot(q.xyz_mm[0] - path[k].xyz_mm[0], q.xyz_mm[1] - path[k].xyz_mm[1], q.xyz_mm[2] - path[k].xyz_mm[2]) / (q.t_s - path[k].t_s)));
}

/** How many times later every point of a slower path is: SLOWER times what the arm needs to keep up, if it needs more time at all. */
export function slowerFactor(paths: PathPoint[][]): number {
  return Math.round(SLOWER * Math.max(1, ...paths.map((p) => peakSpeed(p) / FOLLOW_MM_S)) * 10) / 10;
}

/**
 * The path scaled by up to `k` about the centre of its extent in y and z,
 * then fitted to the arm's box: the factor shrinks until the path fits, and
 * the path shifts back inside where it pokes out. Returns the factor used.
 */
export function sizeScale(path: PathPoint[], k: number): { path: PathPoint[]; k: number } {
  const [y0, y1] = span(path.map((p) => p.xyz_mm[1]));
  const [z0, z1] = span(path.map((p) => p.xyz_mm[2]));
  const fit = Math.min(k, y1 > y0 ? (Y1 - Y0) / (y1 - y0) : Infinity, z1 > z0 ? (Z1 - Z0) / (z1 - z0) : Infinity);
  const [cy, cz] = [(y0 + y1) / 2, (z0 + z1) / 2];
  // where the scaled extent pokes out of the box, the shift that brings it back
  const back = (lo: number, hi: number, c: number, a: number, b: number) => {
    const [l, h] = [c + (a - c) * fit, c + (b - c) * fit];
    return l < lo ? lo - l : h > hi ? hi - h : 0;
  };
  const [dy, dz] = [back(Y0, Y1, cy, y0, y1), back(Z0, Z1, cz, z0, z1)];
  return {
    path: path.map((p) => ({ t_s: p.t_s, xyz_mm: [p.xyz_mm[0], r1(cy + (p.xyz_mm[1] - cy) * fit + dy), r1(cz + (p.xyz_mm[2] - cz) * fit + dz)] })),
    k: Math.round(fit * 100) / 100,
  };
}

type Gesture = NonNullable<Step["gesture"]>;

/** A gesture in words, for the card: its points, how long, how wide and high, and where its middle is. */
export function gestureText(g: Gesture): string {
  if (g.path.length === 0) return "no path";
  const [y0, y1] = span(g.path.map((p) => p.xyz_mm[1]));
  const [z0, z1] = span(g.path.map((p) => p.xyz_mm[2]));
  const mid = r1((y0 + y1) / 2);
  const side = mid > 1 ? `, ${Math.round(mid)} mm to the arm's left` : mid < -1 ? `, ${Math.round(-mid)} mm to the arm's right` : "";
  return `${g.path.length} points over ${g.path.at(-1)!.t_s.toFixed(1)} s, ${Math.round(y1 - y0)} × ${Math.round(z1 - z0)} mm${side}${g.hand ? `, the ${g.hand} hand` : ""}`;
}

type Idea = { title: string; summary: string; gesture: (g: Gesture) => Gesture };

/** A step whose path the variants change: two points or more, and a hand that moved. */
function moves(s: Step): boolean {
  const path = s.gesture?.path ?? [];
  if (s.verb !== "gesture" || path.length < 2) return false;
  const [y0, y1] = span(path.map((p) => p.xyz_mm[1]));
  const [z0, z1] = span(path.map((p) => p.xyz_mm[2]));
  return y1 > y0 || z1 > z0;
}

/**
 * How many times faster than the clip each step's path in `spec` is played, against the same step in `base`:
 * a slower variant's 1/3. The rehearsal reports the speed it followed at against the path it was given; times
 * this, the card says it against the clip.
 */
export function clipPace(base: TaskSpec, spec: TaskSpec): Record<string, number> {
  return Object.fromEntries(
    spec.steps.flatMap((s) => {
      const [was, now] = [base.steps.find((b) => b.id === s.id)?.gesture?.path.at(-1)?.t_s, s.gesture?.path.at(-1)?.t_s];
      return was && now ? [[s.id, was / now]] : [];
    }),
  );
}

/** The ideas for this spec's paths, and why one is not offered. */
function ideas(spec: TaskSpec): { ideas: Idea[]; not_yet: NotYet[] } {
  const steps = spec.steps.filter(moves);
  const not_yet: NotYet[] = [];
  const out: Idea[] = [];
  if (steps.length === 0) return { ideas: out, not_yet: [{ idea: "A similar gesture", why: "no traced path where the hand moved: there is nothing to mirror, slow or scale" }] };
  const own = steps.every((s) => mirrorPath(s.gesture!.path).every((p, i) => Math.abs(p.xyz_mm[1] - s.gesture!.path[i].xyz_mm[1]) <= SAME_MM));
  if (own) not_yet.push({ idea: "The other side", why: "the path is its own mirror image: on the other side the arm would do the same" });
  else
    out.push({
      title: "The other side",
      summary: "The same path mirrored to the arm's other side, as the other hand would do it.",
      gesture: (g) => ({ ...g, path: mirrorPath(g.path), ...(g.hand ? { hand: g.hand === "left" ? ("right" as const) : ("left" as const) } : {}) }),
    });
  const long = Math.max(...steps.map((s) => s.gesture!.path.at(-1)!.t_s));
  const slow = slowerFactor(steps.map((s) => s.gesture!.path));
  out.push({
    title: "Slower",
    summary: `The same path ${slow}x slower than the clip: ${long.toFixed(1)} s becomes ${(long * slow).toFixed(1)} s, slower than the arm can follow the clip itself.`,
    gesture: (g) => ({ ...g, path: timeScale(g.path, slow) }),
  });
  const grow = Math.min(...steps.map((s) => sizeScale(s.gesture!.path, BIGGER).k));
  const box = `${Y1 - Y0} × ${Z1 - Z0} mm`;
  if (grow >= MIN_GROWTH) {
    out.push({ title: "Bigger", summary: `The same path ${grow.toFixed(2)}x as large, still inside the ${box} the arm reaches in front of it.`, gesture: (g) => ({ ...g, path: sizeScale(g.path, grow).path }) });
  } else {
    not_yet.push({ idea: "Bigger", why: `the path already fills the ${box} the arm reaches in front of it` });
    out.push({ title: "Smaller", summary: `The same path at ${SMALLER}x the size: it already fills the ${box} the arm reaches, so it cannot grow.`, gesture: (g) => ({ ...g, path: sizeScale(g.path, SMALLER).path }) });
  }
  return { ideas: out, not_yet };
}

/** The similar tasks of a spec of gestures alone, numbered from `first`, ready for /api/compile. */
export function gestureVariants(base: TaskSpec, first = 1): Checked {
  const { ideas: list, not_yet } = ideas(base);
  const variants: Variant[] = list.slice(0, MAX_VARIANTS).map((idea, i) => {
    const id = `variant#${first + i}`;
    const spec = structuredClone(base);
    spec.title = `${base.title}: ${idea.title}`;
    spec.summary = idea.summary;
    const changes: SpecChange[] = [];
    for (const s of spec.steps) {
      if (!moves(s)) continue;
      s.gesture = idea.gesture(s.gesture!);
      s.sources = { ...s.sources, gesture: id };
      changes.push({ path: `steps[${s.id}].gesture`, value: s.gesture, source: id });
    }
    const edits = changes.map((c) => ({ path: c.path, before: base.steps.find((b) => `steps[${b.id}].gesture` === c.path)?.gesture, after: c.value }));
    return { id, title: idea.title, summary: idea.summary, changes, edits, spec, warnings: [] };
  });
  return { variants, not_yet };
}
