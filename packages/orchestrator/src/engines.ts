import { isAbsolute, join } from "node:path";
import type { EngineAdapter, SageConfig } from "@sage/core";
import { OpencodeEngine } from "@sage/engine-opencode";
import { FakeEngine } from "@sage/testkit";

/** Build the configured engine. Only this function knows which concrete engines exist. */
export function makeEngine(cfg: SageConfig, repo: string): EngineAdapter {
  if (cfg.engine.kind === "fake") {
    const sc = process.env.SAGE_FAKE_SCENARIO ?? cfg.engine.fake.scenario;
    if (!sc)
      throw new Error("engine.kind is 'fake' but no engine.fake.scenario (or SAGE_FAKE_SCENARIO) is set");
    return new FakeEngine(isAbsolute(sc) ? sc : join(repo, sc));
  }
  return new OpencodeEngine({
    bin: cfg.engine.opencode.bin,
    startupTimeoutMs: cfg.engine.opencode.startupTimeoutMs,
    turnTimeoutMs: cfg.engine.opencode.turnTimeoutMs,
    pricing: cfg.engine.opencode.pricing,
    isolateState: cfg.engine.opencode.isolateState,
  });
}
