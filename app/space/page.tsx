import type { Metadata } from "next";
import Link from "next/link";
import { selectionLine, usd, verdict } from "@/lib/showcase/format";
import { recordings } from "@/lib/showcase/load";

export const metadata: Metadata = { title: "Space showcase · Understudy" };

export default async function Space() {
  const all = await recordings();
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-10 sm:px-6 sm:py-14">
      <header className="flex max-w-3xl flex-col gap-4">
        <h1 className="display text-5xl font-semibold text-ink-deep sm:text-6xl">Space showcase</h1>
        <p className="text-lg leading-relaxed text-neutral-700">
          Astronauts at work aboard the ISS, filmed by NASA. Each clip is one recorded run through Understudy (labels vary run to run); what the models answered is recorded, so this page calls none of them. The simulated SO-101 runs again in your browser for every version of the program, on Earth and in orbit.
        </p>
      </header>

      <ul className="flex flex-col gap-8">
        {all.map(({ sample, session }) => {
          const asks = session.turns.reduce((n, t) => n + t.asks.length, 0);
          return (
            <li key={sample.name}>
              <Link href={`/space/${sample.name}`} className="group grid overflow-hidden rounded-lg border-2 border-ink bg-card shadow-[7px_8px_0_var(--sun)] transition-transform hover:-translate-y-0.5 md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
                <div className="duotone aspect-[16/9] md:aspect-auto md:min-h-80">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a still the recorder wrote; next/image would only resize it */}
                  <img src={`/showcase/${sample.name}.jpg`} alt={`A frame from ${sample.label}`} className="h-full w-full object-cover md:absolute md:inset-0" />
                </div>
                <div className="flex flex-col gap-3 p-5 sm:p-6">
                  <h2 className="display text-3xl font-semibold leading-tight text-ink-deep">{session.label.spec.title}</h2>
                  <p className="text-neutral-700">{sample.label}</p>
                  <p className="text-sm text-muted">
                    {asks} question{asks === 1 ? "" : "s"} from the robot, {session.iterations.length} version{session.iterations.length === 1 ? "" : "s"} of its program; the last one {verdict(session)}. Model calls: {usd(session.total_usd)}.
                  </p>
                  {selectionLine(session) && <p className="text-sm text-muted">{selectionLine(session)}</p>}
                  <span className="mt-auto self-start rounded-full bg-ink px-4 py-2 text-paper group-hover:bg-accent-text">Watch it</span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
