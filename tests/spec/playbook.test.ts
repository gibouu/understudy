/**
 * #56: the playbook's seed set. Each showcase rule's evidence is the recording's own words, its fixture
 * the kind of task that clip is, and a rule reaches only a spec with a step of its kind.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Session, type Run } from "@/lib/showcase/session";
import { POUR_SPEC } from "@/lib/sim/demo-spec";
import { DEFAULT_ON, kindsOf, matchRules, PLAYBOOK, playbookSection, citedRules } from "@/lib/spec/playbook";

const session = (clip: string) => Session.parse(JSON.parse(readFileSync(path.join(process.cwd(), "public", "showcase", `${clip}.json`), "utf8")));
const said = (r: Run) => (r.pass ? "pass" : r.why!);
const shown = PLAYBOOK.filter((r) => r.source.startsWith("notes#"));

describe("the seed playbook", () => {
  it("is six rules: four from the showcase's Notes patches, two from the bench, each id once", () => {
    expect(PLAYBOOK.map((r) => [r.id, r.fixture, r.source, r.on])).toEqual([
      ["pocket-lift-reach", "pocket", "notes#1", true],
      ["zone-lift-reach", "zone", "notes#1", true],
      ["pocket-wait-still-orbit", "pocket", "notes#1", true],
      ["pocket-release-above-floor", "pocket", "notes#2", true],
      ["zone-settle-before-release", "zone", "bench#r2-playbook3.1", false],
      ["pour-tilt-longer", "pour", "bench#r2-playbook3.2", false],
    ]);
    expect(new Set(PLAYBOOK.map((r) => r.id)).size).toBe(PLAYBOOK.length);
    expect(DEFAULT_ON).toEqual(["pocket-lift-reach", "zone-lift-reach", "pocket-wait-still-orbit", "pocket-release-above-floor"]);
    for (const r of PLAYBOOK.filter((x) => !x.on)) expect(r.note, r.id).toBeTruthy();
  });

  it.each(shown.map((r) => [r.id, r] as const))("%s: its evidence is the recording's", (_, r) => {
    const s = session(r.evidence.clip);
    const n = Number(r.source.slice("notes#".length));
    const i = s.iterations.map((it, k) => (it.source === "notes" ? k : -1)).filter((k) => k >= 0)[n - 1];
    const it = s.iterations[i];
    expect(it.changes).toContain(r.evidence.change);
    // the world the patch was for failed before it, and the rule's before quotes that failure
    const before = s.iterations[i - 1].results;
    const failing = (["earth", "orbit"] as const).filter((w) => !before[w].pass);
    expect(failing.length).toBeGreaterThan(0);
    for (const w of failing) expect(r.evidence.before).toContain(said(before[w]).replace(/by [\d.]+ mm/, "by"));
    // the failure it was made for is gone after it; a rule whose world still fails says what fails next
    for (const w of failing) {
      expect(it.results[w].why ?? "").not.toBe(before[w].why);
      if (it.results[w].pass) continue;
      expect(r.evidence.after).toContain(it.results[w].why!);
    }
    if (it.results.earth.pass && it.results.orbit.pass) expect(r.evidence.after).toBe("passes at 1 g and 0 g");
    // the failure class is the recording's: out of reach, or a check that did not hold
    expect(r.failure_class).toBe(before[failing[0]].failure_class === "embodiment_limit" ? "embodiment_limit" : "check_failed");
    // tagged with the kind of task the clip is
    expect(kindsOf(it.spec).has(r.fixture)).toBe(true);
  });
});

describe("the bench rules", () => {
  type BenchRun = { probe: string; gravity: string; passed_at: number | null; iterations: { knobs: Record<string, unknown> }[] };
  const bench = JSON.parse(readFileSync(path.join(process.cwd(), "bench", "results", "patch-loop.json"), "utf8")) as { arms: Record<string, { runs: BenchRun[]; playbook?: { from_runs: number } }> };
  // the repairs r2-playbook3 was distilled from (tests/measure/patch-loop.test.ts distil): super-off, Earth and Mars, fixed by a patch
  const fixes = bench.arms["super-off"].runs.filter((r) => (r.gravity === "earth" || r.gravity === "mars") && r.passed_at !== null && r.passed_at > 0);
  const changed = (r: BenchRun) => Object.fromEntries(Object.entries(r.iterations[r.passed_at!].knobs).filter(([k, v]) => r.iterations[0].knobs[k] !== v));

  it("count the repairs as the raw runs have them, not as the distillation summed them up", () => {
    expect(fixes.length).toBe(bench.arms["r2-playbook3"].playbook!.from_runs);
    const place = fixes.filter((r) => r.probe === "place").map(changed);
    expect(place.length).toBe(7);
    expect(place.every((c) => c.release_height_mm === 0)).toBe(true);
    expect(place.filter((c) => c.release_speed_mm_s === 5 && c.wait_before_release_s === 2).length).toBe(4);
    const pour = fixes.filter((r) => r.probe === "pour").map(changed);
    expect(pour.length).toBe(9);
    expect(pour.every((c) => typeof c.tilt_s === "number" && c.tilt_s >= 1.5 && c.tilt_s <= 4 && (c.target_offset_mm === 10 || c.target_offset_mm === 40))).toBe(true);
    expect(pour.filter((c) => c.tilt_deg === 100).length).toBe(4);
    expect(pour.filter((c) => c.strategy === "hold-and-wait").length).toBe(4);
    expect(PLAYBOOK.find((r) => r.id === "zone-settle-before-release")!.evidence.change).toContain("in all 7 repairs");
    expect(PLAYBOOK.find((r) => r.id === "pour-tilt-longer")!.evidence.change).toContain("in all 9 repairs; tilt_deg 90 → 100 in 4");
  });
});

describe("matchRules", () => {
  const pipette = session("iss-glovebox-pipette").iterations[1].spec;
  const chess = session("dev-clip").iterations[1].spec;
  const all = PLAYBOOK.map((r) => r.id);

  it("gives a spec only the rules of its own kind of task", () => {
    expect(matchRules(pipette, all).map((r) => r.id)).toEqual(["pocket-lift-reach", "pocket-wait-still-orbit", "pocket-release-above-floor"]);
    expect(matchRules(chess, all).map((r) => r.id)).toEqual(["zone-lift-reach", "zone-settle-before-release"]);
    expect(matchRules(POUR_SPEC, all).map((r) => r.id)).toEqual(["pour-tilt-longer"]);
  });

  it("keeps only the rules left on, and ignores an id it does not have", () => {
    expect(matchRules(pipette, ["pocket-release-above-floor", "made-up", "pour-tilt-longer"]).map((r) => r.id)).toEqual(["pocket-release-above-floor"]);
    expect(matchRules(pipette, [])).toEqual([]);
  });

  it("narrows to the failure of the last rehearsal, when there is one", () => {
    expect(matchRules(pipette, all, "embodiment_limit").map((r) => r.id)).toEqual(["pocket-lift-reach"]);
    expect(matchRules(pipette, all, "check_failed").map((r) => r.id)).toEqual(["pocket-wait-still-orbit", "pocket-release-above-floor"]);
    expect(matchRules(pipette, all, "spec_gap")).toEqual([]);
  });

  it("gives a gesture nothing", () => {
    expect(matchRules(session("iss-wave").iterations[0].spec, all)).toEqual([]);
  });
});

describe("the prompt and the citation", () => {
  it("lists each rule with its evidence, and says so when there is none", () => {
    const rules = matchRules(session("iss-glovebox-pipette").iterations[1].spec, DEFAULT_ON);
    const text = playbookSection(rules);
    for (const r of rules) expect(text).toContain(`- ${r.id} (learned on a pocket task, ${r.evidence.clip})`);
    expect(text).not.toContain("zone-lift-reach");
    expect(playbookSection([])).toMatch(/\n\(no rules\)$/);
  });

  it("cites only the rules it was given", () => {
    const rules = PLAYBOOK.slice(0, 2);
    expect(citedRules(["pocket-lift-reach", "playbook#zone-lift-reach", "pour-tilt-longer", 3], rules)).toEqual(["playbook#pocket-lift-reach", "playbook#zone-lift-reach"]);
    expect(citedRules("pocket-lift-reach", rules)).toEqual([]);
  });
});
