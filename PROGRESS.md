# SAGE — Progress

This file is updated in the same commits as the work it describes. The git history plus this file
should be enough to resume after an interruption.

_Last updated: 2026-11-16 (session 2: verification and website)._

## MVP checklist

| # | Item | Status | Where / evidence |
|---|---|---|---|
| 1 | Durable lifecycle: run and task state machines; transitions journaled before side effects; kill and resume | done | `packages/core`; `orchestrator.ts`; CLI crash tests at 7 kill points |
| 2 | Planning: Zod task graph with deps, acceptance criteria, files, allowed tests; invalid plans re-planned; human approval unless `--yes` | done | `packages/planner`, `core/src/plan.ts`; e2e "invalid plans are rejected and re-planned" |
| 3 | Execution: worktree, branch and `opencode serve` per task attempt; fresh session seeded with the spec only; dependency-aware scheduler; concurrency 2 | done | `orchestrator.ts`, `engine-opencode`; e2e concurrency test (peak RUNNING = 2) |
| 4 | Policy: path jail, protected paths, command allow/deny, network off, scrubbed env, ask via CLI, repo text untrusted, every decision journaled | done | `packages/policy`, guard plugin and server; red-team test |
| 5 | Verification: SAGE runs gates and parses results; protected-file tamper check | done | `packages/verify`; impossible-task test |
| 6 | Recovery: 7 failure classes with defined handling; limits from config | done | `core/src/failure.ts`; e2e retry, transient and budget tests |
| 7 | Budgets: tokens and cost per task and run, hard stop | done | `onModelCall` budget check plus session interrupt; e2e and adapter tests |
| 8 | Merge and oversight: run branch in dependency order; target branch untouched until approve and merge; trailers; machine identity; agent cannot approve | done | `oversight.ts`; e2e and CLI tests |
| 9 | Traceability: `sage trace` tree; every change attributable to a task | done | `packages/trace`; e2e attribution assertion |
| 10 | CLI: init, run, plan, status, approve, reject, resume, abort, trace, diff, merge, doctor, gc, eval; Zod-validated JSONC config | done | `packages/cli`; CLI tests |
| 11 | Tests: state machines, policy, e2e, crash/resume, red team, impossible task; green on Windows | done | 106 tests, 0 failures (session 2). CI is green on windows-latest and ubuntu-latest |
| 12 | Eval scaffold: 7 tasks in 3 fixture repos with hidden tests, plus chaos, red-team, impossible and budget suites; fake and live modes; EVALUATION.md with measured numbers only | done (fake mode measured) | `evals/`, `docs/EVALUATION.md`. Live eval **not run**, see below |
| 13 | Docs: README, ADRs, REPORT_NOTES, THREAT_MODEL, ARCHITECTURE, PROGRESS | done | `docs/` |
| 14 | Small commits, pushed, authorship audit, lint clean, disk reported | done | see the final summary in the session log; `bun run disk` |

## What works end to end

- Fake engine (zero cost): `bun run demo`, then `sage run … --yes`, `trace`, `approve`, `merge`.
- Real engine: `scripts/engine-probe.ts` passes against OpenCode 2.3.0 (the fork's version) and
  against 2.0.29. In both, the guard plugin loads and reports `active` and a session is created.
- Live smoke test: one full run with `openai/gpt-6.1-terra` through OpenCode 2.0.29 and a ChatGPT
  sign-in.
  - Path: plan → execute → 10 tool calls, all mediated by the guard → SAGE gate passed → merged into
    the run branch; `main` untouched.
  - Usage: 43,879 tokens; OpenCode reported $0.00 for this sign-in type.
  - Record: `docs/evidence/live-smoke-2026-11-16.md`.

## Stubbed, incomplete or not done

- **Live `sage eval --live` was not run.** Only the single live smoke run above was done. EVALUATION.md
  therefore contains fake-mode numbers, and marks model-dependent metrics as "not measured".
- No **bare-OpenCode baseline** harness, so no comparison with OpenCode alone.
- No **SWE-bench** runs. The official harness needs Docker, which is out of scope.
- **Re-planning after a task failure** is not implemented. Failures are retried or escalated to a
  human. Re-planning applies only to invalid plans.
- `sage replay`, an OTLP exporter and a coverage-diff gate are not implemented. The exporter
  interface exists.
- `sage merge` only fast-forwards. If the target branch moved during the run, the user merges by
  hand.
- Interactive "ask" prompts use @clack/prompts in a TTY. Without a TTY, asks wait for
  `sage approve --request <id>` (`JournalAsker`). This mode has unit coverage only through
  `ScriptedAsker`.
- No fork patches were needed, so there is no `sage` branch in `engine/opencode`. The submodule
  points at the fork's `dev` HEAD (`e4606463e7`), which exists on the remote.

## Known bugs / rough edges

1. A run's `invoke_agent` span shows the model as `default` when `engine.model` is unset. In that
   case the real model appears only on the `chat` spans.
2. Budget overrun is bounded by one model call, not zero. With the fake price table and a tiny
   limit, the eval shows a 62% overrun of a $0.005 limit (one call costs $0.0081).
3. When a provider reports no cost (subscription sign-ins), only token caps protect spend.
   `engine.opencode.pricing` can estimate cost, but it must be configured by hand.
4. The shell analyser is conservative. Unusual but harmless commands become "ask", which stalls
   unattended runs until the ask times out (5 min default) and is denied.
5. `bunfig.toml` `[test] timeout` is ignored by Bun 1.4.4, so long test files call
   `setDefaultTimeout`.
6. `sage gc` kills a leftover engine process by the pid recorded in its state directory. If the
   OS has reused that pid for an unrelated process, gc would kill that process.
   *Proposed fix:* record the process start time with the pid and compare it before killing
   (`wmic`/`Get-Process` on Windows, `/proc/<pid>/stat` on Linux).
7. Coverage is measured in-process only. Code that runs in CLI subprocesses (`packages/cli/src`,
   the crash and robustness tests) is exercised by tests but not counted by `bun test --coverage`.
8. Concurrent runs in the same repo are safe (tested), but they serialise on SQLite's write lock.
   Throughput with many parallel runs has not been measured.

## Session 2 (2026-11-16): verification results

No live model calls were made in this session.

- **CI:** green on ubuntu-latest and windows-latest for the latest commits. One earlier red run was
  caused by a generated JSON file failing the formatter; generated eval output is now excluded
  from lint.
- **Fresh clone:** `git clone --recurse-submodules`, then `bun install`, `bun test`, `bun run demo`,
  the fake-mode `sage run` and `sage trace` from the README, and `sage doctor`. All of them work
  verbatim on Windows, in both Git Bash and PowerShell. The temporary clone was deleted afterwards.
- **README fixes:** clone with `--recurse-submodules`; added a `sage doctor` step with an
  explanation of the expected `WARN` lines; added the tested versions; synced the command
  reference with `--help`. `packages/cli/test/docs-sync.test.ts` now enforces that sync.
- **Full suite:** 106 tests, 0 failures. `bun test --coverage` reports **89.43% lines / 89.31%
  functions** (in-process code only, see known issue 7). Biome is clean, typecheck is clean, the
  link checker finds 0 broken links, and the fake-mode `sage eval` was regenerated.
- **Robustness checks** (all are now repeatable tests in `packages/cli/test/`):
  - Crash and resume at all 7 kill points, repeated 3× (21 runs): all pass.
  - Two concurrent runs in one repo: **bug found and fixed.** The second process failed with
    `database is locked`, because a deferred SQLite transaction that upgrades from read to write
    does not wait on the busy handler. Writes now use `BEGIN IMMEDIATE`, and the busy timeout is set
    before WAL. The test now checks journal rebuild equality, separate branches and worktrees, and
    correct content for both runs (passed 4/4 consecutive runs).
  - `sage gc` after an aborted run: **gap fixed.** gc removed worktrees but not leftover engine
    processes. The OpenCode adapter now writes an `engine.pid` file per server, and gc kills any
    that are still alive.
  - Uncommitted changes in the target repo: untouched, both tracked edits and untracked files.
    `sage merge` refuses with a clear message instead of overwriting them.
  - Repo path containing spaces: works end to end, including merge.
  - Paths longer than 260 characters inside a worktree: created, verified and merged.
  - `sage abort` during a pending policy "ask": **bug fixed.** The non-interactive approver kept
    waiting until its 5-minute timeout, and the orchestrator would have attempted invalid
    transitions on the ABORTED run. Now abort rejects pending approvals, the approver and the guard
    stop on ABORTED, in-flight engine turns get an abort signal, and the scheduler stops. In the
    test, the process exits within seconds.
  - Invalid `sage.config.jsonc`: **improved.** The error used to be a raw Zod dump. It now names the
    file and every bad key (`retry.maxAttempts: …`), and syntax errors say "is not valid JSONC".
- **`sage doctor`: 2 bugs fixed.**
  - The version check compared `v2.0.29` with `2.3.0`, so equal versions would also have been
    reported as a mismatch.
  - Sign-in detection looked for a V1 `auth.json`; it now asks `opencode auth list` and prints
    names only.

## Suggested next fixes (priority order)

1. Run `SAGE_LIVE=1 SAGE_EVAL_MODEL=<model> sage eval --live --max-usd 3`. Then add a
   bare-OpenCode baseline runner, using `opencode run` on the same fixtures, so the comparison is
   measured.
2. Kernel-level containment behind the adapter:
   - bubblewrap/seccomp on Linux;
   - AppContainer or a restricted token on Windows.
   This addresses residual risk 1 in THREAT_MODEL.md.
3. Re-planning on repeated `gate_failed`: ask the planner to split or re-specify the task.
4. A merge strategy for a target branch that moved: rebase the run branch in the integration
   worktree, then re-verify.
5. Pass the model id into `invoke_agent` spans from the engine's first `step.started` event.
6. An OTLP exporter, and `sage replay`.

## Environment notes (this machine)

- Git identity used for every commit, unchanged: `SparshSunilNaik <ssn7406n@gmail.com>`.
- Bun 1.4.4 was installed with `npm i -g bun`. The Bun cache is at `./.cache/bun-install`.
- Biome runs through WASM because Windows Application Control blocks the native `biome.exe`
  (ADR 0003).
- OpenCode 2.3.0 is installed project-locally in `.cache/opencode-2.3.0` (gitignored). The user's
  global OpenCode is 2.0.29.
- Disk use is 1.44 GB in total (`bun run disk`), including about 0.7 GB for `.cache` (the Bun cache plus the OpenCode 2.3.0 binary).
  Leftover test fixtures in temp were removed at the end of the session.

## Session 2 (2026-11-16): project website

- **Location:** a static site in `docs/` for GitHub Pages ("Deploy from a branch", `main`, `/docs`).
  - `docs/index.html` and `docs/404.html`.
  - Assets are in `docs/site/` (css, js, img), plus `docs/.nojekyll`.
  - There is no build step, no framework, no external scripts, no trackers and no web fonts (system
    font stacks only).
  - Page weight is about 62 KB (HTML + CSS + JS + icon), plus a 60 KB social preview PNG that is
    only fetched by link unfurlers.
- **Content:**
  - a hero with real captured `sage run` and `sage trace` output;
  - the problem, with three sourced facts from research.md;
  - a hand-built inline SVG architecture diagram and the run lifecycle;
  - outcome-framed features tied to gaps G1–G7;
  - install and quickstart, using the commands verified in the fresh-clone test;
  - use cases and non-use cases;
  - evidence, labelled as fake-engine results;
  - limitations, and a footer.
- **Design:** a typeset engineering-paper look with a terminal accent.
  - Serif text and monospace for machine output, warm paper neutrals and one vermilion accent.
  - Numbered section rail (§1–§7).
  - Light and dark via `prefers-color-scheme`, plus a remembered manual toggle (localStorage
    wrapped in try/catch; `?theme=` for testing).
- **Tooling:**
  - `scripts/serve-site.ts` serves `docs/` under `/sage/` like GitHub Pages; `--check` crawls
    every page, asset and `#anchor`.
  - `scripts/check-links.ts` checks relative links in README, docs and the site, including
    anchors and absolute site URLs.
  - `scripts/site.test.ts` runs both in `bun test`, and also checks that there are no external
    scripts or root-absolute paths.
- **Verification:**
  - HTML is valid (html-validate, recommended rules).
  - Heading order is correct with a single h1. Landmarks, a skip link, visible focus and labelled
    SVGs are in place.
  - WCAG AA contrast is computed for 30 colour pairs across both themes; all pass.
  - Screenshots were taken at 375/768/1440 px in light and dark (Edge headless full-page, plus the
    in-app browser for section detail). They are kept in `.cache/shots/`, not committed.
- **Critique-and-fix rounds:**
  1. Terminal output unreadable: the inline-`code` style leaked into it, painting light bars over
     the text. The hero heading wrapped to 5 lines. The theme-toggle label was ambiguous. In the
     diagram, edges crossed, labels collided and monospace notes overflowed their boxes. The
     diagram was re-laid out so that no edges cross.
  2. At 375 px the page laid out 606 px wide: the round-1 hero override beat the mobile media
     query. The mobile nav reorder targeted the wrong element. Long commands scrolled under the
     copy button (they now wrap on narrow screens). The evidence table scrolled sideways (it now
     stacks per row). The wordmark square was invisible in dark mode (it now uses theme tokens).
     `--yes` broke across lines inside the lifecycle cells. html-validate flagged `aria-label` on a
     plain `<ol>` and `<pre>`.
  3. At 1440 px the longest demo command scrolled inside a code block narrower than its column
     (code blocks widened). The theme toggle was verified to persist across reloads over the
     system preference.
- **Social preview:** `docs/site/img/social.svg` is the original, exported to `social.png`
  (1200×630) with Edge headless.
- **License:** the repository has no LICENSE file yet. The footer says so and does not claim one.
  Choosing a license is left to the author.
