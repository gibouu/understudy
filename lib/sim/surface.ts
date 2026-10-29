/**
 * The geometry of a contact step, pure (no MuJoCo): a path on the surface of a fixed primitive (the stand-in a
 * held object is applied to), and the point of a held primitive that meets it.
 *
 * A stand-in is any spec object that does not move (role surface, fixture or obstacle): a box, a sphere or an
 * upright cylinder, sized in the spec. The code knows it only by its shape and size, never by what it stands for.
 * A contact path is given in that object's frame, mm; each point is moved onto the primitive's surface at the
 * nearest point (`onSurface`), with the outward normal there, after the path is cut into samples SAMPLE_MM apart.
 *
 * The held object's contact point is its support point toward the surface: the point of its primitive furthest
 * along -normal, from its pose in the world (`support`). A held object keeps the orientation it was gripped at,
 * so for a flat surface that point stays the same; on a curved one it moves along the held object's rim.
 */
import type { SpecObject } from "@/lib/spec/schema";

export type Vec3 = [number, number, number];

/** Path samples are this far apart, mm, at most: what coverage is counted over. */
export const SAMPLE_MM = 1;
/** A cylinder's cap faces a direction within about 0.6° of its axis (the sine of that angle): tipped more, its rim meets a flat surface first. */
const AXIAL = 0.1;
/** Above this many samples a path is too long to follow in one step. */
export const MAX_SAMPLES = 2000;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const n = norm(a);
  return n > 1e-12 ? scale(a, 1 / n) : [0, 0, 1];
};
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Row-major rotation matrix of a unit quaternion [w, x, y, z]. */
export function quatToMat([w, x, y, z]: [number, number, number, number]): number[] {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}
export const rot = (R: number[], v: Vec3): Vec3 => [
  R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
  R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
  R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
];
export const rotT = (R: number[], v: Vec3): Vec3 => [
  R[0] * v[0] + R[3] * v[1] + R[6] * v[2],
  R[1] * v[0] + R[4] * v[1] + R[7] * v[2],
  R[2] * v[0] + R[5] * v[1] + R[8] * v[2],
];

/** Half-extents of a primitive in its own frame, mm: box [x, y, z]/2; cylinder [r, r, h/2]; sphere [r, r, r]. */
export function halfExtents(o: Pick<SpecObject, "shape" | "size_mm">): Vec3 {
  const [a, b, c] = o.size_mm;
  if (o.shape === "box") return [a / 2, b / 2, c / 2];
  if (o.shape === "cylinder") return [a / 2, a / 2, c / 2];
  return [a / 2, a / 2, a / 2];
}

/** The nearest point of the primitive's surface to `p` and the outward normal there, both in the object's frame, mm. */
export function onSurface(o: Pick<SpecObject, "shape" | "size_mm">, p: Vec3): { point: Vec3; normal: Vec3 } {
  const h = halfExtents(o);
  if (o.shape === "sphere") {
    const n = unit(p);
    return { point: scale(n, h[0]), normal: n };
  }
  if (o.shape === "box") {
    const inside = p.every((v, k) => Math.abs(v) <= h[k]);
    if (!inside) {
      const q: Vec3 = [clamp(p[0], -h[0], h[0]), clamp(p[1], -h[1], h[1]), clamp(p[2], -h[2], h[2])];
      const d = sub(p, q);
      // off a face the nearest point is on it, off an edge or a corner too; the normal is the face's (the one the
      // point is furthest out from), so a path drawn just above a face follows that face and not a rounded edge
      const k = [0, 1, 2].reduce((best, i) => (Math.abs(d[i]) > Math.abs(d[best]) ? i : best), 0);
      const normal: Vec3 = [0, 0, 0];
      normal[k] = Math.sign(d[k]) || 1;
      return { point: q, normal };
    }
    // inside: out through the nearest face
    const k = [0, 1, 2].reduce((best, i) => (h[i] - Math.abs(p[i]) < h[best] - Math.abs(p[best]) ? i : best), 0);
    const point: Vec3 = [...p];
    point[k] = (Math.sign(p[k]) || 1) * h[k];
    const normal: Vec3 = [0, 0, 0];
    normal[k] = Math.sign(p[k]) || 1;
    return { point, normal };
  }
  // upright cylinder: the side, the top or the bottom, whichever is nearest
  const r = h[0];
  const hz = h[2];
  const radial = Math.hypot(p[0], p[1]);
  const dir: Vec3 = radial > 1e-9 ? [p[0] / radial, p[1] / radial, 0] : [1, 0, 0];
  const side: Vec3 = [dir[0] * r, dir[1] * r, clamp(p[2], -hz, hz)];
  const capR = Math.min(radial, r);
  const top: Vec3 = [dir[0] * capR, dir[1] * capR, hz];
  const bottom: Vec3 = [dir[0] * capR, dir[1] * capR, -hz];
  const options: { point: Vec3; normal: Vec3 }[] = [
    { point: side, normal: dir },
    { point: top, normal: [0, 0, 1] },
    { point: bottom, normal: [0, 0, -1] },
  ];
  return options.reduce((best, c) => (norm(sub(c.point, p)) < norm(sub(best.point, p)) ? c : best));
}

export type Sample = {
  /** on the surface, world frame, m */
  point: Vec3;
  /** outward unit normal there, world frame */
  normal: Vec3;
  /** distance along the path from its first sample, m */
  s_m: number;
};

/**
 * The path cut into samples at most SAMPLE_MM apart along the polyline (in the object's frame), each moved onto
 * the surface and placed in the world by the object's pose (centre m, row-major rotation). Arc length is measured
 * between the samples on the surface.
 */
export function samplePath(o: Pick<SpecObject, "shape" | "size_mm">, path: Vec3[], centre_m: Vec3, R: number[]): Sample[] {
  const local: Vec3[] = [];
  for (let k = 0; k < path.length; k++) {
    if (k === 0) {
      local.push(path[0]);
      continue;
    }
    const a = path[k - 1];
    const b = path[k];
    const n = Math.max(1, Math.ceil(norm(sub(b, a)) / SAMPLE_MM));
    for (let i = 1; i <= n; i++) local.push(add(a, scale(sub(b, a), i / n)));
  }
  if (local.length > MAX_SAMPLES) throw new Error(`the contact path is ${local.length} mm long; at most ${MAX_SAMPLES} mm can be followed in one step`);
  const out: Sample[] = [];
  for (const p of local) {
    const { point, normal } = onSurface(o, p);
    const world = add(centre_m, rot(R, scale(point, 0.001)));
    const s_m = out.length ? out.at(-1)!.s_m + norm(sub(world, out.at(-1)!.point)) : 0;
    out.push({ point: world, normal: unit(rot(R, normal)), s_m });
  }
  return out;
}

/** The point of a primitive (centre m, row-major rotation, world) furthest along the world direction `d`. */
export function support(o: Pick<SpecObject, "shape" | "size_mm">, centre_m: Vec3, R: number[], d: Vec3): Vec3 {
  const h = scale(halfExtents(o), 0.001);
  const l = rotT(R, unit(d));
  let p: Vec3;
  if (o.shape === "sphere") p = scale(l, h[0]);
  else if (o.shape === "box") p = [Math.sign(l[0]) * h[0], Math.sign(l[1]) * h[1], Math.sign(l[2]) * h[2]];
  else {
    const radial = Math.hypot(l[0], l[1]);
    // within AXIAL of the axis the whole cap faces the surface and its centre stands for it; tipped more, the rim
    // on the side it tips to is what touches first
    const rim: Vec3 = radial > AXIAL ? [(l[0] / radial) * h[0], (l[1] / radial) * h[0], 0] : [0, 0, 0];
    p = [rim[0], rim[1], (Math.sign(l[2]) || 1) * h[2]];
  }
  return add(centre_m, rot(R, p));
}

/** Small spheres on a contact path, for the stage; geoms that touch nothing. */
export function contactMarkersXml(paths: Sample[][]): string {
  const out: string[] = [];
  paths.forEach((path, n) => {
    const every = Math.max(1, Math.ceil(path.length / 40));
    path.forEach((p, i) => {
      if (i % every !== 0 && i !== path.length - 1) return;
      const pos = add(p.point, scale(p.normal, 0.001)).map((v) => v.toFixed(4)).join(" ");
      out.push(`<geom name="contact_${n}_${i}" type="sphere" size="0.003" pos="${pos}" rgba="0.2 0.55 0.85 0.6" contype="0" conaffinity="0" group="2"/>`);
    });
  });
  return out.join("\n");
}
