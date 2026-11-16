#!/usr/bin/env bun
import { Command } from "commander";
import {
  cmdAbort,
  cmdApprove,
  cmdDiff,
  cmdDoctor,
  cmdGc,
  cmdInit,
  cmdMerge,
  cmdReject,
  cmdResume,
  cmdRun,
  cmdStatus,
  cmdTrace,
} from "./commands.ts";
import { err } from "./context.ts";

const program = new Command();
program
  .name("sage")
  .description("SAGE: an autonomous, model-agnostic software-development control plane on top of OpenCode")
  .version("0.1.0")
  .option("-C, --repo <path>", "target git repository (default: current directory)");

const g = () => program.opts<{ repo?: string }>();

program
  .command("init")
  .description("write sage.config.jsonc and prepare the .sage state directory")
  .option("--force", "overwrite an existing config")
  .option("--fake <scenario>", "configure the deterministic fake engine with a scenario file")
  .action((o) => cmdInit({ ...g(), ...o }));

program
  .command("run")
  .description("plan and execute a goal (stops for plan approval unless --yes, and always before merge)")
  .argument("<goal>", "what you want done")
  .option("-y, --yes", "pre-approve the plan")
  .option("-c, --concurrency <n>", "parallel tasks (default from config: 2)")
  .action(async (goal, o) => {
    await cmdRun(goal, { ...g(), ...o });
  });

program
  .command("plan")
  .description("create a run and produce a plan only (approve later with `sage approve`)")
  .argument("<goal>")
  .action(async (goal) => {
    await cmdRun(goal, { ...g(), planOnly: true });
  });

program
  .command("status")
  .description("list runs, or show one run in detail")
  .argument("[run]", "run id (prefix) or 'latest'")
  .option("--json", "machine-readable output")
  .action(async (run, o) => {
    await cmdStatus(run, { ...g(), ...o });
  });

program
  .command("approve")
  .description("approve a pending plan or merge (or a single policy request with --request)")
  .argument("<run>")
  .option("--request <id>", "approve one pending policy 'ask' request")
  .option("--reason <text>", "note recorded with the approval")
  .action((run, o) => cmdApprove(run, { ...g(), ...o }));

program
  .command("reject")
  .description("reject a run (ABORTED) or a single policy request with --request")
  .argument("<run>")
  .option("--request <id>", "reject one pending policy 'ask' request instead of the whole run")
  .option("--reason <text>", "note recorded with the rejection")
  .action((run, o) => cmdReject(run, { ...g(), ...o }));

program
  .command("resume")
  .description("continue a run from its journal (after a crash, approval, or with --retry-escalated)")
  .argument("<run>")
  .option("-y, --yes", "pre-approve the plan if it is still awaiting approval")
  .option("--retry-escalated", "give escalated tasks of a FAILED run another attempt")
  .action(async (run, o) => {
    await cmdResume(run, { ...g(), ...o });
  });

program
  .command("abort")
  .description("abort a run")
  .argument("<run>")
  .action((run) => cmdAbort(run, g()));

program
  .command("trace")
  .description(
    "print the causal trace: goal → plan → tasks → model/tool calls → policy → diffs → gates → approvals",
  )
  .argument("<run>")
  .option("--json", "raw spans")
  .action((run, o) => cmdTrace(run, { ...g(), ...o }));

program
  .command("diff")
  .description("show the run's changes (or one task's with --task)")
  .argument("<run>")
  .option("--task <id>", "only this task's changes")
  .option("--stat", "summary of changed files instead of the full diff")
  .action((run, o) => cmdDiff(run, { ...g(), ...o }));

program
  .command("merge")
  .description("fast-forward the target branch to the approved run branch")
  .argument("<run>")
  .action((run) => cmdMerge(run, g()));

program
  .command("doctor")
  .description("check environment, engine version, provider auth presence and disk usage")
  .action(() => cmdDoctor(g()));

program
  .command("gc")
  .description("remove worktrees of finished runs")
  .option("--all", "also include FAILED runs")
  .option("--branches", "also delete task (and unmerged run) branches")
  .option("--dry-run", "show what would be removed")
  .action((o) => cmdGc({ ...g(), ...o }));

program
  .command("eval")
  .description(
    "run the evaluation suite (fake mode by default; live with SAGE_LIVE=1) and write docs/EVALUATION.md",
  )
  .option("--live", "use the real engine (requires SAGE_LIVE=1 and a configured provider)")
  .option("--out <file>", "report path", "docs/EVALUATION.md")
  .option("--max-usd <n>", "live spend cap for the whole eval", "3")
  .action(async (o) => {
    const { runEvals } = await import("@sage/evals");
    await runEvals({ live: Boolean(o.live), out: o.out, maxUsd: Number(o.maxUsd) });
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  err(`sage: ${(e as Error).message}`);
  if (process.env.SAGE_DEBUG) err((e as Error).stack ?? "");
  process.exit(1);
});
