import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_SPEC } from "@/lib/sim/demo-spec";
import { reachability } from "@/lib/sim/ik";
import { buildScene } from "@/lib/sim/scene";
import { SO101_XML, stageXml } from "@/lib/sim/so101";

describe("the /stage demo spec", () => {
  it("compiles next to the arm with the tube's grasp point and a point 50 mm above the pocket in reach", async () => {
    const { default: loadMujoco } = await import("@mujoco/mujoco");
    const mujoco = await loadMujoco();
    const dir = path.join(process.cwd(), "assets", "so101");
    const vfs = new mujoco.MjVFS();
    vfs.addBuffer(SO101_XML, new Uint8Array(readFileSync(path.join(dir, SO101_XML))));
    for (const file of readdirSync(path.join(dir, "assets"))) vfs.addBuffer(file, new Uint8Array(readFileSync(path.join(dir, "assets", file))));
    const build = buildScene(DEMO_SPEC);
    expect(build.warnings).toEqual([]);
    expect(build.pockets.rack.inner_m[0]).toBeCloseTo(0.02, 6);
    const model = mujoco.MjModel.from_xml_string(stageXml(build.worldbody), vfs);
    const data = new mujoco.MjData(model);
    try {
      expect(model.nq).toBe(6 + 7); // six arm joints plus the tube's free joint
      mujoco.mj_forward(model, data);
      const pocket = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, `${build.names.rack}_pocket`);
      expect(pocket).toBeGreaterThanOrEqual(0);
      const opening = Array.from((data.site_xpos as Float64Array).slice(3 * pocket, 3 * pocket + 3));
      expect(opening[2]).toBeCloseTo(0.04, 6);
      const r = reachability(mujoco, model, data, [
        { pos: build.frames.tube.xyz_m, approach: "top" },
        { pos: [opening[0], opening[1], opening[2] + 0.05], approach: "top" },
      ]);
      expect(r.results.map((x) => x.ok)).toEqual([true, true]);
    } finally {
      data.delete();
      model.delete();
      vfs.delete();
    }
  }, 60_000);
});
