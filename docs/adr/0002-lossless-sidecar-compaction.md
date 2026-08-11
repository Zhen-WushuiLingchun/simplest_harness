# ADR-0002: Pair lossy context summaries with a lossless preservation ledger

## Status

Accepted.

## Context

Automatic summarization can omit negative results, alter numbers, drop units, or blur the difference between approximate and oracle implementations. Those failures are especially damaging in scientific work and may remain silent after the original transcript is removed.

## Decision

Implement compaction as a plugin that produces a narrative RE-TRAC-style summary plus a lossless sidecar ledger. The ledger stores canonical structured values under stable IDs. A compaction artifact is accepted only if it references every live ledger item and the values hash identically. Runtime-observed git state is captured separately. The old transcript is pruned only after atomic persistence and validation.

Use a configurable hybrid trigger: default soft ratio 0.75, hard ratio 0.90, optional absolute token threshold, model-requested early compaction, manual mode, and off mode. Disable automatic ratio triggers when model capacity is unknown.

Use the active model for narrative compression by default. An optional
registered `compaction.modelId` may supply the narrative instead; the runtime
still attaches and validates the live ledger, recent tail, and source boundary.

## Consequences

### Positive

- Exact numerical and negative results survive narrative compression.
- Compaction failures fail closed without destroying the previous context.
- The mechanism remains provider-agnostic and auditable.

### Negative

- The ledger consumes some irreducible context.
- The model must explicitly maintain scientific preservation records.
- Completeness before the first ledger entry is a behavioral obligation, not mechanically knowable.

### Neutral

- Provider-native opaque compaction may still be used internally by an adapter, but it cannot replace the TMSH artifact and ledger contract.

## Alternatives considered

- Summary only: rejected because it cannot mechanically prevent silent fact loss.
- Keep the full transcript forever: rejected because it eventually exceeds provider limits and degrades focus/cost.
- Fixed absolute threshold: rejected because model context capacities differ.
- Fixed ratio with no override: rejected because task and provider behavior differ.

## References

- https://arxiv.org/abs/2602.02486
- https://developers.openai.com/api/docs/guides/compaction
- https://platform.claude.com/docs/en/build-with-claude/compaction
