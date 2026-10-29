/**
 * POST /api/compile {spec, previous?}: Nano turns a task spec into a Program,
 * with an `ask` op for every value it would otherwise have to guess. It runs
 * again after every interview answer; `previous` is the program kept when a
 * recompile comes back unusable; `unlock` or `sample_token` lets it go live
 * (lib/unlock/check.ts). Replay (no key, ?replay=1, or no way past the spend
 * guard) answers from tests/fixtures/compile.json: the recording of the same
 * spec, else the latest one with the same title. A spec of gestures alone has
 * nothing to guess: its program, a follow op per step, is written here with no
 * model, live or replayed alike.
 *
 * `playbook` (#56, off unless the page sends it): {rules, failure?}, the ids of the playbook rules the
 * person left on and the failure of the last rehearsal on screen. The rules that match the spec
 * (lib/spec/playbook.ts matchRules) go into the user message and the program says which it applied;
 * replay then answers only from a recording made with the same rules. Without the key, or with no
 * rule that matches, the request and the answer are the ones from before the playbook.
 */
import { NextResponse } from "next/server";
import recordings from "@/tests/fixtures/compile.json";
import { callModel } from "@/lib/providers/call";
import { tokenFactory, wantsReplay } from "@/lib/providers/tokenfactory";
import { normalizeProgram, resolveFixtureNames } from "@/lib/spec/normalize";
import { AXES, PlaybookProgram, PREDICATE_OPERANDS, Program, TaskSpec } from "@/lib/spec/schema";
import { done, failed, type StageResult } from "@/lib/spec/stage-result";
import { lintProgram, validateProgram } from "@/lib/spec/validate";
import { canonicalSlot, valueAt } from "@/lib/spec/apply";
import { askable, WAITING_NOTE, waitingProgram, withRequiredAsks } from "@/lib/spec/answer";
import { gestureProgram } from "@/lib/sim/gesture";
import { footprintMm, MM, WALL_M } from "@/lib/sim/scene";
import { budgetRefused, explain, liveGate } from "@/lib/unlock/check";
import { prerunProgram } from "@/lib/showcase/lookup";
import { citedRules, matchRules, playbookSection, type Rule } from "@/lib/spec/playbook";
import { z } from "zod";

export const maxDuration = 60;

const PREDICATES = Object.entries(PREDICATE_OPERANDS)
  .map(([kind, n]) => `${kind} needs ${[n.object && "object", n.target && "target", n.value && `value (${n.unit})`].filter(Boolean).join(", ") || "nothing"}`)
  .join("; ");

// Measured in scripts/bench-session.mjs (PR #71); the Geometry paragraph states what the interpreter does.
const COMPILE_SYSTEM = `You play the robot: a 5-DoF SO-101 arm with a parallel gripper (aperture 0 to 60 mm), top, side or front approach, no force sensing, reach 300 mm from its base. Compile the task spec you are given into a program for it. Return one compact JSON object only, no indentation:
{"spec_title":string,"steps":[{"step_id":<spec step id>,"ops":[op, ...]}],"warnings":[string]}
Ops:
- {"op":"move_to","frame":"world"|<object id>,"offset_mm":[x,y,z],"approach":"top"|"side"|"front"}
- {"op":"grasp","object":<object id>,"aperture_mm":number}
- {"op":"release"}
- {"op":"tilt","deg":number,"toward":<object id>,"seconds":number}
- {"op":"follow"}
- {"op":"wait_until","predicate":P,"timeout_s":number}
- {"op":"assert","predicate":P}
- {"op":"ask","slot":<spec path>,"question":string,"why":string}
A predicate P is {"kind":K,"object":<id>,"target":<id>,"value":number} with only the operands its kind needs. K is exactly one of these names: ${PREDICATES}.
tilt turns the held object about its rim on the side of "toward", deg from upright (a pour), over seconds; deg 0 turns it back upright.
follow moves the point between the pads along the gesture path of the step it is in, on the clip's timing, and checks it reached every point.
Geometry: millimetres. The world frame sits at the robot base on the table: x away from the robot, y to its left, z up. An object's frame is its centre, turned by its yaw; size_mm is its extent along x, y, z, so its top face is at z = +size_mm[2]/2 and the table at z = -size_mm[2]/2 in its frame. Until a grasp, move_to puts the point between the gripper pads at the offset, and grasp closes the pads there. While an object is held, move_to puts the held object's centre at the offset instead. The user message lists the moves worked out for this spec as ready move_to ops: copy them exactly rather than computing your own.
Rules:
- One entry in steps per spec step, in the spec's order, with step_id the spec step's id.
- Offsets are relative to the named frame. Use the step's via_points when it has them; otherwise build each step from the listed moves: approach, down to the grip, grasp, lift; then over the target, down, release. You choose which listed moves to use and where to release.
- You execute only what the spec states. Every value you would have to guess becomes an ask instead, and only these can be asked: a missing pocket_clearance_mm on a pocket fixture, a missing tolerance band on the axes the step is sensitive to (${AXES.join(", ")}), a step without a success predicate. One ask per missing field, placed in the step that needs it; slot is the spec path, for example objects[rack].pocket_clearance_mm, steps[s2].tolerances.x_mm, steps[s2].success.
- A missing value is never a warning: it is an ask op, because the asks become the questions put to the person who did the task. Warnings are only for what no answer can fix.
- A field already set in the spec is settled, whatever its source (vl#, interview#, notes#, user#edit): never ask about it again.
- End each insert or place step with an assert of its success predicate when the spec gives one.
- A pour step (verb "pour", with pour.into, pour.tilt_deg and pour.tilt_s) copies the ops listed for it in the user message, in order: grip the container from the front, tilt toward pour.into, wait until the liquid is inside it, tilt back to 0, release, back off, assert.
- A gesture step (verb "gesture": a hand moving through the air, such as a wave, a signal to a crane driver or a sign traced in the air) has no object: its ops are exactly the ones listed for it in the user message, and it asks nothing, since the path it follows is its only check.
- Only the eight ops above exist; anything else (descend, insert, place, lift, pour, wave) is written with move_to, grasp, release, tilt and follow.
- The examples' numbers belong to their objects: for this spec copy only the moves listed in the user message, frame and numbers unchanged.
- Keep the program short: no comments, no prose.
Example. A jar (cylinder, size_mm [40,40,80]) is picked in s1 and placed on a tray (box, size_mm [200,150,20], zone fixture) in s2; s2 has a success predicate but no tolerance. The jar is gripped 8 mm below its top (z = 40 - 8 = 32 in its frame) from 50 mm above (32 + 50 = 82); once held, offsets place its centre: lifted 50 mm, carried with its bottom 20 mm above the tray (10 + 40 + 20 = 70), then set down with its bottom 1 mm above the tray's top (10 + 40 + 1 = 51).
[{"step_id":"s1","ops":[{"op":"move_to","frame":"jar","offset_mm":[0,0,82],"approach":"top"},{"op":"move_to","frame":"jar","offset_mm":[0,0,32],"approach":"top"},{"op":"grasp","object":"jar","aperture_mm":40},{"op":"wait_until","predicate":{"kind":"contact_both_pads","object":"jar"},"timeout_s":1},{"op":"move_to","frame":"jar","offset_mm":[0,0,50],"approach":"top"}]},{"step_id":"s2","ops":[{"op":"move_to","frame":"tray","offset_mm":[0,0,70],"approach":"top"},{"op":"ask","slot":"steps[s2].tolerances.x_mm","question":"How far off-centre can the jar land before it counts as missed?","why":"no tolerance band for x_mm"},{"op":"move_to","frame":"tray","offset_mm":[0,0,51],"approach":"top"},{"op":"release"},{"op":"wait_until","predicate":{"kind":"object_still","object":"jar"},"timeout_s":2},{"op":"assert","predicate":{"kind":"inside_zone","object":"jar","target":"tray"}}]}]
Pour examples. A mug (box, size_mm [48,48,54], holding 38 mL) is poured into a bowl in s1 with pour {"into":"bowl","tilt_deg":120,"tilt_s":1.5} and success liquid_inside of the mug's liquid in the bowl, 90:
[{"step_id":"s1","ops":[{"op":"move_to","frame":"mug","offset_mm":[0,0,50],"approach":"front"},{"op":"move_to","frame":"mug","offset_mm":[0,0,0],"approach":"front"},{"op":"grasp","object":"mug","aperture_mm":48},{"op":"tilt","deg":120,"toward":"bowl","seconds":1.5},{"op":"wait_until","predicate":{"kind":"liquid_inside","object":"mug","target":"bowl","value":90},"timeout_s":3},{"op":"tilt","deg":0,"seconds":1.5},{"op":"release"},{"op":"move_to","frame":"mug","offset_mm":[0,0,50],"approach":"front"},{"op":"assert","predicate":{"kind":"liquid_inside","object":"mug","target":"bowl","value":90}}]}]
In a lab, a beaker of buffer (box, size_mm [44,44,60]) is emptied into a reservoir in s2 with pour {"into":"reservoir","tilt_deg":150,"tilt_s":2} and no success predicate:
[{"step_id":"s2","ops":[{"op":"ask","slot":"steps[s2].success","question":"How much of the buffer has to end up in the reservoir for the pour to count?","why":"no success predicate"},{"op":"move_to","frame":"beaker","offset_mm":[0,0,50],"approach":"front"},{"op":"move_to","frame":"beaker","offset_mm":[0,0,0],"approach":"front"},{"op":"grasp","object":"beaker","aperture_mm":44},{"op":"tilt","deg":150,"toward":"reservoir","seconds":2},{"op":"wait_until","predicate":{"kind":"liquid_inside","object":"beaker","target":"reservoir","value":90},"timeout_s":3},{"op":"tilt","deg":0,"seconds":2},{"op":"release"},{"op":"move_to","frame":"beaker","offset_mm":[0,0,50],"approach":"front"}]}]`;

const r1 = (x: number) => Math.round(x * 10) / 10;

/** The moves a program needs, as ready ops: a 3B-active model copies JSON well and adds numbers and picks frames badly. */
function geometry(spec: TaskSpec): string {
  const move = (frame: string, z: number) => JSON.stringify({ op: "move_to", frame, offset_mm: [0, 0, r1(z)], approach: "top" });
  const lines: string[] = [];
  const poured = new Set(spec.steps.filter((s) => s.verb === "pour" && s.pour).map((s) => s.object));
  for (const o of spec.objects.filter((o) => o.role === "manipulated" && !poured.has(o.id))) {
    const grip = Math.max(0, o.size_mm[2] / 2 - 8);
    lines.push(`- ${o.id}, before it is held: approach ${move(o.id, grip + 50)}; grip point (8 mm below its top) ${move(o.id, grip)}; then {"op":"grasp","object":"${o.id}","aperture_mm":${Math.min(...footprintMm(o))}}; once held, lift ${move(o.id, 50)}`);
  }
  for (const s of spec.steps) {
    if (s.verb === "gesture") {
      lines.push(`- step ${s.id} is a gesture of ${s.gesture?.path.length ?? 0} points: {"step_id":"${s.id}","ops":[{"op":"follow"}]}`);
      continue;
    }
    const o = spec.objects.find((x) => x.id === s.object);
    if (o && s.verb === "pour" && s.pour) {
      // gripped from the front at its centre, so the wrist can roll it over (lib/sim/interpreter.ts, tilt)
      const { into, tilt_deg, tilt_s = 1.5 } = s.pour;
      const front = (z: number) => JSON.stringify({ op: "move_to", frame: o.id, offset_mm: [0, 0, z], approach: "front" });
      const success = s.success.find((p) => p.kind === "liquid_inside" && p.target === into);
      // the share of what the container held: what the target held before does not count
      const ops = [
        front(50),
        front(0),
        JSON.stringify({ op: "grasp", object: o.id, aperture_mm: Math.min(...footprintMm(o)) }),
        JSON.stringify({ op: "tilt", deg: tilt_deg, toward: into, seconds: tilt_s }),
        JSON.stringify({ op: "wait_until", predicate: { kind: "liquid_inside", object: o.id, target: into, value: success?.value ?? 90 }, timeout_s: 3 }),
        JSON.stringify({ op: "tilt", deg: 0, seconds: tilt_s }),
        JSON.stringify({ op: "release" }),
        front(50),
        ...s.success.map((predicate) => JSON.stringify({ op: "assert", predicate })),
      ];
      lines.push(`- step ${s.id} pours ${o.id} into ${into}, these ops in order: ${ops.join(", ")}`);
      continue;
    }
    const f = s.target && spec.objects.find((x) => x.id === s.target!.frame);
    if (!o || !f || !s.target) continue;
    const top = f.size_mm[2] / 2;
    const half = o.size_mm[2] / 2;
    const facts = [`carried 20 mm over it ${move(f.id, top + half + 20)}`, `its bottom 1 mm above ${f.id}'s top ${move(f.id, top + half + 1)}`];
    if (s.target.fixture === "pocket") facts.push(`resting on the pocket floor ${move(f.id, -top + Math.min(WALL_M / MM, top) + half)}`);
    lines.push(`- step ${s.id}, ${o.id} held: ${facts.join("; ")}`);
  }
  return lines.join("\n");
}

/** An ask about a field the spec already sets wastes a question; drop it. */
function settled(spec: TaskSpec, slot: string): boolean {
  const v = valueAt(spec, slot);
  return v !== undefined && !(Array.isArray(v) && v.length === 0) && !(typeof v === "object" && v !== null && Object.keys(v).length === 0);
}

/** A recorded compile; `playbook` holds the ids of the rules it was given, absent for one made without the playbook. */
type Recording = { spec: unknown; playbook?: string[]; result: StageResult<Program> };

/** What the page sends with the switch on. */
const PlaybookAsk = z.object({ rules: z.array(z.string()).max(50), failure: z.enum(["embodiment_limit", "check_failed", "spec_gap"]).optional() });

const sameRules = (r: Recording, rules: readonly Rule[] | null) => (rules === null ? r.playbook === undefined : JSON.stringify(r.playbook) === JSON.stringify(rules.map((x) => x.id)));

function replay(spec: TaskSpec, rules: readonly Rule[] | null = null): StageResult<Program> {
  const all = (recordings as Recording[]).filter((r) => sameRules(r, rules));
  if (rules && !all.some((r) => JSON.stringify(TaskSpec.parse(r.spec)) === JSON.stringify(spec))) {
    // no compile recorded with these rules for this spec: the one without the playbook, said so
    const off = replay(spec);
    return off.status === "done" ? done(off.value, [...off.warnings, "replay: recorded without the playbook"], off.ledger) : off;
  }
  const key = JSON.stringify(spec);
  const exact = all.find((r) => JSON.stringify(TaskSpec.parse(r.spec)) === key);
  if (exact) return exact.result;
  const near = all.findLast((r) => TaskSpec.parse(r.spec).title === spec.title)?.result;
  if (near?.status === "done") return done(near.value, [...near.warnings, "replay: recorded for an earlier version of this spec"], near.ledger);
  return failed(`no recorded compile for "${spec.title}"`, false);
}

export async function POST(req: Request): Promise<NextResponse<StageResult<Program>>> {
  const body = await req.json().catch(() => null);
  const spec = TaskSpec.safeParse(body?.spec);
  if (!spec.success) return NextResponse.json(failed(`invalid spec: ${spec.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, false), { status: 400 });
  // a program with no moves (the one waiting for where it goes, lib/spec/answer.ts) is nothing to fall back on
  const sent = body?.previous === undefined ? undefined : Program.safeParse(body.previous).data;
  const previous = sent?.steps.some((s) => s.ops.some((op) => op.op !== "ask")) ? sent : undefined;
  const gestures = gestureProgram(spec.data);
  if (gestures) return NextResponse.json(done(gestures, ["every step is a gesture: the program follows each path and needs no model"]));
  const waiting = waitingProgram(spec.data);
  if (waiting) return NextResponse.json(done(waiting, [WAITING_NOTE]));

  // the playbook rules for this spec, null with the switch off or none that match: then nothing below changes
  const asking = body?.playbook === undefined ? null : PlaybookAsk.safeParse(body.playbook);
  if (asking && !asking.success) return NextResponse.json(failed("invalid playbook: {rules: [rule id], failure?}", false), { status: 400 });
  const matched = asking ? matchRules(spec.data, asking.data.rules, asking.data.failure) : [];
  const rules = matched.length ? matched : null;

  // a sample's similar task, written ahead of time (lib/showcase/prerun.ts): no model, no wait; not written with the playbook
  const pre = rules ? null : await prerunProgram(spec.data);
  if (pre) return NextResponse.json(pre);

  const gate = wantsReplay(req) ? null : await liveGate("compile", body);
  const client = gate?.live ? tokenFactory({ timeout: 25_000, maxRetries: 1 }) : null;
  const asked = client
    ? await callModel(client, {
        role: "nano",
        system: COMPILE_SYSTEM,
        user: `Task spec:\n${JSON.stringify(spec.data)}\n\nMoves for this spec:\n${geometry(spec.data)}${rules ? `\n\n${playbookSection(rules)}` : ""}`,
        maxTokens: 3000,
        // the playbook's answer has one more key; with it off the answer is parsed exactly as before
        schema: rules ? PlaybookProgram : Program,
        shape: `{"spec_title":string,"steps":[{"step_id":string,"ops":[op, ...]}, ...],"warnings":[string]${rules ? `,"playbook":[rule id]` : ""}}: every entry of steps is an object with step_id and ops, and warnings is a key of the answer, after the closing bracket of steps`,
        normalize: normalizeProgram,
        check: (p) => lintProgram(resolveFixtureNames(p, spec.data).program, spec.data),
        previous,
      })
    : explain(replay(spec.data, rules), gate);
  // turned away by the live budget halfway: the recording answers, as if the guard had said so
  const refused = budgetRefused(asked);
  const result = refused ? explain(replay(spec.data, rules), refused) : asked;
  if (result.status !== "done") return NextResponse.json(result);
  const resolved = resolveFixtureNames(result.value, spec.data);
  const warnings = [...result.warnings, ...resolved.warnings];
  // the rules it says it applied, among those it was given; nothing at all without the playbook. A kept
  // previous program keeps what it said when it was compiled (Program parsed it without), or says nothing
  const { playbook: said, ...unsaid } = resolved.program;
  const kept = previous !== undefined && result.warnings.some((w) => w.endsWith("previous value kept"));
  const keptSaid = kept ? PlaybookProgram.safeParse(body.previous).data?.playbook : undefined;
  const cites = !rules ? undefined : kept ? (keptSaid && citedRules(keptSaid, rules)) : citedRules(said, rules);
  const program: Program = {
    ...unsaid,
    ...(cites ? { playbook: cites } : {}),
    steps: unsaid.steps.map((s) => ({
      ...s,
      ops: s.ops
        .map((op) => (op.op === "ask" ? { ...op, slot: canonicalSlot(spec.data, op.slot) } : op))
        .filter((op) => {
          if (op.op !== "ask") return true;
          if (settled(spec.data, op.slot)) warnings.push(`dropped an ask for ${op.slot}: the spec already sets it`);
          else if (!askable(spec.data, op.slot)) warnings.push(`dropped an ask for ${op.slot} ("${op.question}"): not something the person who did the task can answer`);
          else return true;
          return false;
        }),
    })),
  };
  const required = withRequiredAsks(spec.data, program);
  for (const slot of required.added) warnings.push(`added an ask for ${slot}: the rehearsal needs it`);
  // a dangling reference stays in the program: the interpreter reports it as a spec gap
  for (const i of validateProgram(required.program, spec.data)) warnings.push(`${i.path}: ${i.message}`);
  return NextResponse.json(done(required.program, warnings, result.ledger));
}
