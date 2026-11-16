/**
 * Wire protocol between the guard plugin (running inside OpenCode, or inside the fake engine)
 * and the SAGE orchestrator. Kept dependency-free because this file is loaded by OpenCode's
 * plugin host, where SAGE's node_modules are not resolvable. The orchestrator validates the
 * same shapes with Zod.
 */

export interface GuardRequest {
  runId: string;
  taskId: string;
  attempt: number;
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  sessionId?: string;
}

export interface GuardResponse {
  decision: "allow" | "deny";
  rule: string;
  reason: string;
}

export interface GuardEndpointConfig {
  url: string;
  token: string;
  runId: string;
  taskId: string;
  attempt: number;
  timeoutMs?: number;
}

/**
 * Ask the orchestrator whether a tool call may run. Fails CLOSED: any transport or protocol error
 * results in a deny. "ask" decisions are resolved by the orchestrator (human prompt) before it
 * responds, so the plugin only ever sees allow/deny.
 */
export async function askGuard(
  cfg: GuardEndpointConfig,
  call: { callId: string; tool: string; args: unknown; sessionId?: string },
): Promise<GuardResponse> {
  const body: GuardRequest = {
    runId: cfg.runId,
    taskId: cfg.taskId,
    attempt: cfg.attempt,
    callId: call.callId,
    tool: call.tool,
    args:
      call.args && typeof call.args === "object"
        ? (call.args as Record<string, unknown>)
        : { value: call.args },
    sessionId: call.sessionId,
  };
  try {
    const res = await fetch(`${cfg.url}/v1/guard`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 30 * 60_000),
    });
    if (!res.ok)
      return { decision: "deny", rule: "guard-unavailable", reason: `guard returned HTTP ${res.status}` };
    const json = (await res.json()) as Partial<GuardResponse>;
    if (json.decision !== "allow" && json.decision !== "deny") {
      return { decision: "deny", rule: "guard-protocol", reason: "malformed guard response" };
    }
    return { decision: json.decision, rule: String(json.rule ?? ""), reason: String(json.reason ?? "") };
  } catch (e) {
    return {
      decision: "deny",
      rule: "guard-unavailable",
      reason: `guard unreachable: ${(e as Error).message}`,
    };
  }
}
