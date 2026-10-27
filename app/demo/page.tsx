import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { recordings } from "@/lib/showcase/load";
import { tourPick } from "@/lib/showcase/tour";
import { Tour } from "./tour";

export const metadata: Metadata = {
  title: "The 1-minute demo · Understudy",
  description: "One recorded run, step by step: a NASA clip, what the model saw, what the robot asked, a simulated SO-101 rehearsing on Earth and in orbit, the patch, and the export.",
};

/** The guided tour of one showcase recording; like /space it calls no model. */
export default async function Demo() {
  const r = tourPick(await recordings());
  if (!r) notFound();
  return <Tour sample={r.sample} session={r.session} />;
}
