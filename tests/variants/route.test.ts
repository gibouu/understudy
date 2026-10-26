import { beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/variants/route";
import { valueAt } from "@/lib/spec/apply";
import type { Program, TaskSpec } from "@/lib/spec/schema";
import type { StageResult } from "@/lib/spec/stage-result";
import type { Checked } from "@/lib/variants/validate";
import { issBase, loadSim, postCompile, rollout } from "./harness";

const post = async (body: unknown, query = "?replay=1"): Promise<{ status: number; result: StageResult<Checked> }> => {
  const res = await POST(new Request(`http://test/api/variants${query}`, { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, result: await res.json() };
};

let base: { spec: TaskSpec; program: Program };

beforeAll(async () => {
  await loadSim();
  base = await issBase();
}, 60_000);

describe("POST /api/variants in replay, on the ISS sample", () => {
  it("offers three or more variants, and at least one passes on Earth and in orbit", async () => {
    const { result } = await post({ spec: base.spec });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.warnings).toContain("replay: recorded answer");
    expect(result.value.variants.length).toBeGreaterThanOrEqual(3);
    const outcomes: string[] = [];
    let both = 0;
    for (const v of result.value.variants) {
      expect(v.spec.title).not.toBe(base.spec.title);
      expect(v.edits.length).toBeGreaterThan(0);
      // the answers given for the task above carry over
      expect(valueAt(v.spec, "steps[s2].success")).toEqual(valueAt(base.spec, "steps[s2].success"));
      const c = await postCompile(v.spec, base.program);
      expect(c.status, v.title).toBe("done");
      if (c.status !== "done") continue;
      const [earth, orbit] = [1, 0].map((g) => rollout(v.spec, c.value, g));
      outcomes.push(`${v.title}: earth ${earth.pass ? "pass" : earth.why}, orbit ${orbit.pass ? "pass" : orbit.why}`);
      if (earth.pass && orbit.pass) both++;
    }
    expect(both, outcomes.join("\n")).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("turns “put it on a higher shelf” into one valid change that raises the target", async () => {
    const { result } = await post({ spec: base.spec, request: "Put it on a higher shelf.", first: 4 });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.value.variants).toHaveLength(1);
    const [v] = result.value.variants;
    expect(v.id).toBe("variant#4");
    const target = base.spec.steps[1].target!.frame;
    const before = valueAt(base.spec, `objects[${target}].pose.xyz_mm.2`) as number;
    expect(valueAt(v.spec, `objects[${target}].pose.xyz_mm.2`)).toBeGreaterThan(before);
    expect(v.spec.objects.find((o) => o.id === target)?.sources.pose).toBe("variant#4");
  });

  it("says plainly that the arm cannot pour yet", async () => {
    const { result } = await post({ spec: base.spec, request: "pour it into the tray instead" });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.value.variants).toEqual([]);
    expect(result.value.not_yet[0].why).toMatch(/not|cannot|yet/i);
  });

  it("names the recorded requests when asked one it has no recording of", async () => {
    const { result } = await post({ spec: base.spec, request: "stack two of them" });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.message).toContain("put it on a higher shelf");
  });

  it("refuses a body without a valid spec", async () => {
    const { status, result } = await post({ spec: { title: "x" } });
    expect(status).toBe(400);
    expect(result.status).toBe("failed");
  });
});
