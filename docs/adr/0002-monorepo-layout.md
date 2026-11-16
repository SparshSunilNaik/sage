# ADR 0002 — Monorepo layout and package boundaries

- Status: accepted
- Date: 2026-11-16

## Decision

Bun workspaces monorepo, TypeScript strict, no `any`, Zod at every boundary.

| Package | Responsibility | Depends on |
|---|---|---|
| `@sage/core` | types, run/task state machines, plan schema, config schema, event-sourced journal (SQLite + Drizzle), leases, failure classes, `EngineAdapter` interface | zod, drizzle-orm |
| `@sage/workspace` | git helpers, worktrees, process-tree kill, env scrubbing, disk accounting | — |
| `@sage/policy` | pure rule engine for tool calls (path jail, protected paths, commands, network, secrets) | core |
| `@sage/planner` | planner/executor prompts, JSON extraction, validated re-planning | core |
| `@sage/verify` | gate runner, output parsers, protected-file tamper check | core, workspace |
| `@sage/trace` | JSONL span exporter (OTel GenAI names), redaction, tree renderer | zod |
| `@sage/guard-plugin` | the OpenCode V2 plugin + its dependency-free wire protocol | — |
| `@sage/engine-opencode` | the only package that knows OpenCode (ADR 0001) | core, workspace |
| `@sage/testkit` | deterministic fake engine, fixture repos, scripted scenarios | core, workspace, guard-plugin |
| `@sage/orchestrator` | **added vs. the suggested layout**: scheduler, task lifecycle, guard server, recovery, budgets, oversight | all of the above |
| `@sage/cli` | the `sage` command (Commander + @clack/prompts) | orchestrator |
| `@sage/evals` | `sage eval` suites and report generator | orchestrator, testkit |

## Why an `orchestrator` package

The suggested layout put the scheduler in `core`. The scheduler needs the planner, policy, verifier,
workspace and trace packages; putting it in `core` would make `core` depend on everything and
create cycles. `core` stays a leaf (types + journal), and the orchestration logic that composes the
other packages lives in its own package.

## Other notes

- `guard-plugin` deliberately has **no dependencies**: OpenCode loads it from its own runtime,
  where SAGE's `node_modules` are not on the resolution path. Its `opencode/` subdirectory is the
  entry OpenCode loads (see `docs/upstream-candidates.md` #1).
- `testkit` is a runtime dependency of `orchestrator` only because `engine.kind = "fake"` must be
  selectable from `sage.config.jsonc` (used by `sage eval` and the CLI crash tests).
