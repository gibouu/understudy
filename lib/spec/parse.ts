/**
 * Lenient parsing of model output.
 *
 * Policy
 *   1. Leading reasoning (`<think>…</think>` at the very start, repeated) is
 *      removed. A leading `<think>` that never closes means the model was
 *      cut off while reasoning: nothing in it is trusted.
 *   2. Every `{` or `[` in what remains starts a candidate; the candidate ends
 *      at its balanced close, string-aware. Prose braces, examples before the
 *      answer and reasoning tags inside JSON strings are survived because the
 *      first candidate that both parses and validates wins.
 *   3. An optional `normalize` hook rewrites near-misses (aliases, degraded
 *      fixtures) and returns warnings before validation.
 */
import type { z } from "zod";

export class ModelOutputError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = "ModelOutputError";
  }
}

/** Remove leading think blocks; return "" for an unterminated leading one. */
export function stripLeadingThink(text: string): string {
  let s = text.trimStart();
  while (s.startsWith("<think>")) {
    const end = s.indexOf("</think>");
    if (end < 0) return "";
    s = s.slice(end + "</think>".length).trimStart();
  }
  return s;
}

/** Balanced close index for a candidate starting at `start`, or -1. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** Every balanced candidate in order of its start offset. */
export function* jsonCandidates(text: string): Generator<string> {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "{" && c !== "[") continue;
    const end = balancedEnd(text, i);
    if (end > i) yield text.slice(i, end + 1);
  }
}

/** The first candidate that is valid JSON, after leading-think removal, or null. */
export function extractJson(text: string): string | null {
  for (const candidate of jsonCandidates(stripLeadingThink(text))) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      /* try the next start */
    }
  }
  return null;
}

export type Parsed<T> = { value: T; warnings: string[] };
export type Normalizer = (raw: unknown) => { data: unknown; warnings: string[] };

function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/**
 * Parse and validate model text against a Zod schema. Throws
 * ModelOutputError when no candidate parses and validates; the message
 * carries the first validation failure so the caller can retry, keep the
 * previous value or fall back.
 */
export function parseModelJson<T>(
  text: string,
  schema: z.ZodType<T>,
  options: { normalize?: Normalizer } = {},
): Parsed<T> {
  const body = stripLeadingThink(text);
  let firstFailure: string | null = null;
  let sawJson = false;
  for (const candidate of jsonCandidates(body)) {
    let raw: unknown;
    try {
      raw = JSON.parse(candidate);
    } catch {
      continue;
    }
    sawJson = true;
    const normalized = options.normalize ? options.normalize(raw) : { data: raw, warnings: [] };
    const result = schema.safeParse(normalized.data);
    if (result.success) return { value: result.data, warnings: normalized.warnings };
    firstFailure ??= describe(result.error);
  }
  if (!sawJson) throw new ModelOutputError("no JSON object in model output", text);
  throw new ModelOutputError(`schema validation failed: ${firstFailure}`, text);
}
