/**
 * A stub of `opencode serve --stdio` (2.3.0 API subset) for adapter tests. It loads the plugins
 * listed in OPENCODE_CONFIG_CONTENT exactly as OpenCode does (directory -> package exports ->
 * default `{id, setup}`), runs a scripted "agent turn" through the plugin's execute.before hook,
 * and emits the same SSE events and message shapes the real server does. No LLM involved.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Hook = (e: Record<string, unknown>) => Promise<void> | void;
const hooks: Record<string, Hook> = {};
const reg = async (name: string, cb: Hook) => {
  hooks[name] = cb;
  return { dispose: async () => undefined };
};

const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
  plugins?: { package: string; options?: Record<string, unknown> }[];
};
const pluginState: { id?: string; state: { status: string; error?: string } }[] = [];
for (const p of cfg.plugins ?? []) {
  try {
    const dir = fileURLToPath(p.package);
    const pkg = JSON.parse(await Bun.file(resolve(dir, "package.json")).text()) as {
      exports?: { ".": string };
    };
    const mod = (await import(resolve(dir, pkg.exports?.["."] ?? "index.ts"))) as {
      default: { id: string; setup: (c: unknown) => Promise<unknown> };
    };
    await mod.default.setup({ options: p.options ?? {}, tool: { hook: reg }, permission: { hook: reg } });
    pluginState.push({ id: mod.default.id, state: { status: "active" } });
  } catch (e) {
    pluginState.push({ state: { status: "failed", error: (e as Error).message } });
  }
}

const password = process.env.OPENCODE_PASSWORD ?? "";
const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
const script = JSON.parse(process.env.STUB_SCRIPT ?? "[]") as {
  tool: string;
  input: Record<string, unknown>;
}[];
const cwd = process.cwd();

let session: { id: string; directory: string } | undefined;
const sse = new Set<ReadableStreamDefaultController<Uint8Array>>();
const emit = (type: string, data: Record<string, unknown>) => {
  const frame = new TextEncoder().encode(
    `data: ${JSON.stringify({ id: crypto.randomUUID(), created: Date.now(), type, data })}\n\n`,
  );
  for (const c of sse) c.enqueue(frame);
};
const messages: Record<string, unknown>[] = [];
let turn: Promise<void> = Promise.resolve();

async function runTurn(sessionID: string): Promise<void> {
  const content: Record<string, unknown>[] = [];
  let step = 0;
  for (const call of script) {
    const assistantMessageID = `msg_${++step}`;
    emit("session.step.started", {
      sessionID,
      assistantMessageID,
      agent: "build",
      model: { providerID: "stub", id: "model-1" },
    });
    let status = "completed";
    try {
      await hooks["execute.before"]?.({
        tool: call.tool,
        sessionID,
        id: `call_${step}`,
        messageID: assistantMessageID,
        input: call.input,
      });
      if (call.tool === "write") {
        const p = resolve(cwd, String(call.input.path));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, String(call.input.content ?? ""));
      }
    } catch {
      status = "error";
    }
    content.push({
      type: "tool",
      id: `call_${step}`,
      name: call.tool,
      state: { status, input: call.input },
      time: { created: Date.now() },
    });
    emit("session.step.ended", {
      sessionID,
      assistantMessageID,
      finish: "tool-calls",
      cost: 0.001,
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    });
  }
  content.push({ type: "text", text: "stub turn finished" });
  messages.push({
    id: "msg_final",
    type: "assistant",
    agent: "build",
    model: { providerID: "stub", id: "model-1" },
    content,
    cost: 0.001 * script.length,
    tokens: {
      input: 100 * script.length,
      output: 20 * script.length,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: Date.now() },
  });
  messages.push({ id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: Date.now() } });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch: async (req) => {
    if (req.headers.get("authorization") !== expected) return new Response("unauthorized", { status: 401 });
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/api/info")
      return Response.json({ version: "2.3.0-stub", pid: process.pid, urls: [], paths: { tmp: "" } });
    if (path === "/api/plugin")
      return Response.json({
        location: { directory: cwd },
        data: pluginState.map((p) => ({ ...p, source: {}, features: {} })),
      });
    if (path === "/api/event") {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          sse.add(c);
          c.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`),
          );
        },
        cancel() {
          /* client went away */
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (path === "/api/session" && req.method === "POST") {
      const body = (await req.json()) as { location?: { directory: string } };
      session = { id: "ses_stub", directory: body.location?.directory ?? cwd };
      return Response.json({ data: { id: session.id } });
    }
    const m = path.match(/^\/api\/(?:experimental\/)?session\/([^/]+)\/(prompt|wait|message|interrupt)$/);
    if (m) {
      const [, id, op] = m;
      if (op === "prompt") {
        turn = runTurn(id!);
        return Response.json({ data: { id: "inbox_1" } });
      }
      if (op === "wait") {
        await turn;
        return new Response(null, { status: 204 });
      }
      if (op === "message") return Response.json({ data: messages, cursor: {} });
      if (op === "interrupt") return Response.json({ interrupted: true });
    }
    return new Response("not found", { status: 404 });
  },
});

process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.port}` })}\n`);
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
