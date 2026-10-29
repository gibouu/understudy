import { beforeAll, describe, expect, it, vi } from "vitest";
import { fieldFor, fieldsOf, originOf, reshootPrompt, type Reshoot, type ReshootBody } from "@/lib/reshoot/reshoot";
import { MODELS } from "@/lib/providers/tokenfactory";
import type { StageResult } from "@/lib/spec/stage-result";
import { LIVE_CLOSED, LIVE_NO_BUDGET } from "@/lib/unlock/messages";
import { fakeRedis } from "@/tests/store/fake-redis";
import { issSample, loadSim } from "../notes/harness";
import { issEvidence } from "./harness";

/** Token Factory stand-in: each create() answers the next reply and records what was sent. */
const tf = vi.hoisted(() => ({ replies: [] as string[], sent: [] as Record<string, unknown>[], hang: false }));
vi.mock("@/lib/providers/tokenfactory", async (original) => {
  const real = await original<typeof import("@/lib/providers/tokenfactory")>();
  return {
    ...real,
    wantsReplay: (req: Request) => new URL(req.url).searchParams.get("replay") === "1",
    tokenFactory: () => ({
      withOptions() {
        return this;
      },
      models: { list: async () => ({ data: Object.values(real.MODELS).map((id) => ({ id })) }) },
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            tf.sent.push(params);
            if (tf.hang) return new Promise(() => {});
            return { choices: [{ message: { content: tf.replies.shift() } }], usage: { prompt_tokens: 2000, completion_tokens: 600 } };
          },
        },
      },
    }),
  };
});
const { POST } = await import("@/app/api/reshoot/route");

let body: ReshootBody;

beforeAll(async () => {
  await loadSim();
  const { spec, program } = await issSample();
  body = await issEvidence(spec, program);
}, 60_000);

async function post(b: unknown, url = "http://test/api/reshoot"): Promise<{ status: number; result: StageResult<Reshoot> }> {
  const res = await POST(new Request(url, { method: "POST", body: JSON.stringify(b) }));
  return { status: res.status, result: (await res.json()) as StageResult<Reshoot> };
}

describe("the reshoot list's fields", () => {
  it("knows which fields came from the clip, from an answer, or from elsewhere", () => {
    expect(originOf("vl#seg2")).toBe("video");
    expect(originOf("pose#seg1")).toBe("video");
    expect(originOf("interview#3")).toBe("interview");
    for (const s of ["default", "fit", "tavily:https://example.org", "user#edit", "playbook#1"]) expect(originOf(s)).toBe("other");
    const fields = fieldsOf(body.spec);
    expect(fields.find((f) => f.path === "objects[obj2].pocket_clearance_mm")).toMatchObject({ origin: "interview", source: "interview#1" });
    // the bench fit resized the objects: their sizes cannot be refilmed
    expect(fields.find((f) => f.path === "objects[obj1].size_mm")).toMatchObject({ origin: "other", source: "fit" });
    // a bare id and a sub-path both find the listed field
    expect(fieldFor(body.spec, fields, "obj2.pocket_clearance_mm")?.path).toBe("objects[obj2].pocket_clearance_mm");
    expect(fieldFor(body.spec, fields, "steps[s2].target.frame")).toMatchObject({ path: "steps[s2].target.frame", source: "vl#seg2" });
    expect(fieldFor(body.spec, fields, "objects[nope].size_mm")).toBeUndefined();
  });

  it("never lets a part from elsewhere, a path that does not exist, or a prototype key through", () => {
    const s2 = body.spec.steps.find((s) => s.id === "s2")!;
    const spec = {
      ...body.spec,
      steps: body.spec.steps.map((s) =>
        s.id === "s2"
          ? { ...s, via_points: [{ frame: "obj2", xyz_mm: [0, 0, 30] as [number, number, number], source: "default" }], sources: { ...s2.sources, "pose.__proto__": "interview#1", constructor: "interview#2", "nope.leaf": "interview#3" } }
          : s,
      ),
    };
    const fields = fieldsOf(spec);
    // a default via-point inside a step labelled from the clip is judged by its own source
    expect(fieldFor(spec, fields, "steps[s2].via_points.0.xyz_mm")).toMatchObject({ origin: "other", source: "default" });
    expect(fields.some((f) => /__proto__|constructor|nope/.test(f.path))).toBe(false);
    expect(fieldFor(spec, fields, "steps[s2].__proto__")).toBeUndefined();
    expect(fieldFor(spec, fields, "steps[s2].constructor")).toBeUndefined();
    expect(fieldFor(spec, fields, "objects[obj2].pose.nonexistent")).toBeUndefined();

    // a list replaced by hand speaks for its points; a part edited by hand keeps its parent out, not its siblings
    const edited = {
      ...spec,
      objects: spec.objects.map((o) => (o.id === "obj2" ? { ...o, source: "vl#seg2", sources: { ...o.sources, pose: "vl#seg2", "pose.yaw_deg": "user#edit" } } : o)),
      steps: spec.steps.map((s) => (s.id === "s2" ? { ...s, via_points: [{ ...s.via_points[0], source: "pose#seg1" }], sources: { ...s.sources, via_points: "user#edit" } } : s)),
    };
    const ef = fieldsOf(edited);
    expect(fieldFor(edited, ef, "steps[s2].via_points.0.xyz_mm")).toMatchObject({ origin: "other", source: "user#edit" });
    expect(fieldFor(edited, ef, "objects[obj2].pose")).toBeUndefined();
    expect(fieldFor(edited, ef, "objects[obj2].pose.xyz_mm")).toMatchObject({ path: "objects[obj2].pose.xyz_mm", origin: "video" });
    expect(fieldFor(edited, ef, "objects[obj2].pose.yaw_deg")).toMatchObject({ origin: "other" });

    // a whole record replaced by hand: nothing in it is from the clip any more, whatever it says inside
    const replaced = { ...body.spec, sources: { ...body.spec.sources, "objects.obj2": "user#edit" } };
    const rf = fieldsOf(replaced);
    expect(fieldFor(replaced, rf, "objects[obj2].pocket_clearance_mm")).toMatchObject({ origin: "other", source: "user#edit" });
    expect(fieldFor(replaced, rf, "objects[obj1].name")).toMatchObject({ origin: "video" });
    // replaced twice, under its id from an answer and under its index by hand: the hand edit counts
    const twice = { ...body.spec, sources: { ...body.spec.sources, "objects.obj2": "interview#1", "objects.1": "user#edit" } };
    expect(fieldFor(twice, fieldsOf(twice), "objects[obj2].pocket_clearance_mm")).toMatchObject({ origin: "other", source: "user#edit" });
    // replaced by hand and renamed: the key names no record now, so it counts for every one
    const renamed = { ...body.spec, objects: body.spec.objects.map((o) => (o.id === "obj2" ? { ...o, id: "renamed" } : o)), sources: { ...body.spec.sources, "objects.obj2": "user#edit" } };
    expect(fieldFor(renamed, fieldsOf(renamed), "objects[renamed].pocket_clearance_mm")).toMatchObject({ origin: "other", source: "user#edit" });
    const dotted = { ...renamed, sources: { ...body.spec.sources, "objects.a.b": "user#edit" } };
    expect(fieldFor(dotted, fieldsOf(dotted), "objects[renamed].pocket_clearance_mm")).toMatchObject({ origin: "other" });
    const list = { ...body.spec, sources: { ...body.spec.sources, steps: "default" } };
    expect(fieldFor(list, fieldsOf(list), "steps[s2].target")).toMatchObject({ origin: "other" });
  });

  it("puts the run, the patches and the final outcome in the prompt", () => {
    const p = reshootPrompt(body.spec, body);
    expect(p).toContain("orbit (0 g): FAIL");
    expect(p).toContain("patch 1:");
    expect(p).toContain("Final outcome: earth (1 g) PASS; orbit (0 g) PASS");
    expect(p).toContain("(source interview#1: interview)");
  });
});

describe("POST /api/reshoot", () => {
  it("answers the ISS sample from its recording with ?replay=1, and asks no model", async () => {
    tf.sent.length = 0;
    const { result } = await post(body, "http://test/api/reshoot?replay=1");
    expect(tf.sent).toHaveLength(0);
    expect(result.status).toBe("done");
    const done = result as Extract<StageResult<Reshoot>, { status: "done" }>;
    expect(done.warnings[0]).toBe("replay: recorded reshoot list");
    expect(done.value.model).toBe("nvidia/Nemotron-3-Ultra-550b-a55b");
    expect(done.value.failure_classes.length).toBeGreaterThan(0);
    // every recorded reshoot item names a field from the clip or from an answer
    for (const r of done.value.reshoot) expect(["video", "interview"]).toContain(r.origin);
  });

  it("says when the recording was made after another outcome, and has nothing for another task", async () => {
    const changed = { ...body, patches: body.patches.slice(0, 1) };
    const { result } = await post(changed, "http://test/api/reshoot?replay=1");
    expect(result).toMatchObject({ status: "done" });
    expect((result as { warnings: string[] }).warnings).toContain("replay: recorded after a rehearsal with another outcome");
    // the recorded items are checked again against the spec posted now: fields from elsewhere drop out
    const refit = { ...body, program: { ...body.program, spec_title: "x" }, spec: { ...body.spec, objects: body.spec.objects.map((o) => ({ ...o, source: "fit", sources: {} })), steps: body.spec.steps.map((s) => ({ ...s, source: "default", sources: {} })) } };
    const again = (await post(refit, "http://test/api/reshoot?replay=1")).result as Extract<StageResult<Reshoot>, { status: "done" }>;
    expect(again.value.reshoot).toEqual([]);
    expect(again.value.dropped.length).toBeGreaterThan(0);
    expect(again.warnings).toContain("replay: recorded for another version of the program");
    const other = { ...body, spec: { ...body.spec, title: "something else" } };
    expect((await post(other, "http://test/api/reshoot?replay=1")).result).toMatchObject({ status: "failed", message: "no recorded reshoot list for this task" });
  });

  it("asks Ultra with thinking on and 16,000 tokens, and keeps only the reshoot items for fields from the clip or an answer", async () => {
    tf.sent.length = 0;
    tf.replies.push(
      JSON.stringify({
        failure_classes: [{ class: "Spec gap", evidence: "orbit (0 g) FAIL at s2 op 3: obj1 moving at 16.9 mm/s", fields: ["steps[s2].target"] }],
        reshoot: [
          { field: "obj2.pocket_clearance_mm", why: "a guess", ask: "How deep is the pocket?" },
          { field: "objects[obj1].size_mm", why: "sized by the fit", ask: "Film it with a ruler" },
          { field: "objects[obj9].shape", why: "no such object", ask: "?" },
        ],
        open_risks: ["a flexible film"],
      }),
    );
    const { result } = await post(body);
    expect(tf.sent).toHaveLength(1);
    expect(tf.sent[0]).toMatchObject({ model: MODELS.ultra, max_tokens: 16_000 });
    expect(tf.sent[0].extra_body).toBeUndefined();
    expect(result.status).toBe("done");
    const v = (result as Extract<StageResult<Reshoot>, { status: "done" }>).value;
    expect(v.failure_classes[0].class).toBe("spec_gap");
    expect(v.reshoot).toEqual([{ field: "objects[obj2].pocket_clearance_mm", source: "interview#1", origin: "interview", why: "a guess", ask: "How deep is the pocket?" }]);
    expect(v.dropped).toEqual(["objects[obj1].size_mm: its source is fit, not the clip or an answer", "objects[obj9].shape: not a field of this spec"]);
    expect(v).toMatchObject({ thinking: true, model: MODELS.ultra, outcome: "earth (1 g) PASS; orbit (0 g) PASS", tokens: 2600 });
    expect(v.cost_usd).toBeGreaterThan(0);
  });

  it("says what a failed list cost", async () => {
    tf.sent.length = 0;
    tf.replies.push("not json", "{\"failure_classes\": \"no\"}");
    const { result } = await post(body);
    expect(tf.sent).toHaveLength(2);
    expect(result).toMatchObject({ status: "failed" });
    expect((result as { message: string }).message).toMatch(/\(2 calls, \$0\.\d{4}\)$/);
  });

  it("answers within its deadline when the model never does", async () => {
    tf.sent.length = 0;
    tf.hang = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = post(body);
      await vi.advanceTimersByTimeAsync(100_000);
      const { result } = await pending;
      expect(result).toMatchObject({ status: "failed" });
      expect((result as { message: string }).message).toContain("no usable answer within 100 s");
    } finally {
      vi.useRealTimers();
      tf.hang = false;
    }
  });

  it("replays behind the spend guard, and says why", async () => {
    tf.sent.length = 0;
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("UNDERSTUDY_UNLOCK_CODE", "");
    fakeRedis();
    try {
      const { result } = await post(body);
      expect(tf.sent).toHaveLength(0);
      expect(result).toMatchObject({ status: "done" });
      expect((result as { warnings: string[] }).warnings[0]).toBe(LIVE_CLOSED);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it("replays when the live budget turns the call away halfway", async () => {
    tf.sent.length = 0;
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("UNDERSTUDY_UNLOCK_CODE", "let-me-in");
    // the gate reads money left; the reservation for Ultra's call then fails, so callModel does not make it
    fakeRedis().refuse.push("INCRBY");
    try {
      const { result } = await post({ ...body, unlock: "let-me-in" });
      expect(tf.sent).toHaveLength(0);
      expect(result).toMatchObject({ status: "done" });
      expect((result as { warnings: string[] }).warnings[0]).toBe(LIVE_NO_BUDGET);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it("refuses a bad body", async () => {
    expect((await post({ spec: body.spec })).status).toBe(400);
    expect((await post({ ...body, runs: [] })).status).toBe(400);
  });
});
