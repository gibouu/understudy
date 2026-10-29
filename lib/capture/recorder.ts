/**
 * The camera take behind "Film yourself": a 3, 2, 1 countdown, an 8 s
 * recording, then the take to keep or redo. Pure: app/capture.tsx owns the
 * camera and the MediaRecorder and feeds their events into `step`.
 */
export const COUNTDOWN_S = 3;
export const TAKE_S = 8;

export type CaptureState =
  | { kind: "idle" }
  /** waiting for the browser's camera prompt */
  | { kind: "opening" }
  | { kind: "countdown"; left: number }
  | { kind: "recording"; left: number }
  /** `url` is the take's object URL, made by the caller, revoked when the review ends */
  | { kind: "review"; take: Blob; url: string }
  | { kind: "error"; message: string };

export type CaptureEvent =
  /** "Film yourself", "Retake" or "Try again" */
  | { type: "open" }
  /** the camera stream is live */
  | { type: "camera" }
  /** one second has passed */
  | { type: "tick" }
  /** the recorder stopped and handed over its data */
  | { type: "take"; take: Blob; url: string }
  | { type: "fail"; message: string }
  | { type: "close" };

export const EMPTY_TAKE = "The camera recorded nothing. Try again, or upload a clip.";

export function step(state: CaptureState, event: CaptureEvent): CaptureState {
  switch (event.type) {
    case "open":
      return state.kind === "idle" || state.kind === "review" || state.kind === "error" ? { kind: "opening" } : state;
    case "camera":
      return state.kind === "opening" ? { kind: "countdown", left: COUNTDOWN_S } : state;
    case "tick":
      if (state.kind === "countdown") return state.left > 1 ? { kind: "countdown", left: state.left - 1 } : { kind: "recording", left: TAKE_S };
      if (state.kind === "recording") return { kind: "recording", left: Math.max(0, state.left - 1) };
      return state;
    case "take":
      if (state.kind !== "recording") return state;
      return event.take.size > 0 ? { kind: "review", take: event.take, url: event.url } : { kind: "error", message: EMPTY_TAKE };
    case "fail":
      return state.kind === "idle" ? state : { kind: "error", message: event.message };
    case "close":
      return { kind: "idle" };
  }
}

/**
 * H.264 in MP4 when the browser records it (Safari, and Chrome since 126):
 * the player then knows the take's length, and it is about half the size of
 * Chrome's WebM. Otherwise undefined, the browser's own choice (WebM in
 * Firefox). makeProxy reads both; measured in headless Edge 155, 26 Oct 2026.
 */
export function recordingType(isTypeSupported: (type: string) => boolean): string | undefined {
  return ["video/mp4;codecs=avc1", "video/mp4"].find((type) => {
    try {
      return isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

/** Why this page cannot record at all, or null when it can. */
export function unsupported(env: { getUserMedia?: unknown; MediaRecorder?: unknown }): string | null {
  // getUserMedia is missing outside a secure context (plain http on another host) as well as in old browsers
  if (typeof env.getUserMedia !== "function") return "This browser does not give this page a camera. You can still upload a clip.";
  if (typeof env.MediaRecorder !== "function") return "This browser cannot record video. You can still upload a clip.";
  return null;
}

/** A plain sentence for a getUserMedia or MediaRecorder failure. */
export function cameraError(err: unknown): string {
  const name = err instanceof Error || (typeof err === "object" && err !== null && "name" in err) ? String((err as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "The camera was refused. Allow it in the browser's site settings to film yourself, or upload a clip.";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "No camera was found. You can still upload a clip.";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "The camera could not start; another app may be using it. You can still upload a clip.";
    default: {
      const detail = err instanceof Error && err.message ? err.message : name || String(err);
      return `The camera did not start (${detail}). You can still upload a clip.`;
    }
  }
}
