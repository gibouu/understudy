"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorldRun } from "@/lib/notes/note";
import { SimClient } from "@/lib/sim/client";
import type { Rollout } from "@/lib/sim/interpreter";
import { StageRenderer } from "@/lib/sim/render";
import { GRAVITIES, type GravityName, type Predicate, type Program, type TaskSpec } from "@/lib/spec/schema";
import { failed, idle, running, type LedgerEntry, type StageResult } from "@/lib/spec/stage-result";
import { costOf } from "@/lib/variants/cost";
import { MAX_VARIANTS, type NotYet } from "@/lib/variants/parse";
import { physicalKey, type Checked, type Edit, type Variant } from "@/lib/variants/validate";
import { PatchLoop } from "./patch-loop";

/** The same two worlds as the rehearsal above. */
const WORLDS: GravityName[] = ["earth", "orbit"];
const MAX_REQUEST_CHARS = 200;

type WorldResult = Rollout | { error: string } | "running";
/** `n` counts the variant's rehearsals, so each one gets a fresh patch loop. */
type Run = { n: number; compile: StageResult<Program>; worlds: Partial<Record<GravityName, WorldResult>>; ledger: LedgerEntry[] };
/** Every request this section made, for the running total; a failed one may have spent tokens it does not report. */
type Call = { what: string; ledger: LedgerEntry[]; replayed: boolean; failed: boolean };

async function post<T>(url: string, body: unknown): Promise<StageResult<T>> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as StageResult<T>;
  } catch (err) {
    return failed((err as Error).message);
  }
}

const replayed = (r: StageResult<unknown>) => r.status === "done" && r.warnings.some((w) => w.startsWith("replay"));
const callOf = (what: string, r: StageResult<unknown>): Call => ({
  what,
  ledger: (r as { ledger?: LedgerEntry[] }).ledger ?? [],
  replayed: replayed(r),
  failed: r.status === "failed",
});
const usd = (x: number) => `US$${x < 0.01 ? x.toFixed(4) : x.toFixed(3)}`;

/**
 * A variant that failed in some world for a reason a patch can reach (not an
 * unanswered question, not a crash), as the runs the patch loop starts from;
 * null when there is nothing to patch.
 */
export function patchable(run: Run | undefined): WorldRun[] | null {
  if (!run) return null;
  const runs = WORLDS.flatMap((world) => {
    const r = run.worlds[world];
    return r && r !== "running" && !("error" in r) ? [{ world, rollout: r }] : [];
  });
  if (runs.length !== WORLDS.length || runs.every((r) => r.rollout.pass)) return null;
  return runs.every((r) => r.rollout.pass || r.rollout.failure_class !== "spec_gap") ? runs : null;
}

const ids = new WeakMap<object, number>();
let lastId = 0;
const idOf = (o: object) => ids.get(o) ?? (ids.set(o, ++lastId), lastId);

/**
 * Below the rehearsal: Super suggests similar tasks as spec changes, or
 * writes one from a line the person types; each chosen one is compiled by
 * Nano (the program above as `previous`) and rehearsed on Earth and in
 * orbit on this section's own stage. The answers already given carry over.
 * A new spec or program above starts the section afresh.
 */
export function Variants({ spec, program }: { spec: TaskSpec; program: Program }) {
  return <VariantsFor key={`${idOf(spec)}:${idOf(program)}`} spec={spec} program={program} />;
}

function VariantsFor({ spec, program }: { spec: TaskSpec; program: Program }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<SimClient | null>(null);
  const [status, setStatus] = useState("starting");
  const [ready, setReady] = useState(false);
  const [suggest, setSuggest] = useState<StageResult<Checked>>(idle());
  const [ask, setAsk] = useState<StageResult<Checked>>(idle());
  const [request, setRequest] = useState("");
  const [offered, setOffered] = useState<{ variant: Variant; from: string }[]>([]);
  const [notYet, setNotYet] = useState<NotYet[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [calls, setCalls] = useState<Call[]>([]);
  const [busy, setBusy] = useState(false);
  const [patching, setPatching] = useState(false);
  const [showing, setShowing] = useState<string | null>(null);
  /** bumped when the section goes: replies and rollouts for it are dropped */
  const gen = useRef(0);
  /** the next variant number: each request reserves its range when it is sent, so two in flight never share one */
  const next = useRef(1);
  /** one rehearsal or patch loop at a time on the one stage, even on a double click */
  const rehearsing = useRef(false);
  const patchingRef = useRef(false);
  // stable: the patch loop stops itself when this changes
  const onPatchBusy = useCallback((b: boolean) => {
    patchingRef.current = b;
    setPatching(b);
  }, []);
  const offeredKeys = useRef(new Set<string>());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let alive = true; // Strict Mode disposes and re-runs this effect; the first client must stay silent
    const renderer = new StageRenderer(canvas);
    const client = new SimClient()
      .on("status", (message) => alive && setStatus(message))
      .on("error", (message) => alive && setStatus(`error: ${message}`))
      .on("loaded", (m) => renderer.setMeta(m))
      .on("frame", (frame) => renderer.update(frame));
    clientRef.current = client;
    // the stage opens on the task above; each variant loads its own world into it
    client
      .load({ spec })
      .then(() => alive && (setReady(true), setStatus("the task above")))
      .catch((err: Error) => alive && setStatus(`error: ${err.message}`));
    return () => {
      alive = false;
      client.dispose();
      renderer.dispose();
    };
  }, [spec]);

  // a reply or rollout still on its way when the section goes is dropped
  useEffect(
    () => () => {
      gen.current++;
    },
    [],
  );

  function reserve(n: number): number {
    const first = next.current;
    next.current += n;
    return first;
  }

  function receive(r: StageResult<Checked>, what: string, from: string) {
    setCalls((cs) => [...cs, callOf(what, r)]);
    if (r.status !== "done") return;
    // a later reply can repeat a variant already offered: the arm would do the same thing
    const fresh = r.value.variants.filter((v) => {
      const key = physicalKey(v.spec);
      if (offeredKeys.current.has(key)) return false;
      offeredKeys.current.add(key);
      return true;
    });
    setOffered((xs) => [...xs, ...fresh.map((variant) => ({ variant, from }))]);
    setChosen((c) => new Set([...c, ...fresh.map((v) => v.id)]));
    setNotYet((xs) => [...xs, ...r.value.not_yet]);
  }

  async function suggestVariants() {
    const id = gen.current;
    setSuggest(running("Super is thinking of similar tasks"));
    const r = await post<Checked>("/api/variants", { spec, first: reserve(MAX_VARIANTS) });
    if (id !== gen.current) return;
    setSuggest(r);
    receive(r, "Suggestions", "suggested");
  }

  async function describe() {
    const line = request.trim();
    if (!line) return;
    const id = gen.current;
    setAsk(running("Super is writing it as spec changes"));
    const r = await post<Checked>("/api/variants", { spec, request: line, first: reserve(1) });
    if (id !== gen.current) return;
    setAsk(r);
    receive(r, `“${line}”`, line);
  }

  /**
   * One rollout of `p` per world on this stage, each from the variant's start.
   * `show` puts each result on the card; otherwise a world that errors throws.
   * Null when the section went meanwhile.
   */
  async function runWorlds(v: Variant, p: Program, show: boolean, id: number): Promise<WorldRun[] | null> {
    const client = clientRef.current;
    if (!client) throw new Error("the simulator is not loaded");
    setShowing(v.id);
    await client.load({ spec: v.spec });
    const out: WorldRun[] = [];
    const put = (world: GravityName, result: WorldResult) => show && setRuns((rs) => ({ ...rs, [v.id]: { ...rs[v.id], worlds: { ...rs[v.id].worlds, [world]: result } } }));
    for (const world of WORLDS) {
      if (id !== gen.current) return null;
      // a rollout homes only the arm: put the objects back where the variant has them, too
      client.reset();
      client.setGravity(GRAVITIES[world]);
      put(world, "running");
      let result: WorldResult;
      try {
        result = await client.run(p, "sensed", "home");
      } catch (err) {
        result = { error: (err as Error).message };
      }
      if (id !== gen.current) return null;
      put(world, result);
      if (!("error" in result)) out.push({ world, rollout: result });
      else if (!show) throw new Error(result.error);
    }
    return out;
  }

  async function rehearse(list: Variant[]) {
    if (!clientRef.current || rehearsing.current || patchingRef.current) return;
    rehearsing.current = true;
    const id = gen.current;
    setBusy(true);
    for (const v of list) {
      const update = (run: Partial<Run>) =>
        setRuns((rs) => {
          const prev: Run | undefined = rs[v.id];
          return { ...rs, [v.id]: { ...(prev ?? { n: 0, compile: idle(), worlds: {}, ledger: [] }), ...run } };
        });
      setRuns((rs) => ({ ...rs, [v.id]: { n: (rs[v.id]?.n ?? 0) + 1, compile: running("Nano is writing its program"), worlds: {}, ledger: [] } }));
      const c = await post<Program>("/api/compile", { spec: v.spec, previous: program });
      if (id !== gen.current) return;
      update({ compile: c, ledger: callOf("", c).ledger });
      setCalls((cs) => [...cs, callOf(`${v.title}: program`, c)]);
      if (c.status !== "done") continue;
      try {
        if (!(await runWorlds(v, c.value, true, id))) return;
      } catch (err) {
        update({ worlds: { earth: { error: (err as Error).message } } });
      }
    }
    rehearsing.current = false;
    setBusy(false);
  }

  /** The patch loop's rehearsal of a patched program, on this stage. */
  const patchRehearsal = (v: Variant) => async (p: Program): Promise<WorldRun[]> => {
    const runs = await runWorlds(v, p, false, gen.current);
    if (!runs) throw new Error("the section was closed");
    return runs;
  };

  const total = costOf(calls.flatMap((c) => c.ledger));
  const failedCalls = calls.filter((c) => c.failed && c.ledger.length === 0).length;
  const anyReplayed = calls.some((c) => c.replayed);
  const picked = offered.filter((o) => chosen.has(o.variant.id)).map((o) => o.variant);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-[color:var(--muted,#737373)]">
        The same task with something changed: Super writes each one as changes to the spec above, Nano writes its program, and the arm rehearses it on Earth and in orbit. The answers given above carry over.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button className="rounded bg-[var(--ink,#171717)] px-3 py-1.5 text-sm text-[color:var(--paper,#fff)] disabled:opacity-40" disabled={suggest.status === "running" || busy} onClick={suggestVariants}>
          {offered.some((o) => o.from === "suggested") ? "Suggest more" : "Suggest similar tasks"}
        </button>
        <StatusLine result={suggest} />
      </div>

      <form
        className="flex flex-col gap-1 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          describe();
        }}
      >
        <span className="text-[color:var(--muted,#737373)]">Or describe a similar task in one line.</span>
        <span className="flex flex-wrap gap-2">
          <input value={request} onChange={(e) => setRequest(e.target.value)} maxLength={MAX_REQUEST_CHARS} className="min-w-0 flex-1 rounded border px-3 py-1.5" placeholder="e.g. put it on a higher shelf" />
          <button className="rounded border px-3 py-1.5 disabled:opacity-40" disabled={!request.trim() || ask.status === "running" || busy}>
            Write it as a variant
          </button>
        </span>
        <StatusLine result={ask} />
        {ask.status === "done" && ask.value.variants.length === 0 && (
          <p className="text-[color:var(--accent,#b45309)]">Not yet: {ask.value.not_yet[0]?.why || "the arm cannot do that yet"}.</p>
        )}
      </form>

      {offered.length > 0 && (
        <ul className="flex flex-col gap-3">
          {offered.map(({ variant: v, from }) => (
            <VariantCard
              key={v.id}
              base={spec}
              variant={v}
              from={from}
              run={runs[v.id]}
              showing={showing === v.id}
              checked={chosen.has(v.id)}
              disabled={busy || patching}
              onCheck={(on) => setChosen((c) => (on ? new Set([...c, v.id]) : new Set([...c].filter((x) => x !== v.id))))}
              onRehearse={() => rehearse([v])}
              patch={(() => {
                const run = runs[v.id];
                const first = patchable(run);
                if (!first || run.compile.status !== "done") return null;
                return <PatchLoop key={`${v.id}:${run.n}`} spec={v.spec} program={run.compile.value} first={first} rehearse={patchRehearsal(v)} onBusy={onPatchBusy} onPatch={(r) => setCalls((cs) => [...cs, callOf(`${v.title}: patch`, r)])} />;
              })()}
            />
          ))}
        </ul>
      )}

      {notYet.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-[color:var(--muted,#737373)]">Not yet, or does not fit the bench ({notYet.length})</summary>
          <ul className="mt-2 list-disc pl-5 text-[color:var(--muted,#737373)]">
            {notYet.map((n, i) => (
              <li key={`${n.idea}-${i}`}>
                <span className="text-[color:var(--ink,currentColor)]">{n.idea}</span>
                {n.why && `: ${n.why}`}
              </li>
            ))}
          </ul>
        </details>
      )}

      {offered.length > 0 && (
        <div>
          <button className="rounded bg-[var(--ink,#171717)] px-3 py-1.5 text-sm text-[color:var(--paper,#fff)] disabled:opacity-40" disabled={!ready || busy || patching || picked.length === 0} onClick={() => rehearse(picked)}>
            Rehearse the {picked.length} chosen on Earth, then in orbit
          </button>
        </div>
      )}

      <div className={`relative aspect-[4/3] w-full overflow-hidden rounded-xl border bg-[#f4f1ea] ${offered.length ? "" : "hidden"}`}>
        <canvas ref={canvasRef} className="h-full w-full" />
        <div className="pointer-events-none absolute left-3 top-3 rounded bg-white/80 px-2 py-1 text-xs text-neutral-700">
          {showing ? `${offered.find((o) => o.variant.id === showing)?.variant.title}: ${status}` : status}
        </div>
      </div>

      {calls.length > 0 && (
        <div className="rounded-lg border p-3 text-sm">
          <p>
            Model calls in this section so far: <span className="font-medium">{total.calls}</span>, <span className="font-medium">{usd(total.usd)}</span> at Token Factory list prices
            {total.unpriced > 0 && `, plus ${total.unpriced} with no list price`}
            {anyReplayed && " (replayed: the cost of the recorded calls)"}.
            {failedCalls > 0 && ` ${failedCalls} request${failedCalls === 1 ? "" : "s"} failed; a failed request does not report what its calls cost, so that is not counted.`}
          </p>
          <ul className="mt-1 text-xs text-[color:var(--muted,#737373)]">
            {calls.map((c, i) => (
              <li key={i}>
                {c.what}: {c.failed && c.ledger.length === 0 ? "failed, cost not reported" : `${c.ledger.length} call${c.ledger.length === 1 ? "" : "s"}, ${usd(costOf(c.ledger).usd)}${c.failed ? ", then failed" : ""}`}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-[color:var(--muted,#737373)]">
            Compared with a new demonstration of each task: filming it again, Super VL labelling the new clip, and the robot&apos;s questions asked and answered again. Here nothing is filmed or labelled again, and the answers above are reused.
          </p>
        </div>
      )}
    </div>
  );
}

function StatusLine({ result }: { result: StageResult<Checked> }) {
  if (result.status === "running") return <span className="animate-pulse text-sm text-[color:var(--muted,#737373)]">{result.note}…</span>;
  if (result.status === "failed") return <span className="text-sm text-red-700">{result.message}</span>;
  if (replayed(result)) return <span className="text-xs text-amber-700">replayed from a recording</span>;
  return null;
}

function VariantCard({ base, variant: v, from, run, showing, checked, disabled, onCheck, onRehearse, patch }: { base: TaskSpec; variant: Variant; from: string; run?: Run; showing: boolean; checked: boolean; disabled: boolean; onCheck: (on: boolean) => void; onRehearse: () => void; patch: React.ReactNode }) {
  const cost = run && run.ledger.length ? costOf(run.ledger) : null;
  return (
    <li className={`rounded-lg border p-3 text-sm ${showing ? "border-[color:var(--accent,#b45309)]" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={checked} disabled={disabled} onChange={(e) => onCheck(e.target.checked)} />
          <span>
            <span className="font-medium">{v.title}</span>
            {from !== "suggested" && <span className="text-xs text-[color:var(--muted,#737373)]"> · from “{from}”</span>}
            {v.summary && <span className="block text-[color:var(--muted,#737373)]">{v.summary}</span>}
          </span>
        </label>
        <button className="shrink-0 rounded border px-2 py-1 text-xs disabled:opacity-40" disabled={disabled} onClick={onRehearse}>
          Rehearse
        </button>
      </div>
      <ul className="mt-2 flex flex-col gap-0.5 pl-6 font-mono text-xs text-[color:var(--muted,#737373)]">
        {v.edits.map((e) => (
          <li key={e.path}>{describeEdit(base, e)}</li>
        ))}
      </ul>
      {v.warnings.map((w) => (
        <p key={w} className="pl-6 text-xs text-amber-700">
          {w}
        </p>
      ))}
      {run && (
        <div className="mt-2 pl-6">
          {run.compile.status === "running" && <p className="animate-pulse text-xs">{run.compile.note}…</p>}
          {run.compile.status === "failed" && <p className="text-xs text-red-700">{run.compile.message}</p>}
          {run.compile.status === "done" && (
            <table className="text-left text-xs">
              <tbody>
                {WORLDS.map((w) => (
                  <tr key={w} className="align-top">
                    <td className="py-0.5 pr-3">
                      {w} · {GRAVITIES[w]} g
                    </td>
                    <td className="py-0.5 pr-3 font-medium">
                      <Outcome result={run.worlds[w]} />
                    </td>
                    <td className="py-0.5 text-[color:var(--muted,#737373)]">{why(run.worlds[w])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {cost && (
            <p className="mt-1 text-xs text-[color:var(--muted,#737373)]">
              Its program: {cost.calls} Nano call{cost.calls === 1 ? "" : "s"}, {usd(cost.usd)}
              {replayed(run.compile) && " (recorded)"}
            </p>
          )}
          {patch}
        </div>
      )}
    </li>
  );
}

function Outcome({ result }: { result?: WorldResult }) {
  if (!result) return <span className="text-neutral-400">waiting</span>;
  if (result === "running") return <span className="animate-pulse">running…</span>;
  if ("error" in result) return <span className="text-red-700">error</span>;
  return result.pass ? <span className="text-emerald-700">pass</span> : <span className="text-red-700">fail{result.failed_step_id ? ` at ${result.failed_step_id}` : ""}</span>;
}

function why(result?: WorldResult): string {
  if (!result || result === "running") return "";
  if ("error" in result) return result.error;
  return result.pass ? `done in ${result.t.toFixed(1)} s` : (result.why ?? "");
}

/** One changed field in plain words: what it was, what it is in this variant. */
function describeEdit(spec: TaskSpec, e: Edit): string {
  const [, id, field] = e.path.match(/^\w+\[([^\]]+)\]\.(\w+)/) ?? [];
  const name = spec.objects.find((o) => o.id === id)?.name ?? spec.steps.find((s) => s.id === id)?.id ?? id;
  const show = (v: unknown): string => {
    if (v === undefined) return "not set";
    if (field === "size_mm" && Array.isArray(v)) return `${v.join(" × ")} mm`;
    if (field === "pose" && v && typeof v === "object") {
      const p = v as { xyz_mm: number[]; yaw_deg: number; frame: string };
      return `(${p.xyz_mm.map((x) => Math.round(x)).join(", ")}) mm${p.frame === "world" ? "" : ` in ${spec.objects.find((o) => o.id === p.frame)?.name ?? p.frame}`}${p.yaw_deg ? `, turned ${p.yaw_deg}°` : ""}`;
    }
    if (field === "pocket_clearance_mm") return `${v} mm`;
    if (field === "success" && Array.isArray(v)) return (v as Predicate[]).map((p) => p.kind).join(" + ") || "none";
    if (field === "target" && v && typeof v === "object") return (v as { fixture: string }).fixture;
    if (field === "tolerances" && v && typeof v === "object") return Object.entries(v).map(([k, x]) => `${k} ±${x}`).join(", ") || "none";
    return typeof v === "string" ? v : JSON.stringify(v);
  };
  return `${name} ${field.replace(/_mm$/, "").replace(/_/g, " ")}: ${show(e.before)} → ${show(e.after)}`;
}
