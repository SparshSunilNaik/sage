/**
 * OpenCode plugin entry directory. OpenCode loads a plugin *directory*; when that directory has a
 * package.json with `name` + `exports` it resolves the package by name (a self-reference that fails
 * for an unpublished workspace package), so SAGE points OpenCode at this directory instead, which has
 * no package.json and is resolved by its conventional `index.ts` (engine/opencode/packages/plugin/src/host.ts).
 */
export { default } from "../src/plugin.ts";
