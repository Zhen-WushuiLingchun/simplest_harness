# Activation gate and capability contract

Load this when deciding *whether* to build, or when filling in the
`CapabilityContract`.

## The failure taxonomy

| Class | Signature | Correct response |
| --- | --- | --- |
| `CONFIGURATION_PROBLEM` | Tool exists and is correct; a flag, path, env var, credential, or version is wrong. | Fix config. `NO_BUILD`. |
| `KNOWN_TOOL_MISUSE` | The right API exists; it was called with wrong arguments, wrong order, or wrong assumptions. | Correct the call. `NO_BUILD`. |
| `ORDINARY_CODE_BUG` | Logic error in code we control. | Fix the bug. `NO_BUILD`. |
| `MISSING_CAPABILITY` | No tool in reach performs the operation at all. | Search, then build if warranted. |
| `POOR_TOOL_FIT` | A tool performs *something like* the operation, but its abstraction forces brittle glue on every call. | Adapter or wrapper, usually small. |
| `REPEATED_MANUAL_WORK` | The agent has reasoned its way through the same transformation ≥3 times. | Build; the payoff is context, not correctness. |
| `UNKNOWN` | Not yet diagnosed. | Keep investigating. Never build from `UNKNOWN`. |

## Failure modes that impersonate capability gaps

Check each before escalating:

- **Bad upstream data.** The parser is fine; the input is truncated, wrongly
  encoded, or a different format than claimed. Inspect the actual bytes.
- **Environment drift.** Works elsewhere, fails here: version skew, missing
  system library, different locale, path separator, or line ending.
- **Permissions and sandboxing.** Network, filesystem, or credential denial
  surfacing as an opaque tool error.
- **Wrong layer.** The failure is downstream of the tool being blamed.
- **Silent truncation.** The tool succeeded on a subset and the agent read the
  partial result as complete.
- **Nondeterminism.** Intermittent failure read as a missing feature.

## The three-times rule

One occurrence is an incident. Two is a coincidence. Three is a capability gap.

For `REPEATED_MANUAL_WORK`, count actual occurrences in the conversation or
repo history before escalating. If you cannot point to concrete repetitions,
the gap is speculative — return `NO_BUILD` and note the pattern to watch for.

## CapabilityContract

Fill this in before any search. Unknown fields are acceptable, but mark them
`UNKNOWN` rather than guessing — an invented requirement is worse than a
missing one.

```yaml
goal:                    # what the caller ultimately wants
blocked_step:            # the operation that is currently failing
observed_failure:        # error, wrong output, or cost — be specific
required_input:          # types, formats, sources, size range
required_output:         # types, formats, consumers
required_semantics:      # what "correct" means; conventions, invariants
accuracy_requirements:   # tolerance, precision, exactness
performance_requirements:# latency, throughput, memory, input scale
side_effect_constraints: # network, filesystem, credentials, idempotence
environment:             # OS, runtime versions, offline?, sandbox limits
integration_target:      # who calls this and how
expected_reuse:          # one-off | this task | this project | cross-project
known_existing_tools:    # what was already tried, and how it fell short
```

### Separating the three questions

The most common design error is optimizing the contract around the *failed
approach* rather than the *goal*.

> An agent tries to extract a table from a PDF with a text-layout library, and
> the columns interleave. The tempting contract is "fix column ordering in
> extracted text". The real contract is "get structured rows out of this
> document class" — which may be better served by a different extractor
> entirely, or by the source data that generated the PDF.

Ask: if the current tool had never existed, how would I state the requirement?

### Reuse tier drives everything downstream

| `expected_reuse` | Implication |
| --- | --- |
| `one-off` | Almost always `NO_BUILD`. Write the inline script. |
| `this task` | Build only if the task will invoke it many times. Skip the registry. |
| `this project` | Build, validate, register. The normal case. |
| `cross-project` | Build, validate, register, and harden the interface — someone will depend on it. |
