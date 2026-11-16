import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelCall } from "@sage/core";
import { GuardServer } from "@sage/orchestrator";
import { cleanup, tempDir } from "@sage/testkit";
import { scrubEnv } from "@sage/workspace";
import { binArgv, OpencodeEngine, parseModel } from "../src/index.ts";

setDefaultTimeout(60_000);
const STUB = join(import.meta.dir, "stub-opencode.ts");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) cleanup(d);
});

describe("OpencodeEngine against a stub 2.3.0 server", () => {
  test("loads the guard plugin, routes every tool call through SAGE, reports usage", async () => {
    const wt = tempDir("sage-oc-");
    dirs.push(wt);
    const seen: string[] = [];
    const guard = new GuardServer("run-1", async (r) => {
      seen.push(`${r.tool}:${String(r.args.path)}`);
      return String(r.args.path).includes("secret")
        ? { decision: "deny", rule: "test", reason: "nope" }
        : { decision: "allow", rule: "ok", reason: "" };
    }).start();
    const script = [
      { tool: "write", input: { path: "ok.ts", content: "export {};\n" } },
      { tool: "write", input: { path: "secret.txt", content: "x" } },
    ];
    const engine = new OpencodeEngine({
      bin: `"${process.execPath}" "${STUB}"`,
      startupTimeoutMs: 20_000,
      turnTimeoutMs: 20_000,
      pricing: {},
    });
    const session = await engine.start({
      runId: "run-1",
      taskId: "t1",
      role: "executor",
      cwd: wt,
      env: scrubEnv(process.env, { set: { STUB_SCRIPT: JSON.stringify(script) } }),
      guard: { url: guard.url, token: guard.token },
      model: "stub/model-1",
      stateDir: join(wt, ".state"),
      attempt: 1,
    });
    const calls: ModelCall[] = [];
    const turn = await session.prompt("do it", { onModelCall: (c) => calls.push(c) });
    await session.close();
    guard.stop();

    expect(turn.status).toBe("completed");
    expect(turn.text).toBe("stub turn finished");
    expect(seen).toEqual(["write:ok.ts", "write:secret.txt"]);
    expect(readFileSync(join(wt, "ok.ts"), "utf8")).toBe("export {};\n");
    expect(existsSync(join(wt, "secret.txt"))).toBe(false);
    expect(turn.tools.map((t) => t.status)).toEqual(["completed", "error"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      model: "stub/model-1",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.001,
    });
  });

  test("budget hard stop interrupts the turn", async () => {
    const wt = tempDir("sage-oc-");
    dirs.push(wt);
    const guard = new GuardServer("run-2", async () => ({
      decision: "allow",
      rule: "ok",
      reason: "",
    })).start();
    const engine = new OpencodeEngine({
      bin: `"${process.execPath}" "${STUB}"`,
      startupTimeoutMs: 20_000,
      turnTimeoutMs: 20_000,
      pricing: {},
    });
    const script = [{ tool: "write", input: { path: "a.ts", content: "" } }];
    const s = await engine.start({
      runId: "run-2",
      taskId: "t",
      role: "executor",
      cwd: wt,
      env: scrubEnv(process.env, { set: { STUB_SCRIPT: JSON.stringify(script) } }),
      guard: { url: guard.url, token: guard.token },
      stateDir: join(wt, ".state"),
      attempt: 1,
    });
    const turn = await s.prompt("x", {
      onModelCall: () => {
        throw new Error("budget exhausted: test");
      },
    });
    await s.close();
    guard.stop();
    expect(turn.status).toBe("aborted");
    expect(turn.error).toContain("budget exhausted");
  });

  test("refuses to start when the guard plugin cannot load (fail closed)", async () => {
    const wt = tempDir("sage-oc-");
    dirs.push(wt);
    const engine = new OpencodeEngine({
      bin: `"${process.execPath}" "${STUB}"`,
      startupTimeoutMs: 20_000,
      turnTimeoutMs: 20_000,
      pricing: {},
      guardPluginDir: join(wt, "does-not-exist"),
    });
    await expect(
      engine.start({
        runId: "r",
        taskId: "t",
        role: "executor",
        cwd: wt,
        env: scrubEnv(process.env),
        guard: { url: "http://127.0.0.1:9", token: "x" },
        stateDir: join(wt, ".state"),
        attempt: 1,
      }),
    ).rejects.toThrow(/sage-guard plugin is not active/);
  });

  test("helpers", () => {
    expect(parseModel("anthropic/claude-sonnet-5-5")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-5-5",
    });
    expect(parseModel("openrouter/a/b")).toEqual({ providerID: "openrouter", id: "a/b" });
    expect(() => parseModel("nomodel")).toThrow();
    expect(binArgv(`"C:\\Program Files\\bun.exe" run x.ts`)).toEqual([
      "C:\\Program Files\\bun.exe",
      "run",
      "x.ts",
    ]);
  });
});
