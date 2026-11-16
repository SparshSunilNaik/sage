import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "@sage/workspace";

export type FileMap = Record<string, string>;

/** A tiny TypeScript repo with a failing-until-implemented function. */
export const CALC_REPO: FileMap = {
  "package.json": JSON.stringify({ name: "calc-fixture", private: true, type: "module" }, null, 2),
  "src/math.ts": `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
  "tests/math.test.ts": `import { expect, test } from "bun:test";\nimport { add } from "../src/math.ts";\n\ntest("add", () => {\n  expect(add(2, 3)).toBe(5);\n});\n`,
  "README.md": "# calc fixture\n",
};

export function tempDir(prefix = "sage-"): string {
  const base = process.env.SAGE_TEST_TMP ?? tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

export function writeFiles(root: string, files: FileMap): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, ...rel.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

/** Create a git repo with one commit on `main`. Uses the machine's configured git identity. */
export async function makeRepo(files: FileMap = CALC_REPO, extra: FileMap = {}): Promise<string> {
  const dir = tempDir("sage-repo-");
  writeFiles(dir, { ...files, ...extra });
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "core.autocrlf", "false"]);
  await git(dir, ["config", "core.longpaths", "true"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "fixture: initial commit"]);
  return dir;
}

export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* best effort on Windows (file locks) */
  }
}
