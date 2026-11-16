import { type GateConfig, matchesAny, toPosix } from "@sage/core";
import { changedFiles, commitAll, dirtyFiles, runProcess } from "@sage/workspace";
import { PARSERS } from "./parsers.ts";

export interface GateResult {
  gate: string;
  passed: boolean;
  required: boolean;
  exitCode: number | null;
  timedOut: boolean;
  summary: string;
  /** Tail of the combined output, fed back to the agent on retry. */
  outputTail: string;
  durationMs: number;
}

export interface VerifyInput {
  worktree: string;
  /** Commit the task started from. */
  baseSha: string;
  gates: readonly GateConfig[];
  env: Record<string, string>;
  protectedPaths: readonly string[];
  allowedTestFiles: readonly string[];
  /** Commit trailers used if leftover uncommitted changes must be captured before verifying. */
  trailers?: { run: string; task?: string };
}

export interface VerifyResult {
  passed: boolean;
  gates: GateResult[];
  /** Protected files changed without plan authorisation (tamper evidence). */
  violations: string[];
  changed: string[];
}

export async function runGate(g: GateConfig, cwd: string, env: Record<string, string>): Promise<GateResult> {
  const argv = g.command.map((a) => (a === "bun" ? process.execPath : a));
  const r = await runProcess(argv, { cwd, env, timeoutMs: g.timeoutMs });
  const out = `${r.stdout}\n${r.stderr}`;
  const parsed = PARSERS[g.parser](out, r.code);
  const passed = parsed.passed && !r.timedOut;
  return {
    gate: g.name,
    passed,
    required: g.required,
    exitCode: r.code,
    timedOut: r.timedOut,
    summary: r.timedOut ? `timed out after ${g.timeoutMs}ms` : parsed.summary,
    outputTail: out.trim().split(/\r?\n/).slice(-60).join("\n").slice(-6000),
    durationMs: r.durationMs,
  };
}

export function protectedViolations(
  files: readonly string[],
  protectedPaths: readonly string[],
  allowed: readonly string[],
): string[] {
  const allow = new Set(allowed.map(toPosix));
  return files.filter((f) => matchesAny(f, protectedPaths) && !allow.has(toPosix(f)));
}

/**
 * Independent verification, run by SAGE (never by the agent). The task's committed head is compared
 * with its base for protected-file tampering, then every configured gate runs in the worktree with a
 * scrubbed environment. The task passes only if all required gates pass and there are no violations.
 */
export async function verifyTask(input: VerifyInput): Promise<VerifyResult> {
  // Uncommitted leftovers would make verification ambiguous; they are a bug in the caller.
  const dirty = await dirtyFiles(input.worktree);
  if (dirty.length) {
    await commitAll(input.worktree, "sage: capture uncommitted changes before verify", undefined, {
      run: input.trailers?.run ?? "unknown",
      task: input.trailers?.task,
      step: "verify-capture",
    });
  }
  const changed = await changedFiles(input.worktree, input.baseSha, "HEAD");
  const violations = protectedViolations(changed, input.protectedPaths, input.allowedTestFiles);
  const gates: GateResult[] = [];
  for (const g of input.gates) gates.push(await runGate(g, input.worktree, input.env));
  const passed = violations.length === 0 && gates.every((g) => g.passed || !g.required);
  return { passed, gates, violations, changed };
}

/** Feedback text for a retry, built from gate output (truncated) and violations. */
export function feedbackFrom(v: VerifyResult): string {
  const parts: string[] = [];
  if (v.violations.length) {
    parts.push(
      `Your change modified protected files, which is not allowed: ${v.violations.join(", ")}. ` +
        "Do not edit tests or CI configuration; change the implementation instead.",
    );
  }
  for (const g of v.gates.filter((x) => !x.passed)) {
    parts.push(`Gate '${g.gate}' failed (${g.summary}). Output (tail):\n${g.outputTail}`);
  }
  return parts.join("\n\n").slice(0, 8000);
}
