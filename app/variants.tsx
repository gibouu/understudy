"use client";

import { useEffect, useRef, useState } from "react";
import { SimClient } from "@/lib/sim/client";
import type { Rollout } from "@/lib/sim/interpreter";
import { StageRenderer } from "@/lib/sim/render";
import { GRAVITIES, type GravityName, type Predicate, type Program, type TaskSpec } from "@/lib/spec/schema";
import { failed, idle, running, type LedgerEntry, type StageResult } from "@/lib/spec/stage-result";
import { costOf } from "@/lib/variants/cost";
import type { NotYet } from "@/lib/variants/parse";
import type { Checked, Edit, Variant } from "@/lib/variants/validate";

/** The same two worlds as the rehearsal above. */
const WORLDS: GravityName[] = ["earth", "orbit"];
const MAX_REQUEST_CHARS = 200;

type WorldResult = Rollout | { error: string } | "running";
type Run = { compile: StageResult<Program>; worlds: Partial<Record<GravityName, WorldResult>>; ledger: LedgerEntry[] };
/** Every model call this section made, for the running total. */
type Call = { what: string; ledger: LedgerEntry[]; replayed: boolean };

async function post<T>(url: string, body: unknown): Promise<StageResult<T>> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as StageResult<T>;
  } catch (err) {
    return failed((err as Error).message);
  }
}

const replayed = (r: StageResult<unknown>) => r.status === "done" && r.warnings.some((w) => w.startsWith("replay"));
const usd = (x: number) => `US$${x < 0.01 ? x.toFixed(4) : x.toFixed(3)}`;

/**
 * Hook for the patch loop (#28, `/api/notes`): a variant that failed in some
 * world for a reason a patch can reach (not an unanswered question, not a
 * crash), as the `{world, rollout}` runs `PatchLoop` takes. Not wired yet:
 * once `app/patch-loop.tsx` is on main, mount it under such a variant with
 * these runs and a `rehearse` that loads the variant's spec into this stage.
 */
export function patchable(run: Run | undefined): { world: GravityName; rollout: Rollout }[] | null {
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
  const [showing, setShowing] = useState<string | null>(null);
  /** bumped when the task above changes: replies for the old one are dropped */
  const gen = useRef(0);
  const next = useRef(1);

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

  function receive(r: StageResult<Checked>, what: string, from: string) {
    if (r.status !== "done") return;
    setCalls((cs) => [...cs, { what, ledger: r.ledger ?? [], replayed: replayed(r) }]);
    next.current += r.value.variants.length;
    setOffered((xs) => [...xs, ...r.value.variants.map((variant) => ({ variant, from }))]);
    setNotYet((xs) => [...xs, ...r.value.not_yet]);
    setChosen((c) => new Set([...c, ...r.value.variants.map((v) => v.id)]));
  }

  async function suggestVariants() {
    const id = gen.current;
    setSuggest(running("Super is thinking of similar tasks"));
    const r = await post<Checked>("/api/variants", { spec, first: next.current });
    if (id !== gen.current) return;
    setSuggest(r);
    receive(r, "Suggestions", "suggested");
  }

  async function describe() {
    const line = request.trim();
    if (!line) return;
    const id = gen.current;
    setAsk(running("Super is writing it as spec changes"));
    const r = await post<Checked>("/api/variants", { spec, request: line, first: next.current });
    if (id !== gen.current) return;
    setAsk(r);
    receive(r, `“${line}”`, line);
  }

  async function rehearse(list: Variant[]) {
    const client = clientRef.current;
    if (!client || busy) return;
    const id = gen.current;
    setBusy(true);
    for (const v of list) {
      const update = (run: Partial<Run>) =>
        setRuns((rs) => {
          const prev: Run | undefined = rs[v.id];
          return { ...rs, [v.id]: { ...(prev ?? { compile: idle(), worlds: {}, ledger: [] }), ...run } };
        });
      update({ compile: running("Nano is writing its program"), worlds: {}, ledger: [] });
      const c = await post<Program>("/api/compile", { spec: v.spec, previous: program });
      if (id !== gen.current) return;
      update({ compile: c, ledger: c.status === "done" ? (c.ledger ?? []) : [] });
      if (c.status === "done") setCalls((cs) => [...cs, { what: `${v.title}: program`, ledger: c.ledger ?? [], replayed: replayed(c) }]);
      if (c.status !== "done") continue;
      setShowing(v.id);
      try {
        await client.load({ spec: v.spec });
      } catch (err) {
        update({ worlds: { earth: { error: (err as Error).message } } });
        continue;
      }
      for (const world of WORLDS) {
        if (id !== gen.current) return;
        // a rollout homes only the arm: put the objects back where the variant has them, too
        client.reset();
        client.setGravity(GRAVITIES[world]);
        setRuns((rs) => ({ ...rs, [v.id]: { ...rs[v.id], worlds: { ...rs[v.id].worlds, [world]: "running" } } }));
        let result: WorldResult;
        try {
          result = await client.run(c.value, "sensed", "home");
        } catch (err) {
          result = { error: (err as Error).message };
        }
        if (id !== gen.current) return;
        setRuns((rs) => ({ ...rs, [v.id]: { ...rs[v.id], worlds: { ...rs[v.id].worlds, [world]: result } } }));
      }
    }
    setBusy(false);
  }

  const total = costOf(calls.flatMap((c) => c.ledger));
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
              disabled={busy}
              onCheck={(on) => setChosen((c) => (on ? new Set([...c, v.id]) : new Set([...c].filter((x) => x !== v.id))))}
              onRehearse={() => rehearse([v])}
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
          <button className="rounded bg-[var(--ink,#171717)] px-3 py-1.5 text-sm text-[color:var(--paper,#fff)] disabled:opacity-40" disabled={!ready || busy || picked.length === 0} onClick={() => rehearse(picked)}>
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
          </p>
          <ul className="mt-1 text-xs text-[color:var(--muted,#737373)]">
            {calls.map((c, i) => (
              <li key={i}>
                {c.what}: {c.ledger.length} call{c.ledger.length === 1 ? "" : "s"}, {usd(costOf(c.ledger).usd)}
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

function VariantCard({ base, variant: v, from, run, showing, checked, disabled, onCheck, onRehearse }: { base: TaskSpec; variant: Variant; from: string; run?: Run; showing: boolean; checked: boolean; disabled: boolean; onCheck: (on: boolean) => void; onRehearse: () => void }) {
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
