# SAGE — Architecture

SAGE is a **control plane above OpenCode**. OpenCode is the execution engine (providers, the tool
loop, LSP, MCP, sessions). SAGE owns everything around a coding session: the durable task
lifecycle, planning into a task graph, scheduling, per-task workspaces, a policy check on every tool
call, independent verification, budgets, human approval gates and an auditable trace.

```mermaid
flowchart TB
  user([Developer]) -->|sage run / approve / merge| cli[sage CLI]
  cli --> orch
  subgraph SAGE["SAGE control plane (one process per run)"]
    orch[Orchestrator<br/>scheduler · lifecycle · recovery · budgets]
    journal[(Journal<br/>SQLite, append-only events<br/>+ projections, leases)]
    planner[Planner<br/>Zod-validated task graph]
    policy[Policy engine<br/>path jail · protected paths<br/>commands · network · secrets]
    verify[Verifier<br/>gates · parsers · tamper check]
    trace[Trace<br/>JSONL spans, OTel GenAI names]
    guard[Guard endpoint<br/>127.0.0.1 + per-run token]
    orch <--> journal
    orch --> planner
    orch --> verify
    orch --> trace
    guard --> policy
    guard --> orch
  end
  subgraph Engine["OpenCode 2.x (one `opencode serve --stdio` per task attempt)"]
    oc[Server API<br/>HTTP + SSE]
    plugin[sage-guard plugin<br/>execute.before · permission.evaluate]
    tools[Tool loop<br/>shell · read · write · edit · patch · …]
    oc --- tools
    tools -->|every call| plugin
  end
  orch -->|EngineAdapter<br/>create session · prompt · wait · usage| oc
  plugin -->|POST /v1/guard| guard
  orch --> wt[(git worktree per task<br/>branch sage/&lt;run&gt;/task-&lt;id&gt;)]
  tools --> wt
  verify --> wt
  wt -->|merge in dependency order| rb[(run branch<br/>sage/&lt;run&gt;/run)]
  rb -->|sage merge after human approve<br/>fast-forward only| target[(your target branch)]
  provider[(Model providers<br/>OpenAI · Anthropic API · Copilot · …)] --- oc
```

## Lifecycle

**Run states:** `CREATED → PLANNING → AWAITING_PLAN_APPROVAL → EXECUTING → AWAITING_MERGE_APPROVAL → MERGED`,
with `FAILED` and `ABORTED` exits (`packages/core/src/states.ts`).

**Task states:** `PENDING → READY → RUNNING → VERIFYING → PASSED`, with `RETRYING`, `ESCALATED`,
`FAILED`. A task can only reach `PASSED` from `VERIFYING`, and `PASSED` means "gates green and
merged into the run branch".

A run, step by step (`packages/orchestrator/src/orchestrator.ts`):

1. `createRun` journals `run.created` (goal, base commit, target branch, run branch).
2. `setup` step: create the run branch from the base commit and an integration worktree.
3. `plan` step: a planner session (read-only policy) returns JSON; it is parsed and validated with
   Zod plus graph checks (unique ids, known deps, acyclic, safe paths). Invalid plans are fed back
   and retried (`retry.maxPlanAttempts`).
4. Plan approval: interactive prompt, `--yes`, or later `sage approve`.
5. Scheduler: promotes `PENDING` tasks whose dependencies `PASSED` to `READY`, runs up to
   `concurrency` (default 2) tasks at once.
6. Per attempt: `workspace:<n>` (worktree reset to the current run-branch tip, so dependants see
   their dependencies' work) → `agent:<n>` (fresh engine process + session seeded only with the task
   spec, plan summary, dependency summaries and retry feedback; commit with `Sage-Run/Task/Step`
   trailers) → `verify:<n>` (gates + tamper check) → `merge:<n>` (serialised `--no-ff` merge into
   the run branch).
7. Failures are classified and handled by `decideRecovery` (ADR 0006).
8. All tasks passed → `AWAITING_MERGE_APPROVAL` with a pending merge approval. `sage approve` +
   `sage merge` fast-forward the target branch.

## Guard path (one tool call)

```mermaid
sequenceDiagram
  participant M as Model
  participant OC as OpenCode tool loop
  participant P as sage-guard plugin
  participant G as SAGE guard endpoint
  participant Pol as Policy
  participant H as Human (CLI)
  M->>OC: tool call (e.g. shell "curl …")
  OC->>P: execute.before {tool, input}
  P->>G: POST /v1/guard (bearer token)
  G->>Pol: evaluate(tool, args, task context)
  alt ask
    G->>H: prompt (or `sage approve --request`)
    H-->>G: allow / deny
  end
  G-->>G: journal policy.decision + trace execute_tool
  G-->>P: allow | deny
  alt deny
    P-->>OC: throw → tool error returned to the model
  else allow
    OC->>OC: run tool in the worktree
  end
```

## Data

- `.sage/sage.db`: `events` (append-only) + projections `runs`, `tasks`, `steps`, `approvals`, and
  the operational `leases` table.
- `.sage/runs/<run>/trace.jsonl`: spans.
- `.sage/wt/<run>/…`: worktrees (removed by `sage gc`).
- `.sage/engine/<run>/<task>-<attempt>/`: per-attempt OpenCode state (DB, logs).

`.sage/` is added to `.git/info/exclude` of the target repo.

## Engine boundary

`EngineAdapter` (`packages/core/src/engine.ts`) has two implementations: `OpencodeEngine`
(`packages/engine-opencode`) and `FakeEngine` (`packages/testkit`). The fake engine sends every
scripted tool call through the same guard HTTP endpoint the real plugin uses, so the whole policy
path is covered by the default (zero-cost) test suite.
