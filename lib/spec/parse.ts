/**
 * Lenient parsing of model output. Reasoning models may wrap JSON in
 * <think> blocks, prose or code fences; we take the first balanced JSON
 * value and validate it. Schema defaults and coercions turn near-misses
 * into warnings instead of failures.
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

/** Strip thinking blocks and return the first balanced {...} or [...] in the text. */
export function extractJson(text: string): string | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "");
  const start = cleaned.search(/[[{]/);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
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
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

export type Parsed<T> = { value: T; warnings: string[] };

/**
 * Parse and validate model text against a Zod schema. Throws
 * ModelOutputError when no JSON is found or validation fails; the caller
 * decides whether to retry, keep the previous value or fall back.
 */
export function parseModelJson<T>(text: string, schema: z.ZodType<T>): Parsed<T> {
  const json = extractJson(text);
  if (json === null) throw new ModelOutputError("no JSON object in model output", text);
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new ModelOutputError(`invalid JSON: ${(err as Error).message}`, text);
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ModelOutputError(`schema validation failed: ${issues}`, text);
  }
  return { value: result.data, warnings: [] };
}
