/**
 * Zero-cost integration probe against the REAL OpenCode binary: start `opencode serve --stdio`
 * through the SAGE adapter, verify the guard plugin loads and reports `active`, create a session,
 * and shut down. No prompt is sent, so no LLM call and no spend.
 *
 * Usage: bun run scripts/engine-probe.ts [path-to-opencode]   (default: SAGE_OPENCODE_BIN or "opencode")
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeEngine } from "../packages/engine-opencode/src/index.ts";
import { GuardServer } from "../packages/orchestrator/src/index.ts";
import { scrubEnv } from "../packages/workspace/src/index.ts";

const bin = process.argv[2] ?? process.env.SAGE_OPENCODE_BIN ?? "opencode";
const dir = mkdtempSync(join(tmpdir(), "sage-probe-"));
const guard = new GuardServer("probe", async () => ({
  decision: "deny",
  rule: "probe",
  reason: "probe",
})).start();
const engine = new OpencodeEngine({ bin, startupTimeoutMs: 60_000, turnTimeoutMs: 60_000, pricing: {} });
let ok = false;
try {
  console.log(`engine version: ${await engine.version()}`);
  const t0 = Date.now();
  const s = await engine.start({
    runId: "probe",
    taskId: "probe",
    role: "executor",
    cwd: dir,
    env: scrubEnv(process.env),
    guard: { url: guard.url, token: guard.token },
    stateDir: join(dir, ".state"),
    attempt: 1,
  });
  console.log(`server started, guard plugin active, session created (${Date.now() - t0} ms)`);
  await s.close();
  ok = true;
} catch (e) {
  console.error(`probe failed: ${(e as Error).message}`);
} finally {
  guard.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
process.exit(ok ? 0 : 1);
