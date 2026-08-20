#!/usr/bin/env python3
"""Validate and render Open Wrangler's Python dependency range authority."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
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

MAX_AUTHORITY_BYTES = 65_536
MAX_DEPENDENCIES = 64
MAX_QUALIFIED_VERSIONS = 16
MAX_CONSUMER_BYTES = 2_097_152
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
    cohort_kind: str
    minimum_status: str
    qualified_versions: tuple[str, ...]

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
        value = f"{prefix}{release[0] + 1}"
    elif kind == "minor":
        value = f"{prefix}{release[0]}.{(release[1] if len(release) > 1 else 0) + 1}"
    else:
        _fail("invalid_authority_qualification")
    return Version(value)


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
        "qualification",
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
        exact_version: Version | None = None
        if exact_raw is not None:
            if minimum_raw is not None or maximum_raw is not None:
                _fail("invalid_authority_range")
            exact_text, exact_version = _version(exact_raw)
            specifier = SpecifierSet(f"=={exact_text}")
            lower = upper = exact_version
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

        qualification_raw = value["qualification"]
        if not isinstance(qualification_raw, dict) or set(qualification_raw) != {
            "cohortKind",
            "minimumStatus",
            "qualifiedVersions",
        }:
            _fail("invalid_authority_qualification")
        cohort_kind = _text(qualification_raw["cohortKind"])
        minimum_status = _text(qualification_raw["minimumStatus"])
        if cohort_kind not in {"exact", "major", "minor"}:
            _fail("invalid_authority_qualification")
        if minimum_status not in {"qualified", "declared-unqualified"}:
            _fail("invalid_authority_qualification")
        qualified_raw = qualification_raw["qualifiedVersions"]
        if (
            not isinstance(qualified_raw, list)
            or not 1 <= len(qualified_raw) <= MAX_QUALIFIED_VERSIONS
        ):
            _fail("invalid_authority_qualification")
        qualified_texts: list[str] = []
        qualified_versions: list[Version] = []
        for item in qualified_raw:
            qualified_text, qualified_version = _version(item)
            if qualified_versions and qualified_versions[-1] >= qualified_version:
                _fail("invalid_authority_qualification")
            if not specifier.contains(qualified_version, prereleases=True):
                _fail("invalid_authority_qualification")
            qualified_texts.append(qualified_text)
            qualified_versions.append(qualified_version)

        if exact_text is not None:
            assert exact_version is not None
            if (
                cohort_kind != "exact"
                or minimum_status != "qualified"
                or len(qualified_versions) != 1
                or qualified_versions[0] != exact_version
            ):
                _fail("invalid_authority_qualification")
        else:
            assert maximum_text is not None
            if cohort_kind not in {"major", "minor"}:
                _fail("invalid_authority_qualification")
            first_qualified = qualified_versions[0]
            if minimum_status == "qualified" and first_qualified != lower:
                _fail("invalid_authority_qualification")
            if minimum_status == "declared-unqualified" and not lower < first_qualified:
                _fail("invalid_authority_qualification")
            if minimum_status == "qualified" and _cohort_key(
                lower, cohort_kind
            ) != _cohort_key(first_qualified, cohort_kind):
                _fail("invalid_authority_qualification")
            if not _cohorts_are_contiguous(qualified_versions, cohort_kind):
                _fail("invalid_authority_qualification")
            if upper != _next_cohort(qualified_versions[-1], cohort_kind):
                _fail("invalid_authority_qualification")

        group = _text(value["pyprojectGroup"])
        if group not in {"runtime", "dev"}:
            _fail("invalid_authority_group")

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
                qualified_versions=tuple(qualified_texts),
            )
        )
    return tuple(dependencies)


@dataclass(frozen=True)
class ConsumerSnapshot:
    path: Path
    raw: bytes
    text: str
    identity: tuple[int, int, int, int, int]
    mode: int


def _identity(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _consumer_snapshot(path: Path) -> ConsumerSnapshot:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        before = path.lstat()
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size > MAX_CONSUMER_BYTES
        ):
            _fail(
                "consumer_too_large"
                if before.st_size > MAX_CONSUMER_BYTES
                else "consumer_unsafe"
            )
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            if _identity(opened) != _identity(before):
                _fail("consumer_changed")
            chunks: list[bytes] = []
            remaining = MAX_CONSUMER_BYTES + 1
            while remaining:
                chunk = os.read(descriptor, min(65_536, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            raw = b"".join(chunks)
            after = os.fstat(descriptor)
        finally:
            os.close(descriptor)
    except AuthorityError:
        raise
    except OSError:
        _fail("consumer_unreadable")
    if len(raw) > MAX_CONSUMER_BYTES:
        _fail("consumer_too_large")
    if _identity(after) != _identity(before):
        _fail("consumer_changed")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        _fail("consumer_invalid_utf8")
    if "\x00" in text:
        _fail("consumer_unsafe")
    return ConsumerSnapshot(
        path=path,
        raw=raw,
        text=text,
        identity=_identity(before),
        mode=stat.S_IMODE(before.st_mode),
    )


def _replace_blocks(text: str, blocks: tuple[tuple[str, str, str], ...]) -> str:
    lines = text.split("\n")
    markers = tuple(marker for start, end, _body in blocks for marker in (start, end))
    for line in lines:
        if any(marker in line for marker in markers) and line not in markers:
            _fail("malformed_generation_marker")

    positions: dict[str, int] = {}
    for marker in markers:
        indexes = [index for index, line in enumerate(lines) if line == marker]
        if not indexes:
            _fail("missing_generation_marker")
        if len(indexes) != 1:
            _fail("duplicate_generation_marker")
        positions[marker] = indexes[0]

    intervals: list[tuple[int, int, str]] = []
    for start, end, body in blocks:
        start_at = positions[start]
        end_at = positions[end]
        if start_at >= end_at:
            _fail("reversed_generation_marker")
        intervals.append((start_at, end_at, body))
    for first_index, (first_start, first_end, _first_body) in enumerate(intervals):
        for second_start, second_end, _second_body in intervals[first_index + 1 :]:
            if max(first_start, second_start) < min(first_end, second_end):
                _fail("nested_generation_marker")
    if tuple(positions[marker] for marker in markers) != tuple(
        sorted(positions.values())
    ):
        _fail("reversed_generation_marker")

    for start_at, end_at, body in reversed(intervals):
        lines[start_at + 1 : end_at] = body.split("\n")
    return "\n".join(lines)


def _stage_sibling(path: Path, raw: bytes, mode: int) -> ConsumerSnapshot:
    temporary: Path | None = None
    descriptor = -1
    try:
        descriptor, name = tempfile.mkstemp(
            prefix=f".{path.name}.openwrangler-", dir=path.parent
        )
        temporary = Path(name)
        file_chmod = getattr(os, "fchmod", None)
        if file_chmod is not None:
            file_chmod(descriptor, mode)
        else:
            os.chmod(temporary, mode)
        offset = 0
        while offset < len(raw):
            written = os.write(descriptor, raw[offset:])
            if written <= 0:
                _fail("consumer_write_failed")
            offset += written
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        staged = _consumer_snapshot(temporary)
        if staged.raw != raw or staged.mode != mode:
            _fail("consumer_write_failed")
        return staged
    except (AuthorityError, OSError):
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
        _fail("consumer_write_failed")


def _remove_staged(snapshots: Iterator[ConsumerSnapshot]) -> None:
    for snapshot in snapshots:
        if not _same_snapshot(snapshot):
            continue
        try:
            snapshot.path.unlink(missing_ok=True)
        except OSError:
            pass


def _same_snapshot(snapshot: ConsumerSnapshot) -> bool:
    try:
        current = _consumer_snapshot(snapshot.path)
    except AuthorityError:
        return False
    return current.identity == snapshot.identity and current.raw == snapshot.raw


def _write_consumers_atomically(
    snapshots: tuple[ConsumerSnapshot, ...], expected: dict[Path, str]
) -> None:
    replacements: dict[Path, ConsumerSnapshot] = {}
    rollbacks: dict[Path, ConsumerSnapshot] = {}
    committed: dict[Path, ConsumerSnapshot] = {}
    replaced: list[Path] = []
    error_code: str | None = None
    try:
        for snapshot in snapshots:
            replacements[snapshot.path] = _stage_sibling(
                snapshot.path, expected[snapshot.path].encode("utf-8"), snapshot.mode
            )
            rollbacks[snapshot.path] = _stage_sibling(
                snapshot.path, snapshot.raw, snapshot.mode
            )
        for snapshot in snapshots:
            replacement = replacements[snapshot.path]
            if not _same_snapshot(snapshot):
                _fail("consumer_changed")
            if not _same_snapshot(replacement):
                _fail("consumer_write_failed")
            try:
                os.replace(replacement.path, snapshot.path)
            except OSError:
                _fail("consumer_write_failed")
            replacements.pop(snapshot.path)
            replaced.append(snapshot.path)
            committed_snapshot = _consumer_snapshot(snapshot.path)
            if committed_snapshot.raw != replacement.raw:
                _fail("consumer_write_failed")
            committed[snapshot.path] = committed_snapshot
        directories = (
            {snapshot.path.parent for snapshot in snapshots}
            if os.name != "nt"
            else set()
        )
        for directory in directories:
            try:
                descriptor = os.open(directory, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            except OSError:
                _fail("consumer_write_failed")
    except AuthorityError as error:
        error_code = str(error)
        for path in reversed(replaced):
            rollback = rollbacks[path]
            committed_snapshot = committed.get(path)
            if (
                committed_snapshot is None
                or not _same_snapshot(committed_snapshot)
                or not _same_snapshot(rollback)
            ):
                error_code = "consumer_rollback_failed"
                continue
            try:
                os.replace(rollback.path, path)
            except OSError:
                error_code = "consumer_rollback_failed"
            else:
                rollbacks.pop(path)
        assert error_code is not None
        _fail(error_code)
    finally:
        _remove_staged(iter(replacements.values()))
        _remove_staged(iter(rollbacks.values()))


@contextmanager
def _authority_write_lock() -> Iterator[None]:
    descriptor = -1
    try:
        descriptor = os.open(AUTHORITY_PATH, os.O_RDONLY)
        if os.name == "nt":
            import msvcrt

            try:
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            except OSError:
                _fail("consumer_write_busy")
        else:
            import fcntl

            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                _fail("consumer_write_busy")
            except OSError:
                _fail("consumer_write_failed")
        yield
    except AuthorityError:
        raise
    except OSError:
        _fail("consumer_write_failed")
    finally:
        if descriptor >= 0:
            try:
                if os.name == "nt":
                    import msvcrt

                    os.lseek(descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(descriptor, fcntl.LOCK_UN)
            except OSError:
                pass
            os.close(descriptor)


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


def rendered_consumers(
    dependencies: tuple[Dependency, ...],
    snapshots: tuple[ConsumerSnapshot, ...] | None = None,
) -> dict[Path, str]:
    if snapshots is None:
        snapshots = (
            _consumer_snapshot(PYPROJECT_PATH),
            _consumer_snapshot(HOST_PATH),
        )
    sources = {snapshot.path: snapshot.text for snapshot in snapshots}
    if set(sources) != {PYPROJECT_PATH, HOST_PATH}:
        _fail("consumer_unreadable")
    pyproject = _replace_blocks(
        sources[PYPROJECT_PATH],
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
    )
    host = _replace_blocks(
        sources[HOST_PATH],
        ((HOST_START, HOST_END, _render_host(dependencies)),),
    )
    return {PYPROJECT_PATH: pyproject, HOST_PATH: host}


def _synchronize_unlocked(*, write: bool) -> tuple[Path, ...]:
    dependencies = load_authority()
    snapshots = (
        _consumer_snapshot(PYPROJECT_PATH),
        _consumer_snapshot(HOST_PATH),
    )
    expected = rendered_consumers(dependencies, snapshots)
    mismatches = tuple(
        snapshot.path
        for snapshot in snapshots
        if snapshot.raw != expected[snapshot.path].encode("utf-8")
    )
    if write and mismatches:
        mismatch_snapshots = tuple(
            snapshot for snapshot in snapshots if snapshot.path in mismatches
        )
        _write_consumers_atomically(mismatch_snapshots, expected)
    return mismatches


def synchronize(*, write: bool) -> tuple[Path, ...]:
    if not write:
        return _synchronize_unlocked(write=False)
    with _authority_write_lock():
        return _synchronize_unlocked(write=True)


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
