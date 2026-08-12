# Direct DeepSeek and OpenCode Compatibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden OpenCode Go message compatibility without expanding TMSH beyond a thin interface, then freeze and smoke-test a direct DeepSeek V4 Flash benchmark path.

**Architecture:** Keep the existing AI SDK transports. Add provider-agnostic message-history validation and lossless post-parse tool-input normalization, plus a capability-gated OpenCode Go error classifier that never retries or invents provider state. Benchmark configuration remains local and ignored.

**Tech Stack:** Node.js 22+, strict TypeScript, AI SDK 7, Vitest, PowerShell, Pier/DeepSWE.

---

### Task 1: Add failing adapter compatibility tests

**Files:**

- Create: `tests/models/adapter-compatibility.test.ts`
- Test: `tests/models/tool-alias.test.ts`

**Step 1:** Start a loopback Chat Completions fixture that returns a reasoning
part and two tool calls. Capture the second request after tool results are
appended.

**Step 2:** Assert that the second request contains the unchanged
`reasoning_content`, two assistant `tool_calls`, and two matching tool result
messages in order.

**Step 3:** Return a double-encoded tool argument object and assert the adapter
exposes an object both in `toolCalls` and the saved assistant message. This test
must fail against commit `368f39b` because post-parse normalization is absent.

**Step 4:** Supply an orphan tool result and assert the endpoint receives zero
requests. Add duplicate-call and unresolved-call cases.

**Step 5:** Simulate the known OpenCode Go 400 response and assert that the
error is classified without retrying. Run:

```powershell
pnpm vitest run tests/models/adapter-compatibility.test.ts tests/models/tool-alias.test.ts
```

Expected before implementation: at least the post-parse repair, invariant, and
classification assertions fail.

### Task 2: Implement the compatibility seam

**Files:**

- Modify: `src/models/adapter.ts`
- Modify: `src/core/types.ts` only if an existing capability cannot express the profile

**Step 1:** Add a pure helper that decodes only a JSON string whose decoded
value is a non-null, non-array object. Preserve all other inputs exactly.

**Step 2:** Apply the helper to parsed `result.toolCalls` before converting to
`JsonValue`, then reuse the normalized call when rewriting assistant tool-call
parts.

**Step 3:** Add a pure message-history validator enforcing declared/pending
tool-call and exactly-once result invariants. Invoke it immediately before
`generateText`.

**Step 4:** Detect the existing `opencode-go-chat-completions` descriptor
capability. Wrap only the three observed provider-history 400 families with a
stable `OpenCode Go compatibility error` prefix, preserve the original error as
the cause, and state that no retry occurred.

**Step 5:** Run the focused tests. Expected: all pass.

### Task 3: Document the behavior and scientific reset

**Files:**

- Modify: `README.md`
- Modify: `docs/plans/2026-08-12-direct-deepseek-opencode-compatibility-design.md` only if implementation evidence changes the design

**Step 1:** Document that official DeepSeek V4 IDs use
`https://api.deepseek.com`, that old aliases are retired, and that OpenCode Go
compatibility is capability-gated.

**Step 2:** State explicitly that provider compatibility errors are not model
benchmark failures and that results from different provider routes or TMSH
commits cannot be pooled.

**Step 3:** Document the no-retry and no-reasoning-synthesis behavior.

### Task 4: Verify and commit the repository change

**Files:**

- Modify only files listed by Tasks 1-3.

**Step 1:** Run:

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
git diff --check
```

Expected: every command exits zero.

**Step 2:** Inspect `git diff` for secret material and unrelated changes.

**Step 3:** Commit the compatibility implementation with a focused commit
message. Do not push until local and live smoke evidence are recorded.

### Task 5: Configure and smoke-test direct DeepSeek V4 Flash

**Files (local ignored benchmark workspace):**

- Create: `F:\AI\workspace\test\pier_tmsh_deepseek_agent.py`
- Create: `F:\AI\workspace\test\run-deepswe-deepseek-direct-flash.ps1`
- Create: `F:\AI\workspace\test\tmsh.deepseek-direct.json`
- Modify: `F:\AI\workspace\test\BENCHMARK.md`

**Step 1:** Use the existing process environment variable name
`DEEPSEEK_API_KEY`; do not copy or print its value. Freeze model
`deepseek-v4-flash`, base URL `https://api.deepseek.com`, Node major 24, one
model, delegation depth zero, and allowlist `api.deepseek.com`.

**Step 2:** Authenticated `GET /models` must report
`deepseek-v4-flash`. Record only model IDs and status.

**Step 3:** Run a bounded direct-adapter two-tool smoke. Assert that the second
request succeeds and that no string tool input remains.

### Task 6: Run one full valid trial

**Files:**

- Write only ignored Pier job artifacts and `BENCHMARK.md` evidence.

**Step 1:** Run exactly one `anko-default-function-arguments` trial with the
frozen task checksum, DeepSWE commit, base commit, verifier, new TMSH commit,
Node 24, and direct DeepSeek provider.

**Step 2:** Monitor until completion or first terminal infrastructure error.
Do not launch replacement attempts automatically.

**Step 3:** Record exact request/response/tool counts, token usage, wall time,
F2P/P2P totals, partial score, reward, exception state, modified files, and git
state.

**Step 4:** If valid, report it as direct-provider `n=1`; if invalid, preserve
the failure and stop before any retry.
