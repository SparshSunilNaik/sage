/**
 * Create a throwaway demo repo wired to the deterministic fake engine (no LLM, no cost).
 * Usage: bun run demo   ->  prints the commands to try next.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { calcScenario, makeRepo, writeScenario } from "../packages/testkit/src/index.ts";
import { runProcess } from "../packages/workspace/src/index.ts";

const root = join(import.meta.dir, "..");
const target = join(root, ".cache", "demo-repo");
if (existsSync(target)) rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
const tmp = await makeRepo();
// move the generated repo to a stable path
const { renameSync, mkdirSync } = await import("node:fs");
mkdirSync(join(root, ".cache"), { recursive: true });
renameSync(tmp, target);
const scenario = join(root, ".cache", "demo-scenario.json");
writeScenario(scenario, calcScenario());
const init = await runProcess([process.execPath, join(root, "packages", "cli", "src", "bin.ts"), "-C", target, "init", "--fake", scenario], {
  cwd: target,
});
process.stdout.write(init.stdout);
console.log(`
Demo repo ready: ${target}
Try (from the SAGE checkout):
  bun run sage -C "${target}" run "add multiply and subtract to src/math.ts" --yes
  bun run sage -C "${target}" status latest
  bun run sage -C "${target}" trace latest
  bun run sage -C "${target}" diff latest --stat
  bun run sage -C "${target}" approve latest
  bun run sage -C "${target}" merge latest
`);
