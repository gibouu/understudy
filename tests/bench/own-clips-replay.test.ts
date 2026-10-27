/**
 * The raw answers kept by tests/bench/own-clips.test.ts (#149), read again by
 * today's parsers, with no network: every first label Super VL gave for a
 * clip of someone's own, and every first program Nemotron 3.5 Lightning gave
 * for its fitted spec. Before #149, 10 of 16 labels and 2 of 64 programs did
 * not parse (docs/MEASUREMENTS.md section 14); a check problem the route asks
 * the model to fix is counted apart, since a second call recovers it. The
 * answers from the live run after the fix are read too.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fitToBench } from "@/lib/sim/fit";
import { tidyLabel } from "@/lib/spec/label";
import { normalizeProgram, resolveFixtureNames } from "@/lib/spec/normalize";
import { parseModelJson } from "@/lib/spec/parse";
import { Program, TaskSpec } from "@/lib/spec/schema";
import { lintProgram } from "@/lib/spec/validate";

const read = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), "bench", "results", name), "utf8"));
type Call = { content: string };
type Run = { clip: string; run: number; k?: number; label?: { calls: Call[] }; compile?: { calls: Call[] } };

const labels = read("own-clips-label-before.json").results as Run[];
const labelsAfter = read("own-clips-label-after.json").results as Run[];
const compiles = read("own-clips-compile-before.json").results as Run[];
const specs = read("own-clips-specs-before.json").specs as { clip: string; run: number; spec: unknown }[];
const specOf = (r: Run) => TaskSpec.parse(specs.find((s) => s.clip === r.clip && s.run === r.run)!.spec);
const seconds = (clip: string) => Number(/(\d+)s$/.exec(clip)![1]);

describe("own clips' first answers, read again", () => {
  const unparsed = (runs: Run[]) =>
    runs.flatMap((r) => {
      try {
        parseModelJson(r.label!.calls[0].content, TaskSpec, { normalize: (raw) => tidyLabel(raw, seconds(r.clip)) });
        return [];
      } catch (err) {
        return [`${r.clip} #${r.run}: ${(err as Error).message}`];
      }
    });

  it("every first label parses but one retract that names a destination, which is asked about", () => {
    expect(labels).toHaveLength(16);
    expect(unparsed(labels)).toEqual(["veggie-landscape-12s #2: schema validation failed: steps.6.object: only a gesture step has no object"]);
    expect(unparsed(labelsAfter)).toEqual([]);
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

/**
 * #150: every kept label, fitted. A label counts when the fit finds something to rehearse. The fit
 * on main took the first insert or place step and nothing else; now a move onto an object then a
 * release is read as a place, an insert of an object into itself no longer hides the place after
 * it, and either outranks a gesture beside it. "after150" and "final150" were labelled with a
 * place rule in the label prompt, which measured no gain and was not kept (section 15).
 */
describe("own clips' labels, fitted (#150)", () => {
  const labelOf = (r: Run) => parseModelJson(r.label!.calls.at(-1)!.content, TaskSpec, { normalize: (raw) => tidyLabel(raw, seconds(r.clip)) }).value;
  /** main's fit: the first insert or place step, onto another named object */
  const onMain = (spec: TaskSpec) => {
    const act = spec.steps.find((s) => (s.verb === "insert" || s.verb === "place") && s.target);
    const ids = new Set(spec.objects.map((o) => o.id));
    return Boolean(act && act.object && ids.has(act.object) && ids.has(act.target!.frame) && act.object !== act.target!.frame);
  };

  it.each([
    ["own-clips-label-before.json", 16, 13, 15],
    ["own-clips-label-after.json", 16, 11, 14],
    ["own-clips-label-main150.json", 24, 18, 20],
    ["own-clips-label-after150.json", 24, 20, 21],
    ["own-clips-label-final150.json", 24, 17, 19],
  ] as const)("%s: of %i, %i had something to rehearse on main, %i now", (file, of, main, now) => {
    const specs = (read(file).results as Run[]).map(labelOf);
    expect(specs).toHaveLength(of);
    expect(specs.filter(onMain)).toHaveLength(main);
    expect(specs.filter((s) => fitToBench(s).spec !== s)).toHaveLength(now);
  });
});
