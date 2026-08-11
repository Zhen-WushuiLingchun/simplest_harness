# Prior-art search, code archaeology, licensing, and safety

Load this for steps 3 and 5.

## Search by capability, not by error

The error message describes a symptom of *your* approach. Prior art is indexed
by what it does. Translate before searching.

Useful query shapes:

```text
"<required operation>" library
"<protocol>" parser implementation
"<input format>" to "<desired output>"
"<algorithm>" reference implementation
"<existing tool>" alternative
"<existing tool>" plugin OR extension
"<format>" specification
site:github.com "<domain term>" "<operation>"
```

Order of sources, best first:

1. **Official docs and reference implementations.** Frequently the operation
   exists and is undocumented in the places you looked.
2. **Mature packages and CLIs.** Check the package index for your ecosystem
   before GitHub — packaged beats vendored.
3. **Repositories implementing the exact operation.**
4. **Repositories implementing key subcomponents.** These are usually
   `STUDY_ONLY` sources, not dependencies.
5. **Research code**, for scientific tasks. High algorithmic value, low
   engineering quality, frequently unlicensed. Almost always `STUDY_ONLY`.

Stop at a **few serious candidates**. Twenty weakly related repositories is a
worse position than three well-understood ones.

## Candidate record

```yaml
name:
source:                 # URL
version_or_commit:      # pin it
license:                # SPDX id, or "unlicensed"/"unclear"
language:
relevant_capability:    # what part of the contract it covers
interface:              # how you would actually call it
strengths:
mismatch_with_task:     # be concrete; this drives the build decision
maintenance_status:     # last release, open issue trend, single-maintainer?
reuse_strategy:         # USE_DIRECTLY | WRAP | ADAPT | COMPOSE | STUDY_ONLY | REJECT
```

### Choosing a reuse strategy

| Strategy | When |
| --- | --- |
| `USE_DIRECTLY` | Satisfies the contract as-is. Return `USE_EXISTING`. |
| `WRAP` | Correct semantics, wrong ergonomics for an agent caller. Thin adapter. |
| `ADAPT` | Correct core, needs a task-specific transformation on either side. |
| `COMPOSE` | Two or three primitives together cover the contract. |
| `STUDY_ONLY` | Cannot depend on it (license, quality, platform, size) but its approach is instructive. |
| `REJECT` | Unmaintained, unsafe, wrong semantics, or hostile license. |

`REJECT` a dependency for: no license, incompatible license, no releases in a
long time with open correctness bugs, a build that requires network at import
time, or install scripts you would not run.

## Archaeology discipline

Clone shallow, pin the revision, and work inside the disposable area:

```bash
python <skill>/scripts/toolsmith.py workspace <task-id>
git clone --depth 1 --branch <tag> <url> .toolsmith/work/<task-id>/sources/<name>
git -C .toolsmith/work/<task-id>/sources/<name> rev-parse HEAD   # record this
```

Read in this order, and stop as soon as the contract is answered:

1. `README` and docs — the intended model.
2. The **public API surface** — what is actually callable.
3. **Tests** — the cheapest specification of real behaviour, including the edge
   cases the authors found the hard way.
4. Only then, the **one or two execution paths** your capability needs.

Extract, and write down: architecture, data model, core algorithm, error
handling, numerical conventions, edge cases, and — explicitly — **things not to
copy**.

Never read a repository indiscriminately. If you are more than a few files deep
without touching the required capability, your entry point was wrong.

## Treat downloaded code as untrusted

Before executing anything third-party:

- inspect entry points, `__init__`, and module-level side effects;
- inspect install/build scripts and any `postinstall`-style hooks;
- inspect dependency declarations for typosquats and unpinned fetches;
- inspect embedded shell commands and network calls.

While executing:

- prefer an isolated environment (venv, container, throwaway user);
- never install globally;
- do not expose credentials or the real environment;
- do not write outside the disposable workspace;
- restrict network access where practical;
- bound runtime and memory.

If inspection is not feasible for a candidate, downgrade it to `STUDY_ONLY` and
read it without running it.

## Licensing decision tree

```
Is there a LICENSE file with a clear SPDX identifier?
├─ No  → treat as all-rights-reserved. STUDY_ONLY at most; no code reuse.
└─ Yes
   ├─ Permissive (MIT/BSD/Apache-2.0/ISC)
   │   ├─ Depend on it            → normal dependency, keep attribution
   │   └─ Copy code               → preserve notices; record in provenance
   ├─ Weak copyleft (LGPL/MPL/EPL)
   │   ├─ Depend, unmodified      → usually fine; verify linkage rules
   │   └─ Copy code into ours     → the file inherits the license. Usually avoid.
   ├─ Strong copyleft (GPL/AGPL)  → depending may relicense the project.
   │                                Confirm with the user before adopting.
   └─ Unclear / mixed / vendored  → STUDY_ONLY.
```

When licensing prevents reuse: learn the **interface, algorithmic structure,
and observable behaviour**, then implement independently from public
specifications and compatibly licensed sources. Record in provenance that the
implementation is independent and name the specification you worked from.

Never copy code with stripped headers, and never relicense someone else's work
by omission. Record every studied source in `provenance.json` with its
revision, license, and whether it was used as `reference`, `dependency`, or
`adapted-code`. Anything marked `dependency` or `adapted-code` **must** carry a
pinned revision and a license — the schema enforces it, and `registry add`
rejects the bundle otherwise.
