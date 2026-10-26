"use client";

/**
 * "Film yourself": the camera, a 3, 2, 1 countdown, an 8 s take, then Retake
 * or Use this clip, which hands the take to the flow like an upload. The take
 * stays in the browser; the flow sends only its 480-wide proxy to the model. Also
 * the unlock prompt for clips of your own (#35), asked once per tab.
 */
import { useEffect, useReducer, useRef, useState } from "react";
import { cameraError, COUNTDOWN_S, recordingType, step, TAKE_S, unsupported, type CaptureState } from "@/lib/capture/recorder";
import { isUnlockRefusal, UNLOCK_STORAGE_KEY, UNLOCK_WRONG } from "@/lib/unlock/messages";

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

function recorderFor(media: MediaStream): MediaRecorder {
  const options = { videoBitsPerSecond: 2_500_000 };
  const mimeType = typeof MediaRecorder.isTypeSupported === "function" ? recordingType((t) => MediaRecorder.isTypeSupported(t)) : undefined;
  if (mimeType) {
    try {
      return new MediaRecorder(media, { ...options, mimeType });
    } catch {
      // claimed but refused: fall back to the browser's own choice
    }
  }
  return new MediaRecorder(media, options);
}

export function FilmYourself({ onClip }: { onClip: (take: Blob) => void }) {
  const [state, dispatch] = useReducer(step, { kind: "idle" } as CaptureState);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const run = useRef<AbortController | null>(null);

  useEffect(() => () => run.current?.abort(), []);
  const reviewUrl = state.kind === "review" ? state.url : null;
  useEffect(() => (reviewUrl ? () => URL.revokeObjectURL(reviewUrl) : undefined), [reviewUrl]);

  async function shoot() {
    run.current?.abort();
    const ac = new AbortController();
    run.current = ac;
    dispatch({ type: "open" });
    const missing = unsupported({ getUserMedia: navigator.mediaDevices?.getUserMedia, MediaRecorder: globalThis.MediaRecorder });
    if (missing) return dispatch({ type: "fail", message: missing });

    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (err) {
      if (!ac.signal.aborted) dispatch({ type: "fail", message: cameraError(err) });
      return;
    }
    let recorder: MediaRecorder | undefined;
    try {
      if (ac.signal.aborted) return;
      setStream(media);
      dispatch({ type: "camera" });
      for (let i = 0; i < COUNTDOWN_S; i++) {
        await sleep(1000, ac.signal);
        dispatch({ type: "tick" });
      }
      const rec = recorderFor(media);
      recorder = rec;
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      const stopped = new Promise<void>((resolve, reject) => {
        rec.onstop = () => resolve();
        rec.onerror = (e) => reject((e as Event & { error?: Error }).error ?? new Error("the recorder failed"));
      });
      stopped.catch(() => {}); // an abort below leaves it unawaited
      rec.start(250);
      for (let i = 0; i < TAKE_S; i++) {
        await sleep(1000, ac.signal);
        dispatch({ type: "tick" });
      }
      rec.stop();
      await stopped;
      if (ac.signal.aborted) return;
      const take = new Blob(chunks, { type: rec.mimeType || chunks[0]?.type || "video/webm" });
      // an empty take becomes an error in `step`, so it gets no URL to leak
      dispatch({ type: "take", take, url: take.size > 0 ? URL.createObjectURL(take) : "" });
    } catch (err) {
      if (!ac.signal.aborted) dispatch({ type: "fail", message: cameraError(err) });
    } finally {
      if (recorder && recorder.state !== "inactive") recorder.stop();
      media.getTracks().forEach((t) => t.stop());
      // a run cancelled while its camera prompt was open must not blank a newer run's preview
      setStream((current) => (current === media ? null : current));
    }
  }

  function close() {
    run.current?.abort();
    dispatch({ type: "close" });
  }

  return (
    <>
      <button className="rounded border px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-40" disabled={state.kind !== "idle"} onClick={shoot}>
        Film yourself
      </button>
      {state.kind !== "idle" && (
        <div className="flex w-full flex-col gap-3 rounded-lg border p-3">
          <Take state={state} stream={stream} />
          <div className="flex flex-wrap items-center gap-2">
            {state.kind === "review" && (
              <>
                <button
                  className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
                  onClick={() => {
                    onClip(state.take);
                    dispatch({ type: "close" });
                  }}
                >
                  Use this clip
                </button>
                <button className="rounded border px-3 py-1.5 text-sm hover:bg-neutral-50" onClick={shoot}>
                  Retake
                </button>
              </>
            )}
            {state.kind === "error" && (
              <button className="rounded border px-3 py-1.5 text-sm hover:bg-neutral-50" onClick={shoot}>
                Try again
              </button>
            )}
            <button className="text-sm text-neutral-500 underline" onClick={close}>
              {state.kind === "review" || state.kind === "error" ? "Close" : "Cancel"}
            </button>
          </div>
          <p className="text-xs text-neutral-500">
            Your clip stays in this browser. Only a small copy, 480 pixels wide at 4 frames a second, goes to the model on Nebius Token Factory; this app keeps none of it.
          </p>
        </div>
      )}
    </>
  );
}

function Take({ state, stream }: { state: CaptureState; stream: MediaStream | null }) {
  const live = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (live.current) live.current.srcObject = stream;
  }, [stream]);

  if (state.kind === "error") return <p className="text-sm text-red-700">{state.message}</p>;
  if (state.kind === "review") return <video src={state.url} controls muted playsInline className="max-h-72 w-full rounded-lg bg-black object-contain" />;
  return (
    <div className="relative">
      <video ref={live} autoPlay muted playsInline className="aspect-video max-h-72 w-full rounded-lg bg-black object-contain" />
      <div className="absolute inset-0 flex items-center justify-center">
        {state.kind === "opening" && <span className="text-sm text-white/80">Asking for the camera…</span>}
        {state.kind === "countdown" && <span className="text-7xl font-semibold text-white drop-shadow">{state.left}</span>}
      </div>
      {state.kind === "recording" && (
        <span className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1 text-xs text-white">
          <span className="size-2 animate-pulse rounded-full bg-red-500" />
          Recording · {state.left} s left
        </span>
      )}
    </div>
  );
}

/** the code typed on this page; it wins over sessionStorage, which may hold an older one or refuse the write */
let typed: string | undefined;

/** The unlock code typed in this tab, sent with every label request: the latest typed here first, else the stored one. */
export function unlockCode(): string | undefined {
  if (typed) return typed;
  try {
    return sessionStorage.getItem(UNLOCK_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Under a refused label: asks for the code once, keeps it for the tab, and runs the label again. */
export function UnlockPrompt({ message, onUnlock }: { message: string; onUnlock: () => void }) {
  const [code, setCode] = useState("");
  if (!isUnlockRefusal(message)) return null;
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!code.trim()) return;
        typed = code.trim();
        try {
          sessionStorage.setItem(UNLOCK_STORAGE_KEY, typed);
        } catch {
          // storage blocked: `typed` still carries it for this page
        }
        onUnlock();
      }}
    >
      <input
        type="password"
        autoComplete="off"
        aria-label="Unlock code"
        placeholder={message === UNLOCK_WRONG ? "try the code again" : "unlock code"}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        className="rounded border px-3 py-1.5 text-sm"
      />
      <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">Unlock and watch</button>
    </form>
  );
}
