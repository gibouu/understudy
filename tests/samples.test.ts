import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SAMPLES } from "@/lib/samples";

const DIR = path.join(process.cwd(), "samples");
const README = readFileSync(path.join(DIR, "README.md"), "utf8");
const MAX_BYTES = 5 * 1024 * 1024;
/** the label route keeps 200 characters of the hint */
const MAX_HINT = 200;

function head(file: string, n: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, readSync(fd, buf, 0, n, 0));
  } finally {
    closeSync(fd);
  }
}

describe("sample registry", () => {
  it("has unique names the sample route can serve and unique labels", () => {
    expect(new Set(SAMPLES.map((s) => s.name)).size).toBe(SAMPLES.length);
    expect(new Set(SAMPLES.map((s) => s.label)).size).toBe(SAMPLES.length);
    for (const s of SAMPLES) expect(s.name).toMatch(/^[\w-]+$/);
  });

  it.each(SAMPLES)("$name: an H.264 file under 5 MB with a README row and a hint the label route keeps whole", ({ name, hint }) => {
    const file = path.join(DIR, `${name}.mp4`);
    expect(statSync(file).size).toBeLessThanOrEqual(MAX_BYTES);
    const start = head(file, 4096);
    expect(start.subarray(4, 8).toString("latin1")).toBe("ftyp");
    expect(start.includes("avc1")).toBe(true);
    expect(README).toContain(`\`${name}.mp4\``);
    expect(hint.length).toBeGreaterThan(0);
    expect(hint.length).toBeLessThanOrEqual(MAX_HINT);
  });

  it("registers every clip under samples/", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".mp4"));
    expect(files.sort()).toEqual(SAMPLES.map((s) => `${s.name}.mp4`).sort());
  });

  it("records a licence on every README row", () => {
    const rows = README.split("\n").filter((l) => /^\| `[\w-]+\.mp4` \|/.test(l));
    expect(rows.length).toBe(SAMPLES.length);
    for (const row of rows) expect(row).toContain("Public domain (work of NASA)");
  });
});
