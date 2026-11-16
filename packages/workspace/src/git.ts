import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runProcess } from "./proc.ts";

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim().slice(0, 500)}`);
    this.name = "GitError";
  }
}

/** Environment for git subprocesses. Identity is NOT overridden: commits use the machine's git config. */
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // Never let a stray identity override leak in: SAGE commits use configured user.name/email only.
    if (/^GIT_(AUTHOR|COMMITTER)_/.test(k)) continue;
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export async function git(cwd: string, args: readonly string[], allowFail = false): Promise<string> {
  const r = await runProcess(["git", ...args], { cwd, env: gitEnv(), timeoutMs: 120_000 });
  if (r.code !== 0 && !allowFail) throw new GitError(args, r.code, r.stderr || r.stdout);
  return r.stdout.trim();
}

export async function gitTry(
  cwd: string,
  args: readonly string[],
): Promise<{ ok: boolean; out: string; err: string }> {
  const r = await runProcess(["git", ...args], { cwd, env: gitEnv(), timeoutMs: 120_000 });
  return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

export async function repoRoot(cwd: string): Promise<string> {
  return resolve(await git(cwd, ["rev-parse", "--show-toplevel"]));
}

export async function headSha(cwd: string, ref = "HEAD"): Promise<string> {
  return git(cwd, ["rev-parse", ref]);
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await gitTry(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
}

export async function isClean(cwd: string): Promise<boolean> {
  return (await git(cwd, ["status", "--porcelain"])) === "";
}

export async function gitIdentity(cwd: string): Promise<{ name: string; email: string }> {
  const name = (await gitTry(cwd, ["config", "user.name"])).out;
  const email = (await gitTry(cwd, ["config", "user.email"])).out;
  return { name, email };
}

/** Make SAGE's state directory invisible to git status in the target repo (repo-local, no config change). */
export function excludeSageDir(repo: string, gitCommonDir: string): void {
  const p = join(gitCommonDir, "info", "exclude");
  mkdirSync(dirname(p), { recursive: true });
  const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (!cur.split(/\r?\n/).includes(".sage/")) writeFileSync(p, `${cur.replace(/\n?$/, "\n")}.sage/\n`);
  void repo;
}

export async function gitCommonDir(cwd: string): Promise<string> {
  return resolve(cwd, await git(cwd, ["rev-parse", "--git-common-dir"]));
}

export interface Trailers {
  run: string;
  task?: string;
  step: string;
}

export function formatMessage(subject: string, body: string | undefined, t: Trailers): string {
  const lines = [`Sage-Run: ${t.run}`];
  if (t.task) lines.push(`Sage-Task: ${t.task}`);
  lines.push(`Sage-Step: ${t.step}`);
  return `${subject}\n\n${body ? `${body}\n\n` : ""}${lines.join("\n")}\n`;
}

/**
 * Stage everything and commit if there are changes. Returns the new HEAD sha (or the existing one
 * if there was nothing to commit). Uses the machine's configured identity; never passes --author.
 */
export async function commitAll(
  cwd: string,
  subject: string,
  body: string | undefined,
  t: Trailers,
): Promise<string> {
  await git(cwd, ["add", "-A"]);
  const dirty = (await git(cwd, ["status", "--porcelain"])) !== "";
  if (dirty) await git(cwd, ["commit", "--no-verify", "-q", "-m", formatMessage(subject, body, t)]);
  return headSha(cwd);
}

export async function changedFiles(cwd: string, base: string, head = "HEAD"): Promise<string[]> {
  const out = await git(cwd, ["diff", "--name-only", "--no-renames", base, head]);
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

/** Uncommitted + untracked changes in a working tree. */
export async function dirtyFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ""));
}

export async function diffText(cwd: string, base: string, head = "HEAD", stat = false): Promise<string> {
  return git(cwd, ["diff", ...(stat ? ["--stat"] : []), base, head]);
}

export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  return (await gitTry(cwd, ["merge-base", "--is-ancestor", a, b])).ok;
}
