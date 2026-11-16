# ADR 0005 — Durability: event sourcing + step journal

- Status: accepted
- Date: 2026-11-16

## Decision

- **Append-only `events` table** in SQLite (`bun:sqlite`, WAL, `synchronous=FULL`), protected by
  triggers that reject UPDATE/DELETE. Every state change is an event, validated with Zod and with
  the run/task state machines (`from` must equal the current state).
- **Derived tables** (`runs`, `tasks`, `steps`, `approvals`) are projections updated in the same
  transaction as the event; `Journal.rebuild()` drops and replays them, and tests assert the result
  is identical.
- **Steps**: every side-effecting operation runs through `journal.step(run, task, key, fn)`, which
  journals `step.started` *before* `fn` and `step.done` (with its result) after. A completed step is
  never re-run; a started-but-unfinished step re-runs with `resumed = true` and must be idempotent
  or compensate first. Examples:
  - `workspace:<n>`: `ensureWorktree` is idempotent.
  - `agent:<n>`: on resume, the worktree is reset to the attempt's base commit (discarding partial,
    unverified edits) before the agent runs again.
  - `merge:<n>`: skipped if the task head is already an ancestor of the run branch.
  - `final-merge`: fast-forward only; repeated runs are no-ops.
- **Leases**: one orchestrator drives a run at a time (`leases` table, TTL + heartbeat). On
  `sage resume`, a lease held by a dead process on the same host is taken over.
- **Crash testing**: `SAGE_CRASH_AT=<point>` makes the orchestrator kill itself (SIGKILL /
  TerminateProcess) at named points; the CLI test-suite and `sage eval` resume after each point and
  assert no duplicated side effects.

## Why not Temporal/DBOS/Inngest

They would satisfy G1/G2 but add a server dependency to a local-first CLI. The step journal gives
the needed guarantee for a single-machine orchestrator in a few hundred lines.
