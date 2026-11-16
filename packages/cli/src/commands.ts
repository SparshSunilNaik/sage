import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, CONFIG_TEMPLATE, type Plan, type RunState } from "@sage/core";
import { ENGINE_PID_FILE } from "@sage/engine-opencode";
import {
  abort,
  approve,
  DenyAsker,
  engineStateDir,
  JournalAsker,
  makeEngine,
  merge,
  Orchestrator,
  reject,
  retryEscalated,
  runDir,
  SerialAsker,
  sageDir,
  taskBranch,
  tracePath,
  worktreeRoot,
} from "@sage/orchestrator";
import { readSpans, renderTree, runTraceIds, summarize } from "@sage/trace";
import {
  dirSize,
  excludeSageDir,
  formatBytes,
  git,
  gitCommonDir,
  gitIdentity,
  gitTry,
  isProcessAlive,
  killTree,
  removeWorktree,
  runProcess,
  secretNames,
} from "@sage/workspace";
import { type Ctx, context, err, money, out } from "./context.ts";
import { parseAuthList, parseEngineVersion } from "./doctor-util.ts";
import { ClackAsker, confirmPlan, formatPlan, isInteractive } from "./interactive.ts";

export interface GlobalOpts {
  repo?: string;
}

/* ----------------------------------- init ----------------------------------- */

export async function cmdInit(o: GlobalOpts & { force?: boolean; fake?: string }) {
  const c = await context(o);
  const p = join(c.repo, CONFIG_FILE);
  if (existsSync(p) && !o.force) {
    out(`${CONFIG_FILE} already exists (use --force to overwrite)`);
  } else {
    let text = CONFIG_TEMPLATE;
    if (o.fake)
      text = text.replace(
        `"kind": "opencode"`,
        `"kind": "fake",\n    "fake": { "scenario": ${JSON.stringify(o.fake)} }`,
      );
    writeFileSync(p, text);
    out(`wrote ${p}`);
  }
  excludeSageDir(c.repo, await gitCommonDir(c.repo));
  out(`state directory: ${sageDir(c.repo)} (excluded from git via .git/info/exclude)`);
  const id = await gitIdentity(c.repo);
  if (!id.name || !id.email)
    err("warning: git user.name/user.email are not configured; SAGE commits will fail");
}

/* ------------------------------- run / resume -------------------------------- */

interface DriveOpts extends GlobalOpts {
  yes?: boolean;
  concurrency?: string;
  planOnly?: boolean;
}

function orchestrator(c: Ctx, o: DriveOpts): Orchestrator {
  if (o.concurrency) c.config.concurrency = Number(o.concurrency);
  const interactive = isInteractive();
  const asker = interactive
    ? new SerialAsker(new ClackAsker())
    : process.env.SAGE_NONINTERACTIVE_ASK === "deny"
      ? new DenyAsker()
      : new JournalAsker(c.journal, c.config.policy.askTimeoutMs, (m) => err(m));
  return new Orchestrator({
    repo: c.repo,
    journal: c.journal,
    config: c.config,
    engine: makeEngine(c.config, c.repo),
    asker,
    autoApprovePlan: Boolean(o.yes) && !o.planOnly,
    confirmPlan: interactive && !o.yes && !o.planOnly ? confirmPlan : undefined,
    log: (m) => err(`[sage] ${m}`),
  });
}

function nextSteps(runId: string, state: RunState, c: Ctx): void {
  out(`run ${runId}: ${state}`);
  const short = runId;
  switch (state) {
    case "AWAITING_PLAN_APPROVAL": {
      const plan = JSON.parse(c.journal.mustRun(runId).planJson ?? "null") as Plan | null;
      if (plan) out(formatPlan(plan));
      out(`next: sage approve ${short} && sage resume ${short}   (or: sage reject ${short})`);
      break;
    }
    case "AWAITING_MERGE_APPROVAL":
      out(`all tasks passed. review: sage diff ${short} / sage trace ${short}`);
      out(`next: sage approve ${short} && sage merge ${short}   (or: sage reject ${short})`);
      break;
    case "FAILED":
      out(`reason: ${c.journal.mustRun(runId).reason ?? ""}`);
      out(
        `inspect: sage status ${short} / sage trace ${short}; retry escalated tasks: sage resume ${short} --retry-escalated`,
      );
      break;
    default:
      break;
  }
}

export async function cmdRun(goal: string, o: DriveOpts) {
  const c = await context(o);
  const orch = orchestrator(c, o);
  const runId = await orch.createRun(goal);
  out(`created run ${runId}`);
  const state = await orch.drive(runId);
  nextSteps(runId, state, c);
  return state;
}

export async function cmdResume(run: string, o: DriveOpts & { retryEscalated?: boolean }) {
  const c = await context(o);
  const runId = c.journal.resolveRunId(run);
  if (o.retryEscalated) out(`retrying escalated tasks: ${retryEscalated(c.journal, runId).join(", ")}`);
  const state = await orchestrator(c, o).drive(runId);
  nextSteps(runId, state, c);
  return state;
}

/* ---------------------------------- status ---------------------------------- */

export async function cmdStatus(run: string | undefined, o: GlobalOpts & { json?: boolean }) {
  const c = await context(o);
  if (!run) {
    const runs = c.journal.listRuns();
    if (o.json)
      return out(
        JSON.stringify(runs.map((r) => ({ id: r.id, state: r.state, goal: r.goal, costUsd: r.costUsd }))),
      );
    if (!runs.length) return out('no runs yet. start one with: sage run "<goal>"');
    for (const r of runs) out(`${r.id}  ${r.state.padEnd(24)} ${money(r.costUsd)}  ${r.goal.slice(0, 70)}`);
    return;
  }
  const runId = c.journal.resolveRunId(run);
  const r = c.journal.mustRun(runId);
  const tasks = c.journal.getTasks(runId);
  if (o.json) return out(JSON.stringify({ run: r, tasks, approvals: c.journal.approvals(runId) }));
  out(`run      ${r.id}`);
  out(`goal     ${r.goal}`);
  out(`state    ${r.state}${r.reason ? `  (${r.reason})` : ""}`);
  out(`branches ${r.runBranch} -> ${r.targetBranch} (base ${r.baseSha.slice(0, 10)})`);
  out(
    `usage    in=${r.inputTokens} out=${r.outputTokens} cost=${money(r.costUsd)} (budget ${money(c.config.budget.run.maxUsd)})`,
  );
  out("tasks:");
  for (const t of tasks) {
    out(
      `  ${t.id.padEnd(20)} ${t.state.padEnd(10)} attempt=${t.attempt} cost=${money(t.costUsd)}${t.failureClass ? ` ${t.failureClass}` : ""}${t.reason && t.state !== "PASSED" ? `  — ${t.reason.slice(0, 120)}` : ""}`,
    );
  }
  const pending = c.journal.approvals(runId).filter((a) => a.status === "pending");
  if (pending.length) {
    out("pending approvals:");
    for (const a of pending) out(`  ${a.id} [${a.kind}] ${a.request}`);
  }
}

/* -------------------------------- oversight --------------------------------- */

export async function cmdApprove(run: string, o: GlobalOpts & { request?: string; reason?: string }) {
  const c = await context(o);
  out(approve(c.journal, c.journal.resolveRunId(run), { requestId: o.request, reason: o.reason }));
}

export async function cmdReject(run: string, o: GlobalOpts & { request?: string; reason?: string }) {
  const c = await context(o);
  out(reject(c.journal, c.journal.resolveRunId(run), { requestId: o.request, reason: o.reason }));
}

export async function cmdAbort(run: string, o: GlobalOpts) {
  const c = await context(o);
  out(abort(c.journal, c.journal.resolveRunId(run)));
}

export async function cmdMerge(run: string, o: GlobalOpts) {
  const c = await context(o);
  out(await merge(c.journal, c.repo, c.journal.resolveRunId(run)));
}

/* ------------------------------- trace / diff -------------------------------- */

export async function cmdTrace(run: string, o: GlobalOpts & { json?: boolean }) {
  const c = await context(o);
  const runId = c.journal.resolveRunId(run);
  const spans = readSpans(tracePath(c.repo, runId));
  if (o.json) return out(JSON.stringify(spans, null, 2));
  out(renderTree(spans, runTraceIds(runId).rootSpanId));
  const s = summarize(spans);
  out("");
  out(
    `model calls=${s.modelCalls} tokens in=${s.inputTokens} out=${s.outputTokens} cost=${money(s.costUsd)} | tool calls=${s.toolCalls} denied=${s.denied}`,
  );
  const approvals = c.journal.approvals(runId);
  if (approvals.length) {
    out("approvals:");
    for (const a of approvals) out(`  [${a.kind}] ${a.status} by ${a.actor ?? "-"} — ${a.request}`);
  }
}

export async function cmdDiff(run: string, o: GlobalOpts & { task?: string; stat?: boolean }) {
  const c = await context(o);
  const runId = c.journal.resolveRunId(run);
  const r = c.journal.mustRun(runId);
  const stat = o.stat ? ["--stat"] : [];
  if (o.task) {
    const t = c.journal.mustTask(runId, o.task);
    if (!t.baseSha || !t.headSha) return out("task has no committed work yet");
    return out(await git(c.repo, ["diff", ...stat, t.baseSha, t.headSha]));
  }
  for (const t of c.journal.getTasks(runId)) {
    const files = JSON.parse(t.filesJson ?? "[]") as string[];
    out(`# task ${t.id} [${t.state}] ${files.join(", ")}`);
  }
  out(await git(c.repo, ["diff", ...stat, r.baseSha, r.runBranch]));
}

/* ----------------------------------- doctor ---------------------------------- */

const PROVIDER_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
];

export function sageHome(): string {
  return join(import.meta.dir, "..", "..", "..");
}

export async function cmdDoctor(o: GlobalOpts) {
  const lines: [string, boolean, string][] = [];
  const add = (name: string, ok: boolean, detail: string) => lines.push([name, ok, detail]);
  add("bun", true, Bun.version);
  const gv = await runProcess(["git", "--version"], { cwd: process.cwd() });
  add("git", gv.code === 0, gv.stdout.trim());
  let repo: string | undefined;
  try {
    const c = await context(o);
    repo = c.repo;
    const id = await gitIdentity(c.repo);
    add(
      "git identity",
      Boolean(id.name && id.email),
      id.name && id.email ? `${id.name} <${id.email}>` : "user.name/user.email missing",
    );
    add(
      "config",
      true,
      existsSync(join(c.repo, CONFIG_FILE))
        ? `${CONFIG_FILE} valid (engine=${c.config.engine.kind})`
        : "no config file (defaults)",
    );
    const forkPkg = join(sageHome(), "engine", "opencode", "package.json");
    const forkVersion = existsSync(forkPkg)
      ? (JSON.parse(readFileSync(forkPkg, "utf8")).version as string)
      : "fork not checked out";
    const ov = await runProcess([c.config.engine.opencode.bin, "--version"], {
      cwd: c.repo,
      timeoutMs: 20_000,
    });
    const engineVersion = parseEngineVersion(ov.stdout || ov.stderr);
    add(
      "opencode engine",
      ov.code === 0 && engineVersion === forkVersion,
      ov.code === 0
        ? `binary ${engineVersion}, fork ${forkVersion}${engineVersion === forkVersion ? "" : " (MISMATCH: install @opencode/cli@" + forkVersion + ")"}`
        : `'${c.config.engine.opencode.bin}' not runnable`,
    );
  } catch (e) {
    add("repository", false, (e as Error).message);
  }
  // OpenCode 2.x stores credentials in its database; ask it which integrations are configured.
  let bin = "opencode";
  try {
    bin = (await context(o)).config.engine.opencode.bin;
  } catch {
    /* default */
  }
  const auth = await runProcess([bin, "auth", "list"], { cwd: process.cwd(), timeoutMs: 30_000 });
  const integrations = auth.code === 0 ? parseAuthList(auth.stdout) : [];
  add(
    "opencode sign-ins",
    integrations.length > 0,
    auth.code !== 0
      ? `could not run '${bin} auth list'`
      : integrations.length
        ? `${integrations.join(", ")} (names only; credentials stay in OpenCode)`
        : "none (run `opencode auth login`, or pass provider keys via engine.opencode.passEnv)",
  );
  const present = PROVIDER_VARS.filter((k) => process.env[k]);
  add(
    "provider env keys",
    present.length > 0,
    present.length ? `set: ${present.join(", ")} (values not shown)` : "none set",
  );
  add(
    "secret-like env vars",
    true,
    `${secretNames(process.env).length} present; all are scrubbed from agent/gate environments`,
  );
  const home = sageHome();
  const disk = dirSize(home);
  add("disk (SAGE install)", disk < 12 * 1024 ** 3, `${formatBytes(disk)} (budget 15 GB, alert at 12 GB)`);
  if (repo) add("disk (.sage state)", true, formatBytes(dirSize(sageDir(repo))));
  for (const [n, ok, d] of lines) out(`${ok ? "ok  " : "WARN"} ${n.padEnd(22)} ${d}`);
}

/* ------------------------------------ gc ------------------------------------- */

/** Pids recorded by engine processes under a run's engine state directory. */
export function enginePids(dir: string): number[] {
  if (!existsSync(dir)) return [];
  const pids: number[] = [];
  for (const sub of readdirSync(dir)) {
    const f = join(dir, sub, ENGINE_PID_FILE);
    if (!existsSync(f)) continue;
    const pid = Number(readFileSync(f, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

export async function cmdGc(o: GlobalOpts & { all?: boolean; dryRun?: boolean; branches?: boolean }) {
  const c = await context(o);
  const terminal: RunState[] = o.all ? ["MERGED", "ABORTED", "FAILED"] : ["MERGED", "ABORTED"];
  let freed = 0;
  for (const r of c.journal.listRuns()) {
    if (!terminal.includes(r.state)) continue;
    const wt = worktreeRoot(c.repo, r.id);
    const eng = join(sageDir(c.repo), "engine", r.id);
    const size = dirSize(wt) + dirSize(eng);
    if (size === 0 && !o.branches) continue;
    out(`${o.dryRun ? "would remove" : "removing"} worktrees of ${r.id} (${r.state}, ${formatBytes(size)})`);
    if (o.dryRun) continue;
    // Engine servers left behind by a killed orchestrator (their pid files survive the crash).
    for (const pid of enginePids(eng)) {
      if (isProcessAlive(pid)) {
        killTree(pid);
        out(`  killed leftover engine process ${pid}`);
      }
    }
    for (const t of c.journal.getTasks(r.id)) {
      if (t.worktree) await removeWorktree(c.repo, t.worktree);
      if (o.branches) await gitTry(c.repo, ["branch", "-D", taskBranch(r.id, t.id)]);
    }
    await removeWorktree(c.repo, join(wt, "_integration"));
    rmSync(wt, { recursive: true, force: true });
    rmSync(eng, { recursive: true, force: true });
    if (o.branches && r.state !== "MERGED") await gitTry(c.repo, ["branch", "-D", r.runBranch]);
    freed += size;
  }
  await gitTry(c.repo, ["worktree", "prune"]);
  out(
    `gc done; ${o.dryRun ? "would free" : "freed"} ${formatBytes(freed)}. journal and traces are kept (${runDir(c.repo, "*")}).`,
  );
  void engineStateDir;
}
