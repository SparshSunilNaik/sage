import { spawn, spawnSync } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: string;
  /** Cap on captured output per stream (bytes). */
  maxOutput?: number;
}

/**
 * Spawn a process from an argument array (never a shell string) and collect its output.
 * On timeout the whole process tree is killed.
 */
export function runProcess(argv: readonly string[], opts: RunOptions): Promise<RunResult> {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("empty command");
  const started = Date.now();
  const max = opts.maxOutput ?? 2_000_000;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? (process.env as Record<string, string>),
      shell: false,
      windowsHide: true,
      // POSIX: own process group so the tree can be killed with -pid.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < max) stderr += d.toString("utf8");
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            if (child.pid) killTree(child.pid);
          }, opts.timeoutMs)
        : undefined;
    const finish = (code: number | null, err?: Error) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr: err ? `${stderr}${err.message}` : stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    };
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code));
  });
}

/** Kill a process and all of its descendants. Windows: taskkill /T /F. POSIX: signal the group. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
