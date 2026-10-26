/**
 * The bench facts the variants prompt states, measured: a hand-written
 * held-until-seated program (no model in the loop) on the ISS sample moved
 * to the spots, shelves and starts the facts allow, and just past them.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { TaskSpec } from "@/lib/spec/schema";
import { benchFacts, SPOT_RING_MM } from "@/lib/variants/prompt";
import { heldUntilSeated, issBase, loadSim, rollout } from "./harness";

let base: TaskSpec;
beforeAll(async () => {
  await loadSim();
  base = (await issBase()).spec;
}, 60_000);

const at = (s: TaskSpec, g: number) => rollout(s, heldUntilSeated(s), g);
const moved = (id: string, xyz: [number, number, number], frame = "world") => {
  const s = structuredClone(base);
  s.objects.find((o) => o.id === id)!.pose = { xyz_mm: xyz, yaw_deg: 0, frame };
  return s;
};

describe("the bench facts in the variants prompt", () => {
  it("the task itself passes on Earth and in orbit when held until seated", () => {
    expect(at(base, 1).pass).toBe(true);
    expect(at(base, 0).pass).toBe(true);
  });

  it("a shelf as high as the facts allow is in reach, and a few mm higher is not", () => {
    const shelf = Number(benchFacts(base).match(/of up to ([\d.]+) mm/)![1]);
    const z = base.objects[1].pose!.xyz_mm;
    expect(at(moved("obj2", [z[0], z[1], z[2] + shelf]), 1).pass).toBe(true);
    const over = at(moved("obj2", [z[0], z[1], z[2] + shelf + 4]), 1);
    expect(over.failure_class).toBe("embodiment_limit");
  });

  it(`the held object is in reach at spots ${SPOT_RING_MM[0]} to ${SPOT_RING_MM[1]} mm from the base`, () => {
    for (const [x, y] of [
      [150, -50],
      [150, -150],
      [200, -150],
      [235, -50],
    ]) {
      const r = Math.hypot(x, y);
      expect(r).toBeGreaterThanOrEqual(SPOT_RING_MM[0]);
      expect(r).toBeLessThanOrEqual(SPOT_RING_MM[1]);
      expect(at(moved("obj1", [x, y, 20]), 1).pass, `${x}, ${y}`).toBe(true);
    }
    expect(at(moved("obj1", [250, -150, 20]), 1).failure_class).toBe("embodiment_limit");
  });

  it("the object started on the pocket floor is taken out and put back, on Earth and in orbit", () => {
    const pose = JSON.parse(benchFacts(base).match(/on its pocket floor: pose (\{.*?\});/)![1]);
    const s = moved("obj1", pose.xyz_mm, pose.frame);
    expect(at(s, 1).pass).toBe(true);
    expect(at(s, 0).pass).toBe(true);
  });
});
