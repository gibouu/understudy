import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CLEAR_M, Dressing, SETTINGS, settingFor } from "@/lib/sim/settings";
import { SAMPLES } from "@/lib/samples";

describe("settingFor", () => {
  it("puts every space sample's hint in the station module", () => {
    for (const s of SAMPLES) expect(settingFor(s.hint)).toBe("station");
  });

  it("reads the label's words as well as the hint", () => {
    expect(settingFor("Astronaut places seed film into Veggie plant pillows aboard ISS", "", undefined)).toBe("station");
    expect(settingFor("pour the cup", "A crew member pours water in microgravity.")).toBe("station");
    expect(settingFor("tighten a bolt", "Done in orbit, on a rack.")).toBe("station");
    expect(settingFor("stow the bag", "", "aboard the station")).toBe("station");
  });

  it("sends household and unmarked clips to the kitchen", () => {
    expect(settingFor("pour the cup into the bowl", "Pick up the cup and pour its water into the bowl.")).toBe("kitchen");
    expect(settingFor("marker into holder", "A person puts a capped marker into a pen holder.", "")).toBe("kitchen");
    expect(settingFor()).toBe("kitchen");
  });

  it("is not fooled by words that only contain a space word", () => {
    for (const t of ["a charging station on the desk", "a soldering workstation", "the space between the cups", "kiss the cook", "a glass mission jar"])
      expect(settingFor(t), t).toBe("kitchen");
  });
});

describe("Dressing", () => {
  const clear = new THREE.Box3(new THREE.Vector3(...CLEAR_M.min), new THREE.Vector3(...CLEAR_M.max));

  for (const name of SETTINGS) {
    it(`${name}: keeps out of the volume the arm works in`, () => {
      const d = new Dressing(name);
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
