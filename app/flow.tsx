"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { estimate, usual, type Stage } from "@/lib/estimate";
import { SAMPLES, type Sample } from "@/lib/samples";
import { formAnswers, recordedBy, recordedLine, recordedNote, same, turnFor } from "@/lib/showcase/play";
import { Session } from "@/lib/showcase/session";
import { fitToBench, type Fit } from "@/lib/sim/fit";
import { formFor, WAITING_NOTE, waitingProgram } from "@/lib/spec/answer";
import { applyChanges } from "@/lib/spec/apply";
import { LINE_MAX, oneArmLine, scopeNotes, sentenceOf } from "@/lib/spec/confirm";
import type { Program, ProgramOp, SpecChange, TaskSpec } from "@/lib/spec/schema";
import { done, failed, idle, running, type StageResult } from "@/lib/spec/stage-result";
import { CONSENT_LINE } from "@/lib/keep/record";
import { gateNote } from "@/lib/unlock/messages";
import { clipSha256, makeProxy } from "@/lib/vision/proxy";
import { rememberedLabel, rememberLabel } from "@/lib/vision/remembered";
import { withGesturePaths } from "@/lib/vision/trace";
import { FilmYourself, keepSampleToken, liveAuth, UnlockPrompt, UploadClip } from "./capture";
import { GroundChips } from "./ground-chips";
import { keep, keepCall, keeping, startSession } from "./keep";
import { answeredBy, useModels, type Role } from "./models";
import { ProgramView, type Failure } from "./program-view";
import { Reshoot } from "./reshoot";
import { Working } from "./working";

const Rehearsal = dynamic(() => import("./rehearsal").then((m) => m.Rehearsal), {
  ssr: false,
  loading: () => <div className="aspect-[4/3] w-full animate-pulse rounded-xl border bg-neutral-100" />,
});
const Variants = dynamic(() => import("./variants").then((m) => m.Variants), { ssr: false });
const Saboteur = dynamic(() => import("./saboteur").then((m) => m.Saboteur), { ssr: false });

/** Nano asks about one gap per compile; past this many rounds the page stops asking. */
const MAX_ROUNDS = 6;

/** What each stage is doing and why, one line each, naming the model this deployment calls for it. */
const lines = (say: (role: Role) => string): Record<Exclude<Stage, "notes">, string> => ({
  recorded: "Opening the recording of this clip",
  proxy: "Making a small copy of the clip in your browser, 480 px wide at 4 frames a second, so it uploads quickly",
  watch: `${say("vl")} is watching the clip on Token Factory, to name the objects and the steps`,
  trace: "MediaPipe is tracing the hand in your browser, so the arm can follow the same path",
  compile: `${say("nano")} is writing the robot's program, with a question for each number it would have to guess`,
});

/** The clip being worked on: a sample (with its showcase recording, when it has one) or a clip of your own. */
type Clip = { blob: Blob; url: string; sample?: Sample; rec?: Session | null };
type Box = "label" | "program";
type Clock = { stage: Stage; at: number };

type Ask = Extract<ProgramOp, { op: "ask" }>;
const asksOf = (p: Program): Ask[] => p.steps.flatMap((s) => s.ops).filter((op): op is Ask => op.op === "ask");

async function post<T>(url: string, body: unknown): Promise<StageResult<T>> {
  const at = keeping();
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...liveAuth(), ...(body as object) }) });
    const r = (await res.json()) as StageResult<T>;
    keepCall(url, body, r, at);
    return r;
  } catch (err) {
    return failed((err as Error).message);
  }
}

export function Flow() {
  const say = useModels();
  const [clip, setClip] = useState<Clip | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  /** the stage running in each box, and Date.now() when it began */
  const [clock, setClock] = useState<Record<Box, Clock>>({ label: { stage: "proxy", at: 0 }, program: { stage: "compile", at: 0 } });
  const [hint, setHint] = useState("");
  const [label, setLabel] = useState<StageResult<TaskSpec>>(idle());
  const [fit, setFit] = useState<Fit | null>(null);
  const [spec, setSpec] = useState<TaskSpec | null>(null);
  const [program, setProgram] = useState<StageResult<Program>>(idle());
  /** who wrote the program shown: a recompile that kept it keeps its writer */
  const [programBy, setProgramBy] = useState<string | undefined>(undefined);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [turn, setTurn] = useState(0);
  const [notes, setNotes] = useState<string[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** a live label waiting for the person to confirm it (#158): the tracing notes its fit will carry */
  const [unconfirmed, setUnconfirmed] = useState<string[] | null>(null);
  /** the consent box for a clip of your own (#78): nothing is kept without it */
  const [consent, setConsent] = useState(false);
  /** the id a session given for training is kept under, shown so its owner can ask for it to be deleted */
  const [kept, setKept] = useState<string | undefined>(undefined);
  /** the id the rehearsal on screen began under: a rollout that ends after the box changed is not kept */
  const rehearsalAt = useRef<string | undefined>(undefined);
  const pick = useRef(0);
  // leaving /try ends the kept session: no other page asks for consent
  useEffect(() => () => void startSession(false), []);
  /** bumped by every reset: a reply that lands after a newer clip or run is dropped */
  const gen = useRef(0);

  function reset() {
    gen.current++;
    setClock((x) => ({ label: { ...x.label, at: 0 }, program: { ...x.program, at: 0 } }));
    setLabel(idle());
    setFit(null);
    setSpec(null);
    setProgram(idle());
    setProgramBy(undefined);
    setAnswers({});
    setTurn(0);
    setNotes([]);
    setFailure(null);
    setUnconfirmed(null);
  }

  function choose(blob: Blob, nextHint: string, sample?: Sample, rec?: Session | null) {
    pick.current++; // a sample still loading must not replace this clip
    setClip((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { blob, url: URL.createObjectURL(blob), sample, rec };
    });
    setDuration(null);
    setHint(nextHint);
    // a sample is NASA's: only a clip of your own, with the box ticked, is kept
    setKept(startSession(!sample && consent));
    reset();
  }

  async function loadSample(s: Sample) {
    const id = ++pick.current;
    try {
      // the recording /space plays, when this sample has one: the compiles and answers below come from it
      const [r, rec] = await Promise.all([
        fetch(`/samples/${s.name}.mp4`),
        fetch(`/showcase/${s.name}.json`)
          .then((x) => (x.ok ? x.json() : null))
          .then((raw) => Session.safeParse(raw).data ?? null)
          .catch(() => null),
      ]);
      if (!r.ok) throw new Error(`the sample did not load (HTTP ${r.status})`);
      const blob = await r.blob();
      if (id === pick.current) choose(blob, s.hint, s, rec);
    } catch (err) {
      if (id === pick.current) setLabel(failed((err as Error).message));
    }
  }

  /** A stage starts in a box: its line shows and its clock restarts; tracing's frame counts keep its clock running. */
  function step(box: Box, stage: Exclude<Stage, "notes">, note: string = lines(say)[stage]) {
    setClock((x) => (stage === "trace" && x[box].stage === "trace" && x[box].at > 0 ? x : { ...x, [box]: { stage, at: Date.now() } }));
    if (box === "label") setLabel(running(note));
    else setProgram(running(note));
  }

  /** `fresh`: ask Nano even when the recording has this spec ("Ask Nano again"). */
  async function compile(next: TaskSpec, previous?: Program, fresh = false) {
    const id = gen.current;
    setFailure(null);
    const turn = !fresh && clip?.rec ? turnFor(clip.rec, next) : null;
    if (turn && clip?.rec) {
      // the recording compiled exactly this spec: its program, and the answers given to its asks
      setProgram(done(turn.program, [recordedNote(clip.rec, "compile"), ...turn.warnings]));
      setProgramBy(recordedBy(clip.rec, "compile"));
      setAnswers(formAnswers(next, turn));
      return;
    }
    // nowhere to go yet: the one question, written here as the route would, with no model and no wait
    const waitingNow = waitingProgram(next);
    if (waitingNow) {
      setProgram(done(waitingNow, [WAITING_NOTE]));
      setProgramBy(undefined);
      setAnswers({});
      return;
    }
    step("program", "compile");
    const r = await post<Program>("/api/compile", { spec: next, previous });
    if (id !== gen.current) return;
    // the calls that failed are in the ledger, but the program shown is the one kept (lib/providers/call.ts)
    const kept = r.status === "done" && r.warnings.some((w) => w.endsWith("previous value kept"));
    if (!kept) setProgramBy(r.status === "done" ? answeredBy(r.ledger) : undefined);
    setProgram(r);
    setAnswers({});
  }

  /** The label from the sample's recording, when the line typed is still the one it was recorded with; null to label live. */
  async function recordedLabel(c: Clip, line: string): Promise<StageResult<TaskSpec> | null> {
    if (!c.sample || line.trim() !== c.sample.hint) return null;
    step("label", "recorded");
    const r = await post<TaskSpec>("/api/label", { clip_sha256: await clipSha256(c.blob), recorded: true });
    return r.status === "done" ? r : null;
  }

  /** `line`: the person's one line about the clip, sent as the hint (a rewrite of the label's sentence passes its own). */
  async function watch(line: string = hint) {
    if (!clip) return;
    reset();
    const id = gen.current;
    let labelled = await recordedLabel(clip, line);
    if (id !== gen.current) return;
    if (!labelled) {
      // a clip of your own labelled before, with the same line, answers from this browser (lib/vision/remembered.ts)
      const sha = await clipSha256(clip.blob).catch(() => null);
      const mine = sha && !clip.sample ? sha : null;
      labelled = mine ? await rememberedLabel(mine, line) : null;
      if (id !== gen.current) return;
      if (!labelled) {
        step("label", "proxy");
        // without a proxy the route can still answer from its recording of this clip; else the reason there is no proxy is shown
        const unproxied = { why: "" };
        const body = await makeProxy(clip.blob).catch(async (err) => ((unproxied.why = (err as Error).message), { clip_sha256: sha ?? (await clipSha256(clip.blob)) }));
        if (id !== gen.current) return;
        step("label", "watch");
        labelled = await post<TaskSpec>("/api/label", { ...body, hint: line });
        if (id !== gen.current) return;
        if (unproxied.why && labelled.status !== "done") labelled = failed(unproxied.why);
        if (mine) void rememberLabel(mine, line, labelled);
      }
    }
    keepSampleToken((labelled as { sample_token?: string }).sample_token);
    // the recording's own label keeps its recorded fit, so the recorded compiles match it exactly
    const rec = clip.rec && labelled.status === "done" && same(clip.rec.label.spec, labelled.value) ? clip.rec : null;
    // a gesture's hand path is measured here, in the browser, before the fit
    const { result: r, notes: traced } = rec
      ? { result: labelled, notes: [] }
      : await withGesturePaths(labelled, clip.blob, (note) => {
          const frame = /frame \d+ of \d+/.exec(note)?.[0];
          if (id === gen.current) step("label", "trace", frame ? `${lines(say).trace}: ${frame}` : lines(say).trace);
        });
    if (id !== gen.current) return;
    setLabel(r);
    if (r.status !== "done") return;
    // the recording's label plays at once; any other waits for the person to say it is what they did
    if (rec) await goOn(r.value, traced, rec);
    else setUnconfirmed(traced);
  }

  /** The label is what the person did: fit it to the bench and compile. */
  async function goOn(labelled: TaskSpec, traced: string[], rec: Session | null = null) {
    setUnconfirmed(null);
    const f = rec ? { spec: rec.fit.spec, warnings: [...rec.fit.warnings] } : fitToBench(labelled);
    f.warnings.unshift(...traced);
    setFit(f);
    setSpec(f.spec);
    await compile(f.spec);
  }

  async function answer(asks: Ask[]) {
    if (!spec || program.status !== "done") return;
    const changes: SpecChange[] = [];
    for (const a of asks) {
      const raw = answers[a.slot];
      if (raw === undefined || raw === "") continue;
      const form = formFor(spec, a.slot);
      const value = form.kind === "success" ? form.options[Number(raw)].predicates : form.kind === "target" ? form.options[Number(raw)].target : Number(raw);
      changes.push({ path: a.slot, value, source: `interview#${turn + 1}` });
    }
    if (changes.length === 0) return;
    keep("answers", { turn: turn + 1, asks, changes }, keeping());
    const applied = applyChanges(spec, changes);
    setNotes(applied.warnings);
    if (applied.warnings.length) return;
    let next = applied.spec;
    // where it goes, answered (lib/sim/fit.ts whereTo): the fit lays out the chosen object now
    if (changes.some((c) => formFor(spec, c.path).kind === "target")) {
      const f = fitToBench(next);
      setFit({ spec: f.spec, warnings: f.warnings });
      next = f.spec;
    }
    setSpec(next);
    setTurn(turn + 1);
    await compile(next, program.value);
  }

  const asks = program.status === "done" ? asksOf(program.value) : [];
  /** a program of gestures alone is written by the compile route itself, with no model (lib/sim/gesture.ts) */
  const gestures = Boolean(spec?.steps.length) && spec!.steps.every((s) => s.verb === "gesture");
  /** a place with nowhere to go yet: the compile route asks where, with no model (lib/spec/answer.ts waitingProgram) */
  const waiting = Boolean(spec) && waitingProgram(spec!) !== null;
  /** Section 2 names who answered the label (its ledger: a recording's carries its recorded calls), else the model this deployment calls. */
  const labelBy = (label.status === "done" && answeredBy(label.ledger)) || say("vl");
  const ready = program.status === "done" && spec && (asks.length === 0 || turn >= MAX_ROUNDS);

  return (
    <div className="flex flex-col gap-6">
      <Section n={1} title="Choose a clip">
        <div className="flex flex-wrap gap-2">
          {SAMPLES.map((s) => (
            <button key={s.name} className="rounded border px-3 py-1.5 text-sm hover:bg-neutral-50" onClick={() => loadSample(s)}>
              {s.label}
            </button>
          ))}
          <UploadClip
            key={clip?.url}
            disabled={!consent}
            onPick={() => {
              // the file being read is now the latest pick: a sample still loading must not replace it, nor it a later one
              const id = ++pick.current;
              return (file) => {
                if (id === pick.current) choose(file, "");
              };
            }}
          />
          <FilmYourself disabled={!consent} onClip={(take) => choose(take, "")} />
        </div>
        <label className="mt-3 flex items-start gap-2 text-sm text-neutral-700">
          <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => {
              setConsent(e.target.checked);
              // untick: nothing more of this clip is kept; tick again: what follows is kept, under a new id
              setKept(startSession(e.target.checked && Boolean(clip) && !clip?.sample));
            }} />
          <span>
            {CONSENT_LINE} <span className="text-neutral-500">Needed to upload or film a clip of your own; the samples need nothing.</span>
          </span>
        </label>
        <Privacy kept={kept} />
        {clip && (
          <div className="mt-3 flex flex-col gap-3">
            <video src={clip.url} controls muted playsInline onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)} className="max-h-72 w-full rounded-lg bg-black object-contain" />
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-600">What is the person doing? One line helps the model name the objects.</span>
              <input value={hint} onChange={(e) => setHint(e.target.value)} maxLength={200} className="rounded border px-3 py-1.5" placeholder="e.g. putting a capped marker into a pen holder" />
            </label>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40" disabled={label.status === "running"} onClick={() => watch()}>
                Watch the clip
              </button>
              <span className="text-sm text-neutral-600">
                {clip.rec && hint.trim() === clip.sample?.hint
                  ? "Recorded, so it plays at once; the rehearsal runs live in your browser."
                  : duration
                    ? clip.sample
                      ? `With your own line the models run live: about ${estimate(duration)}.`
                      : `This takes about ${estimate(duration)} for your own video, and a few seconds for each answer.`
                    : null}
              </span>
            </div>
          </div>
        )}
      </Section>

      {label.status !== "idle" && (
        <Section n={2} title="What the model saw" model={labelBy}>
          <Status result={label} clock={clock.label} duration={duration} />
          {label.status === "failed" && <UnlockPrompt message={label.message} onUnlock={() => watch()} />}
          {label.status === "done" && <SpecSummary spec={label.value} />}
          {label.status === "done" && unconfirmed && (
            <Confirm
              key={sentenceOf(label.value)}
              spec={label.value}
              onYes={() => goOn(label.value, unconfirmed)}
              onRewrite={(line) => {
                setHint(line);
                watch(line);
              }}
            />
          )}
        </Section>
      )}

      {label.status === "done" && spec && (
        <GroundChips
          spec={spec}
          busy={program.status === "running"}
          onSpec={(next) => {
            setSpec(next);
            compile(next, program.status === "done" ? program.value : undefined);
          }}
        />
      )}

      {fit && (
        <Section n={3} title="Fitted to the robot's bench">
          <p className="text-sm text-neutral-600">
            The SO-101 rehearses one manipulation, with the objects laid out in its reach and sized for its gripper, or a gesture, with the hand&apos;s path scaled into its reach.
          </p>
          <ul className="mt-2 list-disc pl-5 text-sm text-neutral-700">
            {fit.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Section>
      )}

      {program.status !== "idle" && spec && (
        <Section n={4} title="Questions from the robot" model={gestures ? "no model: the arm follows the traced path" : waiting ? "no model: one question first" : (program.status === "done" && programBy) || say("nano")}>
          <Status result={program} clock={clock.program} duration={duration} />
          {program.status === "done" && asks.length === 0 && <p className="text-sm text-emerald-700">No open questions: the program has everything it needs.</p>}
          {program.status === "done" && asks.length > 0 && turn < MAX_ROUNDS && (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                answer(asks);
              }}
            >
              {recordedLine(program.warnings) && Object.keys(answers).length > 0 && <p className="text-xs text-neutral-500">The answers given when this clip was recorded are filled in. Change one and {say("nano")} answers live.</p>}
              {asks.map((a) => (
                <AskField key={a.slot} ask={a} spec={spec} value={answers[a.slot] ?? ""} onChange={(v) => setAnswers({ ...answers, [a.slot]: v })} />
              ))}
              <div>
                <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">Answer and recompile</button>
              </div>
            </form>
          )}
          {notes.map((n) => (
            <p key={n} className="text-sm text-red-700">
              {n}
            </p>
          ))}
          {program.status === "done" && (
            <div className="mt-4 border-t pt-4">
              <ProgramView spec={spec} program={program.value} failure={failure} by={gestures || waiting ? "The page" : (programBy ?? say("nano"))} />
            </div>
          )}
          {program.status !== "running" && !waiting && (
            <button className="self-start text-xs text-neutral-500 underline" onClick={() => compile(spec, program.status === "done" ? program.value : undefined, true)}>
              Ask {say("nano")} again
            </button>
          )}
          {turn > 0 && <p className="text-xs text-neutral-500">{turn} answer{turn > 1 ? "s" : ""} so far; each one recompiles the program.</p>}
        </Section>
      )}

      {ready && program.status === "done" && (
        <Section n={5} title="Rehearse" model="MuJoCo WebAssembly · SO-101">
          {asks.length > 0 && <p className="text-sm text-amber-700">Some questions are still open: the rehearsal stops at the first one.</p>}
          <Rehearsal spec={spec} program={program.value} onFail={setFailure} hint={hint} onRehearse={() => (rehearsalAt.current = keeping())} onRun={kept ? (world, rollout) => keep("rehearsal", { world, program: program.value, rollout }, rehearsalAt.current) : undefined} />
        </Section>
      )}

      {ready && program.status === "done" && !spec.steps.some((s) => s.verb === "gesture") && (
        <Section n={6} title="Perturb the world" model="MuJoCo WebAssembly · headless batch">
          <Saboteur spec={spec} program={program.value} />
        </Section>
      )}

      {ready && program.status === "done" && <Reshoot spec={spec} program={program.value} />}

      {ready && program.status === "done" && !spec.steps.some((s) => s.verb === "gesture") && (
        <Section n={7} title="Try a similar task">
          <Variants spec={spec} program={program.value} />
        </Section>
      )}
    </div>
  );
}

/** What a session given for training keeps, and why (README.md and docs/LIMITATIONS.md say the same). */
function Privacy({ kept }: { kept?: string }) {
  return (
    <p className="mt-2 text-xs text-neutral-500">
      What is kept: for a clip of your own, and only with the box ticked, the small copy the model watches (480 pixels wide, 4 frames a second, no sound), the line you typed, the label, the task spec, your answers, every program, each rehearsal&apos;s result and each patch, under a random session id, with no name, account or address. It sits in a private store that only the Understudy team reads, to see where the models go wrong and to train models that do better. Without the box ticked nothing is kept, and the samples are never kept.
      {kept && (
        <>
          {" "}
          This session is kept as <span className="font-mono">{kept}</span>; to have it deleted, quote that id in an issue on{" "}
          <a className="underline" href="https://github.com/gibouu/understudy/issues">
            github.com/gibouu/understudy
          </a>
          .
        </>
      )}
    </p>
  );
}

function Section({ n, title, model, children }: { n: number; title: string; model?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border p-5">
      <header className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="flex items-baseline gap-3 font-medium">
          <span className="text-xs text-neutral-400">{n}</span>
          {title}
        </h2>
        {model && <span className="truncate text-xs text-neutral-500">{model}</span>}
      </header>
      {children}
    </section>
  );
}

function Status<T>({ result, clock, duration }: { result: StageResult<T>; clock: Clock; duration: number | null }) {
  if (result.status === "running") return <Working note={result.note ?? "working"} since={clock.at} usual={usual(clock.stage, duration)} />;
  if (result.status === "failed") return <p className="text-sm text-red-700">{result.message}</p>;
  const recorded = result.status === "done" ? recordedLine(result.warnings) : undefined;
  if (recorded) return <p className="mb-2 text-xs text-neutral-500">{recorded}</p>;
  if (result.status === "done" && result.warnings.some((w) => w.startsWith("replay"))) return <p className="mb-2 text-xs text-amber-700">{gateNote(result.warnings) ?? "replayed from a recording"}</p>;
  return null;
}

/** The question after the label (#158): the person says it is what they did, or rewrites it and the clip is watched again. */
function Confirm({ spec, onYes, onRewrite }: { spec: TaskSpec; onYes: () => void; onRewrite: (line: string) => void }) {
  const sentence = sentenceOf(spec);
  const offer = oneArmLine(spec);
  // the field holds at most LINE_MAX characters, so an untouched long sentence is its first LINE_MAX
  const shown = sentence.slice(0, LINE_MAX);
  const [line, setLine] = useState(shown);
  const rewritten = line.trim() !== "" && line.trim() !== shown.trim();
  return (
    <div className="mt-4 flex flex-col gap-3 border-t pt-4 text-sm" role="group" aria-label="Is this what the person did?">
      <p className="font-medium">Is this what the person did?</p>
      <p className="text-neutral-700">&ldquo;{sentence}&rdquo;</p>
      <div>
        <button className="rounded bg-neutral-900 px-3 py-1.5 text-white" onClick={onYes}>
          Yes, that&apos;s it
        </button>
      </div>
      {offer && (
        <p className="text-neutral-700">
          One arm could do this instead:{" "}
          <button className="rounded-full border px-3 py-0.5 hover:bg-neutral-50" onClick={() => setLine(offer)}>
            {offer}
          </button>
        </p>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (rewritten) onRewrite(line.trim());
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-neutral-600">If not, say what the person did in one line, and the model watches the clip again with it.</span>
          <input value={line} onChange={(e) => setLine(e.target.value)} maxLength={LINE_MAX} className="rounded border px-3 py-1.5" />
        </label>
        <div>
          <button className="rounded border px-3 py-1.5 disabled:opacity-40" disabled={!rewritten}>
            Watch again with my line
          </button>
        </div>
      </form>
    </div>
  );
}

function SpecSummary({ spec }: { spec: TaskSpec }) {
  const name = (id: string) => spec.objects.find((o) => o.id === id)?.name ?? id;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <p className="font-medium">{spec.title}</p>
        <p className="text-neutral-600">{spec.summary}</p>
      </div>
      {scopeNotes(spec).map((n) => (
        <p key={n} className="text-amber-700">
          {n}
        </p>
      ))}
      <ul className="flex flex-col gap-1">
        {spec.objects.map((o) => (
          <li key={o.id}>
            <span className="font-medium">{o.name}</span>{" "}
            <span className="text-neutral-500">
              {o.role}, {o.shape} {o.size_mm.join(" × ")} mm, confidence {o.confidence}
            </span>
          </li>
        ))}
      </ul>
      <ol className="flex flex-col gap-1">
        {spec.steps.map((s) => (
          <li key={s.id} className="font-mono text-xs text-neutral-700">
            {s.t_start_s.toFixed(0)}–{s.t_end_s.toFixed(0)} s · {s.verb}{s.object ? ` ${name(s.object)}` : ""}
            {s.target ? ` → ${s.target.fixture} of ${name(s.target.frame)}` : ""}
          </li>
        ))}
      </ol>
    </div>
  );
}

function AskField({ ask, spec, value, onChange }: { ask: Ask; spec: TaskSpec; value: string; onChange: (v: string) => void }) {
  const form = formFor(spec, ask.slot);
  // chips are buttons: inside a label, clicking the question would press the first one
  const Root = form.kind === "target" ? "div" : "label";
  return (
    <Root className="flex flex-col gap-1 text-sm" {...(form.kind === "target" ? { role: "group", "aria-label": ask.question } : {})}>
      <span>{ask.question}</span>
      {ask.why && <span className="text-xs text-neutral-500">{ask.why}</span>}
      {form.kind === "number" && (
        <span className="flex items-center gap-2">
          <input type="number" min={0} step="any" value={value} onChange={(e) => onChange(e.target.value)} className="w-28 rounded border px-2 py-1" />
          {form.unit}
        </span>
      )}
      {form.kind === "success" && (
        <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded border px-2 py-1">
          <option value="">choose…</option>
          {form.options.map((o, i) => (
            <option key={o.label} value={i}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {form.kind === "target" && (
        <span className="flex flex-wrap gap-2">
          {form.options.map((o, i) => (
            <button key={o.target.frame} type="button" aria-pressed={value === String(i)} onClick={() => onChange(String(i))} className={`rounded-full border px-3 py-1 ${value === String(i) ? "border-neutral-900 bg-neutral-900 text-white" : "hover:bg-neutral-50"}`}>
              {o.label}
            </button>
          ))}
        </span>
      )}
      {form.kind === "unsupported" && <span className="text-xs text-amber-700">This one can&apos;t be answered here yet ({ask.slot}).</span>}
    </Root>
  );
}
