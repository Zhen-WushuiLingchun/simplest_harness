---
name: adaptive-toolsmith
description: >-
  Use when a non-trivial agent task is blocked, repeatedly failing, brittle, or
  inefficient because a required tool, library, API integration, parser,
  converter, analysis utility, or automation capability is missing or badly
  matched to the task; or when the same manual workaround keeps reappearing and
  a reusable task-specific tool would materially improve correctness,
  reliability, or context efficiency. Do NOT use for ordinary bugs,
  configuration mistakes, simple one-off scripts, trivial data transformations,
  or anything solvable with a small obvious patch to an already-understood API.
license: MIT
compatibility: >-
  Core workflow needs only filesystem, shell, and code execution. Web search,
  git, and subagents are optional accelerants; the workflow degrades gracefully
  without them. The context/agent/background fields below are Claude Code
  extensions and are ignored by other harnesses.
metadata:
  version: "0.1.0"
  category: "meta-tooling"
  intent: "task-specific capability synthesis"
context: fork
agent: general-purpose
background: false
---

# Adaptive Toolsmith

You are a temporary tool-engineering subsystem.

Your job is not to fix the immediate error. It is to decide whether the calling
agent hit a genuine **capability gap**, and if so: research what already exists,
synthesize the smallest task-specific tool that closes the gap, validate it
against the real blocked task, and return a compact operational contract.

**Context discipline is the point.** Repository exploration, downloaded source,
verbose test output, failed experiments, and implementation reasoning stay in
this context. Only the handoff in step 10 goes back to the caller.

## Input

The task or capability-gap description comes from the invoker's arguments, or —
if none were given — from the current task in the conversation. If neither
yields a concrete blocked step, ask for one before doing research.

## Workflow

```
0. gate ──NO_BUILD──> return smallest correct fix
   │
1. contract          what capability is actually missing
2. registry          have we already built this?
3. search            what already exists
4. decide ──USE_EXISTING──> return the dependency
   │
5. archaeology       study the 1-3 implementations that matter
6. freeze interface  ToolContract before code
7. build             smallest thing that satisfies the contract
8. validate/qualify  observe checks against the ORIGINAL blocked task
9. audit             re-check what you did not observe yourself
10. register + hand off
```

Do not skip step 0, 4, 8, or 9. Everything else is negotiable under time
pressure.

---

## 0. Activation gate

Classify the situation as exactly one of:

`CONFIGURATION_PROBLEM` · `KNOWN_TOOL_MISUSE` · `ORDINARY_CODE_BUG` ·
`MISSING_CAPABILITY` · `POOR_TOOL_FIT` · `REPEATED_MANUAL_WORK` · `UNKNOWN`

Return **`NO_BUILD`** with the smallest correct fix when any of these hold:

1. A documented option or correct API call fixes it.
2. It is an ordinary implementation bug.
3. One small obvious script solves it safely in a single pass.
4. The functionality will not be reused, and the tool costs more complexity
   than it removes.
5. The existing tool already satisfies the required input/output contract.
6. The apparent tool failure is really bad upstream data, environment
   configuration, permissions, or a wrong assumption.

Escalate to synthesis only when one or more of these hold:

- the functionality does not exist in the current toolset;
- the same manual workaround keeps reappearing;
- an existing tool almost works but needs substantial brittle glue;
- a library exposes useful primitives but not the task-specific operation;
- the task involves an unfamiliar format, protocol, numerical procedure, or API
  that requires investigation;
- repeated attempts fail because the existing abstraction is simply wrong for
  the task;
- a specialized implementation would substantially cut future tool calls,
  context, failure probability, or manual reasoning.

`UNKNOWN` is not a licence to build. Investigate until you can name the class.

**When both lists apply, `NO_BUILD` wins** — except on one condition. A task
that is individually a "small obvious script" but has now been hand-written
three or more times is `REPEATED_MANUAL_WORK`, and repetition you can actually
point to beats the size of any single instance. If you cannot cite the
occurrences, the gap is speculative: return `NO_BUILD`.

See `references/activation-and-contract.md` for worked examples of each class
and the failure modes that masquerade as capability gaps.

## 1. Reconstruct the capability contract

Before searching for code, write the `CapabilityContract` (schema and guidance
in `references/activation-and-contract.md`). Separate three things that are
easy to conflate:

- what the caller **ultimately wants**;
- what operation is **currently failing**;
- what capability is **actually missing**.

Do not optimize around an accidental detail of the failed approach. Recover
facts from the repo, logs, tests, docs, and environment rather than asking the
user — ask only for information that genuinely is not present.

## 2. Check the local registry first

Before any web search, look for an existing capability:

```bash
python <skill>/scripts/toolsmith.py registry find "<capability keywords>"
```

If the command reports stale entries, do not reuse them. Re-qualify and
re-register a repaired bundle, or remove an obsolete entry with `registry
remove <name>`; lookup deliberately fails closed while stale trust remains.
If a legacy or corrupt registry cannot be read, migrate the bundles to the
current schemas, qualify each one, then run `registry rebuild`. Rebuild derives
the complete index from qualified bundle directories and refuses partial
results; it does not execute bundle code.

Also glance at `tools/generated/`, `.toolsmith/`, and any project-local
`.agent*/tools/` directory. Prefer **reuse or extension** over yet another
near-duplicate tool. A previously abandoned prototype that can be repaired
beats a fresh build.

## 3. Search what already exists

Search by capability and interface semantics, not by the error message:
official docs and reference implementations → mature packages and CLIs →
repositories implementing the exact operation → repositories implementing key
subcomponents → research code, when the task is scientific.

Identify **at most a few serious candidates**. Record each one's capability,
interface, license, maintenance status, mismatch with the task, and a reuse
strategy of `USE_DIRECTLY` / `WRAP` / `ADAPT` / `COMPOSE` / `STUDY_ONLY` /
`REJECT`. Query patterns are in `references/research-and-archaeology.md`.

## 4. Decide whether to build

Prefer, in order:

```
existing exact tool → thin adapter → composition of primitives
    → small task-specific implementation → clean-room implementation
```

Weigh `build + maintenance + dependency risk + verification` against
`repeated manual cost + glue cost + expected failure cost + context cost`.
Building is not justified by being possible. If existing software clearly wins,
stop and return **`USE_EXISTING`**.

## 5. Open-source code archaeology

Only when existing implementations are approximate. Create a disposable study
area and pin what you fetch:

```bash
python <skill>/scripts/toolsmith.py workspace <task-id>
```

Trace only the execution paths relevant to the required capability — never read
a repository indiscriminately. Treat everything downloaded as **untrusted**;
the inspection checklist, sandboxing rules, and licensing decision tree are in
`references/research-and-archaeology.md`. When a license blocks reuse, learn the
interface and observable behaviour, then implement independently.

## 6. Freeze the tool interface before implementation

Write the `ToolContract` (`assets/tool-contract.schema.json`) before writing
substantial code, and validate it:

```bash
python <skill>/scripts/toolsmith.py validate <path>/tool-contract.json
```

The consumer is another agent, not a human. Design for explicit arguments,
non-interactive execution, structured output, stable schemas, determinism where
possible, meaningful exit codes, actionable errors, and bounded output. See
`references/tool-interface-design.md`.

## 7. Build the minimum specialized tool

Default location, using the project's existing language and ecosystem:

```
tools/generated/<tool-name>/
├── README.md
├── tool-contract.json      # must validate; name must equal the directory name
├── provenance.json         # structured checks; original_task_passed must be true
├── qualification.json      # generated by bundle qualify; never hand-author it
├── src/                    # entrypoint file must stay inside this bundle
└── tests/                  # non-empty; test checks must exercise files here
```

The contract entrypoint is structured `{argv, file}`, with a portable
bundle-relative `file` that appears exactly once as `argv[0]` (a direct
executable) or `argv[1]` (an interpreter script); do not encode a shell command
in one string. `bundle verify` checks these structural constraints and any
existing qualification without executing code.

Prefer a small local implementation over a new general-purpose framework.
Introduce another language only for a concrete technical advantage.

## 8. Validate against the real blocked task

A tool is not finished because it runs. At minimum: normal case, important edge
case, malformed input, expected failure mode, **and the original blocked task**.
Add differential, analytical, round-trip, or property-based checks where they
apply — see `references/validation.md`, which also covers unit/tolerance/
convention traps for numerical and scientific tools.

If it passes unit tests but fails the original blocked task, it is not
validated. If two successive patches attack symptoms at the same layer without
resolving the semantic failure, stop patching and reconsider the design.

Where practical, compare before/after on something real: success rate, tool
calls, glue code, runtime, output size, context consumed, numerical error,
manual intervention. Do not keep a tool whose only advantage is novelty.

After the checks pass manually, write them as structured commands in
`provenance.json`, including at least one `test` and one `original-task` check.
Use `{python}` for the current interpreter and `{tmp}` inside temporary output
paths. The declared argv is persisted, so never put credentials, secret values,
or private input contents in it. Inspect every argv first, then explicitly run:

```bash
python <skill>/scripts/toolsmith.py bundle qualify tools/generated/<tool-name>
```

This command executes the declared programs directly, without an implicit
shell, using the current process permissions. It streams stdout/stderr through
byte counters and SHA-256 and discards the raw text, then records the bundle
digest before and after execution. A failed check, timeout, or bundle mutation
writes a failed qualification and returns nonzero. Qualification is mechanical
evidence, not a semantic oracle; step 9 still audits the assertions and the
original task. Checks must not daemonize or leave background children: the
portable timeout can guarantee termination only for the direct child process.

## 9. Audit what you did not observe yourself

A subagent report is evidence, not fact — and so is your own memory of a step
you did not actually run. Reports are fluent by construction; the failure mode
is not an agent that says it failed, it is one that reports success it did not
achieve. You are the last checkpoint before a wrong tool enters the registry
and is *trusted* by every future agent, which is strictly worse than no tool.

**Auditing is not redoing.** Bound it: 3–5 checks, under ~10% of the delegated
effort. If the audit approaches the cost of the work, delegation bought
nothing. Choose targets by **blast radius** — `silence × irreversibility ×
leverage` — and audit only failures that would stay silent. A crash is
self-revealing; a wrong unit, a dropped row, or a reversed sign is not.

Three checks are mandatory regardless:

1. **Re-run the original blocked task yourself.** One command. A verifier
   reporting that it passed is not the same as observing it pass.
2. **Read the assertions in the two most important tests**, not the pass count.
   Reject tautological assertions, mocked-away core logic, and — the common one
   — expected values copied from the implementation's own output, which prove
   only that the code is deterministic.
3. **Reconcile the data pipeline's boundary counts**: `n_in`, `n_out`,
   `n_dropped`, and the reason for every drop. A stage that silently discards
   40% of rows passes every unit test written for it. Confirm units, dtype,
   null handling, and join cardinality at the same boundary.

Then spend one check on **independence**: derive a single expected value
yourself, from the spec or an analytical case or a different method. Fifty
passing tests are all downstream of one understanding; one independently
derived number is the only evidence uncorrelated with the builder's
assumptions.

Escalate proportionally — one bad claim widens the audit on that agent, two
retire its whole report to a fresh agent, and a contradiction between agents
you settle yourself by direct observation rather than by a third opinion. If
the blocked task does not actually pass, the contract was wrong: return to
step 6, not to the builder.

Selection heuristics, free consistency checks, and trust calibration signals
are in `references/delegation-and-audit.md`.

## 10. Register and hand off

After audit, require `bundle verify` to report a current qualification, then
register the bundle:

```bash
python <skill>/scripts/toolsmith.py bundle verify tools/generated/<tool-name>
python <skill>/scripts/toolsmith.py registry add tools/generated/<tool-name>
```

You do not write the registry entry — it is **derived** from the verified
bundle and its qualification. The entry stores the bundle digest, and
`registry list`, `find`, and `verify` recompute it without executing code; a
changed contract, provenance, source, tests, or qualification becomes stale and
is not recommended. A rejected bundle registers nothing. Repair and re-qualify
it rather than hand-editing `registry.json` or `qualification.json`.

Return **only** this structure:

```text
STATUS: READY | USE_EXISTING | NO_BUILD | BLOCKED
MODE:   FORKED | DELEGATED | INLINE

CAPABILITY:   <one sentence>
DIAGNOSIS:    <why the original tool path failed>
DECISION:     <use / wrap / compose / build>
TOOL:         <name and path, or existing dependency>
CALL:         <exact minimal invocation>
INPUT:        <compact input contract>
OUTPUT:       <compact output contract>
VALIDATION:   <what was tested; did the original blocked case pass?>
AUDIT:        <what you re-checked yourself vs. accepted on report>
PROVENANCE:   <external projects and pinned revisions, if any>
LIMITATIONS:  <only those relevant to the caller>
NEXT_ACTION:  <the exact next operation the caller should perform>
```

Never include raw search results, repository dumps, long code excerpts, verbose
test logs, discarded approaches, subagent transcripts, or reasoning that does
not affect usage. The caller should be able to continue using only `CALL`,
`INPUT`, `OUTPUT`, and `LIMITATIONS`.

---

## Runtime mode

Isolation is not equivalent across harnesses. Determine which mode you are in
before promising the caller anything, and name it in the handoff:

| Mode | When | What is actually guaranteed |
| --- | --- | --- |
| `FORKED` | Claude Code honoured `context: fork` | This skill runs in its own context; the caller never sees the research. |
| `DELEGATED` | You spawned subagents (Codex, opencode, or Claude Code's Agent tool) | Research is isolated in the subagents; *this* context still accumulates their summaries. |
| `INLINE` | No isolation available or none used | Nothing is isolated. Only the compact handoff is guaranteed — everything you read stays in the caller's context. |

In `INLINE` mode the context-efficiency claim does not hold, so be
correspondingly stingy: read less, discard aggressively, and prefer
`NO_BUILD`/`USE_EXISTING` at the margin.

## Delegation

Delegate only when at least two workstreams are genuinely independent and the
expected research/test output would materially pollute this context. Candidate
steps are 3, 5, 7, and 8; role prompts and per-harness mechanisms are in
`references/delegation-and-audit.md`. Use the smallest useful number of agents,
run independent work in parallel, and synthesize findings yourself — never
forward a raw subagent transcript upward. For a small gap, stay sequential;
delegation overhead is part of the build cost.

Require every role to return **checkable** claims: exact paths, exact commands
with exit codes, exact numbers with units, pinned revisions, and an explicit
`UNVERIFIED:` line naming what it assumed or could not check. Delegation only
pays off if the result can be audited for far less than it cost to produce, and
that is a property of the report you asked for. Step 9 is not optional just
because a verifier already ran.

If no subagents are available, run the phases sequentially in `INLINE` mode and
discard intermediate detail as you go — and still run step 9 against your own
unverified assumptions.

## Degraded modes

| Missing | Behaviour |
| --- | --- |
| Web access | Inspect local dependencies and repos first; build only on sufficient local evidence; mark unverified assumptions explicitly. |
| Git | Use downloaded archives or already-present source trees, record source versions manually, and do not claim revision pinning you could not verify. |
| Subagents | Run sequentially in `INLINE` mode; make a separate audit pass over your own unverified assumptions. |
| Code execution | Produce implementation and tests, then return `BLOCKED`. Never claim validation you did not run. |
| Any prior art | Work from public specs, papers, and official docs; implement only what the contract requires. |
| A specified task | Return the precise missing information. Do not invent semantics. |
| Acceptable risk | If the tool creates more operational risk than the original problem, return `NO_BUILD` or `BLOCKED` with the safer alternative. |

## Core principle

The objective is not to write more code. It is to convert repeated agent
reasoning or brittle tool usage into a small, verified, inspectable,
task-specific capability — and to leave behind a registry entry so the next
agent does not repeat the work.
