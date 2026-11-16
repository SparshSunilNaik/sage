/**
 * Environment scrubbing. Child processes (the engine, the agent's shell, verification gates)
 * get an allowlisted environment; anything that looks like a credential is removed even if
 * it is on the allowlist.
 */
const BASE_ALLOW = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SHELL",
  "USER",
  "USERNAME",
  "LOGNAME",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "BUN_INSTALL",
  "BUN_INSTALL_CACHE_DIR",
];

export const SECRET_NAME =
  /(KEY|TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|_PAT$|^PAT_|DSN)/i;

export interface ScrubOptions {
  /** Extra variable names allowed through (e.g. a provider key for the engine process only). */
  passThrough?: readonly string[];
  /** Variables to set explicitly (not subject to the secret filter). */
  set?: Record<string, string>;
}

export function scrubEnv(source: NodeJS.ProcessEnv, opts: ScrubOptions = {}): Record<string, string> {
  const allow = new Set(BASE_ALLOW.map((k) => k.toUpperCase()));
  const pass = new Set((opts.passThrough ?? []).map((k) => k.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    const up = k.toUpperCase();
    if (pass.has(up)) {
      out[k] = v;
      continue;
    }
    if (!allow.has(up)) continue;
    if (SECRET_NAME.test(up)) continue;
    out[k] = v;
  }
  out.SAGE_AGENT_CONTEXT = "1";
  out.NO_COLOR = "1";
  out.GIT_TERMINAL_PROMPT = "0";
  for (const [k, v] of Object.entries(opts.set ?? {})) out[k] = v;
  return out;
}

/** Names (never values) of secret-looking variables present in an environment. */
export function secretNames(source: NodeJS.ProcessEnv): string[] {
  return Object.keys(source)
    .filter((k) => SECRET_NAME.test(k))
    .sort();
}
