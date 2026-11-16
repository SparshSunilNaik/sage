import { z } from "zod";

export const RunState = z.enum([
  "CREATED",
  "PLANNING",
  "AWAITING_PLAN_APPROVAL",
  "EXECUTING",
  "AWAITING_MERGE_APPROVAL",
  "MERGED",
  "FAILED",
  "ABORTED",
]);
export type RunState = z.infer<typeof RunState>;

export const TaskState = z.enum([
  "PENDING",
  "READY",
  "RUNNING",
  "VERIFYING",
  "PASSED",
  "RETRYING",
  "ESCALATED",
  "FAILED",
]);
export type TaskState = z.infer<typeof TaskState>;

/**
 * Allowed run transitions. FAILED -> EXECUTING exists only for an explicit human
 * "resume --retry-escalated"; the orchestrator never takes it on its own.
 */
const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  CREATED: ["PLANNING", "ABORTED", "FAILED"],
  PLANNING: ["AWAITING_PLAN_APPROVAL", "FAILED", "ABORTED"],
  AWAITING_PLAN_APPROVAL: ["EXECUTING", "PLANNING", "ABORTED"],
  EXECUTING: ["AWAITING_MERGE_APPROVAL", "FAILED", "ABORTED"],
  AWAITING_MERGE_APPROVAL: ["MERGED", "ABORTED", "FAILED"],
  MERGED: [],
  FAILED: ["EXECUTING", "ABORTED"],
  ABORTED: [],
};

const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  PENDING: ["READY", "FAILED"],
  READY: ["RUNNING", "FAILED"],
  RUNNING: ["VERIFYING", "RETRYING", "ESCALATED", "FAILED"],
  VERIFYING: ["PASSED", "RETRYING", "ESCALATED", "FAILED"],
  PASSED: [],
  RETRYING: ["RUNNING", "ESCALATED", "FAILED"],
  ESCALATED: ["RETRYING", "FAILED"],
  FAILED: [],
};

export const TERMINAL_RUN_STATES: readonly RunState[] = ["MERGED", "ABORTED"];
export const TERMINAL_TASK_STATES: readonly TaskState[] = ["PASSED", "FAILED"];

export class InvalidTransitionError extends Error {
  constructor(kind: "run" | "task", from: string, to: string) {
    super(`invalid ${kind} transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!canTransitionRun(from, to)) throw new InvalidTransitionError("run", from, to);
}

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!canTransitionTask(from, to)) throw new InvalidTransitionError("task", from, to);
}

export function runTransitions(): Readonly<Record<RunState, readonly RunState[]>> {
  return RUN_TRANSITIONS;
}

export function taskTransitions(): Readonly<Record<TaskState, readonly TaskState[]>> {
  return TASK_TRANSITIONS;
}
