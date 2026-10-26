// What one Understudy session costs on Nebius Token Factory, measured.
//
//   UNDERSTUDY_ENV_FILE=/path/to/.env.local node scripts/bench-session.mjs [--runs 3] [--out bench/results/session.json]
//        [--clip samples/iss-veggie-seed-film.mp4] [--ultra-thinking on|off] [--max-run-usd 0.5] [--debug <dir outside the repo>]
//
// The routes are not built yet, so this runs every Token Factory call of one
// session in order, with prototype prompts of realistic size and shape:
//   health    Nano, 5 tokens, as app/api/health/route.ts sends it
//   label     Super VL watches a 480-wide 4 fps H.264 proxy of the clip (video_url data URI) -> TaskSpec JSON
//   compile   Nano turns the spec into a Program with ask slots
//   interview Super asks one question per open slot (compile asks plus the label's open questions, at most
//             5); each canned answer comes back on the next turn, which turns it into changes[]; the spec is
//             patched and Nano recompiles; one closing turn folds in the last answer
//   saboteur  Super writes 12 perturbation scenarios
//   notes     Super proposes one patch from the worst (synthetic) rollout failure, Nano recompiles
//   reshoot   Ultra writes the failure classes, the reshoot list and open risks (16k budget, background)
// Rollouts are synthetic (no simulator here); Ground (Tavily, opt-in) and the reactive turn are left out.
//
// Model IDs, the base URL and the thinking switch come from lib/providers/tokenfactory.ts; list prices
// from tests/fixtures/models.json (the script refuses to run when one of the four is missing). Every call
// reserves its worst case on the shared ledger (scripts/bench-ledger.mjs, global cap BENCH_CAP_USD) before
// it is sent and is charged after: the real cost, or the reserved estimate when it failed or timed out.
// --ledger-cap-usd <n> also caps this script's cumulative ledger spend. Writes counts and shapes only:
// no prompts, no outputs, no key.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BudgetError, charge, costOf as ledgerCostOf, guard, loadPrices } from "./bench-ledger.mjs";
import { logCall } from "./call-log.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");
if (!process.env.NEBIUS_API_KEY) throw new Error("NEBIUS_API_KEY missing from the env file");
/** never let the key reach stdout or the results file, whatever an error message contains */
const redact = (s) => String(s).split(process.env.NEBIUS_API_KEY).join("<redacted>");

// After loadEnvFile, so UNDERSTUDY_MODEL_* overrides in the env file apply as they do in the app.
const { MODELS, TOKEN_FACTORY_BASE_URL, VIDEO_PROXY, thinkingOff, tokenFactory, usageOf } = await import(
  path.join(ROOT, "lib/providers/tokenfactory.ts")
);

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const next = argv[i + 1];
  args[argv[i].slice(2)] = next === undefined || next.startsWith("--") ? true : next;
}
const RUNS = Number(args.runs ?? 3);
const OUT = path.resolve(ROOT, args.out ?? "bench/results/session.json");
const CLIP = path.resolve(ROOT, args.clip ?? "samples/iss-veggie-seed-film.mp4");
const ULTRA_THINKING = args["ultra-thinking"] === "off" ? "off" : "on";
const MAX_RUN_USD = Number(args["max-run-usd"] ?? 0.5);
const MAX_TOTAL_USD = 1.0;
const SCRIPT = "bench-session";
/** optional cap on this script's cumulative spend on the shared ledger (the global cap always applies) */
const LEDGER_CAP_USD = args["ledger-cap-usd"] === undefined ? undefined : Number(args["ledger-cap-usd"]);
const MAX_QUESTIONS = 5;
/** --debug <dir>: also write each call's user prompt and output there, for prompt work (never into the repo) */
const DEBUG_DIR = typeof args.debug === "string" ? path.resolve(args.debug) : null;
if (DEBUG_DIR) mkdirSync(DEBUG_DIR, { recursive: true });

// Routes run with maxDuration 300; no retries so every request is counted once.
const client = tokenFactory({ timeout: 290_000, maxRetries: 0 });

// --- Prices ------------------------------------------------------------------
// list prices from tests/fixtures/models.json; throws (refuses to run) when a model has none
const PRICES = loadPrices(Object.values(MODELS));
const costOf = (model, u) => ledgerCostOf(PRICES, model, u);

// --- Video proxy --------------------------------------------------------------
const tmp = path.join(os.tmpdir(), "understudy-bench");
mkdirSync(tmp, { recursive: true });
const PROXY = path.join(tmp, `${path.basename(CLIP, ".mp4")}-${VIDEO_PROXY.width}w-${VIDEO_PROXY.fps}fps.mp4`);
const CRF = 28;
const probe = (file) =>
  JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,codec_name:format=duration", "-of", "json", file]).toString(),
  );
const encStarted = performance.now();
execFileSync("ffmpeg", ["-y", "-v", "error", "-i", CLIP, "-an", "-vf", `scale=${VIDEO_PROXY.width}:-2,fps=${VIDEO_PROXY.fps}`, "-c:v", "libx264", "-preset", "medium", "-crf", String(CRF), "-pix_fmt", "yuv420p", "-movflags", "+faststart", PROXY]);
const encMs = Math.round(performance.now() - encStarted);
const clipProbe = probe(CLIP);
const proxyProbe = probe(PROXY);
const proxyBytes = statSync(PROXY).size;
const clipSeconds = Number(clipProbe.format.duration);
const VIDEO_URI = `data:video/mp4;base64,${readFileSync(PROXY).toString("base64")}`;
console.log(`proxy ${proxyProbe.streams[0].width}x${proxyProbe.streams[0].height} ${VIDEO_PROXY.fps} fps, ${clipSeconds} s, ${(proxyBytes / 1024).toFixed(0)} KB (encoded in ${encMs} ms)`);

// --- Helpers -------------------------------------------------------------------
/** strip leading think blocks and fences, then parse the first balanced JSON object */
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

const isRec = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** Minimal version of lib/spec/apply.ts: set a leaf by path and record its provenance. */
function applyChange(spec, change) {
  if (!change || typeof change.path !== "string") return false;
  const tokens = [...change.path.matchAll(/[^.[\]]+|\[([^\]]+)\]/g)].map((m) => m[1] ?? m[0]);
  if (!tokens.length || tokens.some((t) => ["__proto__", "constructor", "prototype"].includes(t))) return false;
  if (tokens[0] === "open_questions" && tokens.length === 1) {
    spec.open_questions = [...(spec.open_questions ?? []), ...[change.value].flat().map(String)];
    return true;
  }
  let node = spec;
  let record = spec;
  let rel = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (Array.isArray(node)) {
      let idx = node.findIndex((x) => isRec(x) && x.id === t);
      if (idx < 0 && /^\d+$/.test(t) && Number(t) < node.length) idx = Number(t);
      if (idx < 0) return false;
      node = node[idx];
      if (i === 1 && (tokens[0] === "objects" || tokens[0] === "steps")) {
        record = node;
        rel = [];
        continue;
      }
    } else if (isRec(node)) {
      if (!(t in node) || node[t] == null) node[t] = /^\d+$/.test(tokens[i + 1]) ? [] : {};
      node = node[t];
    } else return false;
    rel.push(t);
  }
  const leaf = tokens.at(-1);
  if (Array.isArray(node)) {
    // steps[s3] replaces the record whose id is s3, as lib/spec/apply.ts does; else an index (or append)
    let idx = node.findIndex((x) => isRec(x) && x.id === leaf);
    if (idx < 0 && /^\d+$/.test(leaf) && Number(leaf) <= node.length) idx = Number(leaf);
    if (idx < 0) return false;
    node[idx] = change.value;
  } else if (isRec(node)) node[leaf] = change.value;
  else return false;
  if (record !== spec) {
    record.sources = isRec(record.sources) ? record.sources : {};
    record.sources[[...rel, leaf].join(".")] = String(change.source ?? "interview");
  } else {
    spec.sources = isRec(spec.sources) ? spec.sources : {};
    spec.sources[tokens.join(".")] = String(change.source ?? "interview");
  }
  return true;
}
const applyAll = (spec, changes) => (Array.isArray(changes) ? changes.map((c) => applyChange(spec, c)).filter(Boolean).length : 0);

const askSlots = (program) =>
  (program?.steps ?? []).flatMap((s) => (Array.isArray(s?.ops) ? s.ops : []).filter((o) => o?.op === "ask").map((o) => ({ step_id: s.step_id, slot: String(o.slot ?? ""), question: String(o.question ?? ""), why: String(o.why ?? "") })));
/**
 * What the interview may ask about: the compiler's ask slots plus the label's open questions
 * (SPEC section 5: what the vision model was unsure of becomes the first questions).
 */
const openSlots = (program, spec) => [
  ...askSlots(program),
  ...(Array.isArray(spec.open_questions) ? spec.open_questions : []).map((q) => ({ step_id: "-", slot: "open_questions", question: String(q), why: "the vision model was unsure" })),
];

/**
 * Short answers the person who did the task would give, picked by what the question is about.
 * Task-agnostic on purpose (the label names the objects, not this script); a question no
 * pattern fits gets its first chip, as if tapped, else "I don't know."
 */
const CANNED = [
  [/toleran|deviation|how far|off by|allow|maximum|error|precis|accura|±|offset|shift|misalign/i, "It still works if the target is off by about 3 mm; past 5 mm it catches the edge."],
  [/success|done|finish|complete|how do you know|how do you tell|confirm|verify|determine that/i, "Done when it sits fully in place and stays there after I let go."],
  [/clearance|gap|play|wider|loose|tight|fit/i, "About 2 mm of play around it once it is in."],
  [/orient|angle|tilt|yaw|rotat|upright/i, "Keep it upright, within about 10 degrees."],
  [/grip|grasp|aperture|pinch|hold|finger/i, "I pinch it near the top edge, fingers about 4 mm apart."],
  [/where|position|pose|locat|distance|height|far from|origin|size|dimension|how big/i, "The target is about 30 cm in front of me and 10 cm to my right; the part is about 6 cm long."],
  [/recover|fail|miss|retry|wrong|slip|drop/i, "If it misses, I back off about 2 cm and try once more."],
  [/time|fast|second|speed|how long/i, "It takes me about 4 seconds; under 10 is fine."],
  [/hazard|safe|avoid|damage|careful|crush|tear|fragile/i, "Don't squeeze it hard; nothing sharp or hot nearby."],
];
const cannedAnswer = (question, chips) =>
  CANNED.find(([re]) => re.test(question))?.[1] ?? (Array.isArray(chips) && chips.length ? String(chips[0]) : "I don't know.");

const PREDICATES = "contact_both_pads(object), height_above(object, value mm above the table), inside_zone(object, target), no_collision(), tilt_under(object, value degrees from upright), gripper_within(object, value mm of aperture error), object_still(object), time_under(value seconds)";
const AXES = "x_mm, y_mm, z_mm, yaw_deg, tilt_deg, clearance_mm, pose_noise_mm";

// --- Prototype prompts -------------------------------------------------------
const LABEL_PROMPT = `You label a short video of one person doing a hands-on task (aboard a station or on a bench) so that a robot arm can try to repeat it. Watch the whole clip. Return one JSON object only, no prose, shaped like this:
{"version":1,"title":string,"summary":string,
 "objects":[{"id":string,"name":string,"shape":"cylinder"|"box"|"sphere","size_mm":[number,number,number],"symmetry":"none"|"axial"|"full","role":"manipulated"|"fixture"|"obstacle"|"surface","pose":{"xyz_mm":[x,y,z],"yaw_deg":number,"frame":"world"},"pocket_clearance_mm":number,"confidence":number,"source":"vl#seg<n>"}],
 "steps":[{"id":"s1","verb":"reach"|"grasp"|"move"|"insert"|"place"|"release"|"retract","object":<object id>,"target":{"fixture":"pocket"|"zone"|"stack","frame":<object id>},"t_start_s":number,"t_end_s":number,"source":"vl#seg<n>"}],
 "anchor":{"t_s":number,"confidence":number},
 "warnings":[string],"open_questions":[string]}
Rules:
- Objects are primitives. A cylinder's size_mm is [diameter, diameter, height]; a box's [x, y, z]; a sphere's [d, d, d]; millimetres, 5 to 300 mm. A size outside that range goes to warnings.
- symmetry: axial for a cylinder whose yaw does not matter, full for a sphere, none otherwise. role: manipulated for what the hand moves, fixture for what receives it, obstacle for anything in the way, surface for what everything rests on.
- Each insert or place step names its target as one of three fixtures: pocket (into a hole, holder, sleeve or connector), zone (onto an area of a surface), stack (on top of another object). Anything else becomes zone with a warning.
- Steps in time order, in seconds from the start of the clip, not overlapping, t_end_s >= t_start_s. If the task repeats, label every repetition.
- World frame: origin where a robot base would meet the work surface, x away from the robot, y to its left, z up. Give a pose only when the scene gives you a scale; otherwise leave pose out and add an open question naming the object.
- pocket_clearance_mm only for fixtures with a pocket, and only if you can see it; otherwise leave it out.
- confidence 0 to 1 per object. Anything you are unsure of gets a lower confidence and an open question that names the field.
- anchor is the grasp moment of the first grasp.
- source names the segment you saw it in, e.g. "vl#seg2".`;

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

const INTERVIEW_SYSTEM = `You interview the person who did the task in the clip, so that a robot arm can repeat it. The open slots you are given are what the robot's compiler could not fill and what the vision model was unsure of; you ask about them, one question per turn, the most consequential first, never twice about what the transcript already covers (tolerances, grasp, success criteria, hazards, recovery). Each question cites a measurement from this clip (a step time, a token span, an aperture or an offset from the watch tokens) so the person knows what you are looking at, and is answerable in one sentence. Offer 2 to 4 short answer chips.
When the person has just answered, turn that answer into spec changes: {"path":<spec path>,"value":<JSON value>,"source":"interview#<turn of that answer>"}. Paths: objects[<id>].<field>, steps[<id>].<field> or steps[<id>].<field>.<sub>, anchor.<field>, open_questions. Tolerances are half-widths in the axis unit (${AXES}). steps[<id>].success is a full array of predicates {"kind","object","target","value"} with kind in: ${PREDICATES}. Poses are {"xyz_mm":[x,y,z],"yaw_deg":number,"frame":"world"}. "I don't know" becomes an open_questions entry and a wider band.
Return one JSON object only, keys in this order: {"question":string,"chips":[string],"why":string,"done":boolean,"changes":[...]}. If an answer does not fit its question, record it as an open_questions entry and move on to the next slot. Set done true and question "" only when no open slot is left or when you are told to close.`;

const SABOTEUR_SYSTEM = `You are the saboteur. Write exactly 12 perturbation scenarios that try to break the robot program in simulation; the simulator runs each one twice, blind (the program gets the nominal pose) and sensed (it gets the perturbed pose). Return one JSON object only:
{"scenarios":[{"id":"sc1","name":string,"axis":<axis>,"offset":number,"object":<object id>,"tilt_axis":"x"|"y","pose_noise_mm":number,"seed":integer,"gravity_g":1|0.1654|0,"expected":"pass"|"fail"|"unknown","why":string}]}
tilt_axis only for tilt_deg; pose_noise_mm and seed only when you add observation noise. Axes: ${AXES}; offsets are signed, in the axis unit.
Rules: choose the axes from object symmetry and the tight constraint. Drop yaw_deg for axially or fully symmetric objects. For pocket fixtures use clearance_mm and the fixture's pose error; tilt for stacks; obstacles if there are any. Bracket each tolerance band from the interview on both signs: some offsets inside the band (expected pass), some at its edge (unknown), some beyond it (expected fail). At least two scenarios at Moon gravity (0.1654) and two in orbit (0). Each why cites the spec field or the interview answer it tests, in one sentence.`;

const NOTES_SYSTEM = `You read the worst failure of a simulated rehearsal and propose exactly one change to the task spec that would most likely make the program pass without hiding the failure: never widen a success threshold or a tolerance just to pass. Return one JSON object only:
{"changes":[{"path":string,"value":<JSON value>,"source":"notes#1"}],"why":string,"expected_effect":string}
Paths as in the spec: objects[<id>].<field>, steps[<id>].<field> or steps[<id>].<field>.<sub>. via_points are a full array of {"frame":<id or "world">,"xyz_mm":[x,y,z],"source":string}.`;

const RESHOOT_SYSTEM = `You review the simulated rehearsal of a task a robot learned from one video clip and an interview with the person in it. Then you tell the data team what to film again.
1. Classify every failed rollout into one failure class, with evidence: spec_gap (the spec lacks or misstates a value the program needed), footage_gap (the clip does not show what is needed: occluded, out of frame, too fast, no scale reference), embodiment_limit (the SO-101 cannot do it: reach, aperture, payload), simulator_artefact (the geometric grasp proxy or the primitive shapes caused it; cite the metric). Group failures that share a cause.
2. Write the reshoot list. Only fields whose source is vl#... or interview#... can be reshot or re-asked; a field from default, notes# or user#edit is never on the list. Each item says what to film or ask again and how (camera angle, distance, a ruler or a known object in frame, slower motion, a second take).
3. List the open risks a QA desk should know before buying 500 more demonstrations of this task.
Return one JSON object only:
{"failure_classes":[{"class":"spec_gap"|"footage_gap"|"embodiment_limit"|"simulator_artefact","scenarios":[<scenario id>],"modes":["blind"|"sensed"],"evidence":string}],
 "reshoot":[{"field":<spec path>,"source":string,"why":string,"how":string,"priority":1|2|3}],
 "open_risks":[string],"summary":string}`;

/** What the Watch stage would hand over: one token per labelled step, with deterministic wrist numbers. */
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

/** Deterministic stand-in for the 12 x {sensed, blind} MuJoCo grid. */
function syntheticRollouts(spec, scenarios) {
  const BAND = { blind: { x_mm: 4, y_mm: 4, z_mm: 6, yaw_deg: 8, tilt_deg: 6, clearance_mm: -1, pose_noise_mm: Infinity }, sensed: { x_mm: 25, y_mm: 25, z_mm: 15, yaw_deg: 20, tilt_deg: 10, clearance_mm: -1.5, pose_noise_mm: 6 } };
  const target = (spec.steps ?? []).find((s) => s.verb === "insert" || s.verb === "place") ?? spec.steps?.[0] ?? { id: "s1" };
  const out = [];
  for (const sc of scenarios.slice(0, 12)) {
    for (const mode of ["sensed", "blind"]) {
      const band = BAND[mode][sc.axis] ?? 5;
      const off = Number(sc.offset) || 0;
      const g = Number(sc.gravity_g ?? 1);
      const scale = g === 0 ? 0.75 : 1;
      const pass = sc.axis === "clearance_mm" ? off >= band * scale : Math.abs(off) <= band * scale;
      out.push({
        scenario_id: sc.id,
        mode,
        pass,
        gravity_g: g,
        ...(pass ? {} : { failed_step_id: target.id, failed_predicate: { kind: sc.axis === "tilt_deg" ? "tilt_under" : "inside_zone", object: target.object, target: target.target?.frame } }),
        metrics: { lateral_error_mm: Number((Math.abs(off) * (mode === "blind" ? 1 : 0.15)).toFixed(1)), min_clearance_mm: Number((2 - Math.abs(off) * 0.6).toFixed(1)), tilt_deg: Number((sc.axis === "tilt_deg" ? Math.abs(off) : 1.2).toFixed(1)) },
        seconds: Number((4.2 + (g === 0 ? 1.1 : 0) + (pass ? 0 : 0.8)).toFixed(1)),
      });
    }
  }
  return out;
}

function failureNote(spec, scenarios, rollouts) {
  const fails = rollouts.filter((r) => !r.pass);
  const worst = fails.sort((a, b) => b.metrics.lateral_error_mm - a.metrics.lateral_error_mm)[0] ?? rollouts[0];
  const sc = scenarios.find((s) => s.id === worst?.scenario_id) ?? {};
  const joints = Array.from({ length: 10 }, (_, k) => {
    const t = (3 + k * 0.5).toFixed(1);
    const q = [12 + k * 1.5, -38 + k * 2.1, 71 - k * 1.8, -24 + k * 0.6, 3 + k * 0.2, k < 4 ? 30 : 4.5].map((v) => v.toFixed(1));
    return `t=${t} s  pan ${q[0]}  lift ${q[1]}  elbow ${q[2]}  wrist_flex ${q[3]}  wrist_roll ${q[4]}  gripper ${q[5]}`;
  }).join("\n");
  return `Worst failure: scenario ${sc.id ?? "?"} "${sc.name ?? ""}" (${sc.axis} ${sc.offset} on ${sc.object}, gravity ${sc.gravity_g ?? 1} g), mode ${worst?.mode}: FAIL at step ${worst?.failed_step_id}, predicate ${JSON.stringify(worst?.failed_predicate ?? {})} false.
Metrics: ${JSON.stringify(worst?.metrics ?? {})}, seconds ${worst?.seconds}.
Grid: ${rollouts.filter((r) => r.pass).length} of ${rollouts.length} rollouts pass (sensed ${rollouts.filter((r) => r.pass && r.mode === "sensed").length}, blind ${rollouts.filter((r) => r.pass && r.mode === "blind").length}).
Joint log excerpt (degrees, every 0.5 s):
${joints}`;
}

/** If Label fails the session still runs downstream, on this spec (flagged in the results). */
const FALLBACK_SPEC = {
  version: 1,
  title: "seed film into plant pillow",
  summary: "Pick up a strip of seed film and push it into the pocket of a plant pillow.",
  objects: [
    { id: "film", name: "seed film", shape: "box", size_mm: [12, 1, 60], symmetry: "none", role: "manipulated", confidence: 0.5, source: "default" },
    { id: "pillow", name: "plant pillow", shape: "box", size_mm: [100, 100, 60], symmetry: "none", role: "fixture", confidence: 0.5, source: "default" },
  ],
  steps: [
    { id: "s1", verb: "grasp", object: "film", t_start_s: 2, t_end_s: 4, source: "default" },
    { id: "s2", verb: "insert", object: "film", target: { fixture: "pocket", frame: "pillow" }, t_start_s: 4, t_end_s: 9, source: "default" },
  ],
  warnings: [],
  open_questions: [],
};

// --- One call ----------------------------------------------------------------
let totalCost = 0;
class BudgetStop extends Error {}

async function call(ctx, stage, role, { system, user, maxTokens, thinking = "off", json = true, video = false }) {
  const model = MODELS[role];
  const p = PRICES[model];
  const textChars = (system?.length ?? 0) + (typeof user === "string" ? user.length : LABEL_PROMPT.length);
  // chars/3 plus 100 tokens of chat-template overhead (a 27-char health prompt is billed as 23 tokens)
  const estPrompt = Math.ceil(textChars / 3) + 100 + (video ? Math.ceil(clipSeconds * 250) : 0);
  const worst = estPrompt * p.prompt + maxTokens * p.completion;
  if (ctx.cost + worst > MAX_RUN_USD || totalCost + worst > MAX_TOTAL_USD)
    throw new BudgetStop(`stopped before ${stage}: run at $${ctx.cost.toFixed(4)}, worst case of the next call $${worst.toFixed(4)}, cap $${MAX_RUN_USD} per run / $${MAX_TOTAL_USD} total`);

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });
  const params = { model, messages, max_tokens: maxTokens };
  if (json) params.response_format = { type: "json_object" };
  if (thinking === "off") Object.assign(params, thinkingOff());

  // reserve the worst case on the shared ledger (throws BudgetError past the global or --ledger-cap-usd cap)
  let reservation;
  try {
    reservation = guard(worst, { script: SCRIPT, capUsd: LEDGER_CAP_USD, meta: { model, stage, run: ctx.run } });
  } catch (err) {
    if (err instanceof BudgetError) throw new BudgetStop(`stopped before ${stage}: ${err.message}`);
    throw err;
  }
  const started = performance.now();
  const rec = { stage, role, model, thinking, max_tokens: maxTokens, prompt_text_chars: textChars, video_bytes: video ? proxyBytes : undefined };
  let res;
  try {
    res = await client.chat.completions.create(params);
  } catch (err) {
    // the server may have done the work before the error or timeout: charge the reserved estimate
    charge(SCRIPT, worst, { model, stage, run: ctx.run, estimated: true, failed: true, status: err?.status ?? null }, reservation);
    logCall(SCRIPT, { stage, params, error: `${err?.status ?? "?"} ${redact(err?.message ?? err)}`.slice(0, 300), cost_usd: worst, meta: { role, run: ctx.run, estimated: true }, session: ctx.session, parent: ctx.lastCall });
    ctx.cost += worst;
    totalCost += worst;
    Object.assign(rec, { ok: false, ms: Math.round(performance.now() - started), status: err?.status ?? null, error: redact(err?.message ?? err).slice(0, 300), cost_usd: 0, estimated_usd: worst, prompt_tokens: 0, completion_tokens: 0 });
    ctx.calls.push(rec);
    console.log(`  ${stage.padEnd(10)} ${role.padEnd(5)} FAILED HTTP ${rec.status ?? "?"}: ${rec.error} (charged its estimate $${worst.toFixed(5)})`);
    return { rec, parsed: null, text: "" };
  }
  const msg = res.choices?.[0]?.message ?? {};
  const text = msg.content ?? "";
  const reasoning = msg.reasoning_content ?? msg.reasoning ?? "";
  const u = usageOf(res);
  const cost = costOf(model, u);
  charge(SCRIPT, cost, { model, stage, run: ctx.run, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens }, reservation);
  ctx.lastCall = logCall(SCRIPT, { stage, params, res, usage: u, cost_usd: cost, meta: { role, run: ctx.run }, session: ctx.session, parent: ctx.lastCall }) ?? ctx.lastCall;
  Object.assign(rec, {
    ok: true,
    ms: Math.round(performance.now() - started),
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    reasoning_tokens: u.reasoning_tokens ?? null,
    cached_tokens: u.cached_tokens ?? null,
    reasoning_chars: reasoning.length,
    content_chars: text.length,
    finish: res.choices?.[0]?.finish_reason ?? null,
    cost_usd: cost,
  });
  ctx.cost += cost;
  totalCost += cost;
  const parsed = json ? parseJson(text) : null;
  if (DEBUG_DIR) writeFileSync(path.join(DEBUG_DIR, `run${ctx.run}-${String(ctx.calls.length + 1).padStart(2, "0")}-${stage}.txt`), `${typeof user === "string" ? user : LABEL_PROMPT}\n\n--- output ---\n${text}\n`);
  rec.json_ok = json ? parsed !== null : null;
  rec.empty = text.trim() === "";
  ctx.calls.push(rec);
  const flag = rec.empty ? " EMPTY" : json && !rec.json_ok ? " BAD-JSON" : "";
  console.log(`  ${stage.padEnd(10)} ${role.padEnd(5)} ${String(rec.ms).padStart(6)} ms  in ${String(u.prompt_tokens).padStart(5)}  out ${String(u.completion_tokens).padStart(5)}${u.reasoning_tokens ? ` (reasoning ${u.reasoning_tokens})` : reasoning.length ? ` (reasoning ${reasoning.length} chars)` : ""}  $${cost.toFixed(5)}  ${rec.finish}${flag}`);
  return { rec, parsed, text };
}

// --- One session --------------------------------------------------------------
async function session(run) {
  const ctx = { run, calls: [], cost: 0, notes: [], session: `${SCRIPT}/${new Date().toISOString()}/run${run}`, lastCall: null };
  const shape = {};
  const started = performance.now();
  try {
    // health: exactly what app/api/health/route.ts sends (default thinking, 5 tokens)
    await call(ctx, "health", "nano", { user: "Reply with the single word ok.", maxTokens: 5, thinking: "default", json: false });

    // label
    const label = await call(ctx, "label", "vl", {
      user: [
        { type: "text", text: LABEL_PROMPT },
        { type: "video_url", video_url: { url: VIDEO_URI } },
      ],
      maxTokens: 3000,
      video: true,
    });
    let spec = label.parsed && Array.isArray(label.parsed.objects) && Array.isArray(label.parsed.steps) && label.parsed.steps.length ? label.parsed : null;
    if (!spec) {
      ctx.notes.push("label output unusable; downstream ran on the fallback spec");
      spec = structuredClone(FALLBACK_SPEC);
    }
    spec.provenance = { label_input: "video", model: MODELS.vl };
    shape.label = { objects: spec.objects.length, steps: spec.steps.length, open_questions: (spec.open_questions ?? []).length, used_fallback: !label.parsed };
    label.rec.shape = shape.label;
    const tokens = watchTokens(spec);

    // compile
    let program = null;
    const compile = async (why) => {
      const r = await call(ctx, "compile", "nano", { system: COMPILE_SYSTEM, user: `Task spec:\n${JSON.stringify(spec)}`, maxTokens: 3000 });
      if (r.parsed && Array.isArray(r.parsed.steps)) program = r.parsed;
      else ctx.notes.push(`compile (${why}) unusable; previous program kept`);
      r.rec.shape = { after: why, steps: program?.steps?.length ?? 0, ops: (program?.steps ?? []).reduce((n, s) => n + (s.ops?.length ?? 0), 0), asks: askSlots(program).length };
      return r;
    };
    await compile("label");
    shape.first_compile_asks = askSlots(program).length;

    // interview: question k is answered, the answer comes back on turn k+1 as changes[], then recompile
    const transcript = [];
    let asked = 0;
    let lastAnswer = null;
    let slots = openSlots(program, spec);
    shape.interview = { questions: 0, calls: 0, changes_proposed: 0, changes_applied: 0, ended: "" };
    if (!slots.length) shape.interview.ended = "no ask slot and no open question after the first compile";
    for (let turn = 1; slots.length || lastAnswer; turn++) {
      const closing = asked >= MAX_QUESTIONS || (lastAnswer && !slots.length);
      const user = [
        `Task spec:\n${JSON.stringify(spec)}`,
        `Open slots (the compiler's asks, then the vision model's open questions):\n${slots.map((s) => `- ${s.slot} (step ${s.step_id}): ${s.question}${s.why ? ` [${s.why}]` : ""}`).join("\n") || "(none)"}`,
        `Watch tokens:\n${tokens}`,
        `Transcript so far:\n${transcript.map((t, i) => `Q${i + 1}: ${t.q}\nA${i + 1}: ${t.a}`).join("\n") || "(none)"}`,
        lastAnswer ? `The person just answered question ${asked} (turn ${asked}): "${lastAnswer}". Turn it into changes with source "interview#${asked}".` : "No answer yet: this is the first turn.",
        closing ? "This is the closing turn: turn the latest answer into changes, ask nothing, set done true." : `Questions asked so far: ${asked} of at most ${MAX_QUESTIONS}. Ask the next one.`,
      ].join("\n\n");
      const r = await call(ctx, "interview", "super", { system: INTERVIEW_SYSTEM, user, maxTokens: 1200 });
      shape.interview.calls++;
      const t = r.parsed ?? {};
      const changes = Array.isArray(t.changes) ? t.changes : [];
      let applied = 0;
      if (lastAnswer) {
        applied = applyAll(spec, changes);
        shape.interview.changes_proposed += changes.length;
        shape.interview.changes_applied += applied;
      }
      r.rec.shape = { turn, closing: Boolean(closing), done: Boolean(t.done), question_chars: String(t.question ?? "").length, chips: Array.isArray(t.chips) ? t.chips.length : 0, changes: changes.length, applied };
      if (lastAnswer) {
        await compile(`answer ${asked}`);
        slots = openSlots(program, spec);
      }
      lastAnswer = null;
      if (closing || t.done || !String(t.question ?? "").trim()) {
        shape.interview.ended = closing ? (asked >= MAX_QUESTIONS ? "closing turn after 5 questions" : "closing turn, no slots left") : t.done ? "model said done" : "no question returned";
        if (!r.parsed) ctx.notes.push(`interview turn ${turn} unusable; interview ended`);
        break;
      }
      asked++;
      lastAnswer = cannedAnswer(String(t.question), t.chips);
      transcript.push({ q: String(t.question), a: lastAnswer });
    }
    shape.interview.questions = asked;
    shape.interview.slots_left = slots.length;

    // saboteur
    const sab = await call(ctx, "saboteur", "super", { system: SABOTEUR_SYSTEM, user: `Task spec:\n${JSON.stringify(spec)}\n\nProgram:\n${JSON.stringify(program)}\n\nInterview:\n${transcript.map((t, i) => `Q${i + 1}: ${t.q}\nA${i + 1}: ${t.a}`).join("\n")}`, maxTokens: 3000 });
    let scenarios = Array.isArray(sab.parsed?.scenarios) ? sab.parsed.scenarios : [];
    sab.rec.shape = { scenarios: scenarios.length, expected_fail: scenarios.filter((s) => s.expected === "fail").length, gravities: [...new Set(scenarios.map((s) => s.gravity_g))] };
    if (!scenarios.length) {
      ctx.notes.push("saboteur output unusable; synthetic scenarios used downstream");
      scenarios = Array.from({ length: 12 }, (_, i) => ({ id: `sc${i + 1}`, name: `x shift ${i - 6} mm`, axis: "x_mm", offset: (i - 6) * 2, object: spec.objects[1]?.id ?? spec.objects[0]?.id, gravity_g: 1, expected: "unknown" }));
    }
    const rollouts = syntheticRollouts(spec, scenarios);
    shape.rollouts = { total: rollouts.length, pass: rollouts.filter((r) => r.pass).length, synthetic: true };

    // notes: one patch from the worst failure, then recompile
    const note = failureNote(spec, scenarios, rollouts);
    const notes = await call(ctx, "notes", "super", { system: NOTES_SYSTEM, user: `${note}\n\nTask spec:\n${JSON.stringify(spec)}\n\nProgram:\n${JSON.stringify(program)}`, maxTokens: 800 });
    const nChanges = Array.isArray(notes.parsed?.changes) ? notes.parsed.changes.length : 0;
    const nApplied = applyAll(spec, notes.parsed?.changes);
    notes.rec.shape = { changes: nChanges, applied: nApplied };
    const notesCompile = await compile("notes patch");
    notesCompile.rec.stage = "notes";

    // reshoot (Ultra, background in the app)
    const reshoot = await call(ctx, "reshoot", "ultra", {
      system: RESHOOT_SYSTEM,
      user: `Task spec (with per-field sources):\n${JSON.stringify(spec)}\n\nProgram:\n${JSON.stringify(program)}\n\nScenarios:\n${JSON.stringify(scenarios)}\n\nRollouts (12 scenarios x sensed, blind):\n${JSON.stringify(rollouts)}\n\nInterview:\n${transcript.map((t, i) => `Q${i + 1}: ${t.q}\nA${i + 1}: ${t.a}`).join("\n")}\n\nNotes patch tried: ${JSON.stringify(notes.parsed ?? {})}`,
      maxTokens: 16000,
      thinking: ULTRA_THINKING === "on" ? "default" : "off",
    });
    reshoot.rec.shape = {
      failure_classes: Array.isArray(reshoot.parsed?.failure_classes) ? reshoot.parsed.failure_classes.length : 0,
      reshoot_items: Array.isArray(reshoot.parsed?.reshoot) ? reshoot.parsed.reshoot.length : 0,
      open_risks: Array.isArray(reshoot.parsed?.open_risks) ? reshoot.parsed.open_risks.length : 0,
    };
  } catch (err) {
    if (!(err instanceof BudgetStop)) throw err;
    ctx.aborted = err.message;
    console.log(`  ! ${err.message}`);
  }
  const wallMs = Math.round(performance.now() - started);
  return { run, wall_ms: wallMs, aborted: ctx.aborted ?? null, notes: ctx.notes, shape, totals: totalsOf(ctx.calls), by_stage: groupBy(ctx.calls, "stage"), by_model: groupBy(ctx.calls, "role"), calls: ctx.calls };
}

function totalsOf(calls) {
  const sum = (k) => calls.reduce((n, c) => n + (c[k] ?? 0), 0);
  return {
    calls: calls.length,
    failed: calls.filter((c) => !c.ok).length,
    empty: calls.filter((c) => c.empty).length,
    bad_json: calls.filter((c) => c.json_ok === false).length,
    prompt_tokens: sum("prompt_tokens"),
    completion_tokens: sum("completion_tokens"),
    reasoning_tokens: sum("reasoning_tokens"),
    total_tokens: sum("prompt_tokens") + sum("completion_tokens"),
    cost_usd: Number(sum("cost_usd").toFixed(6)),
    latency_ms: sum("ms"),
  };
}
function groupBy(calls, key) {
  const out = {};
  for (const c of calls) (out[c[key]] ??= []).push(c);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, totalsOf(v)]));
}
const stat = (xs) => ({ mean: Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(6)), min: Math.min(...xs), max: Math.max(...xs) });

// --- Main -----------------------------------------------------------------------
const runs = [];
for (let r = 1; r <= RUNS; r++) {
  console.log(`\nrun ${r} of ${RUNS}`);
  const s = await session(r);
  runs.push(s);
  console.log(`  = ${s.totals.calls} calls, ${s.totals.total_tokens} tokens, $${s.totals.cost_usd.toFixed(4)}, wall ${(s.wall_ms / 1000).toFixed(1)} s`);
  if (s.aborted || s.totals.cost_usd > MAX_RUN_USD) {
    console.log("  ! stopping: budget cap reached");
    break;
  }
}

const complete = runs.filter((s) => !s.aborted);
const STAGES = ["health", "label", "compile", "interview", "saboteur", "notes", "reshoot"];
const summary = complete.length
  ? {
      runs: complete.length,
      per_session: {
        calls: stat(complete.map((s) => s.totals.calls)),
        prompt_tokens: stat(complete.map((s) => s.totals.prompt_tokens)),
        completion_tokens: stat(complete.map((s) => s.totals.completion_tokens)),
        reasoning_tokens: stat(complete.map((s) => s.totals.reasoning_tokens)),
        total_tokens: stat(complete.map((s) => s.totals.total_tokens)),
        cost_usd: stat(complete.map((s) => s.totals.cost_usd)),
        wall_s: stat(complete.map((s) => s.wall_ms / 1000)),
      },
      by_stage: Object.fromEntries(
        STAGES.map((st) => {
          const rows = complete.map((s) => s.by_stage[st] ?? totalsOf([]));
          return [st, { calls: stat(rows.map((x) => x.calls)), prompt_tokens: stat(rows.map((x) => x.prompt_tokens)), completion_tokens: stat(rows.map((x) => x.completion_tokens)), cost_usd: stat(rows.map((x) => x.cost_usd)), latency_s: stat(rows.map((x) => x.latency_ms / 1000)) }];
        }),
      ),
      by_model: Object.fromEntries(
        Object.keys(MODELS).map((role) => {
          const rows = complete.map((s) => s.by_model[role] ?? totalsOf([]));
          return [role, { model: MODELS[role], calls: stat(rows.map((x) => x.calls)), total_tokens: stat(rows.map((x) => x.total_tokens)), cost_usd: stat(rows.map((x) => x.cost_usd)) }];
        }),
      ),
    }
  : null;

const result = {
  benchmark: "understudy session cost on Nebius Token Factory",
  date: new Date().toISOString(),
  reproduce: "UNDERSTUDY_ENV_FILE=<path to .env.local> node scripts/bench-session.mjs",
  previous_estimate: "about 18 requests and under $0.10 per session (docs/SPEC.md, section 4)",
  conditions: {
    base_url: TOKEN_FACTORY_BASE_URL,
    node: process.version,
    openai_sdk: JSON.parse(readFileSync(path.join(ROOT, "node_modules/openai/package.json"), "utf8")).version,
    models: MODELS,
    thinking: {
      health: "default (as app/api/health/route.ts); its 5 tokens all go to reasoning, so the content is empty and finish is length, which the route does not check",
      label: "off (chat_template_kwargs.enable_thinking=false)",
      compile: "off",
      interview: "off",
      saboteur: "off",
      notes: "off",
      reshoot: ULTRA_THINKING === "on" ? "default (on), max_tokens 16000, as SPEC section 4 sizes the background call" : "off",
    },
    max_tokens: { health: 5, label: 3000, compile: 3000, interview: 1200, saboteur: 3000, notes: 800, reshoot: 16000 },
    response_format: "json_object on every call except health",
    streaming: false,
    retries: 0,
    sequential: true,
    clip: { file: path.relative(ROOT, CLIP), seconds: clipSeconds, width: clipProbe.streams[0].width, height: clipProbe.streams[0].height, fps: clipProbe.streams[0].r_frame_rate },
    proxy: { width: proxyProbe.streams[0].width, height: proxyProbe.streams[0].height, fps: VIDEO_PROXY.fps, codec: proxyProbe.streams[0].codec_name, crf: CRF, bytes: proxyBytes, encode_ms: encMs, note: "VIDEO_PROXY in lib/providers/tokenfactory.ts (width 480); encoded once with ffmpeg, outside the timed sessions" },
    prices_per_million_tokens: Object.fromEntries(Object.entries(MODELS).map(([role, id]) => [role, PRICES[id] ? { prompt: PRICES[id].prompt * 1e6, completion: PRICES[id].completion * 1e6, cache_read: PRICES[id].cache_read == null ? null : PRICES[id].cache_read * 1e6 } : null])),
    prices_source: `tests/fixtures/models.json (list prices, fetched ${PRICES.fetched}); video and image inputs are priced 0 beyond their prompt tokens`,
    interview: `at most ${MAX_QUESTIONS} questions over the compiler's ask slots plus the label's open questions; each answer is canned (picked by keyword from the question, else its first chip) and comes back on the next Super turn as changes[]; the spec is patched and Nano recompiles after every answer; a closing turn folds in the last answer`,
    rollouts: "synthetic 12 x {sensed, blind} grid from fixed bands (no simulator); it only feeds the notes and reshoot prompts",
    excluded: ["Ground (Tavily search + extract, opt-in) and its Nano filter", "the reactive turn (stretch)", "GET /v1/models in health (not a chat call, unbilled)", "retries after a 400 (none happened unless listed in failures)"],
    caps: { per_run_usd: MAX_RUN_USD, total_usd: MAX_TOTAL_USD, ledger: `every call reserved on bench/results/ledger.jsonl before it is sent (global cap BENCH_CAP_USD${LEDGER_CAP_USD === undefined ? "" : `, ${SCRIPT} cap $${LEDGER_CAP_USD}`}); a failed call is charged at its reserved estimate` },
  },
  summary,
  failures: runs.flatMap((s) => s.calls.filter((c) => !c.ok || (c.empty && c.stage !== "health") || c.json_ok === false).map((c) => ({ run: s.run, stage: c.stage, role: c.role, status: c.status ?? null, error: c.error ?? null, finish: c.finish ?? null, empty: c.empty ?? null, json_ok: c.json_ok ?? null }))),
  runs,
};

let body = JSON.stringify(result, null, 2) + "\n";
if (body.includes(process.env.NEBIUS_API_KEY)) body = redact(body);
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, body);

// --- Markdown for the caller ------------------------------------------------------
const usd = (x) => `$${x.toFixed(4)}`;
const rng = (s, f) => `${f(s.mean)} (${f(s.min)}-${f(s.max)})`;
if (summary) {
  const n = (x) => Math.round(x).toLocaleString("en-US");
  console.log(`\n| Stage | Model | Calls | Prompt tokens | Completion tokens | Cost | Latency |\n|---|---|---|---|---|---|---|`);
  for (const st of STAGES) {
    const b = summary.by_stage[st];
    const roles = [...new Set(complete.flatMap((s) => s.calls.filter((c) => c.stage === st).map((c) => c.role)))].join(" + ");
    console.log(`| ${st} | ${roles} | ${rng(b.calls, (x) => x.toFixed(1).replace(/\.0$/, ""))} | ${rng(b.prompt_tokens, n)} | ${rng(b.completion_tokens, n)} | ${rng(b.cost_usd, usd)} | ${rng(b.latency_s, (x) => `${x.toFixed(1)} s`)} |`);
  }
  const p = summary.per_session;
  console.log(`\nPer session over ${complete.length} runs, mean (min-max): ${rng(p.calls, (x) => x.toFixed(1))} calls, ${rng(p.total_tokens, n)} tokens (${rng(p.prompt_tokens, n)} in, ${rng(p.completion_tokens, n)} out), ${rng(p.cost_usd, usd)}, wall ${rng(p.wall_s, (x) => `${x.toFixed(0)} s`)}`);
}
console.log(`\nwrote ${path.relative(ROOT, OUT)}; spent ${usd(totalCost)} in total`);
