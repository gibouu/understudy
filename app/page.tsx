import { HealthBadge } from "./health-badge";
import { STAGES, STAGE_LABELS } from "@/lib/spec/stage-result";
import { MODELS } from "@/lib/providers/tokenfactory";

const STAGE_MODEL: Partial<Record<(typeof STAGES)[number], string>> = {
  watch: "MediaPipe, in the browser",
  label: MODELS.vl,
  compile: MODELS.nano,
  interview: MODELS.super,
  ground: "Tavily, filtered by " + MODELS.nano,
  saboteur: MODELS.super,
  rehearsal: "MuJoCo WebAssembly, SO-101",
  notes: MODELS.super + " then " + MODELS.nano,
  reshoot: MODELS.ultra,
  export: "LeRobot v2.1 + modality.json, in the browser",
};

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-4 py-12">
      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-3xl font-semibold tracking-tight">Understudy</h1>
          <HealthBadge />
        </div>
        <p className="text-lg text-neutral-700">
          Watch a person do a task once. Interview them. Rehearse it on a simulated robot. Export the
          training data.
        </p>
      </header>

      <section className="rounded-xl border border-dashed p-6 text-sm text-neutral-600">
        <p className="font-medium text-neutral-800">Upload a clip</p>
        <p className="mt-1">
          One H.264 MP4, 10 seconds to 2 minutes, one person, one tabletop task, fixed phone. Only a
          dozen keyframes leave your browser. Uploads open on day two; the sample clips come with
          them.
        </p>
      </section>

      <ol className="flex flex-col gap-2">
        {STAGES.map((stage, i) => (
          <li
            key={stage}
            className="flex items-baseline justify-between gap-4 rounded-lg border px-4 py-3"
          >
            <span className="flex items-baseline gap-3">
              <span className="w-5 text-right text-xs text-neutral-400">{i + 1}</span>
              <span className="font-medium">{STAGE_LABELS[stage]}</span>
            </span>
            <span className="truncate text-xs text-neutral-500">{STAGE_MODEL[stage]}</span>
          </li>
        ))}
      </ol>

      <footer className="text-xs text-neutral-500">
        Nebius x NVIDIA Global AI Hackathon 2026 · Physical AI track · Apache-2.0 ·{" "}
        <a className="underline" href="https://github.com/gibouu/understudy">
          github.com/gibouu/understudy
        </a>
      </footer>
    </main>
  );
}
