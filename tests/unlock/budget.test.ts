/**
 * The live budget for judging (lib/unlock/budget.ts): one running total of
 * what live Token Factory calls cost, counted in the store, that shuts every
 * live call once it reaches UNDERSTUDY_BUDGET_USD, and shuts them too when
 * the store cannot be read on a deployment. The store is faked
 * (tests/store/fake-redis.ts) and so is Token Factory: nothing here spends.
 */
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { callModel } from "@/lib/providers/call";
import { MODELS } from "@/lib/providers/tokenfactory";
import { usdOf } from "@/lib/providers/price";
import { BUDGET_ENV, budgetCap, costOf, promptTokensAtMost, readBudget, reserve, settle, SPENT_KEY, underCeiling, VIDEO_TOKENS, type Ceiling } from "@/lib/unlock/budget";
import { forgetLiveCalls } from "@/lib/unlock/cap";
import { liveGate, UNLOCK_ENV } from "@/lib/unlock/check";
import { gateNote, LIVE_NO_BUDGET, LIVE_SPENT } from "@/lib/unlock/messages";
import { fakeRedis } from "@/tests/store/fake-redis";

const CODE = "open sesame";

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("NEBIUS_API_KEY", "");
  vi.stubEnv("KV_REST_API_URL", "");
  vi.stubEnv("KV_REST_API_TOKEN", "");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv(UNLOCK_ENV, CODE);
  vi.stubEnv(BUDGET_ENV, "");
  forgetLiveCalls();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const call = (model: string, prompt_tokens: number, completion_tokens: number) => ({ model, prompt_tokens, completion_tokens, seconds: 1 });

describe("the cap", () => {
  it("is US$250 unless UNDERSTUDY_BUDGET_USD says otherwise", () => {
    expect(budgetCap()).toBe(250);
    vi.stubEnv(BUDGET_ENV, "40");
    expect(budgetCap()).toBe(40);
    vi.stubEnv(BUDGET_ENV, "not a number");
    expect(budgetCap()).toBe(250);
  });
});

describe("without a store", () => {
  it("leaves local runs open and charges nothing", async () => {
    expect(await readBudget()).toEqual({ state: "open" });
    await settle(await reserve(MODELS.nano, 1000, 100), call(MODELS.nano, 1000, 100));
    expect((await liveGate("compile", { unlock: CODE })).live).toBe(true);
  });

  it("shuts a deployment's live calls, which replay and say why", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect((await readBudget()).state).toBe("unknown");
    expect(await liveGate("compile", { unlock: CODE })).toEqual({ live: false, why: LIVE_NO_BUDGET });
    // a clip of your own is replayed too, not asked for a code that cannot help
    expect(await liveGate("label", { clip_sha256: "a".repeat(64) })).toEqual({ live: false, why: LIVE_NO_BUDGET });
  });
});

describe("with a store", () => {
  it("adds each call at list price, in micro-dollars rounded up", async () => {
    const store = fakeRedis();
    const e = call(MODELS.vl, 12_345, 678);
    await settle({ ok: true, micro: 0 }, e);
    await settle({ ok: true, micro: 0 }, e);
    const micro = Math.ceil(usdOf(e)! * 1e6);
    expect(store.data.get(SPENT_KEY)).toBe(2 * micro);
    expect(await readBudget()).toMatchObject({ state: "left", cap_usd: 250, spent_usd: Math.round((2 * micro) / 1e4) / 100 });
  });

  it("charges a model the catalogue does not price at the dearest price, never as free", () => {
    const e = call("someone/unpriced-model", 1000, 1000);
    expect(usdOf(e)).toBeUndefined();
    expect(costOf(e)).toBeGreaterThanOrEqual(usdOf(call(MODELS.ultra, 1000, 1000))!);
  });

  it("goes live while money is left, and replays every route once it is spent", async () => {
    const store = fakeRedis();
    vi.stubEnv(BUDGET_ENV, "1");
    expect((await liveGate("notes", { unlock: CODE })).live).toBe(true);
    store.data.set(SPENT_KEY, 1_000_000);
    for (const route of ["compile", "notes", "variants", "ground"] as const) expect(await liveGate(route, { unlock: CODE })).toEqual({ live: false, why: LIVE_SPENT });
    expect(await liveGate("label", { clip_sha256: "a".repeat(64), unlock: CODE })).toEqual({ live: false, why: LIVE_SPENT });
    expect(await readBudget()).toMatchObject({ state: "spent", left_usd: 0 });
    expect(gateNote(["x", LIVE_SPENT])).toBe(LIVE_SPENT);
    expect(LIVE_SPENT).toContain("the live budget for judging is spent");
  });

  it("replays when the store cannot be read", async () => {
    const store = fakeRedis();
    store.down = true;
    expect(await liveGate("compile", { unlock: CODE })).toEqual({ live: false, why: LIVE_NO_BUDGET });
  });

  it("reserves the most a call can cost, gives back what it did not spend, and refuses what would pass the cap", async () => {
    const store = fakeRedis();
    vi.stubEnv(BUDGET_ENV, "1");
    const most = Math.ceil(usdOf(call(MODELS.ultra, 10_000, 4_000))! * 1e6);
    const hold = await reserve(MODELS.ultra, 10_000, 4_000);
    expect(hold).toEqual({ ok: true, micro: most });
    expect(store.data.get(SPENT_KEY)).toBe(most);
    await settle(hold, call(MODELS.ultra, 5_000, 100));
    expect(store.data.get(SPENT_KEY)).toBe(Math.ceil(usdOf(call(MODELS.ultra, 5_000, 100))! * 1e6));
    store.data.set(SPENT_KEY, 1_000_000 - most + 1);
    expect(await reserve(MODELS.ultra, 10_000, 4_000)).toEqual({ ok: false, why: "spent" });
    expect(store.data.get(SPENT_KEY)).toBe(1_000_000 - most + 1);
  });

  it("lets no more calls go than the budget pays for, however many run at once", async () => {
    const store = fakeRedis();
    vi.stubEnv(BUDGET_ENV, "1");
    const most = Math.ceil(usdOf(call(MODELS.ultra, 10_000, 4_000))! * 1e6);
    const holds = await Promise.all(Array.from({ length: 50 }, () => reserve(MODELS.ultra, 10_000, 4_000)));
    expect(holds.filter((h) => h.ok)).toHaveLength(Math.floor(1_000_000 / most));
    expect(Number(store.data.get(SPENT_KEY))).toBeLessThanOrEqual(1_000_000);
  });

  it("makes no call it cannot count: a store that is down refuses the reservation", async () => {
    const store = fakeRedis();
    store.down = true;
    expect(await reserve(MODELS.nano, 100, 100)).toEqual({ ok: false, why: "unknown" });
    // a settlement the store refuses leaves the reservation counted, never less
    store.down = false;
    const hold = await reserve(MODELS.nano, 100, 100);
    const held = store.data.get(SPENT_KEY);
    store.down = true;
    await settle(hold, call(MODELS.nano, 10, 10));
    expect(store.data.get(SPENT_KEY)).toBe(held);
  });

  it("counts a video part as VIDEO_TOKENS, not its base64", () => {
    expect(promptTokensAtMost([{ role: "user", content: [{ type: "text", text: "abcdef" }, { type: "video_url", video_url: { url: "data:video/mp4;base64," + "A".repeat(3_000_000) } }] }])).toBe(1000 + VIDEO_TOKENS + 4 + 4 + 6);
  });

  it("is charged by every billed call a route makes, an unusable answer included", async () => {
    const store = fakeRedis();
    const replies = ["not json", '{"n":1}'];
    const client = {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: replies.shift() } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }) } },
    } as unknown as OpenAI;
    const r = await callModel(client, { role: "nano", user: "u", maxTokens: 100, schema: z.object({ n: z.number() }) });
    expect(r.status).toBe("done");
    const one = Math.ceil(usdOf(call(MODELS.nano, 1000, 200))! * 1e6);
    expect(store.data.get(SPENT_KEY)).toBe(2 * one);
  });

  it("reserves for every attempt the SDK may send, and keeps the reservation of a request that timed out", async () => {
    const store = fakeRedis();
    const client = {
      maxRetries: 2,
      chat: { completions: { create: async () => Promise.reject(new Error("socket hang up")) } },
    } as unknown as OpenAI;
    const r = await callModel(client, { role: "nano", user: "u", maxTokens: 100, schema: z.object({ n: z.number() }) });
    expect(r.status).toBe("failed");
    const one = Math.ceil(usdOf(call(MODELS.nano, promptTokensAtMost([{ role: "user", content: "u" }]), 100))! * 1e6);
    expect(store.data.get(SPENT_KEY)).toBe(3 * one);
  });

  it("counts an attempt whose answer was lost, and the retry that answered, each on its own", async () => {
    const store = fakeRedis();
    let sent = 0;
    const client = {
      maxRetries: 1,
      chat: {
        completions: {
          create: async () => {
            if (sent++ === 0) throw new Error("socket hang up");
            return { choices: [{ message: { content: '{"n":1}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
          },
        },
      },
    } as unknown as OpenAI;
    const r = await callModel(client, { role: "nano", user: "u", maxTokens: 100, schema: z.object({ n: z.number() }) });
    expect(r.status).toBe("done");
    const held = Math.ceil(usdOf(call(MODELS.nano, promptTokensAtMost([{ role: "user", content: "u" }]), 100))! * 1e6);
    expect(store.data.get(SPENT_KEY)).toBe(held + Math.ceil(usdOf(call(MODELS.nano, 10, 5))! * 1e6));
  });

  it("keeps the reservation of a request cut at the deadline, and reserves nothing after it (#189)", async () => {
    const store = fakeRedis();
    const deadline = new AbortController();
    let sent = 0;
    const client = {
      maxRetries: 2,
      chat: {
        completions: {
          create: (_p: unknown, o: { signal?: AbortSignal }) => {
            sent++;
            return new Promise((_resolve, reject) => o.signal?.addEventListener("abort", () => reject(new OpenAI.APIUserAbortError()), { once: true }));
          },
        },
      },
    } as unknown as OpenAI;
    const answer = callModel(client, { role: "nano", user: "u", maxTokens: 100, schema: z.object({ n: z.number() }), signal: deadline.signal });
    await vi.waitFor(() => expect(sent).toBe(1));
    deadline.abort();
    expect((await answer).status).toBe("failed");
    expect(sent).toBe(1);
    expect(store.data.get(SPENT_KEY)).toBe(Math.ceil(usdOf(call(MODELS.nano, promptTokensAtMost([{ role: "user", content: "u" }]), 100))! * 1e6));
  });

  it("keeps the reservation of a 400 the SDK made of a response cut at the deadline (#189)", async () => {
    const store = fakeRedis();
    const deadline = new AbortController();
    let sent = 0;
    const client = {
      chat: {
        completions: {
          create: async () => {
            sent++;
            // the error body was cut short: the SDK still reports the status line it read
            deadline.abort();
            throw new OpenAI.BadRequestError(400, undefined, "400 status code (no body)", new Headers());
          },
        },
      },
    } as unknown as OpenAI;
    expect((await callModel(client, { role: "nano", user: "u", maxTokens: 100, schema: z.object({ n: z.number() }), signal: deadline.signal })).status).toBe("failed");
    expect(sent).toBe(1);
    expect(store.data.get(SPENT_KEY)).toBe(Math.ceil(usdOf(call(MODELS.nano, promptTokensAtMost([{ role: "user", content: "u" }]), 100))! * 1e6));
  });

  it("gives back the reservation of a request cut before it was sent, and pauses for no retry once cut (#189)", async () => {
    const store = fakeRedis();
    const deadline = new AbortController();
    let sent = 0;
    const client = { chat: { completions: { create: async () => (sent++, { choices: [{ message: { content: '{"n":1}' } }] }) } } } as unknown as OpenAI;
    const incr = store.data.set.bind(store.data);
    // the deadline passes while the reservation is being made
    store.data.set = (k, v) => (deadline.abort(), incr(k, v));
    expect((await callModel(client, { role: "nano", user: "u", maxTokens: 100, schema: z.object({ n: z.number() }), signal: deadline.signal })).status).toBe("failed");
    expect(sent).toBe(0);
    expect(store.data.get(SPENT_KEY) ?? 0).toBe(0);
  });

  it("keeps the whole reservation of an answer that does not say what it used", async () => {
    const store = fakeRedis();
    const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{"n":1}' } }] }) } } } as unknown as OpenAI;
    expect((await callModel(client, { role: "nano", user: "u", maxTokens: 100, schema: z.object({ n: z.number() }) })).status).toBe("done");
    expect(store.data.get(SPENT_KEY)).toBe(Math.ceil(usdOf(call(MODELS.nano, promptTokensAtMost([{ role: "user", content: "u" }]), 100))! * 1e6));
  });

  it("counts the budget spent once less than the margin is left, so a request replays rather than fails halfway", async () => {
    const store = fakeRedis();
    vi.stubEnv(BUDGET_ENV, "10");
    store.data.set(SPENT_KEY, 9_600_000);
    expect(await liveGate("compile", { unlock: CODE })).toEqual({ live: false, why: LIVE_SPENT });
  });

  it("keeps the previous value when a recompile has no room left", async () => {
    const store = fakeRedis();
    vi.stubEnv(BUDGET_ENV, "1");
    store.data.set(SPENT_KEY, 1_000_000);
    const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{"n":1}' } }] }) } } } as unknown as OpenAI;
    const r = await callModel(client, { role: "nano", user: "u", maxTokens: 100, schema: z.object({ n: z.number() }), previous: { n: 7 } });
    expect(r).toMatchObject({ status: "done", value: { n: 7 } });
  });

  it("does not make a call the budget has no room for, and says why", async () => {
    const store = fakeRedis();
    vi.stubEnv(BUDGET_ENV, "1");
    store.data.set(SPENT_KEY, 1_000_000);
    let made = 0;
    const client = { chat: { completions: { create: async () => (made++, { choices: [{ message: { content: '{"n":1}' } }] }) } } } as unknown as OpenAI;
    const r = await callModel(client, { role: "nano", user: "u", maxTokens: 100, schema: z.object({ n: z.number() }) });
    expect(made).toBe(0);
    expect(r).toMatchObject({ status: "failed", retryable: false });
    expect(r.status === "failed" && r.message).toContain(LIVE_SPENT);
  });
});

describe("a ceiling of the process's own (the showcase recorder, #118)", () => {
  const micro = (model: string, prompt: number, completion: number) => Math.ceil(usdOf(call(model, prompt, completion))! * 1e6);
  /** answers from the list in turn (an Error is thrown) and keeps the messages of every request */
  function client(replies: (string | Error)[], maxRetries = 0) {
    const sent: unknown[] = [];
    const c = {
      maxRetries,
      chat: {
        completions: {
          create: async (p: { messages: unknown }) => {
            sent.push(structuredClone(p.messages));
            const r = replies.shift();
            if (r instanceof Error) throw r;
            return { choices: [{ message: { content: r } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
          },
        },
      },
    } as unknown as OpenAI;
    return { c, sent };
  }
  const opts = { role: "nano" as const, user: "u", maxTokens: 100, schema: z.object({ n: z.number() }) };
  const badRequest = () => new OpenAI.BadRequestError(400, { message: "unknown field" }, "400 unknown field", new Headers());

  it("counts every request, the resend after a 400 and a re-ask's longer prompt included, and settles each to its cost, with no store", async () => {
    const ceiling: Ceiling = { cap_usd: 1, held_micro: 0 };
    const { c, sent } = client([badRequest(), "not json", '{"n":1}']);
    expect((await underCeiling(ceiling, () => callModel(c, opts))).status).toBe("done");
    expect(sent).toHaveLength(3);
    // the 400 was refused unbilled; the two answers settled to what they used
    expect(ceiling.held_micro).toBe(2 * micro(MODELS.nano, 10, 5));
    expect(ceiling.refused).toBeUndefined();
  });

  it("refuses the request it has no room for, before it is sent, from that request's own prompt", async () => {
    const first = micro(MODELS.nano, promptTokensAtMost([{ role: "user", content: "u" }]), 100);
    // room for the first request, not for the re-ask, whose prompt carries the first answer back
    const ceiling: Ceiling = { cap_usd: (micro(MODELS.nano, 10, 5) + first + 1) / 1e6, held_micro: 0 };
    const { c, sent } = client(["not json", '{"n":1}']);
    const r = await underCeiling(ceiling, () => callModel(c, opts));
    expect(r.status).toBe("failed");
    expect(sent).toHaveLength(1);
    expect(ceiling.refused).toMatch(/the next .* request could cost up to US\$.* over the US\$.* cap/);
    expect(ceiling.held_micro).toBe(micro(MODELS.nano, 10, 5));
  });

  it("keeps the hold of a request that may have been billed, and gives back what the shared total refused", async () => {
    const ceiling: Ceiling = { cap_usd: 1, held_micro: 0 };
    const { c } = client([new Error("socket hang up")]);
    await underCeiling(ceiling, () => callModel(c, opts));
    expect(ceiling.held_micro).toBe(micro(MODELS.nano, promptTokensAtMost([{ role: "user", content: "u" }]), 100));

    fakeRedis();
    vi.stubEnv(BUDGET_ENV, "0");
    const shared: Ceiling = { cap_usd: 1, held_micro: 0 };
    const hold = await underCeiling(shared, () => reserve(MODELS.nano, 100, 100));
    expect(hold).toEqual({ ok: false, why: "spent" });
    expect(shared.held_micro).toBe(0);
  });

  it("is one at a time, and gone once its work ends", async () => {
    const ceiling: Ceiling = { cap_usd: 1, held_micro: 0 };
    await expect(underCeiling(ceiling, () => underCeiling({ cap_usd: 1, held_micro: 0 }, async () => 1))).rejects.toThrow(/already set/);
    await reserve(MODELS.nano, 100, 100);
    expect(ceiling.held_micro).toBe(0);
  });
});
