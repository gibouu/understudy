/**
 * The raw answers kept by tests/bench/own-clips.test.ts (#149), read again by
 * today's parsers, with no network: every first label Super VL gave for a
 * clip of someone's own, and every first program Nemotron 3.5 Lightning gave
 * for its fitted spec. Before #149, 10 of 16 labels and 2 of 64 programs did
 * not parse (docs/MEASUREMENTS.md section 14); a check problem the route asks
 * the model to fix is counted apart, since a second call recovers it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tidyLabel } from "@/lib/spec/label";
import { normalizeProgram, resolveFixtureNames } from "@/lib/spec/normalize";
import { parseModelJson } from "@/lib/spec/parse";
import { Program, TaskSpec } from "@/lib/spec/schema";
import { lintProgram } from "@/lib/spec/validate";

const read = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), "bench", "results", name), "utf8"));
type Call = { content: string };
type Run = { clip: string; run: number; k?: number; label?: { calls: Call[] }; compile?: { calls: Call[] } };

const labels = read("own-clips-label-before.json").results as Run[];
const compiles = read("own-clips-compile-before.json").results as Run[];
const specs = read("own-clips-specs-before.json").specs as { clip: string; run: number; spec: unknown }[];
const specOf = (r: Run) => TaskSpec.parse(specs.find((s) => s.clip === r.clip && s.run === r.run)!.spec);
const seconds = (clip: string) => Number(/(\d+)s$/.exec(clip)![1]);

describe("own clips' first answers, read again", () => {
  it("every first label parses", () => {
    const failed = labels.flatMap((r) => {
      try {
        parseModelJson(r.label!.calls[0].content, TaskSpec, { normalize: (raw) => tidyLabel(raw, seconds(r.clip)) });
        return [];
      } catch (err) {
        return [`${r.clip} #${r.run}: ${(err as Error).message}`];
      }
    });
    expect(labels).toHaveLength(16);
    expect(failed).toEqual([]);
  });

  it("every first program parses; the ones the route asks to fix are the check's, not the parser's", () => {
    const firsts = [...labels.filter((r) => r.compile), ...compiles];
    const verdicts = firsts.map((r) => {
      const spec = specOf(r);
      try {
        const { value } = parseModelJson(r.compile!.calls[0].content, Program, { normalize: normalizeProgram });
        return lintProgram(resolveFixtureNames(value, spec).program, spec).length ? "check" : "ok";
      } catch (err) {
        return `parse: ${r.clip} #${r.run}.${r.k ?? "first"}: ${(err as Error).message}`;
      }
    });
    expect(firsts).toHaveLength(64);
    expect(verdicts.filter((v) => v.startsWith("parse"))).toEqual([]);
    expect(verdicts.filter((v) => v === "check")).toHaveLength(10);
  });
});
