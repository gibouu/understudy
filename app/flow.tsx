"use client";

import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { SAMPLES, type Sample } from "@/lib/samples";
import { fitToBench, type Fit } from "@/lib/sim/fit";
import { formFor } from "@/lib/spec/answer";
import { applyChanges } from "@/lib/spec/apply";
import type { Predicate, Program, ProgramOp, SpecChange, TaskSpec } from "@/lib/spec/schema";
import { failed, idle, running, type StageResult } from "@/lib/spec/stage-result";
import { gateNote } from "@/lib/unlock/messages";
import { clipSha256, makeProxy } from "@/lib/vision/proxy";
import { FilmYourself, keepSampleToken, liveAuth, UnlockPrompt } from "./capture";
import { GroundChips } from "./ground-chips";
import { ProgramView, type Failure } from "./program-view";

const Rehearsal = dynamic(() => import("./rehearsal").then((m) => m.Rehearsal), {
  ssr: false,
  loading: () => <div className="aspect-[4/3] w-full animate-pulse rounded-xl border bg-neutral-100" />,
});
const Variants = dynamic(() => import("./variants").then((m) => m.Variants), { ssr: false });

/** Nano asks about one gap per compile; past this many rounds the page stops asking. */
const MAX_ROUNDS = 6;

type Ask = Extract<ProgramOp, { op: "ask" }>;
const asksOf = (p: Program): Ask[] => p.steps.flatMap((s) => s.ops).filter((op): op is Ask => op.op === "ask");

async function post<T>(url: string, body: unknown): Promise<StageResult<T>> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...liveAuth(), ...(body as object) }) });
    return (await res.json()) as StageResult<T>;
  } catch (err) {
    return failed((err as Error).message);
  }
}

export function Flow() {
  const [clip, setClip] = useState<{ blob: Blob; url: string } | null>(null);
  const [hint, setHint] = useState("");
  const [label, setLabel] = useState<StageResult<TaskSpec>>(idle());
  const [fit, setFit] = useState<Fit | null>(null);
  const [spec, setSpec] = useState<TaskSpec | null>(null);
  const [program, setProgram] = useState<StageResult<Program>>(idle());
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [turn, setTurn] = useState(0);
  const [notes, setNotes] = useState<string[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const pick = useRef(0);
  /** bumped by every reset: a reply that lands after a newer clip or run is dropped */
  const gen = useRef(0);

  function reset() {
    gen.current++;
    setLabel(idle());
    setFit(null);
    setSpec(null);
    setProgram(idle());
    setAnswers({});
    setTurn(0);
    setNotes([]);
    setFailure(null);
  }

  function choose(blob: Blob, nextHint: string) {
    pick.current++; // a sample still loading must not replace this clip
    setClip((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { blob, url: URL.createObjectURL(blob) };
    });
    setHint(nextHint);
    reset();
  }

  async function loadSample(s: Sample) {
    const id = ++pick.current;
    try {
      const r = await fetch(`/samples/${s.name}.mp4`);
      if (!r.ok) throw new Error(`the sample did not load (HTTP ${r.status})`);
      const blob = await r.blob();
      if (id === pick.current) choose(blob, s.hint);
    } catch (err) {
      if (id === pick.current) setLabel(failed((err as Error).message));
    }
  }

  async function compile(next: TaskSpec, previous?: Program) {
    const id = gen.current;
    setProgram(running("Nano is writing the robot's program"));
    setFailure(null);
    const r = await post<Program>("/api/compile", { spec: next, previous });
    if (id !== gen.current) return;
    setProgram(r);
    setAnswers({});
  }

  async function watch() {
    if (!clip) return;
    reset();
    const id = gen.current;
    setLabel(running("making a small copy of the clip in your browser"));
    // without a proxy the route can still answer from its recording of this clip
    const body = await makeProxy(clip.blob).catch(async () => ({ clip_sha256: await clipSha256(clip.blob) }));
    if (id !== gen.current) return;
    setLabel(running("Super VL is watching the clip"));
    const r = await post<TaskSpec>("/api/label", { ...body, hint });
    if (id !== gen.current) return;
    keepSampleToken((r as { sample_token?: string }).sample_token);
    setLabel(r);
    if (r.status !== "done") return;
    const f = fitToBench(r.value);
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
      const value: number | Predicate[] = form.kind === "success" ? form.options[Number(raw)].predicates : Number(raw);
      changes.push({ path: a.slot, value, source: `interview#${turn + 1}` });
    }
    if (changes.length === 0) return;
    const { spec: next, warnings } = applyChanges(spec, changes);
    setNotes(warnings);
    if (warnings.length) return;
    setSpec(next);
    setTurn(turn + 1);
    await compile(next, program.value);
  }

  const asks = program.status === "done" ? asksOf(program.value) : [];
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
          <label className="cursor-pointer rounded border border-dashed px-3 py-1.5 text-sm hover:bg-neutral-50">
            Upload an MP4
            <input
              type="file"
              accept="video/mp4"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) choose(file, "");
              }}
            />
          </label>
          <FilmYourself onClip={(take) => choose(take, "")} />
        </div>
        {clip && (
          <div className="mt-3 flex flex-col gap-3">
            <video src={clip.url} controls muted playsInline className="max-h-72 w-full rounded-lg bg-black object-contain" />
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-600">What is the person doing? One line helps the model name the objects.</span>
              <input value={hint} onChange={(e) => setHint(e.target.value)} maxLength={200} className="rounded border px-3 py-1.5" placeholder="e.g. putting a capped marker into a pen holder" />
            </label>
            <div>
              <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40" disabled={label.status === "running"} onClick={watch}>
                Watch the clip
              </button>
            </div>
          </div>
        )}
      </Section>

      {label.status !== "idle" && (
        <Section n={2} title="What the model saw" model="Nemotron 3.5 Super VL">
          <Status result={label} />
          {label.status === "failed" && <UnlockPrompt message={label.message} onUnlock={watch} />}
          {label.status === "done" && <SpecSummary spec={label.value} />}
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
            The SO-101 rehearses one manipulation, with the objects laid out in its reach and sized for its gripper.
          </p>
          <ul className="mt-2 list-disc pl-5 text-sm text-neutral-700">
            {fit.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Section>
      )}

      {program.status !== "idle" && spec && (
        <Section n={4} title="Questions from the robot" model="Nemotron 3 Nano">
          <Status result={program} />
          {program.status === "done" && asks.length === 0 && <p className="text-sm text-emerald-700">No open questions: the program has everything it needs.</p>}
          {program.status === "done" && asks.length > 0 && turn < MAX_ROUNDS && (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                answer(asks);
              }}
            >
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
              <ProgramView spec={spec} program={program.value} failure={failure} />
            </div>
          )}
          {program.status !== "running" && (
            <button className="self-start text-xs text-neutral-500 underline" onClick={() => compile(spec, program.status === "done" ? program.value : undefined)}>
              Ask Nano again
            </button>
          )}
          {turn > 0 && <p className="text-xs text-neutral-500">{turn} answer{turn > 1 ? "s" : ""} so far; each one recompiles the program.</p>}
        </Section>
      )}

      {ready && program.status === "done" && (
        <Section n={5} title="Rehearse" model="MuJoCo WebAssembly · SO-101">
          {asks.length > 0 && <p className="text-sm text-amber-700">Some questions are still open: the rehearsal stops at the first one.</p>}
          <Rehearsal spec={spec} program={program.value} onFail={setFailure} />
        </Section>
      )}

      {ready && program.status === "done" && (
        <Section n={6} title="Try a similar task" model="Nemotron 3 Super · Nemotron 3 Nano">
          <Variants spec={spec} program={program.value} />
        </Section>
      )}
    </div>
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

function Status<T>({ result }: { result: StageResult<T> }) {
  if (result.status === "running") return <p className="animate-pulse text-sm text-neutral-600">{result.note}…</p>;
  if (result.status === "failed") return <p className="text-sm text-red-700">{result.message}</p>;
  if (result.status === "done" && result.warnings.some((w) => w.startsWith("replay"))) return <p className="mb-2 text-xs text-amber-700">{gateNote(result.warnings) ?? "replayed from a recording"}</p>;
  return null;
}

function SpecSummary({ spec }: { spec: TaskSpec }) {
  const name = (id: string) => spec.objects.find((o) => o.id === id)?.name ?? id;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <p className="font-medium">{spec.title}</p>
        <p className="text-neutral-600">{spec.summary}</p>
      </div>
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
            {s.t_start_s.toFixed(0)}–{s.t_end_s.toFixed(0)} s · {s.verb} {name(s.object)}
            {s.target ? ` → ${s.target.fixture} of ${name(s.target.frame)}` : ""}
          </li>
        ))}
      </ol>
    </div>
  );
}

function AskField({ ask, spec, value, onChange }: { ask: Ask; spec: TaskSpec; value: string; onChange: (v: string) => void }) {
  const form = formFor(spec, ask.slot);
  return (
    <label className="flex flex-col gap-1 text-sm">
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
      {form.kind === "unsupported" && <span className="text-xs text-amber-700">This one can&apos;t be answered here yet ({ask.slot}).</span>}
    </label>
  );
}
