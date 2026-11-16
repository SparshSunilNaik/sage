# ADR 0007 — Tracing and budgets

- Status: accepted
- Date: 2026-11-16

## Tracing

- Spans are written as JSONL (`.sage/runs/<run>/trace.jsonl`) through a pluggable `SpanExporter`
  (`JsonlExporter`, `MemoryExporter`; an OTLP exporter can implement the same interface).
- Names follow the OpenTelemetry GenAI semantic conventions: span names `invoke_agent`, `chat`,
  `execute_tool`; attributes `gen_ai.operation.name`, `gen_ai.request.model`,
  `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.agent.name`,
  `gen_ai.tool.name`, `gen_ai.tool.call.id`. SAGE-specific data uses `sage.*`
  (policy decision/rule, gate results, diffs, approvals, recovery). The conventions were still
  marked *Development* when researched (research.md G5), so names may need updating.
- Span ids for runs, tasks, attempts and the plan are **deterministic** (hash of run/task/attempt),
  so spans written by a resumed process attach to the same tree; the renderer keeps the last record
  per id.
- **Content capture is off by default** (`trace.captureContent`); all string attributes are passed
  through secret redaction (API-key, GitHub-token, AWS, Slack, Bearer/Basic patterns).
- The journal remains the source of truth; spans are the human/OTel view.

## Budgets

- Usage is journaled per model call (`usage` events) and summed per task and per run.
- Before each agent turn and **after every model call** the orchestrator compares spend with
  `budget.task` and `budget.run` (USD and tokens). Exceeding a limit throws inside the engine's
  `onModelCall` callback; the adapter interrupts the OpenCode session immediately. The overrun is
  therefore bounded by one model call.
- When the provider reports no cost (e.g. a subscription sign-in), the token limits still apply,
  and `engine.opencode.pricing` can supply a price table for estimation.
