# Live smoke test — 2026-11-16

Command: `SAGE_LIVE=1 bun run scripts/live-smoke.ts --model openai/gpt-6.1-terra --shared-store`

Engine: opencode 2.0.29 (the user-installed binary; the adapter was also probed against 2.3.0 with `scripts/engine-probe.ts`). Provider: OpenAI through OpenCode's ChatGPT sign-in (official flow). OpenCode reported a cost of $0.00 for this sign-in type, so the token cap was the binding budget.

Earlier attempts with `openai/gpt-5.5` and `openai/gpt-5.3-codex-spark` failed at planning with `model_not_found` for ChatGPT accounts (0 tokens used). They also surfaced a real adapter bug (the message `limit` must be <= 200), fixed in the same commit.

```text
run run-0mwjgjeteaca5fbc1 — goal: Add an exported function multiply(a: number, b: number): number to src/math.ts, and a bun test for it in tests/multiply.test.ts. [AWAITING_MERGE_APPROVAL]
├─ plan (1 tasks, attempt 1) 11.0s
│  ├─ execute_tool read [allow:read] read src/math.ts
│  ├─ execute_tool read [allow:read] read tests/math.test.ts
│  ├─ execute_tool read [allow:read] read package.json
│  ├─ chat openai/gpt-6.1-terra in=5990 out=65 $0.0000
│  └─ chat openai/gpt-6.1-terra in=6233 out=215 $0.0000
├─ approval plan: approved by human
└─ task add-multiply: Implement and test multiply → PASSED
   ├─ invoke_agent executor attempt 1 (openai/gpt-6.1-terra) 22.0s
   │  ├─ execute_tool read [allow:read] read src/math.ts
   │  ├─ execute_tool read [allow:read] read tests
   │  ├─ execute_tool glob [allow:read] glob **/AGENTS.md
   │  ├─ execute_tool read [allow:read] read package.json
   │  ├─ chat openai/gpt-6.1-terra in=5853 out=79 $0.0000
   │  ├─ execute_tool read [allow:read] read tests/math.test.ts
   │  ├─ chat openai/gpt-6.1-terra in=6065 out=20 $0.0000
   │  ├─ execute_tool patch [allow:write] patch
   │  ├─ chat openai/gpt-6.1-terra in=6164 out=224 $0.0000
   │  ├─ execute_tool shell [allow:command-allow] shell `bun test`
   │  ├─ chat openai/gpt-6.1-terra in=6416 out=23 $0.0000
   │  ├─ chat openai/gpt-6.1-terra in=6494 out=38 $0.0000
   │  └─ diff df25a6529734: src/math.ts, tests/multiply.test.ts
   ├─ verify → PASS 98ms
   │  └─ gate test: pass — 2 pass, 0 fail
   └─ merge add-multiply → 0f0859b31ceb
```

```json
{
  "runId": "run-0mwjgjeteaca5fbc1",
  "model": "openai/gpt-6.1-terra",
  "state": "AWAITING_MERGE_APPROVAL",
  "reason": "all tasks passed verification",
  "planErrors": [],
  "wallClockSec": 34,
  "costUsd": 0,
  "inputTokens": 43215,
  "outputTokens": 664,
  "modelCalls": 7,
  "toolCalls": 10,
  "deniedToolCalls": 0,
  "asks": [],
  "tasks": [
    {
      "id": "add-multiply",
      "state": "PASSED",
      "attempts": 1,
      "failure": null
    }
  ],
  "filesChanged": [
    "src/math.ts",
    "tests/multiply.test.ts"
  ],
  "mainUntouched": true
}
```
