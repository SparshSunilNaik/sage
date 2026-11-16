import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { type Actor, EventPayload, type EventRecord } from "./events.ts";
import type { FailureClass } from "./failure.ts";
import type { TaskSpec } from "./plan.ts";
import * as schema from "./schema.ts";
import { assertRunTransition, assertTaskTransition, type RunState, type TaskState } from "./states.ts";

export type RunRow = Omit<typeof schema.runs.$inferSelect, "state"> & { state: RunState };
export type TaskRow = Omit<typeof schema.tasks.$inferSelect, "state"> & { state: TaskState };
export type StepRow = typeof schema.steps.$inferSelect;
export type ApprovalRow = typeof schema.approvals.$inferSelect;

type Db = BunSQLiteDatabase<typeof schema>;

export class Journal {
  readonly db: Db;
  private constructor(
    readonly sqlite: Database,
    readonly path: string,
  ) {
    this.db = drizzle(sqlite, { schema });
  }

  static open(path: string): Journal {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const sqlite = new Database(path, { create: true });
    sqlite.exec("PRAGMA journal_mode = WAL;");
    // FULL: every committed transaction is durable before append() returns. This is what makes
    // "journal before side effect" meaningful across a hard kill.
    sqlite.exec("PRAGMA synchronous = FULL;");
    sqlite.exec("PRAGMA busy_timeout = 10000;");
    sqlite.exec(schema.DDL);
    return new Journal(sqlite, path);
  }

  close(): void {
    this.sqlite.close();
  }

  /** Append one event and update projections atomically. Validates payload + state transitions. */
  append(runId: string, taskId: string | null, actor: Actor, payload: EventPayload): EventRecord {
    const p = EventPayload.parse(payload);
    const ts = new Date().toISOString();
    return this.db.transaction((tx) => {
      this.checkInvariants(tx, runId, taskId, p);
      const row = tx
        .insert(schema.events)
        .values({ ts, runId, taskId, actor, type: p.type, payload: JSON.stringify(p) })
        .returning({ seq: schema.events.seq })
        .get();
      const rec: EventRecord = { seq: row.seq, ts, runId, taskId, actor, payload: p };
      project(tx, rec);
      return rec;
    });
  }

  private checkInvariants(tx: Db, runId: string, taskId: string | null, p: EventPayload): void {
    if (p.type === "run.created") return;
    const run = tx.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
    if (!run) throw new Error(`unknown run ${runId}`);
    if (p.type === "run.state") {
      if (run.state !== p.from) throw new Error(`run ${runId} is ${run.state}, not ${p.from}`);
      assertRunTransition(p.from, p.to);
    }
    if (p.type === "task.state") {
      if (!taskId) throw new Error("task.state requires taskId");
      const t = tx
        .select()
        .from(schema.tasks)
        .where(and(eq(schema.tasks.runId, runId), eq(schema.tasks.id, taskId)))
        .get();
      if (!t) throw new Error(`unknown task ${taskId}`);
      if (t.state !== p.from) throw new Error(`task ${taskId} is ${t.state}, not ${p.from}`);
      assertTaskTransition(p.from, p.to);
    }
  }

  /* ------------------------------ transitions ------------------------------ */

  transitionRun(runId: string, to: RunState, reason?: string, actor: Actor = "sage"): void {
    const run = this.mustRun(runId);
    if (run.state === to) return;
    this.append(runId, null, actor, { type: "run.state", from: run.state, to, reason });
  }

  transitionTask(
    runId: string,
    taskId: string,
    to: TaskState,
    opts: { reason?: string; failureClass?: FailureClass; actor?: Actor } = {},
  ): void {
    const t = this.mustTask(runId, taskId);
    if (t.state === to) return;
    this.append(runId, taskId, opts.actor ?? "sage", {
      type: "task.state",
      from: t.state,
      to,
      reason: opts.reason,
      failureClass: opts.failureClass,
    });
  }

  /* -------------------------------- queries -------------------------------- */

  getRun(runId: string): RunRow | undefined {
    return this.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get() as RunRow | undefined;
  }

  mustRun(runId: string): RunRow {
    const r = this.getRun(runId);
    if (!r) throw new Error(`run not found: ${runId}`);
    return r;
  }

  listRuns(): RunRow[] {
    return this.db.select().from(schema.runs).orderBy(asc(schema.runs.createdAt)).all() as RunRow[];
  }

  /** Resolve a full run id from a unique prefix (or "latest"). */
  resolveRunId(prefix: string): string {
    const all = this.listRuns();
    if (prefix === "latest" || prefix === "last") {
      const last = all.at(-1);
      if (!last) throw new Error("no runs");
      return last.id;
    }
    const m = all.filter((r) => r.id === prefix || r.id.startsWith(prefix));
    if (m.length === 1) return m[0]!.id;
    if (m.length === 0) throw new Error(`no run matches '${prefix}'`);
    throw new Error(`ambiguous run id '${prefix}'`);
  }

  getTasks(runId: string): TaskRow[] {
    return this.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.runId, runId))
      .orderBy(asc(schema.tasks.ord))
      .all() as TaskRow[];
  }

  getTask(runId: string, taskId: string): TaskRow | undefined {
    return this.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.runId, runId), eq(schema.tasks.id, taskId)))
      .get() as TaskRow | undefined;
  }

  mustTask(runId: string, taskId: string): TaskRow {
    const t = this.getTask(runId, taskId);
    if (!t) throw new Error(`task not found: ${runId}/${taskId}`);
    return t;
  }

  taskSpec(t: TaskRow): TaskSpec {
    return JSON.parse(t.specJson) as TaskSpec;
  }

  events(runId: string): EventRecord[] {
    return this.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.runId, runId))
      .orderBy(asc(schema.events.seq))
      .all()
      .map((e) => ({
        seq: e.seq,
        ts: e.ts,
        runId: e.runId,
        taskId: e.taskId,
        actor: e.actor as Actor,
        payload: EventPayload.parse(JSON.parse(e.payload)),
      }));
  }

  approvals(runId: string): ApprovalRow[] {
    return this.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.runId, runId))
      .orderBy(asc(schema.approvals.createdAt))
      .all();
  }

  getApproval(id: string): ApprovalRow | undefined {
    return this.db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
  }

  /* --------------------------------- steps --------------------------------- */

  getStep(runId: string, taskId: string | null, key: string): StepRow | undefined {
    return this.db
      .select()
      .from(schema.steps)
      .where(
        and(eq(schema.steps.runId, runId), eq(schema.steps.taskId, taskId ?? ""), eq(schema.steps.key, key)),
      )
      .get();
  }

  stepsFor(runId: string): StepRow[] {
    return this.db.select().from(schema.steps).where(eq(schema.steps.runId, runId)).all();
  }

  /**
   * Run a side-effecting step at most once to completion. The "started" record is journaled
   * BEFORE `fn` runs; "done" (with its result) after. If a previous process died between the two,
   * `fn` runs again with `resumed = true` and must be idempotent (or compensate first).
   */
  async step<T>(
    runId: string,
    taskId: string | null,
    key: string,
    fn: (ctx: { resumed: boolean }) => Promise<T>,
  ): Promise<T> {
    const existing = this.getStep(runId, taskId, key);
    if (existing?.status === "done") return JSON.parse(existing.resultJson ?? "null") as T;
    const resumed = existing?.status === "started";
    if (!resumed) this.append(runId, taskId, "sage", { type: "step.started", key });
    const result = await fn({ resumed });
    this.append(runId, taskId, "sage", { type: "step.done", key, result: result ?? null });
    return result;
  }

  /* -------------------------------- leases --------------------------------- */

  /** Acquire the run lease. Returns the current holder if it is held by someone else and not expired. */
  acquireLease(
    runId: string,
    owner: string,
    ttlMs: number,
    now = Date.now(),
  ): { ok: true } | { ok: false; holder: string; expiresAt: number } {
    const res = this.sqlite.transaction(() => {
      const cur = this.db.select().from(schema.leases).where(eq(schema.leases.runId, runId)).get();
      if (cur && cur.owner !== owner && cur.expiresAt > now) {
        return { ok: false as const, holder: cur.owner, expiresAt: cur.expiresAt };
      }
      this.db
        .insert(schema.leases)
        .values({ runId, owner, expiresAt: now + ttlMs })
        .onConflictDoUpdate({ target: schema.leases.runId, set: { owner, expiresAt: now + ttlMs } })
        .run();
      return { ok: true as const };
    })();
    if (res.ok) this.append(runId, null, "sage", { type: "lease.acquired", owner, expiresAt: now + ttlMs });
    return res;
  }

  renewLease(runId: string, owner: string, ttlMs: number, now = Date.now()): boolean {
    const r = this.sqlite
      .query("UPDATE leases SET expires_at = ? WHERE run_id = ? AND owner = ?")
      .run(now + ttlMs, runId, owner);
    return r.changes > 0;
  }

  releaseLease(runId: string, owner: string): void {
    const r = this.sqlite.query("DELETE FROM leases WHERE run_id = ? AND owner = ?").run(runId, owner);
    if (r.changes > 0) this.append(runId, null, "sage", { type: "lease.released", owner });
  }

  getLease(runId: string): { owner: string; expiresAt: number } | undefined {
    return this.db.select().from(schema.leases).where(eq(schema.leases.runId, runId)).get();
  }

  /* ----------------------------- rebuild / audit ---------------------------- */

  /** Drop all projections and replay the event log. Used to prove derived state = f(events). */
  rebuild(): void {
    const all = this.db.select().from(schema.events).orderBy(asc(schema.events.seq)).all();
    this.db.transaction((tx) => {
      tx.delete(schema.runs).run();
      tx.delete(schema.tasks).run();
      tx.delete(schema.steps).run();
      tx.delete(schema.approvals).run();
      for (const e of all) {
        project(tx, {
          seq: e.seq,
          ts: e.ts,
          runId: e.runId,
          taskId: e.taskId,
          actor: e.actor as Actor,
          payload: EventPayload.parse(JSON.parse(e.payload)),
        });
      }
    });
  }

  countEvents(runId: string, type?: string): number {
    const where = type
      ? and(eq(schema.events.runId, runId), eq(schema.events.type, type))
      : eq(schema.events.runId, runId);
    const r = this.db.select({ n: sql<number>`count(*)` }).from(schema.events).where(where).get();
    return r?.n ?? 0;
  }
}

/** Pure projection: apply one event to the derived tables. */
function project(tx: Db, e: EventRecord): void {
  const p = e.payload;
  const taskWhere = () => and(eq(schema.tasks.runId, e.runId), eq(schema.tasks.id, e.taskId ?? ""));
  switch (p.type) {
    case "run.created":
      tx.insert(schema.runs)
        .values({
          id: e.runId,
          goal: p.goal,
          repo: p.repo,
          state: "CREATED",
          targetBranch: p.targetBranch,
          baseSha: p.baseSha,
          runBranch: p.runBranch,
          createdAt: e.ts,
          updatedAt: e.ts,
        })
        .run();
      return;
    case "run.state":
      tx.update(schema.runs)
        .set({ state: p.to, reason: p.reason ?? null, updatedAt: e.ts })
        .where(eq(schema.runs.id, e.runId))
        .run();
      return;
    case "plan.accepted":
      tx.update(schema.runs)
        .set({ planJson: JSON.stringify(p.plan), updatedAt: e.ts })
        .where(eq(schema.runs.id, e.runId))
        .run();
      return;
    case "task.created":
      tx.insert(schema.tasks)
        .values({
          runId: e.runId,
          id: p.spec.id,
          ord: p.ord,
          title: p.spec.title,
          specJson: JSON.stringify(p.spec),
          state: "PENDING",
          updatedAt: e.ts,
        })
        .run();
      return;
    case "task.state":
      tx.update(schema.tasks)
        .set({
          state: p.to,
          reason: p.reason ?? null,
          ...(p.failureClass ? { failureClass: p.failureClass } : {}),
          updatedAt: e.ts,
        })
        .where(taskWhere())
        .run();
      return;
    case "task.attempt":
      tx.update(schema.tasks)
        .set({ attempt: p.attempt, feedback: p.feedback ?? null, updatedAt: e.ts })
        .where(taskWhere())
        .run();
      return;
    case "task.workspace":
      tx.update(schema.tasks)
        .set({ branch: p.branch, worktree: p.worktree, baseSha: p.baseSha, updatedAt: e.ts })
        .where(taskWhere())
        .run();
      return;
    case "task.head":
      tx.update(schema.tasks)
        .set({ headSha: p.headSha, filesJson: JSON.stringify(p.files), updatedAt: e.ts })
        .where(taskWhere())
        .run();
      return;
    case "task.merged":
      tx.update(schema.tasks).set({ mergedSha: p.sha, updatedAt: e.ts }).where(taskWhere()).run();
      return;
    case "step.started":
      tx.insert(schema.steps)
        .values({ runId: e.runId, taskId: e.taskId ?? "", key: p.key, status: "started", startedSeq: e.seq })
        .onConflictDoUpdate({
          target: [schema.steps.runId, schema.steps.taskId, schema.steps.key],
          set: { status: "started", startedSeq: e.seq, doneSeq: null, resultJson: null },
        })
        .run();
      return;
    case "step.done":
      tx.update(schema.steps)
        .set({ status: "done", resultJson: JSON.stringify(p.result ?? null), doneSeq: e.seq })
        .where(
          and(
            eq(schema.steps.runId, e.runId),
            eq(schema.steps.taskId, e.taskId ?? ""),
            eq(schema.steps.key, p.key),
          ),
        )
        .run();
      return;
    case "usage": {
      tx.update(schema.runs)
        .set({
          inputTokens: sql`${schema.runs.inputTokens} + ${p.inputTokens}`,
          outputTokens: sql`${schema.runs.outputTokens} + ${p.outputTokens}`,
          costUsd: sql`${schema.runs.costUsd} + ${p.costUsd}`,
        })
        .where(eq(schema.runs.id, e.runId))
        .run();
      if (e.taskId) {
        tx.update(schema.tasks)
          .set({
            inputTokens: sql`${schema.tasks.inputTokens} + ${p.inputTokens}`,
            outputTokens: sql`${schema.tasks.outputTokens} + ${p.outputTokens}`,
            costUsd: sql`${schema.tasks.costUsd} + ${p.costUsd}`,
          })
          .where(taskWhere())
          .run();
      }
      return;
    }
    case "approval.requested":
      tx.insert(schema.approvals)
        .values({
          id: p.approvalId,
          runId: e.runId,
          taskId: e.taskId,
          kind: p.kind,
          status: "pending",
          request: p.request,
          createdAt: e.ts,
        })
        .run();
      return;
    case "approval.decided":
      tx.update(schema.approvals)
        .set({ status: p.decision, actor: e.actor, reason: p.reason ?? null, decidedAt: e.ts })
        .where(eq(schema.approvals.id, p.approvalId))
        .run();
      return;
    case "run.merged":
      tx.update(schema.runs)
        .set({ mergedSha: p.sha, updatedAt: e.ts })
        .where(eq(schema.runs.id, e.runId))
        .run();
      return;
    case "plan.invalid":
    case "policy.decision":
    case "gate.result":
    case "lease.acquired":
    case "lease.released":
    case "note":
      return;
  }
}
