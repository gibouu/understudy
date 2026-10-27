/**
 * The one model call every route makes: JSON mode and thinking off (unless
 * asked for), one retry without JSON mode when Token Factory answers 400
 * (thinking stays off), one more ask when the output does not parse, and then the
 * caller's previous value (when it has one) instead of a failure, so a bad
 * recompile never loses a working program. Spec v2 risk 3.
 */
import OpenAI from "openai";
import type { z } from "zod";
import { ModelOutputError, parseModelJson, type Normalizer } from "@/lib/spec/parse";
import { done, failed, type LedgerEntry, type StageResult } from "@/lib/spec/stage-result";
import { errorText, MODELS, notServed, thinkingOff, usageOf, type ModelRole } from "./tokenfactory";

/** Token Factory takes a video as a `video_url` part, which the OpenAI types do not list. */
export type UserPart = OpenAI.ChatCompletionContentPart | { type: "video_url"; video_url: { url: string } };

export type CallOptions<T> = {
  role: ModelRole;
  /** left out for the vision model, as it was measured */
  system?: string;
  /** text, or text and video parts for the vision model */
  user: string | UserPart[];
  maxTokens: number;
  schema: z.ZodType<T>;
  normalize?: Normalizer;
  /** kept, with a warning, when the second answer still does not parse */
  previous?: T;
  /** the answer's shape in one line, repeated when an answer is not usable: a model asked again with only the error tends to repeat itself */
  shape?: string;
  /** problems a parsed value still has; the model is asked once to fix them, and what remains becomes warnings */
  check?: (value: T) => string[];
  /** reason before answering (the model's default); maxTokens then covers reasoning and answer */
  thinking?: boolean;
  /** every billed call is pushed here as well, failed ones included (a failed result carries no ledger) */
  ledger?: LedgerEntry[];
};

export async function callModel<T>(client: OpenAI, o: CallOptions<T>): Promise<StageResult<T>> {
  const model = MODELS[o.role];
  const ledger: LedgerEntry[] = o.ledger ?? [];
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    ...(o.system === undefined ? [] : [{ role: "system" as const, content: o.system }]),
    { role: "user", content: o.user as OpenAI.ChatCompletionUserMessageParam["content"] },
  ];
  let optional = true;
  let checked: { value: T; warnings: string[] } | null = null;

  async function ask(): Promise<string> {
    const started = Date.now();
    // thinking stays off on the retry too: a thinking answer can spend the whole budget and return nothing
    const params = { model, messages, max_tokens: o.maxTokens, ...(o.thinking ? {} : thinkingOff()) };
    let res;
    try {
      res = await client.chat.completions.create(optional ? { ...params, response_format: { type: "json_object" } } : params);
    } catch (err) {
      if (!(optional && err instanceof OpenAI.APIError && err.status === 400)) throw err;
      optional = false;
      return ask();
    }
    const u = usageOf(res);
    ledger.push({ model, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, cached_tokens: u.cached_tokens, seconds: (Date.now() - started) / 1000 });
    return res.choices[0]?.message?.content ?? "";
  }

  try {
    for (let attempt = 1; ; attempt++) {
      const text = await ask();
      try {
        const { value, warnings } = parseModelJson(text, o.schema, { normalize: o.normalize });
        const problems = o.check?.(value) ?? [];
        if (problems.length === 0 || attempt === 2) return done(value, [...warnings, ...problems.map((p) => `${o.role}: ${p}`)], ledger);
        checked = { value, warnings: [...warnings, ...problems.map((p) => `${o.role}: ${p}`)] };
        messages.push({ role: "assistant", content: text }, { role: "user", content: `That answer has problems:\n- ${problems.join("\n- ")}\nFix them and return the whole answer again as one JSON object only.` });
      } catch (err) {
        if (!(err instanceof ModelOutputError)) throw err;
        if (attempt === 2) {
          // a fix that does not parse: the first answer, problems and all, beats nothing
          if (checked) return done(checked.value, [...checked.warnings, `${o.role}: the corrected answer did not parse`], ledger);
          if (o.previous !== undefined) return done(o.previous, [`${o.role}: ${err.message}; previous value kept`], ledger);
          return failed(`${o.role}: ${err.message}`);
        }
        messages.push({ role: "assistant", content: text }, { role: "user", content: `That answer was not usable (${err.message}).${o.shape ? ` The shape is ${o.shape}.` : ""} Return the whole answer again as one JSON object only.` });
      }
    }
  } catch (err) {
    // network, auth, rate limit: the SDK already retried what it could
    const status = err instanceof OpenAI.APIError ? err.status : undefined;
    // a retired or unknown model: from the next request on, every route replays
    if (status === 404) notServed(model);
    if (checked) return done(checked.value, [...checked.warnings, `${o.role}: the fix was not returned (${errorText(err)})`.slice(0, 300)], ledger);
    return failed(`${o.role}: ${errorText(err)}`.slice(0, 300), status === undefined || status === 429 || status >= 500);
  }
}
