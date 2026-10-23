/**
 * Lenient parsing of model output.
 *
 * Policy
 *   1. Leading reasoning (`<think>…</think>` at the very start, repeated) is
 *      removed. A leading `<think>` that never closes means the model was
 *      cut off while reasoning: nothing in it is trusted.
 *   2. A single string-aware pass finds the balanced JSON values at the top
 *      level of what remains. Values nested inside an unfinished outer value
 *      (a truncated draft) are not candidates. Prose braces that do not parse
 *      are skipped. Exactly one candidate may parse and validate; several
 *      different valid ones (an example next to the answer) are refused as
 *      ambiguous, and the caller asks again for a single JSON value.
 *   3. An optional `normalize` hook rewrites near-misses (aliases, degraded
 *      fixtures) and returns warnings before validation. A normalizer that
 *      throws only disqualifies that candidate.
 */
import type { z } from "zod";

/** Larger outputs are refused before any scanning. */
export const MAX_MODEL_OUTPUT_CHARS = 2_000_000;

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

/** Index of the close bracket balancing the one at `start`; -1 when the text ends first or a closer mismatches. */
function balancedEnd(text: string, start: number): number {
  const expected: string[] = [];
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
    else if (c === "{") expected.push("}");
    else if (c === "[") expected.push("]");
    else if (c === "}" || c === "]") {
      if (expected.pop() !== c) return -1; // a mismatched closer: not JSON, and nothing after it is trusted
      if (expected.length === 0) return i;
    }
  }
  return -1;
}

/**
 * Top-level balanced candidates in order, found in one pass. An unbalanced
 * top-level opener swallows the rest of the text (nothing inside an
 * unfinished value is offered).
 */
export function* jsonCandidates(text: string): Generator<string> {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c !== "{" && c !== "[") {
      i++;
      continue;
    }
    const end = balancedEnd(text, i);
    if (end < 0) return;
    yield text.slice(i, end + 1);
    i = end + 1;
  }
}

/** The last top-level candidate that is valid JSON, after leading-think removal, or null. Diagnostics only; parseModelJson decides. */
export function extractJson(text: string): string | null {
  let last: string | null = null;
  for (const candidate of jsonCandidates(stripLeadingThink(text))) {
    try {
      JSON.parse(candidate);
      last = candidate;
    } catch {
      /* prose braces */
    }
  }
  return last;
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
 * carries the last validation failure so the caller can retry, keep the
 * previous value or fall back.
 */
export function parseModelJson<T>(
  text: string,
  schema: z.ZodType<T>,
  options: { normalize?: Normalizer } = {},
): Parsed<T> {
  if (text.length > MAX_MODEL_OUTPUT_CHARS) {
    throw new ModelOutputError(`model output too long (${text.length} chars)`, text.slice(0, 1000));
  }
  const body = stripLeadingThink(text);
  const valid: Parsed<T>[] = [];
  let lastFailure: string | null = null;
  let sawJson = false;
  for (const candidate of jsonCandidates(body)) {
    let raw: unknown;
    try {
      raw = JSON.parse(candidate);
    } catch {
      continue;
    }
    sawJson = true;
    let normalized: { data: unknown; warnings: string[] };
    try {
      normalized = options.normalize ? options.normalize(raw) : { data: raw, warnings: [] };
    } catch (err) {
      lastFailure = `normalization failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    const result = schema.safeParse(normalized.data);
    if (result.success) valid.push({ value: result.data, warnings: normalized.warnings });
    else lastFailure = describe(result.error);
  }
  if (valid.length === 1) return valid[0];
  if (valid.length > 1) {
    const distinct = new Set(valid.map((v) => JSON.stringify(v.value)));
    if (distinct.size === 1) return valid[valid.length - 1];
    throw new ModelOutputError(`ambiguous output: ${distinct.size} different values validate; ask for a single JSON value`, text);
  }
  if (!sawJson) throw new ModelOutputError("no complete JSON value in model output", text);
  throw new ModelOutputError(`schema validation failed: ${lastFailure}`, text);
}
