/**
 * #56 review: with the playbook on, a replay never does worse than with it off. For each NASA manipulation
 * sample, at the specs /try compiles from its recording (the fitted spec, iteration 0, and the answered one,
 * iteration 1), the route is asked in replay with the rules the page would send. Where it has no compile made
 * with them, its answer is not made with the playbook (madeWithPlaybook false, no citation claimed) and the
 * page plays the clip's recorded turn instead (app/flow.tsx compile), as the switch-off path does.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/compile/route";
import { turnFor } from "@/lib/showcase/play";
import { Session } from "@/lib/showcase/session";
import { DEFAULT_ON, madeWithPlaybook, matchRules } from "@/lib/spec/playbook";
import { Program } from "@/lib/spec/schema";

const session = (clip: string) => Session.parse(JSON.parse(readFileSync(path.join(process.cwd(), "public", "showcase", `${clip}.json`), "utf8")));
const post = async (body: unknown) => (await POST(new Request("http://x/api/compile?replay=1", { method: "POST", body: JSON.stringify(body) }))).json();

const CASES = ["iss-glovebox-pipette", "iss-veggie-seed-film", "iss-fluid-bag-foam", "iss-veggie-seed-film-2", "dev-clip"].flatMap((clip) => [0, 1].map((i) => [clip, i] as const));

describe("the playbook on, in replay, against the switch off", () => {
  it.each(CASES)("%s, iteration %s: the page shows a program, never a failure the switch off would not show", async (clip, i) => {
    const rec = session(clip);
    const spec = rec.iterations[i].spec;
    // what the switch off shows: the recorded turn
    const off = turnFor(rec, spec);
    expect(off, "the switch off plays the recording").not.toBeNull();
    const rules = matchRules(spec, DEFAULT_ON).map((r) => r.id);
    expect(rules.length, "the page sends rules for this sample").toBeGreaterThan(0);
    const r = await post({ spec, playbook: { rules } });
    if (madeWithPlaybook(r)) {
      // only the pipette has compiles recorded with its rules (tests/fixtures/compile.json)
      expect(clip).toBe("iss-glovebox-pipette");
      expect(r.value.playbook.length).toBeGreaterThan(0);
      return;
    }
    // no playbook answer: it claims nothing about the rules, and the page plays the same turn as the switch off
    expect(r.value?.playbook).toBeUndefined();
    const shown = turnFor(rec, spec)!;
    expect(Program.parse(shown.program)).toEqual(Program.parse(off!.program));
  });

  it("answers the pipette with its playbook recordings, at both specs", async () => {
    for (const i of [0, 1]) {
      const spec = session("iss-glovebox-pipette").iterations[i].spec;
      expect(madeWithPlaybook(await post({ spec, playbook: { rules: matchRules(spec, DEFAULT_ON).map((r) => r.id) } }))).toBe(true);
    }
  });
});
