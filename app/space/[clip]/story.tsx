"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Sample } from "@/lib/samples";
import { usd, verdict } from "@/lib/showcase/format";
import { modelLabel } from "@/lib/providers/models";
import type { Call, Iteration, Run, Session } from "@/lib/showcase/session";
import type { TaskSpec } from "@/lib/spec/schema";
import { ProgramView, type Failure } from "../../program-view";

const Rehearsal = dynamic(() => import("../../rehearsal").then((m) => m.Rehearsal), {
  ssr: false,
  loading: () => (
    <div className="flex aspect-[4/3] w-full items-center justify-center rounded-xl border bg-[#f4f1ea]">
      <span className="rounded-lg bg-white/90 px-4 py-2.5 text-sm text-neutral-800 shadow-sm">Loading the simulator…</span>
    </div>
  ),
});

const SOURCE: Record<Iteration["source"], string> = { compile: "First compile", interview: "After the answers", notes: "Notes patch", playbook: "From the playbook" };

/** Interpreter notes name objects by id ("obj2 moving at 68 mm/s"); the story says their names. */
function named(spec: TaskSpec, text: string): string {
  return spec.objects.reduce((t, o) => t.replace(new RegExp(`\\b${o.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), `the ${o.name}`), text);
}

/** A labelled step in words; only a move, an insert or a place says where to. */
function stepWords(spec: TaskSpec, s: TaskSpec["steps"][number]): string {
  if (s.object === undefined) return s.verb;
  const name = (id: string) => spec.objects.find((o) => o.id === id)?.name ?? id;
  const where = s.target && s.target.frame !== s.object ? name(s.target.frame) : null;
  if (where && (s.verb === "insert" || s.verb === "place")) return `${s.verb} the ${name(s.object)} ${s.target!.fixture === "pocket" ? "into" : "onto"} the ${where}`;
  if (where && s.verb === "move") return `move the ${name(s.object)} to the ${where}`;
  return `${s.verb} the ${name(s.object)}`;
}

/** The models a stage's calls went to in this recording, by name; undefined when the stage made no call. */
function credit(session: Session, stage: Call["stage"]): string | undefined {
  const names = [...new Set(session.ledger.filter((c) => c.stage === stage).map((c) => modelLabel(c.model)))];
  return names.length ? names.join(" and ") : undefined;
}

function version(it: Iteration, i: number, session: Session): string {
  if (it.source === "interview") {
    const n = session.turns[i - 1]?.answers.length ?? 0;
    return `After ${n} answer${n === 1 ? "" : "s"}`;
  }
  if (it.source === "notes") return `${SOURCE.notes} ${session.iterations.slice(0, i + 1).filter((x) => x.source === "notes").length}`;
  return SOURCE[it.source];
}

/** The clip, fetched whole into a blob URL as the guided flow does: /samples/ serves no byte ranges, which Safari needs to stream. */
function Clip({ sample }: { sample: Sample }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    fetch(`/samples/${sample.name}.mp4`)
      .then((r) => {
        if (!r.ok) throw new Error(`the clip did not load (HTTP ${r.status})`);
        return r.blob();
      })
      .then((blob) => {
        if (!alive) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [sample.name]);
  if (error) return <p className="text-bad">{error}</p>;
  return (
    <div className="aspect-video w-full overflow-hidden rounded-lg border-2 border-ink bg-ink-deep">
      {url ? (
        <video src={url} poster={`/showcase/${sample.name}.jpg`} controls muted playsInline className="h-full w-full object-contain" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- the recorder's still, while the clip loads
        <img src={`/showcase/${sample.name}.jpg`} alt="" className="h-full w-full animate-pulse object-cover opacity-80" />
      )}
    </div>
  );
}

function Step({ n, title, model, children, id }: { n: number; title: string; model?: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="flex min-w-0 scroll-mt-6 flex-col gap-4 border-t-2 border-ink pt-5">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="display text-5xl font-bold text-transparent [-webkit-text-stroke:1.5px_var(--ink)]" aria-hidden="true">
          {n}
        </span>
        <h2 className="display text-3xl font-semibold text-ink-deep">{title}</h2>
        {model && <span className="text-sm text-muted sm:ml-auto">{model}</span>}
      </header>
      {children}
    </section>
  );
}

function Outcome({ run, spec }: { run: Run; spec: TaskSpec }) {
  if (run.pass) return <span className="font-semibold text-ok">passes</span>;
  // a program with an open question rehearses up to it and stops there
  if (run.failure_class === "spec_gap" && run.why?.startsWith("unanswered: ")) return <span className="font-semibold text-accent-text">stops at its first open question</span>;
  return (
    <span>
      <span className="font-semibold text-bad">fails</span>
      {run.why && <span className="text-neutral-700">: {named(spec, run.why)}</span>}
    </span>
  );
}

export function Story({ sample, session }: { sample: Sample; session: Session }) {
  const last = session.iterations.length - 1;
  const [pick, setPick] = useState(last);
  const [failure, setFailure] = useState<Failure | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const it = session.iterations[pick];
  const label = session.label.spec;
  const fit = session.fit.spec;
  const name = (spec: TaskSpec, id: string) => spec.objects.find((o) => o.id === id)?.name ?? id;
  const spent = (i: number) => session.label.cost_usd + session.iterations.slice(0, i + 1).reduce((a, x) => a + x.cost_usd, 0);
  const tokens = session.ledger.reduce((a, c) => a + c.prompt_tokens + c.completion_tokens, 0);
  const asked = session.turns.filter((t) => t.asks.length > 0);
  const finalFails = !session.iterations[last].results.earth.pass || !session.iterations[last].results.orbit.pass;
  const firstNote = session.iterations.findIndex((x) => x.source === "notes");
  const compiler = credit(session, "compile");

  function choose(i: number, scroll: boolean) {
    setPick(i);
    setFailure(null);
    if (scroll) stage.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex max-w-3xl flex-col gap-3">
        <Link href="/space" className="self-start text-muted underline underline-offset-2 hover:text-accent-text">
          All clips
        </Link>
        <h1 className="display text-4xl font-semibold text-ink-deep sm:text-5xl">{label.title}</h1>
        <p className="text-lg text-neutral-700">
          {sample.label}. Recorded on {new Date(session.recorded_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}{" "}
          {session.selection ? `as ${session.selection.run ? `run ${session.selection.run} of ${session.selection.runs}` : `one of ${session.selection.runs}`} recording runs of this clip, ${session.selection.kept}; labels and patches vary from run to run` : "as one run through Understudy (labels vary run to run)"}. Its {session.ledger.length} model calls cost {usd(session.total_usd)} in all. The last version of its program {verdict(session)}.
        </p>
      </header>

      <Step n={1} title="The clip">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Clip sample={sample} />
          <div className="flex flex-col gap-3 text-[17px] leading-relaxed">
            <p>
              The only other input is the line its uploader would type. It names the task, and that matters: in our{" "}
              <a className="underline underline-offset-2 hover:text-accent-text" href="https://github.com/gibouu/understudy/blob/main/docs/MEASUREMENTS.md#6-labelling-the-hero-clip">
                label measurements
              </a>{" "}
              only a hint that names the task got the model to name the object being moved.
            </p>
            <blockquote className="display border-l-4 border-sun pl-4 text-2xl leading-snug text-ink-deep">“{session.hint}”</blockquote>
            <p className="text-muted">The clip goes to the model as a small copy: 480 pixels wide, 4 frames a second, no sound.</p>
          </div>
        </div>
      </Step>

      <Step n={2} title="What the model saw" model={credit(session, "label")}>
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <p className="text-[17px] leading-relaxed">{label.summary}</p>
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
          <div className="flex flex-col gap-3 self-start rounded-lg bg-paper-deep p-5">
            <h3 className="display text-xl font-semibold">Fitted to the robot’s bench</h3>
            <p className="text-neutral-700">
              {fit.steps.length >= 2 && fit.steps[0].object !== undefined
                ? <>The SO-101 rehearses one manipulation: the {name(fit, fit.steps[0].object)} goes {fit.steps[1].target?.fixture === "pocket" ? "into" : "onto"} the {name(fit, fit.steps[1].target?.frame ?? "")}, laid out within its reach and sized for its gripper.</>
                : <>The SO-101 rehearses a gesture: the hand&apos;s path, scaled into its reach.</>}{" "}
              Everything the fit changed or left out:
            </p>
            <ul className="list-disc pl-5 text-neutral-700">
              {session.fit.warnings.map((w) => (
                <li key={w}>{named(session.fit.spec, w)}</li>
              ))}
            </ul>
            {session.label.warnings.length > 0 && (
              <details className="text-sm text-muted">
                <summary className="cursor-pointer">What the checks flagged in the label</summary>
                <ul className="mt-2 list-disc pl-5">
                  {session.label.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>
      </Step>

      <Step n={3} title="What the robot asked" model={compiler}>
        {compiler ? (
          <>
            <p className="max-w-3xl text-[17px] leading-relaxed">
              Nano writes the robot’s program and turns every value it would otherwise have to guess into a question for the person who did the task. The answers below were given when recording, standing in for the crew member; each round recompiles the program.
            </p>
            {asked.length === 0 && <p className="text-neutral-700">Nano had no questions: the spec held everything the program needed.</p>}
          </>
        ) : (
          // a gesture: its program is the hand's path, written without a model call
          <p className="max-w-3xl text-[17px] leading-relaxed">No model wrote this program: it follows the hand’s path traced from the clip, so there was nothing to ask.</p>
        )}
        {asked.map((turn, i) => (
          <ol key={i} className="flex max-w-3xl flex-col gap-5">
            {turn.asks.map((a) => {
              const answer = turn.answers.find((x) => x.slot === a.slot);
              return (
                <li key={a.slot} className="flex flex-col gap-2">
                  <p className="max-w-xl self-start rounded-2xl border-2 border-ink bg-card px-4 py-3 text-[17px] text-ink-deep shadow-[5px_5px_0_var(--accent-bright)]">
                    {a.question}
                    {a.why && <span className="mt-1 block text-sm text-muted">{a.why}</span>}
                  </p>
                  <p className="ml-6 max-w-xl border-l-4 border-sun pl-3 text-[17px] sm:ml-10">{answer ? answer.text : <span className="text-muted">not answered</span>}</p>
                </li>
              );
            })}
            {turn.warnings.length > 0 && (
              <li>
                <details className="text-sm text-muted">
                  <summary className="cursor-pointer">Compile notes for round {i + 1}</summary>
                  <ul className="mt-2 list-disc pl-5">
                    {turn.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </details>
              </li>
            )}
          </ol>
        ))}
      </Step>

      <div ref={stage} className="flex scroll-mt-4 flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Version of the program">
          <span className="mr-1 text-muted">Version of the program:</span>
          {session.iterations.map((x, i) => (
            <button
              key={i}
              aria-pressed={i === pick}
              onClick={() => choose(i, false)}
              className={`rounded-full border-2 px-3 py-1 ${i === pick ? "border-ink bg-ink text-paper" : "border-ink/30 hover:border-ink"}`}
            >
              {i}. {version(x, i, session)}
            </button>
          ))}
        </div>
        <div className="grid gap-10 lg:grid-cols-2 lg:gap-8">
          <Step n={4} title="The program">
            <ProgramView spec={it.spec} program={it.program} failure={failure} />
          </Step>
          <Step n={5} title="The rehearsal" model="MuJoCo in your browser, SO-101">
            <p className="text-neutral-700">
              When it was recorded, version {pick} of the program: on Earth it <Outcome run={it.results.earth} spec={it.spec} />; in orbit it <Outcome run={it.results.orbit} spec={it.spec} />. Here it runs again.
            </p>
            {/* the Notes stage calls a model, and /space never does */}
            <Rehearsal key={pick} spec={it.spec} program={it.program} onFail={setFailure} notes={false} hint={session.hint} autoplay speed={2} />
          </Step>
        </div>
      </div>

      <Step n={6} title="How it improved">
        <ol className="flex flex-col divide-y-2 divide-ink/15 border-y-2 border-ink/15">
          {session.iterations.map((x, i) => (
            <li key={i} className={`grid gap-3 py-4 md:grid-cols-[13rem_minmax(0,1fr)_11rem] md:gap-6 ${i === pick ? "bg-card" : ""}`}>
              <div className="flex flex-col gap-1 md:pl-3">
                <span className="display text-xl font-semibold">
                  {i}. {version(x, i, session)}
                </span>
                <button onClick={() => choose(i, true)} className="self-start text-sm text-accent-text underline underline-offset-2 hover:decoration-2">
                  Rehearse this version
                </button>
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <p>
                  Earth: <Outcome run={x.results.earth} spec={x.spec} />
                  <br />
                  Orbit: <Outcome run={x.results.orbit} spec={x.spec} />
                </p>
                {x.changes.length > 0 && (
                  <ul className="list-disc pl-5 text-neutral-700">
                    {x.changes.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                )}
                <p className="text-sm text-muted">Why: {named(x.spec, x.why)}</p>
              </div>
              <p className="tnum text-sm text-neutral-700 md:pr-3 md:text-right">
                {usd(x.cost_usd)} for this version
                <br />
                {usd(spent(i))} so far
              </p>
            </li>
          ))}
        </ol>
        {firstNote > 0 ? (
          <p className="max-w-3xl rounded-lg border-2 border-dashed border-accent p-4 text-[17px]">
            From version {firstNote} on, the Notes stage takes over: Super reads what the simulator measured in the previous version’s rehearsal and changes the numbers of the step that failed, and each patch is rehearsed again on Earth and in orbit. It thinks only once the cheap answer gets stuck.{session.selection?.others && ` ${session.selection.others}`} On small probe programs of two to four knobs, the same loop fixed 94% of the failures that could be fixed.
          </p>
        ) : (
          session.pending.length > 0 &&
          finalFails && (
            <p className="max-w-3xl rounded-lg border-2 border-dashed border-accent p-4 text-[17px]">
              This recording stops before the Notes stage, where Super reads what the simulator measured in the failed rehearsal, patches the program’s numbers, and each patch is rehearsed again on Earth and in orbit.
            </p>
          )
        )}
        <p className="text-sm text-muted">
          All model calls for this recording: {session.ledger.length} calls on Nebius Token Factory, {tokens.toLocaleString("en")} tokens, {usd(session.total_usd)} at list prices, {session.ledger.reduce((a, c) => a + c.seconds, 0).toFixed(1)} s.
        </p>
      </Step>
    </main>
  );
}
