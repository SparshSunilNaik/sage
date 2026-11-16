/** Normalise `opencode --version` output ("opencode v2.3.0", "2.3.0") to "2.3.0". */
export function parseEngineVersion(output: string): string {
  const last = output.trim().split(/\s+/).pop() ?? "";
  return last.replace(/^v/i, "");
}

/**
 * Integration names from `opencode auth list` (V2 keeps credentials in its database, not in an
 * auth.json file). Only the first column is kept, and anything that looks like a secret is dropped,
 * so doctor can never print a credential.
 */
export function parseAuthList(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const first = line.trim().split(/\s+/)[0] ?? "";
    if (!first || first.length > 40) continue;
    if (/^(sk-|ghp_|gho_|github_pat_|xox)/i.test(first)) continue;
    if (/^(no|none|error|usage|description|integration|name)\b/i.test(first)) continue;
    if (!/^[A-Za-z][\w.-]*$/.test(first)) continue;
    names.push(first);
  }
  return [...new Set(names)];
}
