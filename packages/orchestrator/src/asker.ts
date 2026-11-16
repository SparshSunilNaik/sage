import type { Journal } from "@sage/core";

export interface AskRequest {
  runId: string;
  taskId: string;
  approvalId: string;
  tool: string;
  summary: string;
  reason: string;
}

/**
 * Resolves policy "ask" decisions with a human. Returns true for allow.
 * The orchestrator journals the request before asking and the decision after.
 */
export interface Asker {
  ask(req: AskRequest): Promise<boolean>;
}

/** Non-interactive default: never allow what policy wanted a human to see. */
export class DenyAsker implements Asker {
  async ask(): Promise<boolean> {
    return false;
  }
}

/** Test helper: answers from a predicate. */
export class ScriptedAsker implements Asker {
  readonly asked: AskRequest[] = [];
  constructor(private readonly answer: (r: AskRequest) => boolean) {}
  async ask(r: AskRequest): Promise<boolean> {
    this.asked.push(r);
    return this.answer(r);
  }
}

/**
 * Waits for a human to decide via `sage approve <run> --request <id>` / `sage reject ...` from another
 * terminal (the decision lands in the journal). Times out to deny.
 */
export class JournalAsker implements Asker {
  constructor(
    private readonly journal: Journal,
    private readonly timeoutMs: number,
    private readonly notify: (msg: string) => void,
  ) {}
  async ask(r: AskRequest): Promise<boolean> {
    this.notify(
      `policy asks for approval [${r.approvalId}] ${r.taskId}: ${r.summary} (${r.reason}).\n` +
        `  approve: sage approve ${r.runId} --request ${r.approvalId}   deny: sage reject ${r.runId} --request ${r.approvalId}`,
    );
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const a = this.journal.getApproval(r.approvalId);
      if (a && a.status !== "pending") return a.status === "approved";
      await Bun.sleep(500);
    }
    return false;
  }
}

/** Serialises interactive prompts so that concurrent tasks do not interleave questions. */
export class SerialAsker implements Asker {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly inner: Asker) {}
  ask(r: AskRequest): Promise<boolean> {
    const p = this.chain.then(() => this.inner.ask(r));
    this.chain = p.catch(() => undefined);
    return p;
  }
}
