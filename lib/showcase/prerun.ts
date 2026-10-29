/**
 * Run a sample's similar tasks once, ahead of time, so /try never waits on a
 * model for them: the spec the page ends on once the recorded answers are
 * given (the recording's last interview iteration), Super's suggestions for
 * it through POST /api/variants, and each suggestion's program through POST
 * /api/compile, as app/variants.tsx asks for them. Saved as
 * public/showcase/<clip>.variants.json; lib/showcase/lookup.ts answers it.
 * lib/showcase/prerun.test.ts runs it.
 */
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { Program } from "@/lib/spec/schema";
import type { LedgerEntry } from "@/lib/spec/stage-result";
import type { Checked } from "@/lib/variants/validate";
import { live, post, priceOf } from "./record";
import { VariantsRecording, type Session } from "./session";

/** Stop before a clip's calls pass this, at list prices: about 20 times what one costs. */
const CAP_USD = 0.05;

/** The version of the task the page hands to the similar-tasks section: the last one the interview made. */
export function baseOf(rec: Session) {
  const it = rec.iterations.findLast((x) => x.source !== "notes");
  if (!it) throw new Error(`${rec.clip.name}: no compile or interview iteration`);
  return { spec: it.spec, program: it.program };
}

const usd = (ledger: LedgerEntry[] = []) => ledger.reduce((t, e) => t + priceOf(e), 0);

export async function prerunClip(root: string, rec: Session, log: (line: string) => void = () => {}): Promise<VariantsRecording> {
  // an earlier pre-run would answer these very requests: the routes must go live
  const out = path.join(root, "public", "showcase", `${rec.clip.name}.variants.json`);
  if (existsSync(out)) rmSync(out);
  const { POST: variantsRoute } = await import("@/app/api/variants/route");
  const { POST: compileRoute } = await import("@/app/api/compile/route");
  const base = baseOf(rec);

  const suggestions = live(await post<Checked>(variantsRoute, "/api/variants", { spec: base.spec, first: 1 }), "variants");
  let total = usd(suggestions.ledger);
  log(`${rec.clip.name}: ${suggestions.value.variants.length} similar tasks, ${suggestions.value.not_yet.length} not yet`);

  const programs: VariantsRecording["programs"] = [];
  for (const v of suggestions.value.variants) {
    if (total > CAP_USD) throw new Error(`${rec.clip.name}: over US$${CAP_USD} before ${v.title}`);
    const r = await post<Program>(compileRoute, "/api/compile", { spec: v.spec, previous: base.program });
    // a gesture's program is written by the route with no model
    const gestures = v.spec.steps.every((s) => s.verb === "gesture");
    const kept = live(r, `compile ${v.title}`, !gestures);
    total += usd(kept.ledger);
    programs.push({ id: v.id, spec: v.spec, result: kept });
    log(`  ${v.id} ${v.title}: ${kept.value.steps.length} steps`);
  }

  return VariantsRecording.parse({
    version: 1,
    clip: rec.clip,
    recorded_at: new Date().toISOString(),
    spec: base.spec,
    suggestions,
    programs,
    total_usd: Number(total.toFixed(6)),
  });
}
