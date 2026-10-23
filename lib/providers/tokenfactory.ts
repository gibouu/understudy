/**
 * Nebius Token Factory through the OpenAI SDK. One place for the base URL,
 * the four NVIDIA model IDs (overridable from env so a renamed model does not
 * break the demo in December) and the replay switch.
 */
import OpenAI from "openai";

export const TOKEN_FACTORY_BASE_URL = "https://api.tokenfactory.nebius.com/v1/";

export const MODELS = {
  /** watches: segments, objects, sizes, symmetry from keyframes (image + video input) */
  vl: process.env.UNDERSTUDY_MODEL_VL ?? "nvidia/Nemotron-3.5-Super-VL",
  /** plays the robot: spec to program, ask slots, grounding filter */
  nano: process.env.UNDERSTUDY_MODEL_NANO ?? "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  /** interviews, writes perturbation scenarios, patches programs */
  super: process.env.UNDERSTUDY_MODEL_SUPER ?? "nvidia/nemotron-3-super-120b-a12b",
  /** failure classes, reshoot list, open risks, in the background */
  ultra: process.env.UNDERSTUDY_MODEL_ULTRA ?? "nvidia/Nemotron-3-Ultra-550b-a55b",
} as const;

export type ModelRole = keyof typeof MODELS;

export function hasTokenFactoryKey(): boolean {
  return Boolean(process.env.NEBIUS_API_KEY);
}

export type ClientOptions = {
  /** per-request deadline in ms; must stay under the route's maxDuration */
  timeout?: number;
  maxRetries?: number;
};

/** Returns null when no key is configured: every route then serves recorded replays. */
export function tokenFactory(options: ClientOptions = {}): OpenAI | null {
  const apiKey = process.env.NEBIUS_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: TOKEN_FACTORY_BASE_URL,
    timeout: options.timeout ?? 60_000,
    maxRetries: options.maxRetries ?? 2,
  });
}

/** `?replay=1` on any route forces the recorded fixture even with a key present. */
export function wantsReplay(req: Request): boolean {
  return new URL(req.url).searchParams.get("replay") === "1" || !hasTokenFactoryKey();
}

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens?: number;
};

export function usageOf(completion: {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  } | null;
}): Usage {
  const u = completion.usage;
  return {
    prompt_tokens: u?.prompt_tokens ?? 0,
    completion_tokens: u?.completion_tokens ?? 0,
    cached_tokens: u?.prompt_tokens_details?.cached_tokens ?? undefined,
  };
}
