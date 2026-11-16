import { describe, expect, test } from "bun:test";
import plugin, { askGuard, type GuardPluginContext, SageGuardDenied } from "@sage/guard-plugin";
import { GuardServer } from "../src/index.ts";

describe("guard server + plugin", () => {
  const server = new GuardServer("run-x", async (r) =>
    r.tool === "write"
      ? { decision: "deny", rule: "test", reason: "no writes" }
      : { decision: "allow", rule: "ok", reason: "" },
  ).start();
  const cfg = { url: server.url, token: server.token, runId: "run-x", taskId: "t", attempt: 1 };

  test("binds to 127.0.0.1 and requires the bearer token", async () => {
    expect(server.url.startsWith("http://127.0.0.1:")).toBe(true);
    const r = await fetch(`${server.url}/v1/health`);
    expect(r.status).toBe(401);
    const bad = await fetch(`${server.url}/v1/health`, { headers: { authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
    const ok = await fetch(`${server.url}/v1/health`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(ok.status).toBe(200);
  });

  test("allow / deny round trip; malformed and wrong-run requests are denied", async () => {
    expect((await askGuard(cfg, { callId: "1", tool: "read", args: { path: "a" } })).decision).toBe("allow");
    expect((await askGuard(cfg, { callId: "2", tool: "write", args: { path: "a" } })).decision).toBe("deny");
    expect((await askGuard({ ...cfg, runId: "other" }, { callId: "3", tool: "read", args: {} })).rule).toBe(
      "guard-protocol",
    );
    const raw = await fetch(`${server.url}/v1/guard`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}` },
      body: "{not json",
    });
    expect((await raw.json()).decision).toBe("deny");
  });

  test("fails closed when the orchestrator is unreachable or the token is wrong", async () => {
    expect(
      (await askGuard({ ...cfg, token: "wrong" }, { callId: "4", tool: "read", args: {} })).decision,
    ).toBe("deny");
    const dead = { ...cfg, url: "http://127.0.0.1:9" };
    const r = await askGuard({ ...dead, timeoutMs: 2000 }, { callId: "5", tool: "read", args: {} });
    expect(r).toMatchObject({ decision: "deny", rule: "guard-unavailable" });
  });

  test("plugin registers execute.before (throws on deny) and permission.evaluate (allow)", async () => {
    const hooks: Record<string, (e: never) => unknown> = {};
    const reg = (name: string, cb: (e: never) => unknown) => {
      hooks[name] = cb;
      return Promise.resolve({ dispose: async () => undefined });
    };
    const ctx = {
      options: { url: server.url, token: server.token, runId: "run-x", taskId: "t", attempt: 1 },
      tool: { hook: reg },
      permission: { hook: reg },
    } as unknown as GuardPluginContext;
    expect(plugin.id).toBe("sage-guard");
    const cleanup = await plugin.setup(ctx);
    const before = hooks["execute.before"] as unknown as (e: object) => Promise<void>;
    await expect(
      before({ tool: "read", sessionID: "s", id: "c1", input: { path: "x" } }),
    ).resolves.toBeUndefined();
    await expect(
      before({ tool: "write", sessionID: "s", id: "c2", input: { path: "x" } }),
    ).rejects.toBeInstanceOf(SageGuardDenied);
    const evalEvent = { sessionID: "s", action: "edit", resources: ["x"], effect: "ask" as string };
    (hooks.evaluate as unknown as (e: object) => void)(evalEvent);
    expect(evalEvent.effect).toBe("allow");
    await cleanup();
  });

  test("plugin refuses to start without its options", async () => {
    const ctx = {
      options: {},
      tool: { hook: async () => ({ dispose: async () => undefined }) },
      permission: { hook: async () => ({ dispose: async () => undefined }) },
    };
    await expect(plugin.setup(ctx as unknown as GuardPluginContext)).rejects.toThrow(/missing option/);
  });
});
