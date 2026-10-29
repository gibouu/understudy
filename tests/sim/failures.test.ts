/**
 * The three failing rollouts of docs/FAILURES.md (issue #24), replayed in node
 * with no model call, so the doc cannot drift from the simulator: each case
 * must fail with the reason the doc quotes, word for word, and the recorded
 * model output the doc quotes must still be in the recording.
 *
 * - insertion collision: the last recorded program of iss-veggie-seed-film-2,
 *   blind, on the patching model's recorded scenario "tray-x+6" (the grid and
 *   the scoreboard run exactly this);
 * - unreachable target: the program after the answers in iss-glovebox-pipette,
 *   on the nominal bench, and the Notes patch that fixed it;
 * - wrong aperture: what the rehearsal can show of it. A commanded aperture is
 *   not simulated (two constructed cases pass); the nearest failure, a grasp
 *   that missed (the last program of dev-clip on the recorded scenario
 *   "obj2-tilt-x+10" in orbit), was a scene bug fixed in #77: it now holds.
 *
 *   node_modules/.bin/vitest run tests/sim/failures.test.ts --silent=false
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { replayPlan } from "@/lib/saboteur/replay";
import { loadEngine, rollout, type Engine } from "@/lib/showcase/rehearse";
import { Session } from "@/lib/showcase/session";
import { runBatch, type BatchRollout } from "@/lib/sim/batch";
import { environment, type Rollout } from "@/lib/sim/interpreter";
import { buildScene, footprintMm, heightMm, MM } from "@/lib/sim/scene";
import type { Program, Scenario, TaskSpec } from "@/lib/spec/schema";
import scenarios from "@/tests/fixtures/saboteur.json";

const session = (file: string) => Session.parse(JSON.parse(readFileSync(path.join(process.cwd(), file), "utf8")));

let engine: Engine;
beforeAll(async () => {
  engine = await loadEngine();
}, 60_000);

/** The patching model's recorded twelve for this spec (tests/fixtures/saboteur.json), and one of them by id. */
function recordedScenario(spec: TaskSpec, id: string): Scenario {
  const plan = replayPlan(spec);
  if (plan.status !== "done") throw new Error("no plan");
  expect(plan.value.source).toBe("model");
  const sc = plan.value.scenarios.find((s) => s.id === id);
  if (!sc) throw new Error(`no scenario ${id}`);
  // the model that wrote them, as the doc names it
  const hit = (scenarios as { spec_title: string; result: { ledger?: { model: string }[] } }[]).find((r) => r.spec_title === spec.title);
  expect(hit?.result.ledger?.map((c) => c.model)).toContain("nvidia/Nemotron-3.5-Super-VL");
  return sc;
}

async function batch(spec: TaskSpec, program: Program, rollouts: BatchRollout[]): Promise<Rollout[]> {
  const out = await runBatch(engine.mujoco, (xml) => engine.mujoco.MjModel.from_xml_string(xml), spec, program, rollouts);
  return out.map((r) => {
    if (!r.rollout) throw new Error(r.error ?? "no rollout");
    return r.rollout;
  });
}

describe("1. insertion collision: iss-veggie-seed-film-2, blind, tray 6 mm off on x", () => {
  const s = session("public/showcase/iss-veggie-seed-film-2.json");
  const last = s.iterations.at(-1)!;
  const spec = last.spec;

  it("is the recording's last version, which passes on the nominal bench", () => {
    expect(s.iterations.map((i) => i.source)).toEqual(["compile", "interview"]);
    expect(spec.objects.find((o) => o.id === "obj2")!.size_mm).toEqual([40, 6, 40]);
    expect(spec.objects.find((o) => o.id === "obj1")).toMatchObject({ pocket_clearance_mm: 10, sources: { pocket_clearance_mm: "interview#1" } });
    expect(last.results.earth.pass && last.results.orbit.pass).toBe(true);
  });

  it("the patching model wrote the scenario and said it would fail on the rim", () => {
    const sc = recordedScenario(spec, "tray-x+6");
    expect(sc).toMatchObject({ name: "tray 6 mm off on x", axis: "x_mm", offset: 6, object: "obj1", expected: "fail", why: "past the band: packet hits the rim" });
  });

  it("fails blind at 1 g and 0 g with the simulator's reason, and passes sensed", async () => {
    const sc = recordedScenario(spec, "tray-x+6");
    const [earthBlind, earthSensed, orbitBlind, orbitSensed] = await batch(spec, last.program, [
      { scenario: sc, mode: "blind", gravity_g: 1 },
      { scenario: sc, mode: "sensed", gravity_g: 1 },
      { scenario: sc, mode: "blind", gravity_g: 0 },
      { scenario: sc, mode: "sensed", gravity_g: 0 },
    ]);
    expect(earthBlind).toMatchObject({ pass: false, failed_step_id: "s2", failed_op: 3, why: "obj2 is 5.8 mm from obj1's centre, not inside it" });
    expect(earthBlind.failure_class).toBeUndefined();
    expect(orbitBlind).toMatchObject({ pass: false, failed_step_id: "s2", failed_op: 3, why: "obj2 is 5.7 mm from obj1's centre, not inside it" });
    expect(earthSensed.pass).toBe(true);
    expect(orbitSensed.pass).toBe(true);

    // where it ended, against the pocket the perturbed world built: its side inside the pocket's wall, its bottom on the floor
    const world = environment(spec, sc).spec;
    const tray = world.objects.find((o) => o.id === "obj1")!;
    const packet = world.objects.find((o) => o.id === "obj2")!;
    const pocket = buildScene(world).pockets.obj1;
    const end = earthBlind.end!.find((o) => o.object === "obj2")!;
    expect(end.held).toBe(true);
    const offCentre = Math.abs(end.xyz_mm[0] - tray.pose!.xyz_mm[0]);
    const intoWall = offCentre + footprintMm(packet)[0] / 2 - (pocket.inner_m[0] / MM) / 2;
    const floor = tray.pose!.xyz_mm[2] + heightMm(tray) / 2 - pocket.depth_m / MM;
    const aboveFloor = end.xyz_mm[2] - heightMm(packet) / 2 - floor;
    console.info(`blind 1 g: packet ${offCentre.toFixed(1)} mm off the pocket's centre on x, its side ${intoWall.toFixed(1)} mm into the wall, its bottom ${aboveFloor.toFixed(1)} mm above the floor, still held`);
    expect(intoWall).toBeCloseTo(0.8, 1);
    expect(offCentre).toBeCloseTo(5.8, 1);
    expect(aboveFloor).toBeCloseTo(0.1, 1);
  }, 120_000);
});

describe("2. unreachable target: iss-glovebox-pipette, the program after the answers", () => {
  const s = session("public/showcase/iss-glovebox-pipette.json");
  const [, answered, patched] = s.iterations;

  it("fails at 1 g and 0 g on the lift, out of reach, as recorded", () => {
    expect(answered.source).toBe("interview");
    expect(answered.spec.objects.find((o) => o.id === "pipette")!.size_mm).toEqual([25, 25, 40]);
    expect(answered.spec.objects.find((o) => o.id === "cartridge")!.pocket_clearance_mm).toBe(10);
    // what the answers set: the pocket's clearance, the success check and a tolerance, not the lift
    expect(answered.spec.steps.find((x) => x.id === "s2")!.sources).toEqual({ success: "interview#1", "tolerances.clearance_mm": "interview#1" });
    expect(answered.program.steps[0].ops[4]).toEqual({ op: "move_to", frame: "pipette", offset_mm: [0, 0, 50], approach: "top" });
    expect(s.iterations[0].results.earth.why).toBe(answered.results.earth.why);
    const earth = rollout(engine, answered.spec, answered.program, "earth");
    const orbit = rollout(engine, answered.spec, answered.program, "orbit");
    expect(earth).toMatchObject({ pass: false, failed_step_id: "s1", failed_op: 4, failure_class: "embodiment_limit", why: "move_to pipette + (0, 0, 50) mm from top: out of reach by 8.1 mm" });
    expect(orbit).toMatchObject({ pass: false, failed_step_id: "s1", failed_op: 4, failure_class: "embodiment_limit", why: "move_to pipette + (0, 0, 50) mm from top: out of reach by 8.4 mm" });
    expect(answered.results.earth.why).toBe(earth.why);
    expect(answered.results.orbit.why).toBe(orbit.why);
  }, 60_000);

  it("the patching model lowered the lift to 41.9 mm, and the patched program passes in both worlds", () => {
    const p = patched.patch!;
    expect(patched.source).toBe("notes");
    expect(p).toMatchObject({ model: "nvidia/nemotron-3-super-120b-a12b", thinking: false, escalation: null, tokens: 1315, changes: [{ name: "s1.op4.z_mm", from: 50, to: 41.9 }], clamps: [] });
    expect(p.cost_usd).toBeCloseTo(0.00045, 5);
    expect(s.ledger.filter((c) => c.stage === "notes")).toHaveLength(1);
    // the kept run of four; each of the three before it ended after five patches without passing
    expect(s.selection).toMatchObject({ runs: 4, run: 4 });
    for (const n of [1, 2, 3]) {
      const before = session(`bench/rerecord/iss-glovebox-pipette/run-${n}.json`);
      expect(before.iterations.filter((i) => i.source === "notes")).toHaveLength(5);
      expect(before.iterations.at(-1)!.results.earth.pass && before.iterations.at(-1)!.results.orbit.pass).toBe(false);
    }
    expect(p.why).toBe("The pipette was out of reach by ~8.2 mm when trying to lift to z=50 mm, indicating the target height exceeds the arm's capability.");
    expect(p.expect).toBe("Lowering the lift target to z=41.9 mm will place the pipette within reach while keeping its bottom above the cartridge pocket floor.");
    expect(rollout(engine, patched.spec, patched.program, "earth").pass).toBe(true);
    expect(rollout(engine, patched.spec, patched.program, "orbit").pass).toBe(true);
  }, 60_000);
});

describe("2b. the same failure in dev-clip, fixed the same way", () => {
  it("its first two versions stop out of reach by 11.1 mm, and the patch lowers the lift from 50 to 38.9", () => {
    const s = session("public/showcase/dev-clip.json");
    expect(s.iterations.map((i) => i.source)).toEqual(["compile", "interview", "notes"]);
    for (const it of s.iterations.slice(0, 2)) expect(it.results.earth).toMatchObject({ pass: false, failure_class: "embodiment_limit", why: "move_to obj2 + (0, 0, 50) mm from top: out of reach by 11.1 mm" });
    expect(s.iterations[2].patch).toMatchObject({ model: "nvidia/nemotron-3-super-120b-a12b", changes: [{ name: "s1.op3.z_mm", from: 50, to: 38.9 }] });
    expect(s.iterations[2].results.earth.pass && s.iterations[2].results.orbit.pass).toBe(true);
  });
});

describe("3. wrong aperture: what the rehearsal can show of it", () => {
  it("constructed: a commanded aperture 20 mm too small changes nothing; the rollout is the recorded one", () => {
    const s = session("public/showcase/iss-glovebox-pipette.json");
    const last = s.iterations.at(-1)!;
    const op = last.program.steps[0].ops[2];
    expect(op).toEqual({ op: "grasp", object: "pipette", aperture_mm: 25 });
    expect(last.spec.objects.find((o) => o.id === "pipette")!.size_mm).toEqual([25, 25, 40]);
    const small = structuredClone(last.program);
    small.steps[0].ops[2] = { op: "grasp", object: "pipette", aperture_mm: 5 };
    const as = rollout(engine, last.spec, last.program, "earth");
    const narrow = rollout(engine, last.spec, small, "earth");
    expect(narrow.pass).toBe(true);
    expect(narrow.t).toBe(as.t);
    expect(narrow.log.filter((l) => !l.includes("grasp pipette"))).toEqual(as.log.filter((l) => !l.includes("grasp pipette")));
  }, 60_000);

  it("constructed: a box 120 x 120 mm across and 40 mm tall is held and placed", () => {
    const s = session("public/showcase/iss-glovebox-pipette.json");
    const last = s.iterations.at(-1)!;
    const spec = structuredClone(last.spec);
    spec.objects[0].size_mm = [120, 120, 40];
    spec.objects[1].size_mm = [160, 160, 12];
    const r = rollout(engine, spec, last.program, "earth");
    expect(r.log.some((l) => l.endsWith("grasp pipette: held"))).toBe(true);
    expect(r.pass).toBe(true);
  }, 60_000);

  it("recorded program, recorded scenario: the tilted piece that was missed in orbit before #77 starts on the table and is held", async () => {
    const s = session("public/showcase/dev-clip.json");
    const last = s.iterations.at(-1)!;
    expect(last.spec.objects.find((o) => o.id === "obj2")).toMatchObject({ shape: "cylinder", size_mm: [40, 40, 40] });
    const sc = recordedScenario(last.spec, "obj2-tilt-x+10");
    expect(sc).toMatchObject({ name: "piece tilted 10 deg about x", axis: "tilt_deg", offset: 10, object: "obj2", expected: "unknown", why: "tilted cylinder may seat unevenly in microgravity" });
    const [orbitSensed, orbitBlind, earthSensed] = await batch(last.spec, last.program, [
      { scenario: sc, mode: "sensed", gravity_g: 0 },
      { scenario: sc, mode: "blind", gravity_g: 0 },
      { scenario: sc, mode: "sensed", gravity_g: 1 },
    ]);
    // docs/FAILURES.md case 3: before #77 the piece started 3.2 mm inside the table and was missed at 0 g
    for (const r of [orbitSensed, orbitBlind, earthSensed]) {
      expect(r.pass).toBe(true);
      expect(r.log.some((l) => l.endsWith("grasp obj2: missed"))).toBe(false);
      const end = r.end!.find((o) => o.object === "obj2")!;
      console.info(`tilted piece: ends at ${end.speed_mm_s.toFixed(1)} mm/s`);
      expect(end.speed_mm_s).toBeLessThan(1);
    }
  }, 120_000);
});
