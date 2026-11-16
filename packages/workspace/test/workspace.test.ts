import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, makeRepo, tempDir } from "@sage/testkit";
import {
  changedFiles,
  commitAll,
  ensureWorktree,
  git,
  isProcessAlive,
  listWorktrees,
  removeWorktree,
  resetWorktree,
  runProcess,
  scrubEnv,
  secretNames,
} from "../src/index.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) cleanup(d);
});

describe("env scrubbing", () => {
  test("drops secrets and non-allowlisted vars, keeps PATH", () => {
    const env = scrubEnv({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      GITHUB_TOKEN: "ghp_x",
      AWS_SECRET_ACCESS_KEY: "x",
      RANDOM_VAR: "1",
      HOME: "/home/u",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.RANDOM_VAR).toBeUndefined();
    expect(env.SAGE_AGENT_CONTEXT).toBe("1");
  });
  test("explicit pass-through keeps a named key", () => {
    const env = scrubEnv({ OPENAI_API_KEY: "k", PATH: "p" }, { passThrough: ["OPENAI_API_KEY"] });
    expect(env.OPENAI_API_KEY).toBe("k");
  });
  test("secretNames reports names only", () => {
    expect(secretNames({ A_TOKEN: "v", PATH: "x" })).toEqual(["A_TOKEN"]);
  });
});

describe("process management", () => {
  test("timeout kills the whole process tree", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const pidFile = join(dir, "child.pid");
    const script = `
      const { spawn } = require("node:child_process");
      const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
      setInterval(() => {}, 1000);
    `;
    const r = await runProcess([process.execPath, "-e", script], { cwd: dir, timeoutMs: 2500 });
    expect(r.timedOut).toBe(true);
    const childPid = Number(readFileSync(pidFile, "utf8"));
    await Bun.sleep(500);
    expect(isProcessAlive(childPid)).toBe(false);
  });

  test("captures output and exit code", async () => {
    const r = await runProcess([process.execPath, "-e", "console.log('hi'); process.exit(3)"], { cwd: "." });
    expect(r.code).toBe(3);
    expect(r.stdout.trim()).toBe("hi");
  });
});

describe("worktrees", () => {
  test("ensureWorktree is idempotent; commits carry trailers and configured identity", async () => {
    const repo = await makeRepo();
    dirs.push(repo);
    const base = await git(repo, ["rev-parse", "HEAD"]);
    const wt = join(repo, ".sage", "wt", "r1", "t1");
    await ensureWorktree(repo, wt, "sage/r1/t1", base);
    await ensureWorktree(repo, wt, "sage/r1/t1", base); // second call: no error, same tree
    expect((await listWorktrees(repo)).filter((w) => w.branch === "sage/r1/t1")).toHaveLength(1);

    writeFileSync(join(wt, "src", "new.ts"), "export const x = 1;\n");
    const sha = await commitAll(wt, "sage: test", undefined, { run: "r1", task: "t1", step: "agent:1" });
    const msg = await git(wt, ["log", "-1", "--format=%B"]);
    expect(msg).toContain("Sage-Run: r1");
    expect(msg).toContain("Sage-Task: t1");
    expect(msg).toContain("Sage-Step: agent:1");
    expect(msg).not.toMatch(/Co-Authored-By/i);
    const author = await git(wt, ["log", "-1", "--format=%an <%ae>"]);
    const name = await git(repo, ["config", "user.name"]);
    expect(author.startsWith(name)).toBe(true);
    expect(await changedFiles(wt, base, sha)).toEqual(["src/new.ts"]);

    // Nothing to commit -> same sha.
    expect(await commitAll(wt, "noop", undefined, { run: "r1", step: "x" })).toBe(sha);

    // Reset discards partial work.
    writeFileSync(join(wt, "junk.txt"), "x");
    await resetWorktree(wt, base);
    expect(existsSync(join(wt, "junk.txt"))).toBe(false);
    expect(existsSync(join(wt, "src", "new.ts"))).toBe(false);

    await removeWorktree(repo, wt);
    expect(existsSync(wt)).toBe(false);
    // Target branch untouched.
    expect(await git(repo, ["rev-parse", "main"])).toBe(base);
  });
});
