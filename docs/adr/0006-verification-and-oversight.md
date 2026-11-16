# ADR 0006 — Independent verification and separation of duties

- Status: accepted
- Date: 2026-11-16

## Decision

1. **The model never grades its own work.** After the agent's turn, SAGE commits the worktree and
   runs the configured gates itself (`bun test`, `tsc`, Biome, …) with a scrubbed environment and
   parses their output. "No tests ran" is a failure. A task is PASSED only if all required gates
   pass **and** no protected file changed without plan authorisation.
2. **Protected paths** (tests, CI, SAGE/agent config) are read-only by policy; the plan may grant a
   task specific test files (`allowedTestFiles`). The verifier re-checks the committed diff, which
   also catches indirect edits the policy cannot see.
3. **Two human gates**: plan approval (skippable only by the human with `--yes`) and merge approval.
   `sage merge` requires an approval whose actor is `human`, and only fast-forwards.
4. **An agent cannot approve or merge its own work**:
   - approvals are not reachable over the guard endpoint (only `/v1/guard` and `/v1/health` exist);
   - the `sage` command is on the policy denylist;
   - `assertHuman()` refuses approvals in any process whose environment has
     `SAGE_AGENT_CONTEXT=1`, which SAGE sets for every engine and gate process;
   - the journal DB lives outside every task worktree (path jail).
5. **Failure handling is deterministic** (`decideRecovery`): `provider_transient` → backoff retry;
   `tool_error`/`gate_failed` → retry with gate output fed back; `policy_denied` → one feedback retry
   then escalate; `conflict` → retry from the new run-branch tip; `budget_exhausted`/`unknown` →
   escalate. Escalated tasks only retry when a human runs `sage resume --retry-escalated`.
