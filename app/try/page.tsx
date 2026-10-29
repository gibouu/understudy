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
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-neutral-800">
          <span className="font-medium">For judges:</span> Nebius Token Factory retires Nemotron 3 Nano and Nemotron 3 Super on 9 November 2026, before judging; we built on them. The NASA samples play runs recorded on them, their similar tasks included, so they need no model. A clip of your own runs on the Nemotron models Token Factory names in their place (Nemotron 3.5 Lightning and Nemotron 3.5 Super VL, with Nemotron 3 Ultra when a patch loop is stuck), which we measured on the same benches but did not design around. If a model is gone when you try, each step says so and plays its recording.
        </p>
      </header>
      <Flow />
    </main>
  );
}
