/**
 * GET /api/health (#129): the probe makes a paid 5-token call, so its answer
 * serves every request on the instance for a minute. Token Factory is faked:
 * each create() counted is one paid call.
 */
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetModels } from "@/lib/providers/tokenfactory";
import { BUDGET_ENV, SPENT_KEY } from "@/lib/unlock/budget";
import { fakeRedis } from "@/tests/store/fake-redis";

const tf = vi.hoisted(() => ({ calls: 0, refuse: false, broken: false }));
vi.mock("@/lib/providers/tokenfactory", async (original) => {
  const real = await original<typeof import("@/lib/providers/tokenfactory")>();
  return {
    ...real,
    wantsReplay: (req: Request) => new URL(req.url).searchParams.get("replay") === "1",
    tokenFactory: () => {
      if (tf.broken) throw new TypeError("bad header");
      return {
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
      };
    },
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
    tf.broken = false;
    forgetModels();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

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

  it("does not keep a probe that threw: the next request probes again", async () => {
    tf.broken = true;
    expect(await health()).toMatchObject({ mode: "replay", reason: "the health check failed" });
    tf.broken = false;
    expect((await health()).mode).toBe("live");
    expect(tf.calls).toBe(1);
  });

  it("answers ?replay=1 without a call", async () => {
    expect(await health("?replay=1")).toMatchObject({ mode: "replay" });
    expect(tf.calls).toBe(0);
  });

  it("says what the live budget has left, and replays without a probe once it is spent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = fakeRedis();
    vi.stubEnv(BUDGET_ENV, "10");
    store.data.set(SPENT_KEY, 2_500_000);
    expect(await health()).toMatchObject({ mode: "live", budget: { cap_usd: 10, spent_usd: 2.5, left_usd: 7.5 } });
    expect(tf.calls).toBe(1);
    store.data.set(SPENT_KEY, 10_000_000);
    vi.setSystemTime(now + 61_000);
    const spent = await health();
    expect(spent).toMatchObject({ mode: "replay", budget: { left_usd: 0 } });
    expect(spent.reason).toContain("the live budget for judging is spent");
    expect(tf.calls).toBe(1);
  });

  it("replays on a deployment whose budget cannot be read", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    expect(await health()).toMatchObject({ mode: "replay" });
    expect(tf.calls).toBe(0);
  });
});
