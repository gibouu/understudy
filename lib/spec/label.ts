/**
 * The Label stage's prompt and the clean-up its output gets before it is a
 * TaskSpec: times clamped to the clip, overlapping steps trimmed so each
 * starts where the previous one ended (a gesture keeps its own window: one
 * hand waves while the other holds), sizes outside 5 to 300 mm flagged.
 * Prompt measured in scripts/bench-session.mjs and scripts/bench-label.mjs
 * (PR #71): video input, thinking off, and a one-line hint from the person
 * who filmed it, which is what gets the manipulated object named right.
 */
import { normalizeSpec, type Normalized } from "./normalize";

export const LABEL_PROMPT = `You label a short video of one person doing a hands-on task (aboard a station or on a bench) so that a robot arm can try to repeat it. Watch the whole clip. Return one JSON object only, no prose, shaped like this:
{"version":1,"title":string,"summary":string,
 "objects":[{"id":string,"name":string,"shape":"cylinder"|"box"|"sphere","size_mm":[number,number,number],"symmetry":"none"|"axial"|"full","role":"manipulated"|"fixture"|"obstacle"|"surface","pose":{"xyz_mm":[x,y,z],"yaw_deg":number,"frame":"world"},"pocket_clearance_mm":number,"confidence":number,"source":"vl#seg<n>"}],
 "steps":[{"id":"s1","verb":"reach"|"grasp"|"move"|"insert"|"place"|"release"|"retract"|"gesture","object":<object id>,"target":{"fixture":"pocket"|"zone"|"stack","frame":<object id>},"gesture":{"hand":"left"|"right"},"t_start_s":number,"t_end_s":number,"source":"vl#seg<n>"}],
 "anchor":{"t_s":number,"confidence":number},
 "warnings":[string],"open_questions":[string]}
Rules:
- Objects are primitives. A cylinder's size_mm is [diameter, diameter, height]; a box's [x, y, z]; a sphere's [d, d, d]; millimetres, 5 to 300 mm. A size outside that range goes to warnings.
- symmetry: axial for a cylinder whose yaw does not matter, full for a sphere, none otherwise. role: manipulated for what the hand moves, fixture for what receives it, obstacle for anything in the way, surface for what everything rests on.
- A step where a hand moves through the air to signal or greet, handling nothing, is a gesture: for example waving to the camera, a marshaller's come-ahead signal, beckoning someone over, a hand sign that traces a shape. A gesture step has no object and no target; "gesture":{"hand":...} names which of the person's own hands makes it, and the step spans the whole movement. If the clip shows nothing but gestures, objects may be empty.
- Each insert or place step names its target as one of three fixtures: pocket (into a hole, holder, sleeve or connector), zone (onto an area of a surface), stack (on top of another object). Anything else becomes zone with a warning.
- Steps in time order, in seconds from the start of the clip, not overlapping, t_end_s >= t_start_s. If the task repeats, label every repetition.
- World frame: origin where a robot base would meet the work surface, x away from the robot, y to its left, z up. Give a pose only when the scene gives you a scale; otherwise leave pose out and add an open question naming the object.
- pocket_clearance_mm only for fixtures with a pocket, and only if you can see it; otherwise leave it out.
- confidence 0 to 1 per object. Anything you are unsure of gets a lower confidence and an open question that names the field.
- anchor is the grasp moment of the first grasp.
- source names the segment you saw it in, e.g. "vl#seg2".`;

export const hintText = (hint: string) => `Context from the person who uploaded the clip: ${hint}`;

const MIN_MM = 5;
const MAX_MM = 300;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** normalizeSpec, then the label clean-up against a clip of `durationS` seconds. The input is not mutated. */
export function tidyLabel(raw: unknown, durationS: number): Normalized {
  const { data, warnings } = normalizeSpec(raw);
  if (!isRec(data)) return { data, warnings };
  const questions = data.open_questions as string[];
  const clamp = (t: unknown) => r2(Math.min(Math.max(num(t), 0), durationS));

  if (Array.isArray(data.steps)) {
    const steps = data.steps.filter(isRec);
    steps.sort((a, b) => num(a.t_start_s) - num(b.t_start_s));
    let end = 0;
    for (const s of steps) {
      const [t0, t1] = [num(s.t_start_s), num(s.t_end_s)];
      s.t_start_s = clamp(t0);
      s.t_end_s = Math.max(clamp(t1), s.t_start_s as number);
      if (s.t_start_s !== t0 || s.t_end_s !== t1) warnings.push(`step ${String(s.id)}: times ${t0}-${t1} s clamped to the ${durationS} s clip`);
      if (typeof s.verb === "string" && s.verb.toLowerCase() === "gesture") continue;
      if ((s.t_start_s as number) < end) {
        warnings.push(`step ${String(s.id)}: started at ${s.t_start_s} s, before the previous step ended; moved to ${end} s`);
        s.t_start_s = end;
        s.t_end_s = Math.max(s.t_end_s as number, end);
      }
      end = s.t_end_s as number;
    }
    data.steps = steps;
  }
  if (isRec(data.anchor) && typeof data.anchor.t_s === "number") data.anchor.t_s = clamp(data.anchor.t_s);

  if (Array.isArray(data.objects)) {
    for (const o of data.objects.filter(isRec)) {
      if (!Array.isArray(o.size_mm) || !o.size_mm.some((v) => typeof v === "number" && (v < MIN_MM || v > MAX_MM))) continue;
      warnings.push(`object ${String(o.id)}: size_mm [${o.size_mm.join(", ")}] is outside ${MIN_MM} to ${MAX_MM} mm`);
      questions.push(`objects[${String(o.id)}].size_mm: is ${String(o.name ?? o.id)} really [${o.size_mm.join(", ")}] mm?`);
    }
  }
  return { data, warnings };
}
