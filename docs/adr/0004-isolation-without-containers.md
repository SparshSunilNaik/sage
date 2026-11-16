# ADR 0004 — Isolation without containers

- Status: accepted
- Date: 2026-11-16

## Context

research.md G4 plans "one container per task". The project constraints forbid Docker, Kubernetes,
WSL, VMs and Windows Sandbox.

## Decision

Isolation is layered from what a normal user process can do:

1. **Git worktree per task** (`.sage/wt/<run>/<task>`) on its own branch; the user's checkout and
   target branch are never written until `sage merge` after a human `sage approve`.
2. **Process per task attempt**: a dedicated `opencode serve --stdio` process with its own DB
   (`OPENCODE_DB`), killed as a tree at the end.
3. **Scrubbed environment**: allowlist of benign variables; anything that looks like a credential
   is dropped (provider keys only via explicit `engine.opencode.passEnv`, for the engine process).
   Verification gates always run with the fully scrubbed environment.
4. **Policy on every tool call** via the guard plugin (`execute.before`, fail-closed), enforcing a
   path jail, protected paths, command allow/deny lists, network-off-by-default and secret-env rules.
5. **Independent verification** catches what the policy cannot see (e.g. a script the agent runs
   that edits a protected file): protected-file changes are detected from the committed diff.

## Consequences

This is **process- and policy-level isolation, not kernel-level**. See `docs/THREAT_MODEL.md` for
exactly what is and is not protected. The engine adapter boundary means a container- or
sandbox-based runner (e.g. bubblewrap on Linux) can be added later without touching the
orchestrator.
