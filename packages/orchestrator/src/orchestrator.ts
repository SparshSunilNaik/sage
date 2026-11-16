import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  type Actor,
  classifyEngineError,
  decideRecovery,
  type EngineAdapter,
  type FailureClass,
  type Journal,
  type ModelCall,
  newId,
  type Plan,
  type RunState,
  randomToken,
  type SageConfig,
  type TaskRow,
  type TaskSpec,
  topoOrder,
} from "@sage/core";
import type { GuardResponse } from "@sage/guard-plugin";
import { planGoal, type RepoContext, taskPrompt } from "@sage/planner";
import { evaluate, policyContext } from "@sage/policy";
import { JsonlExporter, type SpanExporter, Tracer } from "@sage/trace";
import { feedbackFrom, verifyTask } from "@sage/verify";
import {
  branchExists,
  changedFiles,
  commitAll,
  currentBranch,
  ensureWorktree,
  excludeSageDir,
  formatMessage,
  git,
  gitCommonDir,
  gitTry,
  headSha,
  isAncestor,
  isProcessAlive,
  resetWorktree,
  scrubEnv,
} from "@sage/workspace";
import { type Asker, DenyAsker } from "./asker.ts";
import { type GuardRequestParsed, GuardServer } from "./guard-server.ts";
import {
  engineStateDir,
  integrationWorktree,
  runBranch,
  taskBranch,
  taskWorktree,
  tracePath,
} from "./paths.ts";

export class LeaseHeldError extends Error {
  constructor(runId: string, holder: string) {
    super(
      `run ${runId} is being driven by another orchestrator (${holder}); wait for it or let its lease expire`,
    );
    this.name = "LeaseHeldError";
  }
}

class BudgetExceeded extends Error {
  constructor(msg: string) {
    super(`budget exhausted: ${msg}`);
    this.name = "BudgetExceeded";
  }
}

export interface OrchestratorOptions {
  repo: string;
  journal: Journal;
  config: SageConfig;
  engine: EngineAdapter;
  asker?: Asker;
  log?: (msg: string) => void;
  /** `--yes`: the human pre-approved the plan on the command line. */
  autoApprovePlan?: boolean;
  /** Interactive plan approval (CLI prompt). Return true to approve. */
  confirmPlan?: (plan: Plan, runId: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  exporter?: SpanExporter;
  leaseTtlMs?: number;
}

const READ_ONLY_TOOLS = new Set(["read", "glob", "grep", "list", "ls", "view", "todowrite", "todoread"]);

/** Deterministic span ids so spans written by a resumed process attach to the same tree nodes. */
const sid = (...parts: (string | number)[]) =>
  createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 16);

/**
 * Test hook for crash/resume testing: when SAGE_CRASH_AT names this point, the process kills itself
 * without any cleanup (equivalent to kill -9 / TerminateProcess). Never active unless the env var is set.
 */
export function crashPoint(name: string): void {
  const at = process.env.SAGE_CRASH_AT;
  if (!at || at !== name) return;
  const marker = process.env.SAGE_CRASH_MARKER;
  if (marker && existsSync(marker)) return; // crash only once per marker
  if (marker) Bun.write(marker, name);
  process.kill(process.pid, "SIGKILL");
}

export class Orchestrator {
  private readonly j: Journal;
  private readonly cfg: SageConfig;
  private readonly asker: Asker;
  private readonly log: (m: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private guard: GuardServer | undefined;
  private tracer: Tracer | undefined;
  private mergeChain: Promise<unknown> = Promise.resolve();
  private cancel = new AbortController();

  /** True once a human aborted (or rejected) the run; all work stops at the next checkpoint. */
  private isAborted(runId: string): boolean {
    return this.j.mustRun(runId).state === "ABORTED";
  }
  private readonly owner = `${hostname()}:${process.pid}:${randomToken(6)}`;

  constructor(private readonly o: OrchestratorOptions) {
    this.j = o.journal;
    this.cfg = o.config;
    this.asker = o.asker ?? new DenyAsker();
    this.log = o.log ?? (() => undefined);
    this.sleep = o.sleep ?? ((ms) => Bun.sleep(ms));
  }

  private get repo(): string {
    return this.o.repo;
  }

  /* ================================ run creation ================================ */

  async createRun(goal: string): Promise<string> {
    const runId = newId("run");
    const baseSha = await headSha(this.repo);
    const target = this.cfg.targetBranch ?? (await currentBranch(this.repo));
    if (target === "HEAD")
      throw new Error("detached HEAD: set targetBranch in sage.config.jsonc or check out a branch");
    excludeSageDir(this.repo, await gitCommonDir(this.repo));
    this.j.append(runId, null, "human", {
      type: "run.created",
      goal,
      repo: this.repo,
      targetBranch: target,
      baseSha,
      runBranch: runBranch(runId),
    });
    return runId;
  }

  /* ================================ main driver ================================= */

  /**
   * Drive a run forward from whatever state the journal says it is in, until it finishes or needs a
   * human. Safe to call again after a crash (this is what `sage resume` does).
   */
  async drive(runId: string): Promise<RunState> {
    const ttl = this.o.leaseTtlMs ?? 30_000;
    const got = this.j.acquireLease(runId, this.owner, ttl);
    if (!got.ok) {
      const pid = Number(got.holder.split(":")[1]);
      const sameHost = got.holder.split(":")[0] === hostname();
      if (!(sameHost && Number.isFinite(pid) && !isProcessAlive(pid)))
        throw new LeaseHeldError(runId, got.holder);
      this.log(`previous orchestrator ${got.holder} is dead; taking over its lease`);
      this.j.acquireLease(runId, this.owner, ttl, got.expiresAt + 1);
    }
    const hb = setInterval(() => this.j.renewLease(runId, this.owner, ttl), Math.max(1000, ttl / 3));
    // A human may abort from another terminal (`sage abort`): notice it quickly and interrupt
    // in-flight engine turns instead of finishing work that will be thrown away.
    this.cancel = new AbortController();
    const watch = setInterval(() => {
      if (this.isAborted(runId)) this.cancel.abort();
    }, 500);
    this.tracer = new Tracer(
      runId,
      this.o.exporter ?? new JsonlExporter(tracePath(this.repo, runId)),
      this.cfg.trace.captureContent,
    );
    this.guard = new GuardServer(runId, (r) => this.onGuard(r)).start();
    try {
      for (;;) {
        const run = this.j.mustRun(runId);
        switch (run.state) {
          case "CREATED":
            this.j.transitionRun(runId, "PLANNING");
            break;
          case "PLANNING":
            await this.plan(runId);
            break;
          case "AWAITING_PLAN_APPROVAL": {
            const decided = await this.planApproval(runId);
            if (!decided) return "AWAITING_PLAN_APPROVAL";
            break;
          }
          case "EXECUTING":
            await this.execute(runId);
            break;
          default:
            return run.state;
        }
      }
    } finally {
      clearInterval(hb);
      clearInterval(watch);
      this.guard.stop();
      const run = this.j.mustRun(runId);
      this.tracer
        .start(
          "sage.run",
          {
            "sage.run.id": runId,
            "sage.goal": run.goal,
            "sage.run.state": run.state,
            "sage.cost_usd": run.costUsd,
            "gen_ai.usage.input_tokens": run.inputTokens,
            "gen_ai.usage.output_tokens": run.outputTokens,
          },
          "",
          this.tracer.rootSpanId,
        )
        .end(run.state === "FAILED" ? "error" : "ok");
      this.j.releaseLease(runId, this.owner);
    }
  }

  /* ================================== planning ================================== */

  private async setupRun(runId: string): Promise<void> {
    const run = this.j.mustRun(runId);
    await this.j.step(runId, null, "setup", async () => {
      if (!(await branchExists(this.repo, run.runBranch))) {
        await git(this.repo, ["branch", run.runBranch, run.baseSha]);
      }
      await ensureWorktree(this.repo, integrationWorktree(this.repo, runId), run.runBranch, run.runBranch);
      return { runBranch: run.runBranch };
    });
    // The integration worktree may have been removed (gc) while the journal says setup is done.
    if (!existsSync(integrationWorktree(this.repo, runId))) {
      await ensureWorktree(this.repo, integrationWorktree(this.repo, runId), run.runBranch, run.runBranch);
    }
  }

  private async repoContext(cwd: string): Promise<RepoContext> {
    const files = (await gitTry(cwd, ["ls-files"])).out.split(/\r?\n/).filter(Boolean);
    const agents = join(cwd, "AGENTS.md");
    let scripts: Record<string, string> | undefined;
    try {
      scripts = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts;
    } catch {
      scripts = undefined;
    }
    return {
      files,
      agentsMd: existsSync(agents) ? readFileSync(agents, "utf8") : undefined,
      packageScripts: scripts,
    };
  }

  private async plan(runId: string): Promise<void> {
    await this.setupRun(runId);
    const run = this.j.mustRun(runId);
    const integ = integrationWorktree(this.repo, runId);
    const span = this.tracer!.start("sage.plan", {}, undefined, sid(runId, "plan"));
    const outcome = await this.j.step(runId, null, "plan", async () => {
      const session = await this.o.engine.start({
        runId,
        taskId: "planner",
        role: "planner",
        cwd: integ,
        env: this.engineEnv(),
        guard: { url: this.guard!.url, token: this.guard!.token },
        model: this.cfg.engine.plannerModel ?? this.cfg.engine.model,
        stateDir: engineStateDir(this.repo, runId, "planner"),
        attempt: 1,
      });
      try {
        return await planGoal({
          session,
          goal: run.goal,
          context: await this.repoContext(integ),
          gateNames: this.cfg.gates.map((g) => g.name),
          maxAttempts: this.cfg.retry.maxPlanAttempts,
          onInvalid: (attempt, errors) => {
            this.j.append(runId, null, "sage", { type: "plan.invalid", attempt, errors });
            this.log(`plan attempt ${attempt} rejected: ${errors.slice(0, 3).join("; ")}`);
          },
          onModelCall: (c) => this.onModelCall(runId, null, "planner", c, span.spanId),
        });
      } catch (e) {
        return { ok: false as const, errors: [(e as Error).message], attempts: 0 };
      } finally {
        await session.close();
      }
    });
    span.set("sage.plan.attempt", outcome.attempts);
    if (this.isAborted(runId)) {
      span.end("error");
      return;
    }
    if (!outcome.ok) {
      span.set("sage.plan.errors", outcome.errors).end("error");
      this.j.transitionRun(runId, "FAILED", `planning failed: ${outcome.errors.slice(0, 3).join("; ")}`);
      return;
    }
    span.set("sage.plan.tasks", outcome.plan.tasks.length).end();
    this.acceptPlan(runId, outcome.plan);
    crashPoint("after-plan");
    this.j.transitionRun(runId, "AWAITING_PLAN_APPROVAL");
  }

  /** Idempotent: safe to repeat after a crash in the middle. */
  private acceptPlan(runId: string, plan: Plan): void {
    if (!this.j.mustRun(runId).planJson) this.j.append(runId, null, "sage", { type: "plan.accepted", plan });
    const order = topoOrder(plan.tasks);
    order.forEach((id, ord) => {
      if (this.j.getTask(runId, id)) return;
      const spec = plan.tasks.find((t) => t.id === id)!;
      this.j.append(runId, id, "sage", { type: "task.created", ord, spec });
    });
    if (!this.j.approvals(runId).some((a) => a.kind === "plan")) {
      this.j.append(runId, null, "sage", {
        type: "approval.requested",
        approvalId: newId("apr"),
        kind: "plan",
        request: `approve plan with ${plan.tasks.length} task(s)`,
      });
    }
  }

  private async planApproval(runId: string): Promise<boolean> {
    const pending = this.j.approvals(runId).find((a) => a.kind === "plan" && a.status === "pending");
    const plan = JSON.parse(this.j.mustRun(runId).planJson ?? "null") as Plan;
    let approved: boolean | undefined;
    let reason = "";
    if (this.o.autoApprovePlan) {
      approved = true;
      reason = "pre-approved with --yes";
    } else if (this.o.confirmPlan) {
      approved = await this.o.confirmPlan(plan, runId);
      reason = "interactive";
    }
    if (approved === undefined) return false;
    if (pending) {
      this.j.append(runId, null, "human", {
        type: "approval.decided",
        approvalId: pending.id,
        decision: approved ? "approved" : "rejected",
        reason,
      });
    }
    this.tracer!.event("sage.approval", {
      "sage.approval.kind": "plan",
      "sage.approval.decision": approved ? "approved" : "rejected",
      "sage.approval.actor": "human",
    });
    this.j.transitionRun(
      runId,
      approved ? "EXECUTING" : "ABORTED",
      `plan ${approved ? "approved" : "rejected"} (${reason})`,
      "human",
    );
    return true;
  }

  /* ================================== execution ================================= */

  private async execute(runId: string): Promise<void> {
    await this.setupRun(runId);
    const limit = this.cfg.concurrency;
    const active = new Map<string, Promise<void>>();
    for (;;) {
      const tasks = this.j.getTasks(runId);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      for (const t of tasks) {
        if (t.state !== "PENDING") continue;
        const deps = this.j.taskSpec(t).dependsOn;
        if (deps.every((d) => byId.get(d)?.state === "PASSED")) this.j.transitionTask(runId, t.id, "READY");
      }
      const runnable = this.j
        .getTasks(runId)
        .filter((t) => ["READY", "RUNNING", "VERIFYING", "RETRYING"].includes(t.state) && !active.has(t.id));
      for (const t of runnable) {
        if (active.size >= limit || this.isAborted(runId)) break;
        const p = this.runTask(runId, t.id)
          .catch((e) => this.log(`task ${t.id} crashed in orchestrator: ${(e as Error).stack ?? e}`))
          .finally(() => active.delete(t.id));
        active.set(t.id, p);
      }
      if (active.size === 0) break;
      await Promise.race(active.values());
    }

    if (this.isAborted(runId)) return; // a human aborted: leave everything as journaled
    const tasks = this.j.getTasks(runId);
    if (tasks.every((t) => t.state === "PASSED")) {
      if (!this.j.approvals(runId).some((a) => a.kind === "merge")) {
        this.j.append(runId, null, "sage", {
          type: "approval.requested",
          approvalId: newId("apr"),
          kind: "merge",
          request: `merge ${this.j.mustRun(runId).runBranch} into ${this.j.mustRun(runId).targetBranch}`,
        });
      }
      crashPoint("before-merge-approval");
      this.j.transitionRun(runId, "AWAITING_MERGE_APPROVAL", "all tasks passed verification");
    } else {
      const bad = tasks.filter((t) => t.state !== "PASSED").map((t) => `${t.id}=${t.state}`);
      this.j.transitionRun(runId, "FAILED", `tasks not passed: ${bad.join(", ")}`);
    }
  }

  private failureHistory(runId: string, taskId: string) {
    let nonTransient = 0;
    let transient = 0;
    let policy = 0;
    for (const e of this.j.events(runId)) {
      if (e.taskId !== taskId || e.payload.type !== "task.state" || !e.payload.failureClass) continue;
      if (e.actor === "human") continue;
      if (e.payload.failureClass === "provider_transient") transient++;
      else nonTransient++;
      if (e.payload.failureClass === "policy_denied") policy++;
    }
    return { nonTransient, transient, policy };
  }

  private async runTask(runId: string, taskId: string): Promise<void> {
    const taskSpan = sid(runId, "task", taskId);
    try {
      for (;;) {
        if (this.isAborted(runId)) return;
        const t = this.j.mustTask(runId, taskId);
        switch (t.state) {
          case "READY":
            this.j.append(runId, taskId, "sage", { type: "task.attempt", attempt: t.attempt + 1 });
            this.j.transitionTask(runId, taskId, "RUNNING");
            break;
          case "RETRYING":
            this.j.transitionTask(runId, taskId, "RUNNING");
            break;
          case "RUNNING": {
            const r = await this.attempt(runId, t, taskSpan);
            if (r.ok) this.j.transitionTask(runId, taskId, "VERIFYING");
            else await this.fail(runId, taskId, r.cls, r.reason, r.feedback);
            break;
          }
          case "VERIFYING": {
            const r = await this.verifyAndMerge(runId, t, taskSpan);
            if (r.ok)
              this.j.transitionTask(runId, taskId, "PASSED", {
                reason: "gates green, merged into run branch",
              });
            else await this.fail(runId, taskId, r.cls, r.reason, r.feedback);
            break;
          }
          default:
            return;
        }
      }
    } finally {
      const t = this.j.mustTask(runId, taskId);
      this.tracer!.start(
        "sage.task",
        {
          "sage.task.id": taskId,
          "sage.task.title": t.title,
          "sage.task.state": t.state,
          "sage.task.attempts": t.attempt,
          "sage.cost_usd": t.costUsd,
          ...(t.failureClass ? { "sage.failure.class": t.failureClass } : {}),
        },
        undefined,
        taskSpan,
      ).end(t.state === "PASSED" ? "ok" : t.state === "FAILED" || t.state === "ESCALATED" ? "error" : "ok");
    }
  }

  private async fail(runId: string, taskId: string, cls: FailureClass, reason: string, feedback?: string) {
    const h = this.failureHistory(runId, taskId);
    const action = decideRecovery(
      cls,
      {
        attempt: h.nonTransient + (cls === "provider_transient" ? 0 : 1),
        transientRetries: h.transient,
        policyRetries: h.policy,
      },
      this.cfg.retry,
    );
    this.tracer!.event(
      "sage.recovery",
      { "sage.failure.class": cls, "sage.recovery.action": action.kind, "sage.reason": reason.slice(0, 500) },
      sid(runId, "task", taskId),
    );
    this.log(`task ${taskId}: ${cls} (${reason.slice(0, 200)}) -> ${action.kind}`);
    if (action.kind === "escalate") {
      this.j.transitionTask(runId, taskId, "ESCALATED", {
        failureClass: cls,
        reason: `${action.reason}: ${reason}`.slice(0, 2000),
      });
      return;
    }
    const t = this.j.mustTask(runId, taskId);
    this.j.append(runId, taskId, "sage", {
      type: "task.attempt",
      attempt: t.attempt + 1,
      feedback: action.kind === "retry_with_feedback" ? feedback : undefined,
    });
    this.j.transitionTask(runId, taskId, "RETRYING", { failureClass: cls, reason: reason.slice(0, 2000) });
    if (action.kind === "retry_backoff") await this.sleep(action.delayMs);
  }

  private budgetCheck(runId: string, taskId: string | null): void {
    const run = this.j.mustRun(runId);
    const b = this.cfg.budget;
    if (run.costUsd >= b.run.maxUsd)
      throw new BudgetExceeded(`run cost $${run.costUsd.toFixed(4)} >= $${b.run.maxUsd}`);
    if (run.inputTokens + run.outputTokens >= b.run.maxTokens)
      throw new BudgetExceeded(`run tokens >= ${b.run.maxTokens}`);
    if (taskId) {
      const t = this.j.mustTask(runId, taskId);
      if (t.costUsd >= b.task.maxUsd)
        throw new BudgetExceeded(`task cost $${t.costUsd.toFixed(4)} >= $${b.task.maxUsd}`);
      if (t.inputTokens + t.outputTokens >= b.task.maxTokens)
        throw new BudgetExceeded(`task tokens >= ${b.task.maxTokens}`);
    }
  }

  private onModelCall(
    runId: string,
    taskId: string | null,
    role: "planner" | "executor",
    c: ModelCall,
    parent: string,
  ) {
    this.j.append(runId, taskId, "engine", {
      type: "usage",
      model: c.model,
      role,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      costUsd: c.costUsd,
    });
    this.tracer!.event(
      "chat",
      {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": c.model,
        "gen_ai.usage.input_tokens": c.inputTokens,
        "gen_ai.usage.output_tokens": c.outputTokens,
        "sage.cost_usd": c.costUsd,
      },
      parent,
    );
    this.budgetCheck(runId, taskId); // throws BudgetExceeded -> engine aborts the turn (hard stop)
  }

  private engineEnv(): Record<string, string> {
    return scrubEnv(process.env, { passThrough: this.cfg.engine.opencode.passEnv });
  }

  private gateEnv(): Record<string, string> {
    return scrubEnv(process.env);
  }

  private async attempt(
    runId: string,
    t: TaskRow,
    taskSpan: string,
  ): Promise<{ ok: true } | { ok: false; cls: FailureClass; reason: string; feedback?: string }> {
    const n = t.attempt;
    const spec = this.j.taskSpec(t);
    const wt = taskWorktree(this.repo, runId, t.id);
    const branch = taskBranch(runId, t.id);
    const integ = integrationWorktree(this.repo, runId);

    const ws = await this.j.step(runId, t.id, `workspace:${n}`, async () => {
      const runTip = await headSha(integ);
      await ensureWorktree(this.repo, wt, branch, runTip);
      await resetWorktree(wt, runTip); // every attempt starts from the current run-branch tip
      this.j.append(runId, t.id, "sage", { type: "task.workspace", branch, worktree: wt, baseSha: runTip });
      return { baseSha: runTip };
    });
    crashPoint("after-workspace");

    try {
      this.budgetCheck(runId, t.id);
    } catch (e) {
      return { ok: false, cls: "budget_exhausted", reason: (e as Error).message };
    }

    const agentSpan = sid(runId, "agent", t.id, n);
    const model = this.cfg.engine.model ?? "default";
    const agent = await this.j.step(runId, t.id, `agent:${n}`, async ({ resumed }) => {
      if (resumed) {
        // Compensation: a previous process died mid-turn. Discard its partial, unverified edits.
        await ensureWorktree(this.repo, wt, branch, ws.baseSha);
        await resetWorktree(wt, ws.baseSha);
      }
      const span = this.tracer!.start(
        "invoke_agent",
        {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": "executor",
          "gen_ai.request.model": model,
          "sage.attempt": n,
          "sage.task.id": t.id,
          ...(resumed ? { "sage.resumed": true } : {}),
        },
        taskSpan,
        agentSpan,
      );
      const session = await this.o.engine.start({
        runId,
        taskId: t.id,
        role: "executor",
        cwd: wt,
        env: this.engineEnv(),
        guard: { url: this.guard!.url, token: this.guard!.token },
        model: this.cfg.engine.model,
        stateDir: engineStateDir(this.repo, runId, `${t.id}-${n}`),
        attempt: n,
      });
      let turn: Awaited<ReturnType<typeof session.prompt>>;
      try {
        turn = await session.prompt(
          taskPrompt({
            spec,
            goal: this.j.mustRun(runId).goal,
            planSummary: (JSON.parse(this.j.mustRun(runId).planJson ?? "{}") as Partial<Plan>).summary ?? "",
            dependencies: this.dependencySummaries(runId, spec),
            attempt: n,
            feedback: t.feedback ?? undefined,
            agentsMd: existsSync(join(wt, "AGENTS.md"))
              ? readFileSync(join(wt, "AGENTS.md"), "utf8")
              : undefined,
            gateNames: this.cfg.gates.map((g) => g.name),
          }),
          {
            onModelCall: (c) => this.onModelCall(runId, t.id, "executor", c, agentSpan),
            timeoutMs: this.cfg.engine.opencode.turnTimeoutMs,
            signal: this.cancel.signal,
          },
        );
      } finally {
        await session.close();
      }
      crashPoint("mid-agent");
      const head = await commitAll(
        wt,
        `sage(${t.id}): attempt ${n} — ${spec.title}`,
        turn.text.slice(0, 1500) || undefined,
        {
          run: runId,
          task: t.id,
          step: `agent:${n}`,
        },
      );
      const files = await changedFiles(wt, ws.baseSha, head);
      this.tracer!.event(
        "sage.diff",
        { "sage.diff.sha": head.slice(0, 12), "sage.diff.files": files },
        agentSpan,
      );
      span
        .setMany({ "sage.turn.status": turn.status, "sage.tools": turn.tools.length })
        .end(turn.status === "completed" ? "ok" : "error");
      return { status: turn.status, error: turn.error ?? null, headSha: head, files };
    });
    this.j.append(runId, t.id, "sage", { type: "task.head", headSha: agent.headSha, files: agent.files });
    crashPoint("after-agent");

    if (agent.status === "completed") return { ok: true };
    const msg = agent.error ?? agent.status;
    const cls: FailureClass = /budget exhausted/i.test(msg) ? "budget_exhausted" : classifyEngineError(msg);
    return {
      ok: false,
      cls,
      reason: msg,
      feedback: `The previous attempt ended with an engine error: ${msg}`,
    };
  }

  private dependencySummaries(runId: string, spec: TaskSpec) {
    return spec.dependsOn.map((d) => {
      const dt = this.j.mustTask(runId, d);
      return { id: d, title: dt.title, files: JSON.parse(dt.filesJson ?? "[]") as string[] };
    });
  }

  private async verifyAndMerge(
    runId: string,
    t: TaskRow,
    taskSpan: string,
  ): Promise<{ ok: true } | { ok: false; cls: FailureClass; reason: string; feedback?: string }> {
    const n = t.attempt;
    const spec = this.j.taskSpec(t);
    const wt = taskWorktree(this.repo, runId, t.id);
    const v = await this.j.step(runId, t.id, `verify:${n}`, async () => {
      if (!existsSync(wt))
        await ensureWorktree(this.repo, wt, taskBranch(runId, t.id), t.headSha ?? t.baseSha ?? "HEAD");
      const vspan = this.tracer!.start(
        "sage.verify",
        { "sage.attempt": n },
        taskSpan,
        sid(runId, "verify", t.id, n),
      );
      const res = await verifyTask({
        worktree: wt,
        baseSha: t.baseSha ?? "HEAD",
        gates: this.cfg.gates,
        env: this.gateEnv(),
        protectedPaths: this.cfg.policy.protectedPaths,
        allowedTestFiles: spec.allowedTestFiles,
        trailers: { run: runId, task: t.id },
      });
      for (const g of res.gates) {
        this.j.append(runId, t.id, "sage", {
          type: "gate.result",
          gate: g.gate,
          passed: g.passed,
          exitCode: g.exitCode,
          summary: g.summary,
          durationMs: g.durationMs,
        });
        this.tracer!.event(
          "sage.gate",
          { "sage.gate.name": g.gate, "sage.gate.passed": g.passed, "sage.gate.summary": g.summary },
          vspan.spanId,
          g.passed ? "ok" : "error",
        );
      }
      if (res.violations.length) {
        this.tracer!.event(
          "sage.gate",
          {
            "sage.gate.name": "protected-files",
            "sage.gate.passed": false,
            "sage.gate.summary": `unauthorised edits: ${res.violations.join(", ")}`,
          },
          vspan.spanId,
          "error",
        );
      }
      vspan.set("sage.verify.passed", res.passed).end(res.passed ? "ok" : "error");
      return { passed: res.passed, violations: res.violations, feedback: feedbackFrom(res) };
    });
    crashPoint("after-verify");
    if (!v.passed) {
      if (v.violations.length) {
        return {
          ok: false,
          cls: "policy_denied",
          reason: `protected files modified: ${v.violations.join(", ")}`,
          feedback: v.feedback,
        };
      }
      return { ok: false, cls: "gate_failed", reason: "verification gates failed", feedback: v.feedback };
    }

    const merged = await this.serialMerge(() =>
      this.j.step(runId, t.id, `merge:${n}`, async () => {
        const integ = integrationWorktree(this.repo, runId);
        const head = this.j.mustTask(runId, t.id).headSha!;
        if (await isAncestor(integ, head, "HEAD")) return { ok: true, sha: await headSha(integ) };
        const msg = formatMessage(`sage: merge task ${t.id} — ${spec.title}`, undefined, {
          run: runId,
          task: t.id,
          step: `merge:${n}`,
        });
        const r = await gitTry(integ, ["merge", "--no-ff", "--no-edit", "-q", "-m", msg, head]);
        if (!r.ok) {
          await gitTry(integ, ["merge", "--abort"]);
          return { ok: false, sha: "", error: r.err || r.out };
        }
        return { ok: true, sha: await headSha(integ) };
      }),
    );
    if (!merged.ok) {
      return {
        ok: false,
        cls: "conflict",
        reason: `merge conflict: ${String((merged as { error?: string }).error ?? "").slice(0, 300)}`,
      };
    }
    if (this.j.mustTask(runId, t.id).mergedSha !== merged.sha) {
      this.j.append(runId, t.id, "sage", { type: "task.merged", sha: merged.sha });
    }
    this.tracer!.event(
      "sage.merge",
      { "sage.task.id": t.id, "sage.merge.sha": merged.sha.slice(0, 12) },
      taskSpan,
    );
    crashPoint("after-merge");
    return { ok: true };
  }

  private serialMerge<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.mergeChain.then(fn);
    this.mergeChain = p.catch(() => undefined);
    return p;
  }

  /* ==================================== guard =================================== */

  private async onGuard(r: GuardRequestParsed): Promise<GuardResponse> {
    const { runId, taskId } = r;
    const summary = summarizeCall(r.tool, r.args);
    if (this.isAborted(runId))
      return { decision: "deny", rule: "run-aborted", reason: "the run was aborted by a human" };
    let decision: { decision: "allow" | "deny" | "ask"; rule: string; reason: string };
    let parent: string;
    if (taskId === "planner") {
      parent = sid(runId, "plan");
      decision = READ_ONLY_TOOLS.has(r.tool.toLowerCase())
        ? evaluate(
            { tool: r.tool, args: r.args },
            policyContext(this.cfg, integrationWorktree(this.repo, runId), []),
          )
        : { decision: "deny", rule: "planner-read-only", reason: "the planner may only read files" };
    } else {
      const t = this.j.getTask(runId, taskId);
      if (!t?.worktree)
        return { decision: "deny", rule: "unknown-task", reason: `no active task '${taskId}'` };
      if (t.state !== "RUNNING" || t.attempt !== r.attempt) {
        return {
          decision: "deny",
          rule: "stale-session",
          reason: `task ${taskId} attempt ${r.attempt} is not running`,
        };
      }
      parent = sid(runId, "agent", taskId, r.attempt);
      decision = evaluate(
        { tool: r.tool, args: r.args },
        policyContext(this.cfg, t.worktree, this.j.taskSpec(t).allowedTestFiles),
      );
    }

    let final: "allow" | "deny" = decision.decision === "allow" ? "allow" : "deny";
    if (decision.decision === "ask") {
      const approvalId = newId("ask");
      this.j.append(runId, taskId === "planner" ? null : taskId, "sage", {
        type: "approval.requested",
        approvalId,
        kind: "tool",
        request: `${summary} — ${decision.reason}`,
      });
      const ok = await this.asker.ask({
        runId,
        taskId,
        approvalId,
        tool: r.tool,
        summary,
        reason: decision.reason,
      });
      const existing = this.j.getApproval(approvalId);
      const actor: Actor = this.asker instanceof DenyAsker ? "sage" : "human";
      if (existing?.status === "pending") {
        this.j.append(runId, taskId === "planner" ? null : taskId, actor, {
          type: "approval.decided",
          approvalId,
          decision: ok ? "approved" : "rejected",
          reason: actor === "sage" ? "no interactive approver; default deny" : undefined,
        });
      }
      final = ok && !this.isAborted(runId) ? "allow" : "deny";
    }
    this.j.append(runId, taskId === "planner" ? null : taskId, "sage", {
      type: "policy.decision",
      callId: r.callId,
      tool: r.tool,
      decision: decision.decision,
      final,
      rule: decision.rule,
      reason: decision.reason,
      summary,
    });
    this.tracer?.event(
      "execute_tool",
      {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": r.tool,
        "gen_ai.tool.call.id": r.callId,
        "sage.policy.decision": decision.decision,
        "sage.policy.final": final,
        "sage.policy.rule": decision.rule,
        "sage.tool.summary": summary,
      },
      parent,
      final === "allow" ? "ok" : "error",
    );
    if (final === "deny")
      this.log(`policy denied ${taskId}: ${summary} (${decision.rule}: ${decision.reason})`);
    return { decision: final, rule: decision.rule, reason: decision.reason };
  }
}

export function summarizeCall(tool: string, args: Record<string, unknown>): string {
  const p = args.path ?? args.filePath ?? args.file_path ?? args.url ?? args.pattern;
  if (typeof args.command === "string") return `${tool} \`${args.command.slice(0, 160)}\``;
  if (typeof p === "string") return `${tool} ${p.slice(0, 200)}`;
  return tool;
}
