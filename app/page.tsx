import { HealthBadge } from "./health-badge";
import { Flow } from "./flow";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-4 py-12">
      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-3xl font-semibold tracking-tight">Understudy</h1>
          <HealthBadge />
        </div>
        <p className="text-lg text-neutral-700">
          One clip of a person doing a task becomes a robot program. The models watch it, ask what
          they could not see, and a simulated SO-101 rehearses it on Earth and in orbit.
        </p>
      </header>

      <Flow />

      <footer className="text-xs text-neutral-500">
        Nebius x NVIDIA Global AI Hackathon 2026 · Physical AI track · Apache-2.0 ·{" "}
        <a className="underline" href="https://github.com/gibouu/understudy">
          github.com/gibouu/understudy
        </a>
      </footer>
    </main>
  );
}
