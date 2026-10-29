import { describe, expect, it } from "vitest";
import { cameraError, COUNTDOWN_S, EMPTY_TAKE, recordingType, step, TAKE_S, unsupported, type CaptureEvent, type CaptureState } from "@/lib/capture/recorder";

const run = (events: CaptureEvent[], from: CaptureState = { kind: "idle" }) => events.reduce(step, from);
const ticks = (n: number): CaptureEvent[] => Array.from({ length: n }, () => ({ type: "tick" }));
const take = new Blob([new Uint8Array(1024)], { type: "video/webm" });

describe("the recorder's states", () => {
  it("goes idle, opening, countdown 3 2 1, recording 8 s, review", () => {
    expect(run([{ type: "open" }])).toEqual({ kind: "opening" });
    expect(run([{ type: "open" }, { type: "camera" }])).toEqual({ kind: "countdown", left: COUNTDOWN_S });
    const counted = [{ type: "open" }, { type: "camera" }, ...ticks(COUNTDOWN_S - 1)] as CaptureEvent[];
    expect(run(counted)).toEqual({ kind: "countdown", left: 1 });
    const recording = [...counted, ...ticks(1)];
    expect(run(recording)).toEqual({ kind: "recording", left: TAKE_S });
    expect(run([...recording, ...ticks(TAKE_S)])).toEqual({ kind: "recording", left: 0 });
    expect(run([...recording, ...ticks(TAKE_S + 3)])).toEqual({ kind: "recording", left: 0 });
    expect(run([...recording, ...ticks(TAKE_S), { type: "take", take, url: "blob:x" }])).toEqual({ kind: "review", take, url: "blob:x" });
  });

  it("is a 3 s countdown and an 8 s take", () => {
    expect([COUNTDOWN_S, TAKE_S]).toEqual([3, 8]);
  });

  it("turns an empty take into an error", () => {
    expect(step({ kind: "recording", left: 0 }, { type: "take", take: new Blob([]), url: "blob:x" })).toEqual({ kind: "error", message: EMPTY_TAKE });
  });

  it("retakes from review and tries again from an error, but ignores open mid-take", () => {
    expect(step({ kind: "review", take, url: "blob:x" }, { type: "open" })).toEqual({ kind: "opening" });
    expect(step({ kind: "error", message: "x" }, { type: "open" })).toEqual({ kind: "opening" });
    for (const s of [{ kind: "opening" }, { kind: "countdown", left: 2 }, { kind: "recording", left: 4 }] as CaptureState[]) expect(step(s, { type: "open" })).toBe(s);
  });

  it("fails from any active state, closes from any state, and stays idle on a late failure", () => {
    for (const s of [{ kind: "opening" }, { kind: "countdown", left: 2 }, { kind: "recording", left: 4 }, { kind: "review", take, url: "blob:x" }] as CaptureState[]) {
      expect(step(s, { type: "fail", message: "boom" })).toEqual({ kind: "error", message: "boom" });
      expect(step(s, { type: "close" })).toEqual({ kind: "idle" });
    }
    expect(step({ kind: "idle" }, { type: "fail", message: "boom" })).toEqual({ kind: "idle" });
  });

  it("ignores events that belong to another state", () => {
    const idle: CaptureState = { kind: "idle" };
    expect(step(idle, { type: "camera" })).toBe(idle);
    expect(step(idle, { type: "tick" })).toBe(idle);
    expect(step(idle, { type: "take", take, url: "blob:x" })).toBe(idle);
    const counting: CaptureState = { kind: "countdown", left: 2 };
    expect(step(counting, { type: "take", take, url: "blob:x" })).toBe(counting);
    const review: CaptureState = { kind: "review", take, url: "blob:x" };
    expect(step(review, { type: "tick" })).toBe(review);
  });
});

describe("the container a take is recorded in", () => {
  it("prefers H.264 in MP4, then any MP4, else leaves it to the browser", () => {
    expect(recordingType(() => true)).toBe("video/mp4;codecs=avc1");
    expect(recordingType((t) => t === "video/mp4")).toBe("video/mp4");
    expect(recordingType((t) => t.startsWith("video/webm"))).toBeUndefined();
    expect(
      recordingType(() => {
        throw new Error("old browser");
      }),
    ).toBeUndefined();
  });
});

describe("what the page says when it cannot film", () => {
  const fn = () => {};

  it("names a missing camera API and a missing MediaRecorder, and points to upload", () => {
    expect(unsupported({ getUserMedia: fn, MediaRecorder: fn })).toBeNull();
    expect(unsupported({ MediaRecorder: fn })).toMatch(/camera.*upload a clip/);
    expect(unsupported({ getUserMedia: fn })).toMatch(/cannot record video.*upload a clip/);
  });

  it("tells a refused camera from a missing or busy one", () => {
    const err = (name: string) => Object.assign(new Error("x"), { name });
    expect(cameraError(err("NotAllowedError"))).toMatch(/^The camera was refused/);
    expect(cameraError(new DOMException("denied", "NotAllowedError"))).toMatch(/^The camera was refused/);
    expect(cameraError(err("NotFoundError"))).toMatch(/^No camera was found/);
    expect(cameraError(err("NotReadableError"))).toMatch(/another app/);
    expect(cameraError(new Error("odd"))).toBe("The camera did not start (odd). You can still upload a clip.");
    for (const name of ["NotAllowedError", "NotFoundError", "NotReadableError", "Whatever"]) expect(cameraError(err(name))).toMatch(/upload a clip\.$/);
  });
});
