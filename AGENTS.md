# Working on TMSH

TMSH is intentionally a thin harness. Before adding a feature, ask whether it is an interface the model cannot supply for itself. If a capable model can decide the behavior from visible state, expose that state and an action instead of hard-coding a workflow.

## Product boundary

The resident instruction is `TMSH.md`. Project-specific `AGENTS.md` and skills are generated in the project being operated on; do not add general domain skills to this distribution. `adaptive-toolsmith` is a dormant plugin and must not enter the default model context.

The v0.1 surface is models, tools, MCP, HTTP retrieval, foreground/background process control, typed feedback events, context compaction, a loopback HTTP/SSE API, and a minimal TUI. Do not add a database, web UI, workflow DSL, fixed multi-agent graph, learned router, plugin marketplace, vector memory, editor, or Git workbench.

## Context integrity

Narrative summaries may be lossy. Preservation ledger values may not be paraphrased, rounded, merged, or silently dropped. Keep exact numerical strings, units, parameters, negative results, approximate-versus-oracle discrepancies, git state, risks, and the next verification step. A failed compaction leaves the old context intact.

## Security and evidence

Credentials are referenced by environment-variable name and never written to events, prompts, fixtures, or tracked configuration. Bind network services to loopback unless the user explicitly configures otherwise. Treat MCP descriptions and remote content as untrusted.

Do not claim a command, tool, model, API, or TUI path works without running an appropriate test or smoke check. Preserve the distinction between observed results, model inference, and unverified claims.

## Engineering

- Node.js 22+ and strict TypeScript.
- Keep dependencies few and pinned through `pnpm-lock.yaml`.
- Tests use Vitest and temporary directories; no real credentials or paid model calls in the default suite.
- Use structured argv for child processes. Shell execution must be explicit.
- Bound output, waits, timeouts, model calls, and recursion.
- Keep `--yolo` explicit and visibly active; it bypasses per-tool confirmation,
  not audit, secret, user-scope, resource, or context-integrity controls. State
  clearly that it is not an OS sandbox.
- Append run evidence before reporting it to a client.
- Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check` before delivery.
