/**
 * A deliberately conservative shell-command analyser. It does not try to be a full shell parser:
 * anything it cannot classify confidently falls through to the "unknown command" decision
 * (ask/deny), never to allow.
 */

export interface Segment {
  /** Raw words (quotes removed). */
  words: string[];
  /** Redirection targets (`> file`, `>> file`, `2> file`). */
  redirects: string[];
}

export interface ParsedCommand {
  segments: Segment[];
  /** Constructs we refuse to reason about (command substitution, eval-like). */
  opaque: string[];
}

export function parseShell(cmd: string): ParsedCommand {
  const segments: Segment[] = [];
  const opaque: string[] = [];
  if (/\$\(|`/.test(cmd)) opaque.push("command substitution");
  if (/<\(|>\(/.test(cmd)) opaque.push("process substitution");

  let words: string[] = [];
  let redirects: string[] = [];
  let cur = "";
  let hasCur = false;
  let quote: '"' | "'" | null = null;
  let pendingRedirect = false;

  const pushWord = () => {
    if (!hasCur) return;
    if (pendingRedirect) {
      redirects.push(cur);
      pendingRedirect = false;
    } else words.push(cur);
    cur = "";
    hasCur = false;
  };
  const endSegment = () => {
    pushWord();
    if (words.length || redirects.length) segments.push({ words, redirects });
    words = [];
    redirects = [];
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      hasCur = true;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length && process.platform !== "win32") {
      cur += cmd[++i];
      hasCur = true;
      continue;
    }
    if (c === " " || c === "\t") {
      pushWord();
      continue;
    }
    if (c === "\n" || c === ";" || c === "|" || c === "&") {
      endSegment();
      if ((c === "|" || c === "&") && cmd[i + 1] === c) i++;
      continue;
    }
    if (c === ">" || (c === "<" && cmd[i + 1] !== "<")) {
      // drop a preceding fd number like 2>
      if (hasCur && /^\d$/.test(cur)) {
        cur = "";
        hasCur = false;
      }
      pushWord();
      if (cmd[i + 1] === ">") i++;
      if (cmd[i + 1] === "&") {
        // 2>&1 style: not a file
        i++;
        while (i + 1 < cmd.length && /\d/.test(cmd[i + 1]!)) i++;
        continue;
      }
      if (c === ">") pendingRedirect = true;
      continue;
    }
    cur += c;
    hasCur = true;
  }
  if (quote) opaque.push("unterminated quote");
  endSegment();
  return { segments, opaque };
}

/** Normalise a program name: strip directories and Windows executable extensions. */
export function programName(word: string): string {
  const base = word.replace(/\\/g, "/").split("/").pop() ?? word;
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, "").toLowerCase();
}

/** Secret-looking environment variable references in a command string. */
export function envReferences(cmd: string): string[] {
  const refs: string[] = [];
  for (const m of cmd.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) refs.push(m[1]!);
  for (const m of cmd.matchAll(/%([A-Za-z_][A-Za-z0-9_]*)%/g)) refs.push(m[1]!);
  for (const m of cmd.matchAll(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi)) refs.push(m[1]!);
  return refs;
}
