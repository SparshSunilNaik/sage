import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type EngineAdapter,
  type EngineSession,
  type EngineStartOptions,
  type EngineToolEvent,
  type ModelCall,
  type PromptOptions,
  randomToken,
  type TurnResult,
} from "@sage/core";
import { killTree, runProcess } from "@sage/workspace";
import { type Message, OpencodeHttp, type Tokens } from "./http.ts";

export interface OpencodeEngineOptions {
  /** Executable plus optional leading args, e.g. "opencode" or "bun run --cwd <fork>/packages/cli src/index.ts". */
  bin: string;
  startupTimeoutMs: number;
  turnTimeoutMs: number;
  /** USD per 1M tokens by "provider/model", used only if OpenCode reports no cost. */
  pricing: Record<string, { input: number; output: number }>;
  /** Directory of the guard plugin (default: this repo's packages/guard-plugin). */
  guardPluginDir?: string;
}

export const GUARD_PLUGIN_DIR = join(import.meta.dir, "..", "..", "guard-plugin", "opencode");

export function parseModel(m: string | undefined): { providerID: string; id: string } | undefined {
  if (!m) return undefined;
  const i = m.indexOf("/");
  if (i <= 0) throw new Error(`model must be "provider/model", got '${m}'`);
  return { providerID: m.slice(0, i), id: m.slice(i + 1) };
}

/** Split a configured binary string into argv (supports `bun run ... src/index.ts` for running from source). */
export function binArgv(bin: string): string[] {
  return bin.match(/"[^"]*"|\S+/g)?.map((s) => s.replace(/^"|"$/g, "")) ?? [bin];
}

function tokenCall(
  model: string,
  t: Tokens | undefined,
  cost: number | undefined,
  pricing: OpencodeEngineOptions["pricing"],
): ModelCall {
  const input = (t?.input ?? 0) + (t?.cache.read ?? 0) + (t?.cache.write ?? 0);
  const output = (t?.output ?? 0) + (t?.reasoning ?? 0);
  const p = pricing[model];
  const est = p ? (input * p.input + output * p.output) / 1_000_000 : 0;
  return { model, inputTokens: input, outputTokens: output, costUsd: cost && cost > 0 ? cost : est };
}

/** Start `opencode serve --stdio` and read the URL it prints. */
async function startServer(
  o: EngineStartOptions,
  opts: OpencodeEngineOptions,
  password: string,
): Promise<{ child: ChildProcess; url: string }> {
  mkdirSync(o.stateDir, { recursive: true });
  const guardDir = opts.guardPluginDir ?? GUARD_PLUGIN_DIR;
  const config = {
    plugins: [
      {
        package: pathToFileURL(guardDir).href,
        options: {
          url: o.guard.url,
          token: o.guard.token,
          runId: o.runId,
          taskId: o.taskId,
          attempt: o.attempt,
        },
      },
    ],
  };
  const [cmd, ...pre] = binArgv(opts.bin);
  const child = spawn(cmd!, [...pre, "serve", "--stdio", "--hostname", "127.0.0.1"], {
    cwd: o.cwd,
    env: {
      ...o.env,
      OPENCODE_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      // Repo-supplied OpenCode config is untrusted (it could disable the guard or add tools).
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DB: join(o.stateDir, "opencode.db"),
    },
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString("utf8")).slice(-4000);
  });
  const url = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error(`opencode did not start in ${opts.startupTimeoutMs}ms: ${stderr}`)),
      opts.startupTimeoutMs,
    );
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`opencode exited early (${code}): ${stderr}`));
    });
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      for (const line of buf.split(/\r?\n/)) {
        const m =
          line.match(/^\s*\{.*"url"\s*:\s*"([^"]+)".*\}\s*$/) ?? line.match(/server listening on (\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!.replace(/\/$/, ""));
          return;
        }
      }
    });
  });
  return { child, url };
}

class OpencodeSession implements EngineSession {
  constructor(
    private readonly http: OpencodeHttp,
    private readonly child: ChildProcess,
    private readonly sessionId: string,
    private readonly model: string,
    private readonly opts: OpencodeEngineOptions,
  ) {}

  async prompt(text: string, po: PromptOptions = {}): Promise<TurnResult> {
    const calls: ModelCall[] = [];
    const models = new Map<string, string>();
    let abortReason: string | undefined;
    let guardBypass = false;
    const sse = new AbortController();
    const waitCtl = new AbortController();
    const stop = (reason: string) => {
      if (abortReason) return;
      abortReason = reason;
      void this.http.interrupt(this.sessionId);
    };
    const onEvent = (e: { type: string; data: Record<string, unknown> }) => {
      if (e.data.sessionID !== this.sessionId) return;
      if (e.type === "session.step.started") {
        const m = e.data.model as { providerID?: string; id?: string } | undefined;
        if (m?.providerID && m.id) models.set(String(e.data.assistantMessageID), `${m.providerID}/${m.id}`);
      } else if (e.type === "session.step.ended" || e.type === "session.step.failed") {
        const call = tokenCall(
          models.get(String(e.data.assistantMessageID)) ?? this.model,
          e.data.tokens as Tokens | undefined,
          e.data.cost as number | undefined,
          this.opts.pricing,
        );
        calls.push(call);
        try {
          po.onModelCall?.(call);
        } catch (err) {
          stop((err as Error).message); // budget hard stop: interrupt the session now
        }
      } else if (e.type === "permission.asked") {
        // The guard plugin resolves every evaluation to allow after SAGE decided. A permission prompt
        // reaching us means the guard is not in the loop: refuse (fail closed) and fail the turn.
        guardBypass = true;
        void this.http.replyPermission(this.sessionId, String(e.data.id), "reject", "SAGE guard not active");
      }
    };
    const types = ["session.step.started", "session.step.ended", "session.step.failed", "permission.asked"];
    const sub = this.http.subscribe(types, onEvent, sse.signal).catch(() => undefined);
    const timeout = setTimeout(
      () => stop(`turn timed out after ${po.timeoutMs ?? this.opts.turnTimeoutMs}ms`),
      po.timeoutMs ?? this.opts.turnTimeoutMs,
    );
    po.signal?.addEventListener("abort", () => stop("aborted"));
    try {
      await Bun.sleep(100); // let the SSE subscription attach before the turn starts
      await this.http.prompt(this.sessionId, text);
      await this.http.wait(this.sessionId, waitCtl.signal);
    } catch (e) {
      return { status: "error", text: "", error: (e as Error).message, calls, tools: [] };
    } finally {
      clearTimeout(timeout);
      await Bun.sleep(200); // drain trailing step events
      sse.abort();
      await sub;
    }
    const msgs = (await this.http.messages(this.sessionId)).data;
    const { text: out, tools, error } = summarizeMessages(msgs);
    // If SSE missed usage, fall back to per-message usage.
    if (calls.length === 0) {
      for (const m of msgs.filter((x) => x.type === "assistant")) {
        const mm = m.model ? `${m.model.providerID}/${m.model.id}` : this.model;
        calls.push(tokenCall(mm, m.tokens, m.cost, this.opts.pricing));
        try {
          po.onModelCall?.(calls.at(-1)!);
        } catch (err) {
          abortReason ??= (err as Error).message;
        }
      }
    }
    if (abortReason) return { status: "aborted", text: out, error: abortReason, calls, tools };
    if (guardBypass)
      return {
        status: "error",
        text: out,
        error: "tool permission prompt reached SAGE: guard plugin not active",
        calls,
        tools,
      };
    if (error) return { status: "error", text: out, error, calls, tools };
    return { status: "completed", text: out, calls, tools };
  }

  async close(): Promise<void> {
    try {
      this.child.stdin?.end(); // --stdio servers exit when stdin closes
    } catch {
      /* ignore */
    }
    await Bun.sleep(300);
    if (this.child.exitCode === null && this.child.pid) killTree(this.child.pid);
  }
}

export function summarizeMessages(msgs: Message[]): {
  text: string;
  tools: EngineToolEvent[];
  error?: string;
} {
  const tools: EngineToolEvent[] = [];
  let text = "";
  let error: string | undefined;
  for (const m of msgs) {
    if (m.type === "assistant") {
      for (const c of m.content ?? []) {
        if (c.type === "text" && "text" in c && typeof c.text === "string") text = c.text;
        if (c.type === "tool" && "name" in c) {
          const st = (c as { state: { status: string } }).state.status;
          tools.push({
            callId: String((c as { id: string }).id),
            tool: String(c.name),
            status: st === "completed" ? "completed" : "error",
            summary: String(c.name),
          });
        }
      }
      if (m.error) error = typeof m.error === "string" ? m.error : JSON.stringify(m.error).slice(0, 500);
    }
    if (m.type === "idle") {
      if (m.outcome === "failed") error ??= m.error ? JSON.stringify(m.error).slice(0, 500) : "turn failed";
      else if (m.outcome === "succeeded") error = undefined;
    }
  }
  return { text, tools, error };
}

export class OpencodeEngine implements EngineAdapter {
  readonly name = "opencode";
  constructor(readonly opts: OpencodeEngineOptions) {}

  async version(): Promise<string> {
    const [cmd, ...pre] = binArgv(this.opts.bin);
    const r = await runProcess([cmd!, ...pre, "--version"], { cwd: process.cwd(), timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`cannot run '${this.opts.bin} --version': ${r.stderr.trim()}`);
    return (r.stdout.trim().split(/\s+/).pop() ?? "").replace(/^v/, "");
  }

  async start(o: EngineStartOptions): Promise<EngineSession> {
    const password = randomToken();
    const { child, url } = await startServer(o, this.opts, password);
    const http = new OpencodeHttp(url, password);
    try {
      const deadline = Date.now() + this.opts.startupTimeoutMs;
      for (;;) {
        try {
          await http.info();
          break;
        } catch (e) {
          if (Date.now() > deadline) throw e;
          await Bun.sleep(250);
        }
      }
      // Fail closed: refuse to run an agent unless the guard plugin is loaded and active.
      // Plugins load lazily the first time a location is used: the first listing can be empty.
      let plugins = (await http.plugins(o.cwd)).data;
      while (plugins.length === 0 && Date.now() < deadline) {
        await Bun.sleep(250);
        plugins = (await http.plugins(o.cwd)).data;
      }
      const guard = plugins.find((p) => p.id === "sage-guard");
      if (guard?.state.status !== "active") {
        throw new Error(
          `sage-guard plugin is not active in OpenCode (${JSON.stringify(guard?.state ?? "missing")})`,
        );
      }
      const session = await http.createSession({
        title: `sage ${o.runId} ${o.taskId} #${o.attempt}`,
        agent: o.role === "planner" ? "plan" : "build",
        model: parseModel(o.model),
        location: { directory: o.cwd },
        // Every permission evaluation reaches the guard plugin's evaluate hook (no deny rules here,
        // which would short-circuit it; ADR 0001). The plugin's execute.before hook is the hard gate.
        permissions: [{ action: "*", resource: "*", effect: "ask" }],
      });
      return new OpencodeSession(http, child, session.data.id, o.model ?? "opencode/default", this.opts);
    } catch (e) {
      if (child.pid) killTree(child.pid);
      throw e;
    }
  }
}
