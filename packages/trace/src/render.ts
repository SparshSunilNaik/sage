import type { SpanRecord } from "./trace.ts";

const num = (v: unknown) => (typeof v === "number" ? v : 0);

function label(s: SpanRecord): string {
  const a = s.attributes;
  const ms = Date.parse(s.endTime) - Date.parse(s.startTime);
  const dur = ms > 0 ? ` ${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}` : "";
  const err = s.status === "error" ? " ✗" : "";
  switch (s.name) {
    case "sage.run":
      return `run ${a["sage.run.id"]} — goal: ${a["sage.goal"]} [${a["sage.run.state"] ?? ""}]${dur}`;
    case "sage.plan":
      return `plan (${a["sage.plan.tasks"] ?? "?"} tasks, attempt ${a["sage.plan.attempt"] ?? 1})${err}${dur}`;
    case "sage.task":
      return `task ${a["sage.task.id"]}: ${a["sage.task.title"] ?? ""} → ${a["sage.task.state"] ?? ""}${err}${dur}`;
    case "invoke_agent":
      return `invoke_agent ${a["gen_ai.agent.name"] ?? ""} attempt ${a["sage.attempt"] ?? ""} (${a["gen_ai.request.model"] ?? "?"})${err}${dur}`;
    case "chat":
      return `chat ${a["gen_ai.request.model"]} in=${num(a["gen_ai.usage.input_tokens"])} out=${num(a["gen_ai.usage.output_tokens"])} $${num(a["sage.cost_usd"]).toFixed(4)}`;
    case "execute_tool":
      return `execute_tool ${a["gen_ai.tool.name"]} [${a["sage.policy.decision"] ?? "?"}${a["sage.policy.rule"] ? `:${a["sage.policy.rule"]}` : ""}] ${a["sage.tool.summary"] ?? ""}`;
    case "sage.diff":
      return `diff ${a["sage.diff.sha"] ?? ""}: ${(a["sage.diff.files"] as string[] | undefined)?.join(", ") || "(no changes)"}`;
    case "sage.verify":
      return `verify → ${a["sage.verify.passed"] ? "PASS" : "FAIL"}${dur}`;
    case "sage.gate":
      return `gate ${a["sage.gate.name"]}: ${a["sage.gate.passed"] ? "pass" : "FAIL"} — ${a["sage.gate.summary"] ?? ""}`;
    case "sage.approval":
      return `approval ${a["sage.approval.kind"]}: ${a["sage.approval.decision"]} by ${a["sage.approval.actor"]}`;
    case "sage.merge":
      return `merge ${a["sage.task.id"] ?? a["sage.merge.target"] ?? ""} → ${a["sage.merge.sha"] ?? ""}${err}`;
    case "sage.recovery":
      return `recovery ${a["sage.failure.class"]} → ${a["sage.recovery.action"]}`;
    default:
      return `${s.name}${err}${dur}`;
  }
}

/** Render spans as an indented tree (goal → plan → task → model/tool calls → diffs → gates → approvals). */
export function renderTree(spans: readonly SpanRecord[], rootSpanId: string): string {
  const children = new Map<string, SpanRecord[]>();
  for (const s of spans) {
    const p = s.parentSpanId ?? "";
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(s);
  }
  for (const list of children.values()) list.sort((a, b) => a.startTime.localeCompare(b.startTime));
  const lines: string[] = [];
  const walk = (id: string, prefix: string) => {
    const kids = children.get(id) ?? [];
    kids.forEach((k, i) => {
      const last = i === kids.length - 1;
      lines.push(`${prefix}${last ? "└─ " : "├─ "}${label(k)}`);
      walk(k.spanId, `${prefix}${last ? "   " : "│  "}`);
    });
  };
  const roots = spans.filter((s) => s.spanId === rootSpanId);
  // The root span is written when a run finishes; synthesize a header if the run is still open.
  const root = roots.at(-1);
  lines.push(root ? label(root) : `run (in progress) trace ${rootSpanId}`);
  walk(rootSpanId, "");
  return lines.join("\n");
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  modelCalls: number;
  toolCalls: number;
  denied: number;
}

export function summarize(spans: readonly SpanRecord[]): UsageSummary {
  const s: UsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    modelCalls: 0,
    toolCalls: 0,
    denied: 0,
  };
  for (const sp of spans) {
    if (sp.name === "chat") {
      s.modelCalls++;
      s.inputTokens += num(sp.attributes["gen_ai.usage.input_tokens"]);
      s.outputTokens += num(sp.attributes["gen_ai.usage.output_tokens"]);
      s.costUsd += num(sp.attributes["sage.cost_usd"]);
    }
    if (sp.name === "execute_tool") {
      s.toolCalls++;
      if (sp.attributes["sage.policy.final"] === "deny") s.denied++;
    }
  }
  return s;
}
