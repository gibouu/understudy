import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { NotePatch } from "@/lib/notes/patch";
import { MODELS } from "@/lib/providers/tokenfactory";
import { outcomeLine, type WorldRun } from "@/lib/notes/note";
import type { Program, TaskSpec } from "@/lib/spec/schema";
import type { StageResult } from "@/lib/spec/stage-result";
import { issSample, loadSim, rehearse } from "./harness";

/** Token Factory stand-in: each create() answers the next reply and records what was sent. */
const tf = vi.hoisted(() => ({ replies: [] as string[], sent: [] as Record<string, unknown>[], superModel: "" }));
vi.mock("@/lib/providers/tokenfactory", async (original) => {
  const real = await original<typeof import("@/lib/providers/tokenfactory")>();
  return {
    ...real,
    // `superModel` stands in for Super's own ID, kept with UNDERSTUDY_KEEP_RETIRED=1
    MODELS: {
      ...real.MODELS,
      get super() {
        return tf.superModel || real.MODELS.super;
      },
    },
    wantsReplay: (req: Request) => new URL(req.url).searchParams.get("replay") === "1",
    tokenFactory: () => ({
      models: { list: async () => ({ data: Object.values(real.MODELS).map((id) => ({ id })) }) },
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            tf.sent.push(params);
            return { choices: [{ message: { content: tf.replies.shift() } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } };
          },
        },
      },
    }),
  };
});
const { POST } = await import("@/app/api/notes/route");

let spec: TaskSpec;
let program: Program;
let runs: WorldRun[];

beforeAll(async () => {
  await loadSim();
  ({ spec, program } = await issSample());
  runs = rehearse(spec, program);
}, 60_000);

async function post(body: unknown, url = "http://test/api/notes"): Promise<{ status: number; result: StageResult<NotePatch> }> {
  const res = await POST(new Request(url, { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, result: (await res.json()) as StageResult<NotePatch> };
}

const attempt = (thinking: boolean) => ({ set: { "s2.op3.timeout_s": 5 }, thinking, clamps: [], rejected: [], outcome: "orbit (0 g) FAIL" });

describe("POST /api/notes", () => {
  const OFF = { max_tokens: 800, extra_body: { chat_template_kwargs: { enable_thinking: false } } };

  it("re-asks a no-op with Nemotron 3 Ultra, thinking off, at once (Super VL cannot think within 4,096 tokens), and prices both calls", async () => {
    tf.sent.length = 0;
    tf.replies.push('{"set":{"s2.op0.x_mm":0},"why":"a"}', '{"set":{"s2.op1.z_mm":13},"why":"b","expect":"c"}');
    const { result } = await post({ spec, program, runs, first: outcomeLine(runs), history: [] });
    expect(result.status).toBe("done");
    const v = (result as Extract<StageResult<NotePatch>, { status: "done" }>).value;
    // stuck, but Ultra did not think: the page says "Nemotron 3 Ultra: the cheap patch changed nothing" (app/patch-loop.tsx)
    expect(v).toMatchObject({ set: { "s2.op1.z_mm": 13 }, thinking: true, thought: false, escalation: "noop", model: MODELS.ultra, why: "b", expect: "c", noop: false });
    expect((result as Extract<StageResult<NotePatch>, { status: "done" }>).warnings).toContain("the patch changed nothing: asked Nemotron 3 Ultra");
    expect(v.cost_usd).toBeGreaterThan(0);
    expect(v.note).toContain("orbit (0 g): FAIL");
    expect(tf.sent[0]).toMatchObject({ model: "nvidia/Nemotron-3.5-Super-VL", ...OFF });
    expect(tf.sent[1]).toMatchObject({ model: MODELS.ultra, ...OFF });
    expect(String((tf.sent[1].messages as { content: string }[])[1].content)).toContain("Return patch 1 of at most 5.");
  });

  it("asks Ultra from the start after two failed cheap patches, and reports what it clamped", async () => {
    tf.sent.length = 0;
    tf.replies.push('{"set":{"s2.op1.z_mm":0}}');
    const { result } = await post({ spec, program, runs, first: outcomeLine(runs), history: [attempt(false), attempt(false)] });
    expect(tf.sent).toHaveLength(1);
    expect(tf.sent[0]).toMatchObject({ model: MODELS.ultra, ...OFF });
    expect(result).toMatchObject({ status: "done", value: { thinking: true, thought: false, escalation: "two_failed", model: MODELS.ultra, set: { "s2.op1.z_mm": 13 }, clamps: [{ name: "s2.op1.z_mm", requested: 0, applied: 13 }] } });
  });

  it("counts every billed call, the unusable answers too", async () => {
    tf.sent.length = 0;
    tf.replies.push("not json", "still not json", '{"set":{"s2.op1.z_mm":13},"why":"b"}');
    const { result } = await post({ spec, program, runs, first: outcomeLine(runs), history: [] });
    expect(tf.sent).toHaveLength(3);
    expect(result).toMatchObject({ status: "done", value: { thinking: true, escalation: "noop", tokens: 3300 } });
    const ledger = (result as Extract<StageResult<NotePatch>, { status: "done" }>).ledger;
    expect(ledger).toHaveLength(3);
  });

  it("says what a failed patch cost", async () => {
    tf.sent.length = 0;
    tf.replies.push("x", "y", "z", "w");
    const { result } = await post({ spec, program, runs, first: outcomeLine(runs), history: [] });
    expect(tf.sent).toHaveLength(4);
    expect(result).toMatchObject({ status: "failed" });
    expect((result as { message: string }).message).toMatch(/\(4 calls, \$0\.\d{4}\)$/);
  });

  it("refuses a bad body, a program that passed everywhere, and a sixth patch", async () => {
    expect((await post({ spec })).status).toBe(400);
    const passing = runs.map((r) => ({ ...r, rollout: { ...r.rollout, pass: true } }));
    expect(await post({ spec, program, runs: passing, first: "" })).toMatchObject({ status: 400, result: { status: "failed" } });
    expect((await post({ spec, program, runs, first: "", history: Array.from({ length: 5 }, () => attempt(true)) })).status).toBe(400);
  });

  it("answers from the recording with ?replay=1, and says so for a program it has not seen", async () => {
    tf.sent.length = 0;
    const { result } = await post({ spec, program, runs, first: outcomeLine(runs), history: [] }, "http://test/api/notes?replay=1");
    expect(result.status).toBe("done");
    expect(tf.sent).toHaveLength(0);
    const other = { ...program, spec_title: "something else" };
    expect((await post({ spec, program: other, runs, first: "" }, "http://test/api/notes?replay=1")).result).toMatchObject({ status: "failed", message: "no recorded patch for this program" });
  });
});

describe("POST /api/notes on Nemotron 3 Super (UNDERSTUDY_KEEP_RETIRED=1)", () => {
  afterEach(() => {
    tf.superModel = "";
  });

  it("re-asks a no-op with Super's own thinking (4,096 tokens), as measured in section 8", async () => {
    tf.superModel = "nvidia/nemotron-3-super-120b-a12b";
    tf.sent.length = 0;
    tf.replies.push('{"set":{"s2.op0.x_mm":0},"why":"a"}', '{"set":{"s2.op1.z_mm":13},"why":"b","expect":"c"}');
    const { result } = await post({ spec, program, runs, first: outcomeLine(runs), history: [] });
    expect(result).toMatchObject({ status: "done", value: { thinking: true, escalation: "noop", model: tf.superModel }, warnings: expect.arrayContaining(["the patch changed nothing: asked again with thinking on"]) });
    expect(tf.sent[1]).toMatchObject({ model: tf.superModel, max_tokens: 4096 });
    expect(tf.sent[1]).not.toHaveProperty("extra_body");
  });
});
