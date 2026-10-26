import Link from "next/link";
import { recordings } from "@/lib/showcase/load";

const MEASURED = "https://github.com/gibouu/understudy/blob/main/docs/MEASUREMENTS.md";

/** Three numbers from docs/MEASUREMENTS.md, each linked to the section that measures it. */
const NUMBERS = [
  { figure: "US$0.04", text: "for a whole session of model calls, from watching the clip to the reshoot list (US$0.0375 on average over three runs).", href: `${MEASURED}#1-what-a-session-costs` },
  { figure: "94%", text: "of the failing rehearsals that can be fixed are fixed within five patches, by Super reading the simulator's notes and reasoning when it gets stuck. Measured on small probe programs of two to four knobs.", href: `${MEASURED}#8-the-self-improvement-loop` },
  { figure: "+28 points", text: "of first-try success on the Moon and in orbit, from rules learned on Earth and Mars, with the cheap model: 5% becomes 33%, against a matched control.", href: `${MEASURED}#8-the-self-improvement-loop` },
];

export default async function Home() {
  const first = (await recordings())[0];
  return (
    <main className="flex flex-col">
      <section className="relative isolate overflow-hidden bg-ink-deep text-paper">
        <Limb />
        <div className="relative mx-auto flex max-w-6xl flex-col gap-6 px-4 pb-36 pt-14 sm:px-6 sm:pb-44 sm:pt-20">
          <h1 className="display misprint text-[clamp(3.5rem,13vw,9.5rem)] font-bold">Understudy</h1>
          <p className="max-w-2xl text-xl leading-snug sm:text-2xl">
            Film a person doing a task once. Understudy turns the clip into a robot program, asks what the camera could not see, and a simulated arm rehearses it on Earth and in orbit.
          </p>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-5 px-4 py-12 sm:px-6 md:grid-cols-12 md:gap-6">
        <Link href="/space" className="group flex flex-col overflow-hidden rounded-lg border-2 border-ink bg-card shadow-[8px_9px_0_var(--sun)] transition-transform hover:-translate-y-0.5 md:col-span-7">
          {first && (
            <div className="duotone aspect-[16/9]">
              {/* eslint-disable-next-line @next/next/no-img-element -- a still the recorder wrote; next/image would only resize it */}
              <img src={`/showcase/${first.sample.name}.jpg`} alt={`A frame from ${first.sample.label}`} className="h-full w-full object-cover" />
            </div>
          )}
          <div className="flex flex-1 flex-col gap-3 p-5 sm:p-6">
            <h2 className="display text-3xl font-semibold text-ink-deep sm:text-4xl">Space showcase</h2>
            <p className="text-[17px] leading-relaxed text-neutral-700">
              Astronauts aboard the ISS, filmed by NASA. Each clip is one recorded run through Understudy (labels vary run to run): see what the model saw, what the robot asked and how its program changed. The arm rehearses every version again in your browser, and nothing here calls a model.
            </p>
            <span className="mt-auto self-start rounded-full bg-ink px-4 py-2 text-paper group-hover:bg-accent-text">Open the showcase</span>
          </div>
        </Link>

        <Link href="/try" className="group flex flex-col gap-3 rounded-lg border-2 border-ink p-5 transition-transform hover:-translate-y-0.5 sm:p-6 md:col-span-5">
          <h2 className="display text-3xl font-semibold text-ink-deep sm:text-4xl">Film your own</h2>
          <p className="text-[17px] leading-relaxed text-neutral-700">Start from a sample clip or upload one of your own. The models run live on Nebius Token Factory.</p>
          <ol className="flex flex-col gap-3 border-t pt-4 text-[17px]">
            {["Super VL watches the clip and names the objects and steps.", "Nano writes the robot’s program and asks what it could not see; you answer.", "The arm rehearses the program on Earth and in orbit."].map((line, i) => (
              <li key={line} className="grid grid-cols-[2rem_1fr] items-baseline">
                <span className="display text-2xl font-bold text-accent-bright">{i + 1}</span>
                {line}
              </li>
            ))}
          </ol>
          <span className="mt-auto self-start rounded-full border-2 border-ink px-4 py-1.5 group-hover:border-accent-text group-hover:text-accent-text">Choose a clip</span>
        </Link>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
        <h2 className="mb-5 text-lg text-muted">Measured on 25 October 2026, not estimated:</h2>
        <ol className="grid gap-px overflow-hidden rounded-lg border-2 border-ink bg-ink md:grid-cols-3">
          {NUMBERS.map((n) => (
            <li key={n.figure} className="bg-paper">
              <a href={n.href} className="group flex h-full flex-col gap-2 p-5 hover:bg-card sm:p-6">
                <span className="display tnum text-5xl font-semibold text-accent-bright sm:text-6xl">{n.figure}</span>
                <span className="text-[17px] leading-snug">{n.text}</span>
                <span className="mt-auto pt-2 text-sm text-muted underline underline-offset-2 group-hover:text-accent-text">How we measured it</span>
              </a>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

/** The Earth's limb seen from orbit, printed in riso bands: the atmosphere in sun and orange, slightly out of register. */
function Limb() {
  return (
    <svg className="absolute inset-0 -z-10 h-full w-full" viewBox="0 0 1200 520" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <defs>
        <linearGradient id="limb-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0c1a2e" />
          <stop offset="1" stopColor="#1b3352" />
        </linearGradient>
        <pattern id="limb-dots" width="9" height="9" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.3" fill="#f7efe2" fillOpacity=".08" />
        </pattern>
        <pattern id="limb-halftone" width="7" height="7" patternUnits="userSpaceOnUse">
          <circle cx="1.6" cy="1.6" r="1.15" fill="#0c1a2e" fillOpacity=".28" />
        </pattern>
        <filter id="limb-tooth">
          <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="3" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>
      <rect width="1200" height="520" fill="url(#limb-sky)" />
      <g fill="#f7efe2">
        <circle cx="140" cy="70" r="1.6" opacity=".7" />
        <circle cx="1040" cy="56" r="1.3" opacity=".6" />
        <circle cx="905" cy="150" r="1.8" opacity=".8" />
        <circle cx="300" cy="200" r="1.1" opacity=".5" />
        <circle cx="1130" cy="230" r="1.4" opacity=".6" />
      </g>
      <circle cx="780" cy="1640" r="1236" fill="#efb340" opacity=".28" />
      <circle cx="780" cy="1640" r="1222" fill="#efb340" opacity=".55" />
      <circle cx="780" cy="1640" r="1208" fill="#e87d3e" opacity=".85" />
      <circle cx="788" cy="1646" r="1194" fill="#cf5220" />
      <circle cx="780" cy="1640" r="1178" fill="#9b3a12" />
      <circle cx="780" cy="1640" r="1178" fill="url(#limb-halftone)" />
      <rect width="1200" height="520" fill="url(#limb-dots)" />
      <rect width="1200" height="520" filter="url(#limb-tooth)" opacity=".16" style={{ mixBlendMode: "overlay" }} />
    </svg>
  );
}
