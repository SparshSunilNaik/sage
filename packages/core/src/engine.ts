/**
 * The one interface between SAGE and an execution engine (OpenCode or the fake test engine).
 * Every engine-specific detail lives behind this boundary (see ADR 0001).
 */

export interface ModelCall {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface EngineToolEvent {
  callId: string;
  tool: string;
  status: "completed" | "error";
  /** Short, redacted description (no file contents). */
  summary: string;
}

export interface TurnResult {
  status: "completed" | "error" | "aborted";
  /** Final assistant text (used for planner JSON and executor summaries). */
  text: string;
  error?: string;
  calls: ModelCall[];
  tools: EngineToolEvent[];
}

export interface GuardEndpoint {
  url: string;
  token: string;
}

export interface EngineStartOptions {
  runId: string;
  /** Task id, or "planner" for the planning session. */
  taskId: string;
  role: "planner" | "executor";
  /** Working directory of the session (the task worktree; repo root for read-only planning). */
  cwd: string;
  /** Scrubbed environment for the engine process. */
  env: Record<string, string>;
  guard: GuardEndpoint;
  model?: string;
  /** Private directory for engine state (DB, logs) for this session. */
  stateDir: string;
  attempt: number;
}

export interface PromptOptions {
  /** Called after every model call; the orchestrator uses it to enforce budgets mid-turn. */
  onModelCall?: (call: ModelCall) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface EngineSession {
  prompt(text: string, opts?: PromptOptions): Promise<TurnResult>;
  close(): Promise<void>;
}

export interface EngineAdapter {
  readonly name: string;
  version(): Promise<string>;
  start(opts: EngineStartOptions): Promise<EngineSession>;
}
