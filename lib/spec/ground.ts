/**
 * Grounding: what the web says a robot doing this task should watch out for.
 * The query is built from the spec, Tavily finds and extracts the pages, the
 * pages are cut into sentences here, only the sentences that name one of the
 * spec's objects or verbs are numbered for Nano, and Nano labels each one
 * (hazard, precondition, tolerance or none). Nano answers with labels, never
 * text, so every chip is a verbatim quote with the URL it came from.
 *
 * A chip the person accepts becomes one SpecChange with `source:
 * tavily:<url>`: the number it states for one of the slots a person could
 * answer (a tolerance, a pocket clearance) when it states one, otherwise a
 * note appended to the spec's warnings, which the compiler reads.
 */
import { z } from "zod";
import { parsePath } from "./apply";
import type { SpecChange, TaskSpec } from "./schema";

export const GROUND_KINDS = ["hazard", "precondition", "tolerance"] as const;
export type GroundKind = (typeof GROUND_KINDS)[number];

/** A sentence from one page, numbered by its place in the list Nano reads. */
export type Candidate = { text: string; url: string; title: string };

export type Chip = {
  text: string;
  url: string;
  title: string;
  kind: GroundKind;
  /** set only when the sentence states a number for this slot */
  slot?: string;
  value?: number;
};

export type Grounding = {
  query: string;
  /** the pages the sentences were read from */
  pages: { url: string; title: string }[];
  chips: Chip[];
};

export const MAX_CHIPS = 6;
const MAX_CANDIDATES = 16;
const MAX_PER_PAGE = 8;
/** Tolerance axes a sentence on the web can speak to; sensing noise and the clearance axis are the rehearsal's own. */
const GROUNDED_AXES = ["x_mm", "y_mm", "z_mm", "yaw_deg", "tilt_deg"] as const;
/** A grounded number past these is a misread unit, not a tolerance. */
const MAX_VALUE: Record<string, number> = { mm: 100, "°": 90 };

const unitOf = (slot: string) => (slot.endsWith("_mm") ? "mm" : slot.endsWith("_deg") ? "°" : "");
const nameOf = (spec: TaskSpec, id: string) => spec.objects.find((o) => o.id === id)?.name ?? id;

/** One query from the spec's title and the names of the objects the task acts on. */
export function groundQuery(spec: TaskSpec): string {
  const names = [...new Set(spec.objects.filter((o) => o.role === "manipulated" || o.role === "fixture").map((o) => o.name))];
  const q = `${spec.title}${names.length ? ` (${names.join(", ")})` : ""}: precautions, preconditions and tolerances`;
  return q.length > 380 ? q.slice(0, 380) : q;
}

/** The slots a grounded number may fill: a pocket's clearance and the tolerance bands of the steps that have a target. */
export function groundSlots(spec: TaskSpec): string[] {
  const slots: string[] = [];
  for (const s of spec.steps) {
    if (!s.target) continue;
    for (const axis of GROUNDED_AXES) slots.push(`steps[${s.id}].tolerances.${axis}`);
    const f = spec.objects.find((o) => o.id === s.target!.frame);
    if (s.target.fixture === "pocket" && f?.role === "fixture") slots.push(`objects[${f.id}].pocket_clearance_mm`);
  }
  return [...new Set(slots)];
}

/** The header lines some extracts start with. */
const METADATA = /^(?:Title|URL Source|Published Time|Markdown Content):/;

/** Past this a page is cut: a few sentences are all a chip needs, and parsing stays fast on hostile input. */
const MAX_PAGE_CHARS = 20_000;

/**
 * The text up to MAX_PAGE_CHARS, ending at the last paragraph end before the
 * cut, or nothing: a cut inside a paragraph could keep an instruction and
 * drop its "unless".
 */
function whole(text: string): string {
  if (text.length <= MAX_PAGE_CHARS) return text;
  const paragraph = text.slice(0, MAX_PAGE_CHARS).lastIndexOf("\n\n");
  return paragraph > 0 ? text.slice(0, paragraph) : "";
}

/** A sentence ends at . ! or ? before a capital or a digit, but not after a common abbreviation ("approx. 2 inches"). */
const SENTENCE_END = /(?<=[.!?])(?<!\b(?:[Aa]pprox|ca|e\.g|i\.e|etc|vs|[Ff]igs?|[Nn]os?|[Mm]in|[Mm]ax|[Dd]iam?|resp|cf|al|Dr|Mr|Mrs|Ms|St|Jr|Inc|Ltd|Co)\.)\s+(?=["“‘(]?[A-Z0-9])/;

/**
 * Markdown from an extract (or a search snippet) as plain statements of a
 * useful length. Every pattern is bounded, so the work is linear in the text.
 */
export function sentencesOf(markdown: string): string[] {
  const plain = whole(markdown)
    .replace(/!\[[^\]\n]{0,300}\]\([^)\s]{0,500}\)/g, " ")
    .replace(/\[([^\]\n]{0,300})\]\([^)\s]{0,500}\)/g, "$1")
    // a tag starts with a letter: "< 2 mm ... > 3 mm" is a comparison, not a tag
    .replace(/<\/?[a-zA-Z][^<>]{0,300}>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[\.\.\.\]/g, "\n\n");
  // a blank line ends a block; a heading or a metadata line is a block of its own; a list item or table row starts one
  const blocks: string[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.length) blocks.push(lines.join(" "));
    lines = [];
  };
  for (const raw of plain.split("\n")) {
    const line = raw.trim().replace(/^(?:>\s*)+/, ""); // a blockquote marker, only at the start of a line
    const alone = /^#/.test(line) || METADATA.test(line);
    if (!line || alone || /^(?:[-*+]\s|\d+[.)]\s|\|)/.test(line)) flush();
    if (line) lines.push(line);
    if (alone) flush();
  }
  flush();
  const out: string[] = [];
  for (const block of blocks) {
    const flat = block
      .replace(/^(?:#+|[-*+]|\d+[.)])\s+/, "")
      // emphasis and table pipes; ">" and "#" inside a sentence are text ("> 3 mm", "#2 pencil")
      .replace(/[*_`|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    for (const s of flat.split(SENTENCE_END)) {
      const t = s.trim();
      if (t.length < 40 || t.length > 300 || t.split(" ").length < 6 || !/[a-z]/.test(t)) continue;
      // a page's metadata, or a question, states nothing
      if (METADATA.test(t) || t.endsWith("?")) continue;
      out.push(t);
    }
  }
  return out;
}

/**
 * The language of advice, in any domain: an instruction, a warning, a
 * condition, a limit or a measurement. A sentence without any of it
 * describes rather than advises, and Nano (3B active, thinking off) labels
 * descriptions as hazards too readily to be left to judge them.
 */
const ADVICE =
  /\b(?:must|should|never|avoid|ensure|make sure|be sure|careful(?:ly)?|caution|warning|do not|don't|cannot|can't|before|until|only if|otherwise|so that|risk|damag\w*|tear\w*|break\w*|crack\w*|leak\w*|spill\w*|slip\w*|jam\w*|bend\w*|crush\w*|contaminat\w*|within|at least|at most|no more than|up to|maximum|minimum|toleran\w*|clearance|gap|required?|need(?:s|ed)? to|important|gently|firmly|align\w*|orient\w*)\b|\d\s?(?:(?:mm|cm|m|inch(?:es)?|deg(?:rees)?)\b|°)/i;

/** Words in object names that say nothing about which object it is. */
const NOT_A_NAME = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "one", "two", "top", "end", "set", "big", "new", "old",
  "small", "large", "red", "tan", "black", "white", "blue", "green", "yellow", "grey", "gray", "clear", "plastic", "metal", "round", "square",
]);

/**
 * The spec's names as patterns: each word of the names of the objects the task
 * acts on, and each step verb, matched with any ending ("pillows",
 * "insertion"). An object name counts twice a verb.
 */
export function specTerms(spec: TaskSpec): { re: RegExp; weight: number }[] {
  // names are split into [a-z] words and verbs come from an enum, so nothing needs escaping;
  // a stem keeps three letters at least, so "cups" and "move" stem to "cup" and "mov", "use" stays "use"
  const stem = (w: string) => {
    const s = w.replace(/(?:es|s|e)$/, "");
    return s.length >= 3 ? s : w;
  };
  const words = spec.objects
    .filter((o) => o.role === "manipulated" || o.role === "fixture")
    .flatMap((o) => o.name.toLowerCase().split(/[^a-z]+/))
    .filter((w) => w.length >= 3 && !NOT_A_NAME.has(w));
  const terms = [...new Set(words.map(stem))].map((w) => ({ re: new RegExp(`\\b${w}\\w*`, "i"), weight: 2 }));
  const verbs = [...new Set(spec.steps.map((s) => stem(s.verb)))].map((v) => ({ re: new RegExp(`\\b${v}\\w*`, "i"), weight: 1 }));
  return [...terms, ...verbs];
}

/**
 * The sentences that name one of the spec's objects or verbs and use the
 * language of advice, the ones that name more first, taken from each page in
 * turn, deduplicated and capped for Nano's prompt. Any other sentence never
 * reaches Nano.
 */
export function candidatesOf(spec: TaskSpec, pages: { url: string; title: string; content: string }[]): Candidate[] {
  const terms = specTerms(spec);
  const score = (text: string) => terms.reduce((n, t) => n + (t.re.test(text) ? t.weight : 0), 0);
  const per = pages.map((p) =>
    sentencesOf(p.content)
      .filter((text) => !p.title || !text.includes(p.title.replace(/^\(PDF\)\s*/, "")))
      .map((text) => ({ text, url: p.url, title: p.title, score: score(text) }))
      .filter((c) => c.score > 0 && ADVICE.test(c.text))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_PER_PAGE),
  );
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (let i = 0; out.length < MAX_CANDIDATES && per.some((list) => i < list.length); i++) {
    for (const list of per) {
      const c = list[i];
      if (!c || seen.has(c.text.toLowerCase())) continue;
      seen.add(c.text.toLowerCase());
      out.push({ text: c.text, url: c.url, title: c.title });
      if (out.length === MAX_CANDIDATES) break;
    }
  }
  return out;
}

export const GROUND_SYSTEM = `You read sentences found on the web about a task a robot arm will rehearse, and label each one with a single word. Return one compact JSON object only:
{"labels":{"<sentence number>":<label>, one entry for every sentence},"numbers":[{"i":<sentence number>,"slot":<slot>,"value":number}]}
Labels:
- hazard: it says what can go wrong with one of the task's objects or actions, or what to avoid while doing it
- precondition: it says what must be true before a step starts
- tolerance: it states a number with a unit for a size, gap, clearance or accuracy of one of the task's objects or actions
- none: anything else. Most sentences are none: a sentence that describes an object, says what it is for, how it was made or tested, or reports news is none.
"numbers" lists only the tolerance sentences whose number fills one of the listed slots, with value converted to the slot's unit; it is usually empty.
Examples, from other tasks.
Objects obj1 "AA cell", obj2 "battery holder"; steps s2 place obj1 into the pocket of obj2; slots objects[obj2].pocket_clearance_mm (mm).
0. Battery holders are used in remote controls and toys.
1. Check the polarity marks in the holder before inserting a cell.
2. Never force a cell into a holder: a dented cell can leak.
3. The spring contact leaves about 2 mm of play around a cell in its holder.
{"labels":{"0":"none","1":"precondition","2":"hazard","3":"tolerance"},"numbers":[{"i":3,"slot":"objects[obj2].pocket_clearance_mm","value":2}]}
Objects obj1 "test tube", obj2 "centrifuge rotor"; steps s2 insert obj1 into the pocket of obj2; slots steps[s2].tolerances.tilt_deg (°).
0. Our rotors are machined from a single block of aluminium.
1. Balance opposite tubes to within 0.1 g before the rotor spins.
2. Tubes tilted more than 12 degrees can crack at speed.
{"labels":{"0":"none","1":"precondition","2":"hazard"},"numbers":[]}`;

export function groundUser(spec: TaskSpec, candidates: Candidate[], slots: string[]): string {
  const objects = spec.objects.map((o) => `${o.id} "${o.name}"`).join(", ");
  const steps = spec.steps
    .map((s) => `${s.id} ${s.verb} ${s.object}${s.target ? ` into the ${s.target.fixture} of ${s.target.frame}` : ""}`)
    .join(", ");
  const units = slots.map((s) => `${s} (${unitOf(s)})`).join(", ");
  return [`Task: ${spec.title}. ${spec.summary}`, `Objects ${objects}; steps ${steps}; slots ${units || "none"}.`, ...candidates.map((c, i) => `${i}. ${c.text}`)].join("\n");
}

const Label = z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(["none", ...GROUND_KINDS]).catch("none"));
export const GroundFilter = z.object({
  /** keyed by sentence number, so a sentence Nano skips cannot shift the labels after it */
  labels: z.record(z.string(), Label).default({}),
  // a malformed entry (Nano writes null for a value it does not have) costs the numbers, never the labels
  numbers: z
    .array(z.object({ i: z.number().int().nonnegative(), slot: z.string(), value: z.number().finite() }))
    .default([])
    .catch([]),
});
export type GroundFilter = z.infer<typeof GroundFilter>;

/**
 * A number with its unit, whole. Before it: no digit or decimal mark, no
 * digit group ("1 000 mm" is not 0 mm), no fraction bar, power or minus even
 * with spaces ("1/2 mm", "1 / 2 mm", "−2 mm" are not 2 mm), and no exponent
 * ("1e2 mm"); a leading-dot decimal is read as one (".5 mm" is 0.5). After
 * the unit: no rate or power, even with spaces or in words ("2 mm/s",
 * "2 mm / s", "2 mm per second", "2 mm²").
 */
const QUANTITY = /(?<![\d.,])(?<!\d[\s  '’])(?<![/^\-–−]\s*)(?<!\d[eE][+-]?)(\d+(?:[.,]\d+)?|[.,]\d+)\s?(millimet(?:er|re)s?|mm|centimet(?:er|re)s?|cm|met(?:er|re)s?|m|inch(?:es)?|degrees?|deg|°)(?!\s*(?:[/²³^]|per\b)|[a-z\d])/gi;

/** Factor to the slot's unit for a unit written in a sentence, or undefined when they measure different things. */
function factor(written: string, unit: string): number | undefined {
  const u = written.toLowerCase();
  if (unit === "°") return u === "°" || u.startsWith("deg") ? 1 : undefined;
  if (unit !== "mm") return undefined;
  if (u === "mm" || u.startsWith("milli")) return 1;
  if (u === "cm" || u.startsWith("centi")) return 10;
  if (u === "m" || u.startsWith("met")) return 1000;
  if (u.startsWith("inch")) return 25.4;
  return undefined;
}

/** Whether `text` writes `value` in the slot's unit, as a number with a unit of the same kind ("2 mm", "0.2 cm", "5 degrees"). */
function states(text: string, value: number, unit: string): boolean {
  for (const m of text.matchAll(QUANTITY)) {
    const k = factor(m[2], unit);
    const n = Number(m[1].replace(",", "."));
    // equal up to floating point only ("0.3 cm" is 3 mm; "0.01 mm" is not 0)
    if (k !== undefined && Number.isFinite(n) && Math.abs(n * k - value) <= 1e-9 * Math.max(1, Math.abs(value))) return true;
  }
  return false;
}

/**
 * Nano's labels as chips, in the order Nano read the sentences, at most
 * MAX_CHIPS; a sentence with no label is none. A tolerance with no number
 * written in it is left out. A number fills a slot only when the slot was
 * offered, the sentence is one of the tolerance chips, the sentence writes
 * that number with a unit of the same kind, and the value is plausible for
 * the unit; otherwise the chip stays a note.
 */
export function chipsFrom(candidates: Candidate[], filter: GroundFilter, slots: string[]): { chips: Chip[]; warnings: string[] } {
  const warnings: string[] = [];
  const labelled = candidates.filter((_, i) => filter.labels[String(i)] !== undefined).length;
  if (labelled !== candidates.length) warnings.push(`nano: labelled ${labelled} of ${candidates.length} sentences`);
  const chips: Chip[] = [];
  const at = new Map<number, Chip>();
  candidates.forEach((c, i) => {
    const kind = filter.labels[String(i)] ?? "none";
    if (kind === "none" || chips.length === MAX_CHIPS) return;
    if (kind === "tolerance" && !/\d/.test(c.text)) {
      warnings.push(`nano: sentence ${i} was labelled a tolerance but states no number`);
      return;
    }
    const chip: Chip = { text: c.text, url: c.url, title: c.title, kind };
    chips.push(chip);
    at.set(i, chip);
  });
  const offered = new Set(slots);
  for (const n of filter.numbers) {
    const chip = at.get(n.i);
    const max = MAX_VALUE[unitOf(n.slot)];
    if (chip?.kind === "tolerance" && chip.slot === undefined && offered.has(n.slot) && n.value >= 0 && max !== undefined && n.value <= max && states(chip.text, n.value, unitOf(n.slot))) {
      Object.assign(chip, { slot: n.slot, value: n.value });
    } else warnings.push(`nano: ${n.slot} = ${n.value} from sentence ${n.i} left out`);
  }
  return { chips, warnings };
}

/** What accepting a chip changes in the spec, with its source. */
export function chipChange(spec: TaskSpec, chip: Chip): SpecChange {
  const source = `tavily:${chip.url}`;
  if (chip.slot !== undefined && chip.value !== undefined) return { path: chip.slot, value: chip.value, source };
  return { path: "warnings", value: [...spec.warnings, `${chip.kind}: ${chip.text} (${source})`], source };
}

/** The chip's effect in words, for the button next to it. */
export function chipEffect(spec: TaskSpec, chip: Chip): string {
  if (chip.slot === undefined || chip.value === undefined) return "adds it to the spec's warnings, which the compiler reads";
  const [list, id, field, sub] = parsePath(chip.slot);
  const what = list === "objects" ? `the ${nameOf(spec, id)}'s pocket clearance` : `step ${id}'s ${field === "tolerances" ? `${sub?.replace(/_(mm|deg)$/, "")} tolerance` : field}`;
  return `sets ${what} to ${chip.value} ${unitOf(chip.slot)}`;
}
