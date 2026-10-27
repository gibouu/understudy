/**
 * Nebius Token Factory through the OpenAI SDK. One place for the base URL,
 * the four NVIDIA model IDs (overridable from env so a renamed model does not
 * break the demo in December), the replacements for the ones Token Factory
 * retires, the replay switch, and the request defaults
 * the day-one smoke tests settled (docs/FEEDBACK.md, 23 Oct 2026).
 */
import OpenAI from "openai";

export const TOKEN_FACTORY_BASE_URL = "https://api.tokenfactory.nebius.com/v1/";

/**
 * Models Token Factory removes from Serverless on 9 November 2026, each with
 * the replacement its notice names (docs.tokenfactory.nebius.com/model-deprecations-november-2026,
 * read 27 Oct 2026). Token Factory does not reroute a retired ID: it answers
 * 404. Judges try the demo until mid-December, so live calls use the
 * replacement from now on, whether the retired ID comes from env or from the
 * defaults below; the recorded sessions keep the models they were recorded
 * on. UNDERSTUDY_KEEP_RETIRED=1 calls the retired models while Token Factory
 * still serves them, to record or rerun a bench on them. Both are measured in
 * docs/MEASUREMENTS.md section 12.
 */
export const RETIRED: Readonly<Record<string, string>> = {
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": "nvidia/Nemotron-3_5-Lightning",
  "nvidia/nemotron-3-super-120b-a12b": "nvidia/Nemotron-3.5-Super-VL",
};

const live = (id: string) => (process.env.UNDERSTUDY_KEEP_RETIRED === "1" ? id : (RETIRED[id] ?? id));

export const MODELS = {
  /** watches: segments, objects, sizes, symmetry from a video proxy or keyframes (image + video input) */
  vl: live(process.env.UNDERSTUDY_MODEL_VL ?? "nvidia/Nemotron-3.5-Super-VL"),
  /** plays the robot: spec to program, ask slots, grounding filter (Nemotron 3.5 Lightning in place of Nemotron 3 Nano) */
  nano: live(process.env.UNDERSTUDY_MODEL_NANO ?? "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"),
  /** interviews, writes perturbation scenarios, patches programs (Nemotron 3.5 Super VL in place of Nemotron 3 Super) */
  super: live(process.env.UNDERSTUDY_MODEL_SUPER ?? "nvidia/nemotron-3-super-120b-a12b"),
  /** failure classes, reshoot list, open risks, in the background */
  ultra: live(process.env.UNDERSTUDY_MODEL_ULTRA ?? "nvidia/Nemotron-3-Ultra-550b-a55b"),
} as const;

export type ModelRole = keyof typeof MODELS;

/** The roles the live routes call; Ultra writes only in the bench scripts, so its absence never stops the demo. */
export const LIVE_ROLES: readonly ModelRole[] = ["vl", "nano", "super"];

/** Whether Token Factory lists each role's model; not `ok` (every route replays) when a live role's is missing or the list could not be read. */
export type Served = {
  ok: boolean;
  /** false when the list itself could not be read */
  listed: boolean;
  models: Record<ModelRole, boolean>;
  /** why not ok, naming each missing role and model */
  why?: string;
};

/** IDs a call was refused with 404 although Token Factory still listed them */
const refused = new Set<string>();

export function served(listed: ReadonlySet<string>): Served {
  const models = Object.fromEntries((Object.keys(MODELS) as ModelRole[]).map((r) => [r, listed.has(MODELS[r]) && !refused.has(MODELS[r])])) as Record<ModelRole, boolean>;
  const missing = LIVE_ROLES.filter((r) => !models[r]).map((r) => `${r}=${MODELS[r]}`);
  return { ok: missing.length === 0, listed: true, models, ...(missing.length ? { why: `missing ${missing.join(", ")}` } : {}) };
}

const LISTED_FOR_MS = 5 * 60_000;
const UNREAD_FOR_MS = 30_000;
let listing: { until: number; result: Promise<Served> } | undefined;

/**
 * Token Factory's model list, checked per role. Read at most once every five
 * minutes per function instance (thirty seconds after a failed read), so a
 * live route pays for it once in a while, not on every call.
 */
export function liveModels(client: OpenAI, now = Date.now()): Promise<Served> {
  if (listing && now < listing.until) return listing.result;
  // a throw while sending, as well as a refusal, counts as a list not read
  const result = Promise.resolve()
    .then(() => client.models.list())
    .then(
      (page): Served => served(new Set(page.data.map((m) => m.id))),
      (err: unknown): Served => ({
        ok: false,
        listed: false,
        models: { vl: false, nano: false, super: false, ultra: false },
        why: `Token Factory did not list its models (${err instanceof Error ? err.message : String(err)})`.slice(0, 200),
      }),
    );
  const entry = { until: now + LISTED_FOR_MS, result };
  listing = entry;
  void result.then((s) => {
    if (listing === entry && !s.listed) entry.until = now + UNREAD_FOR_MS;
    if (!s.ok) console.warn(`tokenfactory: every route replays: ${s.why}`);
  });
  return result;
}

/** A call answered 404 for this model: treat it as unlisted from now on and read the list again on the next request. */
export function notServed(model: string): void {
  refused.add(model);
  listing = undefined;
}

/** For tests: forget every list read and every refusal. */
export function forgetModels(): void {
  refused.clear();
  listing = undefined;
}

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
