/**
 * GET /api/health (#129): the probe makes a paid 5-token call, so its answer
 * serves every request on the instance for a minute. Token Factory is faked:
 * each create() counted is one paid call.
 */
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetModels } from "@/lib/providers/tokenfactory";

const tf = vi.hoisted(() => ({ calls: 0, refuse: false }));
vi.mock("@/lib/providers/tokenfactory", async (original) => {
  const real = await original<typeof import("@/lib/providers/tokenfactory")>();
  return {
    ...real,
    wantsReplay: (req: Request) => new URL(req.url).searchParams.get("replay") === "1",
    tokenFactory: () => ({
      models: { list: async () => ({ data: Object.values(real.MODELS).map((id) => ({ id })) }) },
      chat: {
        completions: {
          create: async (params: { model: string }) => {
            tf.calls++;
            if (tf.refuse) throw OpenAI.APIError.generate(503, { message: "overloaded" }, undefined, new Headers());
            return { choices: [{ message: { content: "ok" } }], model: params.model };
          },
        },
      },
    }),
  };
});
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => {} }));

const { GET } = await import("@/app/api/health/route");
const health = async (q = "") => (await GET(new Request(`http://localhost/api/health${q}`))).json();

describe("GET /api/health", () => {
  let now = Date.parse("2026-10-28T09:00:00Z");
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // past the previous test's minute, so each test starts with no probe kept
    now += 10 * 60_000;
    vi.setSystemTime(now);
    tf.calls = 0;
    tf.refuse = false;
    forgetModels();
  });
  afterEach(() => vi.useRealTimers());

  it("makes one paid call for a burst of requests", async () => {
    const answers = await Promise.all(Array.from({ length: 20 }, () => health()));
    expect(answers.every((a) => a.mode === "live")).toBe(true);
    expect(tf.calls).toBe(1);
    vi.setSystemTime(now + 59_000);
    expect((await health()).mode).toBe("live");
    expect(tf.calls).toBe(1);
  });

  it("probes again after a minute, and flips to replay when the call fails", async () => {
    expect((await health()).mode).toBe("live");
    tf.refuse = true;
    vi.setSystemTime(now + 61_000);
    expect(await health()).toMatchObject({ mode: "replay" });
    expect(tf.calls).toBe(2);
  });

  it("answers ?replay=1 without a call", async () => {
    expect(await health("?replay=1")).toMatchObject({ mode: "replay" });
    expect(tf.calls).toBe(0);
  });
});
