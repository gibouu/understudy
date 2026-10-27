/**
 * GET /api/models: the model each role calls on this deployment
 * (lib/providers/tokenfactory.ts MODELS, retired IDs already replaced), and
 * the one that answers a stuck Notes loop, so a stage's line can name the
 * model before it answers. A result still names the model that really
 * answered, from its ledger. IDs only: nothing secret.
 */
import { connection, NextResponse } from "next/server";
import { stuckRole } from "@/lib/notes/patch";
import { MODELS } from "@/lib/providers/tokenfactory";

export type LiveModels = { vl: string; nano: string; super: string; ultra: string; stuck: string };

export async function GET(): Promise<NextResponse<LiveModels>> {
  // at request time, as /api/health: a build made with other env must not answer for this one
  await connection();
  return NextResponse.json({ vl: MODELS.vl, nano: MODELS.nano, super: MODELS.super, ultra: MODELS.ultra, stuck: MODELS[stuckRole(MODELS.super)] });
}
