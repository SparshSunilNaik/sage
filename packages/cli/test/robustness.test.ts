import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "@sage/core";
import { dbPath, engineStateDir, worktreeRoot } from "@sage/orchestrator";
import { CALC_REPO, calcScenario, cleanup, makeRepo, task, tempDir, writeScenario } from "@sage/testkit";
import { git, isProcessAlive, listWorktrees, runProcess } from "@sage/workspace";

setDefaultTimeout(240_000);
const BIN = join(import.meta.dir, "..", "src", "bin.ts");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) cleanup(d);
});

function baseEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("SAGE_")) e[k] = v;
  return e;
}

function sage(repo: string, args: string[], env: Record<string, string> = {}) {
  return runProcess([process.execPath, BIN, "-C", repo, ...args], {
    cwd: repo,
    env: { ...baseEnv(), SAGE_NONINTERACTIVE_ASK: "deny", ...env },
    timeoutMs: 180_000,
  });
}

async function repoWith(scenario: Parameters<typeof writeScenario>[1], files = CALC_REPO) {
  const repo = await makeRepo(files);
  const aux = tempDir("sage-rob-");
  dirs.push(repo, aux);
  const sc = join(aux, "scenario.json");
  writeScenario(sc, scenario);
  expect((await sage(repo, ["init", "--fake", sc])).code).toBe(0);
  return repo;
}

const journalOf = (repo: string) => Journal.open(dbPath(repo));

describe("robustness (fake engine)", () => {
  test("two concurrent runs in the same repo do not corrupt each other", async () => {
    const repo = await repoWith(calcScenario());
    const [a, b] = await Promise.all([
      sage(repo, ["run", "first run", "--yes"]),
      sage(repo, ["run", "second run", "--yes"]),
    ]);
    expect(a.stderr).not.toContain("sage: ");
    expect(b.stderr).not.toContain("sage: ");
    expect([a.code, b.code]).toEqual([0, 0]);
    const j = journalOf(repo);
    const runs = j.listRuns();
    expect(runs).toHaveLength(2);
    for (const r of runs) {
      expect(r.state).toBe("AWAITING_MERGE_APPROVAL");
      expect(j.getTasks(r.id).map((t) => t.state)).toEqual(["PASSED", "PASSED"]);
      const src = await git(repo, ["show", `${r.runBranch}:src/math.ts`]);
      expect(src.match(/export function multiply/g)).toHaveLength(1);
      expect(src.match(/export function subtract/g)).toHaveLength(1);
      // Each run's events only reference that run's own tasks.
      const ids = new Set(j.events(r.id).flatMap((e) => (e.taskId ? [e.taskId] : [])));
      expect([...ids].sort()).toEqual(["multiply", "subtract"]);
    }
    expect(runs[0]!.runBranch).not.toBe(runs[1]!.runBranch);
    // Projections still equal a replay of the shared event log.
    const before = runs.map((r) => ({ run: j.mustRun(r.id), tasks: j.getTasks(r.id) }));
    j.rebuild();
    expect(runs.map((r) => ({ run: j.mustRun(r.id), tasks: j.getTasks(r.id) }))).toEqual(before);
    // Worktrees of both runs exist side by side.
    const wts = await listWorktrees(repo);
    for (const r of runs) expect(wts.some((w) => w.branch === `${r.runBranch}`)).toBe(true);
    j.close();
  });

  test("sage gc after an aborted run removes worktrees and leftover engine processes", async () => {
    const repo = await repoWith(calcScenario());
    const crashed = await sage(repo, ["run", "goal", "--yes"], { SAGE_CRASH_AT: "after-workspace" });
    expect(crashed.code).not.toBe(0);
    const j = journalOf(repo);
    const runId = j.resolveRunId("latest");
    j.close();
    // Simulate an engine server orphaned by the killed orchestrator.
    const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const stateDir = engineStateDir(repo, runId, "multiply-1");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "engine.pid"), String(orphan.pid));
    expect(existsSync(worktreeRoot(repo, runId))).toBe(true);

    expect((await sage(repo, ["abort", runId])).code).toBe(0);
    const gc = await sage(repo, ["gc"]);
    expect(gc.code).toBe(0);
    expect(gc.stdout).toContain(`killed leftover engine process ${orphan.pid}`);
    await Bun.sleep(500);
    expect(isProcessAlive(orphan.pid!)).toBe(false);
    expect(existsSync(worktreeRoot(repo, runId))).toBe(false);
    expect((await listWorktrees(repo)).map((w) => w.branch)).toEqual(["main"]);
  });

  test("uncommitted changes in the target repo are never touched", async () => {
    const repo = await repoWith(calcScenario());
    const localEdit = `${CALC_REPO["src/math.ts"]}// my local, uncommitted edit\n`;
    writeFileSync(join(repo, "src", "math.ts"), localEdit);
    writeFileSync(join(repo, "notes.txt"), "untracked notes\n");
    const statusBefore = await git(repo, ["status", "--porcelain"]);
    expect((await sage(repo, ["run", "goal", "--yes"])).code).toBe(0);
    expect((await sage(repo, ["approve", "latest"])).code).toBe(0);
    const m = await sage(repo, ["merge", "latest"]);
    expect(m.code).toBe(1); // refuses to fast-forward over a dirty tracked file
    expect(m.stderr).toContain("uncommitted changes");
    expect(readFileSync(join(repo, "src", "math.ts"), "utf8")).toBe(localEdit);
    expect(readFileSync(join(repo, "notes.txt"), "utf8")).toBe("untracked notes\n");
    expect(await git(repo, ["status", "--porcelain"])).toBe(statusBefore);
  });

  test("a target repo path containing spaces works end to end", async () => {
    const base = join(tempDir("sage-sp-"), "my project dir");
    mkdirSync(base, { recursive: true });
    dirs.push(base);
    const prev = process.env.SAGE_TEST_TMP;
    process.env.SAGE_TEST_TMP = base;
    let repo: string;
    try {
      repo = await repoWith(calcScenario());
    } finally {
      if (prev === undefined) delete process.env.SAGE_TEST_TMP;
      else process.env.SAGE_TEST_TMP = prev;
    }
    expect(repo).toContain(" ");
    const r = await sage(repo, ["run", "goal with spaces", "--yes"]);
    expect(r.stderr).not.toContain("sage: ");
    expect(r.stdout).toContain("AWAITING_MERGE_APPROVAL");
    expect((await sage(repo, ["approve", "latest"])).code).toBe(0);
    expect((await sage(repo, ["merge", "latest"])).code).toBe(0);
    expect(await git(repo, ["show", "main:src/math.ts"])).toContain("subtract");
  });

  test("files with very long paths (> 260 chars) inside a worktree are created, verified and merged", async () => {
    const deep = `src/${"a-fairly-long-directory-name-for-testing/".repeat(7)}deep-module.ts`;
    const sc = calcScenario();
    (sc.tasks as Record<string, { attempts: { actions: unknown[] }[] }>).multiply!.attempts[0]!.actions.push({
      tool: "write",
      args: { path: deep, content: "export const deep = true;\n" },
    });
    const repo = await repoWith(sc);
    const r = await sage(repo, ["run", "goal", "--yes"]);
    expect(r.stderr).not.toContain("sage: ");
    expect(r.stdout).toContain("AWAITING_MERGE_APPROVAL");
    const j = journalOf(repo);
    const run = j.mustRun(j.resolveRunId("latest"));
    const wtPath = join(worktreeRoot(repo, run.id), "multiply", ...deep.split("/"));
    expect(wtPath.length).toBeGreaterThan(260);
    expect(await git(repo, ["show", `${run.runBranch}:${deep}`])).toContain("deep = true");
    j.close();
  });

  test("sage abort during a pending policy 'ask' stops the run promptly", async () => {
    const repo = await repoWith({
      planner: [{ summary: "s", tasks: [task("t", "needs an unknown command")] }],
      tasks: {
        t: {
          attempts: [
            {
              actions: [
                { tool: "shell", args: { command: "python script.py" } },
                { tool: "write", args: { path: "src/after.ts", content: "export {};\n" } },
              ],
            },
          ],
        },
      },
    });
    // No SAGE_NONINTERACTIVE_ASK: the run waits for a human decision in the journal.
    const child = spawn(process.execPath, [BIN, "-C", repo, "run", "goal", "--yes"], {
      cwd: repo,
      env: baseEnv(),
      stdio: "ignore",
      windowsHide: true,
    });
    const exited = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
    let pending: string | undefined;
    for (let i = 0; i < 80 && !pending; i++) {
      await Bun.sleep(250);
      if (!existsSync(dbPath(repo))) continue;
      const j = journalOf(repo);
      const runs = j.listRuns();
      pending = runs[0]
        ? j.approvals(runs[0].id).find((a) => a.kind === "tool" && a.status === "pending")?.id
        : undefined;
      j.close();
    }
    expect(pending).toBeDefined();
    const t0 = Date.now();
    expect((await sage(repo, ["abort", "latest"])).code).toBe(0);
    const code = await Promise.race([exited, Bun.sleep(20_000).then(() => "timeout" as const)]);
    expect(code).not.toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(20_000);
    const j = journalOf(repo);
    const runId = j.resolveRunId("latest");
    expect(j.mustRun(runId).state).toBe("ABORTED");
    expect(j.approvals(runId).every((a) => a.status !== "pending")).toBe(true);
    expect(j.getTasks(runId)[0]!.state).not.toBe("PASSED");
    expect(j.approvals(runId).some((a) => a.kind === "merge")).toBe(false);
    const finals = j
      .events(runId)
      .flatMap((e) => (e.payload.type === "policy.decision" ? [e.payload.final] : []));
    expect(finals.every((f) => f === "deny")).toBe(true);
    j.close();
  });

  test("an invalid sage.config.jsonc gives a clear error naming the file and the key", async () => {
    const repo = await makeRepo();
    dirs.push(repo);
    writeFileSync(join(repo, "sage.config.jsonc"), `{ "concurrency": "two", "retry": { "maxAttempts": 0 } }`);
    const bad = await sage(repo, ["status"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("sage.config.jsonc is invalid");
    expect(bad.stderr).toContain("concurrency");
    expect(bad.stderr).toContain("retry.maxAttempts");
    writeFileSync(join(repo, "sage.config.jsonc"), `{ "concurrency": 2,, }`);
    const syntax = await sage(repo, ["status"]);
    expect(syntax.code).toBe(1);
    expect(syntax.stderr).toContain("is not valid JSONC");
  });
});
