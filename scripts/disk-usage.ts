/**
 * Disk accounting for the SAGE checkout (budget: < 15 GB total, target < 8 GB, alert at 12 GB).
 * Usage: bun run scripts/disk-usage.ts [--json]
 */
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirSize, formatBytes } from "../packages/workspace/src/index.ts";

const root = join(import.meta.dir, "..");
const ALERT = 12 * 1024 ** 3;
const parts: Record<string, string> = {
  "engine/opencode (fork working tree)": join(root, "engine"),
  ".git (incl. fork partial clone)": join(root, ".git"),
  node_modules: join(root, "node_modules"),
  ".cache (bun install cache)": join(root, ".cache"),
  ".sage (SAGE's own state, if used on itself)": join(root, ".sage"),
  packages: join(root, "packages"),
  evals: join(root, "evals"),
  docs: join(root, "docs"),
};
const rows = Object.entries(parts).map(([k, p]) => [k, dirSize(p)] as const);
const total = dirSize(root);
// Leftover test fixtures in the system temp dir (should be ~0 after test runs).
const tmp = tmpdir();
const leftovers = existsSync(tmp)
  ? readdirSync(tmp)
      .filter((n) => n.startsWith("sage-"))
      .reduce((s, n) => s + dirSize(join(tmp, n)), 0)
  : 0;

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ total, tempLeftovers: leftovers, parts: Object.fromEntries(rows) }));
} else {
  for (const [k, v] of rows) console.log(`${formatBytes(v).padStart(10)}  ${k}`);
  console.log(`${formatBytes(total).padStart(10)}  TOTAL (SAGE checkout)`);
  console.log(`${formatBytes(leftovers).padStart(10)}  temp fixture leftovers (${tmp}/sage-*)`);
  console.log(
    total + leftovers > ALERT
      ? "ALERT: above the 12 GB threshold — stop and clean up"
      : "within budget (< 12 GB alert threshold)",
  );
}
process.exit(total + leftovers > ALERT ? 2 : 0);
