/**
 * The reshoot list (issue #33, docs/SPEC.md stage 9). After the rehearsal, and
 * the patch loop if it ran, Nemotron 3 Ultra reads what the simulator measured
 * and sorts the failures into four classes, each with evidence from the run:
 * a spec gap (the spec is missing or wrong about something), a footage gap
 * (the clip does not show it well enough), an embodiment limit (the SO-101
 * cannot do it as written) and a simulator artefact (rigid-body physics or
 * the geometric grasp, not the task). It lists reshoot items, and only for
 * spec fields that came from the clip (the vision model, the pose tracker) or
 * from the person's answers: a default or a bench fit cannot be refilmed. And
 * it lists the open risks the rehearsal does not cover.
 *
 * The model's list is checked here, not trusted: a reshoot item for a field
 * the spec does not have, or for one that came from anywhere else, is dropped
 * and named in `dropped`.
 */
import { z } from "zod";
import { failureNote, opText, outcomeLine, type WorldRun } from "@/lib/notes/note";
import { canonicalSlot, parsePath } from "@/lib/spec/apply";
import { FAILURE_CLASSES, GRAVITIES, Predicate, Program, TaskSpec, Vec3mm } from "@/lib/spec/schema";

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const CLASS_LABELS: Record<FailureClass, string> = {
  spec_gap: "spec gap",
  footage_gap: "footage gap",
  embodiment_limit: "embodiment limit",
  simulator_artefact: "simulator artefact",
};

/** Ultra's output budget, reasoning included (issue #33). */
export const MAX_TOKENS = 16_000;
/**
 * Ultra thinks, because the call budget allows it: on the ISS sample (29 Oct 2026) one answer took
 * 2.7 s and $0.004 with thinking off; with it on, three answers took 11.0 s ($0.012, 3,431 completion
 * tokens, about 310 a second), 18.3 s ($0.017) and 4.4 s ($0.005, the recording in tests/fixtures/reshoot.json); on
 * /try after two patches, one took about 40 s ($0.026, 10,006 tokens). The page gives up at 90 s and
 * says so; it never waits longer.
 */
export const THINKING = true;
/** The page stops waiting after this; the route's own deadline is shorter. */
export const PAGE_WAIT_MS = 90_000;

/** Where a field came from, as a reshoot sees it: the clip, the person, or anything else (a default, the bench fit, the web, a hand edit). */
export type Origin = "video" | "interview" | "other";

export function originOf(source: string): Origin {
  if (/^(vl|pose)(#|$)/.test(source)) return "video";
  if (/^interview(#|$)/.test(source)) return "interview";
  return "other";
}

export type Field = { path: string; source: string; origin: Origin; value: string };

const OBJECT_FIELDS = ["name", "shape", "size_mm", "symmetry", "role", "pose", "pocket_clearance_mm", "liquid_ml"] as const;
const STEP_FIELDS = ["verb", "object", "target", "via_points", "preconditions", "success", "tolerances", "pour", "gesture", "t_start_s", "t_end_s"] as const;

const empty = (v: unknown) => v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

function shown(v: unknown): string {
  const text = JSON.stringify(v) ?? String(v);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/** The value at `parts` below `node`, through own properties only; undefined when any part does not resolve. */
function ownAt(node: unknown, parts: string[]): unknown {
  for (const k of parts) {
    if (FORBIDDEN.has(k) || node === null || typeof node !== "object" || !Object.hasOwn(node, k)) return undefined;
    node = (node as Record<string, unknown>)[k];
  }
  return node;
}

/**
 * Every filled field of the spec's objects and steps with its source: a field's own entry in `sources`, else its
 * record's `source`. Via-points carry a source each, so each is listed on its own, never the list as a whole.
 */
export function fieldsOf(spec: TaskSpec): Field[] {
  const out: Field[] = [];
  const top = (key: string) => (Object.hasOwn(spec.sources, key) ? spec.sources[key] : undefined);
  const add = (list: "objects" | "steps", i: number, rec: { id: string; source: string; sources: Record<string, string> } & Record<string, unknown>, names: readonly string[]) => {
    const at = `${list}[${rec.id}]`;
    const first = out.length;
    // the whole record or the whole list replaced (an answer, a hand edit) is recorded in the spec's own sources
    // under its id, its index or the list's name, perhaps several times over: any one from elsewhere wins
    const overrides = [top(`${list}.${rec.id}`), top(`${list}.${i}`), top(list)].filter((x): x is string => x !== undefined);
    const replaced = overrides.find((x) => originOf(x) === "other") ?? overrides[0];
    const sourceOf = (leaf: string) => (Object.hasOwn(rec.sources, leaf) ? rec.sources[leaf] : undefined);
    for (const name of names) {
      const value = rec[name];
      if (empty(value)) continue;
      if (name === "via_points") {
        (value as { source: string }[]).forEach((v, i) => {
          // a replaced list (an answer, a hand edit) speaks for every point in it, over the points' own sources
          const source = sourceOf(`via_points.${i}`) ?? sourceOf("via_points") ?? v.source;
          out.push({ path: `${at}.via_points.${i}`, source, origin: originOf(source), value: shown(v) });
        });
        continue;
      }
      const source = sourceOf(name) ?? replaced ?? rec.source;
      out.push({ path: `${at}.${name}`, source, origin: originOf(source), value: shown(value) });
    }
    // fields changed later (an answer, a hand edit) carry their own source, under a leaf path
    for (const [leaf, source] of Object.entries(rec.sources)) {
      if (out.some((f) => f.path === `${at}.${leaf}`)) continue;
      const value = ownAt(rec, leaf.split("."));
      if (value === undefined) continue;
      out.push({ path: `${at}.${leaf}`, source, origin: originOf(source), value: shown(value) });
    }
    // a record replaced from anywhere but the clip or an answer: nothing in it can be refilmed, whatever it says inside
    if (replaced !== undefined && originOf(replaced) === "other") for (let k = first; k < out.length; k++) out[k] = { ...out[k], source: replaced, origin: "other" };
  };
  spec.objects.forEach((o, i) => add("objects", i, o as never, OBJECT_FIELDS));
  spec.steps.forEach((s, i) => add("steps", i, s as never, STEP_FIELDS));
  return out;
}

/**
 * The field a path names, with the source of the deepest listed field it lies in (`pose.xyz_mm` takes `pose`'s),
 * and only when the whole path exists in the spec. A part below the path that came from anywhere else (a default
 * via-point inside a step labelled from the clip) makes the whole path ineligible: it is not all from the clip or
 * an answer.
 */
export function fieldFor(spec: TaskSpec, fields: Field[], path: string): Field | undefined {
  const parts = parsePath(canonicalSlot(spec, path.trim()));
  if (parts.length < 3 || parts.some((p) => FORBIDDEN.has(p))) return undefined;
  const list = parts[0] === "objects" ? spec.objects : parts[0] === "steps" ? spec.steps : null;
  const rec = list?.find((r) => r.id === parts[1]);
  if (!rec || ownAt(rec, parts.slice(2)) === undefined) return undefined;
  const key = (ps: string[]) => `${ps[0]}[${ps[1]}].${ps.slice(2).join(".")}`;
  const whole = key(parts);
  if (fields.some((f) => f.path.startsWith(`${whole}.`) && f.origin === "other")) return undefined;
  for (let n = parts.length; n >= 3; n--) {
    const hit = fields.find((f) => f.path === key(parts.slice(0, n)));
    // the path asked for, never the broader field it lies in (whose other parts may come from elsewhere)
    if (hit) return { ...hit, path: whole, value: shown(ownAt(rec, parts.slice(2))) };
  }
  return undefined;
}

/** What the page posts: the compiled program's rehearsal in every world, and each patch the loop tried with its outcome. */
const RolloutIn = z.object({
  pass: z.boolean(),
  t: z.number(),
  log: z.array(z.string().max(400)).max(500),
  failed_step_id: z.string().max(100).optional(),
  failed_op: z.number().int().nonnegative().optional(),
  failed_predicate: Predicate.optional(),
  failure_class: z.enum(["embodiment_limit", "spec_gap"]).optional(),
  why: z.string().max(500).optional(),
  end: z
    .array(z.object({ object: z.string(), xyz_mm: Vec3mm, speed_mm_s: z.number(), held: z.boolean(), seated: z.object({ target: z.string(), ok: z.boolean(), why: z.string().max(500) }).optional() }))
    .max(20)
    .optional(),
});
export const WorldRunIn = z.object({ world: z.enum(Object.keys(GRAVITIES) as [keyof typeof GRAVITIES]), rollout: RolloutIn });

export const PatchTried = z.object({
  n: z.number().int().min(1).max(10),
  /** "s2.op1.z_mm: 12 → 13", or "no change" */
  changes: z.string().max(400),
  why: z.string().max(400).default(""),
  /** outcomeLine() of the patch's rehearsal, or why there was none */
  outcome: z.string().max(1000),
});
export type PatchTried = z.infer<typeof PatchTried>;

export const ReshootBody = z.object({
  spec: TaskSpec,
  program: Program,
  runs: z.array(WorldRunIn).min(1).max(3),
  patches: z.array(PatchTried).max(10).default([]),
});
export type ReshootBody = z.infer<typeof ReshootBody>;

/** The model's answer. */
export const ReshootReply = z.object({
  failure_classes: z
    .array(
      z.object({
        class: z.enum(FAILURE_CLASSES),
        evidence: z.string().min(1).max(800),
        fields: z.array(z.string().max(120)).max(8).default([]),
      }),
    )
    .max(8)
    .default([]),
  reshoot: z
    .array(
      z.object({
        field: z.string().min(1).max(120),
        why: z.string().min(1).max(500),
        /** for a video field, what to film again; for an interview field, the question to ask again */
        ask: z.string().min(1).max(500),
      }),
    )
    .max(8)
    .default([]),
  open_risks: z.array(z.string().min(1).max(500)).max(8).default([]),
});
export type ReshootReply = z.infer<typeof ReshootReply>;

export const REPLY_SHAPE = '{"failure_classes":[{"class":"spec_gap|footage_gap|embodiment_limit|simulator_artefact","evidence":"...","fields":["objects[id].field"]}],"reshoot":[{"field":"objects[id].field","why":"...","ask":"..."}],"open_risks":["..."]}';

/** "spec gap", "Footage-Gap", "simulator artifact" → the enum member. */
export function normalizeReply(raw: unknown): { data: unknown; warnings: string[] } {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { failure_classes?: unknown }).failure_classes)) return { data: raw, warnings };
  const r = raw as { failure_classes: unknown[] };
  const failure_classes = r.failure_classes.map((c) => {
    if (!c || typeof c !== "object") return c;
    const x = c as { class?: unknown };
    if (typeof x.class !== "string") return c;
    const k = x.class.trim().toLowerCase().replace(/[\s-]+/g, "_").replace("artifact", "artefact");
    return (FAILURE_CLASSES as readonly string[]).includes(k) ? { ...x, class: k } : c;
  });
  return { data: { ...r, failure_classes }, warnings };
}

export const RESHOOT_SYSTEM = [
  "You review one rehearsal of a robot program in simulation and say what to do about what failed, before anyone collects more demonstrations.",
  "A simulated SO-101 (one 5-DoF arm and a parallel gripper) ran a scripted program compiled from a task spec. The spec was labelled from one video clip of a person doing the task, then completed by the person's answers. Physics is rigid-body with a geometric grasp: no friction, slip or deformation. It ran at 1 g and at 0 g (orbit).",
  "Sort each failure into one of four classes and quote the evidence from the run (a world, a step, a time, a distance, a speed, a check that failed):",
  "- spec_gap: the spec is missing something or states it wrong (a size, a clearance, a target, a success check, a tolerance).",
  "- footage_gap: the clip does not show what the spec needed (an occluded grasp, a hand out of frame, an object too small to size).",
  "- embodiment_limit: one arm of this size cannot do it as written (reach, a two-handed hold, a joint speed, an aperture).",
  "- simulator_artefact: the failure comes from the simulation, not the task (rigid bodies, the weld grasp, primitive shapes).",
  "Reshoot items: only for fields marked video or interview in the field list. A video field gets the shot to film again (what, from where, how close); an interview field gets the question to ask the person again. Never list a field marked other.",
  "Open risks: what this rehearsal does not show and a real robot would meet, for this task only.",
  "The same review applies to any task: a part into a fixture on an assembly line, a vial into a rack in a lab, a box onto a shelf in a warehouse, a cup onto a saucer in a kitchen.",
  "If every world passed, say so in the evidence and keep the classes to what could still fail. Be short: at most four classes, four reshoot items, four risks.",
  "Answer with one JSON object only.",
].join("\n");

function programText(program: Program): string {
  return program.steps.map((s) => `${s.step_id}: ${s.ops.map((op, i) => `op ${i} ${opText(op)}`).join("; ")}`).join("\n");
}

export function reshootPrompt(spec: TaskSpec, b: Pick<ReshootBody, "program" | "runs" | "patches">): string {
  const fields = fieldsOf(spec);
  const runs = b.runs as WorldRun[];
  return [
    `Task: ${spec.title}. ${spec.summary}`,
    spec.warnings.length ? `Warnings from labelling and fitting: ${spec.warnings.join("; ")}` : "",
    spec.open_questions.length ? `Open questions: ${spec.open_questions.join("; ")}` : "",
    "",
    "Spec fields, each with its source (video: labelled from the clip by the vision model or measured by the pose tracker; interview: the person's answer; other: a default, the bench fit, the web or a hand edit):",
    ...fields.map((f) => `- ${f.path} = ${f.value} (source ${f.source}: ${f.origin})`),
    "",
    "Program as compiled:",
    programText(b.program),
    "",
    "Rehearsal of the compiled program, as the simulator measured it:",
    failureNote(spec, b.program, runs),
    "",
    b.patches.length ? "Patches tried after it, each rehearsed again in every world:" : "No patch was tried.",
    ...b.patches.map((p) => `- patch ${p.n}: ${p.changes}${p.why ? ` (${p.why})` : ""}. Outcome: ${p.outcome}`),
    "",
    `Final outcome: ${b.patches.at(-1)?.outcome ?? outcomeLine(runs)}`,
    "",
    `Return ${REPLY_SHAPE}`,
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");
}

export type ReshootItem = { field: string; source: string; origin: Exclude<Origin, "other">; why: string; ask: string };

/** What the route answers and the page shows. */
export type Reshoot = {
  failure_classes: ReshootReply["failure_classes"];
  reshoot: ReshootItem[];
  open_risks: string[];
  /** reshoot items the model listed that were dropped, with why */
  dropped: string[];
  /** the final outcome the list was written for */
  outcome: string;
  model: string;
  thinking: boolean;
  tokens: number;
  cost_usd: number;
};

/** Keeps the reshoot items that name a field from the clip or from the person, with that field's source. */
export function checkReply(spec: TaskSpec, reply: ReshootReply): { reshoot: ReshootItem[]; dropped: string[] } {
  const fields = fieldsOf(spec);
  const reshoot: ReshootItem[] = [];
  const dropped: string[] = [];
  for (const item of reply.reshoot) {
    const f = fieldFor(spec, fields, item.field);
    if (!f) dropped.push(`${item.field}: not a field of this spec`);
    else if (f.origin === "other") dropped.push(`${item.field}: its source is ${f.source}, not the clip or an answer`);
    else if (reshoot.some((r) => r.field === f.path)) dropped.push(`${item.field}: listed twice`);
    else reshoot.push({ field: f.path, source: f.source, origin: f.origin, why: item.why, ask: item.ask });
  }
  return { reshoot, dropped };
}

/** The final outcome line of what the page posted: the last patch's, else the compiled program's. */
export const finalOutcome = (b: Pick<ReshootBody, "runs" | "patches">) => b.patches.at(-1)?.outcome ?? outcomeLine(b.runs as WorldRun[]);
