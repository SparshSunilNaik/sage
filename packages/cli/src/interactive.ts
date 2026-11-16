import * as p from "@clack/prompts";
import type { Plan } from "@sage/core";
import type { Asker, AskRequest } from "@sage/orchestrator";

export const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export function formatPlan(plan: Plan): string {
  const lines = [`Plan: ${plan.summary}`];
  for (const t of plan.tasks) {
    lines.push(`  • [${t.id}] ${t.title}${t.dependsOn.length ? `  (after: ${t.dependsOn.join(", ")})` : ""}`);
    for (const c of t.acceptanceCriteria) lines.push(`      ✓ ${c}`);
    if (t.filesExpected.length) lines.push(`      files: ${t.filesExpected.join(", ")}`);
    if (t.allowedTestFiles.length) lines.push(`      may edit tests: ${t.allowedTestFiles.join(", ")}`);
  }
  return lines.join("\n");
}

export async function confirmPlan(plan: Plan, runId: string): Promise<boolean> {
  p.note(formatPlan(plan), `run ${runId}`);
  const r = await p.confirm({ message: "Approve this plan and start execution?" });
  return r === true;
}

/** Human prompt for policy "ask" decisions. */
export class ClackAsker implements Asker {
  async ask(r: AskRequest): Promise<boolean> {
    const res = await p.confirm({
      message: `Task ${r.taskId} wants to run: ${r.summary}\n  Policy: ${r.reason}\n  Allow once?`,
      initialValue: false,
    });
    return res === true;
  }
}
