# Handover: start here

Written on 25 October 2026 for whoever picks up Understudy next. The deadline is Friday 30 October 2026, 18:00 Paris.

## Where things stand

- **Merged and working:**
  - The rehearsal stage, with Earth, Moon and orbit gravity (`/stage`).
  - The watch page, whose wrist crops find gloved hands far from the camera (`/watch`).
  - The shared contract (`lib/spec/`), the scene builder, IK on the arm's tip, and the LeRobot export writer.
- **Measured:** every claim in the pitch now has a number behind it. Read `docs/MEASUREMENTS.md` first.
  - A full session costs US$0.0375 on Token Factory.
  - The model fixes 94% of failing rehearsals from the simulator's notes.
  - A liquid model sits on top of MuJoCo, checked against Torricelli's law.
  - Gravity, pouring and motion are measured at Earth, Mars, Moon and orbit.
- **Not built yet:**
  - The routes: label, compile, interview, saboteur, notes, reshoot.
  - The program interpreter with grasp and release.
  - The scoreboard.
  - The export wiring.

  The open `critical-path` issues are the plan. The measurements tell you how to build each route: the prompt shapes that worked are in the bench scripts.

## Read in this order

1. `docs/MEASUREMENTS.md`: what is true today, with numbers.
2. `docs/SPEC.md`: the design. `docs/PLAN.md` is the day-by-day plan.
3. `AGENTS.md`, project section: the rules (Codex review before merge, `— gib` signature, no secrets in the repo, replay fixtures for every route).
4. Issue #79, "Handover: start here" (pinned): the `handoff` issues in the order to work them. Every route issue carries a comment with the measured design to build.

## How to run things

```bash
pnpm install
```

```bash
pnpm dev
```

```bash
pnpm test
```

The paid experiments read the Token Factory key from the file named by `UNDERSTUDY_ENV_FILE` and log every call to `bench/results/ledger.jsonl`. The ledger has a hard cap of US$90. About US$77 of the budget is left. `node scripts/bench-ledger.mjs` prints the spend. The commands for each experiment are at the end of `docs/MEASUREMENTS.md`.

## What to build next, in order

1. **The routes, using what the experiments learned:**
   - **Label:** add a one-line task hint field, since the model misreads the ISS clip without one.
   - **Compile:** add the ask rule and its example.
   - **Interview:** use the two-call design.
   - **Saboteur:** enforce 12 scenarios with gravity.
   - **Notes:** use the escalating patcher.
   - **Playbook:** tag rules by task.

   Each is in the issue for that route: #11, #16, #17, #27, #28, #56.
2. **The interpreter and the 1 g / 0 g demo:** #22, #65, #66, #67.
3. **Speed and the scoreboard:** the headless batch rehearsal (#76), then the scoreboard (#55).
4. **The liquid on the stage page:** #74.
5. **Fixes and stretch:** scene and IK fixes (#77), the solver's remaining limits (#75), and the training-data log for a future fine-tune (#78).

Every piece of work is one branch, one PR, a Codex read-only review before merge, and green CI.
