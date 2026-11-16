# ADR 0001 — Engine integration with OpenCode 2.3.0

- Status: accepted
- Date: 2026-11-16

## Context

SAGE is a control plane above OpenCode. The fork at `engine/opencode` (branch `dev`, root
`package.json` version **2.3.0**) is the **V2 rewrite**: packages are published under the
`@opencode/*` npm scope, routes live under `/api/*`, and the plugin API is incompatible with 1.x.
The `@opencode-ai/sdk` / `@opencode-ai/plugin` packages on npm (latest 1.19.5) are the **1.x**
line and must not be used. All facts below were read from the fork's source (paths relative to
`engine/opencode/packages/`), not from blog posts.

## Facts established from source

### Server process
- `opencode serve [--hostname H] [--port N] [--stdio]` (`cli/src/commands/commands.ts:579-591`,
  handler `cli/src/commands/handlers/serve.ts`). Without `--service` the process does **not** join
  the shared background service (`cli/src/server-process.ts:69-78,146-160`) — each SAGE task gets
  an isolated process.
- Hostname defaults to `127.0.0.1`. Without `--port` it scans upward from 4096.
- Prints `server listening on <url>`; with `--stdio` prints JSON `{"url": "..."}` and exits when
  stdin closes (`server-process.ts:207-245`). SAGE uses `--stdio`: the server dies with SAGE.
- Auth: password from `OPENCODE_PASSWORD` (legacy `OPENCODE_SERVER_PASSWORD`), else random.
  HTTP Basic, username `opencode` (`server/src/auth.ts:20`). In `--stdio` mode both variables are
  deleted from `process.env` so tools do not inherit them (`server-process.ts:87-90`).
- Project directory is per request: `location[directory]` query, `x-opencode-directory` header, or
  `process.cwd()` (`server/src/location.ts:74-81`). `POST /api/session` accepts `location`.
- Relevant env: `OPENCODE_CONFIG_CONTENT` (inline config JSON), `OPENCODE_CONFIG_DIR`,
  `OPENCODE_DISABLE_PROJECT_CONFIG` (so repo-supplied `.opencode/` config is not trusted),
  `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DB` (per-process DB file; use one per task),
  `OPENCODE_DISABLE_MODELS_FETCH`, `XDG_*_HOME`.

### HTTP routes
| Purpose | Route |
|---|---|
| Health | `GET /api/info` (503 while starting) |
| Create session | `POST /api/session` `{title?, agent?, model?:{providerID,id}, location?:{directory}, permissions?}` → `{data: Session}` |
| Prompt (async admission) | `POST /api/session/:id/prompt` `{text, ...}` |
| Wait until idle | `POST /api/experimental/session/:id/wait` → 204 |
| Messages | `GET /api/session/:id/message?order=asc` → `{data[], cursor}` |
| Abort | `POST /api/session/:id/interrupt` |
| Session info | `GET /api/session/:id` (includes `cost`, `tokens`) |
| Permission reply | `POST /api/session/:id/permission/:requestID/reply` `{decision:"once"|"always"|"reject"}` |
| SSE | `GET /api/event?types=...` (`data: <json>` frames, `{id, created, type, data}` envelope) |

Assistant messages carry `cost` (USD) and `tokens:{input, output, reasoning, cache:{read,write}}`
plus `model` (`schema/src/session-message.ts:221-248`). Tool calls stream as
`session.tool.called / success / failed`; turns end with `session.execution.succeeded|failed`.

### SDK
- `@opencode/client` (HTTP client; `OpenCode.make({ baseUrl, headers })`). Its README calls it a
  "private generation target" although it is published. `@opencode/sdk` is an *in-process host*,
  not an HTTP client.

### Plugin API (`@opencode/plugin` 2.3.0)
- Default export `{ id, setup(ctx) }` (`Plugin.define`) — V1 named-export hook objects are rejected
  (`core/src/plugin/module.ts:81-94`).
- `ctx.tool.hook("execute.before", e)` — `e = {tool, sessionID, agent, messageID, id, input}`;
  **throwing denies** the call (error message goes back to the model).
- `ctx.tool.hook("execute.after", e)` — observes result; cannot reject.
- `ctx.permission.hook("evaluate", e)` — set `e.effect = "allow"|"deny"|"ask"`; must not throw;
  a configured `deny` rule short-circuits before the hook runs (`core/src/permission.ts:188`).
- Loading: config `plugins: ["file:///abs/dir"]`; a local path must be a **directory** whose entry
  is `index.ts`/`server.ts` (`core/src/config/plugin/source.ts:139-160`). `options` reach `ctx.options`.

### Built-in tools (name: args)
`shell: command, workdir?` · `read: path` · `write: path, content` · `edit: path, oldString,
newString` · `patch: patchText` · `glob: pattern, path?` · `grep: pattern, path?` ·
`webfetch: url` · `websearch: query` · `subagent: ...`. (Legacy names `bash`, `apply_patch`
are mapped to `shell`/`edit` in config.)

## Decision

1. **All OpenCode coupling lives in `packages/engine-opencode`** behind the `EngineAdapter`
   interface defined in `@sage/core`. Nothing else imports OpenCode code.
2. **One `opencode serve --stdio --hostname 127.0.0.1` process per task attempt**, cwd = the task
   worktree, env = scrubbed env + `OPENCODE_PASSWORD` (random per process) + `OPENCODE_DB` (per
   task, under `.sage/`) + `OPENCODE_DISABLE_PROJECT_CONFIG=1` + `OPENCODE_CONFIG_CONTENT`
   (plugins = [guard plugin dir], permissions = everything `ask`, no `deny` rules so the hook is
   always reached).
3. **HTTP client:** the adapter talks to the routes above with `fetch` + Zod-validated responses
   instead of importing `@opencode/client`. Reason: the client is marked a private generation
   target, and a thin typed client keeps the adapter testable against a stub server. The route and
   payload names are exactly those in the generated client. (Revisit if `@opencode/client` is
   declared stable.)
4. **Guard plugin** (`packages/guard-plugin`) is a V2 plugin directory (`index.ts`, default export
   `{id, setup}`) that registers `tool.hook("execute.before")` (throws on deny — the hard gate) and
   `permission.hook("evaluate")` (maps SAGE decisions to effects so OpenCode's own permission
   prompts never reach a human directly). It POSTs to the SAGE orchestrator at
   `http://127.0.0.1:<port>/v1/guard` with a per-run bearer token passed via plugin `options`.
   Fail-closed: if SAGE is unreachable, the call is denied.
5. **Running the engine:** the default is the released `opencode` binary of the **same version as
   the fork (2.3.0, npm `@opencode/cli`)**. Running from source (`bun run dev serve` in the fork)
   is supported via `engine.opencode.bin` but requires `bun install` of the fork's ~11k-file
   workspace, which costs disk and time; the fork is kept for reading the API, the plugin types and
   any future patches. The machine currently has `@opencode/cli` 2.0.29 installed globally;
   `sage doctor` reports a version mismatch until 2.3.0 is installed.
6. No fork patches were needed for the MVP; the `sage` branch of the fork is not created.

## Consequences

- Upgrading OpenCode touches one package. V1/V2 churn (research.md §3.3) is contained.
- Known API limitations are listed in `docs/upstream-candidates.md`.
