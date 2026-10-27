"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { TraceFrame } from "@/lib/export/trace";
import type { Sample } from "@/lib/samples";
import { usd } from "@/lib/showcase/format";
import type { Session } from "@/lib/showcase/session";
import { tourExport, tourVersions, type TourRun } from "@/lib/showcase/tour";
import type { Rollout } from "@/lib/sim/interpreter";
import type { GravityName } from "@/lib/spec/schema";
import { Clip, credit, named, Outcome, stepWords } from "../space/[clip]/story";

const Rehearsal = dynamic(() => import("../rehearsal").then((m) => m.Rehearsal), {
  ssr: false,
  loading: () => (
    <div className="flex aspect-[4/3] w-full items-center justify-center rounded-xl border bg-[#f4f1ea]">
      <span className="rounded-lg bg-white/90 px-4 py-2.5 text-sm text-neutral-800 shadow-sm">Loading the simulator…</span>
    </div>
  ),
});

const REPO = "https://github.com/gibouu/understudy";
/** The stage plays twice as fast as real time: the physics steps the same, so the results do not change. */
const SPEED = 2;
/** Seconds a stage step stays on its results before the tour moves on. */
const HOLD_S = 3;

type StepId = "clip" | "saw" | "asked" | "fails" | "patch" | "passes" | "export";
/** `dwell`: seconds the step shows before the tour moves on; a stage step moves on once both worlds have run. */
const STEPS: { id: StepId; label: string; dwell?: number }[] = [
  { id: "clip", label: "The clip", dwell: 6 },
  { id: "saw", label: "What the model saw", dwell: 8 },
  { id: "asked", label: "What the robot asked", dwell: 8 },
  { id: "fails", label: "Rehearsal: Earth, then orbit" },
  { id: "patch", label: "The patch", dwell: 8 },
  { id: "passes", label: "Rehearsed again" },
  { id: "export", label: "The export" },
];

const ignore = () => {};
const WORLDS: GravityName[] = ["earth", "orbit"];

type Seen = Partial<Record<GravityName, Rollout>>;

export function Tour({ sample, session }: { sample: Sample; session: Session }) {
  const { first, last, patches } = tourVersions(session);
  const steps = STEPS.filter((s) => first < last || (s.id !== "fails" && s.id !== "patch"));
  const [at, setAt] = useState(0);
  const [paused, setPaused] = useState(false);
  const [seenFirst, setSeenFirst] = useState<Seen>({});
  const [seenLast, setSeenLast] = useState<Seen>({});
  const [passing, setPassing] = useState<TourRun[]>([]);
  /** the clip can play: its dwell waits for it, not for the download */
  const [clipReady, setClipReady] = useState(false);
  const top = useRef<HTMLDivElement>(null);
  const step = steps[at];
  const index = (id: StepId) => steps.findIndex((s) => s.id === id);
  const stageStep = step.id === "fails" || step.id === "passes";
  const seen = step.id === "fails" ? seenFirst : seenLast;
  const ran = Object.keys(seen).length;

  // One simulator at a time, each mounted from the step before its own (hidden, it loads while the visitor reads) to
  // its own step: a hidden stage left mounted would keep stepping and drawing. Coming back remounts and rehearses again.
  const mountsFirst = (i: number) => first < last && i <= index("fails");
  const mountsLast = (i: number) => i >= index("passes") - 1 && i <= index("passes");

  function go(to: number) {
    const next = Math.max(0, Math.min(steps.length - 1, to));
    // a stage mounted afresh rehearses again: what the last one found must not move the tour on
    if (!mountsFirst(at) && mountsFirst(next)) setSeenFirst({});
    if (!mountsLast(at) && mountsLast(next)) setSeenLast({});
    setAt(next);
    // the step's media sits under its header: bring the header back when the visitor has scrolled past it
    if (top.current && top.current.getBoundingClientRect().top < 0) top.current.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // a stage step holds its results a moment once both worlds have run, then moves on
  const advance = useEffectEvent(() => go(at + 1));
  useEffect(() => {
    if (!stageStep || ran < 2 || paused) return;
    const t = setTimeout(advance, HOLD_S * 1000);
    return () => clearTimeout(t);
  }, [stageStep, ran, paused, at]);

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    // a video's own controls seek with the arrows
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, video, audio, [contenteditable]")) return;
    if (e.key === "ArrowRight") go(at + 1);
    if (e.key === "ArrowLeft") go(at - 1);
  });
  useEffect(() => {
    const listen = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", listen);
    return () => window.removeEventListener("keydown", listen);
  }, []);

  const onRehearseFirst = useCallback(() => setSeenFirst({}), []);
  const onRehearseLast = useCallback(() => (setSeenLast({}), setPassing([])), []);
  const onRunFirst = useCallback((world: GravityName, rollout: Rollout) => setSeenFirst((s) => ({ ...s, [world]: rollout })), []);
  const onRunLast = useCallback((world: GravityName, rollout: Rollout, trace: TraceFrame[]) => {
    setSeenLast((s) => ({ ...s, [world]: rollout }));
    setPassing((ps) => [...ps.filter((p) => p.world !== world), ...(rollout.pass ? [{ world, trace }] : [])].sort((a, b) => (a.world === "earth" ? -1 : b.world === "earth" ? 1 : 0)));
  }, []);

  const label = session.label.spec;
  const fit = session.fit.spec;
  const name = (id: string) => fit.objects.find((o) => o.id === id)?.name ?? id;
  const asks = session.turns.flatMap((t) => t.asks.map((a) => ({ ...a, answer: t.answers.find((x) => x.slot === a.slot)?.text })));
  const before = session.iterations[first];
  const after = session.iterations[last];
  const orbitOnly = before.results.earth.pass && !before.results.orbit.pass;

  const mountFirst = mountsFirst(at);
  const mountLast = mountsLast(at);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
      <div ref={top} className="flex scroll-mt-2 flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <p className="hidden text-muted sm:block">
            The 1-minute demo: a recorded run of {sample.label}. Nothing on this page calls a model.
          </p>
          <p className="tnum text-sm text-muted" aria-live="polite">
            Step {at + 1} of {steps.length}
          </p>
        </div>
        <ol className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} aria-label="Steps">
          {steps.map((s, i) => (
            <li key={s.id}>
              <button onClick={() => go(i)} className="group flex w-full flex-col gap-1.5 text-left" aria-current={i === at ? "step" : undefined} title={s.label}>
                <span className="relative block h-2 overflow-hidden rounded-full bg-ink/15">
                  {i < at && <span className="absolute inset-y-0 left-0 w-full bg-ink" />}
                  {i === at && s.dwell !== undefined && (
                    <span
                      key={at}
                      className="tour-fill absolute inset-y-0 left-0 bg-accent-bright"
                      style={{ animationDuration: `${s.dwell}s`, animationPlayState: paused || (s.id === "clip" && !clipReady) ? "paused" : "running" }}
                      onAnimationEnd={() => go(at + 1)}
                    />
                  )}
                  {i === at && s.dwell === undefined && (s.id === "export" ? <span className="absolute inset-0 bg-accent-bright" /> : <span className="absolute inset-y-0 left-0 bg-accent-bright transition-[width] duration-500" style={{ width: `${(ran / 2) * 100}%` }} />)}
                </span>
                <span className={`hidden text-xs leading-tight md:block ${i === at ? "font-semibold text-ink-deep" : "text-muted group-hover:text-ink"}`}>{s.label}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <h1 className="display mr-auto text-4xl font-semibold text-ink-deep sm:text-5xl">{step.label}</h1>
          <div className="flex gap-2">
            <button onClick={() => go(at - 1)} disabled={at === 0} className="rounded-full border-2 border-ink px-4 py-1.5 disabled:opacity-30">
              Back
            </button>
            {step.id !== "export" && (
              <button onClick={() => setPaused((p) => !p)} aria-pressed={paused} className="rounded-full border-2 border-ink px-4 py-1.5">
                {paused ? "Play" : "Pause"}
              </button>
            )}
            {step.id !== "export" ? (
              <button onClick={() => go(at + 1)} className="rounded-full bg-ink px-5 py-1.5 text-paper hover:bg-accent-text">
                Next
              </button>
            ) : (
              <button onClick={() => (go(0), setPaused(false))} className="rounded-full border-2 border-ink px-4 py-1.5">
                Watch again
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10">
        <div className="order-2 flex min-w-0 flex-col gap-4 text-[17px] leading-relaxed lg:order-1">
          {step.id === "clip" && (
            <>
              <p className="text-xl leading-snug text-ink-deep">Astronauts at work aboard the ISS, filmed by NASA. Understudy gets this clip and one line of text, nothing else:</p>
              <blockquote className="display border-l-4 border-sun pl-4 text-2xl leading-snug text-ink-deep">“{session.hint}”</blockquote>
              <p className="text-muted">No robot, no hardware: what follows turns the clip into a program for a robot arm and rehearses it in a simulator.</p>
            </>
          )}
          {step.id === "saw" && (
            <>
              <p className="text-xl leading-snug text-ink-deep">{credit(session, "label") ?? "The vision model"} watches the clip and writes down the objects and the steps.</p>
              <p>{label.summary}</p>
              <p className="text-muted">
                {fit.steps.length >= 2 && fit.steps[0].object !== undefined
                  ? `Fitted to the robot's bench: the ${name(fit.steps[0].object)} goes ${fit.steps[1].target?.fixture === "pocket" ? "into" : "onto"} the ${name(fit.steps[1].target?.frame ?? "")}, sized for the SO-101's gripper and reach.`
                  : "Fitted to the robot's bench: the hand's path, scaled into the SO-101's reach."}
              </p>
            </>
          )}
          {step.id === "asked" && (
            <>
              <p className="text-xl leading-snug text-ink-deep">
                {credit(session, "compile") ?? "The compiler"} writes the robot’s program, and every value it would have to guess becomes a question for the person who did the task.
              </p>
              <p className="text-muted">The answers were given when this run was recorded, standing in for the crew member; each one recompiles the program.</p>
            </>
          )}
          {step.id === "fails" && (
            <>
              <p className="text-xl leading-snug text-ink-deep">The same program runs twice in MuJoCo, here in your browser: at 1 g, then at 0 g.</p>
              <div className="hidden lg:block">
                <Live seen={seenFirst} spec={before.spec} />
              </div>
              <p className="text-sm text-muted">
                When recorded, on Earth it <Outcome run={before.results.earth} spec={before.spec} />; in orbit it <Outcome run={before.results.orbit} spec={before.spec} />.
              </p>
              {orbitOnly && <p className="text-muted">At 0 g a released object keeps its velocity instead of resting, so a program must constrain an object before it lets go.</p>}
            </>
          )}
          {step.id === "patch" && (
            <>
              <p className="text-xl leading-snug text-ink-deep">
                {credit(session, "notes") ?? "The notes model"} reads what the simulator measured and changes the numbers of the step that failed. Each patch is rehearsed again in both worlds.
              </p>
              <p className="text-muted">On small probe programs of two to four knobs, this loop fixed 94% of the failures that could be fixed.</p>
            </>
          )}
          {step.id === "passes" && (
            <>
              <p className="text-xl leading-snug text-ink-deep">The patched program, on Earth and in orbit.</p>
              <div className="hidden lg:block">
                <Live seen={seenLast} spec={after.spec} />
              </div>
              <p className="text-sm text-muted">
                When recorded, on Earth it <Outcome run={after.results.earth} spec={after.spec} />; in orbit it <Outcome run={after.results.orbit} spec={after.spec} />.
              </p>
              <p className="text-muted">Once it passes, the stage draws the setting the clip points to around the arm. That is scenery: the rehearsal itself runs on the bench.</p>
            </>
          )}
          {step.id === "export" && (
            <>
              <p className="text-xl leading-snug text-ink-deep">The passing rollouts you just watched, as a LeRobot v2.1 dataset in the layout GR00T N1.7 reads, built in your browser.</p>
              <p className="text-muted">It is a format-valid skeleton, not training data: scripted, primitive-rendered episodes, and its QUALITY.md says so.</p>
            </>
          )}
          {stageStep && (
            <p className="text-sm text-muted">
              Simulated SO-101 arm, rigid-body physics with a geometric grasp, {SPEED}× real time. No hardware. <a className="underline underline-offset-2 hover:text-accent-text" href={`${REPO}/blob/main/docs/LIMITATIONS.md`}>What a pass proves</a>
            </p>
          )}
        </div>

        <div className="order-1 flex min-w-0 flex-col gap-4 lg:order-2">
          {step.id === "clip" && <Clip sample={sample} autoPlay onReady={() => setClipReady(true)} />}
          {step.id === "saw" && (
            <div className="flex flex-col gap-4">
              <ul className="flex flex-col divide-y border-y">
                {label.objects.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2">
                    <span className="font-semibold">{o.name}</span>
                    <span className="tnum text-sm text-muted">
                      {o.shape}, {o.size_mm.join(" × ")} mm, {o.role}
                    </span>
                  </li>
                ))}
              </ul>
              <ol className="flex flex-col gap-1.5">
                {label.steps.map((s) => (
                  <li key={s.id} className="grid grid-cols-[4.5rem_1fr] gap-3">
                    <span className="tnum font-mono text-sm text-muted">
                      {s.t_start_s.toFixed(0)}–{s.t_end_s.toFixed(0)} s
                    </span>
                    <span>{stepWords(label, s)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {step.id === "asked" &&
            (asks.length === 0 ? (
              <p className="text-neutral-700">No questions this time: the spec held everything the program needed.</p>
            ) : (
              <ol className="flex flex-col gap-5">
                {asks.map((a) => (
                  <li key={a.slot} className="flex flex-col gap-2">
                    <p className="max-w-xl self-start rounded-2xl border-2 border-ink bg-card px-4 py-3 text-[17px] text-ink-deep shadow-[5px_5px_0_var(--accent-bright)]">{a.question}</p>
                    <p className="ml-6 max-w-xl border-l-4 border-sun pl-3 text-[17px] sm:ml-10">{a.answer ?? <span className="text-muted">not answered</span>}</p>
                  </li>
                ))}
              </ol>
            ))}
          {step.id === "patch" && (
            <ol className="flex flex-col divide-y-2 divide-ink/15 border-y-2 border-ink/15">
              {patches.map((i, n) => {
                const x = session.iterations[i];
                return (
                  <li key={i} className="flex flex-col gap-2 py-4">
                    <span className="display text-xl font-semibold">Patch {n + 1}</span>
                    <ul className="list-disc pl-5">
                      {x.changes.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                    <p className="text-sm text-muted">Why: {named(x.spec, x.why)}</p>
                    <p>
                      Earth: <Outcome run={x.results.earth} spec={x.spec} />
                      <br />
                      Orbit: <Outcome run={x.results.orbit} spec={x.spec} />
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
          {mountFirst && (
            <div hidden={step.id !== "fails"}>
              <Rehearsal spec={before.spec} program={before.program} onFail={ignore} notes={false} hint={session.hint} autoplay speed={SPEED} guided onRun={onRunFirst} onRehearse={onRehearseFirst} />
            </div>
          )}
          {mountLast && (
            <div hidden={step.id !== "passes"}>
              <Rehearsal spec={after.spec} program={after.program} onFail={ignore} notes={false} hint={session.hint} autoplay speed={SPEED} guided onRun={onRunLast} onRehearse={onRehearseLast} />
            </div>
          )}
          {/* on a phone the caption sits under the stage: the results come first */}
          {step.id === "fails" && (
            <div className="lg:hidden">
              <Live seen={seenFirst} spec={before.spec} />
            </div>
          )}
          {step.id === "passes" && (
            <div className="lg:hidden">
              <Live seen={seenLast} spec={after.spec} />
            </div>
          )}
          {step.id === "export" && <Download session={session} sample={sample} runs={passing} onRehearse={() => go(index("passes"))} />}
        </div>
      </div>

      {step.id === "export" && <EndCard sample={sample} session={session} />}
    </main>
  );
}

/** What the stage has found on this visit, world by world, where the visitor reads: the table under the stage can sit below the fold. */
function Live({ seen, spec }: { seen: Seen; spec: Session["iterations"][number]["spec"] }) {
  const now = WORLDS.find((w) => !seen[w]);
  return (
    <ul className="flex flex-col divide-y rounded-lg border-2 border-ink bg-card px-4" aria-live="polite" aria-label="Results in your browser">
      {WORLDS.map((w) => {
        const r = seen[w];
        return (
          <li key={w} className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-3 py-2.5">
            <span className="display text-xl font-semibold">{w === "earth" ? "Earth, 1 g" : "Orbit, 0 g"}</span>
            {!r ? (
              <span className="text-muted">{w === now ? "rehearsing…" : "next"}</span>
            ) : r.pass ? (
              <span className="font-semibold text-ok">passes</span>
            ) : (
              <span>
                <span className="font-semibold text-bad">fails</span>
                {r.why && <span className="text-neutral-700">: {named(spec, r.why)}</span>}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Download({ session, sample, runs, onRehearse }: { session: Session; sample: Sample; runs: TourRun[]; onRehearse: () => void }) {
  const [state, setState] = useState<{ paths: string[]; headline: string } | { error: string } | "building" | null>(null);

  async function build() {
    setState("building");
    try {
      const { zip, paths, quality } = await tourExport(session, runs);
      const url = URL.createObjectURL(new Blob([zip.slice().buffer], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `understudy-${sample.name}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setState({ paths, headline: quality.headline });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border-2 border-dashed border-ink/40 p-5">
        <p>The dataset is built from the rollouts the stage plays on this visit, and none has passed here yet.</p>
        <button onClick={onRehearse} className="self-start rounded-full bg-ink px-5 py-2 text-paper hover:bg-accent-text">
          Rehearse it first
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 rounded-lg border-2 border-ink bg-card p-5 shadow-[7px_8px_0_var(--sun)]">
      <p>
        {runs.length} passing rollout{runs.length === 1 ? "" : "s"} ({runs.map((r) => (r.world === "earth" ? "Earth" : "orbit")).join(" and ")}), with the spec, the program, the interview and the ledger of the recorded run.
      </p>
      <button onClick={build} disabled={state === "building"} className="self-start rounded-full bg-ink px-5 py-2.5 text-lg text-paper hover:bg-accent-text disabled:opacity-50">
        {state === "building" ? "Building…" : "Download the dataset (.zip)"}
      </button>
      {state !== null && state !== "building" && "error" in state && <p className="text-bad">The export failed: {state.error}</p>}
      {state !== null && state !== "building" && "paths" in state && (
        <div className="flex flex-col gap-2 text-sm">
          <p className="font-semibold">{state.headline}.</p>
          <ul className="max-h-48 overflow-auto font-mono text-xs text-neutral-700">
            {state.paths.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function EndCard({ sample, session }: { sample: Sample; session: Session }) {
  return (
    <section className="flex flex-col gap-5 rounded-lg bg-ink-deep p-6 text-paper sm:p-8">
      <h2 className="display text-3xl font-semibold sm:text-4xl">That was the whole loop.</h2>
      <p className="max-w-3xl text-lg leading-snug text-paper/90">
        One clip, {session.ledger.length} model calls on Nebius Token Factory for {usd(session.total_usd)} when it was recorded, and a simulated arm that rehearsed the program on Earth and in orbit. A pass shows that a scripted SO-101 program carries out the clarified task in rigid-body physics with a geometric grasp, nothing more: not that a learned policy or a real robot would succeed.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link href="/try" className="rounded-full bg-sun px-5 py-2.5 text-lg font-semibold text-ink-deep hover:bg-paper">
          Film your own
        </Link>
        <Link href={`/space/${sample.name}`} className="rounded-full border-2 border-paper/70 px-5 py-2 hover:border-sun hover:text-sun">
          This run in full detail
        </Link>
        <Link href="/space" className="rounded-full border-2 border-paper/70 px-5 py-2 hover:border-sun hover:text-sun">
          Every recorded clip
        </Link>
        <a href={REPO} className="rounded-full border-2 border-paper/70 px-5 py-2 hover:border-sun hover:text-sun">
          Source on GitHub
        </a>
      </div>
    </section>
  );
}
