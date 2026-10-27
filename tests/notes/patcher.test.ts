/**
 * The page names the model that really answered (#138, after #139): a patch says its own model,
 * "thinking on" only when that model thought, and a stuck loop handed to Ultra says so; the
 * deployment's models come from /api/models.
 */
import { describe, expect, it } from "vitest";
import { patcher } from "@/app/patch-loop";
import { answeredBy } from "@/app/models";
import { GET } from "@/app/api/models/route";
import type { NotePatch } from "@/lib/notes/patch";
import { stuckRole } from "@/lib/notes/patch";
import { MODELS } from "@/lib/providers/tokenfactory";

const SUPER = "nvidia/nemotron-3-super-120b-a12b";
const SUPER_VL = "nvidia/Nemotron-3.5-Super-VL";
const ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b";
const patch = (p: Partial<NotePatch>) => ({ model: SUPER, thinking: false, escalation: null, ...p }) as NotePatch;
const ids = (sup: string, stuck: string) => ({ vl: SUPER_VL, nano: "nvidia/Nemotron-3_5-Lightning", super: sup, ultra: ULTRA, stuck });

describe("who wrote a patch", () => {
  it("a recording, or Super live, says thinking on or off", () => {
    expect(patcher(patch({}), ids(SUPER_VL, ULTRA))).toBe("Nemotron 3 Super, thinking off");
    expect(patcher(patch({ thinking: true, escalation: "two_failed" }), ids(SUPER_VL, ULTRA))).toBe("Nemotron 3 Super, thinking on: two patches failed");
    expect(patcher(patch({ thinking: true, escalation: "noop" }), ids(SUPER, SUPER))).toBe("Nemotron 3 Super, thinking on: the cheap patch changed nothing");
  });

  it("a stuck loop handed to Ultra names Ultra and why, not thinking", () => {
    expect(patcher(patch({ model: ULTRA, thinking: true, escalation: "two_failed" }), ids(SUPER_VL, ULTRA))).toBe("Nemotron 3 Ultra: two patches failed");
    expect(patcher(patch({ model: SUPER_VL }), ids(SUPER_VL, ULTRA))).toBe("Nemotron 3.5 Super VL, thinking off");
  });

  it("before /api/models answers, a thinking patch reads as thinking", () => {
    expect(patcher(patch({ thinking: true }), null)).toBe("Nemotron 3 Super, thinking on");
  });
});

describe("the models that answered", () => {
  it("come from the ledger, Tavily left out", () => {
    const e = (model: string) => ({ model, prompt_tokens: 1, completion_tokens: 1, seconds: 1 });
    expect(answeredBy([e("tavily/search"), e("nvidia/Nemotron-3_5-Lightning"), e("nvidia/Nemotron-3_5-Lightning")])).toBe("Nemotron 3.5 Lightning");
    expect(answeredBy([])).toBeUndefined();
  });

  it("/api/models says each role's model and who answers a stuck loop", async () => {
    const body = await GET().json();
    expect(body).toEqual({ vl: MODELS.vl, nano: MODELS.nano, super: MODELS.super, ultra: MODELS.ultra, stuck: MODELS[stuckRole(MODELS.super)] });
    expect(stuckRole(SUPER_VL)).toBe("ultra");
    expect(stuckRole(SUPER)).toBe("super");
  });
});
