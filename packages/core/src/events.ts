import { z } from "zod";
import { FailureClass } from "./failure.ts";
import { Plan, TaskSpec } from "./plan.ts";
import { RunState, TaskState } from "./states.ts";

export const Actor = z.enum(["sage", "human", "engine", "agent"]);
export type Actor = z.infer<typeof Actor>;

const Usage = z.object({
  model: z.string(),
  role: z.enum(["planner", "executor"]),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});

export const EventPayload = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run.created"),
    goal: z.string(),
    repo: z.string(),
    targetBranch: z.string(),
    baseSha: z.string(),
    runBranch: z.string(),
  }),
  z.object({ type: z.literal("run.state"), from: RunState, to: RunState, reason: z.string().optional() }),
  z.object({ type: z.literal("plan.invalid"), attempt: z.number().int(), errors: z.array(z.string()) }),
  z.object({ type: z.literal("plan.accepted"), plan: Plan }),
  z.object({ type: z.literal("task.created"), ord: z.number().int(), spec: TaskSpec }),
  z.object({
    type: z.literal("task.state"),
    from: TaskState,
    to: TaskState,
    reason: z.string().optional(),
    failureClass: FailureClass.optional(),
  }),
  z.object({
    type: z.literal("task.attempt"),
    attempt: z.number().int().positive(),
    feedback: z.string().optional(),
  }),
  z.object({
    type: z.literal("task.workspace"),
    branch: z.string(),
    worktree: z.string(),
    baseSha: z.string(),
  }),
  z.object({ type: z.literal("task.head"), headSha: z.string(), files: z.array(z.string()) }),
  z.object({ type: z.literal("task.merged"), sha: z.string() }),
  z.object({ type: z.literal("step.started"), key: z.string() }),
  z.object({ type: z.literal("step.done"), key: z.string(), result: z.unknown() }),
  z.object({ type: z.literal("usage"), ...Usage.shape }),
  z.object({
    type: z.literal("policy.decision"),
    callId: z.string(),
    tool: z.string(),
    decision: z.enum(["allow", "deny", "ask"]),
    final: z.enum(["allow", "deny"]),
    rule: z.string(),
    reason: z.string(),
    summary: z.string(),
  }),
  z.object({
    type: z.literal("gate.result"),
    gate: z.string(),
    passed: z.boolean(),
    exitCode: z.number().int().nullable(),
    summary: z.string(),
    durationMs: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("approval.requested"),
    approvalId: z.string(),
    kind: z.enum(["plan", "merge", "tool", "escalation"]),
    request: z.string(),
  }),
  z.object({
    type: z.literal("approval.decided"),
    approvalId: z.string(),
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().optional(),
  }),
  z.object({ type: z.literal("lease.acquired"), owner: z.string(), expiresAt: z.number() }),
  z.object({ type: z.literal("lease.released"), owner: z.string() }),
  z.object({ type: z.literal("run.merged"), sha: z.string(), targetBranch: z.string() }),
  z.object({ type: z.literal("note"), message: z.string() }),
]);
export type EventPayload = z.infer<typeof EventPayload>;
export type EventType = EventPayload["type"];

export interface EventRecord {
  seq: number;
  ts: string;
  runId: string;
  taskId: string | null;
  actor: Actor;
  payload: EventPayload;
}
