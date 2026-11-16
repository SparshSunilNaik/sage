import { z } from "zod";

/**
 * Thin typed HTTP client for the OpenCode 2.3.0 server API. Route names and payloads mirror the
 * generated `@opencode/client` (see ADR 0001); responses are validated with Zod (loosely: only the
 * fields SAGE reads are required, unknown fields pass through).
 */

export const ModelRef = z.object({ providerID: z.string(), id: z.string() });

const Tokens = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number().default(0),
  cache: z.object({ read: z.number(), write: z.number() }).default({ read: 0, write: 0 }),
});
export type Tokens = z.infer<typeof Tokens>;

const ToolItem = z.object({
  type: z.literal("tool"),
  id: z.string(),
  name: z.string(),
  state: z.object({ status: z.string(), error: z.unknown().optional() }).loose(),
});
const TextItem = z.object({ type: z.literal("text"), text: z.string() });
const OtherItem = z.object({ type: z.string() }).loose();

export const Message = z
  .object({
    id: z.string(),
    type: z.string(),
    model: ModelRef.optional(),
    content: z.array(z.union([ToolItem, TextItem, OtherItem])).optional(),
    cost: z.number().optional(),
    tokens: Tokens.optional(),
    error: z.unknown().optional(),
    outcome: z.string().optional(),
  })
  .loose();
export type Message = z.infer<typeof Message>;

export const SseEnvelope = z
  .object({ type: z.string(), data: z.record(z.string(), z.unknown()).default({}) })
  .loose();

export class OpencodeHttp {
  constructor(
    readonly baseUrl: string,
    private readonly password: string,
  ) {}

  get authHeader(): string {
    return `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`;
  }

  async req(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: this.authHeader,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  }

  async json<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const r = await this.req(method, path, body);
    const text = await r.text();
    if (!r.ok) throw new Error(`opencode ${method} ${path} -> HTTP ${r.status}: ${text.slice(0, 500)}`);
    return schema.parse(JSON.parse(text));
  }

  info() {
    return this.json("GET", "/api/info", z.object({ version: z.string() }).loose());
  }

  plugins(directory: string) {
    return this.json(
      "GET",
      `/api/plugin?${new URLSearchParams({ "location[directory]": directory })}`,
      z.object({
        data: z.array(
          z.object({ id: z.string().optional(), state: z.object({ status: z.string() }).loose() }).loose(),
        ),
      }),
    );
  }

  createSession(body: Record<string, unknown>) {
    return this.json("POST", "/api/session", z.object({ data: z.object({ id: z.string() }).loose() }), body);
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const r = await this.req("POST", `/api/session/${sessionId}/prompt`, { text });
    if (!r.ok) throw new Error(`opencode prompt -> HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`);
  }

  async wait(sessionId: string, signal?: AbortSignal): Promise<void> {
    const r = await this.req("POST", `/api/experimental/session/${sessionId}/wait`, undefined, signal);
    if (!r.ok && r.status !== 204)
      throw new Error(`opencode wait -> HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.req("POST", `/api/session/${sessionId}/interrupt`).catch(() => undefined);
  }

  async replyPermission(sessionId: string, requestId: string, decision: "once" | "reject", message: string) {
    await this.req("POST", `/api/session/${sessionId}/permission/${requestId}/reply`, {
      decision,
      message,
    }).catch(() => undefined);
  }

  messages(sessionId: string) {
    return this.json(
      "GET",
      `/api/session/${sessionId}/message?order=asc&limit=200`,
      z.object({ data: z.array(Message) }),
    );
  }

  /** Subscribe to the SSE stream; calls `onEvent` for each parsed event until aborted. */
  async subscribe(
    types: string[],
    onEvent: (e: z.infer<typeof SseEnvelope>) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const qs = types.map((t) => `types=${encodeURIComponent(t)}`).join("&");
    const r = await this.req("GET", `/api/event?${qs}`, undefined, signal);
    if (!r.ok || !r.body) throw new Error(`opencode event stream -> HTTP ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let idx = buf.indexOf("\n\n");
        while (idx !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = frame
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (data) {
            try {
              const ev = SseEnvelope.safeParse(JSON.parse(data));
              if (ev.success) onEvent(ev.data);
            } catch {
              /* ignore malformed frame */
            }
          }
          idx = buf.indexOf("\n\n");
        }
      }
    } catch (e) {
      if (!signal.aborted) throw e;
    }
  }
}
