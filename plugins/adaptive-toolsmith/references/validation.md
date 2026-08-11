# Validating a synthesized tool

Load this for step 8. A tool that runs is not a tool that works.

## The floor

Five checks, always:

1. **Normal case** — representative input, expected output.
2. **Important edge case** — empty, single element, boundary, maximum size,
   whichever the domain makes dangerous.
3. **Malformed input** — must fail with the declared error code, not a stack
   trace and not a plausible wrong answer.
4. **Expected failure mode** — the unsupported-but-foreseeable variant declared
   in the contract.
5. **The original blocked task** — the actual case that triggered this skill.

Check 5 is not optional. Passing 1–4 while failing 5 means the contract was
wrong, not the implementation.

## Declare the checks that qualification will observe

After manual validation, encode executable evidence in `provenance.json`. Use
at least one `test` check whose `file` is inside `tests/` and one
`original-task` check whose `file` is the contract entrypoint. Names are stable
kebab-case identifiers and must be unique:

```json
{
  "validation": {
    "original_task_passed": true,
    "checks": [
      {
        "name": "unit-tests",
        "kind": "test",
        "argv": ["{python}", "tests/test_run.py"],
        "file": "tests/test_run.py",
        "timeout_seconds": 60
      },
      {
        "name": "original-blocked-task",
        "kind": "original-task",
        "argv": ["{python}", "src/run.py", "--input", "tests/original.json",
                 "--output", "{tmp}/result.json"],
        "file": "src/run.py",
        "timeout_seconds": 120
      }
    ]
  }
}
```

`{python}` resolves to the interpreter running toolsmith. `{tmp}` resolves to a
fresh temporary directory so checks do not write generated output into the
bundle and invalidate their own digest. `bundle qualify` uses `shell=False`,
streams raw output through byte counters and SHA-256 without retaining its
contents, and returns nonzero unless every check passes and the bundle is
byte-for-byte unchanged. Review the argv before running it: explicit
qualification executes code with the current process permissions and is not a
sandbox. The declared argv itself is persisted in provenance and qualification,
so never place credentials, secret values, or private input contents in it; use
environment-backed credential lookup and non-sensitive fixtures instead.
Do not let checks emit secrets either: a digest can still confirm guesses about
low-entropy values and is evidence, not a redaction mechanism.
Checks must not daemonize or spawn long-lived background children. The portable
timeout kills the direct child, but Python's standard library cannot guarantee
cross-platform process-tree termination; qualification is not a process
supervisor.

## Stronger evidence, when available

| Technique | Use when |
| --- | --- |
| **Differential testing** | A trusted implementation exists (even a slow or partial one). Compare outputs across a corpus. The single highest-value check. |
| **Analytical oracle** | The domain has closed-form answers for special cases. |
| **Official examples** | The spec or upstream project ships fixtures with expected outputs. |
| **Round-trip** | The operation has an inverse. `decode(encode(x)) == x`, and the harder direction too. |
| **Property-based** | Invariants hold over generated inputs (monotonicity, conservation, idempotence, ordering, size relations). |
| **Metamorphic** | No oracle exists, but you know how output *must change* when input changes in a known way. |
| **Regression** | Freeze the original failure as a permanent test case. Always do this. |

## Numerical and scientific tools

Most silent wrongness lives here. Verify explicitly, and record the answers in
the preliminary CapabilityContract's `required_semantics`:

- **Units** — and whether the library assumes SI, natural, or domain units.
- **Conventions** — sign, phase, handedness, index origin, row/column-major,
  time direction, normalization of transforms and basis functions.
- **Coordinate systems** — frame, origin, orientation, and whether the
  transformation is active or passive.
- **Tolerance** — absolute vs relative; what is the acceptable error, and
  compared to what reference?
- **Precision** — float32 vs float64 through the whole pipeline; where
  catastrophic cancellation can occur.
- **Edge values** — NaN, ±inf, denormals, zero-length, degenerate geometry.

A numerical tool that agrees with a reference to 3 significant figures when the
task needs 8 has failed validation, even though every test is green.

## The two-patch rule

If two successive patches attack symptoms at the same layer without resolving
the semantic failure, **stop patching**. The design is wrong. Go back to the
`CapabilityContract` and ask which assumption is false. Continuing to patch
past this point is the single most expensive failure mode in tool synthesis.

## Before/after comparison

Where practical, measure whether the capability actually helped:

```text
success / failure on the blocked task
number of tool calls to complete it
lines of glue code at the call site
runtime
output size / context consumed per invocation
numerical error vs reference
rate of manual intervention
```

Two outcomes justify keeping the tool: it makes something possible that was
not, or it makes something repeated substantially cheaper. Novelty does not.
If neither holds, delete the tool and return `NO_BUILD` with what you learned.

## Reporting honestly

In the handoff's `VALIDATION` line, state what was actually run. If code
execution was unavailable, return `BLOCKED` — never describe untested code as
validated. If check 5 could not be reproduced, say so and name what was missing.

The `AUDIT` line is a different claim and must not be merged into this one.
`VALIDATION` says what the tool was tested against; `AUDIT` says which of those
results you observed yourself rather than accepted on a subagent's report. Step
9 requires you to re-run check 5 personally even when a verifier already
reported it green — see `references/delegation-and-audit.md`.
