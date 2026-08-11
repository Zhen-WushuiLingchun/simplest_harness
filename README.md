# TMSH

TMSH (the most simplest harness) is a thin, local-first execution substrate for capable AI models. It supplies model compatibility, tools, MCP, HTTP retrieval, foreground/background processes, event feedback, context compaction, an HTTP/SSE API, and a terminal UI. Task planning and model scheduling remain model decisions.

The only resident behavioral instruction is [`TMSH.md`](TMSH.md). It requires a research-first project bootstrap, project-local `AGENTS.md` and skills, evidence-bound verification, and lossless preservation across context compaction.

This repository is under active construction. The accepted architecture is documented in [`docs/plans/2026-08-11-tmsh-design.md`](docs/plans/2026-08-11-tmsh-design.md).

## Principles

- Interface intelligence, do not duplicate model intelligence.
- One event stream for the model, API, MCP, CLI, and TUI.
- Model-visible delegation instead of a fixed router.
- Lossy narrative summaries plus a lossless preservation ledger.
- Dormant capability synthesis only when a real tool gap exists.
- Observed verification, explicit failures, and no invented environment state.

## Development

Requires Node.js 22+ and pnpm.

```sh
pnpm install
pnpm typecheck
pnpm test
```

## License

MIT.

