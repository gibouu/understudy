/**
 * Similar tasks for a gesture (#132): the three path transforms, the variants
 * built from the iss-wave recording's traced path with no model, and each
 * rehearsed on Earth and in orbit with the reach check.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as compileRoute } from "@/app/api/compile/route";
import { POST as variantsRoute } from "@/app/api/variants/route";
import { baseOf } from "@/lib/showcase/prerun";
import { loadEngine, rollout, type Engine } from "@/lib/showcase/rehearse";
import { Session } from "@/lib/showcase/session";
import { BOX_Y_MM, BOX_Z_MM, gestureProgram, PLANE_X_MM, scalePath, type HandSample } from "@/lib/sim/gesture";
import type { PathPoint, Program, TaskSpec } from "@/lib/spec/schema";
import type { StageResult } from "@/lib/spec/stage-result";
import { clipPace, GESTURE_VARIANTS_NOTE, gestureVariants, mirrorPath, peakSpeed, sizeScale, SLOWER, slowerFactor, timeScale } from "@/lib/variants/gesture";
import { buildVariant, physicalKey, type Checked } from "@/lib/variants/validate";
import { issBase } from "./harness";

const pt = (t_s: number, y: number, z: number): PathPoint => ({ t_s, xyz_mm: [PLANE_X_MM, y, z] });
const gestureSpec = (path: PathPoint[]): TaskSpec => ({
  title: "a gesture",
  summary: "",
  objects: [],
  steps: [{ id: "s1", verb: "gesture", gesture: { path, reach_mm: 5 }, via_points: [], preconditions: [], success: [], tolerances: {}, t_start_s: 0, t_end_s: 1, source: "vl#0", sources: {} }],
  open_questions: [],
  source: "vl#0",
} as unknown as TaskSpec);
const inBox =(p: PathPoint[]) => p.every(({ xyz_mm: [, y, z] }) => y >= BOX_Y_MM[0] - 0.05 && y <= BOX_Y_MM[1] + 0.05 && z >= BOX_Z_MM[0] - 0.05 && z <= BOX_Z_MM[1] + 0.05);

describe("the path transforms", () => {
  const small = [pt(0, -40, 240), pt(0.5, 10, 260), pt(1, 30, 250)];

  it("mirrors a path to the arm's other side about the box's centre, keeping its times and height", () => {
    expect(mirrorPath(small)).toEqual([pt(0, 40, 240), pt(0.5, -10, 260), pt(1, -30, 250)]);
    expect(mirrorPath(mirrorPath(small))).toEqual(small);
  });

  it("slows a path down by making every point later, and refuses to speed one up", () => {
    expect(timeScale(small, 1.5).map((p) => p.t_s)).toEqual([0, 0.75, 1.5]);
    expect(timeScale(small, 1.5).map((p) => p.xyz_mm)).toEqual(small.map((p) => p.xyz_mm));
    expect(() => timeScale(small, 0.5)).toThrow(/under 1/);
    // times a tenth of a millisecond apart stay apart
    const close = timeScale([pt(0, 0, 250), pt(0.0001, 1, 250), pt(1, 2, 250)], 3).map((p) => p.t_s);
    expect(close[1]).toBeGreaterThan(close[0]);
    expect(close[2]).toBeGreaterThan(close[1]);
  });

  it("offers nothing for a path where the hand did not move, and says why", () => {
    const still = { ...gestureSpec([pt(0, 10, 250), pt(1, 10, 250)]) };
    const r = gestureVariants(still);
    expect(r.variants).toEqual([]);
    expect(r.not_yet[0].why).toMatch(/hand moved/);
    expect(gestureVariants(gestureSpec([pt(0, 10, 250)])).variants).toEqual([]);
  });

  it("says a slowed path's pace against the clip", () => {
    const s = gestureSpec(small);
    const slower = gestureVariants(s).variants.find((v) => v.title === "Slower")!;
    expect(clipPace(s, slower.spec).s1).toBeCloseTo(1 / SLOWER, 6);
    expect(clipPace(s, s).s1).toBe(1);
  });

  it("grows a path about its own centre, then shrinks and shifts it to stay in the box", () => {
    // 70 x 20 mm, centred at (-5, 250): 1.5x fits
    const big = sizeScale(small, 1.5);
    expect(big.k).toBe(1.5);
    expect(big.path.map((p) => p.xyz_mm)).toEqual([[PLANE_X_MM, -57.5, 235], [PLANE_X_MM, 17.5, 265], [PLANE_X_MM, 47.5, 250]]);
    // a path as wide as the box cannot grow
    const wide = [pt(0, -120, 250), pt(1, 120, 260)];
    expect(sizeScale(wide, 1.5).k).toBe(1);
    // near the top of the box: it grows, then comes down inside
    const high = [pt(0, -20, 300), pt(1, 20, 330)];
    const grown = sizeScale(high, 2);
    expect(grown.k).toBe(2);
    expect(inBox(grown.path)).toBe(true);
    expect(Math.max(...grown.path.map((p) => p.xyz_mm[2])) - Math.min(...grown.path.map((p) => p.xyz_mm[2]))).toBeCloseTo(60, 5);
    // smaller, about its centre
    expect(sizeScale(small, 0.5).path.map((p) => p.xyz_mm[1])).toEqual([-22.5, 2.5, 12.5]);
  });
});

describe("similar tasks of the iss-wave recording", () => {
  let engine: Engine;
  let base: TaskSpec;
  let program: Program;
  beforeAll(async () => {
    engine = await loadEngine();
    const rec = Session.parse(JSON.parse(readFileSync(path.join(process.cwd(), "public/showcase/iss-wave.json"), "utf8")));
    ({ spec: base, program } = baseOf(rec));
  }, 60_000);

  it("offers the other side, slower and bigger (or smaller, when the path fills the box), built with no model", () => {
    const { variants, not_yet } = gestureVariants(base, 4);
    expect(variants.map((v) => v.id)).toEqual(["variant#4", "variant#5", "variant#6"]);
    expect(variants.map((v) => v.title).slice(0, 2)).toEqual(["The other side", "Slower"]);
    expect(["Bigger", "Smaller"]).toContain(variants[2].title);
    if (variants[2].title === "Smaller") expect(not_yet.map((n) => n.idea)).toEqual(["Bigger"]);
    const keys = new Set([physicalKey(base), ...variants.map((v) => physicalKey(v.spec))]);
    expect(keys.size).toBe(4);
    for (const v of variants) {
      expect(v.edits.map((e) => e.path)).toEqual(["steps[s1].gesture"]);
      expect(v.spec.steps[0].sources.gesture).toBe(v.id);
      expect(v.spec.title).toBe(`${base.title}: ${v.title}`);
      expect(inBox(v.spec.steps[0].gesture!.path)).toBe(true);
    }
    const [mirror, slower] = variants;
    expect(mirror.spec.steps[0].gesture!.path).toEqual(mirrorPath(base.steps[0].gesture!.path));
    const k = slowerFactor([base.steps[0].gesture!.path]);
    // the wave peaks at 800 mm/s: the arm needs about 2.2 times the clip's time, and the slower one gets 1.5 times that
    expect(k).toBe(4);
    expect(slower.spec.steps[0].gesture!.path.at(-1)!.t_s).toBeCloseTo(base.steps[0].gesture!.path.at(-1)!.t_s * k, 2);
  });

  it("answers from /api/variants with no model, live or replayed, and a line gets no variant", async () => {
    const post = (body: unknown) => variantsRoute(new Request("http://test/api/variants?replay=1", { method: "POST", body: JSON.stringify(body) })).then((r) => r.json() as Promise<StageResult<Checked>>);
    const r = await post({ spec: base, first: 6 });
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(r.warnings).toEqual([GESTURE_VARIANTS_NOTE]);
    expect(r.ledger ?? []).toEqual([]);
    expect(r.value.variants.length).toBe(3);
    const line = await post({ spec: base, request: "wave with both hands" });
    expect(line.status === "done" && line.value.variants).toEqual([]);
  });

  it("rehearses each on Earth and in orbit, following the path within reach, and the slower one takes longer", async () => {
    const before = rollout(engine, base, program, "earth");
    expect(before.pass).toBe(true);
    for (const v of gestureVariants(base).variants) {
      const res = await compileRoute(new Request("http://test/api/compile?replay=1", { method: "POST", body: JSON.stringify({ spec: v.spec, previous: program }) }));
      const c = (await res.json()) as StageResult<Program>;
      expect(c.status, v.title).toBe("done");
      if (c.status !== "done") continue;
      for (const world of ["earth", "orbit"] as const) {
        const r = rollout(engine, v.spec, c.value, world);
        expect(r.followed?.length, `${v.title} ${world}`).toBe(1);
        expect(r.pass, `${v.title} ${world}: ${r.why}`).toBe(true);
        // the arm is speed-capped and already followed the clip slower than its own pace: slower must still show
        if (v.title === "Slower") expect(r.t).toBeGreaterThan(before.t * 1.15);
      }
    }
  }, 240_000);

  it("slows a quicker path by more, so the arm still does it slower than the task above", () => {
    // tests/sim/follow.test.ts's swing: twice a second, 12 cm either way; the arm follows it at 0.26x
    const samples: HandSample[] = Array.from({ length: 41 }, (_, i) => ({ t_s: i / 10, x_m: 0.12 * Math.sin(4 * Math.PI * (i / 10)), y_m: -0.4 - 0.03 * Math.abs(Math.cos(4 * Math.PI * (i / 10))) }));
    const swing = gestureSpec(scalePath(samples, 0.6).path);
    expect(peakSpeed(swing.steps[0].gesture!.path)).toBeGreaterThan(1400);
    const slower = gestureVariants(swing).variants.find((v) => v.title === "Slower")!;
    const before = rollout(engine, swing, gestureProgram(swing)!, "earth");
    const after = rollout(engine, slower.spec, gestureProgram(slower.spec)!, "earth");
    expect(before.pass && after.pass).toBe(true);
    expect(after.followed![0].speed).toBe(1);
    expect(after.t).toBeGreaterThan(before.t * 1.15);
  }, 120_000);

  it("never turns a task that puts an object somewhere into a gesture, nor lets one claim to wave", async () => {
    const iss = (await issBase()).spec;
    expect(buildVariant(iss, { title: "Gesture instead", summary: "", changes: [{ path: "steps[s2].verb", value: "gesture" }] }, 1)).toEqual({ why: "a task keeps its kind: its variants keep one grasp and then one insert or place and never turn into a gesture" });
    expect(buildVariant(iss, { title: "Wave it in", summary: "", changes: [{ path: "objects[obj2].pocket_clearance_mm", value: 4 }] }, 1)).toEqual({ why: 'this task has no gesture: "wave" is not part of it; its variants keep one grasp and then one insert or place' });
  });
});
