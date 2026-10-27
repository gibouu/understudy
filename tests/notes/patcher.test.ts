/**
 * The page names the model that really answered (#138, after #139): a patch says its own model,
 * "thinking on" only when that model thought, and a stuck loop handed to Ultra says so; the
 * deployment's models come from /api/models.
 */
import { describe, expect, it, vi } from "vitest";

// a route handler's connection() needs Next's request scope, which a unit test has not got
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => {} }));
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

describe("who wrote a patch", () => {
  it("a recording, or Super live, says thinking on or off", () => {
    expect(patcher(patch({}))).toBe("Nemotron 3 Super, thinking off");
    // recordings and fixtures made before `thought`: thinking meant the model reasoned
    expect(patcher(patch({ thinking: true, escalation: "two_failed" }))).toBe("Nemotron 3 Super, thinking on: two patches failed");
    expect(patcher(patch({ thinking: true, thought: true, escalation: "noop" }))).toBe("Nemotron 3 Super, thinking on: the cheap patch changed nothing");
  });

  it("a stuck loop handed to a model that did not think names it and why", () => {
    expect(patcher(patch({ model: ULTRA, thinking: true, thought: false, escalation: "two_failed" }))).toBe("Nemotron 3 Ultra: two patches failed");
    // Ultra set to the patcher's own model: still not thinking, as the route sent it
    expect(patcher(patch({ model: SUPER_VL, thinking: true, thought: false, escalation: "noop" }))).toBe("Nemotron 3.5 Super VL: the cheap patch changed nothing");
    expect(patcher(patch({ model: SUPER_VL, thought: false }))).toBe("Nemotron 3.5 Super VL, thinking off");
  });
});

describe("the models that answered", () => {
  it("come from the ledger, Tavily left out", () => {
    const e = (model: string) => ({ model, prompt_tokens: 1, completion_tokens: 1, seconds: 1 });
    expect(answeredBy([e("tavily/search"), e("nvidia/Nemotron-3_5-Lightning"), e("nvidia/Nemotron-3_5-Lightning")])).toBe("Nemotron 3.5 Lightning");
    expect(answeredBy([])).toBeUndefined();
  });

  it("/api/models says each role's model and who answers a stuck loop", async () => {
    const body = await (await GET()).json();
    expect(body).toEqual({ vl: MODELS.vl, nano: MODELS.nano, super: MODELS.super, ultra: MODELS.ultra, stuck: MODELS[stuckRole(MODELS.super)] });
    expect(stuckRole(SUPER_VL)).toBe("ultra");
    expect(stuckRole(SUPER)).toBe("super");
  });
});
