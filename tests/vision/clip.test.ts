import { readFileSync } from "node:fs";
import path from "node:path";
// not exported by the package: reached by path, the same module instance mediabunny's index loads
import { canEncodeVideoMemo } from "../../node_modules/mediabunny/dist/modules/src/encode.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VIDEO_PROXY } from "@/lib/providers/tokenfactory";
import { makeProxy } from "@/lib/vision/proxy";
import { CLIP_ACCEPT, clipProblem, MAX_CLIP_BYTES, problemOf, readClip, type ClipFacts } from "@/lib/vision/clip";

// 2 s, 320 x 240, 15 fps ffmpeg test patterns in a QuickTime container, as an
// iPhone writes them: H.264 ("Most Compatible") and HEVC tagged hvc1 (the default).
const fixture = (name: string) => new Blob([readFileSync(path.join(process.cwd(), "tests", "fixtures", "clip", name))]);

/** WebCodecs as a browser would answer: Node has none, so each test says what decodes. */
function webcodecs(decodes: (codec: string) => boolean, encodesAvc = true) {
  canEncodeVideoMemo.clear(); // mediabunny remembers an encoder's answer; each test is another browser
  vi.stubGlobal("VideoDecoder", class { static isConfigSupported = async (c: { codec: string }) => ({ supported: decodes(c.codec), config: c }) });
  vi.stubGlobal("VideoEncoder", class { static isConfigSupported = async (c: { codec: string }) => ({ supported: encodesAvc && c.codec.startsWith("avc1"), config: c }) });
}
afterEach(() => vi.unstubAllGlobals());

const ok: ClipFacts = { bytes: 5_000_000, duration_s: 20, codec: "avc", video: "ok" };

describe("the upload's file filter", () => {
  const accepted = CLIP_ACCEPT.split(",");
  it("takes MP4 and QuickTime by type, and by extension for a .mov that arrives with no type (Windows, Firefox)", () => {
    for (const t of ["video/mp4", "video/quicktime", ".mp4", ".mov", ".m4v"]) expect(accepted).toContain(t);
  });
  it("is a plain comma list the input element reads", () => {
    for (const t of accepted) expect(t).toMatch(/^(\.[a-z0-9]+|[a-z]+\/[a-z0-9.+-]+)$/);
  });
});

describe("what a clip that cannot become the proxy is told", () => {
  it("nothing, when it decodes, encodes and fits", () => expect(problemOf(ok)).toBeNull());
  it("HEVC this browser cannot decode: says so and how to get H.264, or to film here", () => {
    const m = problemOf({ ...ok, codec: "hevc", video: "undecodable" })!;
    expect(m).toMatch(/cannot decode HEVC/);
    expect(m).toMatch(/Most Compatible/);
    expect(m).toMatch(/H\.264/);
    expect(m).toMatch(/film yourself here/);
  });
  it("another codec it cannot decode is named", () => expect(problemOf({ ...ok, codec: "av1", video: "undecodable" })).toMatch(/cannot decode AV1/));
  it("no video track", () => expect(problemOf({ ...ok, codec: null, video: "unknown" })).toMatch(/no video/));
  it("no H.264 encoder", () => expect(problemOf({ ...ok, video: "unencodable" })).toMatch(/cannot encode the small H\.264 copy/));
  it("too long for the proxy", () => expect(problemOf({ ...ok, duration_s: VIDEO_PROXY.maxSeconds + 5 })).toMatch(/at most 120 s/));
  it("too large to read, before the file is opened", async () => {
    const read = vi.fn();
    const big = { size: MAX_CLIP_BYTES + 1 } as Blob;
    expect(await clipProblem(big, read)).toMatch(/too large/);
    expect(read).not.toHaveBeenCalled();
  });
  it("a file that is not a video", async () => {
    expect(await clipProblem(new Blob([new Uint8Array(4096).fill(7)]))).toMatch(/not a video this page can read/);
  });
});

describe("an iPhone .MOV, as makeProxy's own conversion judges it (set up, not run)", () => {
  it("decodes but cannot encode the 480-wide H.264 copy: said before, not after", async () => {
    webcodecs(() => true, false);
    expect((await readClip(fixture("h264.mov"))).video).toBe("unencodable");
    expect(await clipProblem(fixture("h264.mov"))).toMatch(/cannot encode/);
  });

  it("H.264 in QuickTime: read, decoded, no problem", async () => {
    webcodecs(() => true);
    const f = await readClip(fixture("h264.mov"));
    expect(f.codec).toBe("avc");
    expect(Math.abs(f.duration_s - 2)).toBeLessThan(0.2);
    expect(f.video).toBe("ok");
    expect(await clipProblem(fixture("h264.mov"))).toBeNull();
  });

  it("HEVC in QuickTime, in a browser that decodes HEVC (Safari, Chrome on a Mac): no problem", async () => {
    webcodecs(() => true);
    expect((await readClip(fixture("hevc.mov"))).codec).toBe("hevc");
    expect(await clipProblem(fixture("hevc.mov"))).toBeNull();
  });

  it("HEVC in QuickTime, in a browser that does not: the page says why and what to do", async () => {
    webcodecs((codec) => !/^(hev1|hvc1)/.test(codec));
    const f = await readClip(fixture("hevc.mov"));
    expect(f).toMatchObject({ codec: "hevc", video: "undecodable" });
    expect(await clipProblem(fixture("hevc.mov"))).toMatch(/cannot decode HEVC.*Most Compatible/);
  });

  it("with no WebCodecs at all, nothing is said to decode", async () => {
    expect((await readClip(fixture("h264.mov"))).video).toBe("undecodable");
  });

  it("makeProxy refuses with the same sentence the page shows at upload", async () => {
    webcodecs((codec) => !/^(hev1|hvc1)/.test(codec));
    await expect(makeProxy(fixture("hevc.mov"))).rejects.toThrow(/cannot decode HEVC.*Most Compatible/);
  });

  it("a decoder that says yes, then fails on the frames: makeProxy says the same, not the decoder's bare error", async () => {
    webcodecs(() => true);
    const supported = (globalThis as unknown as { VideoDecoder: { isConfigSupported: unknown } }).VideoDecoder.isConfigSupported;
    vi.stubGlobal(
      "VideoDecoder",
      class {
        static isConfigSupported = supported;
        state = "unconfigured";
        decodeQueueSize = 0;
        private fail: (e: Error) => void;
        constructor(init: { error: (e: Error) => void }) {
          this.fail = init.error;
        }
        addEventListener() {}
        removeEventListener() {}
        configure() {
          this.state = "configured";
        }
        decode() {
          queueMicrotask(() => this.fail(new Error("Decoding error.")));
        }
        flush() {
          return Promise.reject(new Error("Decoding error."));
        }
        reset() {}
        close() {
          this.state = "closed";
        }
      },
    );
    await expect(makeProxy(fixture("hevc.mov"))).rejects.toThrow(/cannot decode HEVC.*Most Compatible/);
  });
});
