/**
 * SAGE guard plugin for OpenCode 2.x (V2 plugin API, `@opencode/plugin` 2.3.0).
 *
 * Shape verified against the fork's source (see docs/adr/0001-engine-integration.md):
 *  - default export `{ id, setup(ctx) }`              packages/plugin/src/promise/plugin.ts
 *  - ctx.tool.hook("execute.before", e) — throw = deny packages/plugin/src/promise/tool.ts
 *  - ctx.permission.hook("evaluate", e) — set e.effect packages/plugin/src/promise/permission.ts
 *
 * The types below are structural copies of the parts we use so that this package has no
 * dependency on OpenCode's internals.
 */
import { askGuard, type GuardEndpointConfig } from "./protocol.ts";

interface ExecuteBefore {
  tool: string;
  readonly sessionID: string;
  readonly id: string;
  input: unknown;
}

interface PermissionEvaluation {
  readonly sessionID: string;
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
  effect: "allow" | "deny" | "ask";
  message?: string;
}

type Hook<T> = (
  name: string,
  cb: (e: T) => Promise<void> | void,
) => Promise<{ dispose: () => Promise<void> }>;

export interface GuardPluginContext {
  readonly options: Readonly<Record<string, unknown>>;
  readonly tool: { readonly hook: Hook<ExecuteBefore> };
  readonly permission: { readonly hook: Hook<PermissionEvaluation> };
}

export class SageGuardDenied extends Error {
  constructor(reason: string) {
    super(`SAGE policy denied this tool call: ${reason}`);
    this.name = "SageGuardDenied";
  }
}

export function readOptions(o: Readonly<Record<string, unknown>>): GuardEndpointConfig {
  const s = (k: string) => {
    const v = o[k];
    if (typeof v !== "string" || !v) throw new Error(`sage-guard: missing option '${k}'`);
    return v;
  };
  return {
    url: s("url"),
    token: s("token"),
    runId: s("runId"),
    taskId: s("taskId"),
    attempt: Number(o.attempt ?? 1),
  };
}

export async function setup(ctx: GuardPluginContext): Promise<() => Promise<void>> {
  const cfg = readOptions(ctx.options);
  const regs = [
    // The hard gate: every tool call (built-in, MCP, codemode) passes through here first.
    await ctx.tool.hook("execute.before", async (e) => {
      const r = await askGuard(cfg, { callId: e.id, tool: e.tool, args: e.input, sessionId: e.sessionID });
      if (r.decision !== "allow") throw new SageGuardDenied(`${r.rule}: ${r.reason}`);
    }),
    // OpenCode's own permission prompts would wait for a human on an OpenCode client that does not
    // exist in headless mode. SAGE already decided in execute.before (with the full arguments), so
    // permission evaluation is resolved to "allow" here. This hook must not throw (ADR 0001).
    await ctx.permission.hook("evaluate", (e) => {
      e.effect = "allow";
      e.message = "decided by SAGE guard (execute.before)";
    }),
  ];
  return async () => {
    for (const r of regs) await r.dispose();
  };
}

const plugin = { id: "sage-guard", setup };
export default plugin;
