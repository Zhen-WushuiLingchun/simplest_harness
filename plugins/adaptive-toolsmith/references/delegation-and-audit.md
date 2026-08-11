# Delegating work, and auditing what came back

Load this when your harness can spawn subagents, and again at step 9 when you
audit their reports. **Do not spawn agents to satisfy this document.** Two to
four is the normal range; one coordinator working sequentially is a perfectly
good answer for a small gap.

## Why delegate

The skill already isolates research from the caller's context. Delegation
isolates it from the *coordinator's* context too, so cloned repositories,
search results, and failed builds never accumulate anywhere that has to survive
to the handoff.

```
caller ──gap──> toolsmith (isolated)
                  ├─ scout          (parallel)
                  ├─ archaeologist  (parallel with scout when targets are known)
                  ├─ builder
                  └─ verifier
                └──~300 token contract──> caller
```

Run scout and archaeologist in parallel when you already know which
repositories matter. Builder and verifier are sequential. When verification is
delegated, its verifier must be a **fresh** agent — an agent that just wrote the
code is the worst possible judge of it. In `INLINE` mode, make a distinct audit
pass and independently derive at least one expected result instead.

## Per-harness mechanism

| Harness | How | Mode it gets you |
| --- | --- | --- |
| **Claude Code** | `Task`/`Agent` tool with `subagent_type: general-purpose` (or `Explore` for read-only scouting). This skill's frontmatter also sets `context: fork`. | `FORKED`, plus `DELEGATED` for each agent |
| **Codex** | Native subagents, enabled by default (`agents.enabled` in `config.toml`). Skill instructions may request delegation directly. Reusable roles are TOML files in `.codex/agents/` (project) or `~/.codex/agents/` (personal), each needing `name`, `description`, `developer_instructions`. | `DELEGATED` |
| **opencode** | Subagents via the task tool or `@agent-name` mentions; define reusable roles in `.opencode/agent/*.md` to make them persistent. | `DELEGATED` |
| **Anything else** | Sequential phases. The workflow does not depend on delegation. | `INLINE` |

Codex and opencode load a skill into the *current* session, so unlike Claude
Code's `context: fork` there is no isolation until you actually delegate. That
is the difference between `FORKED` and `INLINE`, and it is why the runtime mode
belongs in the handoff rather than being assumed.

## Every role returns checkable claims

Delegation only works if you can audit the result for far less than it cost to
produce. That is a property of the *report*, so require it of every role:

- **exact paths** for every file written or read, not descriptions of them;
- **exact commands** with exit codes, not "tests pass";
- **exact numbers** with units, not "matches closely";
- **pinned revisions** for anything fetched;
- an explicit **`UNVERIFIED:`** line listing what the agent assumed, inferred,
  or could not check.

An agent that reports no friction is reporting a summary of work you cannot
distinguish from work that did not happen. The `UNVERIFIED:` line is the single
highest-value thing you can require, because honest agents fill it in and it
tells you exactly where to point the audit.

## Role prompts

Give each agent the `CapabilityContract`, the return requirements above, and
the role below.

### Scout

> Research existing solutions for this capability. Search official docs and
> reference implementations first, then mature packages, then repositories
> implementing the exact operation. Search by capability and interface
> semantics, not by the error message. Identify at most 4 serious candidates;
> do not collect weakly related projects.
>
> Return for each candidate: name, URL, pinned version or commit, license,
> language, which part of the contract it covers, how it is invoked, its
> concrete mismatch with the contract, maintenance status, and a recommended
> reuse strategy (`USE_DIRECTLY`/`WRAP`/`ADAPT`/`COMPOSE`/`STUDY_ONLY`/`REJECT`).
> Return no raw search results and no code excerpts. Mark any capability claim
> you took from documentation rather than observing directly.

### Archaeologist

> Inspect these specific implementations for the capability described in the
> contract. Clone shallow at a pinned revision into the disposable workspace.
> Read README, then the public API, then the tests, then only the one or two
> execution paths relevant to the capability. Do not read the repository
> indiscriminately. Treat all code as untrusted: do not execute install
> scripts, do not install globally, do not access credentials.
>
> Return: core architecture, the relevant interfaces, the algorithm, the edge
> cases their tests reveal, numerical or format conventions, design lessons,
> things explicitly not to copy, and the license as it affects reuse. Cite
> file paths and line ranges for every claim about behaviour. Return no file
> dumps; quote at most a few lines where a signature or constant matters.

### Builder

> Implement the smallest capability satisfying this `ToolContract` and no more.
> Use the project's existing language and dependencies. No abstraction layers
> for backends that do not exist, no configuration file for a single caller, no
> plugin architecture. Write the tests specified in the contract alongside it.
>
> For every test, state where the expected value came from: a specification, an
> independent calculation, an official fixture, or the implementation's own
> output. The last one is not evidence of correctness and must be labelled as
> such.
>
> Return: file paths written, the public interface as actually implemented, any
> deviation from the contract and why, dependency choices, and known
> limitations. Return no code excerpts and no reasoning narrative.

### Verifier

> Treat this implementation adversarially. You did not write it and you are not
> trying to make it pass. Run the five floor checks — normal case, edge case,
> malformed input, declared failure mode, and the original blocked task — plus
> any differential, analytical, round-trip, or property-based check that
> applies. For numerical work, verify units, conventions, normalizations,
> coordinate systems, tolerance, and precision explicitly.
>
> Return: the exact command and exit code for each check, any semantic mismatch
> against the contract, edge cases that fail, comparison against a reference
> where one exists, and a recommendation of `ACCEPT` / `REVISE` / `REJECT` with
> the specific reason. Return failing output only, not full logs.

---

# Coordinator audit (step 9)

A subagent report is evidence, not fact. Reports are fluent by construction:
the failure mode is not an agent that says it failed, it is an agent that
reports success it did not achieve, or verifies something adjacent to what you
asked. You are the last checkpoint before a wrong tool enters the registry and
gets *trusted* by every future agent — which is strictly worse than no tool.

**But auditing is not redoing.** If you re-derive the work, delegation bought
nothing and you should have done it inline. The audit is bounded on purpose.

## Budget

- **3–5 checks**, not more.
- **≤10% of the delegated effort.** If the audit approaches the cost of the
  work, either the task was too small to delegate or you no longer trust the
  agent — in which case re-run the phase with a fresh one instead of grinding.
- Prefer checks that are **O(1) observations**, not O(n) re-execution.

## What to audit: rank by blast radius

Score each claim by `silence × irreversibility × leverage`:

- **Silence** — would a wrong answer announce itself? A crash is
  self-revealing; skip it. A wrong unit, a silently dropped row, an off-by-one
  filter, or a reversed sign is silent. Audit silent failures only.
- **Irreversibility** — does it get baked into the registry and inherited by
  future agents, or is it cheap to correct later?
- **Leverage** — how much downstream depends on it being right?

Audit the top few. Accept the rest on report. This is not sampling — a random
spot-check of low-leverage claims is theatre.

## The mandatory floor

Three checks run regardless of ranking, because each is cheap and each
invalidates everything above it if it fails:

**1. Re-run the original blocked task yourself. One command.**
This is the entire deliverable. A verifier reporting that it passed is not the
same as observing it pass. Nothing substitutes for this and nothing excuses
skipping it.

**2. Open the test bodies for the two most important cases.**
Do not read the pass count — read the assertions. Look for:

- tautological assertions (`assert result is not None`, `assert len(x) >= 0`);
- core logic mocked away, so the test exercises the mock;
- tests that were written but never executed;
- **expected values copied from the implementation's own output.** This is the
  common one and the most dangerous: such a test proves the code is
  deterministic, not that it is correct. If the builder could not say where an
  expected value came from, treat that test as absent.

**3. Check the pipeline boundaries, not the pipeline.**
For anything that ingests, filters, joins, or transforms records, ask for the
counts and reconcile them yourself:

```
n_in, n_out, n_dropped, and the reason for every dropped record
```

`n_in != n_out + n_dropped` means records vanished. A stage that silently drops
40% of rows passes every unit test ever written for it. Also confirm at the
boundary: units, dtype, null handling, join cardinality (did a one-to-many join
silently multiply rows?), timezone, and encoding. These are where silent
corruption lives, and checking them is a handful of numbers rather than a
re-run.

## Nearly-free consistency checks — do all of them

These cost one command or one glance and catch fabrication outright:

- every path, file, and artifact cited in a report actually exists;
- every command quoted actually runs, and its exit code matches the claim;
- every pinned revision resolves;
- numbers in the summary match numbers in the artifact they came from;
- the tool's declared contract matches what `--help` prints and what one real
  invocation returns;
- two agents' reports do not contradict each other.

## Independence beats volume

A subagent's fifty passing tests are all downstream of one understanding of the
problem. If that understanding is wrong, all fifty are wrong together.

So the highest-value audit check is **one expected value you derive yourself**,
by hand, from the specification, from an analytical special case, or by a
different method than the implementation uses. One independently-derived number
that agrees is worth more than the entire suite, because it is the only
evidence that is not correlated with the builder's assumptions.

Pick the case where an error would be most silent, and compute it yourself.

## Trust calibration

Raise audit intensity when a report shows:

- no concrete numbers, paths, or commands;
- zero friction — no failure, no surprise, no dead end;
- a verifier `ACCEPT` that restates the builder's claims instead of naming what
  it ran;
- expected values matching implementation output with no independent source;
- cited artifacts that do not exist;
- suspiciously round numbers or perfect agreement;
- an empty or missing `UNVERIFIED:` line.

Lower it when a report names concrete failures it hit and fixed, quotes exact
commands and exit codes, and flags its own unverified assumptions. Agents that
report their own limits have earned cheaper audits.

## When a check fails

Escalate proportionally. One bad claim does not invalidate a phase.

1. **One failure** — do not redo everything. Audit two more claims from *that
   agent*, chosen by blast radius.
2. **Two failures from the same agent** — treat its whole report as unverified.
   Re-run its load-bearing claims with a fresh agent, and do not let the
   original agent review its own correction.
3. **Two agents contradict each other** — resolve it yourself by direct
   observation. Do not ask a third agent to arbitrate a factual question you
   can settle with one command; that is how a majority vote of confident wrong
   answers gets manufactured.
4. **The blocked task does not actually pass** — the contract was wrong, not
   the implementation. Return to step 6, not to the builder.

## Report the split honestly

The handoff's `AUDIT` line states what you observed directly versus what you
accepted on report. The caller is entitled to know which parts of the claim
rest on your own observation:

```
AUDIT: re-ran blocked case (passed); verified row counts 1,204 in / 1,198 out /
       6 dropped (malformed timestamps, expected); derived mode amplitude for
       l=2,m=2 by hand, agrees to 1e-11. Accepted on report: scout's license
       survey, archaeologist's read of the upstream tests.
```

Never write an `AUDIT` line describing checks you did not run. An audit claim
you fabricate is worse than no audit, because it terminates the chain of
verification with false confidence — the exact failure this step exists to
prevent.

## Coordinator obligations

- Synthesize; never forward a raw subagent transcript upward.
- Reconcile disagreements yourself — if scout says `USE_DIRECTLY` and
  archaeologist finds a blocking license, that is your call to make.
- A `REVISE` from the verifier goes back to a builder with the specific failure,
  not a rewrite request. Two `REVISE` rounds without semantic progress means the
  design is wrong; return to step 6.
- Keep the handoff to the caller in the step 10 format regardless of how many
  agents ran.
