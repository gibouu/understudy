/**
 * Nebius Token Factory through the OpenAI SDK. One place for the base URL,
 * the four NVIDIA model IDs (overridable from env so a renamed model does not
 * break the demo in December), the replay switch, and the request defaults
 * the day-one smoke tests settled (docs/FEEDBACK.md, 23 Oct 2026).
 */
import OpenAI from "openai";

export const TOKEN_FACTORY_BASE_URL = "https://api.tokenfactory.nebius.com/v1/";

export const MODELS = {
  /** watches: segments, objects, sizes, symmetry from a video proxy or keyframes (image + video input) */
  vl: process.env.UNDERSTUDY_MODEL_VL ?? "nvidia/Nemotron-3.5-Super-VL",
  /** plays the robot: spec to program, ask slots, grounding filter */
  nano: process.env.UNDERSTUDY_MODEL_NANO ?? "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  /** interviews, writes perturbation scenarios, patches programs */
  super: process.env.UNDERSTUDY_MODEL_SUPER ?? "nvidia/nemotron-3-super-120b-a12b",
  /** failure classes, reshoot list, open risks, in the background */
  ultra: process.env.UNDERSTUDY_MODEL_ULTRA ?? "nvidia/Nemotron-3-Ultra-550b-a55b",
} as const;

export type ModelRole = keyof typeof MODELS;

/** Token Factory refuses more images than this in one request (HTTP 400). */
export const MAX_IMAGES_PER_REQUEST = 8;

/**
 * The Label input. "video": one H.264 proxy (480p, 4 fps, under 2 minutes) as
 * a data URI; about 170 input tokens per second of clip and one call for the
 * whole clip. "keyframes": up to 7 JPEG keyframes plus one montage, the
 * fallback when the proxy cannot be encoded. Measured 23 Oct 2026.
 */
export const LABEL_INPUT: "video" | "keyframes" = process.env.UNDERSTUDY_LABEL_INPUT === "keyframes" ? "keyframes" : "video";
export const VIDEO_PROXY = { width: 480, fps: 4, maxSeconds: 120 } as const;
export const MAX_KEYFRAMES = MAX_IMAGES_PER_REQUEST - 1;

/**
 * Request parameters that turn hidden reasoning off. Measured 23 Oct 2026:
 * `chat_template_kwargs.enable_thinking: false` works on all three models;
 * `reasoning_effort: "none"` also works on Super and Super VL but returns
 * EMPTY content on Nano for the tested compile prompt, so it is never used.
 * With thinking on, output length varied several-fold between runs: one of
 * two Nano runs and the vision-model run hit their 1,200 and 1,500 token
 * budgets with empty content (finish "length"). Reasoning, when on, comes
 * back in `reasoning_content`, not inside the text.
 */
export function thinkingOff(): { extra_body: { chat_template_kwargs: { enable_thinking: false } } } {
  return { extra_body: { chat_template_kwargs: { enable_thinking: false } } };
}

/** Unknown request parameters are accepted silently (no 400), so a typo never fails loudly. */
export const UNKNOWN_PARAMS_ARE_IGNORED = true;

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
  reasoning_tokens?: number;
};

export function usageOf(completion: {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    completion_tokens_details?: { reasoning_tokens?: number | null } | null;
  } | null;
}): Usage {
  const u = completion.usage;
  return {
    prompt_tokens: u?.prompt_tokens ?? 0,
    completion_tokens: u?.completion_tokens ?? 0,
    cached_tokens: u?.prompt_tokens_details?.cached_tokens ?? undefined,
    reasoning_tokens: u?.completion_tokens_details?.reasoning_tokens ?? undefined,
  };
}
