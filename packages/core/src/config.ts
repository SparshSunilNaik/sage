import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const CONFIG_FILE = "sage.config.jsonc";

const Gate = z.object({
  name: z.string().min(1),
  command: z.array(z.string().min(1)).min(1),
  parser: z.enum(["bun-test", "tsc", "biome", "exit-code"]).default("exit-code"),
  timeoutMs: z.number().int().positive().default(300_000),
  required: z.boolean().default(true),
});
export type GateConfig = z.infer<typeof Gate>;

const Limit = z.object({
  maxUsd: z.number().nonnegative().default(5),
  maxTokens: z.number().int().nonnegative().default(2_000_000),
});

export const DEFAULT_PROTECTED = [
  "**/*.test.*",
  "**/*.spec.*",
  "test/**",
  "tests/**",
  "**/__tests__/**",
  ".github/**",
  ".gitlab-ci.yml",
  "sage.config.jsonc",
  "AGENTS.md",
  "bunfig.toml",
  "biome.json",
];

export const DEFAULT_COMMAND_ALLOW = [
  "bun",
  "bunx",
  "node",
  "tsc",
  "biome",
  "ls",
  "dir",
  "cat",
  "type",
  "head",
  "tail",
  "echo",
  "pwd",
  "mkdir",
  "touch",
  "cp",
  "mv",
  "grep",
  "rg",
  "find",
  "wc",
  "sort",
  "diff",
  "git",
  "true",
];

export const DEFAULT_COMMAND_DENY = [
  "sudo",
  "su",
  "rm -rf /",
  "env",
  "printenv",
  "set",
  "export",
  "sage",
  "opencode",
  "shutdown",
  "reboot",
  "format",
  "mkfs",
  "dd",
  "chmod",
  "chown",
  "reg",
  "regedit",
  "taskkill",
  "kill",
  "powershell",
  "pwsh",
  "cmd",
  "bash",
  "sh",
  "eval",
];

/** Commands that are able to reach the network; denied by default. */
export const DEFAULT_NETWORK_COMMANDS = [
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ftp",
  "ping",
  "nslookup",
  "Invoke-WebRequest",
  "Invoke-RestMethod",
  "iwr",
  "irm",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "pip",
  "pip3",
  "gh",
  "git push",
  "git pull",
  "git fetch",
  "git clone",
  "git remote",
  "git submodule",
  "bun add",
  "bun install",
  "bun i",
  "bun x",
  "bun update",
  "bun publish",
  "bun pm",
  "bunx",
];

export const SageConfig = z.object({
  /** Branch that `sage merge` updates. Default: the branch checked out when the run starts. */
  targetBranch: z.string().optional(),
  concurrency: z.number().int().min(1).max(8).default(2),
  engine: z
    .object({
      kind: z.enum(["opencode", "fake"]).default("opencode"),
      /** "provider/model", passed through to OpenCode. */
      model: z.string().optional(),
      plannerModel: z.string().optional(),
      opencode: z
        .object({
          /** Path to the opencode binary. Default: `opencode` on PATH. */
          bin: z.string().default("opencode"),
          startupTimeoutMs: z.number().int().positive().default(60_000),
          turnTimeoutMs: z.number().int().positive().default(900_000),
          /** Env vars (beyond the scrubbed base env) passed to the engine process, e.g. provider keys. */
          passEnv: z.array(z.string()).default([]),
          /** Price table (USD per 1M tokens) used when the engine does not report a cost. */
          pricing: z
            .record(
              z.string(),
              z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }),
            )
            .default({}),
        })
        .prefault({}),
      fake: z.object({ scenario: z.string().optional() }).prefault({}),
    })
    .prefault({}),
  gates: z
    .array(Gate)
    .default([
      { name: "test", command: ["bun", "test"], parser: "bun-test", timeoutMs: 300_000, required: true },
    ]),
  policy: z
    .object({
      protectedPaths: z.array(z.string()).default(DEFAULT_PROTECTED),
      commandAllow: z.array(z.string()).default(DEFAULT_COMMAND_ALLOW),
      commandDeny: z.array(z.string()).default(DEFAULT_COMMAND_DENY),
      networkCommands: z.array(z.string()).default(DEFAULT_NETWORK_COMMANDS),
      allowNetwork: z.boolean().default(false),
      /** Decision for commands that are on neither list. */
      unknownCommand: z.enum(["ask", "deny", "allow"]).default("ask"),
      /** Decision for unknown tools (e.g. MCP tools). */
      unknownTool: z.enum(["ask", "deny", "allow"]).default("ask"),
      askTimeoutMs: z.number().int().positive().default(300_000),
    })
    .prefault({}),
  budget: z
    .object({
      run: Limit.prefault({ maxUsd: 5, maxTokens: 2_000_000 }),
      task: Limit.prefault({ maxUsd: 1, maxTokens: 500_000 }),
    })
    .prefault({}),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).max(10).default(3),
      maxTransientRetries: z.number().int().min(0).max(10).default(3),
      backoffBaseMs: z.number().int().min(0).default(2_000),
      backoffMaxMs: z.number().int().min(0).default(60_000),
      maxPolicyRetries: z.number().int().min(0).max(5).default(1),
      maxPlanAttempts: z.number().int().min(1).max(5).default(3),
    })
    .prefault({}),
  trace: z
    .object({
      /** Capture prompt/response text in spans. Off by default; secrets are redacted either way. */
      captureContent: z.boolean().default(false),
    })
    .prefault({}),
});
export type SageConfig = z.infer<typeof SageConfig>;

/** Strip // and /* *\/ comments and trailing commas, respecting string literals. */
export function stripJsonc(src: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseConfig(text: string): SageConfig {
  const raw: unknown = JSON.parse(stripJsonc(text));
  return SageConfig.parse(raw);
}

export function loadConfig(repo: string): SageConfig {
  const p = join(repo, CONFIG_FILE);
  if (!existsSync(p)) return SageConfig.parse({});
  return parseConfig(readFileSync(p, "utf8"));
}

export const CONFIG_TEMPLATE = `// SAGE configuration. Validated with Zod at load time.
{
  // Branch updated by \`sage merge\`. Defaults to the branch checked out when a run starts.
  // "targetBranch": "main",
  "concurrency": 2,
  "engine": {
    // "opencode" (real engine) or "fake" (deterministic, for tests/evals)
    "kind": "opencode",
    // "model": "anthropic/claude-sonnet-5-5",
    "opencode": { "bin": "opencode", "passEnv": [] }
  },
  "gates": [
    { "name": "test", "command": ["bun", "test"], "parser": "bun-test" }
    // { "name": "typecheck", "command": ["bunx", "tsc", "--noEmit"], "parser": "tsc" }
  ],
  "budget": {
    "run": { "maxUsd": 5, "maxTokens": 2000000 },
    "task": { "maxUsd": 1, "maxTokens": 500000 }
  },
  "retry": { "maxAttempts": 3 }
}
`;
