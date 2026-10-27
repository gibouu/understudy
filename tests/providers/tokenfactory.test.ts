import type OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import models from "@/tests/fixtures/models.json";
import { forgetModels, LABEL_INPUT, liveModels, MAX_IMAGES_PER_REQUEST, MAX_KEYFRAMES, MODELS, notServed, RETIRED, served, thinkingOff, usageOf, VIDEO_PROXY } from "@/lib/providers/tokenfactory";

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

describe("models Token Factory retires on 9 Nov 2026 (#137)", () => {
  const NANO = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";
  const SUPER = "nvidia/nemotron-3-super-120b-a12b";
  const all = new Set(Object.values(MODELS));
  const without = (...ids: string[]) => new Set([...all].filter((id) => !ids.includes(id)));

  afterEach(() => {
    forgetModels();
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("replaces only with a Nemotron model whose price the catalog fixture lists", () => {
    const ids = new Set(models.models.map((m) => m.id));
    for (const by of Object.values(RETIRED)) {
      expect(by).toMatch(/^nvidia\/.*nemotron/i);
      expect(ids.has(by)).toBe(true);
    }
  });

  it("calls the replacements by default, and for a retired ID set in env", async () => {
    expect(MODELS).toMatchObject({ nano: RETIRED[NANO], super: RETIRED[SUPER], vl: "nvidia/Nemotron-3.5-Super-VL", ultra: "nvidia/Nemotron-3-Ultra-550b-a55b" });
    vi.stubEnv("UNDERSTUDY_MODEL_NANO", NANO);
    vi.stubEnv("UNDERSTUDY_MODEL_SUPER", "nvidia/some-other-model");
    vi.resetModules();
    const tf = await import("@/lib/providers/tokenfactory");
    expect(tf.MODELS).toMatchObject({ nano: RETIRED[NANO], super: "nvidia/some-other-model" });
  });

  it("keeps the retired models with UNDERSTUDY_KEEP_RETIRED=1, to record or rerun a bench on them", async () => {
    vi.stubEnv("UNDERSTUDY_KEEP_RETIRED", "1");
    vi.resetModules();
    const tf = await import("@/lib/providers/tokenfactory");
    expect(tf.MODELS).toMatchObject({ nano: NANO, super: SUPER });
  });

  it("is ok while every role the routes call is listed, Ultra included", () => {
    expect(served(all)).toEqual({ ok: true, listed: true, models: { vl: true, nano: true, super: true, ultra: true } });
    expect(served(without(MODELS.ultra))).toMatchObject({ ok: false, why: `missing ultra=${MODELS.ultra}`, models: { ultra: false } });
  });

  it("is not ok when a role the routes call is missing, and says which", () => {
    expect(served(without(MODELS.nano))).toMatchObject({ ok: false, listed: true, why: `missing nano=${MODELS.nano}`, models: { nano: false } });
  });

  const fake = (ids: string[]) => {
    const list = vi.fn(async () => ({ data: ids.map((id) => ({ id })) }));
    return { client: { models: { list } } as unknown as OpenAI, list };
  };

  it("reads the list once per five minutes, and again after a 404, which counts the model as gone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, list } = fake([...all]);
    const t = Date.now();
    expect((await liveModels(client, t)).ok).toBe(true);
    await liveModels(client, t + 4 * 60_000);
    expect(list).toHaveBeenCalledTimes(1);
    notServed(MODELS.nano);
    expect(await liveModels(client, t + 4 * 60_000)).toMatchObject({ ok: false, models: { nano: false } });
    expect(list).toHaveBeenCalledTimes(2);
    await liveModels(client, t + 10 * 60_000);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it.each([{ data: [null] }, { data: {} }, null])("counts a list of the wrong shape (%j) as not read, never a rejection", async (page) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = { models: { list: async () => page } } as unknown as OpenAI;
    expect(await liveModels(client)).toMatchObject({ ok: false, listed: false });
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
