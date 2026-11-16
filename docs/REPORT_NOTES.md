# Report notes — gaps G1–G7 → what was built → evidence

Maps each gap in `research.md` §5 (and the traceability table §6) to the implementation and to
evidence a reader can check. "Evidence" means a test that passes in the default suite, a measured
number in `docs/EVALUATION.md` (regenerate with `sage eval`), or a recorded live run.

| Gap | Planned response (research.md) | What was built | Evidence | Deviations / not done |
|---|---|---|---|---|
| **G1** Session-bound execution | SQLite event-sourced journal, explicit state machines, leases + heartbeats, `sage resume`, project context in-repo | `@sage/core` journal (append-only `events` with triggers; projections rebuilt by replay), run/task state machines enforced on every event, step journal (started → done), run leases with heartbeat and dead-owner takeover, `sage resume` | `packages/core/test/core.test.ts` (transitions, append-only, steps, rebuild, leases); `packages/cli/test/cli.test.ts` "crash and resume" (7 kill points); EVALUATION.md chaos table (resume success 7/7, steps re-executed per recovery) | `AGENTS.md` is read (as untrusted context) but SAGE does not write project memory back to it |
| **G2** Unreliable recovery | idempotent/compensable steps, git checkpoint after each step, failure classification with per-class handling | 7 failure classes with a pure `decideRecovery` (backoff, feedback retry, rebase retry, escalate); commit checkpoint after every agent turn; worktree reset compensation when an agent step is resumed; idempotent merge | `core.test.ts` recovery tests; e2e tests "gate failure retries with gate output fed back", "transient provider errors back off and retry", "budget hard stop"; chaos table "extra agent invocations" | Re-planning after task failure (as opposed to retry) is not implemented; escalation goes to a human |
| **G3** Self-graded / gameable verification | gates run by the control plane, protected paths, flag test diffs, done only when gates pass | `@sage/verify`: SAGE runs gates with a scrubbed env, parses output ("no tests ran" = fail), checks the committed diff for protected-file changes; policy blocks direct edits; plan can grant `allowedTestFiles` | `packages/verify/test/verify.test.ts` (weakened test passes gates but is rejected); e2e "impossible task"; EVALUATION.md impossible-task section (false completions 0/1) | Coverage-diff gate not implemented; ImpossibleBench with a real model not run |
| **G4** Unsafe environments / uncontrolled tools | container per task, network off, policy via plugin, repo text untrusted | Worktree + process per task, scrubbed env, guard plugin on `execute.before` (fail-closed) → policy (path jail, protected paths, command allow/deny, network-off, secret env); repo OpenCode config disabled; `AGENTS.md` quoted as untrusted | `packages/policy/test/policy.test.ts`; `orchestrator/test/guard.test.ts`; e2e "red team"; EVALUATION.md red-team (blocked 14/14, landed 0); live trace in `docs/evidence/` showing every real tool call mediated | **No containers** (project constraint) — ADR 0004 and THREAT_MODEL.md state the process/policy-level limits honestly |
| **G5** Opaque decisions, limited oversight | OTel GenAI spans + event log, `sage trace`, approval checkpoints, separation of duties | JSONL spans with GenAI names (`invoke_agent`, `chat`, `execute_tool`, `gen_ai.*`), deterministic span ids across resumes, `sage trace` tree (goal → plan → task → model calls → tool calls + policy → diffs → gates → approvals), `Sage-Run/Task/Step` commit trailers, plan + merge approvals, agent cannot approve | `trace.test.ts`; e2e asserts tree content, trailers, author identity, 100% file attribution; CLI test asserts approve refuses in agent context; EVALUATION.md traceability column | `sage replay` not implemented; OTLP exporter not implemented (interface ready) |
| **G6** Multi-agent coordination / context rot | Zod task graph, fresh session per executor with only its spec, structured results | Planner emits a validated graph; each attempt is a new engine process + session seeded with the task spec, plan summary and *structured* dependency summaries (ids, titles, files); results return as records (head sha, files, gate results) | e2e "dependent tasks" (subtract sees multiply's work via the run branch); planner tests; live smoke (`docs/evidence/`) | Tokens-per-task vs single-session baseline not measured |
| **G7** Lock-in and cost blindness | per-run/per-task budgets with hard stop, role-based routing, providers via OpenCode official auth | USD + token budgets per task and run, checked after every model call with immediate session interrupt; `engine.model` and `engine.plannerModel` (role routing); all providers through OpenCode; `sage doctor` reports auth presence without secrets | e2e "budget hard stop"; adapter test "budget hard stop interrupts the turn"; EVALUATION.md budget section (overrun bounded by one call) | Cost per resolved task with a real model not measured; the live smoke used a ChatGPT sign-in that reports $0 |

## Traceability to the problem statement (research.md §6)

| Claim | Where it is addressed |
|---|---|
| P1 "operate within individual sessions" | journal + `sage resume` (G1) |
| P2 "coordinate tasks" | planner → task graph → scheduler (`packages/planner`, `orchestrator.execute`) |
| P3 "manage execution environments" | worktree + process per task, scrubbed env (ADR 0004) |
| P4 "verify results" | `@sage/verify`, protected paths (ADR 0006) |
| P5 "handle failures" | `decideRecovery`, checkpoints, escalation |
| P6 "continuity across sessions" | journal, deterministic resume, dependency summaries |
| P7 "unified orchestration" | the orchestrator above OpenCode |
| P8 "transparent decision-making" | `sage trace`, policy decisions journaled |
| P9 "model-agnostic" | OpenCode providers behind `EngineAdapter`; live run with OpenAI via OpenCode |
| P10 "multiple agents, persistent context" | planner + executors, structured hand-off |
| P11 "isolated execution, controlled tool access" | guard plugin + policy |
| P12 "human oversight, traceable actions, measurable verification" | approvals, trailers, gates, `sage eval` |
| P13 "extending existing open-source infrastructure" | OpenCode server API + plugin; **no fork patches were needed** |

## Numbers to quote

Quote only from `docs/EVALUATION.md` (regenerated by `sage eval`; it records commit and date) and
`docs/evidence/`. Fake-mode resolved rates measure SAGE's pipeline with scripted agents, **not**
model capability — say so in the report.
