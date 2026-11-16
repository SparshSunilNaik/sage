import type { SageConfig } from "@sage/core";
import type { PolicyContext } from "./policy.ts";

export * from "./policy.ts";
export * from "./shell.ts";

export function policyContext(
  cfg: SageConfig,
  worktree: string,
  allowedTestFiles: readonly string[],
): PolicyContext {
  return {
    worktree,
    protectedPaths: cfg.policy.protectedPaths,
    allowedTestFiles,
    commandAllow: cfg.policy.commandAllow,
    commandDeny: cfg.policy.commandDeny,
    networkCommands: cfg.policy.networkCommands,
    allowNetwork: cfg.policy.allowNetwork,
    unknownCommand: cfg.policy.unknownCommand,
    unknownTool: cfg.policy.unknownTool,
  };
}
