/**
 * The geometry of a pour the variants keep: which step is the pour, and the
 * line it pours along, from the held container's centre toward the target's,
 * with the gap between their facing rims. A variant's target stands that far
 * from the held container's rim whatever its size (validate.ts, pourBench);
 * the prompt states the same gap.
 */
import { footprintMm, worldPoses, type Pose3 } from "@/lib/sim/scene";
import type { SpecObject, Step, TaskSpec } from "@/lib/spec/schema";

const DEG = Math.PI / 180;

export type Pour = Step & { pour: NonNullable<Step["pour"]> };

/** The rehearsed pour of a spec: its first step that pours, whole (lib/sim/liquid.ts fills that one's container). */
export const pourOf = (spec: TaskSpec): Pour | undefined => spec.steps.find((s): s is Pour => s.verb === "pour" && s.pour !== undefined);

/** Half the width of a container's footprint along the unit direction `u` of the table, turned `yaw` degrees: the scene builds every container as an open box, whatever its shape. */
export function halfAlong(o: SpecObject, yaw: number, u: [number, number]): number {
  const [a, b] = footprintMm(o);
  const [c, s] = [Math.cos(yaw * DEG), Math.sin(yaw * DEG)];
  return (Math.abs(u[0] * c + u[1] * s) * a + Math.abs(-u[0] * s + u[1] * c) * b) / 2;
}

/**
 * The line a pour pours along, in `world` (worldPoses of `spec`): `from` the
 * held container's centre, unit direction `u` toward the target's, and the
 * `gap` between their facing rims, mm.
 */
export function pourLine(spec: TaskSpec, pour: Pour, world: Record<string, Pose3> = worldPoses(spec)): { from: [number, number]; u: [number, number]; gap: number } {
  const object = (id: string) => spec.objects.find((o) => o.id === id)!;
  const [a, b] = [world[pour.object].xyz_mm, world[pour.pour.into].xyz_mm];
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const u: [number, number] = d > 0 ? [(b[0] - a[0]) / d, (b[1] - a[1]) / d] : [0, 1];
  const gap = d - halfAlong(object(pour.object), world[pour.object].yaw_deg, u) - halfAlong(object(pour.pour.into), world[pour.pour.into].yaw_deg, u);
  return { from: [a[0], a[1]], u, gap };
}
