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

describe("sentencesOf on awkward input", () => {
  it("keeps a comparison written with < and >, which is not a tag", () => {
    expect(sentencesOf("When the clearance is < 2 mm the cap sticks; once it is > 3 mm the marker <b>wobbles</b> in the rack.")).toEqual([
      "When the clearance is < 2 mm the cap sticks; once it is > 3 mm the marker wobbles in the rack.",
    ]);
  });

  it("cuts a long page at a paragraph end, never between an instruction and its exception", () => {
    const filler = "Pen racks come in many colours and sizes for every desk. ".repeat(350);
    const page = `${filler}\n\nAlways push the marker in cap first\nunless the cap is loose.`;
    // the cut falls inside "unless …": the instruction alone would read as a rule
    expect(page.indexOf("unless")).toBeLessThan(20_000);
    expect(page.length).toBeGreaterThan(20_000);
    expect(sentencesOf(page).some((t) => t.startsWith("Always push"))).toBe(false);
  });

  it("drops a long page with no paragraph end before the cut", () => {
    expect(sentencesOf("Always push the marker into the rack cap first, unless the cap is loose. ".repeat(300))).toEqual([]);
  });

  it("does not end a sentence after a common abbreviation", () => {
    expect(sentencesOf("Push the marker in approx. 2 inches, unless the cap is loose.")).toEqual(["Push the marker in approx. 2 inches, unless the cap is loose."]);
  });

  it("stays linear on 120,000 unmatched brackets", () => {
    const started = performance.now();
    sentencesOf("[".repeat(120_000) + "](" + "(".repeat(120_000));
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("candidatesOf", () => {
  it("matches short object names", () => {
    const cup = TaskSpec.parse({
      ...spec,
      objects: [
        { id: "cup", name: "cup", shape: "cylinder", size_mm: [80, 80, 95], symmetry: "axial", role: "manipulated" },
        { id: "saucer", name: "saucer", shape: "cylinder", size_mm: [150, 150, 15], symmetry: "axial", role: "fixture" },
      ],
      steps: [{ id: "s2", verb: "place", object: "cup", target: { fixture: "zone", frame: "saucer" }, t_start_s: 0, t_end_s: 1 }],
    });
    expect(candidatesOf(cup, [page("Never tilt the cup when it is full of hot liquid.")]).map((c) => c.text)).toEqual(["Never tilt the cup when it is full of hot liquid."]);
  });

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

  it("fills a slot only from a number written with a unit of the same kind", () => {
    const sentences: Candidate[] = [
      { text: "Make sure the rack slot is at least 2 mm wider than the marker.", url: "https://a.org", title: "A" },
      { text: "Leave a gap of 0.3 cm and keep the marker within 5 degrees of upright.", url: "https://b.org", title: "B" },
    ];
    const run = (numbers: { i: number; slot: string; value: number }[]) =>
      chipsFrom(sentences, parse({ labels: { "0": "tolerance", "1": "tolerance" }, numbers }), slots).chips.map((c) => c.slot && `${c.slot}=${c.value}`);
    expect(run([{ i: 0, slot: "objects[rack].pocket_clearance_mm", value: 20 }])).toEqual([undefined, undefined]);
    expect(run([{ i: 0, slot: "steps[s2].tolerances.yaw_deg", value: 2 }])).toEqual([undefined, undefined]);
    expect(run([{ i: 1, slot: "objects[rack].pocket_clearance_mm", value: 3 }])).toEqual([undefined, "objects[rack].pocket_clearance_mm=3"]);
    expect(run([{ i: 1, slot: "steps[s2].tolerances.tilt_deg", value: 5 }])).toEqual([undefined, "steps[s2].tolerances.tilt_deg=5"]);
  });

  it("reads a number with its unit whole: no fractions, leading-dot decimals, rates or powers", () => {
    const one = (text: string, slot: string, value: number) =>
      chipsFrom([{ text, url: "https://a.org", title: "A" }], parse({ labels: { "0": "tolerance" }, numbers: [{ i: 0, slot, value }] }), slots).chips[0].slot !== undefined;
    const gap = "objects[rack].pocket_clearance_mm";
    expect(one("Keep a gap of .5 mm around the barrel of the marker.", gap, 5)).toBe(false);
    expect(one("Keep a gap of .5 mm around the barrel of the marker.", gap, 0.5)).toBe(true);
    expect(one("Keep a gap of 1/2 mm around the barrel of the marker.", gap, 2)).toBe(false);
    expect(one("Push the marker in at 2 mm/s or slower, never faster.", gap, 2)).toBe(false);
    expect(one("The slot face is 2 mm² larger than the barrel section.", gap, 2)).toBe(false);
    expect(one("Keep a gap of 1 / 2 mm around the barrel of the marker.", gap, 2)).toBe(false);
    expect(one("Push the marker in at 2 mm / s or slower, never faster.", gap, 2)).toBe(false);
    expect(one("Keep a gap of 1e2 mm around the barrel of the marker.", gap, 2)).toBe(false);
    expect(one("Keep a gap of 0.01 mm around the barrel of the marker.", gap, 0)).toBe(false);
    expect(one("Push the marker in at 2 mm per second or slower, never faster.", gap, 2)).toBe(false);
    expect(one("Keep the marker 1 000 mm from the edge of the rack at least.", gap, 0)).toBe(false);
    expect(one("Offset the marker by \u22122 mm from the centre of the slot.", gap, 2)).toBe(false);
    expect(one("Keep a gap of approx. 2 mm around the barrel of the marker.", gap, 2)).toBe(true);
    expect(one("Keep a gap of 0.3 cm around the barrel of the marker.", gap, 3)).toBe(true);
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
