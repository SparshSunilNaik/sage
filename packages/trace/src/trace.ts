import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Structured spans using OpenTelemetry GenAI semantic-convention names
 * (gen_ai.operation.name, gen_ai.request.model, gen_ai.usage.input_tokens, ...) and span names
 * (invoke_agent, chat, execute_tool). SAGE-specific attributes use the `sage.` prefix.
 * The exporter is pluggable; the default writes JSONL. A real OTLP exporter can implement
 * `SpanExporter` without touching callers.
 */

export type AttrValue = string | number | boolean | string[];
export type Attributes = Record<string, AttrValue>;

export const SpanRecord = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  status: z.enum(["ok", "error", "unset"]),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
});
export type SpanRecord = z.infer<typeof SpanRecord>;

export interface SpanExporter {
  export(span: SpanRecord): void;
}

export class JsonlExporter implements SpanExporter {
  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }
  export(span: SpanRecord): void {
    appendFileSync(this.file, `${JSON.stringify(span)}\n`);
  }
}

export class MemoryExporter implements SpanExporter {
  readonly spans: SpanRecord[] = [];
  export(span: SpanRecord): void {
    this.spans.push(span);
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /(?<=Bearer\s)[A-Za-z0-9._~+/=-]{8,}/gi,
  /(?<=Basic\s)[A-Za-z0-9+/=]{8,}/gi,
  /(?<=(?:api[_-]?key|token|secret|password)["'\s:=]{1,4})[^\s"',}]{6,}/gi,
];

export function redact(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) out = out.replace(p, "[REDACTED]");
  return out;
}

function redactAttrs(a: Attributes): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(a)) {
    if (typeof v === "string") out[k] = redact(v);
    else if (Array.isArray(v)) out[k] = v.map(redact);
    else out[k] = v;
  }
  return out;
}

export function runTraceIds(runId: string): { traceId: string; rootSpanId: string } {
  const h = createHash("sha256").update(runId).digest("hex");
  return { traceId: h.slice(0, 32), rootSpanId: h.slice(32, 48) };
}

export class ActiveSpan {
  private attrs: Attributes;
  private ended = false;
  readonly spanId: string;
  readonly start = new Date();
  constructor(
    private readonly tracer: Tracer,
    readonly name: string,
    attrs: Attributes,
    readonly parentSpanId: string | undefined,
    spanId?: string,
  ) {
    this.attrs = { ...attrs };
    this.spanId = spanId ?? randomBytes(8).toString("hex");
  }
  set(key: string, value: AttrValue): this {
    this.attrs[key] = value;
    return this;
  }
  setMany(a: Attributes): this {
    Object.assign(this.attrs, a);
    return this;
  }
  end(status: "ok" | "error" = "ok"): void {
    if (this.ended) return;
    this.ended = true;
    this.tracer.emit({
      traceId: this.tracer.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startTime: this.start.toISOString(),
      endTime: new Date().toISOString(),
      status,
      attributes: redactAttrs(this.attrs),
    });
  }
}

export class Tracer {
  readonly traceId: string;
  readonly rootSpanId: string;
  constructor(
    readonly runId: string,
    private readonly exporter: SpanExporter,
    readonly captureContent = false,
  ) {
    const ids = runTraceIds(runId);
    this.traceId = ids.traceId;
    this.rootSpanId = ids.rootSpanId;
  }
  start(name: string, attrs: Attributes = {}, parent?: string, spanId?: string): ActiveSpan {
    return new ActiveSpan(this, name, attrs, parent ?? this.rootSpanId, spanId);
  }
  /** Zero-duration span for instantaneous decisions (policy, approvals, gate summaries). */
  event(name: string, attrs: Attributes, parent?: string, status: "ok" | "error" = "ok"): void {
    this.start(name, attrs, parent).end(status);
  }
  /** Content is only attached when capture is enabled; always redacted. */
  content(text: string): string | undefined {
    return this.captureContent ? redact(text).slice(0, 4000) : undefined;
  }
  emit(s: SpanRecord): void {
    this.exporter.export(s);
  }
}

export function readSpans(file: string): SpanRecord[] {
  if (!existsSync(file)) return [];
  const out: SpanRecord[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(SpanRecord.parse(JSON.parse(line)));
    } catch {
      /* torn last line after a crash: skip */
    }
  }
  return out;
}
