# TMSH Initial Harness Implementation Plan

**Goal:** Build the smallest runnable model-directed harness with lossless context compaction, compatible tools, a local API, and a usable TUI.

**Architecture:** A TypeScript run core appends typed events and gives registered models a common tool registry. A context-compactor plugin replaces old narrative history only after preserving an immutable scientific ledger. The TUI and HTTP/MCP surfaces are adapters over the same core.

**Tech Stack:** Node.js 22+, TypeScript, pnpm, Vitest, AI SDK provider adapters, official MCP TypeScript SDK, and imperative OpenTUI with an ANSI fallback.

## Implementation record (2026-08-11)

All eight task outcomes are implemented. Actual module names follow the final
thin-runtime layout (`src/context`, `src/runtime`, `src/api`, and
`src/tui/app.ts`) rather than every provisional filename below. Notable bounded
changes from the initial plan:

- Added explicit `confirm`/`yolo` autonomy modes and persistent TUI marking.
- Added provider-safe reversible tool aliases after the DeepSeek API rejected
  dotted canonical tool names in a live smoke.
- Added both MCP client discovery and a `tmsh mcp` stdio control server.
- Kept imperative OpenTUI as the preferred renderer, but added a tested ANSI
  fallback because OpenTUI 0.5.1 reported unavailable native FFI under the
  observed Windows Node 24.14.0 runtime.
- Added optional `compaction.modelId`; the active model remains the default.
- Vendored adaptive-toolsmith commit
  `e81705c081557e057215d9453db47c420a6a0ffa` as dormant source only.

Qualification evidence is recorded in the repository history and delivery
report; generated `.tmsh/` events and compaction artifacts remain intentionally
untracked.

---

### Task 1: Repository and instruction boundary

**Files:**

- Create: `.gitignore`
- Create: `LICENSE`
- Create: `README.md`
- Create: `TMSH.md`
- Create: `package.json`
- Create: `pnpm-lock.yaml`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

**Steps:**

1. Add ignore rules for dependencies, builds, `.env*`, `.tmsh/`, generated tools, coverage, and local auth.
2. Write `TMSH.md` with the research-first bootstrap, project-local AGENTS/skills generation, model autonomy, preservation ledger, verification, and adaptive-toolsmith activation contract.
3. Add the minimal Node/TypeScript/Vitest project and install pinned dependencies.
4. Run `git check-ignore` against representative secret and runtime paths; expect every one to be ignored.
5. Run `pnpm typecheck`; expect exit 0.

### Task 2: Core types, config, and append-only events

**Files:**

- Create: `src/core/types.ts`
- Create: `src/core/config.ts`
- Create: `src/core/event-store.ts`
- Create: `src/core/tool-registry.ts`
- Test: `tests/core/config.test.ts`
- Test: `tests/core/event-store.test.ts`
- Test: `tests/core/tool-registry.test.ts`

**Steps:**

1. Write tests for defaults, user override precedence, atomic JSONL append/replay, and duplicate tool rejection.
2. Run those tests and confirm they fail because the modules do not exist.
3. Implement only the types and behavior required by the tests.
4. Rerun the focused tests; expect pass.

### Task 3: Lossless context-compactor plugin

**Files:**

- Create: `src/plugins/context-compactor/schema.ts`
- Create: `src/plugins/context-compactor/threshold.ts`
- Create: `src/plugins/context-compactor/ledger.ts`
- Create: `src/plugins/context-compactor/plugin.ts`
- Create: `src/plugins/context-compactor/git-state.ts`
- Test: `tests/plugins/context-compactor.test.ts`

**Steps:**

1. Test token/rate/manual/off trigger behavior at exact soft and hard boundaries.
2. Test stable canonical hashes for objectives, numerical values with units and parameters, oracle discrepancies, failed hypotheses, git state, risks, and next verification.
3. Test that a missing ID, changed canonical value, vague replacement of a number, missing negative result, or mismatched source boundary rejects compaction and preserves old history.
4. Test an accepted artifact retains the configured recent tail and writes atomically.
5. Implement the minimum plugin to pass these tests.

### Task 4: Foreground/background process and HTTP tools

**Files:**

- Create: `src/tools/process-tool.ts`
- Create: `src/tools/http-tool.ts`
- Test: `tests/tools/process-tool.test.ts`
- Test: `tests/tools/http-tool.test.ts`

**Steps:**

1. Test foreground completion, yielded background handle, bounded wait, incremental output, stdin, timeout, stop, and explicit truncation.
2. Test HTTP method, headers, body, timeout, maximum response bytes, content type, and non-2xx responses.
3. Implement with `node:child_process` and `fetch`, without invoking a shell unless the caller explicitly selects one.
4. Rerun focused tests; expect pass and no orphan process.

### Task 5: Models, delegation, MCP, and agent loop

**Files:**

- Create: `src/models/registry.ts`
- Create: `src/models/gateway.ts`
- Create: `src/models/fake-provider.ts`
- Create: `src/tools/model-tool.ts`
- Create: `src/mcp/client-manager.ts`
- Create: `src/mcp/server.ts`
- Create: `src/core/run.ts`
- Test: `tests/models/registry.test.ts`
- Test: `tests/integration/run-loop.test.ts`
- Test: `tests/integration/mcp.test.ts`

**Steps:**

1. Test model registration without secret serialization and reject unknown delegate targets.
2. Test a fake model performing text, process/HTTP tool call, delegation, early compaction, resume, and completion.
3. Test MCP discovery/call over an in-memory transport and one stdio smoke fixture.
4. Implement the provider-neutral gateway and loop; keep provider-specific configuration behind adapters.
5. Rerun tests; inspect the actual emitted event order.

### Task 6: HTTP/SSE API and CLI

**Files:**

- Create: `src/server/server.ts`
- Create: `src/cli.ts`
- Test: `tests/integration/api.test.ts`

**Steps:**

1. Test create run, inspect run, SSE replay/live events, user input, manual compaction, and cancel.
2. Implement a loopback-only Node HTTP server with JSON and SSE; no framework or database.
3. Add `tmsh run`, `tmsh serve`, `tmsh compact`, and `tmsh models` commands.
4. Run the API test and a real `curl.exe` smoke test; record actual responses.

### Task 7: Minimal OpenTUI client

**Files:**

- Create: `src/tui/app.tsx`
- Create: `src/tui/client.ts`
- Create: `src/tui/theme.ts`
- Test: `tests/tui/app.test.tsx`

**Steps:**

1. Test rendering transcript, composer, active model, context percentage, process state, and compaction events.
2. Implement the three-region TUI and shortcuts for submit, model picker, compact, cancel, and quit.
3. Run render tests.
4. Launch the TUI in a real terminal, capture a screenshot, inspect it, and fix any visual defects before delivery.

### Task 8: Dormant adaptive-toolsmith plugin and final qualification

**Files:**

- Create: `plugins/adaptive-toolsmith/` from pinned local commit `e81705c081557e057215d9453db47c420a6a0ffa`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `README.md`

**Steps:**

1. Vendor only the runtime plugin bundle and MIT license/provenance, not its repository history or installer.
2. Keep it absent from default tool/model context; expose activation through the TMSH capability-gap instruction.
3. Run the vendored plugin selftest with the available Python runtime and under `-O`.
4. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, build, CLI help, fake-model end-to-end, API/curl smoke, MCP smoke, and TUI visual QA.
5. Inspect `git diff --check`, `git status`, tracked files, and ignored secret paths.
