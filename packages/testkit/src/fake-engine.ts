import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  EngineAdapter,
  EngineSession,
  EngineStartOptions,
  EngineToolEvent,
  ModelCall,
  PromptOptions,
  TurnResult,
} from "@sage/core";
import { askGuard } from "@sage/guard-plugin";
import { runProcess } from "@sage/workspace";
import { z } from "zod";

/**
 * Deterministic, scripted engine. Used by the whole default test suite and by `sage eval` in fake
 * mode: zero LLM calls, zero cost. Every scripted tool call goes through the SAME guard HTTP
 * endpoint the real OpenCode plugin uses, so policy enforcement is exercised end to end.
 */

const Action = z.union([
  z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) }),
  z.object({ sleepMs: z.number().int().nonnegative() }),
]);
export type FakeAction = z.infer<typeof Action>;

const Attempt = z.object({
  actions: z.array(Action).default([]),
  text: z.string().default("Done."),
  /** Simulated engine/provider failure for this attempt (e.g. "HTTP 529 overloaded"). */
  error: z.string().optional(),
  /** Tokens per simulated model call. */
  inputTokens: z.number().int().nonnegative().default(1200),
  outputTokens: z.number().int().nonnegative().default(300),
});
export type FakeAttempt = z.infer<typeof Attempt>;

export const FakeScenario = z.object({
  model: z.string().default("fake/scripted-1"),
  /** USD per 1M tokens. */
  pricing: z.object({ input: z.number(), output: z.number() }).default({ input: 3, output: 15 }),
  /** Planner responses, one per planning attempt (last repeats). Objects are JSON-encoded. */
  planner: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).default([]),
  tasks: z.record(z.string(), z.object({ attempts: z.array(Attempt).min(1) })).default({}),
  default: z.object({ attempts: z.array(Attempt).min(1) }).optional(),
});
export type FakeScenario = z.infer<typeof FakeScenario>;

export function loadScenario(path: string): FakeScenario {
  return FakeScenario.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function writeScenario(path: string, s: z.input<typeof FakeScenario>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 2));
}

function summarize(tool: string, args: Record<string, unknown>): string {
  const p = args.path ?? args.filePath ?? args.url;
  if (typeof p === "string") return `${tool} ${p}`;
  if (typeof args.command === "string") return `${tool} \`${args.command.slice(0, 120)}\``;
  return tool;
}

class FakeSession implements EngineSession {
  private prompts = 0;
  private toolSeq = 0;
  constructor(
    private readonly s: FakeScenario,
    private readonly o: EngineStartOptions,
    private readonly logFile: string | undefined,
  ) {}

  private call(inputTokens: number, outputTokens: number): ModelCall {
    return {
      model: this.s.model,
      inputTokens,
      outputTokens,
      costUsd: (inputTokens * this.s.pricing.input + outputTokens * this.s.pricing.output) / 1_000_000,
    };
  }

  async prompt(_text: string, opts: PromptOptions = {}): Promise<TurnResult> {
    this.prompts++;
    if (this.logFile) {
      appendFileSync(
        this.logFile,
        `${JSON.stringify({ runId: this.o.runId, taskId: this.o.taskId, role: this.o.role, attempt: this.o.attempt, prompt: this.prompts })}\n`,
      );
    }
    const calls: ModelCall[] = [];
    const tools: EngineToolEvent[] = [];
    const record = (c: ModelCall): TurnResult | null => {
      calls.push(c);
      try {
        opts.onModelCall?.(c);
      } catch (e) {
        return { status: "aborted", text: "", error: (e as Error).message, calls, tools };
      }
      return null;
    };

    if (this.o.role === "planner") {
      const list = this.s.planner;
      const r = list[Math.min(this.prompts, list.length) - 1];
      const aborted = record(this.call(2500, 600));
      if (aborted) return aborted;
      if (r === undefined)
        return { status: "error", text: "", error: "fake scenario has no planner response", calls, tools };
      return { status: "completed", text: typeof r === "string" ? r : JSON.stringify(r), calls, tools };
    }

    const script = this.s.tasks[this.o.taskId] ?? this.s.default;
    if (!script)
      return {
        status: "error",
        text: "",
        error: `fake scenario has no script for task '${this.o.taskId}'`,
        calls,
        tools,
      };
    const att = script.attempts[Math.min(this.o.attempt, script.attempts.length) - 1]!;

    for (const a of att.actions) {
      if ("sleepMs" in a) {
        await Bun.sleep(a.sleepMs);
        continue;
      }
      const aborted = record(this.call(att.inputTokens, att.outputTokens));
      if (aborted) return aborted;
      if (opts.signal?.aborted) return { status: "aborted", text: "", error: "aborted", calls, tools };
      const callId = `call_${this.o.taskId}_${this.o.attempt}_${++this.toolSeq}`;
      const g = await askGuard(
        { ...this.o.guard, runId: this.o.runId, taskId: this.o.taskId, attempt: this.o.attempt },
        { callId, tool: a.tool, args: a.args },
      );
      if (g.decision !== "allow") {
        tools.push({ callId, tool: a.tool, status: "error", summary: `denied: ${g.rule}` });
        continue; // like a real agent, carry on after a denied call
      }
      const res = await this.execute(a.tool, a.args);
      tools.push({
        callId,
        tool: a.tool,
        status: res.ok ? "completed" : "error",
        summary: summarize(a.tool, a.args),
      });
    }
    const aborted = record(this.call(att.inputTokens, att.outputTokens));
    if (aborted) return aborted;
    if (att.error) return { status: "error", text: "", error: att.error, calls, tools };
    return { status: "completed", text: att.text, calls, tools };
  }

  private abs(p: unknown): string {
    const s = String(p ?? "");
    return isAbsolute(s) ? s : resolve(this.o.cwd, s);
  }

  /** Perform an ALLOWED tool call. Only reached after the guard said allow. */
  private async execute(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean }> {
    try {
      switch (tool) {
        case "write": {
          const p = this.abs(args.path);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, String(args.content ?? ""));
          return { ok: true };
        }
        case "edit": {
          const p = this.abs(args.path);
          const cur = readFileSync(p, "utf8");
          const old = String(args.oldString ?? "");
          if (!cur.includes(old)) return { ok: false };
          writeFileSync(p, cur.replace(old, String(args.newString ?? "")));
          return { ok: true };
        }
        case "read":
          return { ok: existsSync(this.abs(args.path)) };
        case "shell": {
          const cmd = String(args.command ?? "");
          const argv =
            process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", cmd] : ["/bin/sh", "-c", cmd];
          const r = await runProcess(argv, { cwd: this.o.cwd, env: this.o.env, timeoutMs: 120_000 });
          return { ok: r.code === 0 };
        }
        default:
          return { ok: true };
      }
    } catch {
      return { ok: false };
    }
  }

  async close(): Promise<void> {}
}

export class FakeEngine implements EngineAdapter {
  readonly name = "fake";
  private readonly scenario: FakeScenario;
  constructor(
    scenario: FakeScenario | string,
    /** Optional JSONL file recording every prompt (used to detect duplicated work after resume). */
    private readonly logFile = process.env.SAGE_FAKE_LOG,
  ) {
    this.scenario = typeof scenario === "string" ? loadScenario(scenario) : scenario;
  }
  async version(): Promise<string> {
    return "fake-1";
  }
  async start(o: EngineStartOptions): Promise<EngineSession> {
    return new FakeSession(this.scenario, o, this.logFile);
  }
}

export function readFakeLog(
  file: string,
): { runId: string; taskId: string; role: string; attempt: number }[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export const fakeLogPath = (dir: string) => join(dir, "fake-engine.log");
