/**
 * What the ISS sample's page posts to /api/reshoot in replay: the compiled program's rehearsal at
 * 1 g and 0 g, and each patch the replayed patch loop (tests/fixtures/notes.json) tried after it.
 */
import { outcomeLine } from "@/lib/notes/note";
import type { PatchTried, ReshootBody } from "@/lib/reshoot/reshoot";
import type { Program, TaskSpec } from "@/lib/spec/schema";
import { patchLoop, rehearse } from "../notes/harness";

export async function issEvidence(spec: TaskSpec, program: Program): Promise<ReshootBody> {
  const runs = rehearse(spec, program);
  const { rounds, final } = await patchLoop(spec, program, "http://test/api/notes?replay=1");
  const patches: PatchTried[] = rounds.flatMap((r, i) => {
    if (r.result.status !== "done") return [];
    const p = r.result.value;
    // a patch's outcome is the rehearsal the next round started from, or the final one
    const after = rounds[i + 1]?.runs ?? final;
    return [{ n: i + 1, changes: p.noop ? "no change" : p.changes.map((c) => `${c.name}: ${c.from} → ${c.to}`).join(", "), why: p.why, outcome: outcomeLine(after) }];
  });
  return { spec, program, runs, patches };
}
