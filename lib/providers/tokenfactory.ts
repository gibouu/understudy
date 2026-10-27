/**
 * Nebius Token Factory through the OpenAI SDK. One place for the base URL,
 * the four NVIDIA model IDs (overridable from env so a renamed model does not
 * break the demo in December), the replacements Token Factory names for the
 * ones it retires, the replay switch, and the request defaults
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

/**
 * Models Token Factory retires from Serverless, and the replacement its notice
 * names (docs.tokenfactory.nebius.com/model-deprecations-november-2026, read
 * 27 Oct 2026). Token Factory does not reroute a retired ID: it answers 404.
 * A role keeps its own model while Token Factory lists it and moves to the
 * replacement only once it is gone, so the demo and its measurements stay on
 * the original models until that day (docs/MEASUREMENTS.md section 12).
 */
export const RETIRED: Readonly<Record<string, { by: string; on: string; names: string }>> = {
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": { by: "nvidia/Nemotron-3_5-Lightning", on: "2026-11-09", names: "Nemotron 3 Nano → Nemotron 3.5 Lightning" },
  "nvidia/nemotron-3-super-120b-a12b": { by: "nvidia/Nemotron-3.5-Super-VL", on: "2026-11-09", names: "Nemotron 3 Super → Nemotron 3.5 Super VL" },
};

/** The roles the live routes call; Ultra writes only in the bench scripts, so its absence never stops the demo. */
export const LIVE_ROLES: readonly ModelRole[] = ["vl", "nano", "super"];

/**
 * What Token Factory serves for each role: its own model, else the named
 * replacement, else nothing (`ok` false, and every route replays). `listed`
 * is false when the list itself could not be read.
 */
export type Served = {
  ok: boolean;
  listed: boolean;
  models: Record<ModelRole, string | null>;
  /** roles answering with a replacement, as "Nemotron 3 Nano → Nemotron 3.5 Lightning" */
  replaced: string[];
  /** why not ok, naming each missing role and model */
  why?: string;
};

/** IDs a call was refused with 404 although Token Factory still listed them */
const refused = new Set<string>();

/** The model to call for `id` given what Token Factory lists: itself, else its named replacement, else nothing. */
function pick(id: string, listed: ReadonlySet<string>): string | null {
  const has = (m: string) => listed.has(m) && !refused.has(m);
  const by = RETIRED[id]?.by;
  return has(id) ? id : by && has(by) ? by : null;
}

export function served(listed: ReadonlySet<string>): Served {
  const models = Object.fromEntries((Object.keys(MODELS) as ModelRole[]).map((role) => [role, pick(MODELS[role], listed)])) as Record<ModelRole, string | null>;
  const replaced = LIVE_ROLES.filter((r) => models[r] !== null && models[r] !== MODELS[r]).map((r) => RETIRED[MODELS[r]].names);
  const missing = LIVE_ROLES.filter((r) => models[r] === null).map((r) => `${r}=${MODELS[r]}`);
  return { ok: missing.length === 0, listed: true, models, replaced, ...(missing.length ? { why: `missing ${missing.join(", ")}` } : {}) };
}

const LISTED_FOR_MS = 5 * 60_000;
const UNREAD_FOR_MS = 30_000;
let listing: { until: number; result: Promise<Served> } | undefined;
/** the IDs of the last list read */
let listedNow: ReadonlySet<string> | undefined;

/**
 * Token Factory's model list, resolved per role. Read at most once every five
 * minutes per function instance (thirty seconds after a failed read), so a
 * live route pays for it once in a while, not on every call.
 */
export function liveModels(client: OpenAI, now = Date.now()): Promise<Served> {
  if (listing && now < listing.until) return listing.result;
  // a throw while sending, as well as a refusal, counts as a list not read
  const result = Promise.resolve().then(() => client.models.list()).then(
    (page): Served => {
      listedNow = new Set(page.data.map((m) => m.id));
      return served(listedNow);
    },
    (err: unknown): Served => ({
      ok: false,
      listed: false,
      models: { vl: null, nano: null, super: null, ultra: null },
      replaced: [],
      why: `Token Factory did not list its models (${err instanceof Error ? err.message : String(err)})`.slice(0, 200),
    }),
  );
  const entry = { until: now + LISTED_FOR_MS, result };
  listing = entry;
  void result.then((s) => {
    if (listing === entry && !s.listed) entry.until = now + UNREAD_FOR_MS;
    if (s.replaced.length) console.info(`tokenfactory: retired models answered by their replacements: ${s.replaced.join("; ")}`);
    if (!s.ok) console.warn(`tokenfactory: every route replays: ${s.why}`);
  });
  return result;
}

/**
 * The model to call for a role's ID (`MODELS[role]`): its named replacement
 * once the last list read no longer has it, else the ID itself, which a call
 * then reports as 404.
 */
export function current(id: string): string {
  return (listedNow && pick(id, listedNow)) ?? id;
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
  listedNow = undefined;
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
