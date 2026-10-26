import type { Metadata } from "next";
import { Flow } from "../flow";
import { HealthBadge } from "../health-badge";

export const metadata: Metadata = { title: "Film your own · Understudy" };

export default function Try() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:py-12">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="display text-4xl font-semibold text-ink-deep sm:text-5xl">Film your own</h1>
          <HealthBadge />
        </div>
        <p className="text-lg text-neutral-700">
          Choose a clip of someone doing a tabletop task. The models watch it, ask what they could not see, and a simulated SO-101 rehearses it on Earth and in orbit.
        </p>
      </header>
      <Flow />
    </main>
  );
}
