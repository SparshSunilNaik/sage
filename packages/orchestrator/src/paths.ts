import { join } from "node:path";

/** All SAGE state for a target repo lives under `<repo>/.sage/` (excluded from git via info/exclude). */
export const sageDir = (repo: string) => join(repo, ".sage");
export const dbPath = (repo: string) => join(sageDir(repo), "sage.db");
export const runDir = (repo: string, runId: string) => join(sageDir(repo), "runs", runId);
export const tracePath = (repo: string, runId: string) => join(runDir(repo, runId), "trace.jsonl");
export const worktreeRoot = (repo: string, runId: string) => join(sageDir(repo), "wt", runId);
export const taskWorktree = (repo: string, runId: string, taskId: string) =>
  join(worktreeRoot(repo, runId), taskId);
export const integrationWorktree = (repo: string, runId: string) =>
  join(worktreeRoot(repo, runId), "_integration");
export const engineStateDir = (repo: string, runId: string, key: string) =>
  join(sageDir(repo), "engine", runId, key);

export const runBranch = (runId: string) => `sage/${runId}/run`;
export const taskBranch = (runId: string, taskId: string) => `sage/${runId}/task-${taskId}`;
