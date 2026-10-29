/**
 * #56: the playbook replays. tests/fixtures/compile.json holds two live compiles of the pipette sample with
 * its three pocket rules (recorded by tests/measure/playbook.test.ts, Nemotron 3.5 Lightning): the fitted
 * spec, as /try compiles it first, and the answered one. Replay answers them only with the same rules on;
 * with the switch off it answers what it answered before the playbook.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import recordings from "@/tests/fixtures/compile.json";
import { POST } from "@/app/api/compile/route";
import { Session } from "@/lib/showcase/session";
import { DEFAULT_ON, matchRules } from "@/lib/spec/playbook";
import { Program, TaskSpec } from "@/lib/spec/schema";

const pipette = Session.parse(JSON.parse(readFileSync(path.join(process.cwd(), "public", "showcase", "iss-glovebox-pipette.json"), "utf8")));
const post = async (body: unknown) => (await POST(new Request("http://x/api/compile?replay=1", { method: "POST", body: JSON.stringify(body) }))).json();
type Rec = { spec: unknown; playbook?: string[]; result: { status: string; value?: unknown } };
const all = recordings as Rec[];

describe("replay with the playbook", () => {
  const ids = matchRules(pipette.iterations[0].spec, DEFAULT_ON).map((r) => r.id);

  it.each([0, 1])("answers the recording made with the same rules (iteration %s's spec), citing what it applied", async (i) => {
    const spec = pipette.iterations[i].spec;
    const rec = all.find((r) => r.playbook && JSON.stringify(TaskSpec.parse(r.spec)) === JSON.stringify(spec));
    expect(rec?.playbook).toEqual(ids);
    const res = await post({ spec, playbook: { rules: [...DEFAULT_ON] } });
    expect(res.status).toBe("done");
    expect(Program.parse(res.value)).toEqual(Program.parse(rec!.result.value));
    expect(res.value.playbook.length).toBeGreaterThan(0);
    for (const c of res.value.playbook) expect(ids.map((x) => `playbook#${x}`)).toContain(c);
  });

  it("with no recording made with these rules, answers the one without the playbook and says so", async () => {
    // the demo spec's answered compile (tests/providers/compile.test.ts), a pocket task recorded before the playbook
    const spec = TaskSpec.parse(all[1].spec);
    expect(matchRules(spec, DEFAULT_ON).length).toBeGreaterThan(0);
    const res = await post({ spec, playbook: { rules: [...DEFAULT_ON] } });
    expect(res.status).toBe("done");
    expect(res.warnings).toContain("replay: recorded without the playbook");
    // the model that wrote it never saw the rules: no claim either way
    expect(res.value.playbook).toBeUndefined();
    expect({ ...Program.parse(res.value), playbook: undefined }).toEqual({ ...Program.parse(all[1].result.value), playbook: undefined });
  });

  it("with the switch off, never answers a recording made with the playbook", async () => {
    for (const i of [0, 1]) {
      const res = await post({ spec: pipette.iterations[i].spec });
      expect(res.value?.playbook).toBeUndefined();
    }
    // every recording from before the playbook still answers its own spec
    for (const r of all.filter((x) => !x.playbook && x.result.status === "done")) {
      const res = await post({ spec: r.spec });
      expect(res.status).toBe("done");
      expect(res.value.playbook).toBeUndefined();
    }
  });
});
