import type { Journal } from "@sage/core";
import { currentBranch, git, headSha, isAncestor, isClean } from "@sage/workspace";

/**
 * Human oversight actions. These are only reachable from the `sage` CLI (never from the guard
 * endpoint), and refuse to run inside an agent session (SAGE_AGENT_CONTEXT is set in every
 * environment SAGE hands to an engine or gate). The `sage` command itself is also on the policy
 * denylist. Together: an agent can never approve or merge its own work.
 */
export class OversightError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "OversightError";
  }
}

export function assertHuman(env: NodeJS.ProcessEnv = process.env): void {
  if (env.SAGE_AGENT_CONTEXT === "1") {
    throw new OversightError("approvals and merges cannot be issued from inside an agent session");
  }
}

export function approve(
  j: Journal,
  runId: string,
  opts: { requestId?: string; reason?: string } = {},
): string {
  assertHuman();
  if (opts.requestId) return decideRequest(j, runId, opts.requestId, "approved", opts.reason);
  const run = j.mustRun(runId);
  if (run.state === "AWAITING_PLAN_APPROVAL") {
    const a = j.approvals(runId).find((x) => x.kind === "plan" && x.status === "pending");
    if (a)
      j.append(runId, null, "human", {
        type: "approval.decided",
        approvalId: a.id,
        decision: "approved",
        reason: opts.reason,
      });
    j.transitionRun(runId, "EXECUTING", "plan approved via `sage approve`", "human");
    return "plan approved; continue with `sage resume`";
  }
  if (run.state === "AWAITING_MERGE_APPROVAL") {
    const a = j.approvals(runId).find((x) => x.kind === "merge" && x.status === "pending");
    if (!a) {
      const done = j.approvals(runId).find((x) => x.kind === "merge" && x.status === "approved");
      if (done) return "merge already approved; run `sage merge`";
      throw new OversightError("no pending merge approval");
    }
    j.append(runId, null, "human", {
      type: "approval.decided",
      approvalId: a.id,
      decision: "approved",
      reason: opts.reason,
    });
    return "merge approved; run `sage merge` to update the target branch";
  }
  throw new OversightError(`nothing to approve: run is ${run.state}`);
}

export function reject(
  j: Journal,
  runId: string,
  opts: { requestId?: string; reason?: string } = {},
): string {
  assertHuman();
  if (opts.requestId) return decideRequest(j, runId, opts.requestId, "rejected", opts.reason);
  const run = j.mustRun(runId);
  const pending = j.approvals(runId).filter((a) => a.status === "pending");
  for (const a of pending) {
    j.append(runId, null, "human", {
      type: "approval.decided",
      approvalId: a.id,
      decision: "rejected",
      reason: opts.reason,
    });
  }
  if (run.state === "MERGED" || run.state === "ABORTED")
    throw new OversightError(`run is already ${run.state}`);
  j.transitionRun(runId, "ABORTED", `rejected by human${opts.reason ? `: ${opts.reason}` : ""}`, "human");
  return "run rejected (ABORTED); the target branch was not touched";
}

function decideRequest(
  j: Journal,
  runId: string,
  id: string,
  decision: "approved" | "rejected",
  reason?: string,
): string {
  const a = j.getApproval(id);
  if (!a || a.runId !== runId) throw new OversightError(`no approval request ${id} in run ${runId}`);
  if (a.status !== "pending") throw new OversightError(`request ${id} is already ${a.status}`);
  j.append(runId, a.taskId, "human", { type: "approval.decided", approvalId: id, decision, reason });
  return `request ${id} ${decision}`;
}

export function abort(j: Journal, runId: string, reason = "aborted by human"): string {
  assertHuman();
  const run = j.mustRun(runId);
  if (run.state === "MERGED" || run.state === "ABORTED")
    throw new OversightError(`run is already ${run.state}`);
  // Close every open question first, so no approver keeps waiting on a dead run.
  for (const a of j.approvals(runId).filter((x) => x.status === "pending")) {
    j.append(runId, a.taskId, "human", {
      type: "approval.decided",
      approvalId: a.id,
      decision: "rejected",
      reason,
    });
  }
  j.transitionRun(runId, "ABORTED", reason, "human");
  return "run aborted; run `sage gc` to remove its worktrees";
}

/** Human-initiated retry of escalated tasks of a FAILED run (separation of duties: never automatic). */
export function retryEscalated(j: Journal, runId: string): string[] {
  assertHuman();
  const run = j.mustRun(runId);
  if (run.state !== "FAILED") throw new OversightError(`run is ${run.state}, not FAILED`);
  const esc = j.getTasks(runId).filter((t) => t.state === "ESCALATED");
  if (!esc.length) throw new OversightError("no escalated tasks to retry");
  for (const t of esc) {
    j.append(runId, t.id, "human", {
      type: "task.attempt",
      attempt: t.attempt + 1,
      feedback: `A human asked for another attempt. Previous failure: ${t.reason ?? ""}`.slice(0, 4000),
    });
    j.transitionTask(runId, t.id, "RETRYING", { reason: "human retry", actor: "human" });
  }
  j.transitionRun(runId, "EXECUTING", "human retry of escalated tasks", "human");
  return esc.map((t) => t.id);
}

/**
 * Fast-forward the user's target branch to the run branch. Requires a human-approved merge approval.
 * Journaled before the side effect, idempotent on re-run.
 */
export async function merge(j: Journal, repo: string, runId: string): Promise<string> {
  assertHuman();
  const run = j.mustRun(runId);
  if (run.state === "MERGED") return `already merged at ${run.mergedSha}`;
  if (run.state !== "AWAITING_MERGE_APPROVAL")
    throw new OversightError(`run is ${run.state}; nothing to merge`);
  const approval = j.approvals(runId).find((a) => a.kind === "merge" && a.status === "approved");
  if (approval?.actor !== "human")
    throw new OversightError("merge has not been approved by a human (`sage approve` first)");

  const res = await j.step(runId, null, "final-merge", async () => {
    const runHead = await headSha(repo, run.runBranch);
    const targetSha = await headSha(repo, run.targetBranch);
    if (targetSha === runHead) return { sha: runHead };
    if (!(await isAncestor(repo, targetSha, runHead))) {
      throw new OversightError(
        `${run.targetBranch} moved since the run started and cannot be fast-forwarded; ` +
          `merge ${run.runBranch} manually or start a new run`,
      );
    }
    if ((await currentBranch(repo)) === run.targetBranch) {
      if (!(await isClean(repo))) throw new OversightError(`working tree of ${repo} has uncommitted changes`);
      await git(repo, ["merge", "--ff-only", "-q", run.runBranch]);
    } else {
      await git(repo, ["update-ref", `refs/heads/${run.targetBranch}`, runHead, targetSha]);
    }
    return { sha: runHead };
  });
  j.append(runId, null, "human", { type: "run.merged", sha: res.sha, targetBranch: run.targetBranch });
  j.transitionRun(runId, "MERGED", `fast-forwarded ${run.targetBranch} to ${res.sha.slice(0, 12)}`, "human");
  return `merged: ${run.targetBranch} -> ${res.sha.slice(0, 12)}`;
}
