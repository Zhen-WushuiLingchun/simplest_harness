# Direct DeepSeek and OpenCode Compatibility Design

## Objective and evidence boundary

The next benchmark epoch uses `deepseek-v4-flash` through the official
DeepSeek OpenAI-compatible endpoint at `https://api.deepseek.com`. The previous
two valid OpenCode Go trials remain immutable evidence for a different provider
route and must not be pooled with the new epoch. The model ID, DeepSWE task,
verifier, Node major version, delegation depth, and TMSH behavior remain frozen;
the provider route and the post-fix TMSH commit are new experimental parameters.

The DeepSeek API currently exposes `deepseek-v4-flash` and
`deepseek-v4-pro`; the legacy `deepseek-chat` and `deepseek-reasoner` aliases
were retired on 2026-07-24. Thinking-mode tool turns require the complete
assistant `reasoning_content` to be replayed with the tool call. TMSH must
preserve that provider message part without logging its contents as a feedback
event.

Primary references:

- https://api-docs.deepseek.com/quick_start/pricing/
- https://api-docs.deepseek.com/guides/thinking_mode
- https://api-docs.deepseek.com/guides/tool_calls
- https://opencode.ai/docs/zh-cn/go/

## Options considered

1. Add dedicated `deepseek` and `opencode-go` runtime providers. This is easy
   to identify but duplicates the existing OpenAI-compatible transport and
   expands the permanent harness surface.
2. Add a general workflow/router that retries, rewrites, or serializes tool
   turns differently per provider. This may hide upstream defects and violates
   the thin-harness boundary.
3. Reuse the existing protocol adapters and add a narrow compatibility seam.
   Existing descriptor capabilities identify OpenCode Go protocol families;
   generic tool-input normalization and conversation invariants protect every
   provider, while OpenCode-specific upstream errors receive an explicit,
   non-retrying classification.

Option 3 is selected. It adds no scheduler, provider graph, or new persistence
layer.

## Data flow and invariants

Before every model request, TMSH validates the visible message history. Each
tool result must match one previously declared, still-pending assistant tool
call; call IDs and results may not be duplicated; a new non-tool message may not
overtake unresolved calls. Validation failure stops locally before network or
tool side effects.

After a provider response, tool inputs are normalized a second time. If an
OpenAI-compatible provider has parsed a double-encoded JSON object into a
string, TMSH losslessly decodes that string to the object required by the tool
schema. Plain strings, arrays, scalars, invalid JSON, and null are not guessed
or coerced. The normalized provider tool name and input are written back into
the assistant response message while every reasoning part and provider option
is retained unchanged.

For descriptors carrying `opencode-go-chat-completions`, three known upstream
400 families are classified as OpenCode compatibility errors: missing tool-call
predecessor, duplicate `tool_call_id`, and missing thinking-mode
`reasoning_content`. TMSH does not automatically retry or synthesize reasoning.
This keeps cost, scientific trajectories, and negative evidence observable.

## Verification and benchmark gate

Local fake-endpoint tests capture the actual second request and assert exact
assistant/tool ID pairing, reasoning replay, and repaired inputs. Invalid
histories must fail before the fake endpoint is contacted. A simulated OpenCode
400 must retain the original provider message while adding the compatibility
classification.

After typecheck, unit tests, build, formatting, and diff checks pass, a bounded
official DeepSeek smoke performs one two-tool turn and one result-replay turn.
Only then may a single DeepSWE trial start. The trial is valid only if the TMSH
run reaches `done`, no infrastructure exception occurs, the frozen hashes and
versions match, and the verifier completes. A model reward of zero remains a
valid model result; an API/history failure does not.
