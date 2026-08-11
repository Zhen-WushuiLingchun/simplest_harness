#!/usr/bin/env python3
"""Support CLI for the adaptive-toolsmith skill.

Stdlib only, so it runs wherever the harness runs. Output is a single JSON
document on stdout, diagnostics on stderr -- the same contract this skill asks
generated tools to follow.

    toolsmith.py workspace <task-id>          create a disposable study area
    toolsmith.py registry list                list registered capabilities
    toolsmith.py registry find <query>        search before building
    toolsmith.py registry add <tool-dir>      register a qualified current bundle
    toolsmith.py registry remove <name>       remove one entry, not its files
    toolsmith.py registry rebuild             derive a fresh index from qualified bundles
    toolsmith.py registry verify              re-check every bundle and digest
    toolsmith.py bundle verify <tool-dir>     check structure and qualification
    toolsmith.py bundle qualify <tool-dir>    explicitly run declared checks
    toolsmith.py validate <file> --kind K     check one file against a schema
    toolsmith.py selftest                     verify this script still works

The registry is a trust boundary: `registry add` takes a tool directory, not a
caller-written entry, verifies the whole bundle, and derives the entry itself.
Nothing enters the registry without a passing original blocked task.

Exit codes: 0 ok, 1 invalid input, 2 not found, 3 internal error.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "assets"
SCHEMAS = {
    "contract": "tool-contract.schema.json",
    "provenance": "provenance.schema.json",
    "qualification": "qualification.schema.json",
    "registry": "registry.schema.json",
}
REGISTRY_RELPATH = Path("tools") / "generated" / "registry.json"
REGISTRY_SCHEMA_VERSION = 2
EMPTY_REGISTRY = {"schema_version": REGISTRY_SCHEMA_VERSION, "tools": []}
QUALIFICATION_FILE = "qualification.json"
QUALIFICATION_SCHEMA_VERSION = 1
BUNDLE_IGNORED_DIRS = {"__pycache__"}
LOCK_TIMEOUT_S = 10.0
LOCK_STALE_S = 120.0


# --------------------------------------------------------------------------
# plumbing


def emit(payload: dict, code: int = 0) -> int:
    json.dump(payload, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return code


def fail(error_code: str, message: str, code: int = 1, **extra) -> int:
    return emit({"status": "error", "code": error_code, "message": message, **extra}, code)


def project_root(explicit=None) -> Path:
    if explicit:
        return Path(explicit).resolve()
    here = Path.cwd().resolve()
    for candidate in (here, *here.parents):
        if (candidate / ".git").exists():
            return candidate
    return here


def parse_json(text: str):
    """Parse JSON while rejecting duplicate keys that other parsers may resolve differently."""
    def unique_object(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate object key %r" % key)
            value[key] = item
        return value

    def reject_constant(value):
        # The stdlib accepts NaN and infinities by default even though they are
        # not JSON. Letting them reach numeric schema checks creates backend-
        # dependent results and can bypass bounds through NaN comparisons.
        raise ValueError("non-standard JSON numeric constant %r" % value)

    return json.loads(
        text,
        object_pairs_hook=unique_object,
        parse_constant=reject_constant,
    )


def load_schema(kind: str) -> dict:
    return parse_json((ASSETS / SCHEMAS[kind]).read_text(encoding="utf-8"))


def within(root: Path, path: Path) -> bool:
    """True when path is inside root after resolution -- blocks ../ escapes."""
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError, RuntimeError):
        return False


@contextlib.contextmanager
def locked(path: Path):
    """Exclusive lock around a read-modify-write of `path`."""
    lock = path.with_name(path.name + ".lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    while True:
        try:
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > LOCK_STALE_S:
                    lock.unlink()  # previous holder died
                    continue
            except OSError:
                continue
            if time.monotonic() - started > LOCK_TIMEOUT_S:
                raise TimeoutError("registry lock held by another process: %s" % lock)
            time.sleep(0.05)
    try:
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        yield
    finally:
        try:
            lock.unlink()
        except OSError:
            pass


def atomic_write(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw_tmp = tempfile.mkstemp(prefix=path.name + ".tmp-", dir=str(path.parent))
    tmp = Path(raw_tmp)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(str(tmp), str(path))
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


# --------------------------------------------------------------------------
# validation
#
# ponytail: uses jsonschema when installed, otherwise a subset validator. The
# subset must stay behaviourally equivalent to jsonschema for the bundled
# schemas -- `selftest` asserts that parity over a corpus of bad instances, so
# adding a schema keyword the fallback lacks fails the test rather than
# silently weakening validation on machines without jsonschema.
#
# Supported: $ref (local), allOf, if/then/else, type, required, enum, const,
# pattern, minLength, maxLength, minItems, items, properties, propertyNames,
# additionalProperties, minimum, maximum, exclusiveMinimum, exclusiveMaximum.
# NOT supported: format (deliberately -- jsonschema treats it as an annotation
# by default too, so the schemas use `pattern` instead), oneOf, anyOf, not.


def _json_equal(left, right) -> bool:
    """JSON Schema equality: numbers compare numerically, booleans do not."""
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(
            _json_equal(a, b) for a, b in zip(left, right)
        )
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(
            _json_equal(left[key], right[key]) for key in left
        )
    return left == right


def _type_ok(value, expected) -> bool:
    if isinstance(expected, list):
        return any(_type_ok(value, e) for e in expected)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return not isinstance(value, bool) and (
            isinstance(value, int)
            or (isinstance(value, float) and value.is_integer())
        )
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return {
        "string": lambda v: isinstance(v, str),
        "object": lambda v: isinstance(v, dict),
        "array": lambda v: isinstance(v, list),
        "null": lambda v: v is None,
    }.get(expected, lambda v: True)(value)


def _deref(schema: dict, root: dict) -> dict:
    seen = 0
    while "$ref" in schema and schema["$ref"].startswith("#/"):
        target = root
        for part in schema["$ref"][2:].split("/"):
            target = target[part]
        schema = target
        seen += 1
        if seen > 20:
            raise ValueError("$ref cycle")
    return schema


def _check(instance, schema: dict, root: dict, path: str = "$") -> list:
    schema = _deref(schema, root)
    errors: list = []

    for sub in schema.get("allOf", []):
        errors += _check(instance, sub, root, path)
    if "if" in schema:
        branch = "then" if not _check(instance, schema["if"], root, path) else "else"
        if branch in schema:
            errors += _check(instance, schema[branch], root, path)

    if "const" in schema and not _json_equal(instance, schema["const"]):
        errors.append("%s: expected %r" % (path, schema["const"]))
    if "enum" in schema and not any(
        _json_equal(instance, option) for option in schema["enum"]
    ):
        errors.append("%s: %r is not one of %s" % (path, instance, schema["enum"]))

    if "type" in schema and not _type_ok(instance, schema["type"]):
        errors.append(
            "%s: expected type %s, got %s" % (path, schema["type"], type(instance).__name__)
        )
        return errors  # further checks would be noise

    if isinstance(instance, bool):
        pass  # bool is an int in Python; never range-check it
    elif isinstance(instance, (int, float)):
        for key, ok, word in (
            ("minimum", lambda v, b: v >= b, "less than minimum"),
            ("maximum", lambda v, b: v <= b, "greater than maximum"),
            ("exclusiveMinimum", lambda v, b: v > b, "not greater than exclusiveMinimum"),
            ("exclusiveMaximum", lambda v, b: v < b, "not less than exclusiveMaximum"),
        ):
            if key in schema and not ok(instance, schema[key]):
                errors.append("%s: %r is %s %r" % (path, instance, word, schema[key]))

    if isinstance(instance, str):
        if len(instance) < schema.get("minLength", 0):
            errors.append("%s: shorter than minLength %d" % (path, schema["minLength"]))
        if "maxLength" in schema and len(instance) > schema["maxLength"]:
            errors.append("%s: longer than maxLength %d" % (path, schema["maxLength"]))
        pattern = schema.get("pattern")
        if pattern and not re.search(pattern, instance):
            errors.append("%s: %r does not match %s" % (path, instance, pattern))

    if isinstance(instance, list):
        if len(instance) < schema.get("minItems", 0):
            errors.append("%s: fewer than minItems %d" % (path, schema["minItems"]))
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for i, item in enumerate(instance):
                errors += _check(item, item_schema, root, "%s[%d]" % (path, i))

    if isinstance(instance, dict):
        for key in schema.get("required", []):
            if key not in instance:
                errors.append("%s: missing required property %r" % (path, key))
        properties = schema.get("properties", {})
        additional = schema.get("additionalProperties")
        names = schema.get("propertyNames")
        for key, value in instance.items():
            child = "%s.%s" % (path, key)
            if isinstance(names, dict):
                errors += ["%s: property name invalid (%s)" % (child, e) for e in _check(key, names, root, child)]
            if key in properties:
                errors += _check(value, properties[key], root, child)
            elif additional is False:
                errors.append("%s: unexpected property" % child)
            elif isinstance(additional, dict):
                errors += _check(value, additional, root, child)

    return errors


def _jsonschema():
    """Return a compatible jsonschema module, or None for absent/old versions."""
    try:
        import jsonschema  # type: ignore
    except ImportError:
        return None
    return jsonschema if getattr(jsonschema, "Draft202012Validator", None) else None


def validate(instance, schema: dict) -> list:
    """Return a list of human-readable error strings; empty means valid."""
    jsonschema = _jsonschema()
    if jsonschema is None:
        return _check(instance, schema, schema)
    validator = jsonschema.Draft202012Validator(schema)
    return [
        "$%s: %s" % ("".join(".%s" % p for p in e.absolute_path), e.message)
        for e in sorted(validator.iter_errors(instance), key=lambda e: list(e.absolute_path))
    ]


def _timestamp_problem(value, path: str):
    """Return one semantic timestamp problem, or None for a real aware datetime."""
    if not isinstance(value, str):
        return None  # the schema owns type errors
    candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return "%s: %r is not a real ISO-8601 datetime" % (path, value)
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return "%s: timestamp must include Z or an explicit UTC offset" % path
    return None


def validate_kind(instance, kind: str) -> list:
    """Run schema validation plus deterministic semantic checks for one asset kind."""
    errors = validate(instance, load_schema(kind))
    if not isinstance(instance, dict):
        return errors

    timestamp_paths = []
    if kind == "provenance":
        timestamp_paths.append((instance.get("generated_at"), "$.generated_at"))
    elif kind == "qualification":
        timestamp_paths.append((instance.get("qualified_at"), "$.qualified_at"))
    elif kind == "registry":
        tools = instance.get("tools", [])
        if not isinstance(tools, list):
            return errors
        names = [entry.get("name") for entry in tools if isinstance(entry, dict)]
        duplicates = sorted({name for name in names if name is not None and names.count(name) > 1})
        if duplicates:
            errors.append("$.tools: duplicate tool names: %s" % ", ".join(duplicates))
        for index, entry in enumerate(tools):
            if isinstance(entry, dict):
                timestamp_paths.extend(
                    [
                        (entry.get("qualified_at"), "$.tools[%d].qualified_at" % index),
                        (entry.get("registered_at"), "$.tools[%d].registered_at" % index),
                    ]
                )
    for value, path in timestamp_paths:
        if value is not None:
            problem = _timestamp_problem(value, path)
            if problem:
                errors.append(problem)
    return errors


# --------------------------------------------------------------------------
# bundle verification and explicit execution qualification


def cli_path(root: Path, raw) -> Path:
    """Resolve CLI paths against the declared project root, not process cwd."""
    path = Path(raw)
    return path if path.is_absolute() else root / path


def bundle_payload_files(tool_dir: Path):
    """Yield deterministic payload files; reject links that could escape the bundle."""
    paths = sorted(tool_dir.rglob("*"), key=lambda p: p.relative_to(tool_dir).as_posix())
    for path in paths:
        rel = path.relative_to(tool_dir)
        if path.is_symlink():
            raise ValueError("bundle contains a symlink: %s" % rel.as_posix())
        if payload_path_is_ignored(rel):
            continue
        if path.is_file():
            yield rel, path


def payload_path_is_ignored(rel: Path) -> bool:
    return (
        any(part in BUNDLE_IGNORED_DIRS for part in rel.parts)
        or rel.as_posix() == QUALIFICATION_FILE
        or rel.suffix == ".pyc"
    )


def bundle_digest(tool_dir: Path) -> str:
    """Hash payload paths and bytes, excluding the generated qualification record."""
    digestor = hashlib.sha256(b"adaptive-toolsmith-bundle-v1\0")
    for rel, path in bundle_payload_files(tool_dir):
        digestor.update(rel.as_posix().encode("utf-8"))
        digestor.update(b"\0")
        size = path.stat().st_size
        digestor.update(str(size).encode("ascii"))
        digestor.update(b"\0")
        with path.open("rb") as stream:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                digestor.update(chunk)
        digestor.update(b"\0")
    return digestor.hexdigest()


def resolve_bundle_command(tool_dir: Path, spec, label: str, problems: list):
    """Validate a structured command and return its declared file when safe."""
    if not isinstance(spec, dict):
        return None
    file_value = spec.get("file")
    argv = spec.get("argv")
    if not isinstance(file_value, str) or not isinstance(argv, list):
        return None  # schema errors already explain this
    if "\\" in file_value or Path(file_value).is_absolute():
        problems.append("%s file must be a portable bundle-relative path: %r" % (label, file_value))
        return None
    if payload_path_is_ignored(Path(file_value)):
        problems.append("%s file is excluded from the bundle digest: %r" % (label, file_value))
        return None
    try:
        candidate = (tool_dir / file_value).resolve()
    except (OSError, RuntimeError) as exc:
        problems.append("%s file cannot be resolved: %s" % (label, exc))
        return None
    if not within(tool_dir, candidate):
        problems.append("%s file escapes the bundle: %r" % (label, file_value))
        return None
    if not candidate.is_file():
        problems.append("%s file does not exist: %r" % (label, file_value))
        return None
    positions = [index for index, value in enumerate(argv) if value == file_value]
    if len(positions) != 1 or positions[0] not in (0, 1):
        problems.append(
            "%s file must appear exactly once as argv[0] (direct executable) or "
            "argv[1] (interpreter script): %r" % (label, file_value)
        )
        return None
    return candidate


def _declared_check(check_spec: dict) -> dict:
    return {
        "name": check_spec["name"],
        "kind": check_spec["kind"],
        "argv": list(check_spec["argv"]),
        "file": check_spec["file"],
        "expected_exit_code": check_spec.get("expected_exit_code", 0),
    }


def verify_bundle(root: Path, tool_dir: Path, qualification_mode: str = "optional") -> dict:
    """Verify structure and, unless ignored, a digest-bound qualification record.

    qualification_mode is "ignore" while creating a new record, "optional" for
    bundle inspection, and "required" for registry trust decisions.
    """
    problems, warnings = [], []
    empty = {
        "problems": problems,
        "entry": None,
        "warnings": warnings,
        "contract": None,
        "provenance": None,
        "qualification": None,
        "qualification_status": "missing",
        "bundle_digest": None,
    }
    try:
        root = root.resolve()
        tool_dir = tool_dir.resolve()
    except (OSError, RuntimeError) as exc:
        empty["problems"] = ["tool directory cannot be resolved: %s" % exc]
        return empty
    if not within(root, tool_dir):
        empty["problems"] = ["tool directory escapes the project root: %s" % tool_dir]
        return empty
    if not tool_dir.is_dir():
        empty["problems"] = ["no such tool directory: %s" % tool_dir]
        return empty

    def read(name, kind, required=True):
        path = tool_dir / name
        if not path.is_file():
            if required:
                problems.append("missing %s" % name)
            return None
        try:
            data = parse_json(path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError, OSError) as exc:
            problems.append("%s is not valid UTF-8 JSON: %s" % (name, exc))
            return None
        errors = validate_kind(data, kind)
        for err in errors:
            problems.append("%s %s" % (name, err))
        return None if errors else data

    contract = read("tool-contract.json", "contract")
    provenance = read("provenance.json", "provenance")
    entrypoint_path = None
    checks = []

    if contract and contract.get("name") != tool_dir.name:
        problems.append(
            "tool-contract.json name %r does not match directory name %r"
            % (contract.get("name"), tool_dir.name)
        )
    if contract:
        entrypoint_path = resolve_bundle_command(
            tool_dir, contract.get("entrypoint"), "entrypoint", problems
        )

    if provenance:
        validation = provenance.get("validation") or {}
        if validation.get("original_task_passed") is not True:
            problems.append(
                "provenance.validation.original_task_passed is not true -- the blocked "
                "task this tool was built for has not been shown to pass"
            )
        checks = validation.get("checks") or []
        kinds, names = [], []
        for index, check_spec in enumerate(checks):
            if not isinstance(check_spec, dict):
                continue
            label = "validation check %d (%s)" % (index, check_spec.get("name", "unnamed"))
            resolved = resolve_bundle_command(tool_dir, check_spec, label, problems)
            kind = check_spec.get("kind")
            kinds.append(kind)
            names.append(check_spec.get("name"))
            if resolved is not None and kind == "test" and not within(tool_dir / "tests", resolved):
                problems.append("%s must exercise a file inside tests/" % label)
            if (
                resolved is not None
                and kind == "original-task"
                and entrypoint_path is not None
                and resolved != entrypoint_path
            ):
                problems.append("%s must exercise the contract entrypoint file" % label)
        if "test" not in kinds:
            problems.append("provenance validation requires at least one test check")
        if "original-task" not in kinds:
            problems.append("provenance validation requires at least one original-task check")
        valid_names = [name for name in names if isinstance(name, str)]
        if len(valid_names) != len(set(valid_names)):
            problems.append("provenance validation check names must be unique")

    tests = tool_dir / "tests"
    if not tests.is_dir() or not any(path.is_file() for path in tests.rglob("*")):
        problems.append("missing or empty tests/ directory")
    if not (tool_dir / "README.md").is_file():
        warnings.append("no README.md in the bundle")

    digest_value = None
    try:
        digest_value = bundle_digest(tool_dir)
    except (OSError, ValueError) as exc:
        problems.append("cannot hash bundle payload: %s" % exc)

    qualification = None
    qualification_status = "ignored" if qualification_mode == "ignore" else "missing"
    if qualification_mode != "ignore":
        qualification = read(
            QUALIFICATION_FILE,
            "qualification",
            required=qualification_mode == "required",
        )
        if qualification is None:
            if qualification_mode == "optional" and not (tool_dir / QUALIFICATION_FILE).exists():
                warnings.append("bundle is structurally valid but not qualified; registry add will refuse it")
        else:
            qualification_status = "invalid"
            declared = [_declared_check(check) for check in checks if isinstance(check, dict)]
            recorded_results = qualification.get("checks", [])
            observed = []
            for result in recorded_results:
                if isinstance(result, dict):
                    observed.append(
                        {
                            "name": result.get("name"),
                            "kind": result.get("kind"),
                            "argv": result.get("argv"),
                            "file": result.get("file"),
                            "expected_exit_code": result.get("expected_exit_code"),
                        }
                    )
            q_problems = []
            declarations_match = observed == declared
            if not declarations_match:
                q_problems.append("recorded checks do not match provenance validation checks")
            bundle_unchanged = qualification.get("bundle_unchanged") is True
            if not bundle_unchanged:
                q_problems.append("bundle changed while qualification commands ran")
            before_matches = bool(
                digest_value and qualification.get("bundle_digest_before") == digest_value
            )
            after_matches = bool(
                digest_value and qualification.get("bundle_digest_after") == digest_value
            )
            if not before_matches:
                q_problems.append("bundle digest no longer matches qualification input")
            if not after_matches:
                q_problems.append("bundle digest no longer matches qualification output")

            computed_passes = []
            for result in recorded_results:
                if not isinstance(result, dict):
                    continue
                computed = (
                    result.get("timed_out") is False
                    and result.get("exit_code") == result.get("expected_exit_code")
                )
                computed_passes.append(computed)
                if result.get("passed") is not computed:
                    q_problems.append(
                        "check %r passed flag disagrees with its timeout/exit code"
                        % result.get("name")
                    )
            original_results = [
                result
                for result in recorded_results
                if isinstance(result, dict) and result.get("kind") == "original-task"
            ]
            computed_original = bool(original_results) and all(
                result.get("passed") is True for result in original_results
            )
            if qualification.get("original_task_passed") is not computed_original:
                q_problems.append("original_task_passed disagrees with recorded original-task checks")
            if not computed_original:
                q_problems.append("qualification did not observe the original task passing")

            computed_overall = (
                declarations_match
                and bundle_unchanged
                and before_matches
                and after_matches
                and computed_original
                and len(computed_passes) == len(recorded_results)
                and all(computed_passes)
            )
            if qualification.get("overall_passed") is not computed_overall:
                q_problems.append("overall_passed disagrees with the recorded evidence")
            if not computed_overall:
                q_problems.append("qualification overall_passed is not true")
            if q_problems:
                problems.extend("%s %s" % (QUALIFICATION_FILE, p) for p in q_problems)
            else:
                qualification_status = "current"

    entry = None
    if (
        not problems
        and contract
        and provenance
        and qualification
        and qualification_status == "current"
        and digest_value
    ):
        inputs = contract.get("inputs") or {}
        outputs = contract.get("outputs") or {}
        entry = {
            "name": contract["name"],
            "purpose": contract["purpose"],
            "keywords": list(contract.get("keywords", [])),
            "path": tool_dir.relative_to(root).as_posix(),
            "entrypoint": contract["entrypoint"],
            "input_contract": ", ".join(
                "%s:%s%s" % (k, v.get("type", "?"), "" if v.get("required") else "?")
                for k, v in sorted(inputs.items())
            )
            or "none",
            "output_contract": "%s -> %s"
            % (outputs.get("format", "?"), outputs.get("destination", "stdout")),
            "validated_on": [check["name"] for check in checks],
            "known_limitations": list(provenance.get("known_limitations", [])),
            "version": contract["version"],
            "bundle_digest": digest_value,
            "qualification": (tool_dir / QUALIFICATION_FILE).relative_to(root).as_posix(),
            "qualified_at": qualification["qualified_at"],
        }
        entry = {k: v for k, v in entry.items() if v not in ([], "")}
        candidate_registry = {
            "schema_version": REGISTRY_SCHEMA_VERSION,
            "tools": [{**entry, "registered_at": qualification["qualified_at"]}],
        }
        for err in validate_kind(candidate_registry, "registry"):
            problems.append("derived registry entry %s" % err)
        if problems:
            entry = None

    return {
        "problems": problems,
        "entry": entry,
        "warnings": warnings,
        "contract": contract,
        "provenance": provenance,
        "qualification": qualification,
        "qualification_status": qualification_status,
        "bundle_digest": digest_value,
    }


# --------------------------------------------------------------------------
# commands


def gitignore_status(root: Path, path: Path):
    """Return True/False from Git's own matcher, or None when unavailable."""
    git = shutil.which("git")
    if git is None or not (root / ".git").exists():
        return None
    try:
        rel = path.resolve().relative_to(root.resolve()).as_posix()
        result = subprocess.run(
            [git, "-C", str(root), "check-ignore", "-q", "--no-index", rel],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    return None


def cmd_workspace(args) -> int:
    task_id = args.task_id
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", task_id):
        return fail(
            "INVALID_TASK_ID",
            "task-id must be 1-64 chars of [A-Za-z0-9._-] and start alphanumeric; "
            "got %r" % task_id,
        )
    root = project_root(args.root)
    base = root / ".toolsmith" / "work" / task_id
    made = {}
    for name in ("sources", "build", "notes"):
        path = base / name
        path.mkdir(parents=True, exist_ok=True)
        made[name] = str(path)

    ignored = gitignore_status(root, base)
    result = {"workspace": str(base), **made, "gitignored": ignored}
    if ignored is False:
        result["warning"] = (
            "'.toolsmith/' is NOT ignored by this project. Add '.toolsmith/work/' to "
            ".gitignore before cloning third-party sources into it, or they will be "
            "staged with your commits."
        )
    elif ignored is None:
        result["warning"] = (
            "Could not determine whether '.toolsmith/work/' is ignored because Git "
            "matching is unavailable. Verify it before placing third-party sources there."
        )
    result["note"] = (
        "Disposable. Clone third-party sources into 'sources' at a pinned revision; "
        "never execute them outside it."
    )
    return emit({"status": "ok", "result": result})


def read_registry(root: Path) -> dict:
    """Load and validate the registry file. Raises ValueError when unusable."""
    path = root / REGISTRY_RELPATH
    if not path.exists():
        return json.loads(json.dumps(EMPTY_REGISTRY))
    try:
        data = parse_json(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError, OSError) as exc:
        raise ValueError("registry at %s is not readable UTF-8 JSON: %s" % (path, exc))
    errors = validate_kind(data, "registry")
    if errors:
        raise ValueError(
            "registry at %s does not match the registry schema: %s" % (path, "; ".join(errors))
        )
    return data


def _stream_evidence(data) -> dict:
    if data is None:
        raw = b""
    elif isinstance(data, bytes):
        raw = data
    else:
        raw = str(data).encode("utf-8", errors="replace")
    return {
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def _drain_stream(stream, evidence: dict):
    """Hash and discard one pipe in constant memory."""
    digestor = hashlib.sha256()
    size = 0
    try:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                break
            size += len(chunk)
            digestor.update(chunk)
    except (OSError, ValueError):
        # A timed-out descendant can keep an inherited pipe open. Closing our
        # read end bounds the wait; the record still covers every observed byte.
        pass
    finally:
        evidence.update({"bytes": size, "sha256": digestor.hexdigest()})


def _expanded_argv(argv: list, tmp_dir: Path) -> list:
    expanded = []
    for value in argv:
        if value == "{python}":
            expanded.append(sys.executable)
        else:
            expanded.append(value.replace("{tmp}", str(tmp_dir)))
    return expanded


def run_qualification_check(tool_dir: Path, check_spec: dict, tmp_dir: Path) -> dict:
    """Run one check, hashing and discarding output in constant memory."""
    declared = _declared_check(check_spec)
    argv = _expanded_argv(check_spec["argv"], tmp_dir)
    timeout_seconds = check_spec.get("timeout_seconds", 60)
    started = time.monotonic()
    exit_code, timed_out = None, False
    stdout_evidence = _stream_evidence(b"")
    stderr_evidence = _stream_evidence(b"")
    streams_and_threads = []
    try:
        process = subprocess.Popen(
            argv,
            cwd=str(tool_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
        )
        stdout_evidence, stderr_evidence = {}, {}
        for stream, evidence in (
            (process.stdout, stdout_evidence),
            (process.stderr, stderr_evidence),
        ):
            thread = threading.Thread(
                target=_drain_stream,
                args=(stream, evidence),
                daemon=True,
            )
            thread.start()
            streams_and_threads.append((stream, thread))
        try:
            exit_code = process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.kill()
            exit_code = process.wait()
    except OSError as exc:
        stderr_evidence = _stream_evidence(
            ("%s: %s" % (type(exc).__name__, exc)).encode("utf-8", errors="replace")
        )
    finally:
        for _, thread in streams_and_threads:
            thread.join(timeout=1)
        for stream, thread in streams_and_threads:
            if thread.is_alive():
                try:
                    stream.close()
                except OSError:
                    pass
        for _, thread in streams_and_threads:
            thread.join(timeout=1)
    duration_ms = max(0, int((time.monotonic() - started) * 1000))
    return {
        **declared,
        "exit_code": exit_code,
        "timed_out": timed_out,
        "passed": not timed_out and exit_code == declared["expected_exit_code"],
        "duration_ms": duration_ms,
        "stdout": stdout_evidence,
        "stderr": stderr_evidence,
    }


def qualify_bundle(root: Path, tool_dir: Path) -> tuple:
    """Execute declared checks and atomically write their digest-bound record."""
    report = verify_bundle(root, tool_dir, qualification_mode="ignore")
    if report["problems"]:
        return None, report

    before = report["bundle_digest"]
    checks = report["provenance"]["validation"]["checks"]
    with tempfile.TemporaryDirectory(prefix="adaptive-toolsmith-qualify-") as tmp:
        results = [
            run_qualification_check(tool_dir, check_spec, Path(tmp)) for check_spec in checks
        ]
    try:
        after = bundle_digest(tool_dir)
    except (OSError, ValueError) as exc:
        after = hashlib.sha256(("unhashable: %s" % exc).encode("utf-8")).hexdigest()
    unchanged = before == after
    original = [result for result in results if result["kind"] == "original-task"]
    original_passed = bool(original) and all(result["passed"] for result in original)
    overall = unchanged and original_passed and all(result["passed"] for result in results)
    record = {
        "schema_version": QUALIFICATION_SCHEMA_VERSION,
        "qualified_at": datetime.now(timezone.utc).isoformat(),
        "bundle_digest_before": before,
        "bundle_digest_after": after,
        "bundle_unchanged": unchanged,
        "checks": results,
        "original_task_passed": original_passed,
        "overall_passed": overall,
    }
    errors = validate_kind(record, "qualification")
    if errors:
        report["problems"].extend("generated qualification %s" % err for err in errors)
        return None, report
    qualification_path = tool_dir / QUALIFICATION_FILE
    with locked(qualification_path):
        atomic_write(qualification_path, json.dumps(record, indent=2, ensure_ascii=False) + "\n")
    return record, report


def audit_registry_entries(root: Path, tools: list) -> tuple:
    """Return current entries and stale diagnostics without executing bundle code."""
    current, stale = [], []
    for stored in tools:
        tool_dir = root / stored["path"]
        report = verify_bundle(root, tool_dir, qualification_mode="required")
        problems = list(report["problems"])
        if report["entry"] is not None:
            stable_stored = {k: v for k, v in stored.items() if k != "registered_at"}
            if stable_stored != report["entry"]:
                problems.append("stored entry no longer matches the derived bundle entry")
        if problems:
            stale.append({"name": stored.get("name", "?"), "problems": problems})
        else:
            current.append(stored)
    return current, stale


def rebuild_registry(root: Path, path: Path) -> tuple:
    """Derive a complete registry from qualified bundle directories.

    This is the explicit recovery path for a legacy or corrupt registry. It
    never executes bundle code and refuses a partial rebuild: if a directory
    looks like a bundle but is not currently qualified, nothing is written.
    """
    generated = path.parent
    with locked(path):
        candidates = []
        if generated.is_dir():
            for candidate in sorted(generated.iterdir(), key=lambda item: item.name):
                if candidate.name == path.name or not candidate.is_dir():
                    continue
                marker_names = ("tool-contract.json", "provenance.json", QUALIFICATION_FILE)
                if any((candidate / marker).exists() for marker in marker_names):
                    candidates.append(candidate)

        reports, rejected = [], []
        for candidate in candidates:
            if candidate.is_symlink():
                rejected.append(
                    {
                        "bundle": candidate.relative_to(root).as_posix(),
                        "problems": ["bundle directory is a symlink"],
                    }
                )
                continue
            report = verify_bundle(root, candidate, qualification_mode="required")
            if report["problems"]:
                rejected.append(
                    {
                        "bundle": candidate.relative_to(root).as_posix(),
                        "problems": report["problems"],
                    }
                )
            else:
                reports.append(report)
        if rejected:
            return None, rejected

        # Preserve timestamps only when the old registry is itself current and
        # the derived entry is byte-for-byte unchanged. Legacy/corrupt data is
        # never carried across the recovery boundary.
        existing_by_name = {}
        try:
            existing = read_registry(root)
        except ValueError:
            existing = EMPTY_REGISTRY
        for stored in existing.get("tools", []):
            existing_by_name[stored.get("name")] = stored

        now = datetime.now(timezone.utc).isoformat()
        tools = []
        for report in reports:
            entry = dict(report["entry"])
            old = existing_by_name.get(entry["name"])
            if old and {k: v for k, v in old.items() if k != "registered_at"} == entry:
                entry["registered_at"] = old["registered_at"]
            else:
                entry["registered_at"] = now
            tools.append(entry)
        tools.sort(key=lambda item: item["name"])
        registry = {"schema_version": REGISTRY_SCHEMA_VERSION, "tools": tools}
        errors = validate_kind(registry, "registry")
        if errors:
            raise ValueError("derived registry is invalid: %s" % "; ".join(errors))
        atomic_write(path, json.dumps(registry, indent=2, ensure_ascii=False) + "\n")
    return registry, []


def cmd_registry(args) -> int:
    root = project_root(args.root)
    path = root / REGISTRY_RELPATH

    if args.action == "rebuild":
        try:
            registry, rejected = rebuild_registry(root, path)
        except ValueError as exc:
            return fail("INTERNAL_ERROR", str(exc), 3)
        if rejected:
            return fail(
                "BUNDLE_REJECTED",
                "rebuild refused because one or more bundle directories are not qualified",
                1,
                result={"path": str(path), "rejected": rejected},
            )
        return emit(
            {
                "status": "ok",
                "result": {
                    "path": str(path),
                    "action": "rebuilt",
                    "total": len(registry["tools"]),
                    "names": [entry["name"] for entry in registry["tools"]],
                },
            }
        )

    try:
        registry = read_registry(root)
    except ValueError as exc:
        return fail("CORRUPT_REGISTRY", str(exc))
    tools = registry.get("tools", [])

    if args.action in ("list", "verify", "find"):
        current, stale = audit_registry_entries(root, tools)
        if args.action == "list":
            return emit(
                {
                    "status": "ok" if not stale else "error",
                    **({} if not stale else {"code": "STALE_REGISTRY_ENTRIES"}),
                    "result": {"path": str(path), "tools": current, "stale": stale},
                },
                0 if not stale else 1,
            )
        if args.action == "verify":
            return emit(
                {
                    "status": "ok" if not stale else "error",
                    **({} if not stale else {"code": "STALE_REGISTRY_ENTRIES"}),
                    "result": {
                        "path": str(path),
                        "registered": len(tools),
                        "current": len(current),
                        "stale": stale,
                    },
                },
                0 if not stale else 1,
            )

    if args.action == "find":
        needles = [t for t in re.split(r"[\s,]+", args.query.lower()) if t]
        matches = []
        for tool in current:
            haystack = " ".join(
                [tool.get("name", ""), tool.get("purpose", "")] + list(tool.get("keywords", []))
            ).lower()
            score = sum(1 for n in needles if n in haystack)
            if score:
                matches.append((score, tool))
        matches.sort(key=lambda pair: -pair[0])
        result = [tool for _, tool in matches]
        return emit(
            {
                "status": "ok" if not stale else "error",
                **({} if not stale else {"code": "STALE_REGISTRY_ENTRIES"}),
                "result": {
                    "query": args.query,
                    "matches": result,
                    "stale": stale,
                    "hint": "Extend or compose an existing capability before building a new one."
                    if result
                    else "No existing capability matched; proceed to prior-art search.",
                },
            },
            0 if not stale else 1,
        )

    if args.action == "remove":
        with locked(path):
            try:
                registry = read_registry(root)
            except ValueError as exc:
                return fail("CORRUPT_REGISTRY", str(exc))
            previous = registry.get("tools", [])
            tools = [tool for tool in previous if tool.get("name") != args.target]
            if len(tools) == len(previous):
                return fail("NOT_FOUND", "no registered tool named %r" % args.target, 2)
            atomic_write(
                path,
                json.dumps(
                    {"schema_version": REGISTRY_SCHEMA_VERSION, "tools": tools},
                    indent=2,
                    ensure_ascii=False,
                )
                + "\n",
            )
        return emit(
            {
                "status": "ok",
                "result": {"path": str(path), "name": args.target, "action": "removed"},
            }
        )

    # add <tool-dir>
    tool_dir = cli_path(root, args.tool_dir)
    report = verify_bundle(root, tool_dir, qualification_mode="required")
    if report["problems"]:
        return fail(
            "BUNDLE_REJECTED",
            "%d problem(s); nothing was registered" % len(report["problems"]),
            1,
            result={"problems": report["problems"], "warnings": report["warnings"]},
        )
    with locked(path):
        # Re-check under the registry lock to narrow the bundle/read/write race.
        report = verify_bundle(root, tool_dir, qualification_mode="required")
        if report["problems"]:
            return fail(
                "BUNDLE_REJECTED",
                "bundle changed before registration; nothing was registered",
                1,
                result={"problems": report["problems"], "warnings": report["warnings"]},
            )
        entry = dict(report["entry"])
        try:
            registry = read_registry(root)
        except ValueError as exc:
            return fail("CORRUPT_REGISTRY", str(exc))
        tools = registry.get("tools", [])
        others = [tool for tool in tools if tool.get("name") != entry["name"]]
        _, stale_others = audit_registry_entries(root, others)
        if stale_others:
            return fail(
                "STALE_REGISTRY_ENTRIES",
                "repair or remove stale registry entries before adding another tool",
                1,
                result={"stale": stale_others},
            )
        existing = next((tool for tool in tools if tool.get("name") == entry["name"]), None)
        replaced = existing is not None
        if existing and {k: v for k, v in existing.items() if k != "registered_at"} == entry:
            entry["registered_at"] = existing["registered_at"]
            action = "unchanged"
        else:
            entry["registered_at"] = datetime.now(timezone.utc).isoformat()
            action = "updated" if replaced else "added"
        tools = [t for t in tools if t.get("name") != entry["name"]] + [entry]
        tools.sort(key=lambda t: t.get("name", ""))
        registry = {"schema_version": REGISTRY_SCHEMA_VERSION, "tools": tools}
        registry_errors = validate_kind(registry, "registry")
        if registry_errors:
            return fail("INTERNAL_ERROR", "derived registry is invalid: %s" % "; ".join(registry_errors), 3)
        atomic_write(path, json.dumps(registry, indent=2, ensure_ascii=False) + "\n")

    return emit(
        {
            "status": "ok",
            "result": {
                "path": str(path),
                "name": entry["name"],
                "action": action,
                "total": len(tools),
                "warnings": report["warnings"],
            },
        }
    )


def cmd_bundle(args) -> int:
    root = project_root(args.root)
    tool_dir = cli_path(root, args.tool_dir)
    if args.action == "qualify":
        record, report = qualify_bundle(root, tool_dir)
        if record is None:
            return fail(
                "BUNDLE_REJECTED",
                "%d structural problem(s); qualification did not run" % len(report["problems"]),
                1,
                result={"problems": report["problems"], "warnings": report["warnings"]},
            )
        result = {
            "bundle": str(tool_dir),
            "qualification": str(tool_dir / QUALIFICATION_FILE),
            "bundle_digest": record["bundle_digest_after"],
            "checks": record["checks"],
            "bundle_unchanged": record["bundle_unchanged"],
            "original_task_passed": record["original_task_passed"],
            "overall_passed": record["overall_passed"],
        }
        if not record["overall_passed"]:
            return fail(
                "QUALIFICATION_FAILED",
                "one or more checks failed or mutated the bundle",
                1,
                result=result,
            )
        return emit({"status": "ok", "result": result})

    report = verify_bundle(root, tool_dir, qualification_mode="optional")
    if report["problems"]:
        return fail(
            "BUNDLE_REJECTED",
            "%d problem(s)" % len(report["problems"]),
            1,
            result={"problems": report["problems"], "warnings": report["warnings"]},
        )
    return emit(
        {
            "status": "ok",
            "result": {
                "bundle": str(tool_dir),
                "bundle_digest": report["bundle_digest"],
                "qualification_status": report["qualification_status"],
                "would_register": report["entry"],
                "warnings": report["warnings"],
            },
        }
    )


def cmd_validate(args) -> int:
    root = project_root(args.root)
    target = cli_path(root, args.file)
    if not target.exists():
        return fail("FILE_NOT_FOUND", "no such file: %s" % target, 2)
    try:
        instance = parse_json(target.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError, OSError) as exc:
        return fail("INVALID_JSON", "%s is not readable UTF-8 JSON: %s" % (target, exc))
    errors = validate_kind(instance, args.kind)
    if errors:
        return fail("SCHEMA_VIOLATION", "%d problem(s): %s" % (len(errors), "; ".join(errors)))
    return emit({"status": "ok", "result": {"file": str(target), "kind": args.kind, "valid": True}})


# --------------------------------------------------------------------------
# selftest


class SelfTestFailure(Exception):
    pass


def check(condition, message):
    """Like assert, but `python -O` cannot strip it."""
    if not condition:
        raise SelfTestFailure(message)


GOOD_CONTRACT = {
    "name": "extract-qnm-modes",
    "version": "0.1.0",
    "purpose": "Extract quasinormal mode amplitudes from an SXS waveform file.",
    "keywords": ["qnm", "ringdown modes"],
    "entrypoint": {"argv": ["python", "src/run.py"], "file": "src/run.py"},
    "inputs": {"waveform_path": {"type": "path", "required": True}},
    "outputs": {"format": "json"},
}
GOOD_PROVENANCE = {
    "generated_for": "blocked on reading SXS waveforms",
    "generated_at": "2026-08-08T00:00:00+00:00",
    "sources_studied": [],
    "validation": {
        "original_task_passed": True,
        "checks": [
            {
                "name": "unit-tests",
                "kind": "test",
                "argv": ["{python}", "tests/test_run.py"],
                "file": "tests/test_run.py",
            },
            {
                "name": "original-blocked-task",
                "kind": "original-task",
                "argv": ["{python}", "src/run.py", "--fixture", "tests/original.json"],
                "file": "src/run.py",
            },
        ],
    },
}
EMPTY_STREAM = {
    "bytes": 0,
    "sha256": hashlib.sha256(b"").hexdigest(),
}
GOOD_QUALIFICATION = {
    "schema_version": 1,
    "qualified_at": "2026-08-08T00:00:00+00:00",
    "bundle_digest_before": "0" * 64,
    "bundle_digest_after": "0" * 64,
    "bundle_unchanged": True,
    "checks": [
        {
            **_declared_check(check),
            "exit_code": 0,
            "timed_out": False,
            "passed": True,
            "duration_ms": 1,
            "stdout": EMPTY_STREAM,
            "stderr": EMPTY_STREAM,
        }
        for check in GOOD_PROVENANCE["validation"]["checks"]
    ],
    "original_task_passed": True,
    "overall_passed": True,
}
GOOD_REGISTRY = {
    "schema_version": REGISTRY_SCHEMA_VERSION,
    "tools": [
        {
            "name": GOOD_CONTRACT["name"],
            "purpose": GOOD_CONTRACT["purpose"],
            "keywords": GOOD_CONTRACT["keywords"],
            "path": "tools/generated/extract-qnm-modes",
            "entrypoint": GOOD_CONTRACT["entrypoint"],
            "input_contract": "waveform_path:path",
            "output_contract": "json -> stdout",
            "validated_on": ["unit-tests", "original-blocked-task"],
            "version": GOOD_CONTRACT["version"],
            "bundle_digest": "0" * 64,
            "qualification": "tools/generated/extract-qnm-modes/qualification.json",
            "qualified_at": "2026-08-08T00:00:00+00:00",
            "registered_at": "2026-08-08T00:01:00+00:00",
        }
    ],
}


def _bad_instances():
    """(kind, instance, why) pairs that every validator must reject."""
    g = GOOD_CONTRACT
    return [
        ("contract", {**g, "name": "Extract_QNM"}, "name pattern"),
        ("contract", {**g, "version": "0.1"}, "version pattern"),
        ("contract", {k: v for k, v in g.items() if k != "purpose"}, "missing required"),
        ("contract", {**g, "outputs": {"format": "yaml"}}, "enum"),
        ("contract", {**g, "inputs": {"x": {"type": "path", "required": "yes"}}}, "bool type"),
        ("contract", {**g, "outputs": {"format": "json", "max_bytes": 0}}, "minimum"),
        ("contract", {**g, "resource_limits": {"timeout_seconds": 0}}, "exclusiveMinimum"),
        ("contract", {**g, "exit_codes": {"nope": "boom"}}, "propertyNames"),
        ("contract", {**g, "purpose": "short"}, "minLength"),
        ("contract", {**g, "keywords": [""]}, "keyword minLength"),
        ("contract", {**g, "entrypoint": "python src/run.py"}, "structured entrypoint"),
        ("provenance", {**GOOD_PROVENANCE, "generated_at": "NOT-A-DATE"}, "timestamp pattern"),
        (
            "provenance",
            {
                **GOOD_PROVENANCE,
                "sources_studied": [{"repository": "r", "usage": "dependency"}],
            },
            "conditional: dependency requires revision and license",
        ),
        (
            "provenance",
            {**GOOD_PROVENANCE, "validation": {"original_task_passed": True, "checks": []}},
            "minItems",
        ),
        (
            "provenance",
            {
                **GOOD_PROVENANCE,
                "validation": {
                    "original_task_passed": True,
                    "checks": [
                        {
                            **GOOD_PROVENANCE["validation"]["checks"][0],
                            "timeout_seconds": 0,
                        }
                    ],
                },
            },
            "check timeout exclusiveMinimum",
        ),
        (
            "qualification",
            {**GOOD_QUALIFICATION, "bundle_digest_before": "not-a-digest"},
            "qualification digest pattern",
        ),
        (
            "qualification",
            {**GOOD_QUALIFICATION, "overall_passed": "yes"},
            "qualification boolean type",
        ),
        (
            "qualification",
            {**GOOD_QUALIFICATION, "schema_version": True},
            "qualification numeric const must reject boolean",
        ),
        ("registry", {**GOOD_REGISTRY, "schema_version": 99}, "registry version const"),
        (
            "registry",
            {
                **GOOD_REGISTRY,
                "tools": [
                    {
                        k: v
                        for k, v in GOOD_REGISTRY["tools"][0].items()
                        if k != "registered_at"
                    }
                ],
            },
            "registry registered_at required",
        ),
        (
            "registry",
            {
                **GOOD_REGISTRY,
                "tools": [{**GOOD_REGISTRY["tools"][0], "bundle_digest": "bad"}],
            },
            "registry digest pattern",
        ),
    ]


def cmd_selftest(args) -> int:
    results = {}

    # Python's JSON decoder is intentionally more permissive than RFC 8259.
    # Trust-boundary files must reject those extensions before schema checks.
    invalid_json = (
        '{"value": NaN}',
        '{"value": Infinity}',
        '{"value": -Infinity}',
        '{"value": 1, "value": 2}',
    )
    for document in invalid_json:
        try:
            parse_json(document)
        except ValueError:
            pass
        else:
            check(False, "non-standard or ambiguous JSON accepted: %s" % document)
    results["strict_json_constants_rejected"] = True

    # 1. the good instances validate
    good_instances = (
        ("contract", GOOD_CONTRACT),
        ("provenance", GOOD_PROVENANCE),
        ("qualification", GOOD_QUALIFICATION),
        ("registry", GOOD_REGISTRY),
    )
    for kind, good in good_instances:
        errs = validate_kind(good, kind)
        check(errs == [], "valid %s rejected: %s" % (kind, errs))
    results["positive_cases"] = len(good_instances)

    # JSON Schema considers mathematically integral JSON numbers integers,
    # even when the Python representation is a float such as 1.0.
    integral_contract = json.loads(json.dumps(GOOD_CONTRACT))
    integral_contract["outputs"]["max_bytes"] = 1.0
    integral_qualification = json.loads(json.dumps(GOOD_QUALIFICATION))
    integral_qualification["checks"][0]["exit_code"] = 0.0
    integral_qualification["checks"][0]["duration_ms"] = 1.0
    for kind, instance in (
        ("contract", integral_contract),
        ("qualification", integral_qualification),
    ):
        schema = load_schema(kind)
        check(not _check(instance, schema, schema), "builtin rejected integral float in %s" % kind)
        js_for_number = _jsonschema()
        if js_for_number is not None:
            check(
                not list(js_for_number.Draft202012Validator(schema).iter_errors(instance)),
                "jsonschema rejected integral float in %s" % kind,
            )
    results["integral_number_semantics"] = True

    equality_cases = (
        (True, {"const": 1}, "boolean matched numeric const"),
        (True, {"enum": [1, 2]}, "boolean matched numeric enum"),
        ([True], {"const": [1]}, "nested boolean matched numeric const"),
    )
    for instance, schema, message in equality_cases:
        check(_check(instance, schema, schema), message)
        js_for_equality = _jsonschema()
        if js_for_equality is not None:
            fallback_rejects = bool(_check(instance, schema, schema))
            strict_rejects = bool(
                list(js_for_equality.Draft202012Validator(schema).iter_errors(instance))
            )
            check(fallback_rejects == strict_rejects, "JSON equality parity broken: %s" % message)
    results["json_equality_semantics"] = True

    # 2. every bad instance is rejected, by whichever validator is active
    for kind, bad, why in _bad_instances():
        check(validate_kind(bad, kind), "%s: bad instance accepted (%s)" % (kind, why))
    results["negative_cases"] = len(_bad_instances())
    impossible = {**GOOD_PROVENANCE, "generated_at": "2026-99-99T99:99:99+00:00"}
    check(validate_kind(impossible, "provenance"), "semantic impossible datetime accepted")
    results["semantic_timestamp_check"] = True

    # 3. the fallback and jsonschema agree -- this is what stops the subset
    #    validator drifting away from the schemas it is supposed to enforce
    js = _jsonschema()
    if js is None:
        results["parity"] = "skipped (jsonschema not installed)"
    else:
        disagreements = []
        for kind, bad, why in _bad_instances():
            schema = load_schema(kind)
            fallback_rejects = bool(_check(bad, schema, schema))
            strict_rejects = bool(list(js.Draft202012Validator(schema).iter_errors(bad)))
            if fallback_rejects != strict_rejects:
                disagreements.append(
                    "%s/%s: fallback=%s jsonschema=%s" % (kind, why, fallback_rejects, strict_rejects)
                )
        for kind, good in good_instances:
            schema = load_schema(kind)
            if bool(_check(good, schema, schema)) or bool(
                list(js.Draft202012Validator(schema).iter_errors(good))
            ):
                disagreements.append("%s: valid instance rejected" % kind)
        check(not disagreements, "validator parity broken: %s" % "; ".join(disagreements))
        results["parity"] = "fallback matches jsonschema on %d cases" % (
            len(_bad_instances()) + len(good_instances)
        )

    # An installed pre-Draft-2020 jsonschema must remain optional, not crash us.
    sentinel = object()
    saved_jsonschema = sys.modules.get("jsonschema", sentinel)

    class OldJSONSchema:
        __version__ = "old"

    sys.modules["jsonschema"] = OldJSONSchema()
    try:
        check(_jsonschema() is None, "old jsonschema was treated as a compatible backend")
    finally:
        if saved_jsonschema is sentinel:
            del sys.modules["jsonschema"]
        else:
            sys.modules["jsonschema"] = saved_jsonschema
    results["old_jsonschema_falls_back"] = True

    # Qualification timeouts fail closed without relying on a platform shell.
    with tempfile.TemporaryDirectory() as timeout_tmp:
        timed = run_qualification_check(
            Path(timeout_tmp),
            {
                "name": "timeout-check",
                "kind": "test",
                "argv": ["{python}", "-c", "import time; time.sleep(1)"],
                "file": "tests/timeout.py",
                "timeout_seconds": 0.01,
            },
            Path(timeout_tmp),
        )
        check(timed["timed_out"] and not timed["passed"], "qualification timeout passed")
    results["qualification_timeout_fails_closed"] = True

    # 4. registry trust gate: bundles, not caller-written entries
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / ".git").mkdir()
        (root / "README.md").write_text("project root, not a tool\n", encoding="utf-8")
        ns = argparse.Namespace(root=str(root), action="add", target="", tool_dir="", query=None)

        def call(fn, **kw):
            for k, v in kw.items():
                setattr(ns, k, v)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = fn(ns)
            return code, json.loads(output.getvalue())

        def run(fn, **kw):
            return call(fn, **kw)[0]

        tool = root / "tools" / "generated" / "extract-qnm-modes"
        (tool / "src").mkdir(parents=True)
        (tool / "tests").mkdir()

        # an empty directory must be rejected
        check(run(cmd_registry, action="add", tool_dir=str(tool)) == 1, "empty bundle accepted")

        good_runner = "print('original-ok')\n"
        good_test = "print('tests-ok')\n"
        (tool / "src" / "run.py").write_text(good_runner, encoding="utf-8")
        (tool / "tests" / "test_run.py").write_text(good_test, encoding="utf-8")
        (tool / "tests" / "original.json").write_text("{}\n", encoding="utf-8")
        (tool / "README.md").write_text("# extract-qnm-modes\n", encoding="utf-8")
        (tool / "tool-contract.json").write_text(json.dumps(GOOD_CONTRACT), encoding="utf-8")

        # Schema-invalid JSON roots are normal bundle rejection, not internal
        # exceptions from later dictionary access.
        (tool / "tool-contract.json").write_text("[]", encoding="utf-8")
        invalid_root_code, invalid_root = call(
            cmd_bundle, action="verify", tool_dir=str(tool)
        )
        check(
            invalid_root_code == 1 and invalid_root.get("code") == "BUNDLE_REJECTED",
            "non-object contract did not fail as a bundle rejection",
        )
        (tool / "tool-contract.json").write_text(json.dumps(GOOD_CONTRACT), encoding="utf-8")

        # a bundle whose blocked task did not pass must be rejected
        failed_provenance = json.loads(json.dumps(GOOD_PROVENANCE))
        failed_provenance["validation"]["original_task_passed"] = False
        (tool / "provenance.json").write_text(
            json.dumps(failed_provenance),
            encoding="utf-8",
        )
        check(run(cmd_registry, action="add") == 1, "bundle with failing blocked task accepted")

        # a bundle whose entrypoint does not exist must be rejected
        (tool / "provenance.json").write_text(json.dumps(GOOD_PROVENANCE), encoding="utf-8")
        (tool / "src" / "run.py").unlink()
        check(
            run(cmd_bundle, action="verify", tool_dir=str(tool)) == 1,
            "bundle with missing entrypoint accepted",
        )
        (tool / "src" / "run.py").write_text(good_runner, encoding="utf-8")

        # The declared executable must live in the bundle, not merely the project.
        escaped_contract = json.loads(json.dumps(GOOD_CONTRACT))
        escaped_contract["entrypoint"] = {
            "argv": ["python", "../../../README.md"],
            "file": "../../../README.md",
        }
        (tool / "tool-contract.json").write_text(json.dumps(escaped_contract), encoding="utf-8")
        check(
            run(cmd_bundle, action="verify", tool_dir=str(tool)) == 1,
            "entrypoint outside the bundle accepted",
        )
        (tool / "tool-contract.json").write_text(json.dumps(GOOD_CONTRACT), encoding="utf-8")

        # Naming a file as an unused trailing argument does not demonstrate
        # that the declared command exercises it.
        smuggled_contract = json.loads(json.dumps(GOOD_CONTRACT))
        smuggled_contract["entrypoint"] = {
            "argv": ["{python}", "-c", "print('not the entrypoint')", "src/run.py"],
            "file": "src/run.py",
        }
        (tool / "tool-contract.json").write_text(json.dumps(smuggled_contract), encoding="utf-8")
        check(
            run(cmd_bundle, action="verify", tool_dir=str(tool)) == 1,
            "entrypoint file smuggled into an unrelated argv was accepted",
        )
        (tool / "tool-contract.json").write_text(json.dumps(GOOD_CONTRACT), encoding="utf-8")

        ignored_contract = json.loads(json.dumps(GOOD_CONTRACT))
        ignored_contract["entrypoint"] = {
            "argv": ["python", "src/ignored.pyc"],
            "file": "src/ignored.pyc",
        }
        (tool / "src" / "ignored.pyc").write_bytes(b"not-real-bytecode")
        (tool / "tool-contract.json").write_text(json.dumps(ignored_contract), encoding="utf-8")
        check(
            run(cmd_bundle, action="verify", tool_dir=str(tool)) == 1,
            "digest-excluded entrypoint accepted",
        )
        (tool / "src" / "ignored.pyc").unlink()
        (tool / "tool-contract.json").write_text(json.dumps(GOOD_CONTRACT), encoding="utf-8")

        # Structure and self-attestation do not substitute for observed checks.
        check(run(cmd_registry, action="add") == 1, "unqualified bundle entered registry")
        (tool / "src" / "run.py").write_text("raise SystemExit(99)\n", encoding="utf-8")
        check(
            run(cmd_bundle, action="qualify", tool_dir=str(tool)) == 1,
            "failing original task qualified",
        )
        check(run(cmd_registry, action="add") == 1, "failed qualification entered registry")

        # A check that edits the bundle invalidates its own qualification.
        (tool / "src" / "run.py").write_text(good_runner, encoding="utf-8")
        mutating_test = (
            "from pathlib import Path\n"
            "Path('mutated-during-check.txt').write_text('changed', encoding='utf-8')\n"
        )
        (tool / "tests" / "test_run.py").write_text(mutating_test, encoding="utf-8")
        check(
            run(cmd_bundle, action="qualify", tool_dir=str(tool)) == 1,
            "bundle mutation during qualification accepted",
        )
        (tool / "mutated-during-check.txt").unlink()
        (tool / "tests" / "test_run.py").write_text(good_test, encoding="utf-8")

        # A passing, unchanged qualification registers idempotently.
        check(
            run(cmd_bundle, action="qualify", tool_dir=str(tool)) == 0,
            "valid qualification failed",
        )
        check(run(cmd_bundle, action="verify", tool_dir=str(tool)) == 0, "qualified bundle rejected")
        check(run(cmd_registry, action="add", tool_dir=str(tool)) == 0, "valid bundle rejected")
        code, second_add = call(cmd_registry, action="add", tool_dir=str(tool))
        check(code == 0, "re-registering a bundle failed")
        check(second_add["result"]["action"] == "unchanged", "idempotent add rewrote entry")
        stored = read_registry(root)["tools"]
        check(len(stored) == 1, "upsert duplicated the entry: %r" % stored)
        check(stored[0]["name"] == "extract-qnm-modes", "wrong name stored")
        check("registered_at" in stored[0], "registered_at not stamped")
        check(
            stored[0]["validated_on"] == ["unit-tests", "original-blocked-task"],
            "validated_on not derived from provenance",
        )
        check(stored[0]["bundle_digest"] == bundle_digest(tool), "wrong bundle digest stored")
        check(stored[0]["keywords"] == GOOD_CONTRACT["keywords"], "keywords not derived")

        duplicate_registry = {"schema_version": REGISTRY_SCHEMA_VERSION, "tools": [stored[0], stored[0]]}
        (root / REGISTRY_RELPATH).write_text(json.dumps(duplicate_registry), encoding="utf-8")
        check(run(cmd_registry, action="list") == 1, "duplicate registry names accepted")
        atomic_write(
            root / REGISTRY_RELPATH,
            json.dumps({"schema_version": REGISTRY_SCHEMA_VERSION, "tools": stored}),
        )

        # Every registry read fails closed on post-registration drift.
        check(run(cmd_registry, action="verify") == 0, "current registry rejected")
        code, found = call(cmd_registry, action="find", query="quasinormal")
        check(code == 0 and len(found["result"]["matches"]) == 1, "current tool not found")

        # A qualification record is excluded from the bundle digest, so verify
        # must independently reject internally impossible observed evidence.
        qualification_path = tool / QUALIFICATION_FILE
        qualification_text = qualification_path.read_text(encoding="utf-8")
        impossible_record = json.loads(qualification_text)
        impossible_record["checks"][0]["exit_code"] = 99
        qualification_path.write_text(json.dumps(impossible_record), encoding="utf-8")
        check(run(cmd_registry, action="verify") == 1, "impossible qualification accepted")
        qualification_path.write_text(qualification_text, encoding="utf-8")
        check(run(cmd_registry, action="verify") == 0, "restored qualification stayed stale")

        (tool / "provenance.json").write_text("{ invalid", encoding="utf-8")
        check(run(cmd_registry, action="verify") == 1, "corrupt provenance was not stale")
        code, found = call(cmd_registry, action="find", query="quasinormal")
        check(code == 1 and found["result"]["matches"] == [], "stale tool was recommended")
        (tool / "provenance.json").write_text(json.dumps(GOOD_PROVENANCE), encoding="utf-8")
        check(run(cmd_registry, action="verify") == 0, "restored identical bundle stayed stale")
        (tool / "src" / "run.py").write_text(good_runner + "# drift\n", encoding="utf-8")
        check(run(cmd_registry, action="verify") == 1, "source drift was not stale")
        (tool / "src" / "run.py").write_text(good_runner, encoding="utf-8")
        check(run(cmd_registry, action="verify") == 0, "restored source stayed stale")

        # Relative bundle paths are rooted at --root, independent of process cwd.
        check(
            run(cmd_bundle, action="verify", tool_dir="tools/generated/extract-qnm-modes") == 0,
            "relative bundle path did not resolve against project root",
        )
        results["registry_gate"] = (
            "requires observed qualification, binds bundle digest, and excludes stale entries"
        )

        # A corrupt/legacy registry is refused, but has an explicit recovery
        # path that derives a fresh index from current qualified bundles.
        (root / REGISTRY_RELPATH).write_text('{"schema_version": 99, "tools": []}', encoding="utf-8")
        check(run(cmd_registry, action="list") == 1, "registry with wrong schema_version accepted")
        check(run(cmd_registry, action="rebuild") == 0, "qualified bundles could not rebuild registry")
        check(run(cmd_registry, action="verify") == 0, "rebuilt registry was not current")
        results["registry_schema_enforced"] = True

        # path traversal is refused
        check(
            run(cmd_registry, action="add", tool_dir=str(root / ".." / "elsewhere")) == 1,
            "tool directory outside the project accepted",
        )
        check(run(cmd_workspace, task_id="gap-001") == 0, "workspace creation failed")
        check((root / ".toolsmith" / "work" / "gap-001" / "sources").is_dir(), "workspace missing")
        check(run(cmd_workspace, task_id="../escape") == 1, "task-id traversal accepted")
        results["path_traversal_blocked"] = True

    return emit(
        {
            "status": "ok",
            "result": {
                "selftest": "passed",
                "validator": "jsonschema" if _jsonschema() else "builtin-subset",
                **results,
            },
        }
    )


# --------------------------------------------------------------------------


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="toolsmith", description=__doc__.split("\n")[0])
    parser.add_argument("--root", help="Project root. Default: nearest ancestor with .git, else cwd.")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("workspace", help="Create a disposable study area for a capability gap.")
    p.add_argument("task_id")
    p.set_defaults(func=cmd_workspace)

    p = sub.add_parser("registry", help="Query or update the capability registry.")
    p.add_argument("action", choices=["list", "find", "add", "remove", "rebuild", "verify"])
    p.add_argument(
        "target",
        nargs="?",
        default="",
        help="Search terms for 'find'; tool directory for 'add'; name for 'remove'.",
    )
    p.set_defaults(func=cmd_registry)

    p = sub.add_parser("bundle", help="Verify or explicitly qualify a tool bundle.")
    p.add_argument("action", choices=["verify", "qualify"])
    p.add_argument("tool_dir")
    p.set_defaults(func=cmd_bundle)

    p = sub.add_parser("validate", help="Validate a JSON file against a bundled schema.")
    p.add_argument("file")
    p.add_argument("--kind", choices=sorted(SCHEMAS), default="contract")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("selftest", help="Verify this script still works.")
    p.set_defaults(func=cmd_selftest)

    args = parser.parse_args(argv)
    if args.command == "registry":
        args.query = args.target
        args.tool_dir = args.target
        if args.action == "find" and not args.target:
            return fail("MISSING_ARGUMENT", "registry find requires a query")
        if args.action == "add" and not args.target:
            return fail(
                "MISSING_ARGUMENT",
                "registry add requires a tool directory, e.g. tools/generated/<name>. "
                "Caller-written entry JSON is no longer accepted: the entry is derived "
                "from the verified bundle.",
            )
        if args.action == "remove" and not args.target:
            return fail("MISSING_ARGUMENT", "registry remove requires a registered tool name")
        if args.action in ("list", "verify", "rebuild") and args.target:
            return fail(
                "UNEXPECTED_ARGUMENT",
                "registry %s does not accept a target" % args.action,
            )
    try:
        return args.func(args)
    except SelfTestFailure as exc:
        return fail("SELFTEST_FAILED", str(exc), 1)
    except Exception as exc:  # noqa: BLE001 - boundary: never leak a traceback as output
        return fail("INTERNAL_ERROR", "%s: %s" % (type(exc).__name__, exc), 3)


if __name__ == "__main__":
    sys.exit(main())
