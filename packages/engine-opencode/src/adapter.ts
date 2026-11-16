import type { EngineAdapter, EngineSession, EngineStartOptions } from "@sage/core";

export interface OpencodeEngineOptions {
  bin: string;
  startupTimeoutMs: number;
  turnTimeoutMs: number;
  pricing: Record<string, { input: number; output: number }>;
}

/** STUB (replaced later in this session): OpenCode adapter. */
export class OpencodeEngine implements EngineAdapter {
  readonly name = "opencode";
  constructor(readonly opts: OpencodeEngineOptions) {}
  async version(): Promise<string> {
    throw new Error("OpencodeEngine not implemented yet");
  }
  async start(_o: EngineStartOptions): Promise<EngineSession> {
    throw new Error("OpencodeEngine not implemented yet");
  }
}
