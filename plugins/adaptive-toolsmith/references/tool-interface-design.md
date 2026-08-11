# Designing tools whose caller is an agent

Load this for step 6, before writing implementation code.

## Why freeze the interface first

The contract is the deliverable. The implementation is replaceable; the
interface is what the calling agent commits to and what the registry indexes.
Writing it first also exposes underspecified semantics while they are still
cheap to fix.

## ToolContract

Validated by `assets/tool-contract.schema.json`.

```yaml
name: extract-qnm-modes
version: "0.1.0"
purpose: >-
  One precise sentence describing the capability.
keywords: [qnm, ringdown modes]
entrypoint:
  argv: [python, src/run.py]
  file: src/run.py

inputs:
  waveform_path:
    type: path
    required: true
    description: HDF5 waveform file in SXS convention.
  modes:
    type: string
    required: false
    default: "2,2"
    description: Comma-separated l,m pairs.

outputs:
  format: json
  destination: stdout

success_schema:
  status: ok
  result: object

error_schema:
  status: error
  code: string          # stable, machine-matchable
  message: string       # actionable, human-readable

exit_codes:
  0: success
  1: invalid input
  2: unsupported input variant
  3: internal failure

side_effects: [none]
determinism:
  deterministic: true
resource_limits:
  timeout_seconds: 120
  max_output_bytes: 1048576
```

## Rules for agent-facing interfaces

Keep the entrypoint structured. `file` is a forward-slash, bundle-relative path
and must appear exactly once as `argv[0]` for a direct executable or `argv[1]`
for an interpreter script; it is the file the trust gate binds to this bundle.
`argv` is an argument vector, not shell syntax: do not put pipes, redirections,
quoting tricks, or several commands into one string.

**Do:**

- take explicit named arguments; no positional soup;
- run non-interactively and never prompt;
- emit machine-readable results on stdout, diagnostics on stderr;
- keep the output schema stable across versions, and version it when it breaks;
- validate inputs early and fail with a specific error code;
- fail loudly rather than returning a partial result that looks complete;
- bound output size, and say so when you truncate;
- expose a timeout when the operation can hang;
- support `--help` describing every argument;
- be deterministic, or document precisely what is not.

**Do not:**

- design for human eyeballs when the consumer is an agent (no progress bars,
  spinners, ANSI colour in the result stream, or prose framing around data);
- hide state in globals, caches, or ambient config;
- mutate the user's environment, install packages, or write outside declared
  paths;
- overload one flag with several meanings;
- return `status: ok` alongside an empty result when the real answer is "not
  found" — that is a distinct, nameable outcome;
- silently coerce malformed input into a plausible value.

## Error codes are an API

An agent recovers from `UNSUPPORTED_CONVENTION` differently than from
`FILE_NOT_FOUND`. Give every failure a stable code, and make the message say
what to do next:

```json
{"status":"error","code":"UNSUPPORTED_CONVENTION",
 "message":"File uses NRAR convention; only SXS is supported. Pass --convention sxs after converting, or file a gap report."}
```

## Output size is a context cost

The whole point is to spend fewer tokens than the reasoning it replaces. If the
natural output is large, offer a summary mode and write the full artifact to a
path, returning the path:

```json
{"status":"ok","result":{"n_modes":8,"summary":{...},"artifact":"…/modes.h5"}}
```

## Sizing the tool

The smallest thing that satisfies the contract. Concretely:

- one entry point, not a plugin architecture;
- no configuration file until a second caller needs different behaviour;
- no abstraction layer for a second backend that does not exist yet;
- dependencies already in the project, unless a new one removes far more code
  than it adds.

A 300-line tool that does exactly one thing and is trivially replaceable beats
a 3000-line framework that anticipates needs nobody has.
