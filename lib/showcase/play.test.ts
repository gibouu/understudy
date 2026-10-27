/**
 * /try plays a sample's recording (#138): every recording, walked as the page
 * walks it, finds its compiles, its answers and its Notes patches, and a
 * change the recording never saw finds nothing, so the page goes live. The
 * routes answer the recorded label and patches with no model and no key.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { POST as label } from "@/app/api/label/route";
import { POST as notes } from "@/app/api/notes/route";
import { formFor } from "@/lib/spec/answer";
import { applyChanges } from "@/lib/spec/apply";
import type { Predicate, ProgramOp, SpecChange, TaskSpec } from "@/lib/spec/schema";
import { estimate, usual } from "@/lib/estimate";
import { canonical, formAnswers, recordedLine, turnFor } from "./play";
import { LabelRecording, Session } from "./session";

const DIR = path.join(process.cwd(), "public", "showcase");
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const sessions = files.filter((f) => !f.endsWith(".label.json")).map((f) => Session.parse(JSON.parse(readFileSync(path.join(DIR, f), "utf8"))));
const labelOnly = files.filter((f) => f.endsWith(".label.json")).map((f) => LabelRecording.parse(JSON.parse(readFileSync(path.join(DIR, f), "utf8"))));

type Ask = Extract<ProgramOp, { op: "ask" }>;

/** The flow's answer(): the form's values become spec changes, in the program's order (app/flow.tsx). */
function answer(spec: TaskSpec, asks: Ask[], values: Record<string, string>, turn: number): TaskSpec {
  const changes: SpecChange[] = [];
  for (const a of asks) {
    const raw = values[a.slot];
    if (raw === undefined || raw === "") continue;
    const form = formFor(spec, a.slot);
    const value: number | Predicate[] = form.kind === "success" ? form.options[Number(raw)].predicates : Number(raw);
    changes.push({ path: a.slot, value, source: `interview#${turn + 1}` });
  }
  const applied = applyChanges(spec, changes);
  expect(applied.warnings).toEqual([]);
  return applied.spec;
}

const post = (route: (req: Request) => Promise<Response>, url: string, body: unknown) => route(new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe.each(sessions.map((s) => [s.clip.name, s] as const))("%s on /try", (_, session) => {
  it("plays every compile, with the recorded answers filled in", () => {
    let spec = session.fit.spec;
    for (const [i, turn] of session.turns.entries()) {
      const found = turnFor(session, spec);
      expect(found, `turn ${i}`).toBe(turn);
      if (i === session.turns.length - 1) break;
      const asks = turn.program.steps.flatMap((s) => s.ops).filter((op): op is Ask => op.op === "ask");
      spec = answer(spec, asks, formAnswers(spec, turn), i);
    }
    // the rehearsal and Notes see the spec the last compile was made for
    expect(canonical(spec)).toBe(canonical(session.iterations[session.turns.length - 1].spec));
  });

  it("goes live for a spec it never saw", () => {
    expect(turnFor(session, { ...session.fit.spec, title: `${session.fit.spec.title} (edited)` })).toBeNull();
  });

  it("answers the label it recorded, with a sample token's slot, and says when", async () => {
    const r = await (await post(label, "/api/label", { clip_sha256: session.clip.sha256, recorded: true })).json();
    expect(r.status).toBe("done");
    expect(canonical(r.value)).toBe(canonical(session.label.spec));
    expect(recordedLine(r.warnings)).toMatch(/^recorded on \d{1,2} \w{3} 20\d\d, Nemotron 3\.5 Super VL$/);
  });

  it("answers each Notes patch for the program and attempt it was made for, and nothing else", async () => {
    const notesAt = session.iterations.flatMap((it, i) => (it.source === "notes" ? [i] : []));
    for (const [attempt, i] of notesAt.entries()) {
      const before = session.iterations[i - 1];
      const runs = [{ world: "orbit", rollout: { pass: false, t: 1, log: [] } }];
      const history = Array.from({ length: attempt }, () => ({ set: {}, thinking: false, clamps: [], rejected: [], outcome: "fails in orbit" }));
      const body = { spec: before.spec, program: before.program, runs, first: "fails in orbit", history };
      const r = await (await post(notes, "/api/notes", body)).json();
      expect(r.status, `patch ${attempt + 1}`).toBe("done");
      expect(r.value.program).toEqual(session.iterations[i].program);
      expect(recordedLine(r.warnings)).toMatch(/^recorded on .*Nemotron 3 Super/);
      // the recorder asks again with fresh: never the recorded patch (with no key the route replays its own fixtures)
      const again = await (await post(notes, "/api/notes", { ...body, fresh: true })).json();
      expect(recordedLine(again.warnings ?? [])).toBeUndefined();
      // the same program asked as another attempt is not this recording's patch
      const other = await (await post(notes, "/api/notes?replay=1", { ...body, history: [...history, history[0] ?? { set: {}, thinking: false, clamps: [], rejected: [], outcome: "x" }] })).json();
      expect(recordedLine(other.warnings ?? [])).not.toBe(recordedLine(r.warnings));
    }
  });
});

describe.each(labelOnly.map((r) => [r.clip.name, r] as const))("%s, recorded up to its label", (_, rec) => {
  it("answers its label at once", async () => {
    const r = await (await post(label, "/api/label", { clip_sha256: rec.clip.sha256, recorded: true })).json();
    expect(canonical(r.value)).toBe(canonical(rec.label.spec));
    expect(recordedLine(r.warnings)).toMatch(/^recorded on /);
  });
});

describe("a clip with no recording", () => {
  it("gets a 404, so the page labels it live", async () => {
    const res = await post(label, "/api/label", { clip_sha256: "c".repeat(64), recorded: true });
    expect(res.status).toBe(404);
  });
});

describe("the estimates (docs/MEASUREMENTS.md section 12)", () => {
  it("say a range that grows with the clip", () => {
    expect(usual("recorded", 10)).toBeUndefined();
    expect(usual("proxy", 8)).toBe("under 5 s");
    expect(usual("watch", 8)).toBe("4 to 15 s");
    expect(usual("watch", 36)).toBe("8 to 25 s");
    expect(estimate(8)).toBe("5 to 25 seconds");
    expect(estimate(36)).toBe("10 to 35 seconds");
    expect(estimate(120)).toBe("20 to 65 seconds");
  });
});
