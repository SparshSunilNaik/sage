/**
 * LIVE smoke test against a real model through OpenCode. Opt-in only: requires SAGE_LIVE=1.
 * Spend is hard-capped by SAGE's budget (default $0.75 per run, 600k tokens).
 *
 * Usage (bash):
 *   SAGE_LIVE=1 bun run scripts/live-smoke.ts --model openai/gpt-5.5 [--bin opencode] [--shared-store] [--max-usd 0.75]
 * PowerShell:
 *   $env:SAGE_LIVE=1; bun run scripts/live-smoke.ts --model openai/gpt-5.5 --shared-store
 *
 * --shared-store uses OpenCode's own data store so credentials saved with `opencode auth login` work
 * (SAGE sessions then also appear in your OpenCode session list). Without it, pass provider API keys
 * via the environment and they are forwarded with engine.opencode.passEnv.
 */
import { Journal, SageConfig } from "../packages/core/src/index.ts";
import {
  dbPath,
  makeEngine,
  Orchestrator,
  ScriptedAsker,
  tracePath,
} from "../packages/orchestrator/src/index.ts";
import { cleanup, makeRepo } from "../packages/testkit/src/index.ts";
import { readSpans, renderTree, runTraceIds, summarize } from "../packages/trace/src/index.ts";
import { changedFiles, git } from "../packages/workspace/src/index.ts";

if (process.env.SAGE_LIVE !== "1") {
  console.error("refusing to run: set SAGE_LIVE=1 to allow paid model calls");
  process.exit(2);
}
const arg = (name: string, def?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const model = arg("model");
if (!model) throw new Error("--model provider/model is required");
const maxUsd = Number(arg("max-usd", "0.75"));
const PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"];

const repo = await makeRepo();
const config = SageConfig.parse({
  concurrency: 1,
  engine: {
    kind: "opencode",
    model,
    opencode: {
      bin: arg("bin", "opencode"),
      isolateState: !process.argv.includes("--shared-store"),
      passEnv: PROVIDER_KEYS.filter((k) => process.env[k]),
      turnTimeoutMs: 600_000,
    },
  },
  budget: { run: { maxUsd, maxTokens: 600_000 }, task: { maxUsd, maxTokens: 400_000 } },
  retry: { maxAttempts: 2, maxPlanAttempts: 2 },
});
const journal = Journal.open(dbPath(repo));
const asker = new ScriptedAsker(() => false); // unattended: anything policy wants a human for is denied
const orch = new Orchestrator({
  repo,
  journal,
  config,
  engine: makeEngine(config, repo),
  asker,
  autoApprovePlan: true,
  log: (m) => console.error(`[sage] ${m}`),
});
const t0 = Date.now();
const runId = await orch.createRun(
  "Add an exported function multiply(a: number, b: number): number to src/math.ts, and a bun test for it in tests/multiply.test.ts.",
);
let state: string;
try {
  state = await orch.drive(runId);
} catch (e) {
  state = `error: ${(e as Error).message}`;
}
const run = journal.mustRun(runId);
const spans = readSpans(tracePath(repo, runId));
console.log(renderTree(spans, runTraceIds(runId).rootSpanId));
const s = summarize(spans);
const files = await changedFiles(repo, run.baseSha, run.runBranch).catch(() => []);
const result = {
  runId,
  model,
  state,
  reason: run.reason,
  planErrors: journal
    .events(runId)
    .flatMap((e) => (e.payload.type === "plan.invalid" ? e.payload.errors : [])),
  wallClockSec: Math.round((Date.now() - t0) / 1000),
  costUsd: run.costUsd,
  inputTokens: run.inputTokens,
  outputTokens: run.outputTokens,
  modelCalls: s.modelCalls,
  toolCalls: s.toolCalls,
  deniedToolCalls: s.denied,
  asks: asker.asked.map((a) => a.summary),
  tasks: journal
    .getTasks(runId)
    .map((t) => ({ id: t.id, state: t.state, attempts: t.attempt, failure: t.failureClass })),
  filesChanged: files,
  mainUntouched: (await git(repo, ["rev-parse", "main"])) === run.baseSha,
};
console.log(JSON.stringify(result, null, 2));
await Bun.write(`.cache/live-smoke-${runId}.json`, JSON.stringify(result, null, 2));
journal.close();
if (!process.argv.includes("--keep")) cleanup(repo);
