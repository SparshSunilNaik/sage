import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(180_000);

import { join } from "node:path";
import { Journal } from "@sage/core";
import { dbPath } from "@sage/orchestrator";
import { calcScenario, cleanup, makeRepo, readFakeLog, tempDir, writeScenario } from "@sage/testkit";
import { git, runProcess } from "@sage/workspace";

const BIN = join(import.meta.dir, "..", "src", "bin.ts");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) cleanup(d);
});

async function setup() {
  const repo = await makeRepo();
  const aux = tempDir("sage-cli-");
  dirs.push(repo, aux);
  const scenario = join(aux, "scenario.json");
  writeScenario(scenario, calcScenario());
  const log = join(aux, "fake.log");
  return { repo, scenario, log };
}

function sage(repo: string, args: string[], env: Record<string, string> = {}) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("SAGE_")) base[k] = v;
  }
  return runProcess([process.execPath, BIN, "-C", repo, ...args], {
    cwd: repo,
    env: { ...base, SAGE_NONINTERACTIVE_ASK: "deny", ...env },
    timeoutMs: 120_000,
  });
}

describe("sage CLI", () => {
  test("init, run --yes, status, trace, diff, approve, merge, gc, doctor", async () => {
    const { repo, scenario, log } = await setup();
    expect((await sage(repo, ["init", "--fake", scenario])).code).toBe(0);
    const run = await sage(repo, ["run", "add multiply and subtract", "--yes"], { SAGE_FAKE_LOG: log });
    expect(run.stderr).not.toContain("sage: ");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("AWAITING_MERGE_APPROVAL");

    const st = JSON.parse((await sage(repo, ["status", "latest", "--json"])).stdout);
    expect(st.run.state).toBe("AWAITING_MERGE_APPROVAL");
    expect(st.tasks.map((t: { state: string }) => t.state)).toEqual(["PASSED", "PASSED"]);

    const trace = await sage(repo, ["trace", "latest"]);
    expect(trace.stdout).toContain("goal: add multiply and subtract");
    expect(trace.stdout).toContain("execute_tool");
    expect(trace.stdout).toContain("gate test: pass");

    const diff = await sage(repo, ["diff", "latest", "--stat"]);
    expect(diff.stdout).toContain("src/math.ts");

    // Merge without approval is refused.
    expect((await sage(repo, ["merge", "latest"])).code).toBe(1);
    // An agent-context process cannot approve.
    const agentApprove = await sage(repo, ["approve", "latest"], { SAGE_AGENT_CONTEXT: "1" });
    expect(agentApprove.code).toBe(1);
    expect(agentApprove.stderr).toContain("agent session");

    expect((await sage(repo, ["approve", "latest"])).code).toBe(0);
    const m = await sage(repo, ["merge", "latest"]);
    expect(m.code).toBe(0);
    expect(await git(repo, ["show", "main:src/math.ts"])).toContain("subtract");

    const gc = await sage(repo, ["gc"]);
    expect(gc.code).toBe(0);
    const doctor = await sage(repo, ["doctor"]);
    expect(doctor.stdout).toContain("git identity");
    expect(doctor.stdout).not.toMatch(/sk-[A-Za-z0-9]{10}/);
  });

  test("plan command stops for approval; reject aborts", async () => {
    const { repo, scenario } = await setup();
    await sage(repo, ["init", "--fake", scenario]);
    const p = await sage(repo, ["plan", "add multiply and subtract"]);
    expect(p.stdout).toContain("AWAITING_PLAN_APPROVAL");
    expect(p.stdout).toContain("[multiply]");
    expect((await sage(repo, ["reject", "latest", "--reason", "no"])).code).toBe(0);
    expect(JSON.parse((await sage(repo, ["status", "latest", "--json"])).stdout).run.state).toBe("ABORTED");
  });
});

const CRASH_POINTS = [
  "after-plan",
  "after-workspace",
  "mid-agent",
  "after-agent",
  "after-verify",
  "after-merge",
  "before-merge-approval",
];

describe("crash and resume", () => {
  // Every kill point is repeated (default 3x) to catch flakiness; override with SAGE_CRASH_REPEAT.
  const REPEAT = Number(process.env.SAGE_CRASH_REPEAT ?? 3);
  for (let rep = 1; rep <= REPEAT; rep++)
    for (const point of CRASH_POINTS) {
      test(`kill -9 at '${point}' (round ${rep}) then resume continues without duplicated side effects`, async () => {
        const { repo, scenario, log } = await setup();
        await sage(repo, ["init", "--fake", scenario]);
        const crashed = await sage(repo, ["run", "add multiply and subtract", "--yes"], {
          SAGE_FAKE_LOG: log,
          SAGE_CRASH_AT: point,
        });
        expect(crashed.code).not.toBe(0); // the process was killed
        const j = Journal.open(dbPath(repo));
        const runId = j.resolveRunId("latest");
        expect(j.mustRun(runId).state).not.toBe("AWAITING_MERGE_APPROVAL");
        j.close();

        // --yes restates the human pre-approval: if the crash happened before it was journaled, resume asks again.
        const resumed = await sage(repo, ["resume", runId, "--yes"], { SAGE_FAKE_LOG: log });
        expect(resumed.stderr).not.toContain("sage: ");
        expect(resumed.code).toBe(0);

        const j2 = Journal.open(dbPath(repo));
        const run = j2.mustRun(runId);
        expect(run.state).toBe("AWAITING_MERGE_APPROVAL");
        expect(j2.getTasks(runId).map((t) => [t.id, t.state, t.attempt])).toEqual([
          ["multiply", "PASSED", 1],
          ["subtract", "PASSED", 1],
        ]);
        // Completed steps are never repeated: one step.done per key.
        const doneKeys = j2
          .events(runId)
          .flatMap((e) => (e.payload.type === "step.done" ? [`${e.taskId ?? ""}/${e.payload.key}`] : []));
        expect(new Set(doneKeys).size).toBe(doneKeys.length);
        // The agent is re-invoked only if it was killed mid-turn (its step was not complete).
        const execs = readFakeLog(log).filter((l) => l.role === "executor");
        const perTask = (id: string) => execs.filter((l) => l.taskId === id).length;
        expect(perTask("multiply")).toBe(point === "mid-agent" ? 2 : 1);
        expect(perTask("subtract")).toBe(1);
        const planners = readFakeLog(log).filter((l) => l.role === "planner").length;
        expect(planners).toBe(1);
        // No duplicated git side effects: exactly one merge per task and no double-applied edits.
        const merges = await git(repo, [
          "log",
          "--merges",
          "--format=%s",
          `${run.baseSha}..${run.runBranch}`,
        ]);
        expect(merges.split("\n").filter(Boolean)).toHaveLength(2);
        const src = await git(repo, ["show", `${run.runBranch}:src/math.ts`]);
        expect(src.match(/export function multiply/g)).toHaveLength(1);
        expect(src.match(/export function subtract/g)).toHaveLength(1);
        // Target branch untouched.
        expect(await git(repo, ["rev-parse", "main"])).toBe(run.baseSha);
        j2.close();
      });
    }
});
