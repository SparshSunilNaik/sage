import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { matchesAny, toPosix } from "@sage/core";
import { envReferences, parseShell, programName } from "./shell.ts";

export type Decision = "allow" | "deny" | "ask";

export interface PolicyDecision {
  decision: Decision;
  /** Stable rule identifier, e.g. "path-jail", "protected-path", "network". */
  rule: string;
  reason: string;
}

export interface PolicyContext {
  worktree: string;
  protectedPaths: readonly string[];
  /** Protected files this task may modify (from the approved plan). */
  allowedTestFiles: readonly string[];
  commandAllow: readonly string[];
  commandDeny: readonly string[];
  networkCommands: readonly string[];
  allowNetwork: boolean;
  unknownCommand: Decision;
  unknownTool: Decision;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

const SECRET_VAR = /(KEY|TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL|AUTH|COOKIE|PRIVATE|SAGE_GUARD)/i;
const SECRET_FILES = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/.npmrc",
  "**/.netrc",
  "**/auth.json",
];
const READ_TOOLS = new Set(["read", "glob", "grep", "list", "ls", "view", "lsp"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "patch", "apply_patch"]);
const SHELL_TOOLS = new Set(["shell", "bash"]);
const NETWORK_TOOLS = new Set(["webfetch", "websearch", "fetch", "codesearch"]);
const HARMLESS_TOOLS = new Set(["todowrite", "todoread", "question", "skill", "subagent", "task", "invalid"]);
const GIT_SAFE = new Set([
  "status",
  "diff",
  "log",
  "show",
  "add",
  "rm",
  "mv",
  "ls-files",
  "grep",
  "rev-parse",
  "blame",
  "restore",
]);
const WRITE_CMDS = new Set([
  "cp",
  "mv",
  "touch",
  "mkdir",
  "rm",
  "rmdir",
  "tee",
  "del",
  "copy",
  "move",
  "ren",
  "sed",
  "truncate",
  "ln",
]);
const INLINE_CODE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c"]);

const allow = (rule: string, reason: string): PolicyDecision => ({ decision: "allow", rule, reason });
const deny = (rule: string, reason: string): PolicyDecision => ({ decision: "deny", rule, reason });

/** Resolve the deepest existing ancestor through symlinks so a link cannot smuggle a path out. */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return p;
    rest.unshift(cur.slice(parent.length).replace(/^[\\/]/, ""));
    cur = parent;
  }
  try {
    return resolve(realpathSync.native(cur), ...rest);
  } catch {
    return p;
  }
}

export interface PathCheck {
  inside: boolean;
  /** Repo-relative POSIX path when inside the worktree. */
  rel: string;
  abs: string;
}

export function checkPath(worktree: string, p: string): PathCheck {
  const expanded = p.startsWith("~")
    ? resolve(process.env.HOME ?? process.env.USERPROFILE ?? "/", p.slice(1).replace(/^[\\/]/, ""))
    : p;
  const abs = realish(resolve(worktree, expanded));
  const root = realish(resolve(worktree));
  const rel = relative(root, abs);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  return { inside, rel: toPosix(rel), abs };
}

function pathArgs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ["path", "filePath", "file_path", "file", "workdir", "cwd", "directory", "dir"]) {
    const v = args[k];
    if (typeof v === "string" && v.length) out.push(v);
  }
  return out;
}

/** Extract target files from an OpenCode/Codex-style patch or a unified diff. */
export function patchTargets(patch: string): string[] {
  const out = new Set<string>();
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.add(m[1]!.trim());
  for (const m of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) out.add(m[1]!.trim());
  for (const m of patch.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(.+)$/gm)) {
    const f = m[1]!.trim();
    if (f !== "/dev/null") out.add(f);
  }
  return [...out];
}

function writeCheck(ctx: PolicyContext, target: string): PolicyDecision | null {
  const pc = checkPath(ctx.worktree, target);
  if (!pc.inside) return deny("path-jail", `write outside the task worktree: ${target}`);
  if (pc.rel === ".git" || pc.rel.startsWith(".git/"))
    return deny("git-internals", `write to git internals: ${target}`);
  if (matchesAny(pc.rel, ctx.protectedPaths) && !ctx.allowedTestFiles.some((a) => toPosix(a) === pc.rel)) {
    return deny(
      "protected-path",
      `'${pc.rel}' is protected (tests/CI/config are read-only unless the plan allows them)`,
    );
  }
  return null;
}

function readCheck(ctx: PolicyContext, target: string): PolicyDecision | null {
  const pc = checkPath(ctx.worktree, target);
  if (!pc.inside) return deny("path-jail", `access outside the task worktree: ${target}`);
  if (matchesAny(pc.rel, SECRET_FILES))
    return deny("secret-file", `access to a secret-bearing file: ${pc.rel}`);
  return null;
}

function listed(words: string[], list: readonly string[]): string | undefined {
  const prog = programName(words[0] ?? "");
  const two = `${prog} ${words[1] ?? ""}`.trim();
  return list.find((e) => {
    const n = e.toLowerCase();
    return n === prog || n === two;
  });
}

/** Evaluate a tool call. Pure apart from resolving symlinks on disk. */
export function evaluate(call: ToolCall, ctx: PolicyContext): PolicyDecision {
  const tool = call.tool.toLowerCase();
  const args = call.args;

  if (NETWORK_TOOLS.has(tool)) {
    return ctx.allowNetwork
      ? allow("network", "network allowed by config")
      : deny("network", `network tool '${tool}' is disabled`);
  }

  if (READ_TOOLS.has(tool)) {
    for (const p of pathArgs(args)) {
      const r = readCheck(ctx, p);
      if (r) return r;
    }
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    if (tool === "glob" && pattern && (isAbsolute(pattern) || pattern.split(/[\\/]/).includes(".."))) {
      return deny("path-jail", `glob pattern escapes the worktree: ${pattern}`);
    }
    return allow("read", "read inside worktree");
  }

  if (WRITE_TOOLS.has(tool)) {
    const targets = pathArgs(args);
    const patch =
      typeof args.patchText === "string" ? args.patchText : typeof args.patch === "string" ? args.patch : "";
    if (patch) targets.push(...patchTargets(patch));
    if (targets.length === 0) return deny("malformed", `${tool} call without a target path`);
    for (const t of targets) {
      const r = writeCheck(ctx, t);
      if (r) return r;
    }
    return allow("write", "write inside worktree to an unprotected path");
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command.trim()) return deny("malformed", "empty shell command");
    for (const w of pathArgs(args)) {
      const pc = checkPath(ctx.worktree, w);
      if (!pc.inside) return deny("path-jail", `workdir outside the task worktree: ${w}`);
    }
    return evaluateShell(command, ctx);
  }

  if (HARMLESS_TOOLS.has(tool)) return allow("harmless", `tool '${tool}' has no direct side effects`);

  return { decision: ctx.unknownTool, rule: "unknown-tool", reason: `tool '${call.tool}' is not classified` };
}

export function evaluateShell(command: string, ctx: PolicyContext): PolicyDecision {
  const secretRefs = envReferences(command).filter((v) => SECRET_VAR.test(v));
  if (secretRefs.length)
    return deny("secret-env", `command reads secret environment variables: ${secretRefs.join(", ")}`);
  if (/process\.env|Bun\.env|os\.environ|getenv\s*\(/.test(command)) {
    return deny("secret-env", "command reads the process environment");
  }

  const parsed = parseShell(command);
  if (parsed.opaque.length) return deny("opaque-shell", `refusing to evaluate: ${parsed.opaque.join(", ")}`);

  let needsAsk: PolicyDecision | null = null;
  for (const seg of parsed.segments) {
    const words = seg.words;
    if (words.length === 0) continue;
    const prog = programName(words[0]!);

    const denied = listed(words, ctx.commandDeny);
    if (denied) return deny("command-deny", `command '${denied}' is on the denylist`);
    if (!ctx.allowNetwork) {
      const net = listed(words, ctx.networkCommands);
      if (net) return deny("network", `network-capable command '${net}' is denied by default`);
    }

    // Path jail + protected paths for every path-like argument.
    for (const w of words.slice(1)) {
      if (w.startsWith("-") && !w.includes("=")) continue;
      const val = w.includes("=") && w.startsWith("-") ? w.slice(w.indexOf("=") + 1) : w;
      if (
        isAbsolute(val) ||
        /^[A-Za-z]:/.test(val) ||
        val.startsWith("~") ||
        val.split(/[\\/]/).includes("..")
      ) {
        const pc = checkPath(ctx.worktree, val);
        if (!pc.inside) return deny("path-jail", `argument points outside the task worktree: ${val}`);
      }
      if (/https?:\/\//i.test(val) && !ctx.allowNetwork) return deny("network", `URL argument: ${val}`);
    }
    for (const r of seg.redirects) {
      const d = writeCheck(ctx, r);
      if (d) return d;
    }
    if (WRITE_CMDS.has(prog)) {
      const targets = words.slice(1).filter((w) => !w.startsWith("-"));
      const writeTargets = prog === "cp" || prog === "copy" || prog === "ln" ? targets.slice(-1) : targets;
      if (prog === "sed" && !words.some((w) => w === "-i" || w.startsWith("-i"))) {
        // read-only sed
      } else {
        for (const t of writeTargets) {
          const d = writeCheck(ctx, t);
          if (d) return d;
        }
      }
    }

    // Inline code: block network access from `bun -e` / `node -e` when network is off.
    if ((prog === "bun" || prog === "node") && words.some((w) => INLINE_CODE_FLAGS.has(w))) {
      const code = words.join(" ");
      if (!ctx.allowNetwork && /fetch\s*\(|https?:|net\.|http\.|WebSocket|dgram/.test(code)) {
        return deny("network", "inline code with network access");
      }
    }

    if (prog === "git") {
      const sub = words.slice(1).find((w) => !w.startsWith("-")) ?? "";
      if (!GIT_SAFE.has(sub)) {
        needsAsk ??= {
          decision: ctx.unknownCommand,
          rule: "git-subcommand",
          reason: `git ${sub} is not on the safe list`,
        };
      }
      continue;
    }

    const allowed = ctx.commandAllow.some((a) => a.toLowerCase() === prog);
    if (!allowed) {
      needsAsk ??= {
        decision: ctx.unknownCommand,
        rule: "unknown-command",
        reason: `command '${prog}' is not on the allowlist`,
      };
    }
  }
  return needsAsk ?? allow("command-allow", "all commands on the allowlist");
}
