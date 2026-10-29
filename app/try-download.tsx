"use client";

import { useState } from "react";
import type { GroundingRecord } from "@/lib/export/grounding";
import { drawFrames } from "@/lib/export/render";
import { passingRuns, tryExport, type TryExportInput, type TryLog } from "@/lib/export/try";
import { createBrowserVideoEncoder } from "@/lib/export/video";
import type { Program, TaskSpec } from "@/lib/spec/schema";
import { usePassed } from "./passed";

type State = { paths: string[]; headline: string; bytes: number; noVideo?: string } | { error: string } | "building" | null;

/**
 * The download on Try it (issue #112): once the program, or a Notes patch of it, has passed on Earth and in orbit on
 * this page, its passing rollouts become a LeRobot v2.1 skeleton with the session next to it, built in the browser.
 * The video is drawn again from the simulator's frames and encoded with WebCodecs; a browser that cannot encode
 * H.264 or VP9 gets the zip without it, and the page says so.
 */
export function TryDownload({ clip, hint, label, labelWarnings, fit, spec, program: given, log, grounding }: Omit<TryExportInput, "program" | "video" | "log"> & { program: Program; log: TryLog; grounding: GroundingRecord | null; spec: TaskSpec }) {
  const program = usePassed(given);
  const [video, setVideo] = useState(true);
  const [state, setState] = useState<State>(null);
  const runs = program ? passingRuns(log, program) : [];

  async function build() {
    if (!program) return;
    setState("building");
    try {
      let encoder: Awaited<ReturnType<typeof createBrowserVideoEncoder>> | undefined;
      let noVideo: string | undefined;
      if (video) {
        try {
          encoder = await createBrowserVideoEncoder();
        } catch (err) {
          noVideo = (err as Error).message;
        }
      }
      const { zip, paths, quality } = await tryExport({ clip, hint, label, labelWarnings, fit, spec, program, log, grounding, video: encoder ? { encoder, draw: (meta, frames) => drawFrames(meta, frames) } : undefined });
      const url = URL.createObjectURL(new Blob([zip.slice().buffer], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `understudy-${clip.sample ? clip.name : "my-clip"}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setState({ paths, headline: quality.headline, bytes: zip.byteLength, noVideo });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  }

  if (!program || runs.length === 0) {
    return <p className="text-sm text-neutral-500">Rehearse the program above until it passes on Earth and in orbit: the dataset is built from the passing rollouts the stage plays on this page.</p>;
  }
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-neutral-700">
        {runs.length} passing rollout{runs.length === 1 ? "" : "s"} ({runs.map((r) => (r.world === "earth" ? "Earth, 1 g" : "orbit, 0 g")).join(" and ")}) of the program that passed, as LeRobot v2.1 episodes in the layout Isaac-GR00T N1.7 reads: the simulated arm&apos;s joint states and commands at 15 fps
        {video ? ", and an MP4 of each, drawn again in your browser from the simulator's state on the bare bench" : ""}. Next to them: the task spec, the program, your answers, every version of the program on this page, the model calls the routes reported{grounding ? ", the web lookup" : ""}, and where the clip comes from.
      </p>
      <p className="text-neutral-600">It is a format-valid skeleton of a scripted program in rigid-body simulation with a geometric grasp: not checked with GR00T&apos;s loader, and not training data. <span className="font-mono">QUALITY.md</span> in the zip says what each file holds.</p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={video} onChange={(e) => setVideo(e.target.checked)} disabled={state === "building"} />
        <span>With video (one MP4 per episode, a few seconds to draw and encode)</span>
      </label>
      <div>
        <button onClick={build} disabled={state === "building"} className="rounded bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-40">
          {state === "building" ? "Building…" : "Download the dataset (.zip)"}
        </button>
      </div>
      {state !== null && state !== "building" && "error" in state && <p className="text-red-700">The export failed: {state.error}</p>}
      {state !== null && state !== "building" && "paths" in state && (
        <div className="flex flex-col gap-2">
          <p className="font-medium">
            {state.headline}. {(state.bytes / 1e6).toFixed(1)} MB.
          </p>
          {state.noVideo && <p className="text-amber-700">No video in this zip: {state.noVideo}.</p>}
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
