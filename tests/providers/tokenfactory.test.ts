import { describe, expect, it } from "vitest";
import models from "@/tests/fixtures/models.json";
import { LABEL_INPUT, MAX_IMAGES_PER_REQUEST, MAX_KEYFRAMES, MODELS, thinkingOff, usageOf, VIDEO_PROXY } from "@/lib/providers/tokenfactory";

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
