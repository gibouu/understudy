"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { SimClient } from "@/lib/sim/client";
import { DEMO_PROGRAMS, DEMO_SPEC, POUR_PROGRAMS, POUR_SPEC } from "@/lib/sim/demo-spec";
import type { Approach, IkResult } from "@/lib/sim/ik";
import type { Frame, SimMeta } from "@/lib/sim/protocol";
import { StageRenderer } from "@/lib/sim/render";
import { buildScene } from "@/lib/sim/scene";
import { SETTINGS } from "@/lib/sim/settings";
import { SO101_HOME, SO101_JOINT_NAMES, SO101_TIP_SITE } from "@/lib/sim/so101";
import { APPROACHES, GRAVITIES, type GravityName, type Program, type TaskSpec } from "@/lib/spec/schema";
import { SettingNote, SettingSwitch, type Shown } from "../setting-switch";

const Variants = dynamic(() => import("../variants").then((m) => m.Variants), { ssr: false });

const SCENE = buildScene(DEMO_SPEC);
/** the spec's moved object and the fixture it goes into: the page names neither */
const OBJECT = DEMO_SPEC.objects.find((o) => o.role === "manipulated")!;
const POCKET_STEP = DEMO_SPEC.steps.find((s) => s.target?.fixture === "pocket")!;
const BODY = SCENE.names[OBJECT.id];
/** the manual pick and place reuses the demo program's moves, so the wrist is squared the same way */
const [PICK, PLACE] = DEMO_PROGRAMS.hold_until_seated.steps;
const GRASP = PICK.ops.find((op) => op.op === "grasp")!;

type Jac = { nv: number; norm: number; rows: string[] } | null;
type Scene = "film" | "pour";
/** what the readout shows of the liquid: where it is, and what it costs a frame */
type LiquidReadout = { where: NonNullable<Frame["liquid"]>["where"]; step_ms: number; frames_s: number };

/** `?scene=pour` opens the pour; `?ml=64` fills its cup with that much (1,000 particles at 64 mL); `?setting=kitchen` draws a setting */
function fromUrl(): { scene: Scene; ml?: number; setting: Shown } {
  const q = new URLSearchParams(window.location.search);
  const ml = Number(q.get("ml"));
  const setting = SETTINGS.find((s) => s === q.get("setting")) ?? null;
  return { scene: q.get("scene") === "pour" ? "pour" : "film", ml: ml > 0 ? ml : undefined, setting };
}
const pourSpec = (ml?: number): TaskSpec =>
  ml ? { ...POUR_SPEC, objects: POUR_SPEC.objects.map((o) => (o.liquid_ml !== undefined ? { ...o, liquid_ml: ml } : o)) } : POUR_SPEC;
const nameOf = (spec: TaskSpec, id: string) => spec.objects.find((o) => o.id === id)?.name ?? id;
/** The pour spec as `program` tilts it (how far, how fast), so similar tasks start from the pour that ran. */
const asRun = (spec: TaskSpec, program: Program): TaskSpec => {
  const tilt = program.steps.flatMap((s) => s.ops).find((op) => op.op === "tilt" && op.deg > 0);
  if (tilt?.op !== "tilt") return spec;
  return { ...spec, steps: spec.steps.map((s) => (s.verb === "pour" && s.pour ? { ...s, pour: { ...s.pour, tilt_deg: tilt.deg, tilt_s: tilt.seconds } } : s)) };
};

/** Known targets: the first four reachable, the last three not. */
const PRESETS: [[number, number, number], Approach, string][] = [
  [[250, 0, 50], "top", "down, centre"],
  [[200, 100, 30], "top", "down, left"],
  [[300, 0, 100], "front", "front, level"],
  [[50, 250, 80], "side", "side, wrist rolled"],
  [[200, 0, 100], "top", "down, too high"],
  [[800, 0, 100], "top", "too far"],
  [[200, 200, 30], "front", "front, off-axis"],
];

export function StageView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<SimClient | null>(null);
  const rendererRef = useRef<StageRenderer | null>(null);
  const [status, setStatus] = useState<{ message: string; progress?: number }>({ message: "starting" });
  const [meta, setMeta] = useState<SimMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ctrl, setCtrl] = useState<number[]>(SO101_HOME);
  const [tip, setTip] = useState<[number, number, number] | null>(null);
  const [object, setObject] = useState<[number, number, number] | null>(null);
  const [simT, setSimT] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [jac, setJac] = useState<Jac>(null);
  const [gravity, setGravity] = useState<GravityName>("earth");
  /** the gravity picked, for a fresh load and a pour started right after the pick */
  const gravityRef = useRef<GravityName>("earth");
  const [target, setTarget] = useState<[number, number, number]>([250, 0, 50]);
  const [approach, setApproach] = useState<Approach>("top");
  const [ik, setIk] = useState<(IkResult & { asked: string }) | null>(null);
  const [attached, setAttached] = useState<string | null>(null);
  const [runNote, setRunNote] = useState<string | null>(null);
  const [scene, setScene] = useState<Scene>(() => fromUrl().scene);
  const [ml] = useState<number | undefined>(() => fromUrl().ml);
  const spec = useMemo(() => (scene === "pour" ? pourSpec(ml) : DEMO_SPEC), [scene, ml]);
  const [liquid, setLiquid] = useState<LiquidReadout | null>(null);
  const [setting, setSetting] = useState<Shown>(() => fromUrl().setting);
  const [seed, setSeed] = useState(1);
  const [busy, setBusy] = useState(false);
  /** the pour program last run from the start: similar tasks start from it */
  const [poured, setPoured] = useState<keyof typeof POUR_PROGRAMS | null>(null);
  /** one object per pour run, so the similar tasks below start afresh only when the pour changes */
  const ran = useMemo(() => (poured ? asRun(spec, POUR_PROGRAMS[poured]) : null), [spec, poured]);
  const frames = useRef<{ n: number; since: number; rate: number }>({ n: 0, since: 0, rate: 0 });
  const lastCtrl = useRef<number[]>(SO101_HOME);
  const lastUi = useRef(0);
  /** a left-button, primary-pointer press: right/middle buttons pan and a second finger pinches */
  const pressAt = useRef<[number, number] | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let alive = true; // Strict Mode disposes and re-runs this effect; the first client must stay silent
    const renderer = new StageRenderer(canvas);
    rendererRef.current = renderer;
    const client = new SimClient()
      .on("status", (message, progress) => setStatus({ message, progress }))
      .on("error", (message) => setError(message))
      .on("loaded", (m) => {
        setMeta(m);
        renderer.setMeta(m);
        if (m.liquid) {
          // close in on the liquid: the middle of the posed objects, seen from beyond them on the right
          const posed = spec.objects.flatMap((o) => (o.pose?.frame === "world" ? [o.pose.xyz_mm.map((v) => v / 1000)] : []));
          const c = [0, 1, 2].map((k) => posed.reduce((sum, p) => sum + p[k], 0) / Math.max(1, posed.length)) as [number, number, number];
          renderer.view(c, [c[0] + 0.3, c[1] - 0.3, c[2] + 0.2]);
        }
        client.setCtrl(SO101_HOME);
        client.setGravity(GRAVITIES[gravityRef.current]);
      })
      .on("frame", (frame: Frame) => {
        renderer.update(frame);
        lastCtrl.current = Array.from(frame.ctrl);
        const now = performance.now();
        // frames the worker delivers per second: 60 when it keeps real time with the liquid on board
        const f = frames.current;
        f.n++;
        if (now - f.since >= 1000) {
          f.rate = (1000 * f.n) / (now - f.since);
          f.n = 0;
          f.since = now;
        }
        if (now - lastUi.current > 100) {
          lastUi.current = now;
          setSimT(frame.t);
          setDropped(frame.dropped_s);
          const xyz = (list: { id: number; name: string }[] | undefined, xpos: Float64Array, name: string) => {
            const i = 3 * (list?.find((x) => x.name === name)?.id ?? -1);
            return i < 0 ? null : ([xpos[i], xpos[i + 1], xpos[i + 2]] as [number, number, number]);
          };
          setObject(xyz(client.meta?.geoms, frame.geomXpos, `${BODY}_geom`));
          setTip(xyz(client.meta?.sites, frame.siteXpos, SO101_TIP_SITE));
          setAttached(frame.attached);
          setLiquid(frame.liquid ? { where: frame.liquid.where, step_ms: frame.liquid.step_ms, frames_s: f.rate } : null);
        }
      });
    clientRef.current = client;
    setMeta(null);
    setRunNote(null);
    setLiquid(null);
    client.load({ spec }).catch((err: Error) => {
      if (alive) setError(err.message);
    });
    return () => {
      alive = false;
      client.dispose();
      renderer.dispose();
    };
  }, [spec]);

  // after the effect above, so a fresh renderer gets the setting too
  useEffect(() => rendererRef.current?.setSetting(setting, spec), [setting, spec]);

  const onSlider = (i: number, v: number) => {
    const next = [...ctrl];
    next[i] = v;
    setCtrl(next);
    clientRef.current?.setCtrl(next);
  };

  const wave = () => {
    const q0 = SO101_HOME;
    const wp = [0, 1, 2, 3, 4].map((k) => ({
      t: k * 1.5,
      q: q0.map((q, j) => (j === 0 ? 0.8 * Math.sin((k * Math.PI) / 2) : j === 1 ? q + 0.4 * Math.sin((k * Math.PI) / 2) : j === 5 ? (k % 2 ? 1.2 : 0.2) : q)),
    }));
    clientRef.current?.play(wp, true);
  };

  const checkJacobian = async () => {
    let r: Awaited<ReturnType<SimClient["jacobian"]>> | undefined;
    try {
      r = await clientRef.current?.jacobian(SO101_TIP_SITE);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    if (!r) return;
    let norm = 0;
    for (const v of r.jacp) norm += v * v;
    const rows = [0, 1, 2].map((row) =>
      Array.from(r.jacp.slice(row * r.nv, row * r.nv + r.nv))
        .map((v) => v.toFixed(3).padStart(7))
        .join(" "),
    );
    setJac({ nv: r.nv, norm: Math.sqrt(norm), rows });
  };

  /**
   * Always moves: on a miss the arm goes to the solver's closest pose and the readout says so. `fallback` also tries the
   * other approaches. `site` is what lands on the target (the tip, or the point between the pads); `via` goes first,
   * `gripper` replaces the current gripper angle.
   */
  const moveTo = async (
    to = target,
    from = approach,
    fallback = false,
    { site, via = [], gripper = ctrl[5] }: { site?: string; via?: [number, number, number][]; gripper?: number } = {},
  ) => {
    setTarget(to);
    const m = to.map((v) => v / 1000) as [number, number, number];
    rendererRef.current?.setTarget(m);
    const vias: number[][] = [];
    let r: IkResult | undefined;
    try {
      for (const p of via) {
        const v = await clientRef.current?.ik(p.map((x) => x / 1000) as [number, number, number], from, site);
        if (!v) return;
        vias.push([...v.q, gripper]);
      }
      for (const a of fallback ? [from, ...APPROACHES.filter((x) => x !== from)] : [from]) {
        const tried = await clientRef.current?.ik(m, a, site);
        if (!tried) return;
        if (!r || tried.ok || tried.pos_err_mm < r.pos_err_mm) [r, from] = [tried, a];
        if (tried.ok) break;
      }
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    if (!r) return;
    setApproach(from);
    setIk({ ...r, asked: `(${to.join(", ")}) mm ${from}` });
    const next = [...r.q, gripper];
    clientRef.current?.play([ctrl, ...vias, next].map((q, i) => ({ t: 1.5 * i, q })));
    setCtrl(next);
  };

  /** Run a program and report it; the sliders then follow where the program left the actuators. */
  const runProgram = async (label: string, program: Program, from: "home" | "here") => {
    setRunNote(`${label}: running`);
    try {
      const r = await clientRef.current?.run(program, "sensed", from);
      if (!r) return;
      setRunNote(`${label}: ${r.pass ? "pass" : `fail${r.failed_step_id ? ` at ${r.failed_step_id}` : ""}, ${r.why}`} (${r.t.toFixed(1)} s)`);
    } catch (err) {
      setRunNote(`${label}: ${(err as Error).message}`);
    }
    setCtrl(lastCtrl.current);
  };
  const one = (op: Program["steps"][number]["ops"][number]): Program => ({ spec_title: DEMO_SPEC.title, warnings: [], steps: [{ step_id: op.op, ops: [op] }] });

  /** A pour from the start: the scene reset (the liquid refilled with `seed`), then the program under the chosen gravity; the note says where the liquid went. */
  const runPour = async (name: keyof typeof POUR_PROGRAMS) => {
    const client = clientRef.current;
    if (!client || busy) return;
    setBusy(true);
    const g = gravityRef.current; // the latest pick, even one made in the same tick
    const label = `${name.replaceAll("_", " ")}, ${g} ${GRAVITIES[g]} g, seed ${seed}`;
    setRunNote(`${label}: running`);
    try {
      // reset and gravity ride in the run message: sent apart, a worker tick could fall between them and the start
      const r = await client.run(POUR_PROGRAMS[name], "sensed", "home", { reset: { seed }, gravityG: GRAVITIES[g] });
      const where = r.log.findLast((l) => l.includes(" liquid: "))?.split(" liquid: ")[1];
      setRunNote(`${label}: ${r.pass ? "pass" : `fail${r.failed_step_id ? ` at ${r.failed_step_id}` : ""}, ${r.why}`} (${r.t.toFixed(1)} s)${where ? `. Liquid: ${where}.` : ""}`);
      setPoured(name);
    } catch (err) {
      setRunNote(`${label}: ${(err as Error).message}`);
    }
    setCtrl(lastCtrl.current);
    setBusy(false);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl border bg-[#f4f1ea]">
        <canvas
          ref={canvasRef}
          className="h-full w-full"
          onPointerDown={(e) => (pressAt.current = e.button === 0 && e.isPrimary ? [e.clientX, e.clientY] : null)}
          onPointerUp={(e) => {
            // a click, not an orbit drag: move the tip above that floor point at the current height
            const start = pressAt.current;
            pressAt.current = null;
            if (!meta || !start || e.button !== 0 || Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 5) return;
            const p = rendererRef.current?.floorPoint(e.clientX, e.clientY);
            if (p) moveTo([Math.round(p[0] * 1000), Math.round(p[1] * 1000), target[2]], approach, true);
          }}
        />
        <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-col items-start gap-1 text-xs text-neutral-700">
          <div className="rounded bg-white/80 px-2 py-1">
            {error ? <span className="text-red-700">error: {error}</span> : status.message}
            {status.progress !== undefined && status.progress < 1 && (
              <span className="ml-2 text-neutral-500">{Math.round(status.progress * 100)}%</span>
            )}
          </div>
          <SettingNote shown={setting} />
        </div>
        {meta && (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-white/80 px-2 py-1 font-mono text-[11px] text-neutral-700">
            t={simT.toFixed(2)}s{dropped > 0 ? ` (dropped ${dropped.toFixed(1)}s)` : ""} · dof {meta.nq} · geoms {meta.ngeom} · {SO101_TIP_SITE}{" "}
            {tip ? `(${tip.map((v) => (v * 1000).toFixed(0)).join(", ")}) mm` : ""}
            {scene === "film" && object ? ` · ${OBJECT.name} (${object.map((v) => (v * 1000).toFixed(0)).join(", ")}) mm` : ""}
            {meta.liquid && liquid && (
              <div>
                liquid {meta.liquid.particles} particles of {(meta.liquid.spacing_m * 1000).toFixed(0)} mm ({meta.liquid.ml.toFixed(0)} mL) · step {liquid.step_ms.toFixed(1)} ms ·{" "}
                {liquid.frames_s.toFixed(0)} frames/s ·{" "}
                {Object.entries(liquid.where.containers)
                  .map(([id, v]) => `${(v * 100).toFixed(0)}% in the ${nameOf(spec, id)}`)
                  .join(", ")}
                {liquid.where.table > 0 ? `, ${(liquid.where.table * 100).toFixed(0)}% on the table` : ""}
                {liquid.where.elsewhere > 0 ? `, ${(liquid.where.elsewhere * 100).toFixed(0)}% ${GRAVITIES[gravity] > 0 ? "elsewhere" : "floating free"}` : ""}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 text-sm">
        <SettingSwitch shown={setting} onPick={setSetting} />
        <div className="flex flex-wrap items-center gap-2" aria-label="scene">
          <span className="text-xs text-neutral-500">scene</span>
          {(["film", "pour"] as const).map((x) => (
            <button key={x} className={`rounded border px-3 py-1 ${scene === x ? "bg-neutral-900 text-white" : ""}`} disabled={busy} onClick={() => setScene(x)}>
              {x === "film" ? "seed film into pillow" : "pour the cup into the bowl"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2" aria-label="gravity">
          <span className="text-xs text-neutral-500">gravity</span>
          {(Object.keys(GRAVITIES) as GravityName[]).map((name) => (
            <button
              key={name}
              className={`rounded border px-3 py-1 disabled:opacity-40 ${gravity === name ? "bg-neutral-900 text-white" : ""}`}
              disabled={busy} // a switch mid-pour would leave the result labelled with the gravity it started in
              onClick={() => { setGravity(name); gravityRef.current = name; clientRef.current?.setGravity(GRAVITIES[name]); }}
            >
              {name} {GRAVITIES[name]} g
            </button>
          ))}
          {scene === "film" && (
            <button className="rounded border border-orange-600 px-3 py-1 text-orange-700" onClick={() => clientRef.current?.nudge(BODY, [0.04, 0.03, 0.12])} disabled={!meta}>
              Nudge the {OBJECT.name}
            </button>
          )}
        </div>

        {scene === "pour" && (
          <div className="flex flex-col gap-2 rounded border p-2 text-xs" aria-label="pour">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-neutral-500">pour, from the start</span>
              {(Object.keys(POUR_PROGRAMS) as (keyof typeof POUR_PROGRAMS)[]).map((name) => (
                <button key={name} className="rounded border border-orange-600 px-3 py-1 text-orange-700 disabled:opacity-40" disabled={!meta || busy} onClick={() => runPour(name)}>
                  {name.replaceAll("_", " ")}
                </button>
              ))}
              <label className="flex items-center gap-1">
                seed
                <select className="rounded border px-1 py-0.5" value={seed} onChange={(e) => setSeed(Number(e.target.value))} aria-label="liquid seed">
                  {[1, 2, 3, 4, 5, 6].map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </label>
              <button className="rounded border px-3 py-1 disabled:opacity-40" disabled={!meta || busy} onClick={() => (clientRef.current?.reset(seed), setRunNote(null))}>
                Refill
              </button>
            </div>
            {meta?.liquid?.warnings.map((w) => (
              <p key={w} className="text-amber-700">
                {w}
              </p>
            ))}
            <p className="text-neutral-500">
              Pick the gravity first. The seed jitters the particles at the start. Measured with a cup on a hinge: in orbit a slow pour leaves the water in the cup (docs/MEASUREMENTS.md section 5), and turning it over in one second lands 90% of it in the target in 3 of 6 seeds (section 8). This arm, gripping the cup, lands 85 to 93% and reaches 90% in 1 of 6 seeds (run in Node; a run here can differ).
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button className="rounded border px-3 py-1" onClick={() => { setCtrl(SO101_HOME); clientRef.current?.setCtrl(SO101_HOME); }}>
            Home
          </button>
          <button className="rounded border px-3 py-1" onClick={wave}>
            Wave (loop)
          </button>
          <button className="rounded border px-3 py-1" onClick={() => clientRef.current?.stop()}>
            Stop
          </button>
          <button className="rounded border px-3 py-1" onClick={() => clientRef.current?.reset()}>
            Reset physics
          </button>
          <button className="rounded border px-3 py-1" onClick={checkJacobian} disabled={!meta}>
            Jacobian check
          </button>
        </div>

        <form
          className="flex flex-wrap items-center gap-2 text-xs"
          aria-label="move the tip"
          onSubmit={(e) => {
            e.preventDefault();
            moveTo();
          }}
        >
          <span className="text-neutral-500">move_to</span>
          {(["x", "y", "z"] as const).map((axis, i) => (
            <label key={axis} className="flex items-center gap-1 font-mono">
              {axis}
              <input
                type="number"
                step={5}
                className="w-16 rounded border px-1 py-0.5"
                value={target[i]}
                onChange={(e) => setTarget(target.map((v, k) => (k === i ? Number(e.target.value) : v)) as [number, number, number])}
              />
            </label>
          ))}
          <span className="text-neutral-500">mm</span>
          <select className="rounded border px-1 py-0.5" value={approach} onChange={(e) => setApproach(e.target.value as Approach)} aria-label="approach">
            {APPROACHES.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <button className="rounded border px-3 py-1" disabled={!meta}>
            Go
          </button>
        </form>
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-neutral-500">try</span>
          {PRESETS.map(([to, from, label]) => (
            <button key={label} className="rounded border px-2 py-0.5" disabled={!meta} onClick={() => moveTo(to, from)} title={`(${to.join(", ")}) mm ${from}`}>
              {label}
            </button>
          ))}
        </div>
        {scene === "film" && (
          <>
          <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="pick and place">
            <span className="text-neutral-500">pick and place (top)</span>
            <button
              className="rounded border border-orange-600 px-3 py-1 text-orange-700"
              disabled={!meta || !!attached}
              onClick={() => runProgram("go to", { ...one(GRASP), steps: [{ step_id: PICK.step_id, ops: PICK.ops.slice(0, PICK.ops.indexOf(GRASP)) }] }, "here")}
            >
              1. Go to the {OBJECT.name}
            </button>
            <button className="rounded border border-orange-600 px-3 py-1 text-orange-700" disabled={!meta || !!attached} onClick={() => runProgram("grasp", one(GRASP), "here")}>
              2. Grasp
            </button>
            <button
              className="rounded border border-orange-600 px-3 py-1 text-orange-700"
              disabled={!meta || !attached}
              onClick={() => runProgram("over the pocket", { ...one(GRASP), steps: [{ step_id: PLACE.step_id, ops: [PICK.ops.at(-1)!, PLACE.ops[0]] }] }, "here")}
            >
              3. Over the pocket
            </button>
            <button className="rounded border border-orange-600 px-3 py-1 text-orange-700" disabled={!meta} onClick={() => runProgram("release", one({ op: "release" }), "here")}>
              4. Release
            </button>
            <span className="font-mono text-neutral-600">{attached ? `holding ${attached}` : "empty"}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="run a program">
            <span className="text-neutral-500">run program</span>
            {(Object.keys(DEMO_PROGRAMS) as (keyof typeof DEMO_PROGRAMS)[]).map((name) => (
              <button key={name} className="rounded border px-3 py-1" disabled={!meta} onClick={() => runProgram(name, DEMO_PROGRAMS[name], "home")}>
                {name.replaceAll("_", " ")}
              </button>
            ))}
          </div>
          </>
        )}
        {runNote && <p className="font-mono text-[11px] text-neutral-700">{runNote}</p>}
        <p className="text-xs text-neutral-500">Or click the floor: the tip goes above that point at height z, switching approach if the chosen one cannot reach.</p>
        {ik && (
          <div className={`rounded border p-2 font-mono text-[11px] leading-5 ${ik.ok ? "bg-neutral-50" : "border-red-300 bg-red-50 text-red-800"}`}>
            {ik.asked}: {ik.ok ? "reached" : `${ik.failure_class}, closest pose shown`} · tip off by {ik.pos_err_mm.toFixed(1)} mm · axis off by {ik.axis_err_deg.toFixed(1)}°
            {ik.approach_deg > 0.05 && ` · approach projected ${ik.approach_deg.toFixed(1)}°`}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {SO101_JOINT_NAMES.map((name, i) => {
            const range = meta?.actuators[i]?.ctrlrange ?? [-3, 3];
            return (
              <label key={name} className="grid grid-cols-[110px_1fr_56px] items-center gap-2 text-xs">
                <span className="font-mono">{name}</span>
                <input
                  type="range"
                  min={range[0]}
                  max={range[1]}
                  step={0.01}
                  value={ctrl[i]}
                  onChange={(e) => onSlider(i, Number(e.target.value))}
                />
                <span className="text-right font-mono text-neutral-500">{ctrl[i].toFixed(2)}</span>
              </label>
            );
          })}
        </div>

        {jac && (
          <div className="rounded border bg-neutral-50 p-2 font-mono text-[11px] leading-5">
            <div>mj_jacSite({SO101_TIP_SITE}): 3×{jac.nv}, |J| = {jac.norm.toFixed(3)}</div>
            {jac.rows.map((r, i) => (
              <div key={i} className="whitespace-pre">{r}</div>
            ))}
          </div>
        )}

        <p className="text-xs text-neutral-500">
          SO-101 from MuJoCo Menagerie (Apache-2.0), MuJoCo 3.17 WebAssembly in a Web Worker,
          three.js on the main thread. Drag to orbit, scroll to zoom. The scene is built from a
          task spec.{" "}
          {scene === "film"
            ? `The ${OBJECT.name} is a free body, the ${POCKET_STEP.target!.frame} a fixture with a pocket. Nudge it on Earth and it falls back; nudge it in orbit and it keeps drifting.`
            : "The cup and the bowl are open boxes; the water is a position-based liquid (lib/sim/fluid.ts) stepped next to MuJoCo, its walls the cup's and the bowl's geoms, one way: the water does not load the arm."}
        </p>
      </div>

      {scene === "pour" && poured && ran && (
        <section className="flex flex-col gap-2 lg:col-span-2" aria-label="similar tasks">
          <h2 className="text-lg font-semibold tracking-tight">Try a similar task</h2>
          <Variants spec={ran} program={POUR_PROGRAMS[poured]} />
        </section>
      )}
    </div>
  );
}
