/**
 * The spot on the bench that "somewhere else on the bench" answers (#155): put in a spec by the fit
 * (lib/sim/fit.ts whereTo) beside the scene's own objects, and offered last by formFor
 * (lib/spec/answer.ts). It is told apart by its source, "fit", which no labelled object has: a
 * label's ids are the model's to choose, so the id is only made unique.
 */
import type { SpecObject, TaskSpec } from "./schema";

export const BENCH_SPOT_NAME = "spot on the bench";

export const isBenchSpot = (o: SpecObject) => o.source === "fit" && o.name === BENCH_SPOT_NAME;

/** A spot on the bench for this spec, with an id none of its objects has. */
export function benchSpot(spec: TaskSpec): SpecObject {
  const ids = new Set(spec.objects.map((o) => o.id));
  let id = "bench_spot";
  for (let n = 2; ids.has(id); n++) id = `bench_spot_${n}`;
  return { id, name: BENCH_SPOT_NAME, shape: "box", size_mm: [100, 100, 10], symmetry: "none", role: "surface", confidence: 1, source: "fit", sources: {} };
}
