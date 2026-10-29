/**
 * /api/saboteur's deadline (#189): at 40 s the spec's twelve answer, the
 * request still on its way is aborted, and no other is sent after it. Token
 * Factory is faked: nothing here spends.
 */
import { describe, expect, it, vi } from "vitest";
import { DEMO_SPEC } from "@/lib/sim/demo-spec";
import type { SaboteurPlan } from "@/lib/saboteur/ask";
import type { StageResult } from "@/lib/spec/stage-result";

/** Token Factory stand-in whose create() never answers until its signal is aborted. */
const tf = vi.hoisted(() => ({ signals: [] as (AbortSignal | undefined)[] }));
vi.mock("@/lib/providers/tokenfactory", async (original) => {
  const real = await original<typeof import("@/lib/providers/tokenfactory")>();
  const { default: OpenAI } = await import("openai");
  return {
    ...real,
    wantsReplay: (req: Request) => new URL(req.url).searchParams.get("replay") === "1",
    tokenFactory: () => ({
      maxRetries: 0,
      models: { list: async () => ({ data: Object.values(real.MODELS).map((id) => ({ id })) }) },
      chat: {
        completions: {
          create: (_params: unknown, o: { signal?: AbortSignal }) => {
            tf.signals.push(o?.signal);
            return new Promise((_resolve, reject) => o?.signal?.addEventListener("abort", () => reject(new OpenAI.APIUserAbortError()), { once: true }));
          },
        },
      },
    }),
  };
});
const { POST } = await import("@/app/api/saboteur/route");

describe("/api/saboteur at its deadline", () => {
  it("answers from the spec, cuts the call in flight and sends no other", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = POST(new Request("http://test/api/saboteur", { method: "POST", body: JSON.stringify({ spec: DEMO_SPEC }) }));
      await vi.advanceTimersByTimeAsync(40_000);
      const result = (await (await pending).json()) as StageResult<SaboteurPlan>;
      expect(result).toMatchObject({ status: "done", value: { source: "spec" } });
      expect(tf.signals).toHaveLength(1);
      expect(tf.signals[0]?.aborted).toBe(true);
      // the cut call and anything it might have started: nothing more goes out
      await vi.advanceTimersByTimeAsync(10_000);
      expect(tf.signals).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
