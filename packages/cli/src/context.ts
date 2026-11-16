import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Journal, loadConfig, type SageConfig } from "@sage/core";
import { dbPath } from "@sage/orchestrator";
import { repoRoot } from "@sage/workspace";

export interface Ctx {
  repo: string;
  config: SageConfig;
  journal: Journal;
}

export async function context(opts: { repo?: string }, needDb = true): Promise<Ctx> {
  const repo = await repoRoot(resolve(opts.repo ?? process.cwd()));
  const config = loadConfig(repo);
  if (needDb && !existsSync(dbPath(repo))) {
    // Opening creates it; that is fine for every command (status on a fresh repo shows no runs).
  }
  return { repo, config, journal: Journal.open(dbPath(repo)) };
}

export const out = (s = ""): void => {
  process.stdout.write(`${s}\n`);
};
export const err = (s: string): void => {
  process.stderr.write(`${s}\n`);
};

export function money(n: number): string {
  return `$${n.toFixed(4)}`;
}
