# SAGE — Progress Log

This file is updated in the same commits as the work it describes, so the git history alone is
enough to resume after an interruption.

## Status

- [x] Repo initialised, OpenCode fork added as a partial-clone submodule at `engine/opencode` (fork version 2.3.0)
- [x] Bun workspace monorepo scaffolded (`packages/*`, `evals`)
- [ ] ADR 0001 engine integration
- [ ] Core journal + state machines

## Environment notes

- Git identity used for all commits: the machine's configured `user.name` / `user.email` (never overridden).
- Bun 1.4.4 installed via `npm i -g bun` (it was missing). Bun package cache: `./.cache/bun-install` (bunfig.toml).
