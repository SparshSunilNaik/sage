import { describe, expect, test } from "bun:test";
import {
  canTransitionRun,
  canTransitionTask,
  classifyEngineError,
  decideRecovery,
  InvalidTransitionError,
  Journal,
  matchesAny,
  parseConfig,
  RunState,
  runTransitions,
  TaskState,
  taskTransitions,
  topoOrder,
  validatePlan,
} from "../src/index.ts";

describe("state machines", () => {
  test("run happy path is allowed", () => {
    const path: RunState[] = [
      "CREATED",
      "PLANNING",
      "AWAITING_PLAN_APPROVAL",
      "EXECUTING",
      "AWAITING_MERGE_APPROVAL",
      "MERGED",
    ];
    for (let i = 0; i + 1 < path.length; i++) expect(canTransitionRun(path[i]!, path[i + 1]!)).toBe(true);
  });

  test("terminal run states have no exits", () => {
    expect(runTransitions().MERGED).toEqual([]);
    expect(runTransitions().ABORTED).toEqual([]);
  });

  test("illegal run transitions are rejected", () => {
    expect(canTransitionRun("CREATED", "EXECUTING")).toBe(false);
    expect(canTransitionRun("EXECUTING", "MERGED")).toBe(false); // merge needs approval state
    expect(canTransitionRun("PLANNING", "EXECUTING")).toBe(false); // plan approval cannot be skipped
  });

  test("every task state is covered and PASSED/FAILED are terminal", () => {
    for (const s of TaskState.options) expect(taskTransitions()[s]).toBeDefined();
    expect(taskTransitions().PASSED).toEqual([]);
    expect(taskTransitions().FAILED).toEqual([]);
  });

  test("task cannot pass without verification", () => {
    expect(canTransitionTask("RUNNING", "PASSED")).toBe(false);
    expect(canTransitionTask("VERIFYING", "PASSED")).toBe(true);
    expect(canTransitionTask("PENDING", "RUNNING")).toBe(false);
  });

  test("exhaustive matrix matches the declared tables", () => {
    for (const a of RunState.options)
      for (const b of RunState.options) expect(canTransitionRun(a, b)).toBe(runTransitions()[a].includes(b));
    for (const a of TaskState.options)
      for (const b of TaskState.options)
        expect(canTransitionTask(a, b)).toBe(taskTransitions()[a].includes(b));
  });
});

describe("plan validation", () => {
  const task = (id: string, deps: string[] = []) => ({
    id,
    title: `task ${id}`,
    description: "do it",
    dependsOn: deps,
    acceptanceCriteria: ["works"],
  });

  test("accepts a valid DAG and orders it", () => {
    const v = validatePlan({ summary: "s", tasks: [task("b", ["a"]), task("a"), task("c", ["a", "b"])] });
    expect(v.ok).toBe(true);
    if (v.ok) expect(topoOrder(v.plan.tasks)).toEqual(["a", "b", "c"]);
  });

  test("rejects cycles, unknown deps, duplicates, bad paths", () => {
    expect(validatePlan({ summary: "s", tasks: [task("a", ["b"]), task("b", ["a"])] }).ok).toBe(false);
    expect(validatePlan({ summary: "s", tasks: [task("a", ["zzz"])] }).ok).toBe(false);
    expect(validatePlan({ summary: "s", tasks: [task("a"), task("a")] }).ok).toBe(false);
    const bad = { ...task("a"), filesExpected: ["../outside.ts"] };
    expect(validatePlan({ summary: "s", tasks: [bad] }).ok).toBe(false);
    expect(validatePlan({ summary: "s", tasks: [] }).ok).toBe(false);
    expect(validatePlan("not json").ok).toBe(false);
  });
});

describe("config", () => {
  test("parses JSONC with comments and trailing commas and applies defaults", () => {
    const c = parseConfig(`// hi
      { "concurrency": 3, /* block */ "engine": { "kind": "fake", }, "url": "http://x//y", }`);
    expect(c.concurrency).toBe(3);
    expect(c.engine.kind).toBe("fake");
    expect(c.retry.maxAttempts).toBe(3);
    expect(c.policy.allowNetwork).toBe(false);
    expect(c.gates[0]?.name).toBe("test");
  });

  test("rejects invalid config", () => {
    expect(() => parseConfig(`{ "concurrency": 0 }`)).toThrow();
  });
});

describe("glob", () => {
  test("matches protected path patterns", () => {
    expect(matchesAny("tests/a.test.ts", ["**/*.test.*"])).toBe(true);
    expect(matchesAny("src/a.test.ts", ["**/*.test.*"])).toBe(true);
    expect(matchesAny("src\\deep\\x.spec.ts", ["**/*.spec.*"])).toBe(true);
    expect(matchesAny(".github/workflows/ci.yml", [".github/**"])).toBe(true);
    expect(matchesAny("src/index.ts", ["**/*.test.*", "tests/**"])).toBe(false);
    expect(matchesAny("src/a.ts", ["src/*.{ts,js}"])).toBe(true);
  });
});

describe("recovery", () => {
  const limits = {
    maxAttempts: 3,
    maxTransientRetries: 2,
    backoffBaseMs: 100,
    backoffMaxMs: 1000,
    maxPolicyRetries: 1,
  };
  test("transient errors back off exponentially then escalate", () => {
    expect(
      decideRecovery("provider_transient", { attempt: 1, transientRetries: 0, policyRetries: 0 }, limits),
    ).toEqual({
      kind: "retry_backoff",
      delayMs: 100,
    });
    expect(
      decideRecovery("provider_transient", { attempt: 1, transientRetries: 1, policyRetries: 0 }, limits),
    ).toEqual({
      kind: "retry_backoff",
      delayMs: 200,
    });
    expect(
      decideRecovery("provider_transient", { attempt: 1, transientRetries: 2, policyRetries: 0 }, limits)
        .kind,
    ).toBe("escalate");
  });
  test("gate failures retry with feedback until attempts exhausted", () => {
    expect(
      decideRecovery("gate_failed", { attempt: 1, transientRetries: 0, policyRetries: 0 }, limits).kind,
    ).toBe("retry_with_feedback");
    expect(
      decideRecovery("gate_failed", { attempt: 3, transientRetries: 0, policyRetries: 0 }, limits).kind,
    ).toBe("escalate");
  });
  test("budget and unknown always escalate; conflict rebases", () => {
    const h = { attempt: 1, transientRetries: 0, policyRetries: 0 };
    expect(decideRecovery("budget_exhausted", h, limits).kind).toBe("escalate");
    expect(decideRecovery("unknown", h, limits).kind).toBe("escalate");
    expect(decideRecovery("conflict", h, limits).kind).toBe("retry_rebase");
    expect(decideRecovery("policy_denied", { ...h, policyRetries: 1 }, limits).kind).toBe("escalate");
  });
  test("classifies engine errors", () => {
    expect(classifyEngineError("HTTP 529 overloaded")).toBe("provider_transient");
    expect(classifyEngineError("ECONNRESET")).toBe("provider_transient");
    expect(classifyEngineError("weird")).toBe("unknown");
  });
});

describe("journal", () => {
  const mk = () => {
    const j = Journal.open(":memory:");
    j.append("r1", null, "sage", {
      type: "run.created",
      goal: "g",
      repo: "/x",
      targetBranch: "main",
      baseSha: "abc",
      runBranch: "sage/run/r1",
    });
    return j;
  };

  test("transitions are validated against current state", () => {
    const j = mk();
    j.transitionRun("r1", "PLANNING");
    expect(j.mustRun("r1").state).toBe("PLANNING");
    expect(() => j.transitionRun("r1", "MERGED")).toThrow(InvalidTransitionError);
    expect(() =>
      j.append("r1", null, "sage", { type: "run.state", from: "CREATED", to: "PLANNING" }),
    ).toThrow(/not CREATED/);
  });

  test("events table is append-only", () => {
    const j = mk();
    expect(() => j.sqlite.exec("UPDATE events SET type='x'")).toThrow(/append-only/);
    expect(() => j.sqlite.exec("DELETE FROM events")).toThrow(/append-only/);
  });

  test("steps run once; started-but-not-done steps re-run with resumed=true", async () => {
    const j = mk();
    let calls = 0;
    const r1 = await j.step("r1", null, "k", async () => ++calls);
    const r2 = await j.step("r1", null, "k", async () => ++calls);
    expect(r1).toBe(1);
    expect(r2).toBe(1);
    expect(calls).toBe(1);
    // Simulate a crash after "started" was journaled.
    j.append("r1", null, "sage", { type: "step.started", key: "k2" });
    let resumedFlag = false;
    await j.step("r1", null, "k2", async ({ resumed }) => {
      resumedFlag = resumed;
      return "ok";
    });
    expect(resumedFlag).toBe(true);
    expect(j.getStep("r1", null, "k2")?.status).toBe("done");
  });

  test("usage accumulates on run and task; rebuild reproduces projections", () => {
    const j = mk();
    j.append("r1", "t1", "sage", {
      type: "task.created",
      ord: 0,
      spec: {
        id: "t1",
        title: "ttt",
        description: "d",
        dependsOn: [],
        acceptanceCriteria: ["x"],
        filesExpected: [],
        allowedTestFiles: [],
      },
    });
    j.append("r1", "t1", "engine", {
      type: "usage",
      model: "m",
      role: "executor",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.25,
    });
    j.append("r1", "t1", "engine", {
      type: "usage",
      model: "m",
      role: "executor",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.25,
    });
    j.transitionTask("r1", "t1", "READY");
    const before = { run: j.mustRun("r1"), task: j.mustTask("r1", "t1"), steps: j.stepsFor("r1") };
    expect(before.run.costUsd).toBeCloseTo(0.5);
    expect(before.task.inputTokens).toBe(11);
    j.rebuild();
    expect(j.mustRun("r1")).toEqual(before.run);
    expect(j.mustTask("r1", "t1")).toEqual(before.task);
  });

  test("leases exclude other owners until expiry", () => {
    const j = mk();
    expect(j.acquireLease("r1", "a", 1000, 0).ok).toBe(true);
    expect(j.acquireLease("r1", "b", 1000, 500).ok).toBe(false);
    expect(j.acquireLease("r1", "b", 1000, 2000).ok).toBe(true);
    expect(j.renewLease("r1", "a", 1000)).toBe(false);
    j.releaseLease("r1", "b");
    expect(j.getLease("r1")).toBeUndefined();
  });

  test("resolveRunId accepts prefixes", () => {
    const j = mk();
    expect(j.resolveRunId("r")).toBe("r1");
    expect(j.resolveRunId("latest")).toBe("r1");
    expect(() => j.resolveRunId("zz")).toThrow();
  });
});
