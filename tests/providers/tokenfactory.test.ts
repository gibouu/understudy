import type OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import models from "@/tests/fixtures/models.json";
import { current, forgetModels, LABEL_INPUT, liveModels, MAX_IMAGES_PER_REQUEST, MAX_KEYFRAMES, MODELS, notServed, RETIRED, served, thinkingOff, usageOf, VIDEO_PROXY } from "@/lib/providers/tokenfactory";

describe("token factory defaults", () => {
  it("names the four Nemotron models that the catalog fixture lists", () => {
    const ids = new Set(models.models.map((m) => m.id));
    for (const id of Object.values(MODELS)) expect(ids.has(id)).toBe(true);
  });
  it("keeps the label input inside the image cap", () => {
    expect(MAX_IMAGES_PER_REQUEST).toBe(8);
    expect(MAX_KEYFRAMES + 1).toBeLessThanOrEqual(MAX_IMAGES_PER_REQUEST);
    expect(LABEL_INPUT).toBe("video");
    expect(VIDEO_PROXY.maxSeconds).toBeLessThanOrEqual(120);
  });
  it("turns thinking off with the chat template flag, never reasoning_effort", () => {
    const p = thinkingOff() as Record<string, unknown>;
    expect(p.extra_body).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect("reasoning_effort" in p).toBe(false);
  });
  it("reads reasoning tokens out of usage", () => {
    expect(usageOf({ usage: { prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 15 } } })).toEqual({ prompt_tokens: 10, completion_tokens: 20, cached_tokens: undefined, reasoning_tokens: 15 });
  });
});

describe("models Token Factory retires (#137)", () => {
  const all = new Set(Object.values(MODELS));
  const without = (...ids: string[]) => new Set([...all].filter((id) => !ids.includes(id)));
  const LIGHTNING = RETIRED[MODELS.nano]!.by;

  afterEach(() => {
    forgetModels();
    vi.restoreAllMocks();
  });

  it("replaces only with a Nemotron model whose price the catalog fixture lists", () => {
    const ids = new Set(models.models.map((m) => m.id));
    for (const { by, on } of Object.values(RETIRED)) {
      expect(by).toMatch(/^nvidia\/.*nemotron/i);
      expect(ids.has(by)).toBe(true);
      expect(on).toBe("2026-11-09");
    }
  });

  it("keeps every role on its own model while it is listed, a replacement listed or not", () => {
    expect(served(new Set([...all, LIGHTNING]))).toEqual({ ok: true, listed: true, models: MODELS, replaced: [] });
  });

  it("moves a retired role to the replacement Token Factory names", () => {
    const s = served(new Set([...without(MODELS.nano, MODELS.super), LIGHTNING]));
    expect(s.ok).toBe(true);
    expect(s.models).toMatchObject({ nano: LIGHTNING, super: MODELS.vl, vl: MODELS.vl });
    expect(s.replaced).toEqual(["Nemotron 3 Nano → Nemotron 3.5 Lightning", "Nemotron 3 Super → Nemotron 3.5 Super VL"]);
  });

  it("is not ok when a role the routes call has neither its model nor a replacement, and says which", () => {
    const s = served(without(MODELS.nano));
    expect(s).toMatchObject({ ok: false, listed: true, why: `missing nano=${MODELS.nano}` });
    expect(s.models.nano).toBeNull();
  });

  it("does not need Ultra", () => {
    expect(served(without(MODELS.ultra))).toMatchObject({ ok: true, models: { ultra: null } });
  });

  const fake = (lists: () => string[]) => {
    const list = vi.fn(async () => ({ data: lists().map((id) => ({ id })) }));
    return { client: { models: { list } } as unknown as OpenAI, list };
  };

  it("calls each ID as itself until a list read says it is gone", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect(current(MODELS.nano)).toBe(MODELS.nano);
    await liveModels(fake(() => [...without(MODELS.nano), LIGHTNING]).client);
    expect(current(MODELS.nano)).toBe(LIGHTNING);
    expect(current(MODELS.vl)).toBe(MODELS.vl);
    expect(current("nvidia/not-a-model")).toBe("nvidia/not-a-model");
  });

  it("reads the list once per five minutes, and again after a 404", async () => {
    const { client, list } = fake(() => [...all, LIGHTNING]);
    const t = Date.now();
    await liveModels(client, t);
    await liveModels(client, t + 4 * 60_000);
    expect(list).toHaveBeenCalledTimes(1);
    vi.spyOn(console, "info").mockImplementation(() => {});
    notServed(MODELS.nano);
    expect((await liveModels(client, t + 4 * 60_000)).models.nano).toBe(LIGHTNING);
    expect(list).toHaveBeenCalledTimes(2);
    await liveModels(client, t + 10 * 60_000);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("counts a list that cannot be read as not ok, and tries again after 30 s", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = vi.fn(async () => {
      throw new Error("connect ETIMEDOUT");
    });
    const client = { models: { list } } as unknown as OpenAI;
    const t = Date.now();
    expect(await liveModels(client, t)).toMatchObject({ ok: false, listed: false });
    await liveModels(client, t + 20_000);
    expect(list).toHaveBeenCalledTimes(1);
    await liveModels(client, t + 31_000);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
