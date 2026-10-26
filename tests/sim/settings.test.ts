import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { DEMO_SPEC, POUR_SPEC } from "@/lib/sim/demo-spec";
import { CLEAR_M, clearAround, Dressing, SETTINGS, settingFor } from "@/lib/sim/settings";
import { SAMPLES } from "@/lib/samples";
import type { TaskSpec } from "@/lib/spec/schema";

describe("settingFor", () => {
  it("puts every space sample's hint in the station module", () => {
    for (const s of SAMPLES) expect(settingFor(s.hint)).toBe("station");
  });

  it("reads the label's words as well as the hint", () => {
    expect(settingFor("Astronaut places seed film into Veggie plant pillows aboard ISS", "", undefined)).toBe("station");
    expect(settingFor("pour the cup", "A crew member pours water in microgravity.")).toBe("station");
    expect(settingFor("tighten a bolt", "Done in orbit, on a rack.")).toBe("station");
    expect(settingFor("stow the bag", "", "aboard the station")).toBe("station");
    expect(settingFor("plug in a sample", "Inside an orbital lab.")).toBe("station");
  });

  it("sends household and unmarked clips to the kitchen", () => {
    expect(settingFor("pour the cup into the bowl", "Pick up the cup and pour its water into the bowl.")).toBe("kitchen");
    expect(settingFor("marker into holder", "A person puts a capped marker into a pen holder.", "")).toBe("kitchen");
    expect(settingFor()).toBe("kitchen");
  });

  it("is not fooled by words that only contain a space word", () => {
    for (const t of ["a charging station on the desk", "a soldering workstation", "the space between the cups", "kiss the cook", "a glass mission jar", "sanding a board with an orbital sander"])
      expect(settingFor(t), t).toBe("kitchen");
  });
});

/** the demo scene with its objects moved out where the default room's walls and its far end would be */
const SPREAD: TaskSpec = {
  ...DEMO_SPEC,
  objects: DEMO_SPEC.objects.map((o, i) => ({ ...o, pose: { ...o.pose!, xyz_mm: i ? [250, 600, 15] : [700, -900, 20] } })),
};

describe("clearAround", () => {
  it("is CLEAR_M for the fitted demo scenes and without a spec", () => {
    for (const spec of [undefined, DEMO_SPEC, POUR_SPEC]) expect(clearAround(spec)).toEqual(CLEAR_M);
  });

  it("grows to hold every object, whatever its rotation", () => {
    const c = clearAround(SPREAD);
    const pillow = Math.hypot(...SPREAD.objects[1].size_mm) / 2000;
    expect(c.max[1]).toBeCloseTo(0.6 + pillow, 6);
    expect(c.max[0]).toBeGreaterThan(0.7);
    expect(c.min[1]).toBeLessThan(-0.9);
    expect(c.min[2]).toBe(CLEAR_M.min[2]); // the work surface stays the floor
  });
});

describe("Dressing", () => {
  for (const [name, around] of SETTINGS.flatMap((n) => [[n, undefined], [n, POUR_SPEC], [n, SPREAD]] as const)) {
    it(`${name}${around ? ` around ${around === SPREAD ? "objects out by the walls" : around.title}` : ""}: keeps out of the volume the arm and the objects use`, () => {
      const c = clearAround(around);
      const clear = new THREE.Box3(new THREE.Vector3(...c.min), new THREE.Vector3(...c.max));
      const d = new Dressing(name, around);
      const tri = new THREE.Triangle();
      let triangles = 0;
      d.group.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const pos = o.geometry.getAttribute("position");
        const index = o.geometry.getIndex()!;
        for (let i = 0; i < index.count; i += 3) {
          tri.a.fromBufferAttribute(pos, index.getX(i));
          tri.b.fromBufferAttribute(pos, index.getX(i + 1));
          tri.c.fromBufferAttribute(pos, index.getX(i + 2));
          triangles++;
          if (clear.intersectsTriangle(tri)) throw new Error(`${name}: a triangle of a ${(o.material as THREE.MeshStandardMaterial).color.getHexString()} part enters the clear volume at (${tri.a.toArray().map((v) => v.toFixed(3))})`);
        }
      });
      expect(triangles).toBeGreaterThan(500);
      d.dispose();
    });
  }

  for (const name of SETTINGS) {
    it(`${name}: costs one draw call per material, a few dozen at most`, () => {
      const d = new Dressing(name);
      const meshes: THREE.Mesh[] = [];
      d.group.traverse((o) => o instanceof THREE.Mesh && meshes.push(o));
      expect(meshes.length).toBeGreaterThan(5);
      expect(meshes.length).toBeLessThanOrEqual(20);
      expect(new Set(meshes.map((m) => m.material)).size).toBe(meshes.length);
      d.dispose();
    });

    it(`${name}: has a work surface whose top is the bench's z = 0, under the arm`, () => {
      const d = new Dressing(name);
      const down = new THREE.Raycaster(new THREE.Vector3(0.2, 0, 0.3), new THREE.Vector3(0, 0, -1));
      const hit = down.intersectObject(d.group, true)[0];
      expect(hit?.point.z).toBeCloseTo(0, 6);
      d.dispose();
    });
  }
});
