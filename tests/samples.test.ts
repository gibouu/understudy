import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SAMPLES } from "@/lib/samples";

const DIR = path.join(process.cwd(), "samples");
const README = readFileSync(path.join(DIR, "README.md"), "utf8");
const MAX_BYTES = 5_000_000;
const MAX_SECONDS = 40;
const WIDTH = 1280;
/** the label route keeps 200 characters of the hint */
const MAX_HINT = 200;

type Box = { type: string; body: number; end: number };

function boxes(buf: Buffer, start: number, end: number): Box[] {
  const out: Box[] = [];
  for (let pos = start; pos + 8 <= end; ) {
    let size = buf.readUInt32BE(pos);
    let body = pos + 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(pos + 8));
      body = pos + 16;
    } else if (size === 0) size = end - pos;
    if (size < body - pos || pos + size > end) break;
    out.push({ type: buf.toString("latin1", pos + 4, pos + 8), body, end: pos + size });
    pos += size;
  }
  return out;
}

/** The tracks of an MP4 read from its boxes: handler, sample entry, picture width, seconds. */
function tracks(file: string) {
  const buf = readFileSync(file);
  const down = (box: Box, ...path: string[]): Box | undefined =>
    path.reduce<Box | undefined>((b, type) => b && boxes(buf, b.body, b.end).find((c) => c.type === type), box);
  const moov = boxes(buf, 0, buf.length).find((b) => b.type === "moov");
  if (!moov) return [];
  return boxes(buf, moov.body, moov.end)
    .filter((b) => b.type === "trak")
    .map((trak) => {
      const mdia = down(trak, "mdia")!;
      const hdlr = down(mdia, "hdlr")!;
      const mdhd = down(mdia, "mdhd")!;
      const stsd = down(mdia, "minf", "stbl", "stsd")!;
      const entries = boxes(buf, stsd.body + 8, stsd.end);
      const entry = entries[0];
      const v1 = buf[mdhd.body] === 1;
      const timescale = buf.readUInt32BE(mdhd.body + (v1 ? 20 : 12));
      const ticks = v1 ? Number(buf.readBigUInt64BE(mdhd.body + 24)) : buf.readUInt32BE(mdhd.body + 16);
      return {
        handler: buf.toString("latin1", hdlr.body + 8, hdlr.body + 12),
        entries: buf.readUInt32BE(stsd.body + 4),
        entry: entry.type,
        width: buf.readUInt16BE(entry.body + 24),
        seconds: ticks / timescale,
      };
    });
}

describe("sample registry", () => {
  it("has unique names the sample route can serve and unique labels", () => {
    expect(new Set(SAMPLES.map((s) => s.name)).size).toBe(SAMPLES.length);
    expect(new Set(SAMPLES.map((s) => s.label)).size).toBe(SAMPLES.length);
    for (const s of SAMPLES) expect(s.name).toMatch(/^[\w-]+$/);
  });

  it.each(SAMPLES)("$name: one H.264 video track, 1280 wide, at most 40 s and 5 MB, no audio", ({ name }) => {
    const file = path.join(DIR, `${name}.mp4`);
    expect(statSync(file).size).toBeLessThanOrEqual(MAX_BYTES);
    const [video, ...rest] = tracks(file);
    expect(rest).toEqual([]);
    expect(video).toMatchObject({ handler: "vide", entries: 1, entry: "avc1", width: WIDTH });
    expect(video.seconds).toBeGreaterThan(0);
    expect(video.seconds).toBeLessThanOrEqual(MAX_SECONDS);
  });

  it.each(SAMPLES)("$name: one README row with a source, the seconds used, the ffmpeg line and a licence", ({ name }) => {
    const rows = README.split("\n").filter((l) => l.startsWith(`| \`${name}.mp4\` |`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("](https://");
    expect(rows[0]).toMatch(/seconds \d+(\.\d+)? to \d+(\.\d+)?/);
    expect(rows[0]).toContain("`ffmpeg ");
    expect(rows[0]).toContain("Public domain (work of NASA)");
  });

  it.each(SAMPLES)("$name: a hint the label route keeps whole", ({ hint }) => {
    expect(hint.length).toBeGreaterThan(0);
    expect(hint.length).toBeLessThanOrEqual(MAX_HINT);
  });

  it("registers every clip under samples/", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".mp4"));
    expect(files.sort()).toEqual(SAMPLES.map((s) => `${s.name}.mp4`).sort());
  });
});
