#!/usr/bin/env python3
"""Validate and render Open Wrangler's Python dependency range authority."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

from pip._vendor.packaging.specifiers import SpecifierSet
from pip._vendor.packaging.utils import canonicalize_name
from pip._vendor.packaging.version import InvalidVersion, Version

ROOT = Path(__file__).resolve().parents[1]
AUTHORITY_PATH = ROOT / "python" / "runtime-dependencies.json"
PYPROJECT_PATH = ROOT / "python" / "pyproject.toml"
HOST_PATH = ROOT / "src" / "extension" / "pythonEnvironmentModel.ts"

MAX_AUTHORITY_BYTES = 65_536
MAX_DEPENDENCIES = 64
MAX_EVIDENCE_PER_DEPENDENCY = 8
MAX_TEXT = 256

PYPROJECT_RUNTIME_START = "  # BEGIN GENERATED PYTHON RUNTIME DEPENDENCIES"
PYPROJECT_RUNTIME_END = "  # END GENERATED PYTHON RUNTIME DEPENDENCIES"
PYPROJECT_DEV_START = "  # BEGIN GENERATED PYTHON OPTIONAL RUNTIME DEPENDENCIES"
PYPROJECT_DEV_END = "  # END GENERATED PYTHON OPTIONAL RUNTIME DEPENDENCIES"
HOST_START = "// BEGIN GENERATED PYTHON RUNTIME DEPENDENCIES"
HOST_END = "// END GENERATED PYTHON RUNTIME DEPENDENCIES"

_IDENTIFIER = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_MODULE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$")
_DISTRIBUTION = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$")
_EVIDENCE = re.compile(r"^[A-Za-z0-9_.\-/]+$")


class AuthorityError(Exception):
    """A bounded authority or generation failure."""


@dataclass(frozen=True)
class Dependency:
    identifier: str
    import_module: str
    distribution: str
    exact_version: str | None
    minimum_version: str | None
    maximum_version_exclusive: str | None
    pyproject_group: str
    tested_minimum_version: str
    tested_maximum_version: str
    evidence: tuple[str, ...]

    @property
    def specifier(self) -> str:
        if self.exact_version is not None:
            return f"=={self.exact_version}"
        return f">={self.minimum_version},<{self.maximum_version_exclusive}"

    @property
    def install_spec(self) -> str:
        return f"{self.distribution}{self.specifier}"

    def descriptor(self) -> dict[str, str]:
        descriptor = {
            "importModule": self.import_module,
            "distribution": self.distribution,
            "installSpec": self.install_spec,
        }
        if self.exact_version is not None:
            descriptor["exactVersion"] = self.exact_version
        else:
            assert self.minimum_version is not None
            assert self.maximum_version_exclusive is not None
            descriptor["minimumVersion"] = self.minimum_version
            descriptor["maximumVersionExclusive"] = self.maximum_version_exclusive
        return descriptor


def _fail(code: str) -> NoReturn:
    raise AuthorityError(code)


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            _fail("duplicate_authority_key")
        value[key] = item
    return value


def _text(value: Any, *, pattern: re.Pattern[str] | None = None) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > MAX_TEXT
        or "\x00" in value
    ):
        _fail("invalid_authority_text")
    if any(ord(character) < 0x20 for character in value):
        _fail("invalid_authority_text")
    if pattern is not None and pattern.fullmatch(value) is None:
        _fail("invalid_authority_text")
    return value


def _version(value: Any) -> tuple[str, Version]:
    text = _text(value)
    try:
        return text, Version(text)
    except (InvalidVersion, MemoryError, RecursionError):
        _fail("invalid_authority_version")


def load_authority(path: Path = AUTHORITY_PATH) -> tuple[Dependency, ...]:
    try:
        if path.stat().st_size > MAX_AUTHORITY_BYTES:
            _fail("authority_too_large")
        raw = path.read_bytes()
    except AuthorityError:
        raise
    except OSError:
        _fail("authority_unreadable")
    if len(raw) > MAX_AUTHORITY_BYTES or b"\x00" in raw:
        _fail("authority_too_large")
    try:
        decoded = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs)
    except AuthorityError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, MemoryError, RecursionError):
        _fail("invalid_authority_json")
    if not isinstance(decoded, dict) or set(decoded) != {
        "schemaVersion",
        "dependencies",
    }:
        _fail("invalid_authority_shape")
    if type(decoded["schemaVersion"]) is not int or decoded["schemaVersion"] != 1:
        _fail("unsupported_authority_schema")
    values = decoded["dependencies"]
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_DEPENDENCIES:
        _fail("invalid_authority_shape")

    expected_keys = {
        "id",
        "importModule",
        "distribution",
        "exactVersion",
        "minimumVersion",
        "maximumVersionExclusive",
        "pyprojectGroup",
        "testedMinimumVersion",
        "testedMaximumVersion",
        "evidence",
    }
    dependencies: list[Dependency] = []
    identifiers: set[str] = set()
    modules: set[str] = set()
    distributions: set[str] = set()
    for value in values:
        if not isinstance(value, dict) or set(value) != expected_keys:
            _fail("invalid_authority_shape")
        identifier = _text(value["id"], pattern=_IDENTIFIER)
        import_module = _text(value["importModule"], pattern=_MODULE)
        distribution = _text(value["distribution"], pattern=_DISTRIBUTION)
        canonical_distribution = canonicalize_name(distribution)
        if (
            identifier in identifiers
            or import_module in modules
            or canonical_distribution in distributions
        ):
            _fail("duplicate_authority_dependency")
        identifiers.add(identifier)
        modules.add(import_module)
        distributions.add(canonical_distribution)

        exact_raw = value["exactVersion"]
        minimum_raw = value["minimumVersion"]
        maximum_raw = value["maximumVersionExclusive"]
        exact_text: str | None = None
        minimum_text: str | None = None
        maximum_text: str | None = None
        if exact_raw is not None:
            if minimum_raw is not None or maximum_raw is not None:
                _fail("invalid_authority_range")
            exact_text, exact = _version(exact_raw)
            specifier = SpecifierSet(f"=={exact_text}")
            lower = upper = exact
        else:
            if minimum_raw is None or maximum_raw is None:
                _fail("unbounded_authority_range")
            minimum_text, lower = _version(minimum_raw)
            maximum_text, upper = _version(maximum_raw)
            if lower >= upper:
                _fail("invalid_authority_range")
            try:
                specifier = SpecifierSet(f">={minimum_text},<{maximum_text}")
            except (MemoryError, RecursionError, ValueError):
                _fail("invalid_authority_range")

        tested_minimum_text, tested_minimum = _version(value["testedMinimumVersion"])
        tested_maximum_text, tested_maximum = _version(value["testedMaximumVersion"])
        if tested_minimum > tested_maximum:
            _fail("invalid_authority_evidence")
        if not specifier.contains(
            tested_minimum, prereleases=True
        ) or not specifier.contains(tested_maximum, prereleases=True):
            _fail("invalid_authority_evidence")
        if exact_text is not None and (
            tested_minimum != lower or tested_maximum != upper
        ):
            _fail("invalid_authority_evidence")
        if exact_text is None and (tested_minimum != lower or tested_maximum >= upper):
            _fail("invalid_authority_evidence")

        group = _text(value["pyprojectGroup"])
        if group not in {"runtime", "dev"}:
            _fail("invalid_authority_group")
        evidence_raw = value["evidence"]
        if (
            not isinstance(evidence_raw, list)
            or not 1 <= len(evidence_raw) <= MAX_EVIDENCE_PER_DEPENDENCY
        ):
            _fail("invalid_authority_evidence")
        evidence_items: list[str] = []
        for item in evidence_raw:
            evidence_item = _text(item, pattern=_EVIDENCE)
            evidence_path = Path(evidence_item)
            if evidence_path.is_absolute() or any(
                part in {"", ".", ".."} for part in evidence_path.parts
            ):
                _fail("invalid_authority_text")
            evidence_items.append(evidence_item)
        evidence = tuple(evidence_items)
        if len(set(evidence)) != len(evidence) or any(
            not (ROOT / item).is_file() for item in evidence
        ):
            _fail("invalid_authority_evidence")

        dependencies.append(
            Dependency(
                identifier=identifier,
                import_module=import_module,
                distribution=distribution,
                exact_version=exact_text,
                minimum_version=minimum_text,
                maximum_version_exclusive=maximum_text,
                pyproject_group=group,
                tested_minimum_version=tested_minimum_text,
                tested_maximum_version=tested_maximum_text,
                evidence=evidence,
            )
        )
    return tuple(dependencies)


def _replace_block(text: str, start: str, end: str, body: str) -> str:
    if text.count(start) != 1 or text.count(end) != 1:
        _fail("missing_generation_marker")
    start_at = text.index(start)
    start_line_end = text.find("\n", start_at)
    end_at = text.index(end, start_line_end + 1)
    end_line_start = text.rfind("\n", 0, end_at) + 1
    if start_line_end < 0 or end_line_start <= start_line_end:
        _fail("invalid_generation_marker")
    return f"{text[: start_line_end + 1]}{body}\n{text[end_line_start:]}"


def _render_pyproject(dependencies: tuple[Dependency, ...], group: str) -> str:
    return "\n".join(
        f'  "{dependency.install_spec}",'
        for dependency in dependencies
        if dependency.pyproject_group == group
    )


def _render_host(dependencies: tuple[Dependency, ...]) -> str:
    identifiers = " | ".join(
        json.dumps(dependency.identifier) for dependency in dependencies
    )
    lines = [
        f"type PythonRuntimeDependencyId =\n  {identifiers};",
        "",
        "const PYTHON_RUNTIME_DEPENDENCIES: Readonly<Record<PythonRuntimeDependencyId, Readonly<PythonDependency>>> =",
        "  Object.freeze({",
    ]
    for dependency in dependencies:
        lines.append(f"    {dependency.identifier}: Object.freeze({{")
        for key, value in dependency.descriptor().items():
            lines.append(f"      {key}: {json.dumps(value)},")
        lines[-1] = lines[-1].removesuffix(",")
        lines.append("    }),")
    lines[-1] = lines[-1].removesuffix(",")
    lines.append("  });")
    return "\n".join(lines)


def rendered_consumers(dependencies: tuple[Dependency, ...]) -> dict[Path, str]:
    try:
        pyproject = PYPROJECT_PATH.read_text(encoding="utf-8")
        host = HOST_PATH.read_text(encoding="utf-8")
    except OSError:
        _fail("consumer_unreadable")
    pyproject = _replace_block(
        pyproject,
        PYPROJECT_RUNTIME_START,
        PYPROJECT_RUNTIME_END,
        _render_pyproject(dependencies, "runtime"),
    )
    pyproject = _replace_block(
        pyproject,
        PYPROJECT_DEV_START,
        PYPROJECT_DEV_END,
        _render_pyproject(dependencies, "dev"),
    )
    host = _replace_block(host, HOST_START, HOST_END, _render_host(dependencies))
    return {PYPROJECT_PATH: pyproject, HOST_PATH: host}


def synchronize(*, write: bool) -> tuple[Path, ...]:
    dependencies = load_authority()
    mismatches: list[Path] = []
    for path, expected in rendered_consumers(dependencies).items():
        try:
            actual = path.read_text(encoding="utf-8")
        except OSError:
            _fail("consumer_unreadable")
        if actual == expected:
            continue
        mismatches.append(path)
        if write:
            path.write_text(expected, encoding="utf-8", newline="\n")
    return tuple(mismatches)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write", action="store_true", help="rewrite generated consumer blocks"
    )
    args = parser.parse_args(argv)
    try:
        mismatches = synchronize(write=args.write)
    except AuthorityError as error:
        print(str(error), file=sys.stderr)
        return 2
    if mismatches and not args.write:
        for path in mismatches:
            print(f"out_of_date:{path.relative_to(ROOT).as_posix()}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
