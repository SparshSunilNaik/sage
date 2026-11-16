import { join } from "node:path";
import { Journal, SageConfig } from "@sage/core";
import { CALC_REPO, FakeEngine, FakeScenario, type FileMap, makeRepo, tempDir } from "@sage/testkit";
import type { z } from "zod";
import { type Asker, dbPath, Orchestrator, type OrchestratorOptions } from "../src/index.ts";

export interface Harness {
  repo: string;
  journal: Journal;
  orch: Orchestrator;
  config: SageConfig;
  logs: string[];
  logFile: string;
}

export async function harness(
  scenario: z.input<typeof FakeScenario>,
  opts: {
    files?: FileMap;
    config?: Record<string, unknown>;
    asker?: Asker;
    autoApprovePlan?: boolean;
    extra?: Partial<OrchestratorOptions>;
  } = {},
): Promise<Harness> {
  const repo = await makeRepo(opts.files ?? CALC_REPO);
  const logFile = join(tempDir("sage-log-"), "fake.log");
  const config = SageConfig.parse({
    engine: { kind: "fake" },
    retry: { backoffBaseMs: 1, backoffMaxMs: 5 },
    ...opts.config,
  });
  const journal = Journal.open(dbPath(repo));
  const logs: string[] = [];
  const orch = new Orchestrator({
    repo,
    journal,
    config,
    engine: new FakeEngine(FakeScenario.parse(scenario), logFile),
    asker: opts.asker,
    autoApprovePlan: opts.autoApprovePlan ?? true,
    log: (m) => logs.push(m),
    sleep: async () => undefined,
    ...opts.extra,
  });
  return { repo, journal, orch, config, logs, logFile };
}
