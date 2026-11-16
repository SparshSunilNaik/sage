# SAGE — Threat model

**Summary: SAGE provides process- and policy-level isolation, not kernel-level isolation.** There
is no container, VM or OS sandbox (project constraint: no Docker, WSL, VMs or Windows Sandbox).
SAGE runs agents as ordinary processes of the current user, confines them with git worktrees, a
scrubbed environment and a policy check on every tool call, and then verifies their output
independently. That stops the mistakes and attacks that go through the agent's *tools*. It does not
stop arbitrary code that the agent manages to execute from doing whatever the user account can do.

## Assets

1. The user's target branch and working tree.
2. Secrets in the environment and on disk (API keys, tokens, SSH keys, OpenCode's credential store).
3. Files outside the repository.
4. The integrity of the verification result ("this task passed").
5. The audit trail (journal, traces) and the approval decisions.
6. Money (provider spend).

## Adversaries and entry points

- **A misbehaving or reward-hacking model** (e.g. edits tests to pass, claims success, runs
  destructive commands). research.md G3/G4, ImpossibleBench, the Replit incident.
- **Prompt injection through repository content**: `AGENTS.md`, code comments, issue text, tool
  output, MCP results. research.md G4 [9][39][40].
- **A malicious repository** that ships its own OpenCode config, plugins or git hooks.

Not in scope: a malicious local user, a compromised OpenCode binary or provider, kernel exploits.

## Controls and what they cover

| Control | Where | Protects | Does NOT protect |
|---|---|---|---|
| Worktree per task + run branch; target branch only changed by `sage merge` after a human `sage approve` (fast-forward only) | orchestrator, oversight | asset 1 | — |
| Guard plugin on `execute.before` for **every** tool call, fail-closed (unreachable SAGE ⇒ deny; plugin not `active` ⇒ the task does not start; any OpenCode permission prompt ⇒ reject + fail turn) | guard-plugin, engine-opencode | assets 2–4 against tool calls | code the agent runs *indirectly* (below) |
| Path jail (resolved through symlinks), `~` expansion, `..`, absolute paths, `glob` patterns | policy | asset 3 for file tools and for path arguments of shell commands | paths computed at runtime inside a program the agent runs |
| Protected paths (tests, CI, `AGENTS.md`, SAGE/biome/bunfig config) read-only unless the approved plan grants a file | policy + verifier | asset 4 | — (indirect edits are caught by the verifier) |
| Verifier re-checks the committed diff for protected-file changes and runs gates itself, with a scrubbed env | verify | asset 4, including indirect edits made by a script the agent ran | a gate command that itself is compromised by non-protected code (e.g. a test helper the plan allowed the agent to edit) |
| Command allow/deny lists; network-capable commands (`curl`, `wget`, `npm`, `bun add`, `git push/fetch/clone`, `Invoke-WebRequest`, …) and network tools (`webfetch`, `websearch`) denied by default; shells/interpreters with `-c`/`-e`-style escapes (`powershell`, `cmd`, `bash`, `sh`, `eval`) denied; command substitution denied; unknown commands ⇒ ask | policy | asset 2/3 against direct command use | a program on the allowlist that the agent *wrote* (e.g. `bun my-script.ts` that opens a socket or reads `process.env`) — see residual risks |
| Secret env access denied (`$X`, `%X%`, `$env:X` for secret-looking names, `process.env`, `printenv`, `env`, `set`) | policy | asset 2 against direct reads | indirect reads by a script the agent writes and runs |
| Environment scrubbing: engine and gate processes get an allowlisted env; secret-looking names are removed; provider keys only via explicit `passEnv` (engine process only); `OPENCODE_PASSWORD` is removed by OpenCode in `--stdio` mode | workspace, engine-opencode | asset 2 for gates and for agent shells when keys come from OpenCode's own store | keys passed via `passEnv` are in the engine process's environment, so a script run by the agent's shell could read them |
| Repo-supplied OpenCode config disabled (`OPENCODE_DISABLE_PROJECT_CONFIG=1`), Claude-Code compat disabled; `AGENTS.md` quoted to models inside `<untrusted>` markers | engine-opencode, planner | malicious repo config/plugins; instruction-hierarchy confusion | a model that follows injected instructions anyway — the policy still applies to whatever it then tries |
| Guard endpoint on `127.0.0.1`, random per-run bearer token, constant-time compare, Zod-validated requests bound to the run id and the *currently running* attempt | orchestrator | spoofed decisions from other local processes / stale sessions | a process that reads the token from the engine's plugin options (same user) — it could only *ask* for decisions, not approve |
| Approvals only via the `sage` CLI; `sage` is denylisted for agents; `SAGE_AGENT_CONTEXT=1` in all agent/gate envs makes approval commands refuse; the journal DB is outside every worktree | oversight | asset 5, separation of duties | a same-user process outside SAGE's control |
| Append-only `events` table (triggers reject UPDATE/DELETE); traces redact secrets; content capture off by default | core, trace | accidental mutation and secret leakage into logs | a same-user process deleting the SQLite file |
| Budgets per task and per run (USD and tokens), checked after every model call with immediate interrupt | orchestrator, engine-opencode | asset 6 (overrun bounded by one model call) | provider-side billing differences; subscriptions that report $0 (token caps still apply) |
| Git hooks: SAGE commits with `--no-verify`; `.git/` is write-protected by policy | workspace, policy | hooks planted by the agent | hooks already present in the target repo run for *your* own git commands |

## Residual risks (honest list)

1. **Indirect execution.** If the agent writes a program and runs it with an allowlisted
   interpreter (`bun file.ts`), that program runs with the user's privileges: it can read files
   outside the worktree, read its environment, and open network connections. SAGE's mitigations
   are: scrubbed environment (no secrets unless you used `passEnv`), the verifier's tamper check,
   the human merge gate, and the full trace for review. Kernel-level isolation (containers,
   bubblewrap/seccomp, AppContainer) is future work behind the same adapter.
2. **Network.** "Network off" is enforced at the tool/command level only. There is no firewall.
3. **Same-user processes.** Anything running as the same OS user can read `.sage/` and OpenCode's
   data directory.
4. **Shell parsing.** The command analyser is conservative (unknown ⇒ ask, opaque ⇒ deny) but is
   not a complete shell parser; exotic syntax may be classified as an unknown command (ask) rather
   than understood.
5. **Model-side prompt injection is not prevented**, only contained: SAGE assumes the model can be
   manipulated and constrains what any model output can do.
6. **`isolateState: false`** shares OpenCode's credential store and session DB with the engine
   process; use it only with providers you are comfortable exposing to agent-run code.

## Provider terms

SAGE never handles provider credentials itself. Keys come from environment variables or from
OpenCode's own auth store (`opencode auth login`). Anthropic models are used only with an API key,
never with Claude Pro/Max subscription OAuth. ChatGPT and Copilot are used only through OpenCode's
official sign-in flows.
