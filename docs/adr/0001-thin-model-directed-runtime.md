# ADR-0001: Use a thin model-directed runtime

## Status

Accepted.

## Context

The project is intended to expose model, tool, process, network, MCP, feedback, and terminal interfaces while leaving task decomposition and orchestration to capable models. Forking a full coding agent would import unrelated planning, editor, workflow, and product policy. A new Go runtime would require rebuilding provider and MCP compatibility that already exists in maintained TypeScript libraries.

## Decision

Use TypeScript on Node.js 22+ with a single run core and append-only events. Use provider adapters rather than a fixed router. Expose model delegation as a tool. Use the official MCP TypeScript SDK and OpenTUI. Keep the HTTP server on loopback by default and use it as the common interface for TUI and external clients.

Provide an explicit `--yolo` autonomy mode. In this mode workspace-scoped
mutating tool calls do not require per-call confirmation. It does not disable
event evidence, secret handling, resource limits, context integrity checks, or
network/filesystem boundaries, and it is visibly marked in the TUI.

## Consequences

### Positive

- The harness stays small and model-directed.
- Provider, MCP, and TUI compatibility use maintained upstream libraries.
- All clients observe the same event stream.

### Negative

- Native provider features require adapter-specific escape hatches.
- OpenTUI adds a native runtime dependency.
- A Node distribution is required.

### Neutral

- v0.1 is local and single-user rather than a distributed service.

## Alternatives considered

- Fork OpenCode: rejected because its full product surface violates the project boundary.
- Go single binary: rejected for v0.1 because model and MCP adapter work would dominate the harness.
- Python/Textual: rejected because the desired TUI lineage and provider ecosystem are stronger in TypeScript.

## References

- https://github.com/anomalyco/opentui
- https://dev.opencode.ai/docs/server/
- https://github.com/modelcontextprotocol/typescript-sdk
