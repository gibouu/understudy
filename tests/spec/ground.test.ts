import { describe, expect, it } from "vitest";
import { applyChanges } from "@/lib/spec/apply";
import { candidatesOf, chipChange, chipEffect, chipsFrom, GroundFilter, groundQuery, groundSlots, sentencesOf, type Candidate, type Chip } from "@/lib/spec/ground";
import { TaskSpec } from "@/lib/spec/schema";

const spec = TaskSpec.parse({
  version: 1,
  title: "marker into rack",
  summary: "a capped marker goes into a pen rack",
  objects: [
    { id: "marker", name: "felt marker", shape: "cylinder", size_mm: [15, 15, 140], symmetry: "axial", role: "manipulated" },
    { id: "rack", name: "pen rack", shape: "box", size_mm: [120, 80, 40], symmetry: "none", role: "fixture" },
    { id: "mat", name: "blue desk mat", shape: "box", size_mm: [400, 300, 3], symmetry: "none", role: "surface" },
  ],
  steps: [
    { id: "s1", verb: "grasp", object: "marker", t_start_s: 0.8, t_end_s: 1.6 },
    { id: "s2", verb: "insert", object: "marker", target: { fixture: "pocket", frame: "rack" }, t_start_s: 1.6, t_end_s: 3.1 },
  ],
});

const page = (content: string, url = "https://example.org/a") => ({ url, title: "A page", content });

describe("groundQuery and groundSlots", () => {
  it("builds the query from the spec's title and the objects it acts on", () => {
    expect(groundQuery(spec)).toBe("marker into rack (felt marker, pen rack): precautions, preconditions and tolerances");
  });

  it("offers the tolerance axes of steps with a target and the clearance of a pocket fixture", () => {
    expect(groundSlots(spec)).toEqual([
      "steps[s2].tolerances.x_mm",
      "steps[s2].tolerances.y_mm",
      "steps[s2].tolerances.z_mm",
      "steps[s2].tolerances.yaw_deg",
      "steps[s2].tolerances.tilt_deg",
      "objects[rack].pocket_clearance_mm",
    ]);
  });
});

describe("sentencesOf", () => {
  it("strips markdown, splits sentences and drops fragments, questions and metadata", () => {
    const md = [
      "# Using a pen rack",
      "Title: Pen racks for the office desk and studio",
      "Always cap the [felt marker](https://x.org/m) before you push it into the rack, or the tip dries out.",
      "- Short item.",
      "Which rack is the best one for a large studio desk?",
      "Pen racks hold markers upright. They keep a desk tidy and help you find the right colour quickly. [...] Do not force a marker into a slot narrower than its barrel.",
    ].join("\n");
    expect(sentencesOf(md)).toEqual([
      "Always cap the felt marker before you push it into the rack, or the tip dries out.",
      "They keep a desk tidy and help you find the right colour quickly.",
      "Do not force a marker into a slot narrower than its barrel.",
    ]);
  });
});

describe("candidatesOf", () => {
  it("keeps only sentences that name the task and read as advice, the ones naming more first", () => {
    const got = candidatesOf(spec, [
      page(
        "Pen racks keep every felt marker in sight on a busy desk. " +
          "Weather today is sunny and you should go outside for a walk. " +
          "Insert each marker cap first so that the tip never touches the rack floor. " +
          "Make sure the pen rack slot is at least 2 mm wider than the felt marker barrel.",
      ),
    ]).map((c) => c.text);
    expect(got).toEqual([
      "Make sure the pen rack slot is at least 2 mm wider than the felt marker barrel.",
      "Insert each marker cap first so that the tip never touches the rack floor.",
    ]);
  });

  it("takes from each page in turn and drops repeats", () => {
    const a = page("You must cap the marker before it goes into the rack. Never drop a marker into the rack tip first.", "https://a.org");
    const b = page("You must cap the marker before it goes into the rack. Align the marker with the rack slot before you let go.", "https://b.org");
    expect(candidatesOf(spec, [a, b]).map((c) => c.url)).toEqual(["https://a.org", "https://a.org", "https://b.org"]);
  });
});

describe("chipsFrom", () => {
  const candidates: Candidate[] = [
    { text: "Never drop a marker into the rack tip first.", url: "https://a.org", title: "A" },
    { text: "Make sure the rack slot is at least 2 mm wider than the marker.", url: "https://b.org", title: "B" },
    { text: "Keep the rack within reach of the felt marker tray.", url: "https://c.org", title: "C" },
    { text: "Pen racks should be cleaned often.", url: "https://d.org", title: "D" },
  ];
  const slots = groundSlots(spec);
  const parse = (raw: unknown) => GroundFilter.parse(raw);

  it("turns labels keyed by sentence into verbatim chips and keeps a number the sentence states", () => {
    const { chips, warnings } = chipsFrom(
      candidates,
      parse({ labels: { "0": "hazard", "1": "Tolerance", "2": "none", "3": "none" }, numbers: [{ i: 1, slot: "objects[rack].pocket_clearance_mm", value: 2 }] }),
      slots,
    );
    expect(chips).toEqual([
      { text: candidates[0].text, url: "https://a.org", title: "A", kind: "hazard" },
      { text: candidates[1].text, url: "https://b.org", title: "B", kind: "tolerance", slot: "objects[rack].pocket_clearance_mm", value: 2 },
    ]);
    expect(warnings).toEqual([]);
  });

  it("leaves out numbers the sentence does not state, slots not offered, and tolerances with no number", () => {
    const { chips, warnings } = chipsFrom(
      candidates,
      parse({
        labels: { "0": "hazard", "1": "tolerance", "2": "tolerance" },
        numbers: [
          { i: 1, slot: "objects[rack].pocket_clearance_mm", value: 5 },
          { i: 1, slot: "objects[marker].size_mm", value: 2 },
          { i: 0, slot: "steps[s2].tolerances.x_mm", value: 2 },
        ],
      }),
      slots,
    );
    expect(chips.map((c) => [c.kind, c.slot])).toEqual([
      ["hazard", undefined],
      ["tolerance", undefined],
    ]);
    expect(warnings).toEqual([
      "nano: labelled 3 of 4 sentences",
      "nano: sentence 2 was labelled a tolerance but states no number",
      "nano: objects[rack].pocket_clearance_mm = 5 from sentence 1 left out",
      "nano: objects[marker].size_mm = 2 from sentence 1 left out",
      "nano: steps[s2].tolerances.x_mm = 2 from sentence 0 left out",
    ]);
  });

  it("reads an unknown label as none and keeps the labels when a number is malformed", () => {
    const f = parse({ labels: { "0": "warning", "3": "precondition" }, numbers: [{ i: 1, slot: "x", value: null }] });
    expect(f.numbers).toEqual([]);
    expect(chipsFrom(candidates, f, slots).chips.map((c) => c.url)).toEqual(["https://d.org"]);
  });
});

describe("chipChange", () => {
  const note: Chip = { text: "Never drop a marker into the rack tip first.", url: "https://a.org/x", title: "A", kind: "hazard" };
  const number: Chip = { text: "at least 2 mm wider", url: "https://b.org/y", title: "B", kind: "tolerance", slot: "objects[rack].pocket_clearance_mm", value: 2 };

  it("sets the slot a number fills, with its source", () => {
    const { spec: next, warnings } = applyChanges(spec, [chipChange(spec, number)]);
    expect(warnings).toEqual([]);
    expect(next.objects[1].pocket_clearance_mm).toBe(2);
    expect(next.objects[1].sources.pocket_clearance_mm).toBe("tavily:https://b.org/y");
    expect(chipEffect(spec, number)).toBe("sets the pen rack's pocket clearance to 2 mm");
  });

  it("appends a note to the spec's warnings, with its source", () => {
    const { spec: next, warnings } = applyChanges(spec, [chipChange(spec, note)]);
    expect(warnings).toEqual([]);
    expect(next.warnings).toEqual(["hazard: Never drop a marker into the rack tip first. (tavily:https://a.org/x)"]);
    expect(next.sources.warnings).toBe("tavily:https://a.org/x");
  });
});
