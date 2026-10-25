"use client";

import { useEffect, useRef, useState } from "react";
import { SimClient } from "@/lib/sim/client";
import { DEMO_SPEC } from "@/lib/sim/demo-spec";
import type { Approach, IkResult } from "@/lib/sim/ik";
import type { Frame, SimMeta } from "@/lib/sim/protocol";
import { StageRenderer } from "@/lib/sim/render";
import { buildScene } from "@/lib/sim/scene";
import { GRIPPER_OPEN, SO101_GRASP_SITE, SO101_HOME, SO101_JOINT_NAMES, SO101_TIP_SITE } from "@/lib/sim/so101";
import { APPROACHES, GRAVITIES, type GravityName } from "@/lib/spec/schema";

const SCENE = buildScene(DEMO_SPEC);
const TUBE = SCENE.names.tube;
const POCKET_SITE = `${SCENE.names.rack}_pocket`;
const TUBE_HALF_MM = DEMO_SPEC.objects.find((o) => o.id === "tube")!.size_mm[2] / 2;
/** grip 17 mm below the tube's top, so the jaws stay above the rack once the tube is seated */
const GRIP_BELOW_TOP_MM = 17;
/** a via point this far above a pick or place, so the jaws come down onto the tube instead of sweeping into it */
const CLEAR_MM = 35;

type Jac = { nv: number; norm: number; rows: string[] } | null;

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
  const [tube, setTube] = useState<[number, number, number] | null>(null);
  const [pocket, setPocket] = useState<[number, number, number] | null>(null);
  const [simT, setSimT] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [jac, setJac] = useState<Jac>(null);
  const [gravity, setGravity] = useState<GravityName>("earth");
  const [target, setTarget] = useState<[number, number, number]>([250, 0, 50]);
  const [approach, setApproach] = useState<Approach>("top");
  const [ik, setIk] = useState<(IkResult & { asked: string }) | null>(null);
  const [attached, setAttached] = useState<string | null>(null);
  const [graspNote, setGraspNote] = useState<string | null>(null);
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
        client.setCtrl(SO101_HOME);
      })
      .on("frame", (frame: Frame) => {
        renderer.update(frame);
        const now = performance.now();
        if (now - lastUi.current > 100) {
          lastUi.current = now;
          setSimT(frame.t);
          setDropped(frame.dropped_s);
          const xyz = (list: { id: number; name: string }[] | undefined, xpos: Float64Array, name: string) => {
            const i = 3 * (list?.find((x) => x.name === name)?.id ?? -1);
            return i < 0 ? null : ([xpos[i], xpos[i + 1], xpos[i + 2]] as [number, number, number]);
          };
          setTube(xyz(client.meta?.geoms, frame.geomXpos, `${TUBE}_geom`));
          setTip(xyz(client.meta?.sites, frame.siteXpos, SO101_TIP_SITE));
          setPocket(xyz(client.meta?.sites, frame.siteXpos, POCKET_SITE));
          setAttached(frame.attached);
        }
      });
    clientRef.current = client;
    client.load({ worldbody: SCENE.worldbody, graspable: SCENE.manipulated }).catch((err: Error) => {
      if (alive) setError(err.message);
    });
    return () => {
      alive = false;
      client.dispose();
      renderer.dispose();
    };
  }, []);

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

  const graspTube = async () => {
    setGraspNote(null);
    try {
      const r = await clientRef.current?.grasp(TUBE);
      if (!r) return;
      setCtrl((c) => c.map((v, i) => (i === 5 ? r.jaw : v)));
      setGraspNote(r.ok ? null : r.message ?? "missed");
    } catch (err) {
      setGraspNote((err as Error).message);
    }
  };

  const release = () => {
    clientRef.current?.release();
    setCtrl((c) => c.map((v, i) => (i === 5 ? GRIPPER_OPEN : v)));
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
        <div className="pointer-events-none absolute left-3 top-3 rounded bg-white/80 px-2 py-1 text-xs text-neutral-700">
          {error ? <span className="text-red-700">error: {error}</span> : status.message}
          {status.progress !== undefined && status.progress < 1 && (
            <span className="ml-2 text-neutral-500">{Math.round(status.progress * 100)}%</span>
          )}
        </div>
        {meta && (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-white/80 px-2 py-1 font-mono text-[11px] text-neutral-700">
            t={simT.toFixed(2)}s{dropped > 0 ? ` (dropped ${dropped.toFixed(1)}s)` : ""} · dof {meta.nq} · geoms {meta.ngeom} · {SO101_TIP_SITE}{" "}
            {tip ? `(${tip.map((v) => (v * 1000).toFixed(0)).join(", ")}) mm` : ""}
            {tube ? ` · tube (${tube.map((v) => (v * 1000).toFixed(0)).join(", ")}) mm` : ""}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2" aria-label="gravity">
          <span className="text-xs text-neutral-500">gravity</span>
          {(Object.keys(GRAVITIES) as GravityName[]).map((name) => (
            <button
              key={name}
              className={`rounded border px-3 py-1 ${gravity === name ? "bg-neutral-900 text-white" : ""}`}
              onClick={() => { setGravity(name); clientRef.current?.setGravity(GRAVITIES[name]); }}
            >
              {name} {GRAVITIES[name]} g
            </button>
          ))}
          <button className="rounded border border-orange-600 px-3 py-1 text-orange-700" onClick={() => clientRef.current?.nudge(TUBE, [0.04, 0.03, 0.12])} disabled={!meta}>
            Nudge the tube
          </button>
        </div>

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
        <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="pick and place">
          <span className="text-neutral-500">pick and place (top)</span>
          <button
            className="rounded border border-orange-600 px-3 py-1 text-orange-700"
            disabled={!meta || !tube || !!attached}
            onClick={() => {
              if (!tube) return;
              const [x, y, z] = tube.map((v) => Math.round(v * 1000));
              const grip: [number, number, number] = [x, y, z + TUBE_HALF_MM - GRIP_BELOW_TOP_MM];
              moveTo(grip, "top", false, { site: SO101_GRASP_SITE, via: [[x, y, grip[2] + CLEAR_MM]], gripper: GRIPPER_OPEN });
            }}
          >
            1. Go to the tube
          </button>
          <button className="rounded border border-orange-600 px-3 py-1 text-orange-700" disabled={!meta || !!attached} onClick={graspTube}>
            2. Grasp
          </button>
          <button
            className="rounded border border-orange-600 px-3 py-1 text-orange-700"
            disabled={!meta || !pocket || !tube}
            onClick={() => {
              if (!pocket || !tube) return;
              // the tube's bottom 2 mm above the opening; lift the tube straight up first
              const [x, y, z] = pocket.map((v) => Math.round(v * 1000));
              const over: [number, number, number] = [x, y, z + 2 + 2 * TUBE_HALF_MM - GRIP_BELOW_TOP_MM];
              const [tx, ty] = tube.map((v) => Math.round(v * 1000));
              moveTo(over, "top", false, { site: SO101_GRASP_SITE, via: [[tx, ty, over[2]]] });
            }}
          >
            3. Over the pocket
          </button>
          <button className="rounded border border-orange-600 px-3 py-1 text-orange-700" disabled={!meta} onClick={release}>
            4. Release
          </button>
          <span className="font-mono text-neutral-600">{attached ? `holding ${attached}` : "empty"}</span>
          {graspNote && <span className="text-red-700">{graspNote}</span>}
        </div>
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
          task spec: the tube is a free body, the rack a fixture with a pocket. Nudge the tube on
          Earth and it falls back; nudge it in orbit and it keeps drifting.
        </p>
      </div>
    </div>
  );
}
