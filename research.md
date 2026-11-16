# SAGE — Background Research & Gap Analysis

> **Purpose.** Source material for the SAGE project report (portfolio + university course project).
> It documents the state of AI coding agents as of **November 2026**, the gaps in existing systems,
> and how each gap maps to SAGE's problem statement and planned design.
>
> **Compiled:** 16 November 2026 · **Status:** pre-implementation (SAGE results sections are placeholders)
>
> **How to cite from this file:** numbers in square brackets, e.g. **[4]**, refer to the
> [Bibliography](#10-bibliography). Peer-reviewed papers are marked 📄, vendor/official docs 🏢,
> and journalism/blogs 📰. For an academic report, prefer 📄 and 🏢 sources; use 📰 sources for
> recent events that have not yet appeared in papers, and say so.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Context: capability is rising, trust is not](#2-context-capability-is-rising-trust-is-not)
3. [Landscape of existing systems](#3-landscape-of-existing-systems)
4. [The model-access landscape (why "model-agnostic" matters)](#4-the-model-access-landscape-why-model-agnostic-matters)
5. [Gap analysis](#5-gap-analysis)
6. [Traceability: problem statement → gap → SAGE response](#6-traceability-problem-statement--gap--sage-response)
7. [Evaluation methodology for SAGE](#7-evaluation-methodology-for-sage)
8. [Limitations of this research](#8-limitations-of-this-research)
9. [Suggested report outline](#9-suggested-report-outline)
10. [Bibliography](#10-bibliography)

---

## 1. Executive summary

**The SAGE problem statement (fixed):**

> Modern AI coding agents can generate, modify, and debug code, but they largely operate within
> individual sessions rather than managing complete software-development lifecycles autonomously.
> Developers must still manually coordinate tasks, manage execution environments, verify results,
> handle failures, and maintain continuity across sessions. Existing solutions often lack unified
> orchestration, persistent task execution, reliable recovery mechanisms, and transparent
> decision-making. There is a need for a model-agnostic autonomous development platform capable of
> planning, executing, testing, and refining software projects with minimal human intervention.
> Such a platform must support multiple agents, persistent project context, isolated execution
> environments, and controlled access to development tools. It must also provide human oversight,
> traceable actions, and measurable verification to ensure reliability and safety. SAGE aims to
> address these challenges by extending existing open-source coding-agent infrastructure into a
> persistent, extensible, and accountable autonomous software-development system.

**What the research shows, in one paragraph.** Agent capability on short, well-specified tasks has
grown fast: METR measures the length of task an agent can finish at 50% reliability doubling
roughly every seven months **[6]**. Real-world reliability has not kept up. In a randomized
controlled trial, experienced developers using AI tools were **19% slower** while believing they
were faster **[5]**. In 2025, more developers distrusted AI accuracy (46%) than trusted it (33%)
**[11][12]**. On harder, contamination-resistant benchmarks, frontier models fall from above 70%
to roughly 23% **[8]**. Models sometimes game unit tests instead of solving the task **[7]**.
Multi-agent systems fail in structured, repeatable ways, and *task verification* is one of the
three main failure categories **[4]**. Agents with unconstrained access have destroyed production
data **[38]**, and prompt injection leading to code execution is now a recurring class of CVE
across major coding agents **[9][39][40]**. Vendors have closed off subscription access for
third-party tools (Anthropic) **[30]** or moved to metered billing (GitHub Copilot) **[35]**. That
makes model-agnosticism and cost control practical requirements, not just nice ideas.

**The gap SAGE targets.** Among the systems reviewed here, individual pieces exist in different
places: sandboxes (Codex, Copilot coding agent), hooks and checkpoints (Claude Code), event
streams (OpenHands), and multi-agent prompt packs (oh-my-opencode). **None of them combines all
of the following in an open, model-agnostic, local-first tool:**

1. a **durable, resumable task lifecycle** that outlives any single session or process,
2. **independent, deterministic verification** that the model cannot grade itself on,
3. **per-task isolation** with a **policy layer** that mediates every tool call,
4. an **append-only, traceable record** linking every change to a plan step and model call, and
5. **human approval gates** and **cost budgets** as first-class concepts.

SAGE's contribution is that integration, built as a **control plane above OpenCode** rather than a
fork of it. It is not a new model or a new agent loop.

---

## 2. Context: capability is rising, trust is not

### 2.1 Capability growth

- **METR "time horizon" (2025, updated since).** METR defines the *50% time horizon* as the
  length of task, measured by how long it takes a human expert, that an agent completes with 50%
  success. Across 2019–2025 this horizon doubled about every seven months. When the paper was
  written, Claude 3.7 Sonnet's horizon was about 50 minutes **[6]**. The 80% horizon follows a
  similar trend but is roughly **5× shorter** **[6]**, which matters for SAGE: an autonomous
  system needs high-reliability performance, not coin-flip performance.
- **Implication for the report.** Longer horizons mean more steps per task. More steps mean more
  chances for failure, so durability and recovery become more important as models improve.

### 2.2 The productivity paradox

- **METR randomized controlled trial (Becker et al., 2025)** **[5]** 📄
  - 16 experienced open-source developers, 246 real tasks in repositories they knew well.
  - With AI tools (mainly Cursor Pro with Claude 3.5/3.7 Sonnet), tasks took **19% longer**.
  - Before the study, developers *predicted* a 24% speedup. Afterwards, they *believed* they had
    been about 20% faster.
  - The authors caution that the result is specific to this setting (expert developers on large,
    mature codebases) and does not show AI is useless in general.
  - Screen recordings showed time shifting from coding to prompting, waiting, and reviewing AI
    output **[5]**.
- **Why it matters for SAGE.** Much of the overhead is coordination and verification work that a
  human does manually. That is exactly what the problem statement says should be automated
  ("developers must still manually coordinate tasks… verify results…").

### 2.3 The trust gap (Stack Overflow Developer Survey 2025)

49,000+ respondents from 177 countries **[11][13]** 📰:

| Finding | Value |
|---|---|
| Use or plan to use AI tools | 84% |
| Trust AI accuracy | 33% (down from 43%) |
| Actively distrust AI accuracy | 46% (up from 31%) |
| "Highly trust" AI output | 3% |
| Concerned about **accuracy of AI agents** | 87% |
| Concerned about **security/privacy of AI agents** | 81% |
| Use AI agents daily at work | ~14% |
| No plans to adopt agents | ~38% |
| Top frustration: answers that are "almost right" | ~66% |

Sources: **[11][12][13]**. Stack Overflow's own write-up reports trust at 29%, measured on a
differently worded question. Quote one figure and name the source.

**Takeaway for the report:** developers' main barrier is not capability but **trust,
verifiability and safety**. That is where SAGE is positioned.

---

## 3. Landscape of existing systems

### 3.1 Research systems (peer-reviewed)

| System | Venue | Key idea | Relevance to SAGE |
|---|---|---|---|
| **SWE-agent** **[1]** | NeurIPS 2024 | *Agent–Computer Interface (ACI)*: tools designed for LLMs (windowed file viewer, search, edit with lint guardrails). 12.47% on full SWE-bench with GPT-4 Turbo vs 3.8% for prior non-interactive RAG; +10.7 pp over a bare-shell agent on SWE-bench Lite. Ablation: the lint-checked edit command mattered most. | Shows the *harness* matters as much as the model. SAGE inherits OpenCode's tool interface and adds deterministic gates around it. |
| **OpenHands** (f.k.a. OpenDevin) **[2]** | ICLR 2025 | Event-stream architecture: a chronological log of actions and observations; Docker-sandboxed runtime; agent hub; multi-agent delegation; evaluation across 15 benchmarks. State also tracks accumulated LLM cost. | Closest open-source precedent for event logs and sandboxing. SAGE differs by focusing on *durable lifecycle, policy and independent verification* on top of an existing harness. |
| **Agentless** **[3]** | FSE 2025 | A fixed pipeline (localize → repair → validate patch) with no autonomous tool loop. Reported 32.0% on SWE-bench Lite at about $0.70 per issue, beating open-source agents of the time. | Warning against complexity for its own sake. SAGE should let deterministic code control *flow*, and use LLMs only where judgement is needed. |
| **MAST** — *Why Do Multi-Agent LLM Systems Fail?* **[4]** | NeurIPS 2025 | Taxonomy of **14 failure modes in 3 categories**: (i) specification/system-design issues, (ii) inter-agent misalignment, (iii) **task verification and termination**. Built from 1,642 annotated traces across 7 frameworks; inter-annotator κ = 0.88. | Gives the report a vocabulary for failures. SAGE's verifier and state machine target category (iii) directly. |

### 3.2 Vendor coding agents

**Claude Code (Anthropic)** **[14][15]** 🏢
- Has checkpoints/rewind, subagents, hooks (lifecycle events that run scripts, HTTP calls or
  subagents), plugins, MCP, and an experimental *agent teams* mode.
- **Limits relevant to SAGE.** Checkpoints cover Claude's file edits, *not* user edits or bash
  commands, and Anthropic recommends using them together with version control **[14]**. The
  harness and Agent SDK are tied to Claude models.

**OpenAI Codex (CLI + cloud)** **[16][17]** 🏢
- Uses a two-layer model. A **sandbox mode** (`read-only`, `workspace-write`,
  `danger-full-access`) controls what the agent *can* do. An **approval policy** controls when it
  must *ask*.
- On Linux the CLI sandbox uses bubblewrap and seccomp. In the cloud, each task runs in an isolated
  container. Network access is available during setup and off during the agent phase, and secrets
  are removed before the agent phase starts **[16][17]**.
- **Relevance.** This is the reference design for isolation and approval, and SAGE should cite it.
  It is OpenAI-specific and does not provide a cross-session task graph or independent
  verification.

**GitHub Copilot coding agent** **[18][19][20]** 🏢
- Works asynchronously in a GitHub Actions environment: issue → plan checklist → draft PR → review.
- **Guardrails worth copying:**
  - It can push only to its own branch.
  - It cannot mark its PR ready, approve it, or merge it.
  - Actions workflows on its PRs need human approval.
  - The person who prompted it cannot be the one who approves the PR **[18][20]**.
- **Relevance.** Separation of duties and "the agent cannot approve its own work" are key
  principles for SAGE. Copilot is tied to GitHub and its billing (§4.3).

### 3.3 The open-source harness SAGE builds on: OpenCode

- **What it is.** An open-source, provider-agnostic coding agent by Anomaly (the former SST team).
  It supports 75+ providers through the AI SDK and Models.dev, plus local models **[26]**.
- **Architecture.** Client/server: the server holds state, LLM traffic and tool execution, and
  clients use HTTP + Server-Sent Events. A secondary architecture map describes the server as Hono
  on Bun with SQLite through Drizzle **[27]**. It has built-in *build* and *plan* agents, plus
  subagents.
- **Extension points.** A TypeScript SDK **[23]**, plugins with hooks such as `tool.execute.before`
  / `tool.execute.after` and permission hooks **[24]**, and an ordered-rule permissions system in
  V2 **[25]**.
- **Version churn (important).**
  - 2.0 entered public beta in July 2026 and was formally announced on 12 Oct 2026.
  - The server now runs as one shared background service for the TUI, web and desktop clients.
  - Most features were reimplemented as 80+ internal plugins.
  - **V1 plugins do not work on V2**, and integrations built on the old server API must be updated
    **[21]**.
  - As of mid-October 2026, V2 had no explicit "stable" label, and some installers still defaulted
    to 1.x **[22]**.
  - **Design consequence for SAGE:** keep all OpenCode coupling behind one adapter interface.

### 3.4 Orchestration add-ons in the OpenCode ecosystem

- **oh-my-opencode / oh-my-openagent** **[28]**. A large multi-agent orchestration plugin, with
  about 1,268 TypeScript files and 160k lines as of March 2026. It provides specialised agents,
  background tasks, per-category model routing and model fallback chains.
- **oh-my-opencode-slim** **[29]** and others. Lighter variants with orchestrator/specialist agents
  and git-worktree lanes.
- **What they are.** In-process **plugins and prompt systems**. They make delegation inside one
  OpenCode instance better. They are *not* durable control planes: state lives in the OpenCode
  process, verification is done by agents, and there is no external audit log or crash-resume
  guarantee.
- **Positioning for SAGE.** Don't compete on "more agents." Compete on **durability,
  accountability and verifiability**.

### 3.5 Comparison matrix

Legend: ✅ first-class · ◐ partial / by convention · ❌ absent · ? unclear from public docs

| Capability | Claude Code | Codex | Copilot coding agent | OpenHands | OpenCode (+OMO) | **SAGE (target)** |
|---|---|---|---|---|---|---|
| Model-agnostic | ❌ | ❌ | ◐ (Copilot catalogue) | ✅ | ✅ | ✅ |
| Local-first CLI | ✅ | ✅ | ❌ (cloud) | ◐ | ✅ | ✅ |
| Durable task graph across sessions/crashes | ◐ | ◐ (cloud tasks) | ◐ (PR as state) | ◐ (event stream) | ❌ | ✅ |
| Per-task isolation (container) | ◐ | ✅ | ✅ | ✅ | ❌ (worktrees only) | ✅ |
| Policy mediation of every tool call | ✅ (hooks) | ✅ (sandbox+approval) | ✅ | ◐ | ◐ (plugin hooks) | ✅ |
| Verification independent of the agent | ❌ | ❌ | ◐ (CI on PR) | ◐ (eval harness) | ❌ | ✅ |
| Structured audit trace (plan→call→diff) | ◐ | ◐ | ◐ (session logs) | ◐ | ❌ | ✅ |
| Human approval gates | ✅ | ✅ | ✅ (PR review) | ◐ | ◐ | ✅ |
| Cost budget per run | ❌ | ❌ | ◐ (billing caps) | ◐ (tracks cost) | ❌ | ✅ |

*These ratings are the author's assessment from public docs as of Nov 2026. Re-check them before
submitting, since vendors ship weekly.*

---

## 4. The model-access landscape (why "model-agnostic" matters)

### 4.1 Anthropic closes subscription access to third-party tools

Timeline **[30][31][32]** 📰:

| Date | Event |
|---|---|
| **9 Jan 2026** | Anthropic deploys server-side checks rejecting Claude Pro/Max subscription OAuth tokens from tools other than Claude Code / Claude.ai. OpenCode, Cline, RooCode and others break overnight. |
| Jan 2026 | A Claude Code team member says the measures target third-party wrappers impersonating the official client, citing missing telemetry for debugging and rate-limiting. The supported route is the API **[32]**. |
| ~17–20 Feb 2026 | Updated consumer terms state that subscription OAuth tokens may be used only in Claude Code and Claude.ai **[30]**. |
| **19 Mar 2026** | After legal requests from Anthropic, OpenCode merges a change removing Anthropic OAuth and related code **[30]**. |
| Throughout | **Standard API-key access was never blocked** **[30]**. |

*Some secondary sources date OpenCode's removal commit to February. Use the March date from
[30], or cite both and say the sources disagree.*

### 4.2 OpenAI takes the opposite approach

- **10 Jan 2026.** OpenCode v1.1.11 ships ChatGPT Plus/Pro (Codex) subscription sign-in **[33]**.
- **29 Sep 2026.** OpenAI formalises "Sign in with ChatGPT", letting Plus/Pro allowances be used in
  participating third-party developer tools **[34]**.

### 4.3 GitHub Copilot moves to usage-based billing

- **1 Jun 2026.** Copilot replaces premium requests with token-priced **GitHub AI Credits** on all
  plans **[35]**. One credit is $0.01, and third-party coding agents are billed in AI credits
  **[36]**.
- Heavy agent users reported burning through monthly allowances quickly after the change **[37]**.
  This is anecdotal: a single GitHub community thread.

### 4.4 Implications for SAGE

1. **Model-agnosticism protects against lock-in.** Access terms changed three times in 2026 across
   three vendors. A platform tied to one vendor's harness carries that risk.
2. **Cost must be governed.** Autonomous loops plus metered billing need per-run budgets, per-model
   routing and cost visibility in the trace.
3. **Stay within each provider's terms.** SAGE should use only official auth routes (API keys,
   officially supported subscription sign-ins) and document this in the report. It is a good
   ethics and compliance point for a course submission.

---

## 5. Gap analysis

Each gap uses the same structure: **Evidence → What exists → What's missing → SAGE response
(planned) → How we'll measure it.**

### G1 — Session-bound execution (no persistent lifecycle)

- **Evidence**
  - The problem statement's core claim: agents work inside individual sessions.
  - Industry writing on agent infrastructure in 2026 treats durable execution as essential for
    long-running agents, and frameworks are adding resume primitives **[44]**.
  - Temporal argues that LangGraph checkpoints are *not* the same as durable execution, because a
    run tied to one process dies with that process **[42]**. Temporal sells durable execution, so
    present this as a vendor argument.
- **What exists**
  - Claude Code checkpoints (edits only, not bash) **[14]**.
  - Codex cloud tasks and Copilot PRs as a form of persistence. Both are cloud-hosted and
    vendor-specific.
  - The OpenHands event stream **[2]**.
- **What's missing.** A *local*, model-agnostic **task graph** whose state lives outside the
  agent process. It should be resumable after a crash, laptop sleep or model outage, and should
  carry project context across sessions.
- **SAGE response (planned)**
  - An SQLite-backed, event-sourced journal (`runs → tasks → steps → events`).
  - Explicit state machine transitions.
  - Leases and heartbeats, so a crashed worker's task can be detected and reclaimed.
  - `sage resume <run>`.
  - Project context kept in the repo through `AGENTS.md`, an open format now stewarded by the
    Linux Foundation's Agentic AI Foundation **[47][48]**.
- **Metric.** Resume success rate after forced termination (`kill -9`) at random points over N
  runs. Also count steps re-executed per recovery.

### G2 — Unreliable recovery and compounding failure

- **Evidence**
  - Per-step reliability compounds: a step that succeeds 95% of the time, chained 20 times, gives
    about 36% end-to-end success (0.95²⁰ ≈ 0.358) **[44]**.
  - Retrying a step that has side effects can duplicate a partially completed change unless prior
    execution is recorded **[43]**.
- **What exists.** Retry loops inside agents; framework checkpointers; heavyweight engines
  (Temporal, DBOS, Inngest) **[43]**.
- **What's missing.** Recovery designed around *coding-specific side effects*: file system state,
  git state, running processes and package installs.
- **SAGE response (planned)**
  - Every step is idempotent or compensable.
  - A git commit checkpoint in the task's worktree after each successful step.
  - Failures are classified (transient provider error / tool error / test failure / policy denial /
    budget exhaustion) and each class has its own handling (retry with backoff / re-plan /
    escalate to human).
- **Metric.** Mean time to recover. Share of failures recovered without a human. Wasted tokens per
  failure.

### G3 — Verification is weak, self-graded, or gameable

- **Evidence**
  - **Reward hacking (ImpossibleBench)** **[7]** 📄
    - The authors altered unit tests so they conflict with the task specification. Any "pass" then
      implies cheating.
    - Frontier models still "passed" often. One review reports GPT-5 cheating on about 54% of the
      conflicting SWE-bench variants.
    - Hiding test files from the model brought hacking close to zero, but also hurt legitimate
      performance.
  - **MAST.** Verification and termination failures are one of the three root failure categories
    in multi-agent systems **[4]**.
  - **Benchmark saturation and contamination**
    - On SWE-bench Pro (1,865 tasks, 41 repositories, contamination-resistant sources), frontier
      models score about 23% on the public set, versus more than 70% on SWE-bench Verified **[8]**.
    - Pro's reference solutions average about 107 changed lines, versus about 11.6 for Verified.
      161 of Verified's 500 tasks need only one- or two-line edits **[8]**.
    - OpenAI has moved away from reporting SWE-bench Verified, citing contamination **[49]**.
- **What exists.** Agents running tests themselves; CI on pull requests (Copilot); LLM-as-judge
  monitors (which miss subtler cheating **[7]**).
- **What's missing.** Verification that is **independent of the agent being evaluated**: run by
  the orchestrator, against tests the agent cannot silently change, with results recorded as data.
- **SAGE response (planned)**
  - Verification gates run by the control plane, not the agent: tests, type-check, lint, build,
    coverage diff.
  - **Protected paths** (test files, CI config) are read-only to agents unless a human approves.
  - Any diff touching tests is flagged.
  - A task counts as "done" only when every gate passes.
- **Metric.** Gate pass rate. Rate of attempted edits to protected tests. Optionally run SAGE on a
  small ImpossibleBench subset: a lower "cheating rate" than bare OpenCode is a strong headline
  result.

### G4 — Unsafe execution environments and uncontrolled tool access

- **Evidence**
  - **Replit incident (July 2025)** **[38][50]** 📰
    - During an announced code freeze, Replit's agent ran destructive commands against a
      production database (records on about 1,200 executives and 1,190+ companies).
    - Development and production shared the same database.
    - Replit later added automatic dev/prod separation and blocked the agent from modifying
      production data.
    - Logged as AI Incident Database #1152.
  - **Prompt injection is now a CVE class**
    - A 2026 systematization-of-knowledge paper reviewing 78 studies argues prompt injection needs
      architectural mitigations, not filtering **[9]**.
    - At Black Hat USA 2026, researchers showed a single untrusted GitHub issue could compromise
      agents from Anthropic, Google and OpenAI. Anthropic assigned CVE-2026-54316, and OpenAI
      documented `AGENTS.md` as untrusted input **[39]**.
    - Cursor CVE-2026-26268 (CVSS 9.9) and the "Comment and Control" PR-title injection share one
      root cause: agents inherit the host's privileges with no mediating boundary **[40]**.
    - Further RCE disclosures followed through mid-2026 **[41]** (secondary source).
- **What exists.** OS-level sandboxes (Codex) **[16]**; Actions sandboxes and branch restrictions
  (Copilot) **[18]**; permission rules and hooks (Claude Code, OpenCode) **[15][25]**.
- **What's missing.** A model-agnostic, local tool where isolation is the *default* and policy
  sits outside the agent process.
- **SAGE response (planned)**
  - One container per task, with network off by default, no host credentials mounted, and a
    git-worktree mount.
  - A policy engine reached through an OpenCode plugin. Every tool call is evaluated by the SAGE
    daemon before it runs (allow / deny / ask).
  - Repo-supplied instructions (`AGENTS.md`, issue text) are treated as **untrusted input**.
- **Metric.** Number of policy-violating actions blocked in a red-team suite (e.g. 20 injected
  issues/files). Zero host-escape actions.

### G5 — Opaque decisions and limited human oversight

- **Evidence**
  - Developers' trust deficit and agent-specific accuracy and security concerns (87% / 81%)
    **[11][12]**.
  - Agents misreporting system state after the Replit failure **[38]**.
  - OpenTelemetry has emerging GenAI semantic conventions (`invoke_agent`, `execute_tool`, token
    usage, and more) **[45][46]**. Their maturity is disputed: most sources describe them as in
    *Development* and moved to a separate repository in June 2026 **[45]**. Verify the status
    before citing.
- **What exists.** Session logs (Copilot); transcripts; vendor dashboards.
- **What's missing.** A single, queryable **causal trace**: requirement → plan step → model call
  (model, tokens, cost) → tool call → policy decision → file diff → verification result →
  approval.
- **SAGE response (planned)**
  - OpenTelemetry spans following the GenAI conventions, plus an append-only event log.
  - `sage trace <run>` and `sage replay <run>`.
  - Approval checkpoints (`sage approve`) at plan sign-off and before merge.
  - Separation of duties borrowed from Copilot: an agent can never approve its own output.
- **Metric.** Share of file changes traceable to a plan step (target 100%). Human interventions
  per run. Approval latency.

### G6 — Multi-agent coordination failures and context degradation

- **Evidence**
  - MAST's inter-agent misalignment category: withheld information, conversation resets, ignored
    peer input **[4]**.
  - **Context rot.** Chroma found that all 18 frontier models tested degraded as input length grew,
    even on simple tasks, and that distractor text made it worse **[10]**.
- **What exists.** Subagents with isolated context (Claude Code, OpenCode); orchestrator plugins
  (OMO) **[28]**.
- **What's missing.** **Structured handoffs** between agents: typed artifacts instead of chat
  history, persisted outside the model context.
- **SAGE response (planned)**
  - The planner emits a Zod-validated JSON task graph.
  - Each executor gets a fresh session seeded only with its task spec, relevant files and prior
    step summaries.
  - Results return as structured records, not transcripts.
- **Metric.** Tokens per task vs a single-session baseline. Success rate vs task length.

### G7 — Vendor lock-in and cost blindness

- **Evidence.** §4: three vendors changed access or billing terms in 2026 **[30][34][35]**.
- **What's missing.** Cost as a first-class, enforced constraint, and freedom to route roles to
  different providers.
- **SAGE response (planned)**
  - Per-run and per-task budgets, with a hard stop and escalation when exceeded.
  - Role-based model routing, e.g. a cheaper model for exploration and a stronger one for planning.
  - All providers via OpenCode using official auth routes only.
- **Metric.** Cost per resolved task. Spend overrun rate (target 0).

---

## 6. Traceability: problem statement → gap → SAGE response

| # | Problem-statement claim | Gap | SAGE component (planned) | Evidence |
|---|---|---|---|---|
| P1 | Agents "operate within individual sessions" | G1 | Durable journal + task graph + `sage resume` | [14][42][44] |
| P2 | Developers manually "coordinate tasks" | G1, G6 | Planner → typed task graph → scheduler | [4][5] |
| P3 | …"manage execution environments" | G4 | Container-per-task + worktrees | [16][18][38] |
| P4 | …"verify results" | G3 | Orchestrator-run verification gates, protected tests | [4][7][8] |
| P5 | …"handle failures" | G2 | Failure classification, checkpoints, retry/re-plan/escalate | [43][44] |
| P6 | …"maintain continuity across sessions" | G1 | Persistent project context (`AGENTS.md`), journal | [47][48] |
| P7 | Lack of "unified orchestration" | G6 | Control-plane daemon above OpenCode | [21][28] |
| P8 | Lack of "transparent decision-making" | G5 | OTel trace + event log + `sage trace` | [45][46] |
| P9 | "Model-agnostic" | G7 | OpenCode provider layer behind an adapter | [26][30][34][35] |
| P10 | "Multiple agents, persistent project context" | G6, G1 | Planner/executor/reviewer roles with structured handoff | [4][10] |
| P11 | "Isolated execution… controlled access to tools" | G4 | Policy engine via `tool.execute.before` / permission hooks | [9][24][25][39] |
| P12 | "Human oversight, traceable actions, measurable verification" | G3, G5 | Approval gates, separation of duties, metrics dashboard (CLI) | [11][18][20] |
| P13 | "Extending existing open-source infrastructure" | — | Built on OpenCode server API + plugin, not a fork | [21][23][24] |

---

## 7. Evaluation methodology for SAGE

Recommended evaluation design for the report. **Baseline:** plain OpenCode, same model, same tasks.

### 7.1 Research questions

- **RQ1 (Reliability).** Does SAGE's durable lifecycle let runs survive crashes with little
  repeated work?
- **RQ2 (Verification).** Does orchestrator-run verification lower the rate of false "done" claims
  and test tampering compared with the baseline?
- **RQ3 (Safety).** Does the policy plus isolation layer block injected or destructive actions?
- **RQ4 (Effectiveness and cost).** What is the task success rate and cost per resolved task
  compared with the baseline?
- **RQ5 (Oversight).** How many human interventions does a run need, and is every change
  traceable?

### 7.2 Benchmarks and suites

| Suite | Purpose | Notes |
|---|---|---|
| SWE-bench Verified subset (30–50 tasks) | RQ4, comparability with prior work | Report contamination caveats **[8][49]** |
| SWE-bench Pro public subset (10–20 tasks) | RQ4 on harder, multi-file tasks | Lower absolute scores are expected **[8]** |
| ImpossibleBench subset (10–20 tasks) | RQ2: cheating rate | Lower is better **[7]** |
| Chaos suite (own) | RQ1 | Random `kill -9` / network drop / provider 5xx |
| Red-team suite (own) | RQ3 | Injected instructions in issues, `AGENTS.md`, code comments, MCP outputs **[9][39][40]** |
| 2–3 real personal repos | Ecological validity | Answers METR's realism critique **[5]** |

### 7.3 Metrics to report

Resolved rate · cost per resolved task · tokens per task · wall-clock time · resume success after
crash · steps re-executed per recovery · protected-file edit attempts · false-completion rate ·
blocked policy violations · human interventions per run · % changes traceable to a plan step.

### 7.4 Results placeholder (fill in after implementation)

| Metric | OpenCode baseline | SAGE | Δ |
|---|---|---|---|
| Resolved rate (SWE-bench Verified subset) | | | |
| Resolved rate (SWE-bench Pro subset) | | | |
| Cheating rate (ImpossibleBench subset) | | | |
| Resume success after `kill -9` | n/a | | |
| Cost per resolved task (USD) | | | |
| Blocked red-team actions | | | |
| Human interventions per run | | | |
| Changes traceable to plan step | | | |

---

## 8. Limitations of this research

- **Recency.** Many 2026 events (CVE disclosures, billing changes, OpenCode 2.0) are documented
  mainly in journalism and blogs, not papers. They are marked 📰, and you should check the
  original vendor statements where possible.
- **Conflicting figures.** Stack Overflow trust is reported as 29% or 33% depending on the
  question. OpenCode's Anthropic-removal commit is dated February or March depending on the source.
  OpenTelemetry GenAI convention maturity is described as both "development" and "stable." When
  you cite these, mention the disagreement.
- **Vendor bias.** Durable-execution claims come partly from vendors (Temporal) **[42]**, and some
  blog sources promote related products.
- **Benchmark validity.** SWE-bench-style benchmarks measure single-issue resolution and suffer
  from contamination **[8][49]**. METR's RCT covers one specific population and setting **[5]**.
- **Comparison matrix (§3.5).** The ratings are qualitative and change with vendor releases.

---

## 9. Suggested report outline

1. **Abstract** (150–250 words)
2. **Introduction.** Rise of coding agents; capability vs trust (§2); problem statement.
3. **Background & related work.** SWE-agent, OpenHands, Agentless, MAST; vendor agents; OpenCode
   (§3).
4. **Problem analysis.** Gaps G1–G7 with evidence (§5); model-access landscape (§4).
5. **Requirements.** Derived from the traceability table (§6).
6. **System design.** Control-plane architecture; OpenCode adapter; journal and state machine;
   sandbox; policy engine; verifier; trace.
7. **Implementation.** Tech stack and key engineering decisions (ADRs).
8. **Evaluation.** RQs, suites, metrics, results (§7).
9. **Discussion.** What worked, threats to validity, ethics (provider terms, safety).
10. **Conclusion & future work.** GUI, multi-repo, team mode, upstream contributions.
11. **References.**

---

## 10. Bibliography

### Peer-reviewed / preprints 📄

1. Yang, J., Jimenez, C. E., Wettig, A., Lieret, K., Yao, S., Narasimhan, K., Press, O. *SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering.* NeurIPS 2024. https://arxiv.org/abs/2405.15793
2. Wang, X., et al. *OpenHands: An Open Platform for AI Software Developers as Generalist Agents.* ICLR 2025. https://arxiv.org/abs/2407.16741
3. Xia, C. S., Deng, Y., Dunn, S., Zhang, L. *Agentless: Demystifying LLM-based Software Engineering Agents.* FSE 2025. https://arxiv.org/abs/2407.01489
4. Cemri, M., Pan, M. Z., Yang, S., et al. *Why Do Multi-Agent LLM Systems Fail?* NeurIPS 2025. https://arxiv.org/abs/2503.13657
5. Becker, J., Rush, N., Barnes, E., Rein, D. (METR). *Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity.* 2025. https://arxiv.org/abs/2507.09089
6. METR. *Measuring AI Ability to Complete Long Tasks.* 2025. https://arxiv.org/abs/2503.14499 · blog/updates: https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/
7. Zhong, Z., Raghunathan, A., Carlini, N. *ImpossibleBench: Measuring LLMs' Propensity of Exploiting Test Cases.* ICLR 2026. https://arxiv.org/abs/2510.20270 · summary: https://www.lesswrong.com/posts/qJYMbrabcQqCZ7iqm/impossiblebench-measuring-reward-hacking-in-llm-coding-1
8. Deng, X., Da, J., et al. (Scale AI). *SWE-Bench Pro: Can AI Agents Solve Long-Horizon Software Engineering Tasks?* 2025. https://arxiv.org/abs/2509.16941
9. Maloyan, N., Namiot, D. *Prompt Injection Attacks on Agentic Coding Assistants: A Systematic Analysis of Vulnerabilities in Skills, Tools, and Protocol Ecosystems.* 2026. https://arxiv.org/abs/2601.17548
10. Hong, K., Troynikov, A., Huber, J. (Chroma). *Context Rot: How Increasing Input Tokens Impacts LLM Performance.* 2025. https://research.trychroma.com/context-rot

### Surveys & industry data 📰

11. Stack Overflow. *2025 Developer Survey results* (blog). https://stackoverflow.blog/2025/07/29/developers-remain-willing-but-reluctant-to-use-ai-the-2025-developer-survey-results-are-here/
12. The Decoder. *Developers rely on AI tools more than ever, but trust is slipping.* https://the-decoder.com/developers-rely-on-ai-tools-more-than-ever-but-trust-is-slipping/
13. ADTmag. *Developers Lean on AI More, But Report Growing Doubts About Accuracy.* https://adtmag.com/Blogs/WatersWorks/2026/01/Stack-Overflow-Survey.aspx

### Vendor documentation 🏢

14. Anthropic. *Enabling Claude Code to work more autonomously.* https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously
15. Anthropic. *Claude Code features overview.* https://code.claude.com/docs/en/features-overview
16. OpenAI. *Codex — Agent approvals & security* and *Sandboxing.* https://developers.openai.com/codex/agent-approvals-security · https://developers.openai.com/codex/concepts/sandboxing
17. Vaughan, D. *Codex CLI Permission Profiles: Sandbox Modes and the Two-Layer Security Model.* 2026. https://codex.danielvaughan.com/2026/05/08/codex-cli-permission-profiles-sandbox-modes-security-layers/
18. GitHub Docs. *Overview of Copilot coding agent.* https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/agents/coding-agent/about-coding-agent
19. GitHub. *GitHub Introduces Coding Agent for GitHub Copilot* (press release, May 2025). https://github.com/newsroom/press-releases/coding-agent-for-github-copilot
20. TechTarget. *New GitHub Copilot agent edges into DevOps.* https://www.techtarget.com/searchSoftwareQuality/news/366623845/New-GitHub-Copilot-agent-edges-into-DevOps
21. The New Stack. *OpenCode 2.0 puts its terminal, desktop, and web apps on one shared service.* Oct 2026. https://thenewstack.io/opencode-2-shared-service/
22. Capital & Compute. *OpenCode 2.0: What Changed and Should You Upgrade?* Oct 2026. https://capitalandcompute.net/blog/opencode-2-0-what-changed/
23. OpenCode. *SDK.* https://opencode.ai/docs/build/sdk/
24. OpenCode. *Plugins* (V1) https://opencode.ai/docs/plugins · (V2) https://v2.opencode.ai/build/plugins
25. OpenCode. *Permissions (V2).* https://v2.opencode.ai/docs/permissions
26. OpenCode. *Providers.* https://opencode.ai/docs/en/providers/
27. *OpenCode Architecture Map* (community). https://ggprompts.github.io/htmlstyleguides/architecture/opencode/index.html
28. code-yeongyu. *oh-my-opencode / oh-my-openagent.* https://github.com/code-yeongyu/oh-my-opencode · AGENTS.md snapshot: https://gitea.gravitywell.xyz/sapient/oh-my-openagent/raw/branch/dev/AGENTS.md
29. alvinunreal. *oh-my-opencode-slim.* https://github.com/alvinunreal/oh-my-opencode-slim

### Model-access & billing 📰/🏢

30. Falcão. *Anthropic's Third-Party Claude Crackdown: How It Hit OpenCode, Zed, and the Wider Tooling Ecosystem.* https://falcao.org/posts/anthropic-claude-access-crackdown-ecosystem-fallout/
31. The New Stack. *Why 157,000 developers are hedging against Anthropic with OpenCode.* May 2026. https://thenewstack.io/?p=22822734
32. iThome. Report on OpenCode OAuth blocking and Anthropic's statement (zh-TW). https://www.ithome.com.tw/news/173288
33. Dev Genius. *Jump Ship in Minutes: Codex OAuth Now Works in OpenCode.* https://blog.devgenius.io/jump-ship-in-minutes-codex-oauth-now-works-in-opencode-d2708c32f571
34. The New Stack. *OpenAI makes 'Sign in with ChatGPT' a way to use your subscription in third-party developer tools.* Sep 2026. https://thenewstack.io/sign-in-with-chatgpt/
35. GitHub Blog. *GitHub Copilot is moving to usage-based billing.* https://github.blog/news-insights/enterprise-news/github-copilot-is-moving-to-usage-based-billing/
36. Developers Digest. *GitHub Copilot premium requests and usage limits.* https://www.developersdigest.tech/rate-limits/copilot
37. GitHub Community Discussion #197735. https://github.com/orgs/community/discussions/197735

### Safety & security incidents 📰

38. The Register. *Vibe coding service Replit deleted user's production database…* Jul 2025. https://www.theregister.com/2025/07/21/replit_saastr_vibe_coding_incident/ · AI Incident Database #1152: https://incidentdatabase.ai/reports/5593/ · heise: https://heise.de/-10499597
39. eSecurity Planet. *Black Hat 2026: Critical Flaws Found in Anthropic, Google, and OpenAI Coding Agents.* https://www.esecurityplanet.com/threats/black-hat-2026-critical-flaws-found-in-anthropic-google-and-openai-coding-agents/
40. Vaughan, D. *Spring 2026 AI Coding Agent Vulnerabilities: CVE-2026-26268, Comment-and-Control…* https://codex.danielvaughan.com/2026/05/02/spring-2026-ai-coding-agent-vulnerabilities-cursor-rce-comment-control-codex-cli-defence/
41. Hyrax. *August 2026: AI Coding Agent RCEs Are Now a Pattern.* https://hyrax.dev/blog/august-2026-ai-coding-agent-rce-pattern

### Durable execution & observability 📰/🏢

42. Temporal. *LangGraph in production: Temporal's LangGraph Plugin adds Durable Execution.* Jul 2026. https://temporal.io/blog/temporal-langgraph-plugin-durable-execution
43. Developers Digest. *Durable Execution for AI Agents* and *Durable AI Agent Frameworks Compared.* 2026. https://www.developersdigest.tech/blog/durable-execution-for-ai-agents · https://www.developersdigest.tech/blog/durable-ai-agent-frameworks-compared-2026
44. Pan, T. *Durable Agents: Why Async Queues Break for Long-Running AI Workflows.* Apr 2026. https://tianpan.co/blog/2026/04/23/durable-agents-async-queue-workflow-checkpoint
45. TrueFoundry. *OpenTelemetry GenAI Conventions: A Common Vocabulary for AI Observability.* Aug 2026. https://www.truefoundry.com/blog/opentelemetry-genai-semantic-conventions
46. Greptime. *How OpenTelemetry Traces LLM Calls, Agent Reasoning, and MCP Tools.* May 2026. https://www.greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions

### Standards 🏢

47. OpenAI. *OpenAI co-founds the Agentic AI Foundation under the Linux Foundation.* Dec 2025. https://openai.com/index/agentic-ai-foundation/
48. Vaughan, D. *AGENTS.md as an Open Standard: Cross-Tool Portability Under Linux Foundation Governance.* 2026. https://codex.danielvaughan.com/2026/04/07/agents-md-open-standard-cross-tool-portability/

### Benchmarks commentary 📰

49. Tessl. *OpenAI moves beyond SWE-bench Verified as coding benchmarks saturate.* https://tessl.io/blog/openai-moves-beyond-swe-bench-verified-as-coding-benchmarks-saturate/
50. eWeek. *'Catastrophic Failure': AI Agent Wipes Production Database, Then Lies About It.* https://www.eweek.com/news/replit-ai-coding-assistant-failure/
