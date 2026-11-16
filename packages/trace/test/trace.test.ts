import { describe, expect, test } from "bun:test";
import { MemoryExporter, redact, renderTree, summarize, Tracer } from "../src/index.ts";

describe("trace", () => {
  test("redacts secrets in attributes", () => {
    expect(redact("key sk-ant-api03-abcdefghijklmnop end")).toBe("key [REDACTED] end");
    expect(redact("Authorization: Bearer abc.def.ghi123")).toContain("[REDACTED]");
    expect(redact('{"api_key": "supersecretvalue"}')).not.toContain("supersecretvalue");
    expect(redact("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("[REDACTED]");
  });

  test("builds a tree with GenAI attribute names and sums usage", () => {
    const ex = new MemoryExporter();
    const t = new Tracer("run-1", ex);
    const task = t.start("sage.task", {
      "sage.task.id": "a",
      "sage.task.title": "do a",
      "sage.task.state": "PASSED",
    });
    const agent = t.start(
      "invoke_agent",
      { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "executor", "sage.attempt": 1 },
      task.spanId,
    );
    t.event(
      "chat",
      {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "fake/model",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20,
        "sage.cost_usd": 0.01,
      },
      agent.spanId,
    );
    t.event(
      "execute_tool",
      {
        "gen_ai.tool.name": "write",
        "sage.policy.decision": "deny",
        "sage.policy.final": "deny",
        "sage.tool.summary": "x",
      },
      agent.spanId,
    );
    agent.end();
    task.end();
    t.start("sage.run", { "sage.run.id": "run-1", "sage.goal": "g" }, "", t.rootSpanId).end();
    const tree = renderTree(ex.spans, t.rootSpanId);
    expect(tree).toContain("task a: do a");
    expect(tree).toContain("chat fake/model in=100 out=20");
    expect(tree).toContain("execute_tool write [deny]");
    const s = summarize(ex.spans);
    expect(s).toMatchObject({ inputTokens: 100, outputTokens: 20, modelCalls: 1, toolCalls: 1, denied: 1 });
  });

  test("content capture is off by default", () => {
    const t = new Tracer("r", new MemoryExporter());
    expect(t.content("hello")).toBeUndefined();
    expect(new Tracer("r", new MemoryExporter(), true).content("sk-ant-api03-aaaaaaaaaaaa")).toBe(
      "[REDACTED]",
    );
  });
});
