"use client";

import { useEffect, useRef, useState } from "react";
import { SimClient } from "@/lib/sim/client";
import type { Frame, SimMeta } from "@/lib/sim/protocol";
import { StageRenderer } from "@/lib/sim/render";
import { SO101_HOME, SO101_JOINT_NAMES, SO101_TIP_SITE } from "@/lib/sim/so101";

type Jac = { nv: number; norm: number; rows: string[] } | null;

export function StageView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<SimClient | null>(null);
  const rendererRef = useRef<StageRenderer | null>(null);
  const [status, setStatus] = useState<{ message: string; progress?: number }>({ message: "starting" });
  const [meta, setMeta] = useState<SimMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ctrl, setCtrl] = useState<number[]>(SO101_HOME);
  const [tip, setTip] = useState<[number, number, number] | null>(null);
  const [simT, setSimT] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [jac, setJac] = useState<Jac>(null);
  const lastUi = useRef(0);

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
          const site = client.meta?.sites.find((s) => s.name === SO101_TIP_SITE);
          if (site) {
            const i = 3 * site.id;
            setTip([frame.siteXpos[i], frame.siteXpos[i + 1], frame.siteXpos[i + 2]]);
          }
        }
      });
    clientRef.current = client;
    client.load().catch((err: Error) => {
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

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl border bg-[#f4f1ea]">
        <canvas ref={canvasRef} className="h-full w-full" />
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
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 text-sm">
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
          three.js on the main thread. Drag to orbit, scroll to zoom.
        </p>
      </div>
    </div>
  );
}
