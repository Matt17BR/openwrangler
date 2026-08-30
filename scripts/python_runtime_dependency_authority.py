#!/usr/bin/env python3
"""Validate Python dependency ranges and keep their three consumers in sync."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import tempfile
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from typing import Any, NoReturn

from pip._vendor.packaging.specifiers import SpecifierSet
from pip._vendor.packaging.utils import canonicalize_name
from pip._vendor.packaging.version import InvalidVersion, Version

ROOT = Path(__file__).resolve().parents[1]
AUTHORITY_PATH = ROOT / "python" / "runtime-dependencies.json"
PYPROJECT_PATH = ROOT / "python" / "pyproject.toml"
HOST_PATH = ROOT / "src" / "extension" / "pythonEnvironmentModel.ts"
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "cross-platform.yml"

MAX_AUTHORITY_BYTES = 65_536
MAX_DEPENDENCIES = 64
MAX_QUALIFIED_VERSIONS = 16
MAX_CONSUMER_BYTES = 2_097_152
MAX_TEXT = 256
VERSION_FIELD_MAX_LENGTH = 64

PYPROJECT_RUNTIME_START = "  # BEGIN GENERATED PYTHON RUNTIME DEPENDENCIES"
PYPROJECT_RUNTIME_END = "  # END GENERATED PYTHON RUNTIME DEPENDENCIES"
PYPROJECT_DEV_START = "  # BEGIN GENERATED PYTHON OPTIONAL RUNTIME DEPENDENCIES"
PYPROJECT_DEV_END = "  # END GENERATED PYTHON OPTIONAL RUNTIME DEPENDENCIES"
HOST_START = "// BEGIN GENERATED PYTHON RUNTIME DEPENDENCIES"
HOST_END = "// END GENERATED PYTHON RUNTIME DEPENDENCIES"
WORKFLOW_START = "  # BEGIN GENERATED PYTHON RUNTIME DEPENDENCY COHORTS"
WORKFLOW_END = "  # END GENERATED PYTHON RUNTIME DEPENDENCY COHORTS"

_IDENTIFIER = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_MODULE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$")
_DISTRIBUTION = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$")
_PYTHON_MAJOR_MINOR = re.compile(r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$")
SUPPORTED_PYTHON_MINIMUM = Version("3.10")
SUPPORTED_PYTHON_MAXIMUM_EXCLUSIVE = Version("3.15")


class AuthorityError(ValueError):
    """A concise validation or generation error."""


@dataclass(frozen=True)
class QualificationCase:
    python_version: str
    version: str


@dataclass(frozen=True)
class PythonCompatibilityBranch:
    python_maximum_version_exclusive: str
    minimum_version: str
    maximum_version_exclusive: str
    qualified_case: QualificationCase

    @property
    def qualified_version(self) -> str:
        return self.qualified_case.version

    @property
    def qualified_python_version(self) -> str:
        return self.qualified_case.python_version

    @property
    def specifier(self) -> str:
        return f">={self.minimum_version},<{self.maximum_version_exclusive}"


@dataclass(frozen=True)
class Dependency:
    identifier: str
    import_module: str
    distribution: str
    exact_version: str | None
    minimum_version: str | None
    maximum_version_exclusive: str | None
    pyproject_group: str
    cohort_kind: str
    minimum_status: str
    primary_qualification_cases: tuple[QualificationCase, ...]
    python_compatibility: PythonCompatibilityBranch | None = None

    @property
    def qualified_versions(self) -> tuple[str, ...]:
        return tuple(case.version for case in self.primary_qualification_cases)

    @property
    def executable_qualification_cases(self) -> tuple[QualificationCase, ...]:
        if self.python_compatibility is None:
            return self.primary_qualification_cases
        return (
            self.python_compatibility.qualified_case,
            *self.primary_qualification_cases,
        )

    @property
    def specifier(self) -> str:
        if self.exact_version is not None:
            return f"=={self.exact_version}"
        return f">={self.minimum_version},<{self.maximum_version_exclusive}"

    @property
    def install_spec(self) -> str:
        return f"{self.distribution}{self.specifier}"

    @property
    def pyproject_install_specs(self) -> tuple[str, ...]:
        if self.python_compatibility is None:
            return (self.install_spec,)
        branch = self.python_compatibility
        boundary = branch.python_maximum_version_exclusive
        return (
            f"{self.distribution}{branch.specifier}; python_version < '{boundary}'",
            f"{self.install_spec}; python_version >= '{boundary}'",
        )

    def descriptor(self) -> dict[str, str]:
        result = {
            "importModule": self.import_module,
            "distribution": self.distribution,
            "installSpec": self.install_spec,
        }
        if self.exact_version is not None:
            result["exactVersion"] = self.exact_version
        else:
            assert self.minimum_version is not None
            assert self.maximum_version_exclusive is not None
            result["minimumVersion"] = self.minimum_version
            result["maximumVersionExclusive"] = self.maximum_version_exclusive
        return result


def _fail(code: str) -> NoReturn:
    raise AuthorityError(code)


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("duplicate_authority_key")
        result[key] = value
    return result


def _text(
    value: Any,
    *,
    pattern: re.Pattern[str] | None = None,
    maximum: int = MAX_TEXT,
) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > maximum
        or "\x00" in value
        or any(ord(character) < 0x20 for character in value)
    ):
        _fail("invalid_authority_text")
    if pattern is not None and pattern.fullmatch(value) is None:
        _fail("invalid_authority_text")
    return value


def _version(value: Any) -> tuple[str, Version]:
    text = _text(value, maximum=VERSION_FIELD_MAX_LENGTH)
    try:
        return text, Version(text)
    except (InvalidVersion, MemoryError, RecursionError):
        _fail("invalid_authority_version")


def _python_major_minor(
    value: Any, *, code: str = "invalid_authority_compatibility"
) -> tuple[str, Version]:
    text = _text(value, maximum=VERSION_FIELD_MAX_LENGTH)
    if _PYTHON_MAJOR_MINOR.fullmatch(text) is None:
        _fail(code)
    try:
        version = Version(text)
    except (InvalidVersion, MemoryError, RecursionError):
        _fail(code)
    if (
        str(version) != text
        or version.epoch
        or version.is_prerelease
        or version.is_devrelease
        or version.is_postrelease
        or version.local is not None
        or len(version.release) != 2
        or not SUPPORTED_PYTHON_MINIMUM <= version < SUPPORTED_PYTHON_MAXIMUM_EXCLUSIVE
    ):
        _fail(code)
    return text, version


def _cohort_key(version: Version, kind: str) -> tuple[int, ...]:
    release = version.release
    if kind == "major":
        return (version.epoch, release[0])
    if kind == "minor":
        return (version.epoch, release[0], release[1] if len(release) > 1 else 0)
    _fail("invalid_authority_qualification")


def _next_cohort(version: Version, kind: str) -> Version:
    prefix = f"{version.epoch}!" if version.epoch else ""
    release = version.release
    if kind == "major":
        return Version(f"{prefix}{release[0] + 1}")
    if kind == "minor":
        minor = release[1] if len(release) > 1 else 0
        return Version(f"{prefix}{release[0]}.{minor + 1}")
    _fail("invalid_authority_qualification")


def _cohorts_are_contiguous(versions: list[Version], kind: str) -> bool:
    cohorts: list[tuple[int, ...]] = []
    for version in versions:
        cohort = _cohort_key(version, kind)
        if not cohorts or cohorts[-1] != cohort:
            cohorts.append(cohort)
    for previous, current in pairwise(cohorts):
        if kind == "major" and current != (previous[0], previous[1] + 1):
            return False
        if kind == "minor" and current != (previous[0], previous[1], previous[2] + 1):
            return False
    return True


def _load_json(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
    except OSError:
        _fail("authority_unreadable")
    if len(raw) > MAX_AUTHORITY_BYTES:
        _fail("authority_too_large")
    if b"\x00" in raw:
        _fail("invalid_authority_json")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs)
    except AuthorityError:
        raise
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        ValueError,
        MemoryError,
        RecursionError,
    ):
        _fail("invalid_authority_json")
    if not isinstance(value, dict):
        _fail("invalid_authority_shape")
    return value


def load_authority(path: Path | None = None) -> tuple[Dependency, ...]:
    value = _load_json(AUTHORITY_PATH if path is None else path)
    if set(value) != {"schemaVersion", "dependencies"}:
        _fail("invalid_authority_shape")
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
        _fail("unsupported_authority_schema")
    entries = value["dependencies"]
    if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_DEPENDENCIES:
        _fail("invalid_authority_shape")

    required_keys = {
        "id",
        "importModule",
        "distribution",
        "exactVersion",
        "minimumVersion",
        "maximumVersionExclusive",
        "pyprojectGroup",
        "qualification",
    }
    dependencies: list[Dependency] = []
    identifiers: set[str] = set()
    modules: set[str] = set()
    distributions: set[str] = set()

    for entry in entries:
        if not isinstance(entry, dict):
            _fail("invalid_authority_shape")
        entry_keys = set(entry)
        if entry_keys != required_keys and entry_keys != {
            *required_keys,
            "pythonCompatibility",
        }:
            _fail("invalid_authority_shape")

        identifier = _text(entry["id"], pattern=_IDENTIFIER)
        import_module = _text(entry["importModule"], pattern=_MODULE)
        distribution = _text(entry["distribution"], pattern=_DISTRIBUTION)
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

        exact_text: str | None = None
        minimum_text: str | None = None
        maximum_text: str | None = None
        exact_version: Version | None = None
        if entry["exactVersion"] is not None:
            if (
                entry["minimumVersion"] is not None
                or entry["maximumVersionExclusive"] is not None
            ):
                _fail("invalid_authority_range")
            exact_text, exact_version = _version(entry["exactVersion"])
            lower = upper = exact_version
            specifier = SpecifierSet(f"=={exact_text}")
        else:
            if (
                entry["minimumVersion"] is None
                or entry["maximumVersionExclusive"] is None
            ):
                _fail("unbounded_authority_range")
            minimum_text, lower = _version(entry["minimumVersion"])
            maximum_text, upper = _version(entry["maximumVersionExclusive"])
            if lower >= upper:
                _fail("invalid_authority_range")
            specifier = SpecifierSet(f">={minimum_text},<{maximum_text}")
        if (
            lower.is_prerelease
            or lower.is_devrelease
            or upper.is_prerelease
            or upper.is_devrelease
        ):
            _fail("invalid_authority_version")

        qualification = entry["qualification"]
        if not isinstance(qualification, dict) or set(qualification) != {
            "cohortKind",
            "minimumStatus",
            "qualifiedCases",
        }:
            _fail("invalid_authority_qualification")
        cohort_kind = _text(qualification["cohortKind"])
        minimum_status = _text(qualification["minimumStatus"])
        if (
            cohort_kind not in {"exact", "major", "minor"}
            or minimum_status != "qualified"
        ):
            _fail("invalid_authority_qualification")
        cases = qualification["qualifiedCases"]
        if not isinstance(cases, list) or not 1 <= len(cases) <= MAX_QUALIFIED_VERSIONS:
            _fail("invalid_authority_qualification")

        qualified_versions: list[Version] = []
        primary_cases: list[QualificationCase] = []
        for case in cases:
            if not isinstance(case, dict) or set(case) != {"pythonVersion", "version"}:
                _fail("invalid_authority_qualification")
            python_text, _ = _python_major_minor(
                case["pythonVersion"], code="invalid_authority_qualification"
            )
            version_text, version = _version(case["version"])
            if (
                (qualified_versions and qualified_versions[-1] >= version)
                or not specifier.contains(version, prereleases=False)
                or version.is_prerelease
                or version.is_devrelease
            ):
                _fail("invalid_authority_qualification")
            qualified_versions.append(version)
            primary_cases.append(
                QualificationCase(python_version=python_text, version=version_text)
            )

        if exact_text is not None:
            if (
                cohort_kind != "exact"
                or len(qualified_versions) != 1
                or qualified_versions[0] != exact_version
            ):
                _fail("invalid_authority_qualification")
        else:
            assert maximum_text is not None
            if (
                cohort_kind not in {"major", "minor"}
                or qualified_versions[0] != lower
                or _cohort_key(lower, cohort_kind)
                != _cohort_key(qualified_versions[0], cohort_kind)
                or not _cohorts_are_contiguous(qualified_versions, cohort_kind)
                or upper != _next_cohort(qualified_versions[-1], cohort_kind)
            ):
                _fail("invalid_authority_qualification")

        group = _text(entry["pyprojectGroup"])
        if group not in {"runtime", "dev"}:
            _fail("invalid_authority_group")

        compatibility: PythonCompatibilityBranch | None = None
        if "pythonCompatibility" in entry:
            raw_compatibility = entry["pythonCompatibility"]
            if exact_text is not None or group != "runtime":
                _fail("invalid_authority_compatibility")
            if not isinstance(raw_compatibility, dict) or set(raw_compatibility) != {
                "pythonMaximumVersionExclusive",
                "minimumVersion",
                "maximumVersionExclusive",
                "qualifiedCase",
            }:
                _fail("invalid_authority_compatibility")
            python_maximum_text, python_maximum = _python_major_minor(
                raw_compatibility["pythonMaximumVersionExclusive"]
            )
            compatibility_minimum_text, compatibility_minimum = _version(
                raw_compatibility["minimumVersion"]
            )
            compatibility_maximum_text, compatibility_maximum = _version(
                raw_compatibility["maximumVersionExclusive"]
            )
            raw_case = raw_compatibility["qualifiedCase"]
            if not isinstance(raw_case, dict) or set(raw_case) != {
                "pythonVersion",
                "version",
            }:
                _fail("invalid_authority_compatibility")
            compatibility_python_text, compatibility_python = _python_major_minor(
                raw_case["pythonVersion"]
            )
            compatibility_version_text, compatibility_version = _version(
                raw_case["version"]
            )
            if (
                compatibility_minimum.is_prerelease
                or compatibility_minimum.is_devrelease
                or compatibility_maximum.is_prerelease
                or compatibility_maximum.is_devrelease
                or compatibility_version != compatibility_minimum
                or compatibility_minimum >= compatibility_maximum
                or compatibility_maximum > lower
                or compatibility_maximum != _next_cohort(compatibility_version, "major")
                or compatibility_python >= python_maximum
                or any(
                    Version(case.python_version) < python_maximum
                    for case in primary_cases
                )
            ):
                _fail("invalid_authority_compatibility")
            compatibility = PythonCompatibilityBranch(
                python_maximum_version_exclusive=python_maximum_text,
                minimum_version=compatibility_minimum_text,
                maximum_version_exclusive=compatibility_maximum_text,
                qualified_case=QualificationCase(
                    python_version=compatibility_python_text,
                    version=compatibility_version_text,
                ),
            )

        dependencies.append(
            Dependency(
                identifier=identifier,
                import_module=import_module,
                distribution=distribution,
                exact_version=exact_text,
                minimum_version=minimum_text,
                maximum_version_exclusive=maximum_text,
                pyproject_group=group,
                cohort_kind=cohort_kind,
                minimum_status=minimum_status,
                primary_qualification_cases=tuple(primary_cases),
                python_compatibility=compatibility,
            )
        )
    return tuple(dependencies)


def _replace_blocks(text: str, blocks: tuple[tuple[str, str, str], ...]) -> str:
    lines = text.split("\n")
    markers = tuple(marker for start, end, _ in blocks for marker in (start, end))
    for line in lines:
        if any(marker in line for marker in markers) and line not in markers:
            _fail("malformed_generation_marker")

    positions: dict[str, int] = {}
    for marker in markers:
        indexes = [index for index, line in enumerate(lines) if line == marker]
        if not indexes:
            _fail("missing_generation_marker")
        if len(indexes) > 1:
            _fail("duplicate_generation_marker")
        positions[marker] = indexes[0]

    intervals: list[tuple[int, int, str]] = []
    for start, end, body in blocks:
        start_at = positions[start]
        end_at = positions[end]
        if start_at >= end_at:
            _fail("reversed_generation_marker")
        intervals.append((start_at, end_at, body))
    for index, (first_start, first_end, _) in enumerate(intervals):
        for second_start, second_end, _ in intervals[index + 1 :]:
            if max(first_start, second_start) < min(first_end, second_end):
                _fail("nested_generation_marker")
    if tuple(positions[marker] for marker in markers) != tuple(
        sorted(positions.values())
    ):
        _fail("reversed_generation_marker")

    for start_at, end_at, body in reversed(intervals):
        lines[start_at + 1 : end_at] = body.split("\n")
    return "\n".join(lines)


def _render_pyproject(dependencies: tuple[Dependency, ...], group: str) -> str:
    return "\n".join(
        f'  "{install_spec}",'
        for dependency in dependencies
        if dependency.pyproject_group == group
        for install_spec in dependency.pyproject_install_specs
    )


def _render_host(dependencies: tuple[Dependency, ...]) -> str:
    # Host descriptors cannot express Python markers, so conditional dependencies remain package/workflow-only.
    host_dependencies = tuple(
        dependency
        for dependency in dependencies
        if dependency.python_compatibility is None
    )
    identifiers = " | ".join(
        json.dumps(dependency.identifier) for dependency in host_dependencies
    )
    lines = [
        f"type PythonRuntimeDependencyId =\n  {identifiers};",
        "",
        "const PYTHON_RUNTIME_DEPENDENCIES: Readonly<Record<PythonRuntimeDependencyId, Readonly<PythonDependency>>> =",
        "  Object.freeze({",
    ]
    for dependency in host_dependencies:
        lines.append(f"    {dependency.identifier}: Object.freeze({{")
        for key, value in dependency.descriptor().items():
            lines.append(f"      {key}: {json.dumps(value)},")
        lines[-1] = lines[-1].removesuffix(",")
        lines.append("    }),")
    lines[-1] = lines[-1].removesuffix(",")
    lines.append("  });")
    return "\n".join(lines)


def _generated_workflow_action_use(workflow_source: str, action: str) -> str:
    lines = workflow_source.split("\n")
    try:
        start = lines.index(WORKFLOW_START)
        end = lines.index(WORKFLOW_END)
    except ValueError:
        _fail("missing_generation_marker")
    if start >= end:
        _fail("reversed_generation_marker")
    matches: list[str] = []
    prefix = f"{action}@"
    for line in lines[start + 1 : end]:
        stripped = line.strip()
        if not stripped.startswith("- uses:"):
            continue
        use = stripped.removeprefix("- uses:").strip()
        reference = use.partition("#")[0].strip()
        if not reference.startswith(prefix):
            continue
        if re.fullmatch(rf"{re.escape(action)}@[0-9a-f]{{40}}", reference) is None:
            _fail("workflow_action_invalid")
        matches.append(use)
    if len(matches) != 1:
        _fail("workflow_action_invalid")
    return matches[0]


def _render_workflow(dependencies: tuple[Dependency, ...], workflow_source: str) -> str:
    checkout_action = _generated_workflow_action_use(
        workflow_source, "actions/checkout"
    )
    setup_python_action = _generated_workflow_action_use(
        workflow_source, "actions/setup-python"
    )
    lines = [
        "  python-runtime-dependency-cohorts:",
        "    name: Exact Python dependency (${{ matrix.id }} ${{ matrix.version }}, Python ${{ matrix.python }})",
        "    runs-on: ubuntu-24.04",
        "    timeout-minutes: 15",
        "    strategy:",
        "      fail-fast: false",
        "      matrix:",
        "        include:",
    ]
    for dependency in dependencies:
        for case in dependency.executable_qualification_cases:
            lines.extend(
                (
                    f"          - id: {json.dumps(dependency.identifier)}",
                    f"            python: {json.dumps(case.python_version)}",
                    f"            version: {json.dumps(case.version)}",
                    f"            requirement: {json.dumps(f'{dependency.distribution}=={case.version}')}",
                )
            )
    lines.extend(
        (
            "    steps:",
            f"      - uses: {checkout_action}",
            f"      - uses: {setup_python_action}",
            "        with:",
            "          python-version: ${{ matrix.python }}",
            "      - name: Install Open Wrangler and exact qualified dependency",
            '        run: python -m pip install -e "python[dev]" "${{ matrix.requirement }}"',
            "      - name: Exercise exact qualified dependency",
            "        run: >-",
            "          python -m pytest",
            "          python/tests/test_runtime_dependency_authority.py::test_exact_qualified_dependency_probe",
            "          -q",
            "        env:",
            "          OPENWRANGLER_QUALIFIED_DEPENDENCY_ID: ${{ matrix.id }}",
            "          OPENWRANGLER_QUALIFIED_PYTHON_VERSION: ${{ matrix.python }}",
            "          OPENWRANGLER_QUALIFIED_DEPENDENCY_VERSION: ${{ matrix.version }}",
        )
    )
    return "\n".join(lines)


def _read_consumer(path: Path) -> str:
    try:
        raw = path.read_bytes()
    except OSError:
        _fail("consumer_unreadable")
    if len(raw) > MAX_CONSUMER_BYTES:
        _fail("consumer_too_large")
    if b"\x00" in raw:
        _fail("consumer_unsafe")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        _fail("consumer_invalid_utf8")
    if "\r" in text.replace("\r\n", ""):
        _fail("consumer_unsafe")
    return text.replace("\r\n", "\n")


def rendered_consumers(
    dependencies: tuple[Dependency, ...],
) -> dict[Path, str]:
    pyproject = _read_consumer(PYPROJECT_PATH)
    host = _read_consumer(HOST_PATH)
    workflow = _read_consumer(WORKFLOW_PATH)
    return {
        PYPROJECT_PATH: _replace_blocks(
            pyproject,
            (
                (
                    PYPROJECT_RUNTIME_START,
                    PYPROJECT_RUNTIME_END,
                    _render_pyproject(dependencies, "runtime"),
                ),
                (
                    PYPROJECT_DEV_START,
                    PYPROJECT_DEV_END,
                    _render_pyproject(dependencies, "dev"),
                ),
            ),
        ),
        HOST_PATH: _replace_blocks(
            host,
            ((HOST_START, HOST_END, _render_host(dependencies)),),
        ),
        WORKFLOW_PATH: _replace_blocks(
            workflow,
            ((WORKFLOW_START, WORKFLOW_END, _render_workflow(dependencies, workflow)),),
        ),
    }


def _write_consumer(path: Path, text: str) -> None:
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
        )
    except OSError:
        _fail("consumer_write_failed")
    temporary = Path(temporary_name)
    open_descriptor = descriptor
    try:
        with os.fdopen(descriptor, "wb") as stream:
            open_descriptor = -1
            stream.write(text.encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except OSError:
        _fail("consumer_write_failed")
    finally:
        if open_descriptor >= 0:
            os.close(open_descriptor)
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def synchronize(*, write: bool) -> tuple[Path, ...]:
    dependencies = load_authority()
    expected = rendered_consumers(dependencies)
    mismatches = tuple(
        path for path, text in expected.items() if _read_consumer(path) != text
    )
    if write:
        # Each file is replaced atomically. If the process stops between files,
        # the normal check reports the remaining mismatch on the next run.
        for path in mismatches:
            _write_consumer(path, expected[path])
    return mismatches


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write", action="store_true", help="rewrite generated consumer blocks"
    )
    arguments = parser.parse_args(argv)
    try:
        mismatches = synchronize(write=arguments.write)
    except AuthorityError as error:
        print(str(error), file=os.sys.stderr)
        return 2
    if mismatches and not arguments.write:
        for path in mismatches:
            print(
                f"out_of_date:{path.relative_to(ROOT).as_posix()}",
                file=os.sys.stderr,
            )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
