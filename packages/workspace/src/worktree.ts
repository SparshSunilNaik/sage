import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, gitTry, headSha } from "./git.ts";

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
}

export async function listWorktrees(repo: string): Promise<WorktreeInfo[]> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  const res: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> = {};
  for (const line of `${out}\n`.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) cur = { path: resolve(line.slice(9)) };
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "" && cur.path) {
      res.push({ path: cur.path, head: cur.head ?? "", branch: cur.branch ?? null });
      cur = {};
    }
  }
  return res;
}

/** Canonical form for comparisons: the real path (expands Windows 8.3 short names like RUNNER~1). */
function canonical(p: string): string {
  let r = resolve(p);
  try {
    if (existsSync(r)) r = realpathSync.native(r);
  } catch {
    /* keep the resolved path */
  }
  return r.replace(/\\/g, "/").replace(/\/$/, "");
}

function samePath(a: string, b: string): boolean {
  const n = canonical;
  return process.platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

/**
 * Idempotently ensure a worktree exists at `path` on `branch` (created from `baseRef` if new).
 * Safe to call again after a crash at any point.
 */
export async function ensureWorktree(
  repo: string,
  path: string,
  branch: string,
  baseRef: string,
): Promise<string> {
  const existing = (await listWorktrees(repo)).find((w) => samePath(w.path, path));
  if (existing && existsSync(path)) {
    if (existing.branch !== branch) await git(path, ["checkout", "-q", "-B", branch, baseRef]);
    return headSha(path);
  }
  await gitTry(repo, ["worktree", "prune"]);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  await git(repo, ["worktree", "add", "-q", "-B", branch, path, baseRef]);
  await git(path, ["config", "--worktree", "core.longpaths", "true"]).catch(() => undefined);
  return headSha(path);
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await gitTry(repo, ["worktree", "remove", "--force", path]);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  await gitTry(repo, ["worktree", "prune"]);
}

/** Restore a worktree to a known commit, discarding partial work (compensation after a crash). */
export async function resetWorktree(path: string, sha: string): Promise<void> {
  await git(path, ["reset", "-q", "--hard", sha]);
  await git(path, ["clean", "-q", "-fd"]);
}

export function dirSize(path: string): number {
  if (!existsSync(path)) return 0;
  // Symlinks/junctions (workspace links in node_modules) are NOT followed: they would double count.
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += lstatSync(p).size;
        } catch {
          /* vanished */
        }
      }
    }
  }
  return total;
}

export function formatBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 2 : 0)} ${u[i]}`;
}
