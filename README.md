# TMSH

TMSH (“the most simplest harness”) is a thin, local-first execution substrate
for capable AI models. It supplies interfaces and observed feedback; the model
supplies task planning, decomposition, tool choice, model selection, recovery,
verification, and stopping decisions.

The resident behavioral instruction is [`TMSH.md`](TMSH.md). It requires a
research-first project bootstrap, project-local `AGENTS.md` and narrow skills,
evidence-bound verification, and exact preservation across context compaction.

## What is included

- OpenAI, Anthropic, OpenAI-compatible, and deterministic fake model adapters.
- A model-visible roster plus bounded `model.delegate`; no fixed router.
- One append-only JSONL event stream for CLI, HTTP/SSE, MCP, and TUI feedback.
- Structured foreground/background processes with bounded wait, output cursor,
  stdin, timeout, stop, and explicit truncation.
- Bounded HTTP/HTTPS retrieval; raw `curl` remains available through the process
  tool.
- MCP stdio and Streamable HTTP clients with dynamic tool discovery, plus a
  `tmsh mcp` stdio server for controlling runs.
- RE-TRAC narrative compaction paired with a hash-checked lossless sidecar.
- An OpenTUI interface with a functional ANSI fallback when native FFI is not
  available in the current JavaScript runtime.
- A dormant, pinned `adaptive-toolsmith` plugin for genuine reusable capability
  gaps.

TMSH intentionally does not include a workflow DSL, fixed multi-agent graph,
learned router, vector database, editor, web UI, plugin marketplace, or domain
planner.

## Quick start

Requires Node.js 22+ and pnpm.

```sh
pnpm install
pnpm build
cp tmsh.example.json tmsh.local.json
# Set the API-key environment variable named by apiKeyEnv.
pnpm start doctor --config tmsh.local.json
pnpm start tui --config tmsh.local.json --yolo
```

On PowerShell, use `Copy-Item tmsh.example.json tmsh.local.json`. Local config,
`.env*`, run events, compaction artifacts, and toolsmith work directories are
ignored by Git.

The checked example uses the current DeepSeek V4 Flash OpenAI-compatible model.
Credentials are referenced only by environment-variable name; values are not
placed in model descriptors or event logs.

## CLI

```text
tmsh run "goal" [--model ID] [--workspace PATH] [--yolo] [--config PATH]
tmsh tui ["initial goal"] [--model ID] [--workspace PATH] [--yolo]
tmsh serve [--yolo] [--config PATH]
tmsh mcp [--config PATH]
tmsh models | tools | doctor [--config PATH]
```

The TUI exposes `/model`, `/models`, `/compact`, `/cancel`, `/runs`, and `/quit`.
Its header always shows `CONFIRM` or `YOLO`.

## YOLO mode

`--yolo` is an explicit autonomy mode: mutating and external tool calls proceed
without per-call approval. It does not disable event evidence, context-ledger
validation, credential-by-environment references, time/byte/call limits, or
loopback API binding.

YOLO is not an operating-system sandbox. A launched command has the permissions
of the TMSH process, and command arguments can reference paths outside the
workspace. Use an OS/container sandbox when containment is required. The
default mode is `confirm`.

## Context compaction

For a known model capacity, automatic mode computes:

```text
usable = maxInputTokens - (reservedOutputTokens ?? model.maxOutputTokens ?? 4096)
soft   = triggerTokens ?? floor(usable * triggerRatio)  # default 0.75
hard   = floor(usable * hardRatio)                      # default 0.90
```

The model may compact earlier. At the soft boundary it chooses between
compaction and one bounded final step; at the hard boundary the runtime requires
compaction before the next normal turn. Unknown capacity disables ratio-based
automation instead of guessing. Modes are `auto`, `manual`, and `off`.

The active model writes the RE-TRAC narrative by default. Set
`compaction.modelId` to use another registered model, such as a low-cost
DeepSeek model. The runtime—not the summarizer—attaches and validates:

1. exact scientific objectives and assumptions;
2. literal numerical values, units, parameters, methods, and evidence;
3. approximate-versus-oracle discrepancies;
4. failed hypotheses, outcomes, and reasons;
5. modified files and observed Git state;
6. unresolved correctness risks;
7. the precise next verification step.

A missing ID, changed canonical value, invalid digest, or mismatched event
boundary rejects the candidate. Old context is replaced only after atomic
artifact persistence succeeds.

## HTTP/SSE API

`tmsh serve` binds to loopback by default.

- `GET /health`
- `GET /v1/models`, `GET /v1/tools`
- `POST /v1/runs`, `GET /v1/runs`, `GET /v1/runs/:id`
- `GET /v1/runs/:id/events`
- `GET /v1/runs/:id/events/stream?after=<seq>`
- `POST /v1/runs/:id/approvals/:toolCallId`
- `POST /v1/runs/:id/cancel`

## Development and evidence

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

Architecture decisions live in [`docs/adr`](docs/adr), and the accepted design
and implementation record live in [`docs/plans`](docs/plans). The dormant
plugin provenance is recorded in
[`plugins/adaptive-toolsmith/PROVENANCE.md`](plugins/adaptive-toolsmith/PROVENANCE.md).

## License

MIT. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for vendored and
runtime dependency notices.
