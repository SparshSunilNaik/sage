import { timingSafeEqual } from "node:crypto";
import { randomToken } from "@sage/core";
import type { GuardResponse } from "@sage/guard-plugin";
import { z } from "zod";

export const GuardRequestSchema = z.object({
  runId: z.string().min(1),
  taskId: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  callId: z.string().min(1),
  tool: z.string().min(1).max(200),
  args: z.record(z.string(), z.unknown()),
  sessionId: z.string().optional(),
});
export type GuardRequestParsed = z.infer<typeof GuardRequestSchema>;

/**
 * Local HTTP endpoint used by the guard plugin. Binds to 127.0.0.1 only, port chosen by the OS,
 * and requires a random per-run bearer token. Anything malformed is denied.
 */
export class GuardServer {
  readonly token = randomToken();
  private server: ReturnType<typeof Bun.serve> | undefined;

  constructor(
    private readonly runId: string,
    private readonly handler: (req: GuardRequestParsed) => Promise<GuardResponse>,
  ) {}

  get url(): string {
    if (!this.server) throw new Error("guard server not started");
    return `http://127.0.0.1:${this.server.port}`;
  }

  start(): this {
    const expected = Buffer.from(`Bearer ${this.token}`);
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const auth = Buffer.from(req.headers.get("authorization") ?? "");
        const authed = auth.length === expected.length && timingSafeEqual(auth, expected);
        if (!authed) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (req.method === "GET" && url.pathname === "/v1/health")
          return Response.json({ ok: true, runId: this.runId });
        if (req.method === "POST" && url.pathname === "/v1/guard") {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return Response.json({ decision: "deny", rule: "guard-protocol", reason: "invalid JSON" });
          }
          const parsed = GuardRequestSchema.safeParse(body);
          if (!parsed.success || parsed.data.runId !== this.runId) {
            return Response.json({
              decision: "deny",
              rule: "guard-protocol",
              reason: "invalid guard request",
            });
          }
          try {
            return Response.json(await this.handler(parsed.data));
          } catch (e) {
            return Response.json({ decision: "deny", rule: "guard-error", reason: (e as Error).message });
          }
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    return this;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
  }
}
