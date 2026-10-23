import { describe, expect, it } from "vitest";
import { decodeName, sampleWaypoints, toNumbers } from "@/lib/sim/names";

describe("decodeName", () => {
  const names = new Uint8Array([...Buffer.from("base\0shoulder\0gripperframe\0")]);
  it("reads a NUL-terminated name at an offset", () => {
    expect(decodeName(names, 0)).toBe("base");
    expect(decodeName(names, 5)).toBe("shoulder");
    expect(decodeName(names, 14)).toBe("gripperframe");
  });
  it("returns an empty string for a bad offset", () => {
    expect(decodeName(names, -1)).toBe("");
    expect(decodeName(names, 999)).toBe("");
  });
});

describe("sampleWaypoints", () => {
  const wp = [
    { t: 0, q: [0, 0] },
    { t: 1, q: [1, 2] },
    { t: 3, q: [3, 2] },
  ];
  it("clamps before and after", () => {
    expect(sampleWaypoints(wp, -1)).toEqual([0, 0]);
    expect(sampleWaypoints(wp, 10)).toEqual([3, 2]);
  });
  it("interpolates linearly inside a segment", () => {
    expect(sampleWaypoints(wp, 0.5)).toEqual([0.5, 1]);
    expect(sampleWaypoints(wp, 2)).toEqual([2, 2]);
  });
  it("returns a copy, not the waypoint array", () => {
    const q = sampleWaypoints(wp, 0);
    q[0] = 99;
    expect(wp[0].q[0]).toBe(0);
  });
  it("handles an empty list", () => {
    expect(sampleWaypoints([], 1)).toEqual([]);
  });
});

describe("toNumbers", () => {
  it("passes typed arrays through", () => {
    const a = new Float64Array([1, 2]);
    expect(toNumbers(a)).toBe(a);
  });
  it("unpacks vector handles", () => {
    const vec = { size: () => 3, get: (i: number) => i * 2 };
    expect(Array.from(toNumbers(vec))).toEqual([0, 2, 4]);
  });
  it("returns an empty list for anything else", () => {
    expect(toNumbers(undefined)).toEqual([]);
  });
});
