// Does the interview recover the truth? Measured on Nebius Token Factory against a deterministic oracle.
//
//   UNDERSTUDY_ENV_FILE=/path/to/.env.local node scripts/bench-interview.mjs [--passes main,thinking,compile-v2,v2-changes-first,v2-split]
//        [--runs 3] [--specs <name,...>] [--concurrency 5] [--out bench/results/interview.json] [--cap-usd 15]
//
// Ten ground-truth TaskSpecs (bench/specs/interview/*.json, valid per lib/spec/schema.ts) are each degraded
// by one fixed rule (degrade() below; the results land in bench/specs/interview/degraded/): five details of
// the insert or place step s2 are removed or blurred:
//   fit           pocket: objects[<fixture>].pocket_clearance_mm removed; zone or stack: steps[s2].tolerances removed
//   aperture      objects[<manipulated>].size_mm scaled by 1.7 or 0.6 (alternating), confidence 0.3, plus the open
//                 question a vision model would add ("size is a guess")
//   success       steps[s2].success removed
//   via           steps[s2].via_points removed (the approach height above the fixture)
//   precondition  steps[s2].preconditions removed (the hazard: tilt, a moving part, a soft object, a lip)
// Then: Nano compiles the degraded spec into a program with ask slots; Super asks one question per turn
// (open slots = compile asks + the spec's open questions, as in scripts/bench-session.mjs); an ORACLE (a
// function, not a model) answers from the ground truth when the question is about one of the five removed
// fields and says "I don't know." otherwise; on the next turn Super turns the answer into changes[], which are
// applied with the app's own lib/spec/apply.ts (one atomic, schema-validated batch); Nano recompiles; at most
// 7 questions. After each answer the five fields are compared with the ground truth (tolerances in CHECKS).
//
// Passes: main (Super and Nano thinking off, N runs), thinking (Super thinking on, 6000 max_tokens, 1 run),
// compile-v2 (ablation: the compile prompt also asks for a missing via point and missing preconditions),
// v2-changes-first (compile-v2 + the interview turn returns changes[] before the next question),
// v2-split (compile-v2 + a separate Super call converts each answer into changes before the next question).
// Prompts are the prototype prompts of scripts/bench-session.mjs, copied; the interview prompt adds a "slot"
// key (which spec path the question is about, so the oracle need not guess) and the shapes of via_points,
// preconditions and size_mm. Every billed call is charged to bench/results/ledger.jsonl.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BudgetError, charge, costOf, guard, loadPrices, spent } from "./bench-ledger.mjs";

const SCRIPT = "bench-interview";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");
if (!process.env.NEBIUS_API_KEY) throw new Error("NEBIUS_API_KEY missing from the env file");
const redact = (s) => String(s).split(process.env.NEBIUS_API_KEY).join("<redacted>");

const { MODELS, TOKEN_FACTORY_BASE_URL, thinkingOff, tokenFactory, usageOf } = await import(path.join(ROOT, "lib/providers/tokenfactory.ts"));
const SCHEMA_TS = path.join(ROOT, "lib/spec/schema.ts");
const { TaskSpec } = await import(pathToFileURL(SCHEMA_TS).href);
// lib/spec/apply.ts imports "./schema" without an extension, which Node's ESM loader does not resolve:
// load the same source with that one specifier pointed at schema.ts (same module instance as above).
const applyTmp = path.join(os.tmpdir(), "understudy-bench", "apply.bench.ts");
mkdirSync(path.dirname(applyTmp), { recursive: true });
writeFileSync(applyTmp, readFileSync(path.join(ROOT, "lib/spec/apply.ts"), "utf8").replace(/from "\.\/schema"/, `from ${JSON.stringify(pathToFileURL(SCHEMA_TS).href)}`));
const { applyChanges } = await import(pathToFileURL(applyTmp).href);

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const next = argv[i + 1];
  args[argv[i].slice(2)] = next === undefined || next.startsWith("--") ? true : next;
}
const RUNS = Number(args.runs ?? 3);
const PASSES = String(args.passes ?? "main,thinking").split(",");
const OUT = path.resolve(ROOT, args.out ?? "bench/results/interview.json");
const MY_CAP_USD = Number(args["cap-usd"] ?? 15);
const MINE = ["bench-label", "bench-interview"];
const CONCURRENCY = Number(args.concurrency ?? 5);
const MAX_QUESTIONS = 7;
const DEBUG_DIR = typeof args.debug === "string" ? path.resolve(args.debug) : null;
if (DEBUG_DIR) mkdirSync(DEBUG_DIR, { recursive: true });

const client = tokenFactory({ timeout: 290_000, maxRetries: 0 });

// --- Prices: list prices from tests/fixtures/models.json; refuses to run when one is missing ---------
const PRICES = loadPrices([MODELS.nano, MODELS.super]);

// --- Prompts (scripts/bench-session.mjs, copied; changes marked) ---------------------
const PREDICATES = "contact_both_pads(object), height_above(object, value mm above the table), inside_zone(object, target), no_collision(), tilt_under(object, value degrees from upright), gripper_within(object, value mm of aperture error), object_still(object), time_under(value seconds)";
const AXES = "x_mm, y_mm, z_mm, yaw_deg, tilt_deg, clearance_mm, pose_noise_mm";

const COMPILE_SYSTEM = `You play the robot: a 5-DoF SO-101 arm with a parallel gripper (aperture 0 to 60 mm), top or side approach, no force sensing, reach 300 mm from its base. Compile the task spec you are given into a program for it. Return one JSON object only:
{"spec_title":string,"steps":[{"step_id":<spec step id>,"ops":[op, ...]}],"warnings":[string]}
Ops:
- {"op":"move_to","frame":"world"|<object id>,"offset_mm":[x,y,z],"approach":"top"|"side"|"front"}
- {"op":"grasp","object":<object id>,"aperture_mm":number}
- {"op":"release"}
- {"op":"wait_until","predicate":P,"timeout_s":number}
- {"op":"assert","predicate":P}
- {"op":"ask","slot":<spec path>,"question":string,"why":string}
A predicate P is {"kind":K,"object":<id>,"target":<id>,"value":number} with only the operands its kind needs. K is one of: ${PREDICATES}.
Rules:
- One entry in steps per spec step, in the spec's order, with step_id the spec step's id.
- Offsets are relative to the named frame. Use the step's via_points when it has them; otherwise approach 50 mm above the object frame, descend, act, lift 50 mm.
- You execute only what the spec states. Every value you would have to guess becomes an ask instead: a missing object pose, a missing pocket_clearance_mm on a pocket fixture, a grasp aperture the object size does not imply, a missing tolerance band on the axes the step is sensitive to (${AXES}), a step without a success predicate. One ask per missing field, placed in the step that needs it; slot is the spec path, for example objects[rack].pose, objects[rack].pocket_clearance_mm, steps[s2].tolerances.x_mm, steps[s2].success.
- A missing value is never a warning: it is an ask op, because the asks become the questions put to the person who did the task. Warnings are only for what no answer can fix.
- A field already set in the spec is settled, whatever its source (vl#, interview#, notes#, user#edit): never ask about it again.
- End each insert or place step with an assert of its success predicate when the spec gives one.
- Keep the program short: no comments, no prose.
Example of one step whose tolerance and success are missing:
{"step_id":"s3","ops":[{"op":"move_to","frame":"rack","offset_mm":[0,0,60],"approach":"top"},{"op":"ask","slot":"steps[s3].tolerances.x_mm","question":"How far off-centre can the rack be before the insert fails?","why":"no tolerance band for x_mm"},{"op":"move_to","frame":"rack","offset_mm":[0,0,15],"approach":"top"},{"op":"release"},{"op":"ask","slot":"steps[s3].success","question":"How do you know the insert is done?","why":"no success predicate"}]}`;

/** compile-v2 (ablation only): two more ask rules, for the two fields the v1 compiler never asks about. */
const COMPILE_SYSTEM_V2 = COMPILE_SYSTEM.replace(
  "a step without a success predicate. One ask per missing field",
  "a step without a success predicate, an insert or place step without via_points (ask how high above the target the object travels before it goes in; slot steps[<id>].via_points), an insert or place step without preconditions (ask what must hold before it, a hazard such as tilt, a moving part, a soft object or a lip; slot steps[<id>].preconditions). One ask per missing field",
);
if (COMPILE_SYSTEM_V2 === COMPILE_SYSTEM) throw new Error("compile-v2 patch did not apply");

const interviewSystem = (changesFirst = false) => `You interview the person who did the task in the clip, so that a robot arm can repeat it. The open slots you are given are what the robot's compiler could not fill and what the vision model was unsure of; you ask about them, one question per turn, the most consequential first, never twice about what the transcript already covers (tolerances, grasp, success criteria, hazards, recovery). Each question cites a measurement from this clip (a step time, a token span, an aperture or an offset from the watch tokens) so the person knows what you are looking at, and is answerable in one sentence. Offer 2 to 4 short answer chips.
When the person has just answered, turn that answer into spec changes: {"path":<spec path>,"value":<JSON value>,"source":"interview#<turn of that answer>"}. Paths: objects[<id>].<field>, steps[<id>].<field> or steps[<id>].<field>.<sub>, anchor.<field>, open_questions. Tolerances are half-widths in the axis unit (${AXES}). steps[<id>].success is a full array of predicates {"kind","object","target","value"} with kind in: ${PREDICATES}. Poses are {"xyz_mm":[x,y,z],"yaw_deg":number,"frame":"world"}. "I don't know" becomes an open_questions entry and a wider band.
[bench addition] steps[<id>].preconditions is a full array of predicates like success: what must hold before and during the step (hazards). steps[<id>].via_points is a full array of {"frame":<object id or "world">,"xyz_mm":[x,y,z],"source":string}, offsets in that frame. objects[<id>].size_mm is [x,y,z] in mm ([diameter, diameter, height] for a cylinder). objects[<id>].pocket_clearance_mm is a number.
Return one JSON object only, keys in this order: ${changesFirst ? `{"changes":[...],"question":string,"slot":string,"chips":[string],"why":string,"done":boolean}; changes come first because they record the answer just given, before you move on` : `{"question":string,"slot":string,"chips":[string],"why":string,"done":boolean,"changes":[...]}`}; slot is the open slot path your question is about (or the spec path it is about, if it is none of them). If an answer does not fit its question, record it as an open_questions entry and move on to the next slot. Set done true and question "" only when no open slot is left or when you are told to close.`;

/** split ablation: a call of its own that only turns the latest answer into changes (same path rules as the interview). */
const CONVERT_SYSTEM = `You turn one answer from the person who did the task into changes to the task spec, so that a robot arm can repeat it. Put every value the answer states into the spec. Return one JSON object only: {"changes":[{"path":<spec path>,"value":<JSON value>,"source":"interview#<turn of that answer>"}]}.
Paths: objects[<id>].<field>, steps[<id>].<field> or steps[<id>].<field>.<sub>, anchor.<field>, open_questions. Tolerances are half-widths in the axis unit (${AXES}). steps[<id>].success is a full array of predicates {"kind","object","target","value"} with kind in: ${PREDICATES}. steps[<id>].preconditions is a full array of predicates like success: what must hold before and during the step (hazards). steps[<id>].via_points is a full array of {"frame":<object id or "world">,"xyz_mm":[x,y,z],"source":string}, offsets in that frame. objects[<id>].size_mm is [x,y,z] in mm ([diameter, diameter, height] for a cylinder). objects[<id>].pocket_clearance_mm is a number. Poses are {"xyz_mm":[x,y,z],"yaw_deg":number,"frame":"world"}. "I don't know" becomes an open_questions entry and a wider band.`;

/** What the Watch stage would hand over (scripts/bench-session.mjs): one token per step, deterministic wrist numbers. */
function watchTokens(spec) {
  return (spec.steps ?? [])
    .map((s, i) => {
      const t0 = Number(s.t_start_s ?? 0).toFixed(1);
      const t1 = Number(s.t_end_s ?? 0).toFixed(1);
      const speed = 40 + ((i * 37) % 90);
      const aperture = s.verb === "grasp" || s.verb === "insert" ? `, aperture ${(4 + (i % 3)).toFixed(1)} mm` : "";
      return `tok${i + 1} ${s.verb ?? "move"} ${t0}-${t1} s, right wrist, peak speed ${speed} mm/s${aperture}`;
    })
    .join("\n");
}

// --- Ground truth, degradation, checks ---------------------------------------------------
const SPEC_DIR = path.join(ROOT, "bench/specs/interview");
const names = readdirSync(SPEC_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
const SELECTED = args.specs ? String(args.specs).split(",") : names;
const GT = Object.fromEntries(SELECTED.map((n) => [n, TaskSpec.parse(JSON.parse(readFileSync(path.join(SPEC_DIR, `${n}.json`), "utf8")))]));

const mainStep = (spec) => spec.steps.find((s) => s.verb === "insert" || s.verb === "place");
const objOf = (spec, id) => spec.objects.find((o) => o.id === id);
const graspWidth = (o) => (o.shape === "box" ? Math.min(o.size_mm[0], o.size_mm[1]) : o.size_mm[0]);
const near = (v, gt, abs, rel) => Number.isFinite(Number(v)) && Math.abs(Number(v) - gt) <= Math.max(abs, rel * Math.abs(gt));

/** Tolerances of the comparison with the ground truth, per field. */
const CHECKS = {
  fit: "pocket: |clearance - truth| <= max(0.5 mm, 25%); zone/stack: every truth axis in steps[s2].tolerances within max(2, 25%)",
  aperture: "grasped width (cylinder diameter; box min(x, y)) within max(2 mm, 20%)",
  success: "every truth predicate kind present in steps[s2].success, its value (when it has one) within max(1, 20%); extra predicates allowed",
  via: "some steps[s2].via_points entry in the fixture's frame with z within max(10 mm, 20%) of the truth (or in world with z within that of fixture z + truth z)",
  precondition: "every truth predicate kind present in steps[s2].preconditions, value within max(1, 20%); extra predicates allowed",
};
function predicatesMatch(have, want) {
  return want.every((w) => (have ?? []).some((h) => h?.kind === w.kind && (w.value === undefined || near(h.value, w.value, 1, 0.2))));
}

function degrade(name, gt, index) {
  const d = structuredClone(gt);
  const s2 = mainStep(d);
  const m = objOf(d, s2.object);
  const f = objOf(d, s2.target.frame);
  const fitPocket = s2.target.fixture === "pocket";
  if (fitPocket) delete f.pocket_clearance_mm;
  else s2.tolerances = {};
  const factor = index % 2 === 0 ? 1.7 : 0.6;
  m.size_mm = m.size_mm.map((v) => Math.max(1, Math.round(v * factor)));
  m.confidence = 0.3;
  d.open_questions = [`objects[${m.id}].size_mm: the ${m.name}'s size is a guess (no scale in frame); how wide is it where the hand grips it?`];
  s2.success = [];
  s2.via_points = [];
  s2.preconditions = [];
  const gs2 = mainStep(gt);
  const gm = objOf(gt, gs2.object);
  const gf = objOf(gt, gs2.target.frame);
  const gaps = [
    {
      cat: "fit",
      path: fitPocket ? `objects[${f.id}].pocket_clearance_mm` : `steps[${s2.id}].tolerances`,
      check: (spec) => {
        const st = mainStep(spec);
        if (fitPocket) return near(objOf(spec, gf.id)?.pocket_clearance_mm, gf.pocket_clearance_mm, 0.5, 0.25);
        return Object.entries(gs2.tolerances).every(([axis, v]) => near(st?.tolerances?.[axis], v, 2, 0.25));
      },
    },
    { cat: "aperture", path: `objects[${m.id}].size_mm`, check: (spec) => { const o = objOf(spec, gm.id); return Array.isArray(o?.size_mm) && near(graspWidth(o), graspWidth(gm), 2, 0.2); } },
    { cat: "success", path: `steps[${s2.id}].success`, check: (spec) => predicatesMatch(mainStep(spec)?.success, gs2.success) },
    {
      cat: "via",
      path: `steps[${s2.id}].via_points`,
      check: (spec) => {
        const want = gs2.via_points[0];
        const tol = Math.max(10, 0.2 * want.xyz_mm[2]);
        return (mainStep(spec)?.via_points ?? []).some((v) => (v?.frame === want.frame && near(v.xyz_mm?.[2], want.xyz_mm[2], tol, 0)) || (v?.frame === "world" && near(v.xyz_mm?.[2], gf.pose.xyz_mm[2] + want.xyz_mm[2], tol, 0)));
      },
    },
    { cat: "precondition", path: `steps[${s2.id}].preconditions`, check: (spec) => predicatesMatch(mainStep(spec)?.preconditions, gs2.preconditions) },
  ];
  return { degraded: TaskSpec.parse(d), gaps, fitPocket, aperture_factor: factor };
}

// --- The oracle -----------------------------------------------------------------------------
/**
 * Which of the five removed fields (or "other") a question is about. Both the slot Super names and the
 * question's wording are read: a question counts as being about a removed field when either points at
 * it (the slot wins when they point at two different removed fields). Step-level fields (success, via,
 * preconditions, the zone tolerance band) count only for the step they were removed from, s2: a slot on
 * steps[s1] or steps[s3] is about that step, whatever its wording. size_mm counts only for the
 * manipulated object. g = { stepId, stepIndex, manip, manipIndex, fitPocket }.
 */
const STEP_LEVEL = ["success", "via", "precondition"];
function classifyText(question, fitPocket) {
  // read only the interrogative clause: the prompt makes Super open with a cited measurement
  // ("From tok2, the 5.0 mm aperture peaking at 77 mm/s - what is ...") whose words are not the topic
  const full = String(question ?? "");
  const q = full.match(/\b(what|how|which|where|when|why|is there|are there|does|do you|did you|can|could|should|would|will)\b[\s\S]*$/i)?.[0] ?? full;
  const rules = [
    ["fit", /clearance|\bgap\b|\bplay\b|wider than|\broom\b|slack|opening|loose|snug/i],
    ["success", /how do you know|tells you|indicat|confirm|\bdone\b|success|finish|complete|fully (in|seated|inserted|placed)|seated|verify|\bcue\b/i],
    ["via", /how high|height above|above the|\blift|approach height|clear the|travel|hover/i],
    ["precondition", /careful|hazard|spill|avoid|damage|must not|before (you|it|insert|plac|start|mov)|\bsafe|tilt|upright|stopped|spinning|moving|squeez|bump|knock|crush|drift/i],
    ["aperture", /how wide|width|diameter|thick|how big|size of|dimension|\bgrip|grasp|aperture/i],
    ["tolerance", /off by|toleran|how far off|off-?cent|misalign|offset|sideways|shift|lateral|accura|precis/i],
  ];
  for (const [cat, re] of rules) if (re.test(q)) return cat === "tolerance" ? (fitPocket ? "other" : "fit") : cat;
  return "other";
}
function classify(slot, question, g) {
  const s = String(slot ?? "");
  const stepTok = s.match(/^steps\[([^\]]+)\]/)?.[1];
  // a question whose wording is about the grasp (s1) or the retract (s3) and not the insert/place is about that step
  const q = String(question ?? "");
  const textOtherStep = /\bretract|\bs[13]\b|grasp step|step s?[13]\b|lift(ing)? it off|picking it up/i.test(q) && !/insert|plac|\bs2\b|step s?2\b|goes in|into the/i.test(q);
  const otherStep = (stepTok !== undefined && stepTok !== g.stepId && stepTok !== String(g.stepIndex)) || (stepTok === undefined && textOtherStep);
  const objTok = s.match(/^objects\[([^\]]+)\]/)?.[1];
  let slotCat = null;
  if (s && !/^open_questions/.test(s)) {
    if (/clearance/i.test(s)) slotCat = "fit";
    else if (/size_mm|aperture|grip/i.test(s)) slotCat = objTok !== undefined && objTok !== g.manip && objTok !== String(g.manipIndex) ? "other" : "aperture";
    else if (otherStep) slotCat = "other";
    else if (/\.success\b/.test(s)) slotCat = "success";
    else if (/via_points/.test(s)) slotCat = "via";
    else if (/preconditions/.test(s)) slotCat = "precondition";
    else if (/\.tolerances/.test(s)) slotCat = g.fitPocket ? "other" : "fit";
    else slotCat = "other";
  }
  if (slotCat && slotCat !== "other") return { cat: slotCat, by: "slot" };
  const textCat = classifyText(question, g.fitPocket);
  const otherObj = objTok !== undefined && objTok !== g.manip && objTok !== String(g.manipIndex);
  const blocked = (otherStep && (STEP_LEVEL.includes(textCat) || (textCat === "fit" && !g.fitPocket))) || (otherObj && textCat === "aperture");
  if (textCat !== "other" && !blocked) return { cat: textCat, by: "text" };
  return { cat: "other", by: slotCat ? "slot" : "text" };
}

const phrase = (gt, p) => {
  const n = (id) => objOf(gt, id)?.name ?? id;
  switch (p.kind) {
    case "inside_zone": return `the ${n(p.object)} is in the ${n(p.target)}`;
    case "object_still": return `the ${n(p.object)} stays still after I let go`;
    case "tilt_under": return `the ${n(p.object)} stays within ${p.value} degrees of upright`;
    case "time_under": return `the whole thing takes under ${p.value} seconds`;
    case "height_above": return `the bottom of the ${n(p.object)} is at least ${p.value} mm above the table`;
    case "no_collision": return "nothing else gets bumped";
    case "contact_both_pads": return `both fingers are on the ${n(p.object)}`;
    case "gripper_within": return `my grip on the ${n(p.object)} is within ${p.value} mm of its width, no squeezing`;
    default: return p.kind;
  }
};
const list = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** The answer the person who did the task gives, from the ground truth only. */
function oracleAnswer(cat, gt, fitPocket) {
  const s2 = mainStep(gt);
  const m = objOf(gt, s2.object);
  const f = objOf(gt, s2.target.frame);
  switch (cat) {
    case "fit": {
      if (fitPocket) return `The opening in the ${f.name} is about ${f.pocket_clearance_mm} mm wider than the ${m.name}: ${f.pocket_clearance_mm} mm of clearance.`;
      const t = s2.tolerances;
      return t.x_mm === t.y_mm ? `It still works if it lands up to ${t.x_mm} mm off in any direction.` : `It still works if it lands up to ${t.x_mm} mm off front-to-back (away from the robot) and ${t.y_mm} mm off side-to-side.`;
    }
    case "aperture": {
      const [a, b, c] = m.size_mm;
      return m.shape === "cylinder" ? `The ${m.name} is ${a} mm across and ${c} mm tall; I grip it across the ${a} mm.` : `The ${m.name} is ${a} by ${b} by ${c} mm; I grip it across the ${Math.min(a, b)} mm side.`;
    }
    case "success": return `It is done when ${list(s2.success.map((p) => phrase(gt, p)))}.`;
    case "via": {
      const v = s2.via_points[0];
      return `Before it goes in I bring it straight above the ${f.name}, ${v.xyz_mm[2]} mm above its centre.`;
    }
    case "precondition": return `Careful: before and while it goes in, ${list(s2.preconditions.map((p) => phrase(gt, p)))}.`;
    default: return "I don't know.";
  }
}

// --- Token Factory calls -------------------------------------------------------------------
function parseJson(text) {
  let s = (text ?? "").trimStart();
  while (s.startsWith("<think>")) {
    const end = s.indexOf("</think>");
    if (end < 0) return null;
    s = s.slice(end + 8).trimStart();
  }
  s = s.replace(/^```(?:json)?\s*/i, "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(ctx, stage, role, { system, user, maxTokens, thinking = "off" }) {
  const model = MODELS[role];
  const p = PRICES[model];
  // chars/3 plus 100 tokens of chat-template overhead, then max_tokens at the completion price
  const worst = (Math.ceil(((system?.length ?? 0) + user.length) / 3) + 100) * p.prompt + maxTokens * p.completion;
  const params = { model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens, response_format: { type: "json_object" } };
  if (thinking === "off") Object.assign(params, thinkingOff());
  const rec = { stage, role, thinking, max_tokens: maxTokens, estimated_usd: 0 };
  const meta = { model, stage, spec: ctx.name, pass: ctx.pass, run: ctx.run };
  for (let attempt = 1; attempt <= 2; attempt++) {
    // every attempt, retries included, reserves its worst case first (throws BudgetError past a cap)
    const reservation = guard(worst, { script: SCRIPT, capUsd: MY_CAP_USD, capScripts: MINE, meta: { ...meta, attempt } });
    const started = performance.now();
    let res;
    try {
      res = await client.chat.completions.create(params);
    } catch (err) {
      // the server may have done the work before the error or timeout: charge the reserved estimate
      const status = err?.status ?? null;
      charge(SCRIPT, worst, { ...meta, attempt, estimated: true, failed: true, status }, reservation);
      rec.estimated_usd += worst;
      ctx.cost += worst;
      ctx.estimated += worst;
      Object.assign(rec, { ok: false, attempts: attempt, ms: Math.round(performance.now() - started), status, error: redact(err?.message ?? err).slice(0, 300), cost_usd: 0 });
      if (attempt === 1 && (status === null || status === 429 || status >= 500)) {
        await sleep(5000);
        continue;
      }
      ctx.calls.push(rec);
      return { rec, parsed: null };
    }
    const msg = res.choices?.[0]?.message ?? {};
    const text = msg.content ?? "";
    const u = usageOf(res);
    const cost = costOf(PRICES, model, u);
    charge(SCRIPT, cost, { ...meta, attempt, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens }, reservation);
    Object.assign(rec, { ok: true, attempts: attempt, ms: Math.round(performance.now() - started), prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, reasoning_tokens: u.reasoning_tokens ?? null, finish: res.choices?.[0]?.finish_reason ?? null, cost_usd: cost });
    const parsed = parseJson(text);
    rec.json_ok = parsed !== null;
    ctx.calls.push(rec);
    ctx.cost += cost;
    if (DEBUG_DIR) writeFileSync(path.join(DEBUG_DIR, `${ctx.pass}-${ctx.name}-r${ctx.run}-${String(ctx.calls.length).padStart(2, "0")}-${stage}.txt`), `${user}\n\n--- output ---\n${text}\n`);
    return { rec, parsed };
  }
}

const askSlots = (program) => (program?.steps ?? []).flatMap((s) => (Array.isArray(s?.ops) ? s.ops : []).filter((o) => o?.op === "ask").map((o) => ({ step_id: s.step_id, slot: String(o.slot ?? ""), question: String(o.question ?? ""), why: String(o.why ?? "") })));
const openSlots = (program, spec) => [...askSlots(program), ...(spec.open_questions ?? []).map((q) => ({ step_id: "-", slot: "open_questions", question: String(q), why: "the vision model was unsure" }))];

// --- One interview ----------------------------------------------------------------------------
async function interview(name, pass, run, index) {
  const gt = GT[name];
  const { degraded, gaps, fitPocket } = degrade(name, gt, index);
  const superThinking = pass === "thinking" ? "on" : "off";
  const superMax = pass === "thinking" ? 6000 : 1200;
  const compileSystem = /v2/.test(pass) ? COMPILE_SYSTEM_V2 : COMPILE_SYSTEM;
  const changesFirst = /changes-first/.test(pass);
  const split = /split/.test(pass);
  const ctx = { name, pass, run, calls: [], cost: 0, estimated: 0 };
  let spec = structuredClone(degraded);
  const recovered = () => gaps.filter((g) => g.check(spec)).map((g) => g.cat);
  const turns = [{ turn: 0, recovered: recovered(), cost_usd: 0, questions: 0 }];
  const questions = [];
  const notes = [];
  let program = null;
  const compile = async (why) => {
    const r = await call(ctx, "compile", "nano", { system: compileSystem, user: `Task spec:\n${JSON.stringify(spec)}`, maxTokens: 3000 });
    if (r.parsed && Array.isArray(r.parsed.steps)) program = r.parsed;
    else notes.push(`compile (${why}) unusable; previous program kept`);
    return askSlots(program);
  };
  let stopped = null;
  try {
    const firstAsks = await compile("degraded");
    turns[0].cost_usd = ctx.cost;
    turns[0].asks = firstAsks.map((a) => a.slot);
    const tokens = watchTokens(spec);
    const transcript = [];
    let asked = 0;
    let lastAnswer = null;
    let slots = openSlots(program, spec);
    const applyAnswer = async (raw) => {
      const changes = (Array.isArray(raw) ? raw : []).filter((c) => c && typeof c.path === "string").map((c) => ({ path: c.path, value: c.value, source: String(c.source || `interview#${asked}`) }));
      const res = applyChanges(spec, changes);
      const q = questions.at(-1);
      q.changes = changes.map((c) => c.path);
      q.applied = res.warnings.length === 0 && changes.length > 0;
      if (res.warnings.length) q.rejected = res.warnings.slice(0, 3);
      spec = res.spec;
      await compile(`answer ${asked}`);
      slots = openSlots(program, spec);
      turns.push({ turn: asked, recovered: recovered(), cost_usd: ctx.cost, questions: asked, slots_left: slots.length });
    };
    for (let turn = 1; slots.length || lastAnswer; turn++) {
      if (split && lastAnswer) {
        const r = await call(ctx, "convert", "super", {
          system: CONVERT_SYSTEM,
          user: [`Task spec:\n${JSON.stringify(spec)}`, `Question ${asked} (about ${questions.at(-1).slot || "the spec"}): ${transcript.at(-1).q}`, `The person answered: "${lastAnswer}"`, `Turn it into changes with source "interview#${asked}".`].join("\n\n"),
          maxTokens: superMax,
          thinking: superThinking,
        });
        if (!r.parsed) notes.push(`convert after answer ${asked} unusable (${r.rec.ok ? `finish ${r.rec.finish}` : `HTTP ${r.rec.status}`})`);
        await applyAnswer(r.parsed?.changes);
        lastAnswer = null;
        if (asked >= MAX_QUESTIONS || !slots.length) {
          stopped = asked >= MAX_QUESTIONS ? "7 questions asked" : "no open slot left";
          break;
        }
      }
      const closing = asked >= MAX_QUESTIONS || (lastAnswer && !slots.length);
      const user = [
        `Task spec:\n${JSON.stringify(spec)}`,
        `Open slots (the compiler's asks, then the vision model's open questions):\n${slots.map((s) => `- ${s.slot} (step ${s.step_id}): ${s.question}${s.why ? ` [${s.why}]` : ""}`).join("\n") || "(none)"}`,
        `Watch tokens:\n${tokens}`,
        `Transcript so far:\n${transcript.map((t, i) => `Q${i + 1}: ${t.q}\nA${i + 1}: ${t.a}`).join("\n") || "(none)"}`,
        lastAnswer ? `The person just answered question ${asked} (turn ${asked}): "${lastAnswer}". Turn it into changes with source "interview#${asked}".` : asked ? "The latest answer is already recorded in the spec above." : "No answer yet: this is the first turn.",
        closing ? "This is the closing turn: turn the latest answer into changes, ask nothing, set done true." : `Questions asked so far: ${asked} of at most ${MAX_QUESTIONS}. Ask the next one.`,
      ].join("\n\n");
      const r = await call(ctx, "interview", "super", { system: interviewSystem(changesFirst), user, maxTokens: superMax, thinking: superThinking });
      const t = r.parsed ?? {};
      if (!r.parsed) notes.push(`interview turn ${turn} unusable (${r.rec.ok ? `finish ${r.rec.finish}` : `HTTP ${r.rec.status}`})`);
      if (lastAnswer) await applyAnswer(t.changes);
      lastAnswer = null;
      if (closing || t.done || !String(t.question ?? "").trim()) {
        stopped = closing ? (asked >= MAX_QUESTIONS ? "7 questions asked" : "no open slot left") : t.done ? "model said done" : "no question returned";
        break;
      }
      asked++;
      const gs2 = mainStep(gt);
      const { cat, by } = classify(t.slot, t.question, { stepId: gs2.id, stepIndex: gt.steps.indexOf(gs2), manip: gs2.object, manipIndex: gt.objects.findIndex((o) => o.id === gs2.object), fitPocket });
      const gap = gaps.find((g) => g.cat === cat);
      const wasRecovered = gap ? gap.check(spec) : false;
      const answer = gap ? oracleAnswer(cat, gt, fitPocket) : "I don't know.";
      questions.push({ turn: asked, slot: String(t.slot ?? ""), category: cat, classified_by: by, about_gap: Boolean(gap), already_recovered: wasRecovered, question_chars: String(t.question).length, question: String(t.question).slice(0, 240), answer });
      transcript.push({ q: String(t.question), a: answer });
      lastAnswer = answer;
    }
    if (!stopped) stopped = "no open slot after the first compile";
  } catch (err) {
    if (!(err instanceof BudgetError)) throw err;
    stopped = `budget: ${err.message}`;
  }
  // carry the last state forward so every run has turns 0..7
  const curve = [];
  for (let k = 0; k <= MAX_QUESTIONS; k++) {
    const last = [...turns].reverse().find((x) => x.turn <= k) ?? turns[0];
    curve.push({ turn: k, recovered: last.recovered.length, fraction: last.recovered.length / gaps.length, cost_usd: Number(last.cost_usd.toFixed(6)) });
  }
  const final = turns.at(-1).recovered;
  return {
    spec: name,
    pass,
    run,
    gaps: gaps.map((g) => ({ cat: g.cat, path: g.path, recovered: final.includes(g.cat), first_turn: turns.find((x) => x.recovered.includes(g.cat))?.turn ?? null })),
    stopped,
    questions_asked: questions.length,
    wasted: questions.filter((q) => !q.about_gap).length,
    repeats: questions.filter((q) => q.about_gap && q.already_recovered).length,
    rejected_batches: questions.filter((q) => q.rejected).length,
    first_compile_asks: turns[0].asks ?? [],
    curve,
    cost_usd: Number(ctx.cost.toFixed(6)),
    estimated_usd: Number(ctx.estimated.toFixed(6)),
    calls: ctx.calls.length,
    failed_calls: ctx.calls.filter((c) => !c.ok).length,
    bad_json: ctx.calls.filter((c) => c.ok && !c.json_ok).length,
    finish_length: ctx.calls.filter((c) => c.finish === "length").length,
    super_tokens: ctx.calls.filter((c) => c.role === "super").reduce((n, c) => n + (c.prompt_tokens ?? 0) + (c.completion_tokens ?? 0), 0),
    nano_tokens: ctx.calls.filter((c) => c.role === "nano").reduce((n, c) => n + (c.prompt_tokens ?? 0) + (c.completion_tokens ?? 0), 0),
    notes,
    questions,
  };
}

async function gtCompile(name) {
  const ctx = { name, pass: "gt-compile", run: 1, calls: [], cost: 0, estimated: 0 };
  const r = await call(ctx, "compile", "nano", { system: COMPILE_SYSTEM, user: `Task spec:\n${JSON.stringify(GT[name])}`, maxTokens: 3000 });
  return { spec: name, asks: askSlots(r.parsed).map((a) => a.slot), ok: Boolean(r.parsed), cost_usd: ctx.cost };
}

async function pool(jobs, n) {
  const out = new Array(jobs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (i < jobs.length) {
        const k = i++;
        out[k] = await jobs[k]();
      }
    }),
  );
  return out;
}

// --- Main ------------------------------------------------------------------------------------------
const degradedDir = path.join(SPEC_DIR, "degraded");
mkdirSync(degradedDir, { recursive: true });
SELECTED.forEach((n) => {
  const { degraded, gaps } = degrade(n, GT[n], names.indexOf(n));
  writeFileSync(path.join(degradedDir, `${n}.json`), JSON.stringify({ removed: gaps.map((g) => ({ field: g.cat, path: g.path })), spec: degraded }, null, 2) + "\n");
});

const started = Date.now();
console.log(`ground-truth compiles (asks a complete spec still gets)`);
const gtc = await pool(SELECTED.map((n) => () => gtCompile(n)), CONCURRENCY);
for (const g of gtc) console.log(`  ${g.spec.padEnd(24)} ${g.ok ? `${g.asks.length} asks ${g.asks.join(" ")}` : "UNUSABLE"}`);

const results = {};
for (const pass of PASSES) {
  const runs = pass === "thinking" ? 1 : RUNS;
  const jobs = [];
  for (let r = 1; r <= runs; r++) for (const n of SELECTED) jobs.push(() => interview(n, pass, r, names.indexOf(n)));
  console.log(`\npass ${pass}: ${jobs.length} interviews`);
  const rs = await pool(
    jobs.map((j) => async () => {
      const x = await j();
      console.log(`  ${x.pass} ${x.spec.padEnd(24)} run ${x.run}: ${x.curve.map((c) => c.recovered).join(" ")} /5  q ${x.questions_asked} wasted ${x.wasted} repeat ${x.repeats} rejected ${x.rejected_batches}  $${x.cost_usd.toFixed(4)}  ${x.stopped}`);
      return x;
    }),
    CONCURRENCY,
  );
  results[pass] = rs;
}

// --- Summary ----------------------------------------------------------------------------------------
const stat = (xs) => (xs.length ? { mean: Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4)), min: Number(Math.min(...xs).toFixed(4)), max: Number(Math.max(...xs).toFixed(4)) } : null);
const CATS = ["fit", "aperture", "success", "via", "precondition"];
const summary = {};
for (const [pass, rs] of Object.entries(results)) {
  const totalRecovered = rs.reduce((n, x) => n + x.curve.at(-1).recovered, 0);
  const totalCost = rs.reduce((n, x) => n + x.cost_usd, 0);
  summary[pass] = {
    interviews: rs.length,
    curve: Array.from({ length: MAX_QUESTIONS + 1 }, (_, k) => ({ turn: k, fraction: stat(rs.map((x) => x.curve[k].fraction)), cost_usd: stat(rs.map((x) => x.curve[k].cost_usd)) })),
    per_spec_final: Object.fromEntries(SELECTED.map((n) => [n, stat(rs.filter((x) => x.spec === n).map((x) => x.curve.at(-1).recovered))])),
    per_field_recovered: Object.fromEntries(CATS.map((c) => [c, `${rs.filter((x) => x.gaps.find((g) => g.cat === c)?.recovered).length}/${rs.length}`])),
    questions: stat(rs.map((x) => x.questions_asked)),
    wasted: stat(rs.map((x) => x.wasted)),
    wasted_share: Number((rs.reduce((n, x) => n + x.wasted, 0) / Math.max(1, rs.reduce((n, x) => n + x.questions_asked, 0))).toFixed(3)),
    repeats: stat(rs.map((x) => x.repeats)),
    rejected_batches: rs.reduce((n, x) => n + x.rejected_batches, 0),
    gap_answers: rs.reduce((n, x) => n + x.questions.filter((q) => q.about_gap && q.changes).length, 0),
    gap_answers_without_changes: rs.reduce((n, x) => n + x.questions.filter((q) => q.about_gap && q.changes && q.changes.length === 0).length, 0),
    dont_know_answers_with_changes: rs.reduce((n, x) => n + x.questions.filter((q) => !q.about_gap && q.changes?.some((p) => p !== "open_questions")).length, 0),
    questions_per_category: Object.fromEntries([...CATS, "other"].map((c) => [c, rs.reduce((n, x) => n + x.questions.filter((q) => q.category === c).length, 0)])),
    stopped: rs.reduce((o, x) => ((o[x.stopped] = (o[x.stopped] ?? 0) + 1), o), {}),
    cost_per_interview_usd: stat(rs.map((x) => x.cost_usd)),
    cost_per_recovered_field_usd: totalRecovered ? Number((totalCost / totalRecovered).toFixed(6)) : null,
    total_cost_usd: Number(totalCost.toFixed(6)),
    failed_calls: rs.reduce((n, x) => n + x.failed_calls, 0),
    bad_json: rs.reduce((n, x) => n + x.bad_json, 0),
    finish_length: rs.reduce((n, x) => n + x.finish_length, 0),
  };
}

const result = {
  benchmark: "Interview recovers the truth: degraded spec -> Nano compile -> Super interview against a deterministic oracle",
  date: new Date().toISOString(),
  reproduce: `UNDERSTUDY_ENV_FILE=<path to .env.local> node scripts/bench-interview.mjs --passes ${PASSES.join(",")} --runs ${RUNS} --concurrency ${CONCURRENCY}${args.specs ? ` --specs ${args.specs}` : ""}${args.out ? ` --out ${args.out}` : ""}`,
  wall_s: Math.round((Date.now() - started) / 1000),
  conditions: {
    base_url: TOKEN_FACTORY_BASE_URL,
    models: { compile: MODELS.nano, interview: MODELS.super },
    passes: {
      main: `Nano and Super thinking off (enable_thinking=false), Super max_tokens 1200, Nano 3000; ${RUNS} runs per spec`,
      thinking: "Super thinking on (default), max_tokens 6000; Nano unchanged; 1 run per spec",
      "compile-v2": `ablation: compile prompt also asks for a missing via point and missing preconditions; otherwise as main; ${RUNS} runs per spec`,
      "v2-changes-first": "ablation: compile-v2 + the interview returns changes[] before the next question (key order)",
      "v2-split": "ablation: compile-v2 + a separate Super call turns each answer into changes (CONVERT_SYSTEM), then the spec is patched and recompiled, then the next question is asked from fresh slots; the asking call's changes are ignored",
    },
    max_questions: MAX_QUESTIONS,
    turn: "turn k = the spec after the answer to question k was applied and recompiled; turn 0 = the degraded spec; an interview that stops early carries its last value forward",
    degrade: "five fields of step s2 per spec: fit (pocket clearance, or the tolerance band for zone/stack), aperture (size_mm scaled x1.7 or x0.6, confidence 0.3, plus one open question), success, via_points, preconditions; files in bench/specs/interview/degraded/",
    oracle: "classifies each question into fit, aperture, success, via, precondition or other from the slot Super names and from keywords in the question's interrogative clause (either may point at a removed field; step-level fields count only on s2, size only on the manipulated object; see classify()); answers from the ground-truth spec with a templated sentence when it is about a removed field (also when that field was already recovered: counted as a repeat), else 'I don't know.' (counted as wasted)",
    checks: CHECKS,
    apply: "lib/spec/apply.ts applyChanges (atomic batch, schema-validated): a batch with one bad change applies nothing",
    concurrency: CONCURRENCY,
    prices: "list prices from tests/fixtures/models.json (Super $0.30 / $0.90, Nano $0.06 / $0.24 per million); a failed or timed-out call is charged at its reserved worst case (estimated_usd, included in cost_usd)",
  },
  ground_truth_compile_asks: gtc,
  summary,
  // this script's own calls only (the ledger may be charged by other scripts at the same time)
  spend_usd: Number((gtc.reduce((n, g) => n + g.cost_usd, 0) + Object.values(results).flat().reduce((n, x) => n + x.cost_usd, 0)).toFixed(6)),
  runs: results,
};
let body = JSON.stringify(result, null, 2) + "\n";
if (body.includes(process.env.NEBIUS_API_KEY)) body = redact(body);
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, body);

for (const [pass, s] of Object.entries(summary)) {
  console.log(`\n${pass}: ${s.interviews} interviews\n| Turn | Recovered (mean) | Range | Cost so far (mean) |\n|---|---|---|---|`);
  for (const c of s.curve) console.log(`| ${c.turn} | ${(c.fraction.mean * 100).toFixed(0)}% | ${(c.fraction.min * 100).toFixed(0)}-${(c.fraction.max * 100).toFixed(0)}% | $${c.cost_usd.mean.toFixed(4)} |`);
  console.log(`per field: ${JSON.stringify(s.per_field_recovered)}; questions ${s.questions.mean} (wasted ${s.wasted.mean}, share ${(s.wasted_share * 100).toFixed(0)}%, repeats ${s.repeats.mean}); rejected batches ${s.rejected_batches}; $${s.cost_per_interview_usd.mean.toFixed(4)} per interview, $${s.cost_per_recovered_field_usd} per recovered field; stopped ${JSON.stringify(s.stopped)}`);
}
console.log(`\nwrote ${path.relative(ROOT, OUT)}; this run spent $${result.spend_usd.toFixed(4)}; ledger total $${spent().toFixed(4)}`);
