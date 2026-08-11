# TMSH: the most simplest harness

## Status

Accepted for implementation on 2026-08-11.

## Product boundary

TMSH is a thin execution substrate for capable models. It provides compatible model APIs, a model-visible tool registry, MCP, HTTP retrieval, foreground/background processes, durable event feedback, context compaction, and a usable TUI. It does not encode a task planner, a fixed multi-agent topology, a learned router, a memory ontology, a workflow DSL, a plugin marketplace, or domain behavior.

The only resident behavioral instruction is `TMSH.md`. On first work in a project, the model must inspect the project, research the relevant technical and domain material online, and create or update project-specific `AGENTS.md` and `.agents/skills/`. Those generated files belong to the opened project rather than to the harness distribution.

`adaptive-toolsmith` is a dormant bundled plugin. It is activated only when the agent identifies a genuine capability gap. It is not loaded into every model context.

## Functional requirements

1. Register multiple user-configured models without placing credentials in prompts or tracked files.
2. Let the active model inspect the model roster and delegate a bounded task to any registered model.
3. Expose one tool contract to provider-native function calling, MCP, the HTTP API, and the TUI.
4. Run commands in the foreground or background and support bounded wait, output polling, stdin, cancellation, and termination.
5. Retrieve web content through a bounded HTTP interface; raw `curl` remains available through the process tool.
6. Persist every run as append-only JSONL events and reconstruct current run state without a database.
7. Compact long contexts automatically or on model/user request without losing the preservation ledger.
8. Provide a local HTTP/SSE API and an OpenTUI terminal client over the same runtime.

## Non-functional requirements

- Local-first and single-user in v0.1. The server binds to loopback by default.
- Cross-platform on Windows, Linux, and macOS under Node.js 22 or newer.
- A run must remain recoverable after process interruption from its event log and latest compaction artifact.
- Secrets are referenced by environment-variable name. Secret values are never serialized to events.
- Tool output is bounded by bytes and time. Truncation is explicit and recoverable through later polling.
- No tool, model, or compaction result is reported as successful without an observed result event.
- The runtime must remain useful with one model and no MCP servers.

## High-level architecture

```text
OpenTUI client ─┐
HTTP/SSE API ───┼──> Run core ──> Model registry ──> provider adapters
MCP server ─────┘       │
                       ├──> Tool registry ──> process / http / MCP client / model delegate
                       ├──> Context compactor plugin
                       └──> .tmsh/runs/<id>/events.jsonl
```

The run core is an event loop, not a workflow engine. A model response may emit text, tool calls, a delegation request, an early compaction request, or completion. The runtime executes valid requests, appends observed results, and asks the model what to do next. Only budgets, permissions, concurrency, context safety, and cancellation are runtime policy.

## Model-directed scheduling

The model roster exposes identifiers, provider, context capacity, supported modalities, tool support, user-authored capability notes, relative cost, and availability. `model.list` returns this roster. `model.delegate` accepts a registered model ID, a bounded task, an optional compact context payload, and a budget. The caller remains responsible for synthesizing the result.

This is autonomous model scheduling without a hard-coded router. Each decision is logged with harness state, selected model, usage, result status, and cost when the provider reports it. A learned router may later consume these records, but it is outside v0.1.

## Context compaction plugin

### Why a hybrid trigger

There is no universal useful-context ratio across models and workloads. Current provider APIs expose explicit thresholds: OpenAI supports `compact_threshold`, and Anthropic exposes an input-token trigger with a current default of 150,000 and minimum of 50,000. Long-context research also shows task- and model-dependent retrieval behavior. Therefore TMSH uses a model-relative default with absolute and manual overrides rather than claiming one universal sweet spot.

### Trigger policy

For a model with known input capacity:

```text
usable_input = max_input_tokens - reserved_output_tokens
soft_trigger = user.tokens ?? floor(usable_input * user.ratio ?? 0.75)
hard_trigger = floor(usable_input * user.hard_ratio ?? 0.90)
```

Modes are `auto`, `manual`, and `off`. In `auto`, the model may invoke `context.compact` before the soft threshold. At or above the soft threshold the runtime asks the model whether to compact now or finish a bounded step first. At or above the hard threshold the runtime compacts before another normal model turn. An absolute user threshold wins over a ratio. If model capacity is unknown, automatic ratio triggering is disabled rather than guessed; manual compaction remains available.

### Lossless sidecar

A narrative summary is lossy by design. TMSH therefore separates:

- `summary`: compressed analytical continuity, including RE-TRAC conclusions, evidence, uncertainties, failed attempts, uncompleted proposals, and discarded possibilities;
- `ledger`: exact preservation records that the compactor cannot paraphrase;
- `recent_tail`: a configurable number of recent turns kept verbatim;
- `source`: hashes and event boundaries proving what was compacted.

The preservation ledger contains stable IDs and canonical JSON values for:

1. exact scientific objective and assumptions;
2. validated numerical results with literal values, units, parameter values, method, and evidence;
3. discrepancies between approximate and oracle implementations;
4. failed hypotheses and why they failed;
5. modified files and exact current git state;
6. unresolved correctness risks;
7. precise next verification step.

Negative results are first-class ledger entries. The plugin rejects a candidate if any live ledger ID is absent, any canonical value changes, any required section is missing, or the source event/hash boundary does not match. The old context is pruned only after the artifact is written atomically and validated.

Git state is collected by the runtime through read-only commands. Scientific entries are supplied and maintained by the model through `context.ledger.upsert`; the runtime validates shape and immutability across compaction but does not judge scientific truth.

### Failure behavior

- Threshold unknown: emit `context.compaction.skipped` with `unknown_model_capacity`.
- Summarizer fails or returns invalid structure: keep the old context, emit a failed event, and retry only when the model or user requests it.
- Ledger mismatch: fail closed and keep the old context.
- Git unavailable: preserve an explicit `unavailable` record; never invent repository state.
- Context reaches the provider limit before a valid compaction: stop the run with a recoverable error and the exact next action.

## Minimal TUI

The TUI has a transcript, a bottom composer, and a collapsible run-status panel. It shows the active model, context use and thresholds, current tool/process, compaction status, and budget. It supports run selection, model selection, cancel, and manual compact. It does not include a file tree, editor, diff workbench, dashboard, or web UI.

## Verification

- Unit tests for threshold precedence and boundary conditions.
- Property tests that compaction cannot change or drop ledger records.
- Failure tests for invalid summaries, unknown capacity, git unavailability, and interrupted atomic writes.
- Process integration tests for foreground completion, background wait, output truncation, stdin, timeout, and stop.
- MCP in-memory and stdio client/server smoke tests.
- HTTP/SSE API test that observes the actual event sequence.
- TUI render test plus visual inspection in a real terminal.
- End-to-end fake-model run that delegates, calls a tool, compacts, resumes, and completes.

## Sources

- RE-TRAC: https://arxiv.org/abs/2602.02486
- OpenAI compaction: https://developers.openai.com/api/docs/guides/compaction
- Anthropic compaction: https://platform.claude.com/docs/en/build-with-claude/compaction
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- OpenTUI: https://github.com/anomalyco/opentui
- OpenCode server design: https://dev.opencode.ai/docs/server/
- Harness-native routing: https://arxiv.org/abs/2607.11399

