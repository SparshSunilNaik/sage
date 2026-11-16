import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Append-only event log. The single source of truth. */
export const events = sqliteTable("events", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  ts: text("ts").notNull(),
  runId: text("run_id").notNull(),
  taskId: text("task_id"),
  actor: text("actor").notNull(),
  type: text("type").notNull(),
  payload: text("payload").notNull(),
});

/* ---- Derived state (projections of `events`; can be rebuilt with Journal.rebuild()) ---- */

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  goal: text("goal").notNull(),
  repo: text("repo").notNull(),
  state: text("state").notNull(),
  targetBranch: text("target_branch").notNull(),
  baseSha: text("base_sha").notNull(),
  runBranch: text("run_branch").notNull(),
  planJson: text("plan_json"),
  reason: text("reason"),
  mergedSha: text("merged_sha"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const tasks = sqliteTable(
  "tasks",
  {
    runId: text("run_id").notNull(),
    id: text("id").notNull(),
    ord: integer("ord").notNull(),
    title: text("title").notNull(),
    specJson: text("spec_json").notNull(),
    state: text("state").notNull(),
    attempt: integer("attempt").notNull().default(0),
    feedback: text("feedback"),
    branch: text("branch"),
    worktree: text("worktree"),
    baseSha: text("base_sha"),
    headSha: text("head_sha"),
    filesJson: text("files_json"),
    mergedSha: text("merged_sha"),
    failureClass: text("failure_class"),
    reason: text("reason"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.id] })],
);

export const steps = sqliteTable(
  "steps",
  {
    runId: text("run_id").notNull(),
    taskId: text("task_id").notNull(),
    key: text("key").notNull(),
    status: text("status").notNull(),
    resultJson: text("result_json"),
    startedSeq: integer("started_seq").notNull(),
    doneSeq: integer("done_seq"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.taskId, t.key] })],
);

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  taskId: text("task_id"),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  request: text("request").notNull(),
  actor: text("actor"),
  reason: text("reason"),
  createdAt: text("created_at").notNull(),
  decidedAt: text("decided_at"),
});

/** Operational (non-historical) table: run leases with heartbeats. Acquire/release are journaled as events. */
export const leases = sqliteTable("leases", {
  runId: text("run_id").primaryKey(),
  owner: text("owner").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const DDL = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT, actor TEXT NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events table is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events table is append-only'); END;
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, goal TEXT NOT NULL, repo TEXT NOT NULL, state TEXT NOT NULL,
  target_branch TEXT NOT NULL, base_sha TEXT NOT NULL, run_branch TEXT NOT NULL,
  plan_json TEXT, reason TEXT, merged_sha TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  run_id TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, title TEXT NOT NULL,
  spec_json TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, feedback TEXT,
  branch TEXT, worktree TEXT, base_sha TEXT, head_sha TEXT, files_json TEXT, merged_sha TEXT,
  failure_class TEXT, reason TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);
CREATE TABLE IF NOT EXISTS steps (
  run_id TEXT NOT NULL, task_id TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL,
  result_json TEXT, started_seq INTEGER NOT NULL, done_seq INTEGER,
  PRIMARY KEY (run_id, task_id, key)
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
  request TEXT NOT NULL, actor TEXT, reason TEXT, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS leases (
  run_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
);
`;
