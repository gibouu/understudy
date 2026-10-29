/**
 * The playbook (#56): Notes patches that fixed a failing rehearsal, kept as rules the next compile can
 * read. A rule is inspectable text with its evidence, not a weight: what kind of task it was learned on,
 * which failure it fixed, what changed, and the rehearsal before and after. Each is tagged with the kind
 * of target it was learned on and goes only to a spec with a step of that kind: untagged rules damaged
 * the pour on the bench (docs/MEASUREMENTS.md section 8).
 *
 * The seed set is written by hand from the recordings, with no model: every Notes patch in the space
 * showcase (public/showcase/<clip>.json) that turned a failing world into a passing one, or cleared the
 * failure it was made for, and the two tasks the bench distilled rules for (bench/results/patch-loop.json,
 * arm r2-playbook3), their evidence counted from the super-off repairs that distillation was given, not
 * from Super's own summary of them. tests/spec/playbook.test.ts pins every rule's evidence to its source.
 *
 * Off by default. With the switch on, /try sends the ids of the rules left on; /api/compile keeps those
 * that match the spec (matchRules) and puts them in Nano's user message (playbookSection).
 */
import type { Axis, Fixture, TaskSpec } from "./schema";

/** The kind of task a rule was learned on: a step's target fixture, or a pour step (whose `into` has no fixture). */
export type RuleKind = Fixture | "pour";
/** What failed: out of the arm's reach, or a check of the program that did not hold in the world (the object drifted, missed, toppled). */
export type RuleFailure = "embodiment_limit" | "check_failed";
/** The failure a rehearsal reports (a Run's failure_class, or none when a check failed), as the page sends it. */
export type SeenFailure = RuleFailure | "spec_gap";

export type Rule = {
  id: string;
  fixture: RuleKind;
  failure_class: RuleFailure;
  /** the band axis the change acts on; null for a timing */
  axis: Axis | null;
  /** when the rule applies, in words */
  condition: string;
  /** what to do in the program, in words the compiler can act on */
  hint: string;
  evidence: {
    /** the showcase clip, or the bench probe, it was learned on */
    clip: string;
    /** the change that fixed it, in words, as the recording says it */
    change: string;
    /** the rehearsal before the change */
    before: string;
    /** the rehearsal after it */
    after: string;
  };
  /** notes#<n>: the clip's n-th Notes patch; bench#<arm>.<n>: the n-th rule a bench arm distilled */
  source: string;
  /** on unless said: a rule learned where /try does not rehearse is off until turned on */
  on: boolean;
  /** why a rule is off by default */
  note?: string;
};

export const PLAYBOOK: readonly Rule[] = [
  {
    id: "pocket-lift-reach",
    fixture: "pocket",
    failure_class: "embodiment_limit",
    axis: "z_mm",
    condition: "the lift just after the grasp (50 mm, as listed) is out of the arm's reach, as it was for a 40 mm-tall object picked at the edge of the bench",
    hint: "lift the held object about 40 mm after the grasp instead of 50 mm; keep every other listed move",
    evidence: {
      clip: "iss-glovebox-pipette",
      change: "the height of the move to the pipette (s1 op 4): 50 → 41.9 mm",
      before: "fails at 1 g and 0 g: move_to pipette + (0, 0, 50) mm from top: out of reach by 8.1 mm (8.4 mm at 0 g)",
      after: "passes at 1 g and 0 g",
    },
    source: "notes#1",
    on: true,
  },
  {
    id: "zone-lift-reach",
    fixture: "zone",
    failure_class: "embodiment_limit",
    axis: "z_mm",
    condition: "the lift just after the grasp (50 mm, as listed) is out of the arm's reach, as it was for a 40 mm cube picked at the edge of the bench",
    hint: "lift the held object about 40 mm after the grasp instead of 50 mm; keep every other listed move",
    evidence: {
      clip: "dev-clip",
      change: "the height of the move to the chess pieces (s1 op 3): 50 → 38.9 mm",
      before: "fails at 1 g and 0 g: move_to obj2 + (0, 0, 50) mm from top: out of reach by 11.1 mm (11.2 mm at 0 g)",
      after: "passes at 1 g and 0 g",
    },
    source: "notes#1",
    on: true,
  },
  {
    id: "pocket-wait-still-orbit",
    fixture: "pocket",
    failure_class: "check_failed",
    axis: null,
    condition: "in orbit (0 g) a released object keeps drifting: 2 s was too short a wait for it to come to rest in the pocket",
    hint: "after the release into the pocket, wait up to 5 s (not 2 s) for the object to be still",
    evidence: {
      clip: "iss-veggie-seed-film",
      change: "how long to wait for object still of the seed film packet (s2 op 4): 2 → 5 s",
      before: "passes at 1 g; fails at 0 g: timed out after 2 s: obj1 moving at 10.2 mm/s",
      after: "the wait no longer times out at 0 g; the next check fails (obj1 is 21.4 mm from obj2's centre, not inside it), fixed by pocket-release-above-floor",
    },
    source: "notes#1",
    on: true,
  },
  {
    id: "pocket-release-above-floor",
    fixture: "pocket",
    failure_class: "check_failed",
    axis: "z_mm",
    condition: "in orbit (0 g), an object let go resting on the pocket floor was pushed out of the pocket",
    hint: "release the object 2 mm above the listed move that rests it on the pocket floor, not on the floor itself",
    evidence: {
      clip: "iss-veggie-seed-film",
      change: "the height of the move to the Veggie plant pillow tray (s2 op 2): 13 → 15 mm",
      before: "passes at 1 g; fails at 0 g: obj1 is 21.4 mm from obj2's centre, not inside it",
      after: "passes at 1 g and 0 g",
    },
    source: "notes#2",
    on: true,
  },
  {
    id: "zone-settle-before-release",
    fixture: "zone",
    failure_class: "check_failed",
    axis: "z_mm",
    condition: "the object is placed upright while the base accelerates sideways, and topples when let go above the surface",
    hint: "set the object down with its bottom on the zone's top (the listed move 1 mm above it, 1 mm lower) before opening the gripper; under a strong sideways push, also wait for it to be still before opening",
    evidence: {
      clip: "bench: place probe (tests/measure/patch-probes.ts), Earth 1 g and Mars 0.379 g, sideways acceleration 0.05 or 0.2 g",
      change: "release_height_mm 10 → 0 in all 7 repairs; under 0.2 g (4 of them) also release_speed_mm_s 20 → 5 and wait_before_release_s 0 → 2",
      before: "the naive place toppled",
      after: "7 repairs passed (super-off arm, seeds 1 to 3)",
    },
    source: "bench#r2-playbook3.1",
    on: false,
    note: "learned on the bench's knob programs under a sideways acceleration that /try does not rehearse",
  },
  {
    id: "pour-tilt-longer",
    fixture: "pour",
    failure_class: "check_failed",
    axis: null,
    condition: "beads are left in the source container after the tilt",
    hint: "tilt for longer than the listed time (1.5 to 4 s rather than 1 s), and hold the tilt until the target is reached when it is farther away",
    evidence: {
      clip: "bench: pour probe (tests/measure/patch-probes.ts), Earth 1 g and Mars 0.379 g, with and without the target 30 mm farther",
      change: "tilt_s 1 → 1.5 to 4 and target_offset_mm 0 → 10 (40 with the target farther) in all 9 repairs; tilt_deg 90 → 100 in 4; hold-and-wait in the 4 with the target farther",
      before: "beads left in the source",
      after: "9 repairs passed (super-off arm, seeds 1 to 3)",
    },
    source: "bench#r2-playbook3.2",
    on: false,
    note: "learned on the bead pour; the liquid model makes the pour far harder to fix and changed what works (docs/MEASUREMENTS.md section 8)",
  },
];

/** The kinds of task a spec's steps are. */
export function kindsOf(spec: TaskSpec): Set<RuleKind> {
  const kinds = new Set<RuleKind>();
  for (const s of spec.steps) {
    if (s.verb === "pour" && s.pour) kinds.add("pour");
    else if (s.target) kinds.add(s.target.fixture);
  }
  return kinds;
}

/** The ids the page starts with: every rule that is on unless turned off. */
export const DEFAULT_ON: readonly string[] = PLAYBOOK.filter((r) => r.on).map((r) => r.id);

/**
 * The rules of the playbook named in `ids` that go to this spec: learned on a kind of task the spec has,
 * and, when the page saw a failure in its last rehearsal, made for that failure. In the playbook's order;
 * an id the playbook does not have is ignored, so a request cannot put text of its own in the prompt.
 */
export function matchRules(spec: TaskSpec, ids: readonly string[], failure?: SeenFailure): Rule[] {
  const kinds = kindsOf(spec);
  return PLAYBOOK.filter((r) => ids.includes(r.id) && kinds.has(r.fixture) && (failure === undefined || r.failure_class === failure));
}

/** A rule as the program cites it. */
export const ref = (r: Rule | string) => `playbook#${typeof r === "string" ? r : r.id}`;

/**
 * The playbook part of Nano's user message. `rules` empty gives the section with no rules: the matched
 * control the bench compares against (same instructions, nothing to apply). Only the route's own
 * measurement sends it empty; the page never sends a section with no rules.
 */
export function playbookSection(rules: readonly Rule[]): string {
  const lines = rules.map((r) => `- ${r.id} (learned on a ${r.fixture} task, ${r.evidence.clip}): when ${r.condition}: ${r.hint}. Evidence: ${r.evidence.change}; before, ${r.evidence.before}; after, ${r.evidence.after}.`);
  return [
    "Playbook: rules learned from patches that fixed a failed rehearsal of another clip with the same kind of target. Apply a rule only where its condition fits this spec; the listed moves stay the reference for everything else. Add a key \"playbook\" to your answer, after warnings: the ids of the rules you applied, [] if none.",
    ...(lines.length ? lines : ["(no rules)"]),
  ].join("\n");
}

/** The `playbook` a program carries: the ids it says it applied, kept only when they were given, as playbook#<id>. */
export function citedRules(said: unknown, given: readonly Rule[]): string[] {
  if (!Array.isArray(said)) return [];
  const ids = new Set(said.filter((x): x is string => typeof x === "string").map((x) => x.replace(/^playbook#/, "")));
  return given.filter((r) => ids.has(r.id)).map(ref);
}
