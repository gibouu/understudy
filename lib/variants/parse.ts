/**
 * What Super answers when asked for similar tasks: a few variants, each a
 * short name, one sentence and the spec changes that make it, plus the ideas
 * the arm cannot do yet and why. The normalizer accepts the near-misses seen
 * from JSON-mode models: a bare list of variants, a `value` sent as a JSON
 * string, a `source` the model added (provenance is ours to set).
 */
import { z } from "zod";
import type { Normalized } from "@/lib/spec/normalize";

export const MAX_VARIANTS = 5;

export const Idea = z.object({
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().max(300).default(""),
  changes: z.array(z.object({ path: z.string().trim().min(1), value: z.unknown() })).min(1).max(8),
});
export type Idea = z.infer<typeof Idea>;

export const NotYet = z.object({ idea: z.string().trim().min(1).max(200), why: z.string().trim().max(300).default("") });
export type NotYet = z.infer<typeof NotYet>;

export const VariantReply = z.object({
  variants: z.array(Idea).max(8).default([]),
  not_yet: z.array(NotYet).max(8).default([]),
});
export type VariantReply = z.infer<typeof VariantReply>;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A value written as JSON text ("[30, 8, 30]") is the value it spells; any other string stays a string. */
function unquote(value: unknown): unknown {
  if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function normalizeReply(raw: unknown): Normalized {
  const warnings: string[] = [];
  const reply = Array.isArray(raw) ? { variants: raw } : isRec(raw) ? { ...raw } : raw;
  if (!isRec(reply)) return { data: reply, warnings };
  if (!Array.isArray(reply.variants) && Array.isArray(reply.changes)) reply.variants = [{ title: reply.title, summary: reply.summary, changes: reply.changes }];
  if (Array.isArray(reply.variants)) {
    reply.variants = reply.variants.map((v) => {
      if (!isRec(v) || !Array.isArray(v.changes)) return v;
      return { ...v, changes: v.changes.map((c) => (isRec(c) ? { path: c.path, value: unquote(c.value) } : c)) };
    });
  }
  return { data: reply, warnings };
}
