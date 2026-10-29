"use client";

import { useState } from "react";
import type { Predicate, Program, ProgramOp, TaskSpec } from "@/lib/spec/schema";

/** `failure_class`: the rehearsal's, when it gave one (none when a check did not hold); the playbook narrows to it (lib/spec/playbook.ts). */
export type Failure = { step_id: string; op?: number; world: string; why?: string; failure_class?: "embodiment_limit" | "spec_gap" };

const CHECKS: Record<Predicate["kind"], (p: Predicate, name: (id?: string) => string) => string> = {
  contact_both_pads: (p, n) => `both pads touch the ${n(p.object)}`,
  height_above: (p, n) => `the ${n(p.object)} is ${p.value} mm above the table`,
  inside_zone: (p, n) => `the ${n(p.object)} is inside the ${n(p.target)}`,
  no_collision: () => "nothing collides",
  tilt_under: (p, n) => `the ${n(p.object)} tilts under ${p.value}°`,
  gripper_within: (p, n) => `the gripper is within ${p.value} mm of the ${n(p.object)}`,
  object_still: (p, n) => `the ${n(p.object)} is still`,
  time_under: (p) => `under ${p.value} s have passed`,
  liquid_inside: (p, n) => `${p.value}% of the liquid is inside the ${n(p.target)}`,
};

function line(op: ProgramOp, name: (id?: string) => string): string {
  switch (op.op) {
    case "move_to": {
      const [x, y, z] = op.offset_mm;
      const at = x === 0 && y === 0 ? `${z} mm above` : `(${x}, ${y}, ${z}) mm from`;
      return `move to ${at} ${op.frame === "world" ? "the robot base" : `the ${name(op.frame)}`}, from the ${op.approach}`;
    }
    case "grasp":
      return `close the gripper to ${op.aperture_mm} mm on the ${name(op.object)}`;
    case "release":
      return "open the gripper";
    case "follow":
      return "follow the hand's path traced from the clip with the point between the pads, point by point";
    case "tilt":
      return op.deg === 0 ? `turn it back upright over ${op.seconds} s` : `tilt it ${op.deg}° toward ${op.toward ? `the ${name(op.toward)}` : "away from the robot"} over ${op.seconds} s`;
    case "wait_until":
      return `wait until ${CHECKS[op.predicate.kind](op.predicate, name)} (up to ${op.timeout_s} s)`;
    case "assert":
      return `check that ${CHECKS[op.predicate.kind](op.predicate, name)}`;
    case "ask":
      return op.question;
  }
}

/** The compiled program as plain lines, asks highlighted, and the op a rehearsal failed on marked. */
/** `by`: the model that wrote the program ("Nemotron 3.5 Lightning"); /space leaves it out, its recordings were all compiled by Nano (RECORDED_ON). */
export function ProgramView({ spec, program, failure, by = "Nano" }: { spec: TaskSpec; program: Program; failure: Failure | null; by?: string }) {
  const [raw, setRaw] = useState(false);
  const name = (id?: string) => spec.objects.find((o) => o.id === id)?.name ?? id ?? "?";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium">The robot&apos;s program</p>
        <button className="text-xs text-neutral-500 underline" onClick={() => setRaw(!raw)}>
          {raw ? "show lines" : "show JSON"}
        </button>
      </div>
      {raw ? (
        <pre className="max-h-96 overflow-auto rounded-lg bg-neutral-50 p-3 text-[11px]">{JSON.stringify(program, null, 2)}</pre>
      ) : (
        <ol className="flex flex-col gap-2 font-mono text-xs">
          {program.steps.map((s) => {
            const step = spec.steps.find((x) => x.id === s.step_id);
            return (
              <li key={s.step_id}>
                <p className="text-neutral-500">
                  {s.step_id} · {step ? `${step.verb}${step.object === undefined ? "" : ` ${name(step.object)}`}${step.target ? ` into the ${name(step.target.frame)}` : ""}` : "unknown step"}
                </p>
                <ol className="ml-4 flex flex-col">
                  {s.ops.map((op, i) => {
                    const failed = failure?.step_id === s.step_id && failure.op === i;
                    return (
                      <li
                        key={i}
                        className={`rounded px-1 ${op.op === "ask" ? "bg-amber-50 text-amber-800" : ""} ${failed ? "bg-red-50 text-red-800 ring-1 ring-red-300" : ""}`}
                      >
                        {op.op === "ask" ? "? " : ""}
                        {line(op, name)}
                        {failed && <span className="ml-2 font-sans">← failed in {failure.world}{failure.why ? `: ${failure.why}` : ""}</span>}
                      </li>
                    );
                  })}
                </ol>
              </li>
            );
          })}
        </ol>
      )}
      {program.warnings.length > 0 && <p className="text-xs text-neutral-500">{by} noted: {program.warnings.join("; ")}</p>}
      {program.playbook && (
        <p className="text-xs text-neutral-600">
          {program.playbook.length ? `${by} says it applied ${program.playbook.join(", ")}` : `${by} says it applied none of the playbook's rules`}
        </p>
      )}
    </div>
  );
}
