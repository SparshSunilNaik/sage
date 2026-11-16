# ADR 0003 — Tooling on the Windows development machine

- Status: accepted
- Date: 2026-11-16

## Context

Development happens on Windows 11 with Git Bash. Constraints: no Docker/WSL/VMs, < 15 GB disk.

## Decisions

1. **Bun** was not installed. It was installed with `npm i -g bun` (1.4.4, matching the fork's
   `packageManager`). The Bun install cache is project-local (`bunfig.toml` → `./.cache/bun-install`).
2. **Biome via WASM.** Windows Application Control ("Smart App Control") blocks the unsigned native
   `biome.exe` from `@biomejs/biome`. Changing that security setting is out of bounds, so
   `scripts/lint.ts` runs the same rules through Biome's official WASM build (`@biomejs/js-api` +
   `@biomejs/wasm-nodejs`, same version 2.6.8) with the repo's `biome.json`. `bun run lint` /
   `bun run lint:fix` work on every platform; CI uses the same script.
3. **All project scripts are TypeScript run by Bun** (`scripts/*.ts`), processes are spawned with
   argument arrays (`shell: false`), and paths go through `node:path`.
4. **Process-tree kill:** `taskkill /PID <pid> /T /F` on Windows; process groups (`detached` +
   `kill(-pid)`) on POSIX (`packages/workspace/src/proc.ts`).
5. **Line endings:** `.gitattributes` normalises to LF; `core.longpaths=true` is set repo-locally
   (and in every SAGE worktree).
6. **OpenCode binary:** the released `@opencode/cli@2.3.0` (same version as the fork) is installed
   project-locally under `.cache/opencode-2.3.0/` for probing; it runs on this machine (it is
   signed). Building the fork from source was not needed (ADR 0001 §5).
7. **`.bin` shims:** Bun creates `node_modules/.bin/*.exe` shims on Windows, which Application Control
   also blocks, so `bun run typecheck` runs `bun node_modules/typescript/bin/tsc` directly.
8. **Test timeouts:** `bunfig.toml`'s `[test] timeout` is not honoured by Bun 1.4.4 on this
   machine, so long-running test files call `setDefaultTimeout()`.
