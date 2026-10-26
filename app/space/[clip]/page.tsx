import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { recording, recordings } from "@/lib/showcase/load";
import { Story } from "./story";

export async function generateStaticParams() {
  return (await recordings()).map((r) => ({ clip: r.sample.name }));
}

export async function generateMetadata({ params }: PageProps<"/space/[clip]">): Promise<Metadata> {
  const r = await recording((await params).clip);
  return { title: r ? `${r.session.label.spec.title} · Understudy` : "Space showcase · Understudy" };
}

/** The clip comes from the URL: a navigation shows this shell at once and the story streams in. */
export default function ClipStory({ params }: PageProps<"/space/[clip]">) {
  return (
    <Suspense fallback={<main className="mx-auto h-[70vh] w-full max-w-6xl animate-pulse px-4 py-12 sm:px-6" aria-busy="true" />}>
      <Recorded params={params} />
    </Suspense>
  );
}

async function Recorded({ params }: Pick<PageProps<"/space/[clip]">, "params">) {
  const r = await recording((await params).clip);
  if (!r) notFound();
  return <Story sample={r.sample} session={r.session} />;
}
