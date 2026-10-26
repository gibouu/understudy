// Label robustness on Nebius Token Factory, measured: what makes Super VL read the clip right.
//
//   UNDERSTUDY_ENV_FILE=/path/to/.env.local node scripts/bench-label.mjs [--runs 5] [--clips iss,dev]
//        [--conditions a,b,c,d,e,f,g] [--out bench/results/label.json] [--cap-usd 15]
//
// Known problem: on samples/iss-veggie-seed-film.mp4 (an astronaut tucking seed film into the plant
// pillows of the Veggie facility) Super VL reports "battery packs" or "hard-drive units in a six-slot
// tray". This script labels both sample clips under seven input conditions, N runs each, and scores
// every label against a hand-made ground truth (bench/specs/label/*.json) with the fixed rubric below.
//
//   a  video proxy 480 wide, 4 fps (the app's Label input, as scripts/bench-session.mjs sends it)
//   b  video proxy 480 wide, 8 fps
//   c  video proxy 480 wide, 2 fps
//   d  6 keyframes (640 wide, captioned with their time) plus one 12-frame montage: 7 images, the fallback
//   e  a + a one-line context hint a user would plausibly type (per clip, see HINTS)
//   f  a with thinking on (no enable_thinking:false) and a 4k budget (max_tokens 4000, as docs/FEEDBACK.md counts budgets)
//   g  video proxy 960 wide, 4 fps (extra: is it resolution?)
// Follow-up conditions, run after a-g showed that no input change fixes the ISS misreading:
//   h  a + a hint naming the task in the user's words (ISS only: "planting seed film into the Veggie plant pillows")
//   i  a, cropped to the work area first (a fixed box around the hands' range, standing in for a wrist-tracked crop)
//   j  d with 1280-wide keyframes (full source width) instead of 640
//   k  i + the plausible hint of e
//
// --model <id> labels with another vision model from Token Factory instead of Super VL (issue #96, see
// scripts/compare-models.mjs): its own reasoning switch in place of enable_thinking, its spend on the ledger as
// compare-label under the comparison's cap, results in bench/results/compare-label.json by default. A model that
// cannot switch reasoning off gets max_tokens 8000 in every condition, so its reasoning fits.
//
// Every call: the prototype LABEL_PROMPT of scripts/bench-session.mjs (copied verbatim), json_object,
// temperature left at the model default, thinking off except f, max_tokens 3000 except f, no retries
// beyond one after a 429/5xx/timeout. Prices are list prices from tests/fixtures/models.json; every
// billed call is charged to bench/results/ledger.jsonl and guarded against the caps.
// Writes the parsed labels (object names, sizes, step verbs, targets) and scores; no prompts, no key.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BudgetError, charge, costOf, guard, loadPrices, spent } from "./bench-ledger.mjs";
import { COMPARATORS, COMPARE_CAP_USD, COMPARE_CATALOGUE, COMPARE_SCRIPTS } from "./compare-models.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");
if (!process.env.NEBIUS_API_KEY) throw new Error("NEBIUS_API_KEY missing from the env file");
const redact = (s) => String(s).split(process.env.NEBIUS_API_KEY).join("<redacted>");

const { MODELS, TOKEN_FACTORY_BASE_URL, thinkingOff, tokenFactory, usageOf } = await import(path.join(ROOT, "lib/providers/tokenfactory.ts"));

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const next = argv[i + 1];
  args[argv[i].slice(2)] = next === undefined || next.startsWith("--") ? true : next;
}
const RUNS = Number(args.runs ?? 5);
/** the model labelling: Super VL, or a comparator that reads video (issue #96) */
const MODEL = typeof args.model === "string" ? args.model : MODELS.vl;
const OTHER = MODEL === MODELS.vl ? null : COMPARATORS[MODEL];
if (MODEL !== MODELS.vl && !OTHER?.video) throw new Error(`${MODEL} is not a video comparator in scripts/compare-models.mjs`);
const SCRIPT = OTHER ? "compare-label" : "bench-label";
const OUT = path.resolve(ROOT, args.out ?? (OTHER ? "bench/results/compare-label.json" : "bench/results/label.json"));
/** my share of the experiment credit, shared with scripts/bench-interview.mjs; a comparator runs under the comparison's cap */
const MY_CAP_USD = OTHER ? COMPARE_CAP_USD : Number(args["cap-usd"] ?? 15);
const MINE = OTHER ? COMPARE_SCRIPTS : ["bench-label", "bench-interview"];
const CLIPS = String(args.clips ?? "iss,dev").split(",");
const CONDITIONS = String(args.conditions ?? "a,b,c,d,e,f,g").split(",");
const REPRODUCE = `UNDERSTUDY_ENV_FILE=<path to .env.local> node scripts/bench-label.mjs --runs ${RUNS} --clips ${CLIPS.join(",")} --conditions ${CONDITIONS.join(",")}${OTHER ? ` --model ${MODEL}` : ""}${args.out ? ` --out ${args.out}` : ""}`;

const client = tokenFactory({ timeout: 290_000, maxRetries: 0 });

// --- Prices: list prices from tests/fixtures/models.json; refuses to run when one is missing ---------
const PRICES = OTHER ? loadPrices([MODEL], COMPARE_CATALOGUE) : loadPrices([MODELS.vl]);
/** the request change for thinking off or on: enable_thinking for Nemotron, the comparator's own switch otherwise */
const reasoning = (thinking) => (OTHER ? (thinking === "off" ? OTHER.off : OTHER.on) : thinking === "off" ? thinkingOff() : {});
const maxTokens = (def) => (OTHER?.always_reasons ? 8000 : def.maxTokens);

// --- Prompt (verbatim from scripts/bench-session.mjs) ----------------------------
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

/** What a user would plausibly type in a one-line "context" box, per clip (condition e). */
const HINTS = { iss: "aboard the ISS, plant growth experiment", dev: "aboard the ISS, chess match" };
/** A hint that names the task itself (condition h): what someone who knows what they filmed might type. */
const TASK_HINTS = { iss: "aboard the ISS, planting seed film into the Veggie plant pillows" };
/** Work-area crops in source pixels (w:h:x:y of the 1280x720 clips), picked by hand to cover the hands' range. */
const CROPS = { iss: "760:520:300:180", dev: "640:420:400:180" };
const CLIP_FILES = { iss: "samples/iss-veggie-seed-film.mp4", dev: "samples/dev-clip.mp4" };
const TRUTH = { iss: "bench/specs/label/iss-veggie-seed-film.json", dev: "bench/specs/label/dev-clip.json" };

// --- Rubric (written before any run; see bench/specs/label/*.json for the truth) ----
// Five yes/no criteria per label; the score is how many hold (0-5). A label that does not parse fails all five.
// "Main object" is the object of the first insert or place step, else the first object with role
// manipulated, else the first object.
const RUBRIC = {
  iss: {
    verb: "some step has verb insert, or place with target.fixture pocket",
    object: "main object's name matches /seed|film|strip|tape/i and not /battery|drive|disk|hdd|ssd|cartridge|card|cell|module/i",
    fixture: "the first insert or place step's target.fixture is pocket",
    steps: "step count within truth 4 +-1 (3 to 5)",
    size: "main object's largest size_mm within a factor of 2 of 60 mm (30 to 120)",
    diagnostic_scene: "(not scored) some object name matches /pillow|plant|seed|veggie|root|growth/i and none matches /battery|hard.?drive|disk|hdd|ssd/i",
  },
  dev: {
    verb: "no step has verb grasp, move, insert, place or release (nothing is moved in the clip; reach and retract are tolerated)",
    object: "some object name matches /chess|board|piece|pawn|king|queen|knight|rook|bishop/i",
    fixture: "no step targets a pocket or a stack (zone or no target)",
    steps: "step count within truth 0 +-1 (0 or 1)",
    size: "the first object named /board/ has largest size_mm within a factor of 2 of 270 mm (135 to 540); else the first named /piece|pawn|king|queen|knight|rook|bishop/ within a factor of 2 of 45 mm (22.5 to 90)",
  },
};
const largest = (o) => (Array.isArray(o?.size_mm) ? Math.max(...o.size_mm.map(Number).filter(Number.isFinite)) : NaN);
const within2 = (v, truth) => Number.isFinite(v) && v >= truth / 2 && v <= truth * 2;
function mainObject(label) {
  const objs = Array.isArray(label.objects) ? label.objects : [];
  const step = (label.steps ?? []).find((s) => s?.verb === "insert" || s?.verb === "place");
  return (step && objs.find((o) => o?.id === step.object)) ?? objs.find((o) => o?.role === "manipulated") ?? objs[0] ?? null;
}
function score(clip, label) {
  if (!label || !Array.isArray(label.objects) || !Array.isArray(label.steps)) return { parsed: false, verb: false, object: false, fixture: false, steps: false, size: false, score: 0 };
  const steps = label.steps.filter(Boolean);
  const names = label.objects.map((o) => String(o?.name ?? ""));
  const main = mainObject(label);
  let r;
  if (clip === "iss") {
    const firstIP = steps.find((s) => s.verb === "insert" || s.verb === "place");
    r = {
      verb: steps.some((s) => s.verb === "insert" || (s.verb === "place" && s.target?.fixture === "pocket")),
      object: /seed|film|strip|tape/i.test(main?.name ?? "") && !/battery|drive|disk|hdd|ssd|cartridge|card|cell|module/i.test(main?.name ?? ""),
      fixture: firstIP?.target?.fixture === "pocket",
      steps: steps.length >= 3 && steps.length <= 5,
      size: within2(largest(main), 60),
      scene: names.some((n) => /pillow|plant|seed|veggie|root|growth/i.test(n)) && !names.some((n) => /battery|hard.?drive|disk|hdd|ssd/i.test(n)),
    };
  } else {
    const board = label.objects.find((o) => /board/i.test(o?.name ?? ""));
    const piece = label.objects.find((o) => /piece|pawn|king|queen|knight|rook|bishop/i.test(o?.name ?? ""));
    r = {
      verb: !steps.some((s) => ["grasp", "move", "insert", "place", "release"].includes(s.verb)),
      object: names.some((n) => /chess|board|piece|pawn|king|queen|knight|rook|bishop/i.test(n)),
      fixture: !steps.some((s) => s.target?.fixture === "pocket" || s.target?.fixture === "stack"),
      steps: steps.length <= 1,
      size: board ? within2(largest(board), 270) : piece ? within2(largest(piece), 45) : false,
    };
  }
  return { parsed: true, ...r, score: ["verb", "object", "fixture", "steps", "size"].filter((k) => r[k]).length };
}

// --- Inputs -------------------------------------------------------------------------
const tmp = path.join(os.tmpdir(), "understudy-bench");
mkdirSync(tmp, { recursive: true });
const CRF = 28;
const probe = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", file]).toString());
const b64 = (file, mime) => `data:${mime};base64,${readFileSync(file).toString("base64")}`;

function proxy(clip, width, fps, crop) {
  const src = path.join(ROOT, CLIP_FILES[clip]);
  const out = path.join(tmp, `${path.basename(src, ".mp4")}-${width}w-${fps}fps${crop ? "-crop" : ""}.mp4`);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", src, "-an", "-vf", `${crop ? `crop=${crop},` : ""}scale=${width}:-2,fps=${fps}`, "-c:v", "libx264", "-preset", "medium", "-crf", String(CRF), "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
  const p = probe(out);
  return { kind: "video", file: out, bytes: statSync(out).size, width: p.streams[0].width, height: p.streams[0].height, fps, crop: crop ?? null, uri: b64(out, "video/mp4") };
}
function keyframes(clip, n = 6, montageN = 12, width = 640) {
  const src = path.join(ROOT, CLIP_FILES[clip]);
  const dur = Number(probe(src).format.duration);
  const dir = path.join(tmp, `${clip}-keyframes-${width}`);
  mkdirSync(dir, { recursive: true });
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = Number((((i + 0.5) * dur) / n).toFixed(1));
    const f = path.join(dir, `k${i + 1}.jpg`);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", String(t), "-i", src, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4", f]);
    frames.push({ t, file: f, bytes: statSync(f).size });
  }
  const montage = path.join(dir, "montage.jpg");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", src, "-vf", `fps=${montageN}/${dur},scale=320:-2,tile=4x3`, "-frames:v", "1", "-q:v", "4", montage]);
  return { kind: "keyframes", frames, montage, montage_bytes: statSync(montage).size, seconds: dur, width };
}

function content(clip, cond, input) {
  if (input.kind === "keyframes") {
    const parts = [{ type: "text", text: `${LABEL_PROMPT}\nThe clip (${input.seconds.toFixed(0)} s) is given as ${input.frames.length} keyframes, each captioned with its time in seconds, then one montage of 12 frames in time order (left to right, top to bottom).` }];
    input.frames.forEach((f, i) => {
      parts.push({ type: "text", text: `keyframe ${i + 1} of ${input.frames.length}, t = ${f.t} s` });
      parts.push({ type: "image_url", image_url: { url: b64(f.file, "image/jpeg") } });
    });
    parts.push({ type: "text", text: "montage of 12 frames, left to right, top to bottom" });
    parts.push({ type: "image_url", image_url: { url: b64(input.montage, "image/jpeg") } });
    return parts;
  }
  const parts = [{ type: "text", text: LABEL_PROMPT }];
  const hint = CONDITION_DEFS[cond].hint?.[clip];
  if (hint) parts.push({ type: "text", text: `Context from the person who uploaded the clip: ${hint}` });
  parts.push({ type: "video_url", video_url: { url: input.uri } });
  return parts;
}

// --- Helpers (as scripts/bench-session.mjs) -------------------------------------------
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

const CONDITION_DEFS = {
  a: { name: "video 480w 4 fps (baseline)", input: (clip) => ["v480x4", () => proxy(clip, 480, 4)], thinking: "off", maxTokens: 3000 },
  b: { name: "video 480w 8 fps", input: (clip) => ["v480x8", () => proxy(clip, 480, 8)], thinking: "off", maxTokens: 3000 },
  c: { name: "video 480w 2 fps", input: (clip) => ["v480x2", () => proxy(clip, 480, 2)], thinking: "off", maxTokens: 3000 },
  d: { name: "6 keyframes + montage (7 images)", input: (clip) => ["kf", () => keyframes(clip)], thinking: "off", maxTokens: 3000 },
  e: { name: "baseline + one-line context hint", input: (clip) => ["v480x4", () => proxy(clip, 480, 4)], hint: HINTS, thinking: "off", maxTokens: 3000 },
  f: { name: "baseline, thinking on, 4k budget", input: (clip) => ["v480x4", () => proxy(clip, 480, 4)], thinking: "on", maxTokens: 4000 },
  g: { name: "video 960w 4 fps (extra)", input: (clip) => ["v960x4", () => proxy(clip, 960, 4)], thinking: "off", maxTokens: 3000 },
  h: { name: "baseline + hint naming the task", clips: ["iss"], input: (clip) => ["v480x4", () => proxy(clip, 480, 4)], hint: TASK_HINTS, thinking: "off", maxTokens: 3000 },
  i: { name: "work-area crop, 480w 4 fps", input: (clip) => ["v480x4crop", () => proxy(clip, 480, 4, CROPS[clip])], thinking: "off", maxTokens: 3000 },
  j: { name: "6 keyframes 1280w + montage", input: (clip) => ["kf1280", () => keyframes(clip, 6, 12, 1280)], thinking: "off", maxTokens: 3000 },
  k: { name: "work-area crop + one-line context hint", input: (clip) => ["v480x4crop", () => proxy(clip, 480, 4, CROPS[clip])], hint: HINTS, thinking: "off", maxTokens: 3000 },
};

const inputs = {};
function inputFor(clip, cond) {
  const [key, make] = CONDITION_DEFS[cond].input(clip);
  return (inputs[`${clip}:${key}`] ??= make());
}

async function label(clip, cond, run) {
  const def = CONDITION_DEFS[cond];
  const model = MODEL;
  const input = inputFor(clip, cond);
  const parts = content(clip, cond, input);
  const p = PRICES[model];
  const imgTokens = input.kind === "video" ? (input.width / 480) ** 2 * input.fps * 36 * 60 : 8 * 1500;
  const worst = (6000 + imgTokens) * p.prompt + maxTokens(def) * p.completion;
  const params = { model, messages: [{ role: "user", content: parts }], max_tokens: maxTokens(def), response_format: { type: "json_object" }, ...reasoning(def.thinking) };
  const rec = { clip, condition: cond, run, model, thinking: def.thinking, max_tokens: maxTokens(def), attempts: 0, estimated_usd: 0 };
  const meta = { model, stage: "label", clip, condition: cond, run };
  for (let attempt = 1; attempt <= 2; attempt++) {
    rec.attempts = attempt;
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
      Object.assign(rec, { ok: false, ms: Math.round(performance.now() - started), status, error: redact(err?.message ?? err).slice(0, 300), cost_usd: 0, score: score(clip, null) });
      if (attempt === 1 && (status === null || status === 429 || status >= 500)) {
        await sleep(5000);
        continue;
      }
      return rec;
    }
    const msg = res.choices?.[0]?.message ?? {};
    const text = msg.content ?? "";
    const u = usageOf(res);
    const cost = costOf(PRICES, model, u);
    charge(SCRIPT, cost, { ...meta, attempt, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens }, reservation);
    const parsed = parseJson(text);
    Object.assign(rec, {
      ok: true,
      ms: Math.round(performance.now() - started),
      prompt_tokens: u.prompt_tokens,
      completion_tokens: u.completion_tokens,
      reasoning_tokens: u.reasoning_tokens ?? null,
      reasoning_chars: String(msg.reasoning_content ?? msg.reasoning ?? "").length,
      finish: res.choices?.[0]?.finish_reason ?? null,
      cost_usd: cost,
      json_ok: parsed !== null,
      score: score(clip, parsed),
      label: parsed
        ? {
            title: String(parsed.title ?? ""),
            objects: (parsed.objects ?? []).map((o) => ({ id: o?.id, name: o?.name, shape: o?.shape, size_mm: o?.size_mm, role: o?.role, confidence: o?.confidence })),
            steps: (parsed.steps ?? []).map((s) => ({ id: s?.id, verb: s?.verb, object: s?.object, target: s?.target, t: [s?.t_start_s, s?.t_end_s] })),
            warnings: (parsed.warnings ?? []).length,
            open_questions: (parsed.open_questions ?? []).length,
          }
        : null,
    });
    return rec;
  }
  return rec;
}

// --- Main ----------------------------------------------------------------------------
for (const clip of CLIPS) if (!existsSync(path.join(ROOT, TRUTH[clip]))) throw new Error(`no ground truth for ${clip}`);
const runs = [];
let stopped = null;
try {
  for (let r = 1; r <= RUNS; r++) {
    for (const clip of CLIPS) {
      for (const cond of CONDITIONS) {
        if (CONDITION_DEFS[cond].clips && !CONDITION_DEFS[cond].clips.includes(clip)) continue;
        const rec = await label(clip, cond, r);
        runs.push(rec);
        // a model the host no longer serves fails every call alike: stop rather than charge them all (the call is recorded above)
        if (rec.status === 404) throw new BudgetError(`${rec.model}: HTTP 404, not served by Token Factory any more`);
        const s = rec.score;
        console.log(`${clip} ${cond} run ${r}: ${rec.ok ? `${String(rec.ms).padStart(6)} ms in ${String(rec.prompt_tokens).padStart(6)} out ${String(rec.completion_tokens).padStart(5)} $${rec.cost_usd.toFixed(5)} ${rec.finish}` : `FAILED ${rec.status}: ${rec.error}`}  score ${s.score}/5 [${["verb", "object", "fixture", "steps", "size"].map((k) => (s[k] ? k : "-")).join(" ")}]${clip === "iss" && s.parsed ? ` scene ${s.scene ? "ok" : "WRONG"}` : ""}  main="${rec.label ? mainObject({ objects: rec.label.objects, steps: rec.label.steps.map((x) => ({ ...x })) })?.name ?? "" : ""}"`);
      }
    }
  }
} catch (err) {
  if (!(err instanceof BudgetError)) throw err;
  stopped = err.message;
  console.log(`! ${err.message}`);
}

const stat = (xs) => (xs.length ? { mean: Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(6)), min: Math.min(...xs), max: Math.max(...xs) } : null);
const summary = {};
for (const clip of CLIPS) {
  summary[clip] = {};
  for (const cond of CONDITIONS) {
    const rs = runs.filter((x) => x.clip === clip && x.condition === cond);
    if (!rs.length) continue;
    const ok = rs.filter((x) => x.ok);
    const count = (k) => rs.filter((x) => x.score[k]).length;
    summary[clip][cond] = {
      condition: CONDITION_DEFS[cond].name,
      runs: rs.length,
      failed_calls: rs.length - ok.length,
      json_ok: rs.filter((x) => x.json_ok).length,
      finish_length: rs.filter((x) => x.finish === "length").length,
      accuracy: Number((rs.reduce((n, x) => n + x.score.score, 0) / (5 * rs.length)).toFixed(3)),
      perfect: rs.filter((x) => x.score.score === 5).length,
      criteria: { verb: count("verb"), object: count("object"), fixture: count("fixture"), steps: count("steps"), size: count("size"), ...(clip === "iss" ? { scene_diagnostic: count("scene") } : {}) },
      main_object_names: rs.map((x) => (x.label ? mainObject({ objects: x.label.objects, steps: x.label.steps }) : null)?.name ?? null),
      prompt_tokens: stat(ok.map((x) => x.prompt_tokens)),
      completion_tokens: stat(ok.map((x) => x.completion_tokens)),
      cost_usd: stat(ok.map((x) => x.cost_usd)),
      latency_s: stat(ok.map((x) => x.ms / 1000)),
    };
  }
}

const inputInfo = Object.fromEntries(
  Object.entries(inputs).map(([k, v]) => [k, v.kind === "video" ? { kind: "video", width: v.width, height: v.height, fps: v.fps, crop: v.crop, crf: CRF, bytes: v.bytes } : { kind: "keyframes", keyframes: v.frames.map((f) => ({ t_s: f.t, bytes: f.bytes })), montage_bytes: v.montage_bytes, width: v.width, note: "6 keyframes at the centres of 6 equal segments, JPEG q4; montage 12 frames 320 wide in a 4x3 tile" }]),
);
const result = {
  benchmark: `Label robustness: ${OTHER ? OTHER.name : "Super VL"} on the sample clips under several input conditions`,
  date: new Date().toISOString(),
  reproduce: REPRODUCE,
  stopped,
  conditions: {
    base_url: TOKEN_FACTORY_BASE_URL,
    model: MODEL,
    defs: Object.fromEntries(CONDITIONS.map((c) => [c, CONDITION_DEFS[c].name])),
    hints: { context: HINTS, task: TASK_HINTS },
    crops: CROPS,
    prompt: "LABEL_PROMPT of scripts/bench-session.mjs, verbatim; d adds one line saying the clip comes as captioned keyframes and a montage",
    temperature: "model default (not sent)",
    response_format: "json_object",
    thinking: OTHER ? `off: ${JSON.stringify(OTHER.off)}${OTHER.off_note ? ` (${OTHER.off_note})` : ""}; f: the model's default` : "chat_template_kwargs.enable_thinking=false except f (default, on)",
    max_tokens: OTHER?.always_reasons ? "8000 in every condition (its reasoning cannot be switched off)" : "3000, f 4000",
    order: "run-major: run 1 of every clip and condition, then run 2, ...; sequential, one call at a time",
    retries: "one retry after 5 s on a timeout, 429 or 5xx; none happened unless attempts > 1",
    inputs: inputInfo,
    prices: OTHER
      ? `list prices from tests/fixtures/models-compare.json ($${(PRICES[MODEL].prompt * 1e6).toFixed(2)} in / $${(PRICES[MODEL].completion * 1e6).toFixed(2)} out per million); video tokens priced as prompt tokens; a failed or timed-out call is charged at its reserved worst case`
      : "list prices from tests/fixtures/models.json ($0.30 in / $0.90 out per million for Super VL); video tokens priced as prompt tokens; a failed or timed-out call is charged at its reserved worst case",
  },
  ground_truth: Object.fromEntries(CLIPS.map((c) => [c, TRUTH[c]])),
  rubric: Object.fromEntries(CLIPS.map((c) => [c, RUBRIC[c]])),
  summary,
  // this script's own calls only (the ledger may be charged by other scripts at the same time)
  spend_usd: Number(runs.reduce((n, x) => n + (x.cost_usd ?? 0) + (x.estimated_usd ?? 0), 0).toFixed(6)),
  estimated_failed_usd: Number(runs.reduce((n, x) => n + (x.estimated_usd ?? 0), 0).toFixed(6)),
  runs,
};
let body = JSON.stringify(result, null, 2) + "\n";
if (body.includes(process.env.NEBIUS_API_KEY)) body = redact(body);
writeFileSync(OUT, body);

console.log(`\n| Clip | Condition | Accuracy | 5/5 | verb | object | fixture | steps | size | Prompt tok | Out tok | Cost/call | Latency |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
const f = (s, fn) => (s ? `${fn(s.mean)} (${fn(s.min)}-${fn(s.max)})` : "-");
for (const clip of CLIPS)
  for (const [cond, s] of Object.entries(summary[clip])) {
    const n = s.runs;
    console.log(`| ${clip} | ${cond} ${s.condition} | ${(s.accuracy * 100).toFixed(0)}% | ${s.perfect}/${n} | ${s.criteria.verb}/${n} | ${s.criteria.object}/${n} | ${s.criteria.fixture}/${n} | ${s.criteria.steps}/${n} | ${s.criteria.size}/${n} | ${f(s.prompt_tokens, (x) => Math.round(x))} | ${f(s.completion_tokens, (x) => Math.round(x))} | ${f(s.cost_usd, (x) => `$${x.toFixed(4)}`)} | ${f(s.latency_s, (x) => `${x.toFixed(1)} s`)} |`);
  }
console.log(`\nwrote ${path.relative(ROOT, OUT)}; this run spent $${result.spend_usd.toFixed(4)}; ledger total $${spent().toFixed(4)}`);
