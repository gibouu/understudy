/**
 * The 1-minute demo (#162): it picks a recording by what it shows, rehearses the version the answers made and the
 * last one, and its download is a LeRobot v2.1 skeleton built from the traces the stage handed it.
 */
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { TraceFrame } from "@/lib/export/trace";
import type { JointVector } from "@/lib/export/types";
import { recordings } from "./load";
import { instruction, tourExport, tourPick, tourVersions } from "./tour";

/** A rollout's trace: a ramp on every joint, `n` frames `dt` apart. */
const ramp = (n: number, dt: number): TraceFrame[] =>
  Array.from({ length: n }, (_, i) => {
    const q = [0, 1, 2, 3, 4, 5].map((j) => j * 0.1 + i * 0.01) as JointVector;
    return { t: i * dt, state: q, action: q };
  });

describe("the tour", async () => {
  const all = await recordings();
  const picked = tourPick(all)!;

  it("plays a recording that asks, fails, is patched and passes in both worlds", () => {
    const s = picked.session;
    const { first, last, patches } = tourVersions(s);
    expect(s.turns.some((t) => t.asks.length > 0)).toBe(true);
    expect(first).toBeLessThan(last);
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.every((i) => s.iterations[i].source === "notes" && i > first && i <= last)).toBe(true);
    const before = s.iterations[first].results;
    expect(before.earth.pass && before.orbit.pass).toBe(false);
    // the version it opens on is rehearsable: it does not stop at an open question
    expect([before.earth, before.orbit].some((r) => r.why?.startsWith("unanswered: "))).toBe(false);
    const after = s.iterations[last].results;
    expect(after.earth.pass && after.orbit.pass).toBe(true);
  });

  it("prefers a recording that passes on Earth and fails in orbit", () => {
    const orbitOnly = all.filter((r) => r.session.iterations.some((x) => x.results.earth.pass && !x.results.orbit.pass));
    if (orbitOnly.length > 0) expect(picked.session.iterations.some((x) => x.results.earth.pass && !x.results.orbit.pass)).toBe(true);
  });

  it("names the task from the spec, never empty", () => {
    for (const r of all) expect(instruction(r.session.iterations.at(-1)!.spec).trim()).not.toBe("");
  });

  it("downloads the passing rollouts as a LeRobot v2.1 skeleton next to the recording", async () => {
    const { zip, paths, quality } = await tourExport(picked.session, [
      { world: "earth", trace: ramp(400, 1 / 60) },
      { world: "orbit", trace: ramp(500, 1 / 60) },
    ]);
    expect(paths).toEqual(
      expect.arrayContaining([
        "lerobot/QUALITY.md",
        "lerobot/meta/info.json",
        "lerobot/meta/tasks.jsonl",
        "lerobot/data/chunk-000/episode_000000.parquet",
        "lerobot/data/chunk-000/episode_000001.parquet",
        "understudy/spec.json",
        "understudy/program.json",
        "understudy/interview.json",
        "understudy/ledger.json",
      ]),
    );
    // the tour exports no video: nothing is rendered, and the report must not say so (#168)
    expect(quality.headline).toBe("2 scripted episodes; a format-valid skeleton, not training data");
    expect(paths.some((p) => p.endsWith(".mp4"))).toBe(false);
    const files = unzipSync(zip);
    const info = JSON.parse(new TextDecoder().decode(files["lerobot/meta/info.json"]));
    expect(info.fps).toBe(15);
    expect(info.total_episodes).toBe(2);
    const quality_md = new TextDecoder().decode(files["lerobot/QUALITY.md"]);
    expect(quality_md).toContain("not training data");
    expect(quality_md).toContain("joint states and actions only, no video");
    expect(quality_md).not.toContain("rendered");
  });
});
