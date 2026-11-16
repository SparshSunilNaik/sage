# Upstream candidates (OpenCode 2.3.0)

Limitations found while integrating SAGE with the OpenCode V2 server and plugin API. Each is a
possible upstream issue/PR. File/line references are to `engine/opencode/packages/`.

1. **Local plugin directories with a named `package.json` fail silently.**
   `plugin/src/host.ts` resolves a local directory whose `package.json` has `name` + `exports` by
   package *name* (`resolveModule("<name>/server", dir)`), i.e. a self-reference. For an unpublished
   workspace package this resolution fails, `entrypoint` is `undefined`, and the plugin is dropped
   (`core/src/config/plugin/source.ts`) **without a warning or a `failed` state** in `/api/plugin`.
   *Workaround in SAGE:* point OpenCode at `packages/guard-plugin/opencode/` (no package.json).
   *Suggested fix:* fall back to the `exports` path relative to the directory, and surface a
   `failed` plugin state instead of silently skipping.

2. **`GET /api/plugin` is empty until the location is first initialised.** Plugins load lazily;
   a client that checks plugin state right after `/api/info` reports ready sees `[]`.
   *Workaround:* poll until non-empty. *Suggested fix:* document it, or have `/api/plugin` force
   location initialisation (it already takes a `location[directory]` query).

3. **A configured `deny` permission rule short-circuits before `permission.hook("evaluate")`**
   (`core/src/permission.ts:188`). A policy plugin therefore cannot observe or log configured
   denials. *Workaround:* SAGE configures no deny rules (everything `ask`) and enforces denials
   itself in `tool.hook("execute.before")`. *Suggested fix:* run evaluate hooks for every
   evaluation (read-only for deny results), or emit an event.

4. **No first-class "headless deny-by-default" mode.** In headless `serve`, an unanswered
   `permission.asked` blocks the turn forever. SAGE detects any `permission.asked` event and
   rejects it (fail closed). *Suggested fix:* a server flag such as `--permission-timeout` or
   `--no-interactive-permissions` that rejects unanswered asks.

5. **`@opencode/client` is marked a "private generation target"** in its README although it is
   published publicly. SAGE uses a small typed `fetch` client against the same routes instead.
   *Suggested fix:* declare the client's stability level.
