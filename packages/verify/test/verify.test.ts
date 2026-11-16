import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROTECTED } from "@sage/core";
import { cleanup, makeRepo } from "@sage/testkit";
import { commitAll, git, scrubEnv } from "@sage/workspace";
import { parseBunTest, parseTsc, protectedViolations, verifyTask } from "../src/index.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) cleanup(d);
});
const gates = [
  { name: "test", command: ["bun", "test"], parser: "bun-test" as const, timeoutMs: 60_000, required: true },
];

describe("parsers", () => {
  test("bun test summary", () => {
    expect(parseBunTest(" 3 pass\n 0 fail\n", 0)).toMatchObject({ passed: true, summary: "3 pass, 0 fail" });
    expect(parseBunTest(" 2 pass\n 1 fail\n", 1).passed).toBe(false);
    expect(parseBunTest("no tests found", 1)).toMatchObject({ passed: false, summary: "no tests ran" });
  });
  test("tsc", () => {
    expect(parseTsc("a.ts(1,1): error TS2322: x\nb.ts(2,2): error TS2339: y", 2).counts.errors).toBe(2);
    expect(parseTsc("", 0).passed).toBe(true);
  });
  test("protected violations", () => {
    expect(
      protectedViolations(["src/a.ts", "tests/a.test.ts", "tests/b.test.ts"], DEFAULT_PROTECTED, [
        "tests/b.test.ts",
      ]),
    ).toEqual(["tests/a.test.ts"]);
  });
});

describe("verifyTask", () => {
  test("passes on green gates, fails on red gates and on tampering", async () => {
    const repo = await makeRepo();
    dirs.push(repo);
    const base = await git(repo, ["rev-parse", "HEAD"]);
    const env = scrubEnv(process.env);
    const ok = await verifyTask({
      worktree: repo,
      baseSha: base,
      gates,
      env,
      protectedPaths: DEFAULT_PROTECTED,
      allowedTestFiles: [],
    });
    expect(ok.passed).toBe(true);
    expect(ok.gates[0]?.summary).toBe("1 pass, 0 fail");

    writeFileSync(
      join(repo, "src", "math.ts"),
      "export function add(a: number, b: number) { return a - b; }\n",
    );
    await commitAll(repo, "break", undefined, { run: "r", step: "s" });
    const red = await verifyTask({
      worktree: repo,
      baseSha: base,
      gates,
      env,
      protectedPaths: DEFAULT_PROTECTED,
      allowedTestFiles: [],
    });
    expect(red.passed).toBe(false);
    expect(red.gates[0]?.outputTail).toContain("fail");

    // "Fix" it by weakening the test: gates pass, but the tamper check rejects the task.
    writeFileSync(
      join(repo, "tests", "math.test.ts"),
      `import { test } from "bun:test";\ntest("add", () => {});\n`,
    );
    await commitAll(repo, "cheat", undefined, { run: "r", step: "s" });
    const cheat = await verifyTask({
      worktree: repo,
      baseSha: base,
      gates,
      env,
      protectedPaths: DEFAULT_PROTECTED,
      allowedTestFiles: [],
    });
    expect(cheat.gates[0]?.passed).toBe(true);
    expect(cheat.violations).toEqual(["tests/math.test.ts"]);
    expect(cheat.passed).toBe(false);
  });
});
