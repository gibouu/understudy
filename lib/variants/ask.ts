/**
 * The one Super call behind /api/variants: thinking off, JSON mode, and one
 * more ask when an idea does not fit the bench (the reasons go back to it).
 * Returns Super's reply as given; `checkReply` turns it into variants.
 */
import type OpenAI from "openai";
import { callModel, type CallOptions } from "@/lib/providers/call";
import type { TaskSpec } from "@/lib/spec/schema";
import type { LedgerEntry, StageResult } from "@/lib/spec/stage-result";
import { normalizeReply, VariantReply } from "./parse";
import { userMessage, VARIANTS_SYSTEM } from "./prompt";
import { replyProblems } from "./validate";

export function variantsCall(spec: TaskSpec, request?: string): CallOptions<VariantReply> {
  return {
    role: "super",
    system: VARIANTS_SYSTEM,
    user: userMessage(spec, request),
    maxTokens: 2500,
    schema: VariantReply,
    normalize: normalizeReply,
    check: (reply) => replyProblems(spec, reply, request),
  };
}

/** `ledger` receives every billed call, the ones of a failed answer included. */
export function askSuper(client: OpenAI, spec: TaskSpec, request?: string, ledger?: LedgerEntry[]): Promise<StageResult<VariantReply>> {
  return callModel(client, { ...variantsCall(spec, request), ledger });
}

/** One line from the person, trimmed to one short line; empty means none. */
export function cleanRequest(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const line = raw.replace(/\s+/g, " ").trim().slice(0, max);
  return line || undefined;
}
