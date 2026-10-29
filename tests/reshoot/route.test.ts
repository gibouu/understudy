import { beforeAll, describe, expect, it, vi } from "vitest";
import { fieldFor, fieldsOf, originOf, reshootPrompt, type Reshoot, type ReshootBody } from "@/lib/reshoot/reshoot";
import { MODELS } from "@/lib/providers/tokenfactory";
import type { StageResult } from "@/lib/spec/stage-result";
import { LIVE_CLOSED } from "@/lib/unlock/messages";
import { issSample, loadSim } from "../notes/harness";
import { issEvidence } from "./harness";

/** Token Factory stand-in: each create() answers the next reply and records what was sent. */
const tf = vi.hoisted(() => ({ replies: [] as string[], sent: [] as Record<string, unknown>[] }));
vi.mock("@/lib/providers/tokenfactory", async (original) => {
  const real = await original<typeof import("@/lib/providers/tokenfactory")>();
  return {
    ...real,
    wantsReplay: (req: Request) => new URL(req.url).searchParams.get("replay") === "1",
    tokenFactory: () => ({
      models: { list: async () => ({ data: Object.values(real.MODELS).map((id) => ({ id })) }) },
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            tf.sent.push(params);
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
    expect(fieldFor(body.spec, fields, "steps[s2].target.frame")?.path).toBe("steps[s2].target");
    expect(fieldFor(body.spec, fields, "objects[nope].size_mm")).toBeUndefined();
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

  it("replays behind the spend guard, and says why", async () => {
    tf.sent.length = 0;
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("UNDERSTUDY_UNLOCK_CODE", "");
    try {
      const { result } = await post(body);
      expect(tf.sent).toHaveLength(0);
      expect(result).toMatchObject({ status: "done" });
      expect((result as { warnings: string[] }).warnings[0]).toBe(LIVE_CLOSED);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a bad body", async () => {
    expect((await post({ spec: body.spec })).status).toBe(400);
    expect((await post({ ...body, runs: [] })).status).toBe(400);
  });
});
