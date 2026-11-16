import { z } from "zod";

export const FailureClass = z.enum([
  "provider_transient",
  "tool_error",
  "gate_failed",
  "policy_denied",
  "budget_exhausted",
  "conflict",
  "unknown",
]);
export type FailureClass = z.infer<typeof FailureClass>;

/** What the orchestrator does with each failure class. */
export type RecoveryAction =
  | { kind: "retry_backoff"; delayMs: number }
  | { kind: "retry_with_feedback" }
  | { kind: "retry_rebase" }
  | { kind: "escalate"; reason: string };

export interface RetryLimits {
  /** Total agent attempts per task (first attempt included). */
  maxAttempts: number;
  /** Extra attempts allowed for provider_transient failures (do not count toward maxAttempts). */
  maxTransientRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** policy_denied failures get at most this many feedback retries before escalation. */
  maxPolicyRetries: number;
}

export interface FailureHistory {
  attempt: number;
  transientRetries: number;
  policyRetries: number;
}

/**
 * Pure decision function: failure class + history + limits -> recovery action.
 * Kept deterministic so that it can be unit-tested exhaustively.
 */
export function decideRecovery(cls: FailureClass, h: FailureHistory, limits: RetryLimits): RecoveryAction {
  switch (cls) {
    case "provider_transient": {
      if (h.transientRetries >= limits.maxTransientRetries) {
        return { kind: "escalate", reason: "provider transient retries exhausted" };
      }
      const delay = Math.min(limits.backoffMaxMs, limits.backoffBaseMs * 2 ** h.transientRetries);
      return { kind: "retry_backoff", delayMs: delay };
    }
    case "tool_error":
    case "gate_failed":
      if (h.attempt >= limits.maxAttempts) return { kind: "escalate", reason: `${cls}: attempts exhausted` };
      return { kind: "retry_with_feedback" };
    case "policy_denied":
      if (h.policyRetries >= limits.maxPolicyRetries || h.attempt >= limits.maxAttempts) {
        return { kind: "escalate", reason: "policy violation; human review required" };
      }
      return { kind: "retry_with_feedback" };
    case "conflict":
      if (h.attempt >= limits.maxAttempts)
        return { kind: "escalate", reason: "conflict: attempts exhausted" };
      return { kind: "retry_rebase" };
    case "budget_exhausted":
      return { kind: "escalate", reason: "budget exhausted (hard stop)" };
    case "unknown":
      return { kind: "escalate", reason: "unclassified failure" };
  }
}

const TRANSIENT_PATTERNS = [
  /\b(429|500|502|503|504|529)\b/,
  /rate.?limit/i,
  /overloaded/i,
  /timed? ?out/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i,
];

/** Classify a raw engine/provider error message. */
export function classifyEngineError(message: string): FailureClass {
  if (TRANSIENT_PATTERNS.some((p) => p.test(message))) return "provider_transient";
  if (/budget/i.test(message)) return "budget_exhausted";
  if (/tool/i.test(message)) return "tool_error";
  return "unknown";
}
