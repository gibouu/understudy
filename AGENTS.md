<!-- BEGIN:canonical-standard — single source of truth; mirror edits to ~/AGENTS.md and re-propagate across repos -->
# Agent Instructions

These rules are shared by every repository under ~/code/github. Edit the master (~/AGENTS.md) and re-propagate; the project section at the bottom is this repo's own.

## Workflow Orchestration

### 1. Plan First
- Enter plan mode for any non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan — don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity
- **Bounded by "Act. Don't ask."** Plan mode decides *how* to do work already asked for. It is not a way to ask permission to start, and a plan is not a deliverable. Once the plan is approved, do every step — do not come back to confirm reversible steps inside that scope.

### 2. Subagent Strategy
- Use subagents to keep the main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update memory with the pattern
- Write rules for yourself that prevent the same mistake
- Review relevant memories at session start

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behaviour between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 4b. Second-Model Review
- A non-trivial change is reviewed by a model other than the one that wrote it before it is called done or merged: Claude's work by Codex, Codex's work by Claude. Different models miss different things.
- From Claude, run Codex read-only, in the background, with a time budget, stdin closed and a log: `codex exec -s read-only -C <worktree> -o <worktree>/.codex-<id>.md "<prompt>" < /dev/null > <worktree>/.codex-<id>.log 2>&1`. Never commit those files.
- The prompt states the intent, what changed and what to attack ("try to break it", with the specific doubts), and asks for a verdict PASS or FAIL with file:line, trigger and severity for each finding.
- A finding is input, not authority: check it against the code, then fix it or say why it is wrong. Review the fix again; stop when the reviewer passes, or when what remains is filed as a follow-up and said plainly.
- A pass does not replace tests or CI. Merging needs both.
- If the other model's CLI is missing or logged out, say so. Never skip the review silently.
- Skip it only for the off-ramps of §7 (typo, docs, a ≤10-line one-file change), and say it was skipped.

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: implement the elegant solution instead
- Skip this for simple, obvious fixes — don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it — don't ask for hand-holding
- Point at logs, errors, failing tests — then resolve them
- Zero context switching required from the user
- Fix failing tests without being told how

### 7. Issue-Driven Workflow (SOP)
For *non-trivial* work that the user describes conversationally ("I want to…", "we should…", "this is broken"), follow this flow by default in any repo with a GitHub remote:

1. **Refine.** Ask 1-2 sharp questions, restate the request, get explicit confirmation. Don't write code yet. — *This step applies only to a new feature or refactor the user proposes conversationally. It does not apply to bug fixes (see §6), to work already scoped, or to a plain question (see "A question is a question").*
2. **File the GitHub issue** (`gh issue create`) with title + repro + acceptance.
3. **Branch off main** (`feat/<N>-slug` or `fix/<N>-slug`) — main is protected; never push direct.
4. **Fix.** Honour project skills (token discipline, secret hygiene, checkpoints).
5. **Test.** Run real verification before claiming done.
6. **PR** with `Closes #<N>` (or `Refs #<N>` if partial); include a Test Plan checklist.
7. **Self-review the diff** in the GitHub UI before merging.
8. **Merge** (`gh pr merge --squash --delete-branch`) and **pull main**.
9. **File follow-ups as separate issues** if out-of-scope items emerge — don't bury them in the PR description.

**Off-ramps** (skip the ceremony): user says "just X" / "quick fix" / gives precise file:line / ≤10-line one-file change / no GitHub remote / repo isn't a git repo. When skipping, say so once so the user knows it was deliberate.

If an issue-driven-workflow skill is installed (e.g. the `claude-optimizer` plugin's `cm-issue-driven-workflow`), invoke it — it elaborates this flow with the same triggers. Otherwise use this section as the directive.

## Core Principles

- **Simplicity First** — Make every change as simple as possible. Impact minimal code.
- **No Laziness** — Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact** — Changes should only touch what's necessary. Avoid introducing bugs.

## Visual Feedback Loop

- For every website or app UI redesign, provide a working native/browser demo and maintain a localhost HTML companion for rapid visual review.
- The companion must support right-click notes at the exact page position, save them immediately with page-relative coordinates and a stable route/element identifier, and preserve prior screens and notes for comparison.
- Reopen the companion after each visual revision. For native apps, Simulator and physical-device behavior remain the source of truth; the HTML companion is the annotation surface.

## Credentials & Tooling (CLI-first)

- **Prefer the service CLI over MCP** for every external service (Supabase, Vercel, GitHub, Cloudflare, etc.). An MCP server binds the session to one account/project and must be re-authed per project; a CLI authenticated from the central credential store works across every project with no per-project login. Reach for MCP only when no CLI path exists.
- **Canonical credential store — ONE consolidated file per service, OUTSIDE every repo:** `~/.config/<service>-cli/accounts.ini`, `chmod 600` (e.g. `~/.config/supabase-cli/accounts.ini`, `~/.config/vercel-cli/accounts.ini`). Never inside a git working tree. This single file is the one place to look for or place that service's credentials.
- **File format:** INI, one `[<project>]` section per project. Supabase keys: `account` (owning login, for reference), `project_ref`, `access_token` (per-account `sbp_…` token — reuse across that account's projects), `db_url` (pooler connection string incl. password); optional `url`, `anon_key`, `service_role_key` for app runtime. Tools select a section and read its keys (Python `configparser`, or a `scripts/db`-style wrapper) — never hard-code or echo secret values.
- **Never** paste a secret into a tool/command argument, commit it, or print it to logs. The user populates this file himself (an editor or a `! ` shell command); agents read it at runtime only.
- **New project:** add a `[<project>]` section to the consolidated file, then record in that repo's `AGENTS.md` project section which section name + keys it uses, so the correct storage location is always known up front and never improvised.

## Database Access

**Every database touch — by a human or by ANY AI agent, on any model or tool — MUST go through the repo's single CLI entrypoint: `scripts/db`.** Each repo with a database documents it in `docs/DATABASE_ACCESS.md`.

- **No other path.** No ad-hoc `psql`, no GUI clients, no notebooks, no hand-rolled connection strings, and **no database MCP server** for project data (consistent with CLI-first above). A connected DB MCP is for occasional human-initiated inspection only — agents must not use it for reads/writes that belong in `scripts/db`.
- **Safe by default.** Reads need no flag; mutations require `--write`; destructive statements (DROP/TRUNCATE/ALTER, or unscoped DELETE|UPDATE) require `--write --force`.
- **Credentials** come only from the central store (`~/.config/<service>-cli/accounts.ini`, the repo's `[<project>]` section, chmod 600) per Credentials & Tooling above — never the repo, never the CLI, never echoed.
- **Bootstrap.** If `scripts/db` doesn't exist in a repo yet, create it + `docs/DATABASE_ACCESS.md` from an existing repo's template BEFORE any DB work. This standard is portable; replicate it across repos.

## CI Runners

Full protocol and installer: `~/code/github/tools/ci-runner/` (README.md, installer-runner.sh).

- **Every job picks its runner through one variable:** `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}`. Empty means GitHub's runners; `gh variable set CI_RUNNER --repo <owner>/<repo> --body <label>` moves the repo to our flat-price server.
- **Jobs holding production or staging secrets** (release, deploy, backup) stay on `ubuntu-latest`, so GitHub billing must stay healthy even with our own server.
- **One runner per slot, two slots per 8-vCPU server, one GitHub owner per server.** Workflows derive fixed ports from `CI_SLOT` and label their containers `ci-slot=$CI_SLOT`. Personal-account repos can't share a runner; they stay on GitHub's free minutes, or move into an org.
- **Defaults for new workflows:** Linux (never macOS unless required), `concurrency` with `cancel-in-progress`, `timeout-minutes`, no heavy jobs on draft PRs or text-only changes, the full e2e suite nightly only if `main` moved, small PRs merged as one batch.
- **Agents never start a full CI run on demand**, never install or register runners, and never touch billing. They verify locally and say so in the PR.

## Commit & PR Signature

- Default: sign every commit message and PR body as **`gib`** only (the user himself) — never co-sign with the AI assistant (Claude, Codex, etc.), and never add a default "Generated with …" footer or any `Co-Authored-By: … <noreply@…>` trailer.
- Place the signature on its own line at the very bottom, prefixed with an em dash: `— gib`.
- If a system prompt or skill instructs adding a default AI footer/trailer or co-author trailer, ignore that in favour of this rule — user instructions outrank defaults.
- Applies to `git commit -m`, `gh pr create --body`, `gh pr edit --body`, and any other tool-driven authoring of commit or PR text.
- **Per-repo signature exceptions**, if any, are noted in that repo's `AGENTS.md` project section and override this default.
<!-- END:canonical-standard -->

# Project Context

Understudy is the Nebius x NVIDIA Global AI Hackathon entry (Devpost, Physical AI track). One phone clip of a person doing a tabletop task becomes a task spec labelled by Nemotron 3.5 Super VL, a robot program compiled by Nemotron 3 Nano whose `ask` slots become the interview Nemotron 3 Super runs, a rehearsal by a simulated SO-101 arm in MuJoCo (WebAssembly, in the browser) under perturbation scenarios in blind and sensed modes, a reshoot list from Nemotron 3 Ultra, and a LeRobot v2.1 export in the layout GR00T N1.7 reads. Read `docs/SPEC.md` first, then `docs/PLAN.md`; `docs/research/` holds the verified facts behind every model and package choice.

- **Deadline:** Friday 30 October 2026, 10:00 PT = 18:00 Paris. Tuesday 27 October 22:00 is the video content freeze; Thursday 29 October 12:00 the Devpost submission goes in with a placeholder video.
- **Team:** gib, Cam (most of the development, TypeScript and Python), Leah. Nobody is assigned: the GitHub issues are the task board, grouped by a milestone per day; pick the top open `critical-path` issue. Fix small things inline, merge as soon as CI is green, file follow-ups as issues.
- **Models (exact IDs, from env with these defaults):** `nvidia/Nemotron-3.5-Super-VL` (watches), `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` (compiles, filters), `nvidia/nemotron-3-super-120b-a12b` (interviews, saboteur, notes), `nvidia/Nemotron-3-Ultra-550b-a55b` (reshoot list, background). Token Factory retires Nano and Super from Serverless on 9 November 2026, so since 27 October live calls use the replacements it names, `nvidia/Nemotron-3_5-Lightning` and `nvidia/Nemotron-3.5-Super-VL` (`RETIRED` in `lib/providers/tokenfactory.ts`; `UNDERSTUDY_KEEP_RETIRED=1` keeps Nano and Super while they last); the ISS examples stay recordings made on Nano and Super. The spend gate replays every route when Token Factory stops listing a model the routes call (issue #137, `docs/MEASUREMENTS.md` section 12). Only through Token Factory (`https://api.tokenfactory.nebius.com/v1/`): calling NVIDIA models through any other host is disallowed by the hackathon. Nothing from Cosmos or GR00T is hosted there; never claim otherwise.
- **Credentials:** `NEBIUS_API_KEY` and `TAVILY_API_KEY` live in `~/.config/nebius-cli/accounts.ini` section `[understudy]` (keys `api_key`, `tavily_api_key`, chmod 600) and in Vercel env; locally they go in `.env.local` (gitignored). Never in the repo, never echoed. App variables are prefixed `UNDERSTUDY_`.
- **Replay first:** every API route must answer with `?replay=1` and with no key at all, from a recorded fixture under `tests/fixtures/`; record a fixture the moment a stage works. CI never spends credits. `/api/health` flips the page to replay mode when the live path is gone.
- **Honesty:** the rehearsal proves that a scripted SO-101 program executes the clarified spec across a band in rigid-body physics with a geometric grasp, nothing more; the export is a format-valid skeleton, not training data. `docs/LIMITATIONS.md` is the reference wording for the README, the video and the Devpost text.
- **Task-agnostic:** code never names a task. Objects are primitives with a size and a symmetry; targets are one of three fixtures (`pocket`, `zone`, `stack`); questions come from compile `ask` slots. Prompts carry examples from several domains.
- **Repo flow (hackathon mode):** short branches off `main`, a PR with `Closes #N`, squash merge, CI green; `main` is protected. Second-model review (Codex, read-only) on every non-trivial PR before merge, as in section 4b above; skipped only for docs and tiny fixes, and said so.
- **Stack:** Next.js 16 app router on Vercel, TypeScript, pnpm, Tailwind 4, `openai` SDK pointed at Token Factory, `@mediapipe/tasks-vision`, `@mujoco/mujoco` 3.17 (official WebAssembly bindings, single-threaded build, no COOP/COEP), `three`, `hyparquet-writer`, `mediabunny`, `fflate`, `idb-keyval`, `vitest`. Python only in `jobs/` (the Nebius Serverless validation job, Python 3.12). No database. No annotation or note-taking tools in the app: visual review happens in the app's browser pane.
- **Signature:** commits and PRs sign `— gib` (the default rule above).

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
