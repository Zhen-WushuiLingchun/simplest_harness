# TMSH local onboarding and resumable TUI design

## Decision

TMSH will keep OpenTUI instead of adding a second full-screen UI framework. OpenTUI's native renderer will run through Bun, its documented primary runtime. `tmsh tui` launched under Node will re-execute the built CLI with an available Bun binary before runtime initialization. If Bun is absent or re-execution fails, the existing ANSI TUI remains the functional fallback. This keeps one TUI implementation and preserves Node support for every non-native entrypoint.

API onboarding is a user-interface capability, not a model workflow. Both `tmsh api` and TUI `/api` use one interactive setup service. The user selects a provider, enters a masked API key, and TMSH sends that key only to the selected provider's model-list endpoint. The user then selects one or more returned models. Descriptors are merged into `tmsh.local.json`; the key is stored in the ignored `tmsh.local.env` and loaded into the process on future starts. Neither secret values nor the local env file content enters events, prompts, fixtures, or tracked configuration.

## Supported provider discovery

The initial provider set is deliberately small:

- OpenAI: `GET https://api.openai.com/v1/models`, bearer authentication.
- Anthropic: `GET https://api.anthropic.com/v1/models`, `x-api-key` plus the required API-version header.
- DeepSeek: `GET https://api.deepseek.com/models`, bearer authentication.
- OpenAI-compatible: user-supplied base URL, `GET <baseUrl>/models`, bearer authentication.

Provider selection happens before credential submission. TMSH will not leak one key to multiple providers to guess its origin. "Automatic detection" means authenticated enumeration and descriptor generation after the user selects the service boundary, not unreliable key-prefix guessing.

Model metadata endpoints do not reliably publish context windows, tool support, modalities, or relative cost. Generated descriptors therefore use conservative defaults and mark only known interface capabilities. Users can edit `tmsh.local.json` to add verified capacity metadata; TMSH will not invent values.

## Resumable conversations

TUI conversations are stored under `.tmsh/sessions/<uuid>.json`. A session contains an ID, title, timestamps, workspace, selected model, complete model-message history, and the validated preservation-ledger snapshot. Writes use an adjacent temporary file plus atomic rename. Session IDs are UUID-validated and file size is bounded before parsing.

The first goal creates a session. Each run with a session loads the stored messages and ledger, appends the new user goal, and persists after model/tool boundaries and successful compaction. `/resume` lists sessions; `/resume <id-or-unique-prefix>` selects one and restores a readable transcript preview. `/new` clears the selection so the next goal starts a new session. Delegated child runs are not separate user conversations.

The session record is continuity state, not the sole audit record. Append-only `.tmsh/runs/<runId>/events.jsonl` remains the source for observed tool and model events; compaction artifacts remain the source for validated compressed boundaries. `.tmsh/` and `tmsh.local.env` are ignored by Git.

## Error and security behavior

- Secret prompts are masked by the interactive prompt library.
- A failed provider probe writes neither a model descriptor nor a key file.
- Config and secret updates are written atomically. Existing unrelated config and environment entries are preserved.
- `tmsh.local.env` parsing accepts only strict `NAME=JSON_STRING` records written by TMSH; malformed records fail closed.
- On POSIX, the secret file is created with mode `0600`; on Windows, the file remains local plaintext and the CLI prints that limitation.
- A session with an invalid schema, digest, traversal-like ID, or oversized file is rejected rather than partially loaded.
- Resuming with an unavailable model is allowed for inspection, but a new goal requires selecting an available model.

## Verification

Tests will cover secret serialization without logging values, provider discovery against local HTTP fixtures, model/config merge, session round-trip and ledger preservation, run continuation from prior messages, `/resume` selection helpers, and Bun re-exec decision logic. Delivery also requires the existing full suite, typecheck, build, format, `git diff --check`, an ANSI fallback smoke, and a real Bun/OpenTUI initialization smoke on Windows.
