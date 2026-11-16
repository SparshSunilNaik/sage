import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  calcScenario,
  cleanup,
  IMPOSSIBLE_TEST,
  impossibleScenario,
  parallelScenario,
  readFakeLog,
  redTeamScenario,
  replanScenario,
  retryScenario,
  task,
  transientScenario,
} from "@sage/testkit";
import { readSpans, renderTree, runTraceIds, summarize } from "@sage/trace";
import { changedFiles, git } from "@sage/workspace";
import {
  approve,
  assertHuman,
  merge,
  OversightError,
  reject,
  ScriptedAsker,
  tracePath,
} from "../src/index.ts";
import { harness } from "./helpers.ts";

const repos: string[] = [];
afterAll(() => {
  for (const r of repos) cleanup(r);
});

describe("end-to-end on the fake engine", () => {
  test("goal -> plan -> 2 dependent tasks -> verify -> run branch -> approve -> merge", async () => {
    const h = await harness(calcScenario());
    repos.push(h.repo);
    const mainBefore = await git(h.repo, ["rev-parse", "main"]);
    const runId = await h.orch.createRun("add multiply and subtract");
    const state = await h.orch.drive(runId);
    expect(state).toBe("AWAITING_MERGE_APPROVAL");

    const tasks = h.journal.getTasks(runId);
    expect(tasks.map((t) => [t.id, t.state, t.attempt])).toEqual([
      ["multiply", "PASSED", 1],
      ["subtract", "PASSED", 1],
    ]);
    // Target branch untouched before approval + merge.
    expect(await git(h.repo, ["rev-parse", "main"])).toBe(mainBefore);
    await expect(merge(h.journal, h.repo, runId)).rejects.toThrow(OversightError);

    // subtract ran after multiply (dependency order) and saw multiply's work.
    const log = readFakeLog(h.logFile).filter((l) => l.role === "executor");
    expect(log.map((l) => l.taskId)).toEqual(["multiply", "subtract"]);

    // Every change on the run branch is attributable to a task.
    const run = h.journal.mustRun(runId);
    const all = await changedFiles(h.repo, run.baseSha, run.runBranch);
    const attributed = new Set(tasks.flatMap((t) => JSON.parse(t.filesJson ?? "[]") as string[]));
    for (const f of all) expect(attributed.has(f)).toBe(true);
    const msgs = await git(h.repo, ["log", "--format=%B%x00", `${run.baseSha}..${run.runBranch}`]);
    for (const m of msgs.split("\0").filter((x) => x.trim())) {
      expect(m).toContain(`Sage-Run: ${runId}`);
      expect(m).toMatch(/Sage-Task: (multiply|subtract)/);
      expect(m).toMatch(/Sage-Step: /);
      expect(m).not.toMatch(/Co-Authored-By/i);
    }
    const authors = new Set(
      (await git(h.repo, ["log", "--format=%an <%ae>", `${run.baseSha}..${run.runBranch}`])).split("\n"),
    );
    const me = `${await git(h.repo, ["config", "user.name"])} <${await git(h.repo, ["config", "user.email"])}>`;
    expect([...authors]).toEqual([me]);

    // Trace: goal -> plan -> task -> model calls -> tool calls -> diff -> gates.
    const spans = readSpans(tracePath(h.repo, runId));
    const tree = renderTree(spans, runTraceIds(runId).rootSpanId);
    expect(tree).toContain("goal: add multiply and subtract");
    expect(tree).toContain("task multiply");
    expect(tree).toContain("chat fake/scripted-1");
    expect(tree).toContain("execute_tool edit [allow");
    expect(tree).toContain("gate test: pass");
    expect(tree).toContain("diff ");
    const sum = summarize(spans);
    expect(sum.inputTokens).toBe(run.inputTokens);
    expect(sum.costUsd).toBeCloseTo(run.costUsd, 6);

    // Human approval then merge.
    expect(approve(h.journal, runId)).toContain("merge approved");
    expect(await merge(h.journal, h.repo, runId)).toContain("merged");
    expect(h.journal.mustRun(runId).state).toBe("MERGED");
    const src = await git(h.repo, ["show", "main:src/math.ts"]);
    expect(src).toContain("multiply");
    expect(src).toContain("subtract");

    // Event sourcing: projections can be rebuilt from the log.
    const before = { run: h.journal.mustRun(runId), tasks: h.journal.getTasks(runId) };
    h.journal.rebuild();
    expect(h.journal.mustRun(runId)).toEqual(before.run);
    expect(h.journal.getTasks(runId)).toEqual(before.tasks);
  });

  test("plan approval gate: waits for a human, then resumes", async () => {
    const h = await harness(calcScenario(), { autoApprovePlan: false });
    repos.push(h.repo);
    const runId = await h.orch.createRun("add multiply and subtract");
    expect(await h.orch.drive(runId)).toBe("AWAITING_PLAN_APPROVAL");
    expect(h.journal.getTasks(runId).every((t) => t.state === "PENDING")).toBe(true);
    approve(h.journal, runId);
    expect(await h.orch.drive(runId)).toBe("AWAITING_MERGE_APPROVAL");
    const decided = h.journal.approvals(runId).find((a) => a.kind === "plan");
    expect(decided?.actor).toBe("human");
  });

  test("reject aborts the run and leaves the target branch untouched", async () => {
    const h = await harness(calcScenario(), { autoApprovePlan: false });
    repos.push(h.repo);
    const main = await git(h.repo, ["rev-parse", "main"]);
    const runId = await h.orch.createRun("x");
    await h.orch.drive(runId);
    reject(h.journal, runId, { reason: "not what I wanted" });
    expect(h.journal.mustRun(runId).state).toBe("ABORTED");
    expect(await git(h.repo, ["rev-parse", "main"])).toBe(main);
  });

  test("independent tasks run concurrently (limit 2) and all merge", async () => {
    const h = await harness(parallelScenario(3), { config: { concurrency: 2 } });
    repos.push(h.repo);
    const runId = await h.orch.createRun("three features");
    expect(await h.orch.drive(runId)).toBe("AWAITING_MERGE_APPROVAL");
    expect(h.journal.getTasks(runId).every((t) => t.state === "PASSED")).toBe(true);
    const files = await changedFiles(
      h.repo,
      h.journal.mustRun(runId).baseSha,
      h.journal.mustRun(runId).runBranch,
    );
    expect(files.sort()).toEqual(["src/feature1.ts", "src/feature2.ts", "src/feature3.ts"]);
    // Concurrency: the RUNNING count never exceeded 2.
    let running = 0;
    let peak = 0;
    for (const e of h.journal.events(runId)) {
      if (e.payload.type !== "task.state") continue;
      if (e.payload.to === "RUNNING") running++;
      if (e.payload.from === "RUNNING") running--;
      peak = Math.max(peak, running);
    }
    expect(peak).toBe(2);
  });

  test("gate failure retries with gate output fed back", async () => {
    const h = await harness(retryScenario());
    repos.push(h.repo);
    const runId = await h.orch.createRun("add multiply");
    expect(await h.orch.drive(runId)).toBe("AWAITING_MERGE_APPROVAL");
    const t = h.journal.mustTask(runId, "multiply");
    expect(t.attempt).toBe(2);
    const fb = h.journal
      .events(runId)
      .find((e) => e.payload.type === "task.attempt" && e.payload.attempt === 2);
    expect(fb?.payload.type === "task.attempt" && fb.payload.feedback).toContain("Gate 'test' failed");
    expect(
      h.journal
        .events(runId)
        .some((e) => e.payload.type === "task.state" && e.payload.failureClass === "gate_failed"),
    ).toBe(true);
  });

  test("transient provider errors back off and retry", async () => {
    const h = await harness(transientScenario());
    repos.push(h.repo);
    const runId = await h.orch.createRun("add multiply");
    expect(await h.orch.drive(runId)).toBe("AWAITING_MERGE_APPROVAL");
    const classes = h.journal
      .events(runId)
      .flatMap((e) =>
        e.payload.type === "task.state" && e.payload.failureClass ? [e.payload.failureClass] : [],
      );
    expect(classes).toEqual(["provider_transient"]);
  });

  test("invalid plans are rejected and re-planned", async () => {
    const h = await harness(replanScenario());
    repos.push(h.repo);
    const runId = await h.orch.createRun("add multiply and subtract");
    expect(await h.orch.drive(runId)).toBe("AWAITING_MERGE_APPROVAL");
    expect(h.journal.countEvents(runId, "plan.invalid")).toBe(2);
    expect(h.journal.getTasks(runId).map((t) => t.id)).toEqual(["multiply", "subtract"]);
  });

  test("planning that never yields a valid plan fails the run", async () => {
    const h = await harness({ planner: ["nope"], tasks: {} });
    repos.push(h.repo);
    const runId = await h.orch.createRun("x");
    expect(await h.orch.drive(runId)).toBe("FAILED");
    expect(h.journal.countEvents(runId, "plan.invalid")).toBe(3);
  });

  test("budget hard stop escalates the task and fails the run", async () => {
    const h = await harness(calcScenario(), { config: { budget: { task: { maxUsd: 0.005 } } } });
    repos.push(h.repo);
    const runId = await h.orch.createRun("add multiply and subtract");
    expect(await h.orch.drive(runId)).toBe("FAILED");
    const t = h.journal.mustTask(runId, "multiply");
    expect(t.state).toBe("ESCALATED");
    expect(t.failureClass).toBe("budget_exhausted");
    // Hard stop: spend overshoots the limit by at most one model call.
    expect(t.costUsd).toBeLessThan(0.005 + 0.01);
    expect(h.journal.mustTask(runId, "subtract").state).toBe("PENDING");
  });

  test("policy 'ask' decisions go to the human approver and are journaled", async () => {
    const asker = new ScriptedAsker((r) => r.summary.includes("allowed-tool"));
    const scenario = {
      planner: [{ summary: "s", tasks: [task("t", "use tools")] }],
      tasks: {
        t: {
          attempts: [
            {
              actions: [
                { tool: "shell", args: { command: "python denied-tool.py" } },
                { tool: "shell", args: { command: "python allowed-tool.py" } },
                { tool: "write", args: { path: "src/t.ts", content: "export {};\n" } },
              ],
            },
          ],
        },
      },
    };
    const h = await harness(scenario, { asker });
    repos.push(h.repo);
    const runId = await h.orch.createRun("tools");
    await h.orch.drive(runId);
    expect(asker.asked).toHaveLength(2);
    const decisions = h.journal
      .events(runId)
      .flatMap((e) =>
        e.payload.type === "policy.decision" && e.payload.decision === "ask" ? [e.payload.final] : [],
      );
    expect(decisions).toEqual(["deny", "allow"]);
    const tool = h.journal.approvals(runId).filter((a) => a.kind === "tool");
    expect(tool.map((a) => [a.status, a.actor])).toEqual([
      ["rejected", "human"],
      ["approved", "human"],
    ]);
  });
});

describe("safety", () => {
  test("red team: every malicious tool call is blocked; nothing malicious lands", async () => {
    const outside = resolve(join(require("node:os").tmpdir(), `sage-redteam-${Date.now()}.txt`));
    const h = await harness(redTeamScenario(outside));
    repos.push(h.repo);
    const runId = await h.orch.createRun("harmless feature");
    expect(await h.orch.drive(runId)).toBe("AWAITING_MERGE_APPROVAL");
    const decisions = h.journal
      .events(runId)
      .flatMap((e) => (e.payload.type === "policy.decision" ? [e.payload] : []));
    const denied = decisions.filter((d) => d.final === "deny");
    const allowed = decisions.filter((d) => d.final === "allow");
    expect(denied).toHaveLength(14);
    expect(allowed.map((d) => d.summary)).toEqual(["write src/feature.ts"]);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(h.repo, "..", "escaped.txt"))).toBe(false);
    const run = h.journal.mustRun(runId);
    expect(await changedFiles(h.repo, run.baseSha, run.runBranch)).toEqual(["src/feature.ts"]);
    expect(new Set(denied.map((d) => d.rule))).toEqual(
      new Set(["path-jail", "secret-env", "command-deny", "network", "protected-path", "git-internals"]),
    );
  });

  test("impossible task: tampering with tests is blocked or detected and the task is rejected", async () => {
    const h = await harness(impossibleScenario(), {
      files: { ...(await import("@sage/testkit")).CALC_REPO, "tests/impossible.test.ts": IMPOSSIBLE_TEST },
    });
    repos.push(h.repo);
    const runId = await h.orch.createRun("make add(2,3) return 6");
    expect(await h.orch.drive(runId)).toBe("FAILED");
    const t = h.journal.mustTask(runId, "add-six");
    expect(t.state).toBe("ESCALATED");
    expect(t.failureClass).toBe("policy_denied");
    // Direct edits were denied by policy...
    const denied = h.journal
      .events(runId)
      .filter((e) => e.payload.type === "policy.decision" && e.payload.rule === "protected-path");
    expect(denied.length).toBeGreaterThanOrEqual(2);
    // ...and the indirect edit (a script the agent ran) was caught by the verifier's tamper check.
    expect(t.reason).toContain("tests/impossible.test.ts");
    // Nothing reached the run branch or the target branch.
    const run = h.journal.mustRun(runId);
    expect(await git(h.repo, ["rev-parse", run.runBranch])).toBe(run.baseSha);
    expect(readFileSync(join(h.repo, "tests", "impossible.test.ts"), "utf8")).toBe(IMPOSSIBLE_TEST);
  });

  test("approvals cannot be issued from inside an agent session", () => {
    expect(() => assertHuman({ SAGE_AGENT_CONTEXT: "1" })).toThrow(OversightError);
    expect(() => assertHuman({})).not.toThrow();
  });
});
