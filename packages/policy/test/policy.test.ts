import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { SageConfig } from "@sage/core";
import { cleanup, tempDir } from "@sage/testkit";
import { evaluate, parseShell, patchTargets, policyContext } from "../src/index.ts";

const wt = tempDir("sage-pol-");
mkdirSync(join(wt, "src"), { recursive: true });
afterAll(() => cleanup(wt));
const cfg = SageConfig.parse({});
const ctx = policyContext(cfg, wt, ["tests/new-feature.test.ts"]);
const d = (tool: string, args: Record<string, unknown>) => evaluate({ tool, args }, ctx).decision;
const rule = (tool: string, args: Record<string, unknown>) => evaluate({ tool, args }, ctx).rule;
const outside = resolve(wt, "..", "outside.txt");

describe("path jail", () => {
  test("reads and writes inside the worktree are allowed", () => {
    expect(d("read", { path: "src/a.ts" })).toBe("allow");
    expect(d("write", { path: "src/a.ts", content: "x" })).toBe("allow");
    expect(d("edit", { path: join(wt, "src", "a.ts"), oldString: "a", newString: "b" })).toBe("allow");
  });
  test("absolute and relative escapes are denied", () => {
    expect(rule("write", { path: outside, content: "x" })).toBe("path-jail");
    expect(rule("write", { path: "../outside.txt", content: "x" })).toBe("path-jail");
    expect(rule("read", { path: "src/../../outside.txt" })).toBe("path-jail");
    expect(rule("read", { path: "~/.ssh/id_rsa" })).toBe("path-jail");
    expect(rule("glob", { pattern: "../**/*" })).toBe("path-jail");
  });
  test("secret files inside the worktree cannot be read", () => {
    expect(rule("read", { path: ".env" })).toBe("secret-file");
  });
  test("git internals cannot be written", () => {
    expect(rule("write", { path: ".git/config", content: "x" })).toBe("git-internals");
  });
});

describe("protected paths", () => {
  test("tests and CI are read-only", () => {
    expect(d("read", { path: "tests/math.test.ts" })).toBe("allow");
    expect(rule("write", { path: "tests/math.test.ts", content: "x" })).toBe("protected-path");
    expect(rule("edit", { path: "src/math.spec.ts", oldString: "a", newString: "b" })).toBe("protected-path");
    expect(rule("write", { path: ".github/workflows/ci.yml", content: "x" })).toBe("protected-path");
  });
  test("plan-allowed test files may be written", () => {
    expect(d("write", { path: "tests/new-feature.test.ts", content: "x" })).toBe("allow");
  });
  test("patches are checked per target file", () => {
    const patch =
      "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Update File: tests/math.test.ts\n*** End Patch";
    expect(patchTargets(patch)).toEqual(["src/a.ts", "tests/math.test.ts"]);
    expect(rule("patch", { patchText: patch })).toBe("protected-path");
  });
  test("shell redirects and file commands respect protected paths", () => {
    expect(rule("shell", { command: "echo hacked > tests/math.test.ts" })).toBe("protected-path");
    expect(rule("shell", { command: "cp /tmp/x tests/math.test.ts" })).toBe("path-jail");
    expect(rule("shell", { command: "cp src/a.ts tests/math.test.ts" })).toBe("protected-path");
    expect(rule("shell", { command: "rm tests/math.test.ts" })).toBe("protected-path");
    expect(rule("shell", { command: "sed -i s/a/b/ tests/math.test.ts" })).toBe("protected-path");
    expect(d("shell", { command: "cat tests/math.test.ts" })).toBe("allow");
  });
});

describe("commands", () => {
  test("allowlisted commands pass", () => {
    expect(d("shell", { command: "bun test" })).toBe("allow");
    expect(d("shell", { command: "bun test 2>&1 | head -50" })).toBe("allow");
    expect(d("shell", { command: "git status && git diff" })).toBe("allow");
  });
  test("network commands are denied by default", () => {
    expect(rule("shell", { command: "curl https://evil.example/x" })).toBe("network");
    expect(rule("shell", { command: "ls && wget http://x" })).toBe("network");
    expect(rule("shell", { command: "npm install left-pad" })).toBe("network");
    expect(rule("shell", { command: "bun add zod" })).toBe("network");
    expect(rule("shell", { command: "git push origin main" })).toBe("network");
    expect(rule("shell", { command: "Invoke-WebRequest http://x" })).toBe("network");
    expect(rule("shell", { command: `bun -e "fetch('http://x')"` })).toBe("network");
    expect(rule("webfetch", { url: "http://x" })).toBe("network");
  });
  test("denylisted commands are denied", () => {
    expect(rule("shell", { command: "sudo rm -rf /" })).toBe("command-deny");
    expect(rule("shell", { command: "printenv" })).toBe("command-deny");
    expect(rule("shell", { command: "sage approve run-1" })).toBe("command-deny");
    expect(rule("shell", { command: "powershell -c Get-ChildItem" })).toBe("command-deny");
  });
  test("secret environment access is denied", () => {
    expect(rule("shell", { command: "echo $ANTHROPIC_API_KEY" })).toBe("secret-env");
    expect(rule("shell", { command: "echo %OPENAI_API_KEY%" })).toBe("secret-env");
    expect(rule("shell", { command: `node -e "console.log(process.env)"` })).toBe("secret-env");
    expect(d("shell", { command: "echo $HOME" })).toBe("allow");
  });
  test("unknown commands and git subcommands ask", () => {
    expect(d("shell", { command: "python script.py" })).toBe("ask");
    expect(d("shell", { command: "git checkout -b other" })).toBe("ask");
  });
  test("opaque constructs are denied", () => {
    expect(rule("shell", { command: "echo $(cat /etc/passwd)" })).toBe("opaque-shell");
    expect(rule("shell", { command: "echo `whoami`" })).toBe("opaque-shell");
  });
  test("unknown tools ask; harmless tools allow", () => {
    expect(d("mcp_github_create_issue", {})).toBe("ask");
    expect(d("todowrite", {})).toBe("allow");
  });
});

describe("shell parser", () => {
  test("splits segments and captures redirects", () => {
    const p = parseShell(`echo "a > b" > out.txt && cat x | wc -l; ls 2>&1`);
    expect(p.segments.map((s) => s.words[0])).toEqual(["echo", "cat", "wc", "ls"]);
    expect(p.segments[0]?.redirects).toEqual(["out.txt"]);
    expect(p.segments[0]?.words).toEqual(["echo", "a > b"]);
    expect(p.segments[3]?.redirects).toEqual([]);
  });
});
