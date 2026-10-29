import { describe, expect, it } from "vitest";
import { ARM_MM, BOX_Y_MM, BOX_Z_MM, describeReach, gestureProgram, MAX_LAG_S, MAX_STRETCH, MAX_POINTS, speedText, PLANE_X_MM, pathMarkersXml, reachCheck, scalePath, type HandSample, type TraceSample } from "@/lib/sim/gesture";
import { TaskSpec, type PathPoint } from "@/lib/spec/schema";

/** A wrist swinging side to side at `hz`, `amp_m` either way, 10 samples a second, around (x0, y0) metres. */
function swing(amp_m: number, hz: number, secs: number, x0 = 0.3, y0 = -0.4): HandSample[] {
  const out: HandSample[] = [];
  for (let k = 0; k <= secs * 10; k++) {
    const t = k / 10;
    out.push({ t_s: 2 + t, x_m: x0 + amp_m * Math.sin(2 * Math.PI * hz * t), y_m: y0 - 0.25 * amp_m * Math.abs(Math.cos(2 * Math.PI * hz * t)) });
  }
  return out;
}

const span = (path: PathPoint[], k: 0 | 1 | 2) => Math.max(...path.map((p) => p.xyz_mm[k])) - Math.min(...path.map((p) => p.xyz_mm[k]));
const inBox = (p: PathPoint) => p.xyz_mm[1] >= BOX_Y_MM[0] - 1e-6 && p.xyz_mm[1] <= BOX_Y_MM[1] + 1e-6 && p.xyz_mm[2] >= BOX_Z_MM[0] - 1e-6 && p.xyz_mm[2] <= BOX_Z_MM[1] + 1e-6;

describe("scalePath", () => {
  it("maps the person's arm onto the robot's and keeps the path's shape, in a plane in front of the arm", () => {
    // a 0.6 m arm: 250 / 0.6 mm of path per metre the hand moves; a step to the image's right is a step to the robot's right (-y)
    const samples: HandSample[] = [
      { t_s: 1, x_m: 0, y_m: 0 },
      { t_s: 1.5, x_m: 0.3, y_m: 0 },
      { t_s: 2, x_m: 0.3, y_m: -0.1 },
    ];
    const r = scalePath(samples, 0.6);
    const k = ARM_MM / 0.6;
    expect(r.fit).toBe(1);
    expect(r.mm_per_m).toBeCloseTo(k, 0);
    expect(r.path.map((p) => p.t_s)).toEqual([0, 0.5, 1]);
    expect(r.path.every((p) => p.xyz_mm[0] === PLANE_X_MM)).toBe(true);
    const [a, b, c] = r.path.map((p) => p.xyz_mm);
    // the ends are kept; the middle sample is averaged with its neighbours, [1, 2, 1]
    expect(c[1] - a[1]).toBeCloseTo(-0.3 * k, 0);
    expect(c[2] - a[2]).toBeCloseTo(0.1 * k, 0); // image up (y down, so -0.1) is world up
    expect(b[1] - a[1]).toBeCloseTo(-0.225 * k, 0);
    expect(b[2] - a[2]).toBeCloseTo(0.025 * k, 0);
    expect(r.path.every(inBox)).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("centres the path in the box, wherever the wrist was in the frame", () => {
    const a = scalePath(swing(0.12, 2, 4, 0.3, -0.4), 0.6).path;
    const b = scalePath(swing(0.12, 2, 4, -0.2, 0.1), 0.6).path;
    const mid = (p: PathPoint[], k: 1 | 2) => (Math.max(...p.map((q) => q.xyz_mm[k])) + Math.min(...p.map((q) => q.xyz_mm[k]))) / 2;
    for (const p of [a, b]) {
      expect(mid(p, 1)).toBeCloseTo((BOX_Y_MM[0] + BOX_Y_MM[1]) / 2, 0);
      expect(mid(p, 2)).toBeCloseTo((BOX_Z_MM[0] + BOX_Z_MM[1]) / 2, 0);
    }
    expect(a.map((p) => p.xyz_mm)).toEqual(b.map((p) => p.xyz_mm));
  });

  it("shrinks a path larger than the box to fit it, and says by how much", () => {
    // a 0.4 m swing either way on a 0.5 m arm is 400 mm across: the box is 240
    const r = scalePath(swing(0.4, 1, 3), 0.5);
    expect(r.fit).toBeLessThan(1);
    expect(r.path.every(inBox)).toBe(true);
    expect(span(r.path, 1)).toBeCloseTo(BOX_Y_MM[1] - BOX_Y_MM[0], 0);
    expect(r.warnings.join(" ")).toMatch(/larger than the arm's reach/);
  });

  it("stretches a narrow swing side to side to fill the box, at most MAX_STRETCH times, and says so", () => {
    // the arm rises 0.3 m while the wrist swings 3 cm either way: 125 mm high, about 25 mm across
    const rise: HandSample[] = Array.from({ length: 61 }, (_, k) => ({ t_s: k / 10, x_m: 0.03 * Math.sin(2 * Math.PI * (k / 10)), y_m: -0.3 * (k / 60) }));
    const plain = scalePath(rise.map((s) => ({ ...s, x_m: 0 })), 0.6);
    const r = scalePath(rise, 0.6);
    const across = span(r.path, 1);
    expect(across).toBeGreaterThan(span(plain.path, 1) + 50);
    expect(across).toBeLessThanOrEqual(BOX_Y_MM[1] - BOX_Y_MM[0] + 1e-6);
    // the height keeps the arm's own scale
    expect(span(r.path, 2)).toBeCloseTo(span(plain.path, 2), 0);
    expect(r.path.every(inBox)).toBe(true);
    expect(r.warnings.join(" ")).toMatch(new RegExp(`stretched \\d+(\\.\\d)?x`));
    expect(across / (0.06 * (ARM_MM / 0.6) * 0.95)).toBeLessThanOrEqual(MAX_STRETCH + 0.01);
    // a path already half the box wide or more is left as it is
    expect(scalePath(swing(0.2, 0.5, 4), 0.6).warnings.join(" ")).not.toMatch(/stretched/);
  });

  it("fills the box when the arm could not be measured, and says so", () => {
    const r = scalePath(swing(0.05, 1, 3), null);
    expect(span(r.path, 1)).toBeCloseTo(BOX_Y_MM[1] - BOX_Y_MM[0], 0);
    expect(r.path.every(inBox)).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/could not be measured/);
  });

  it("gives no path for a wrist seen too briefly, a wrist held still, or bad numbers", () => {
    expect(scalePath([{ t_s: 0, x_m: 0, y_m: 0 }], 0.6).path).toEqual([]);
    expect(scalePath([{ t_s: 0, x_m: 0, y_m: 0 }, { t_s: 0.2, x_m: 0.1, y_m: 0 }], 0.6).path).toEqual([]);
    const still = Array.from({ length: 20 }, (_, k) => ({ t_s: k / 10, x_m: 0.3 + (k % 2) * 0.001, y_m: -0.4 }));
    const r = scalePath(still, 0.6);
    expect(r.path).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/moved under 2 cm/);
    // with no arm to scale by, a still wrist must not be blown up to fill the box
    expect(scalePath(still.map((s) => ({ ...s, x_m: 0.3 })), null).path).toEqual([]);
    expect(scalePath([{ t_s: 0, x_m: NaN, y_m: 0 }, { t_s: 1, x_m: 0.1, y_m: 0 }], 0.6).path).toEqual([]);
  });

  it("keeps 90% of a quick wave: the average only takes off frame-to-frame jitter", () => {
    // three swings a second sampled 30 times a second; the samples nearest the turns are at sin(2π/5) of the swing
    const samples: HandSample[] = Array.from({ length: 61 }, (_, k) => ({ t_s: k / 30, x_m: 0.15 * Math.sin(2 * Math.PI * 3 * (k / 30)), y_m: -0.5 }));
    const r = scalePath(samples, 0.5);
    const gain = (1 + Math.cos((2 * Math.PI * 3) / 30)) / 2;
    expect(gain).toBeCloseTo(0.9, 1);
    expect(span(r.path, 1)).toBeCloseTo(2 * 0.15 * Math.sin((2 * Math.PI) / 5) * gain * (ARM_MM / 0.5), 0);
    // jitter that flips every frame is gone
    const jitter = samples.map((s, k) => ({ ...s, x_m: s.x_m + (k % 2 ? 0.004 : -0.004) }));
    expect(scalePath(jitter, 0.5).path.slice(1, -1).map((p) => p.xyz_mm[1])).toEqual(r.path.slice(1, -1).map((p) => expect.closeTo(p.xyz_mm[1], 0)));
  });

  it("keeps time moving forward: a repeated or earlier sample is dropped", () => {
    const samples: HandSample[] = [0, 0.5, 0.5, 0.3, 1, 1.5].map((t_s, k) => ({ t_s, x_m: 0.1 * Math.sin(k), y_m: -0.1 * k }));
    const times = scalePath(samples, 0.6).path.map((p) => p.t_s);
    expect(times).toEqual([0, 0.5, 1, 1.5]);
    // two frames a fifth of a millisecond apart would round onto one time: the second is dropped
    const close: HandSample[] = [0.0166, 0.0168, 1.0166].map((t_s, k) => ({ t_s, x_m: 0.05 * k, y_m: -0.4 }));
    expect(scalePath(close, 0.6).path.map((p) => p.t_s)).toEqual([0, 1]);
  });

  it("cuts a path longer than MAX_POINTS and says so", () => {
    const r = scalePath(swing(0.1, 1, 70), 0.6);
    expect(r.path).toHaveLength(MAX_POINTS);
    expect(r.warnings.join(" ")).toMatch(/are kept/);
  });
});

describe("reachCheck", () => {
  const path: PathPoint[] = [
    { t_s: 0, xyz_mm: [220, 0, 240] },
    { t_s: 0.5, xyz_mm: [220, 60, 240] },
    { t_s: 1, xyz_mm: [220, 0, 240] },
    { t_s: 1.5, xyz_mm: [220, -60, 240] },
  ];
  /** a trace that passes through `points` one after another, `late` s after the path's own timing, 100 samples a second */
  function through(points: [number, number, number][], late = 0, dt = 0.5): TraceSample[] {
    const out: TraceSample[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      for (let k = 0; k < 50; k++) {
        const u = k / 50;
        out.push({ t_s: late + i * dt + u * dt, xyz_mm: points[i].map((v, j) => v + (points[i + 1][j] - v) * u) as [number, number, number] });
      }
    }
    out.push({ t_s: late + (points.length - 1) * dt, xyz_mm: points.at(-1)! });
    return out;
  }

  it("reaches every point of a trace that goes through them a little behind, and says how far behind", () => {
    const r = reachCheck(path, through(path.map((p) => p.xyz_mm), 0.2), 1);
    expect(r).toMatchObject({ points: 4, reached: 4, missed: [], reach_mm: 1 });
    expect(r.worst_mm).toBeLessThan(1);
    expect(r.late_s).toBeCloseTo(0.2, 1);
  });

  it("misses the points a trace reaches more than MAX_LAG_S late", () => {
    expect(MAX_LAG_S).toBe(0.25);
    const r = reachCheck(path, through(path.map((p) => p.xyz_mm), 0.4), 1);
    expect(r.missed).toContain(1);
    expect(r.reached).toBeLessThan(4);
  });

  it("misses the point a trace stops short of, by how far", () => {
    const short = path.map((p) => [...p.xyz_mm] as [number, number, number]);
    short[1] = [220, 30, 240]; // 30 mm short of the second point
    const r = reachCheck(path, through(short), 15);
    expect(r.missed).toEqual([1]);
    expect(r.reached).toBe(3);
    expect(r.worst_mm).toBeCloseTo(30, 0);
  });

  it("checks the order: a point passed only before the time of the point before it does not count", () => {
    // the trace is at the last point's place before the path starts (t = 1 s), then traces the first three on time and stays
    const trace = through([[220, -60, 240], [220, -60, 240], [220, 0, 240], [220, 60, 240], [220, 0, 240], [220, 0, 240]]);
    const r = reachCheck(path, trace, 5, 1);
    expect(r.missed).toEqual([3]);
    expect(r.worst_mm).toBeCloseTo(60, 0);
  });

  it("never reaches a point with an observation older than the point before it (in order)", () => {
    // A, then B a frame later, then A again: the trace goes A, A, B and stays at B
    const A: [number, number, number] = [220, 0, 240];
    const B: [number, number, number] = [220, 60, 240];
    const p: PathPoint[] = [{ t_s: 0, xyz_mm: A }, { t_s: 0.0333, xyz_mm: B }, { t_s: 0.0667, xyz_mm: A }];
    const trace: TraceSample[] = [{ t_s: 0, xyz_mm: A }, { t_s: 0.04, xyz_mm: A }, { t_s: 0.1, xyz_mm: B }, { t_s: 0.3, xyz_mm: B }];
    const r = reachCheck(p, trace, 5);
    expect(r.missed).toEqual([2]);
    expect(r.worst_mm).toBeCloseTo(60, 0);
  });

  it("counts the observation nearest in time for a window with none, so a miss never reads 0 mm off", () => {
    const A: [number, number, number] = [220, 0, 240];
    const p: PathPoint[] = [{ t_s: 0, xyz_mm: A }, { t_s: 1, xyz_mm: A }, { t_s: 2, xyz_mm: [220, 60, 240] }];
    // the hand held still at A for a second: one observation there reaches both A points
    const r = reachCheck(p, [{ t_s: 0, xyz_mm: A }], 5);
    expect(r.missed).toEqual([2]);
    expect(r.worst_mm).toBeCloseTo(60, 0);
  });

  it("an empty trace reaches nothing", () => {
    expect(reachCheck(path, [], 15).reached).toBe(0);
  });
});

describe("pathMarkersXml", () => {
  it("draws visual-only spheres, at most 61 per path", () => {
    const long: PathPoint[] = Array.from({ length: 250 }, (_, k) => ({ t_s: k / 10, xyz_mm: [220, k - 125, 240] }));
    const xml = pathMarkersXml([long]);
    const geoms = xml.split("\n");
    expect(geoms.length).toBeLessThanOrEqual(61);
    expect(geoms.every((g) => g.includes('contype="0" conaffinity="0"'))).toBe(true);
    expect(geoms.at(-1)).toContain('pos="0.2200 0.1240 0.2400"');
    expect(pathMarkersXml([])).toBe("");
  });
});

describe("gestureProgram", () => {
  const spec = (verbs: string[]) =>
    TaskSpec.parse({ version: 1, title: "t", summary: "", objects: [{ id: "jar", name: "jar", shape: "box", size_mm: [40, 40, 40], symmetry: "none", role: "manipulated" }], steps: verbs.map((verb, i) => ({ id: `s${i + 1}`, verb, ...(verb === "gesture" ? { gesture: {} } : { object: "jar" }), t_start_s: i, t_end_s: i + 1 })) });
  it("follows each path of a spec of gestures alone, and leaves any other spec to the compiler", () => {
    expect(gestureProgram(spec(["gesture", "gesture"]))?.steps).toEqual([
      { step_id: "s1", ops: [{ op: "follow" }] },
      { step_id: "s2", ops: [{ op: "follow" }] },
    ]);
    expect(gestureProgram(spec(["gesture", "grasp"]))).toBeNull();
    expect(gestureProgram(spec([]))).toBeNull();
  });
});

describe("speedText", () => {
  it("never reads a slowdown as 0", () => {
    expect(speedText(0.7)).toBe("0.70");
    expect(speedText(0.072)).toBe("0.072");
    expect(speedText(0.000072)).toBe("0.000072");
    expect(describeReach({ points: 2, reached: 2, reach_mm: 5, missed: [], worst_mm: 1, late_s: 0, speed: 0.000072 })).toMatch(/at 0\.000072x the clip's speed/);
  });
});
