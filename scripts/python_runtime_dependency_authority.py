#!/usr/bin/env python3
"""Validate and render Open Wrangler's Python dependency range authority."""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import re
import secrets
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
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "cross-platform.yml"

MAX_AUTHORITY_BYTES = 65_536
MAX_AUTHORITY_JSON_DEPTH = 128
MAX_AUTHORITY_JSON_NODES = 4_096
MAX_AUTHORITY_JSON_STRING_BYTES = 4_096
MAX_AUTHORITY_JSON_TEXT_BYTES = 32_768
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
WORKFLOW_START = "  # BEGIN GENERATED PYTHON RUNTIME DEPENDENCY COHORTS"
WORKFLOW_END = "  # END GENERATED PYTHON RUNTIME DEPENDENCY COHORTS"

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


def _validate_json_budget(raw: bytes) -> None:
    depth = 0
    nodes = 0
    string_bytes = 0
    total_string_bytes = 0
    in_string = False
    escaped = False
    in_scalar = False
    for character in raw:
        if in_string:
            string_bytes += 1
            total_string_bytes += 1
            if (
                string_bytes > MAX_AUTHORITY_JSON_STRING_BYTES
                or total_string_bytes > MAX_AUTHORITY_JSON_TEXT_BYTES
            ):
                _fail("invalid_authority_json")
            if escaped:
                escaped = False
            elif character == 0x5C:
                escaped = True
            elif character == 0x22:
                in_string = False
            continue
        if character == 0x22:
            nodes += 1
            string_bytes = 0
            in_string = True
        elif character in {0x5B, 0x7B}:
            nodes += 1
            in_scalar = False
            depth += 1
            if depth > MAX_AUTHORITY_JSON_DEPTH:
                _fail("invalid_authority_json")
        elif character in {0x5D, 0x7D}:
            in_scalar = False
            depth -= 1
            if depth < 0:
                _fail("invalid_authority_json")
        elif character in {0x09, 0x0A, 0x0D, 0x20, 0x2C, 0x3A}:
            in_scalar = False
        elif not in_scalar:
            nodes += 1
            in_scalar = True
        if nodes > MAX_AUTHORITY_JSON_NODES:
            _fail("invalid_authority_json")
    if in_string or depth != 0:
        _fail("invalid_authority_json")


def load_authority(path: Path | None = None) -> tuple[Dependency, ...]:
    path = AUTHORITY_PATH if path is None else path
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    try:
        before = path.lstat()
        if before.st_size > MAX_AUTHORITY_BYTES:
            _fail("authority_too_large")
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            _fail("authority_unsafe")
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            if _identity(opened) != _identity(before):
                _fail("authority_changed")
            chunks: list[bytes] = []
            remaining = MAX_AUTHORITY_BYTES + 1
            while remaining:
                chunk = os.read(descriptor, min(65_536, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            after = os.fstat(descriptor)
        finally:
            os.close(descriptor)
        current = path.lstat()
        if _identity(after) != _identity(before) or _identity(current) != _identity(
            before
        ):
            _fail("authority_changed")
        raw = b"".join(chunks)
    except AuthorityError:
        raise
    except OSError:
        _fail("authority_unreadable")
    if len(raw) > MAX_AUTHORITY_BYTES or b"\x00" in raw:
        _fail("authority_too_large")
    _validate_json_budget(raw)
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
        if (
            lower.is_prerelease
            or lower.is_devrelease
            or upper.is_prerelease
            or upper.is_devrelease
        ):
            _fail("invalid_authority_version")
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
            if not specifier.contains(
                qualified_version,
                prereleases=False,
            ):
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


@dataclass(frozen=True)
class AuthorityLockReceipt:
    authority_identity: tuple[int, int, int, int, int]
    parent_identity: tuple[int, int]
    namespace_identity: tuple[int, int]
    parent_descriptor: int = -1
    namespace_descriptor: int = -1


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
        current = path.lstat()
    except AuthorityError:
        raise
    except OSError:
        _fail("consumer_unreadable")
    if len(raw) > MAX_CONSUMER_BYTES:
        _fail("consumer_too_large")
    if _identity(after) != _identity(before) or _identity(current) != _identity(before):
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


def _rename_noreplace(first: Path, second: Path) -> bool:
    try:
        if sys.platform.startswith("linux"):
            function = ctypes.CDLL(None, use_errno=True).renameat2
            function.argtypes = [
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_uint,
            ]
            function.restype = ctypes.c_int
            return function(-100, os.fsencode(first), -100, os.fsencode(second), 1) == 0
        if sys.platform == "darwin":
            function = ctypes.CDLL(None, use_errno=True).renamex_np
            function.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
            function.restype = ctypes.c_int
            return function(os.fsencode(first), os.fsencode(second), 4) == 0
        if os.name == "nt":
            os.rename(first, second)
            return True
    except (AttributeError, OSError, ValueError):
        return False
    return False


def _remove_owned(path: Path, identity: tuple[int, int, int, int, int]) -> bool:
    # Atomically remove the published name before inspecting it. The claimed name
    # is random and never shared, so a foreign replacement at ``path`` is restored
    # rather than being unlinked by a later pathname operation.
    for _attempt in range(8):
        claimed = path.with_name(
            f".{path.name}.openwrangler-dispose-{secrets.token_hex(16)}"
        )
        if not _rename_noreplace(path, claimed):
            continue
        try:
            snapshot = _consumer_snapshot(claimed)
        except AuthorityError:
            _rename_noreplace(claimed, path)
            return False
        if snapshot.identity[:4] != identity[:4]:
            _rename_noreplace(claimed, path)
            return False
        try:
            claimed.unlink()
        except OSError:
            return False
        return True
    return False


def _stage_sibling(path: Path, raw: bytes, mode: int) -> ConsumerSnapshot:
    temporary: Path | None = None
    descriptor = -1
    owned_identity: tuple[int, int, int, int, int] | None = None
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
        owned_identity = _identity(os.fstat(descriptor))
        os.close(descriptor)
        descriptor = -1
        staged = _consumer_snapshot(temporary)
        if staged.raw != raw or staged.mode != mode:
            _fail("consumer_write_failed")
        return staged
    except (AuthorityError, OSError):
        if descriptor >= 0:
            try:
                owned_identity = _identity(os.fstat(descriptor))
            except OSError:
                owned_identity = None
            try:
                os.close(descriptor)
            except OSError:
                pass
        if temporary is not None and owned_identity is not None:
            _remove_owned(temporary, owned_identity)
        _fail("consumer_write_failed")


def _remove_staged(snapshots: Iterator[ConsumerSnapshot]) -> None:
    for snapshot in snapshots:
        _remove_owned(snapshot.path, snapshot.identity)


def _same_snapshot(snapshot: ConsumerSnapshot) -> bool:
    try:
        current = _consumer_snapshot(snapshot.path)
    except AuthorityError:
        return False
    return current.identity == snapshot.identity and current.raw == snapshot.raw


def _exchange_paths(first: Path, second: Path) -> Path:
    try:
        if sys.platform.startswith("linux"):
            function = ctypes.CDLL(None, use_errno=True).renameat2
            function.argtypes = [
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_uint,
            ]
            function.restype = ctypes.c_int
            result = function(
                -100,
                os.fsencode(first),
                -100,
                os.fsencode(second),
                2,
            )
        elif sys.platform == "darwin":
            function = ctypes.CDLL(None, use_errno=True).renamex_np
            function.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
            function.restype = ctypes.c_int
            result = function(os.fsencode(first), os.fsencode(second), 2)
        elif os.name == "nt":
            backup = first.with_name(
                f".{first.name}.openwrangler-exchange-{secrets.token_hex(16)}"
            )
            replace_file = ctypes.windll.kernel32.ReplaceFileW
            replace_file.argtypes = [
                ctypes.c_wchar_p,
                ctypes.c_wchar_p,
                ctypes.c_wchar_p,
                ctypes.c_uint,
                ctypes.c_void_p,
                ctypes.c_void_p,
            ]
            replace_file.restype = ctypes.c_int
            if not replace_file(str(first), str(second), str(backup), 1, None, None):
                _fail("consumer_write_failed")
            return backup
        else:
            _fail("consumer_write_failed")
    except (AttributeError, OSError, ValueError):
        _fail("consumer_write_failed")
    if result != 0:
        _fail("consumer_write_failed")
    return second


def _assert_consumer_states(
    snapshots: tuple[ConsumerSnapshot, ...],
    committed: dict[Path, ConsumerSnapshot],
) -> None:
    for snapshot in snapshots:
        expected_snapshot = committed.get(snapshot.path, snapshot)
        if not _same_snapshot(expected_snapshot):
            _fail("consumer_changed")


def _write_consumers_atomically(
    snapshots: tuple[ConsumerSnapshot, ...],
    expected: dict[Path, str],
    *,
    authority_receipt: AuthorityLockReceipt | None = None,
) -> None:
    targets = tuple(
        snapshot
        for snapshot in snapshots
        if snapshot.raw != expected[snapshot.path].encode("utf-8")
    )
    replacements: dict[Path, ConsumerSnapshot] = {}
    committed: dict[Path, ConsumerSnapshot] = {}
    replaced: list[Path] = []
    error_code: str | None = None
    try:
        for snapshot in targets:
            replacements[snapshot.path] = _stage_sibling(
                snapshot.path, expected[snapshot.path].encode("utf-8"), snapshot.mode
            )
        _assert_consumer_states(snapshots, committed)
        for snapshot in targets:
            _assert_consumer_states(snapshots, committed)
            replacement = replacements[snapshot.path]
            if not _same_snapshot(replacement):
                _fail("consumer_write_failed")
            if authority_receipt is not None:
                _assert_authority_receipt(authority_receipt)
            displaced_path = _exchange_paths(snapshot.path, replacement.path)
            replacements[snapshot.path] = ConsumerSnapshot(
                path=displaced_path,
                raw=snapshot.raw,
                text=snapshot.text,
                identity=snapshot.identity,
                mode=snapshot.mode,
            )
            replaced.append(snapshot.path)
            displaced = _consumer_snapshot(displaced_path)
            replacements[snapshot.path] = displaced
            committed_snapshot = _consumer_snapshot(snapshot.path)
            committed[snapshot.path] = committed_snapshot
            if (
                committed_snapshot.raw != replacement.raw
                or committed_snapshot.mode != replacement.mode
            ):
                _fail("consumer_write_failed")
            if (
                displaced.identity[:2] != snapshot.identity[:2]
                or displaced.raw != snapshot.raw
                or displaced.mode != snapshot.mode
            ):
                _fail("consumer_changed")
            _assert_consumer_states(snapshots, committed)
        directories = (
            {snapshot.path.parent for snapshot in targets} if os.name != "nt" else set()
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
        _assert_consumer_states(snapshots, committed)
        if authority_receipt is not None:
            _assert_authority_receipt(authority_receipt)
    except AuthorityError as error:
        error_code = str(error)
        for path in reversed(replaced):
            rollback = replacements[path]
            committed_snapshot = committed.get(path)
            if (
                committed_snapshot is None
                or not _same_snapshot(committed_snapshot)
                or not _same_snapshot(rollback)
            ):
                replacements.pop(path, None)
                error_code = "consumer_rollback_failed"
                continue
            try:
                removed_path = _exchange_paths(path, rollback.path)
            except AuthorityError:
                replacements.pop(path, None)
                error_code = "consumer_rollback_failed"
                continue
            restored = _consumer_snapshot(path)
            removed = _consumer_snapshot(removed_path)
            if (
                restored.identity[:2] != rollback.identity[:2]
                or restored.raw != rollback.raw
                or restored.mode != rollback.mode
            ):
                replacements.pop(path, None)
                error_code = "consumer_rollback_failed"
                continue
            if (
                removed.identity[:2] != committed_snapshot.identity[:2]
                or removed.raw != committed_snapshot.raw
                or removed.mode != committed_snapshot.mode
            ):
                replacements.pop(path, None)
                error_code = "consumer_rollback_failed"
                continue
            replacements[path] = removed
        assert error_code is not None
        _fail(error_code)
    finally:
        _remove_staged(iter(replacements.values()))


def _authority_file_identity(
    parent_descriptor: int = -1,
) -> tuple[int, int, int, int, int]:
    descriptor = -1
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    try:
        before = AUTHORITY_PATH.lstat()
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size > MAX_AUTHORITY_BYTES
        ):
            _fail("authority_unsafe")
        if parent_descriptor >= 0:
            descriptor = os.open(
                AUTHORITY_PATH.name,
                flags,
                dir_fd=parent_descriptor,
            )
        else:
            descriptor = os.open(AUTHORITY_PATH, flags)
        opened = os.fstat(descriptor)
        current = AUTHORITY_PATH.lstat()
        if _identity(opened) != _identity(before) or _identity(current) != _identity(
            before
        ):
            _fail("authority_changed")
        return _identity(opened)
    except AuthorityError:
        raise
    except OSError:
        _fail("authority_unsafe")
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _assert_authority_receipt(receipt: AuthorityLockReceipt) -> None:
    try:
        parent = AUTHORITY_PATH.parent
        namespace = parent.parent
        if receipt.namespace_descriptor >= 0:
            namespace_opened = os.fstat(receipt.namespace_descriptor)
            parent_opened = os.fstat(receipt.parent_descriptor)
            parent_named = os.stat(
                parent.name,
                dir_fd=receipt.namespace_descriptor,
                follow_symlinks=False,
            )
            authority_named = os.stat(
                AUTHORITY_PATH.name,
                dir_fd=receipt.parent_descriptor,
                follow_symlinks=False,
            )
            if (
                not stat.S_ISDIR(namespace_opened.st_mode)
                or (namespace_opened.st_dev, namespace_opened.st_ino)
                != receipt.namespace_identity
                or not stat.S_ISDIR(parent_opened.st_mode)
                or (parent_opened.st_dev, parent_opened.st_ino)
                != receipt.parent_identity
                or not stat.S_ISDIR(parent_named.st_mode)
                or (parent_named.st_dev, parent_named.st_ino) != receipt.parent_identity
                or not stat.S_ISREG(authority_named.st_mode)
                or authority_named.st_nlink != 1
                or _identity(authority_named) != receipt.authority_identity
            ):
                _fail("authority_changed")
        namespace_current = namespace.lstat()
        parent_current = parent.lstat()
        authority_current = AUTHORITY_PATH.lstat()
    except AuthorityError:
        raise
    except OSError:
        _fail("authority_changed")
    if (
        not stat.S_ISDIR(namespace_current.st_mode)
        or (namespace_current.st_dev, namespace_current.st_ino)
        != receipt.namespace_identity
        or not stat.S_ISDIR(parent_current.st_mode)
        or (parent_current.st_dev, parent_current.st_ino) != receipt.parent_identity
        or not stat.S_ISREG(authority_current.st_mode)
        or authority_current.st_nlink != 1
        or _identity(authority_current) != receipt.authority_identity
    ):
        _fail("authority_changed")


def _windows_mutex_name(path: Path) -> str:
    normalized = os.path.normcase(os.path.abspath(os.fspath(path)))
    digest = hashlib.sha256(os.fsencode(normalized)).hexdigest()
    return f"Local\\OpenWranglerDependencyAuthority-{digest}"


@contextmanager
def _authority_write_lock(
    *, validate_on_exit: bool = True
) -> Iterator[AuthorityLockReceipt]:
    namespace_descriptor = -1
    parent_descriptor = -1
    mutex_handle: int | None = None
    mutex_acquired = False
    try:
        parent = AUTHORITY_PATH.parent
        namespace = parent.parent
        if os.name == "nt":
            kernel32 = ctypes.windll.kernel32
            create_mutex = kernel32.CreateMutexW
            create_mutex.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
            create_mutex.restype = ctypes.c_void_p
            mutex_handle = create_mutex(
                None, False, _windows_mutex_name(AUTHORITY_PATH)
            )
            if not mutex_handle:
                _fail("consumer_write_failed")
            wait = kernel32.WaitForSingleObject
            wait.argtypes = [ctypes.c_void_p, ctypes.c_uint]
            wait.restype = ctypes.c_uint
            wait_result = wait(mutex_handle, 0)
            if wait_result == 0x00000102:
                _fail("consumer_write_busy")
            if wait_result not in {0x00000000, 0x00000080}:
                _fail("consumer_write_failed")
            mutex_acquired = True
            namespace_metadata = namespace.lstat()
            parent_metadata = parent.lstat()
            if not stat.S_ISDIR(namespace_metadata.st_mode) or not stat.S_ISDIR(
                parent_metadata.st_mode
            ):
                _fail("authority_unsafe")
        else:
            namespace_before = namespace.lstat()
            if not stat.S_ISDIR(namespace_before.st_mode):
                _fail("authority_unsafe")
            flags = os.O_RDONLY
            if hasattr(os, "O_DIRECTORY"):
                flags |= os.O_DIRECTORY
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            namespace_descriptor = os.open(namespace, flags)
            namespace_metadata = os.fstat(namespace_descriptor)
            if (
                not stat.S_ISDIR(namespace_metadata.st_mode)
                or namespace_metadata.st_dev != namespace_before.st_dev
                or namespace_metadata.st_ino != namespace_before.st_ino
            ):
                _fail("authority_changed")
            import fcntl

            try:
                fcntl.flock(
                    namespace_descriptor,
                    fcntl.LOCK_EX | fcntl.LOCK_NB,
                )
            except BlockingIOError:
                _fail("consumer_write_busy")
            except OSError:
                _fail("consumer_write_failed")
            namespace_current = namespace.lstat()
            if (
                not stat.S_ISDIR(namespace_current.st_mode)
                or namespace_current.st_dev != namespace_metadata.st_dev
                or namespace_current.st_ino != namespace_metadata.st_ino
            ):
                _fail("authority_changed")
            parent_before = parent.lstat()
            if not stat.S_ISDIR(parent_before.st_mode):
                _fail("authority_unsafe")
            parent_descriptor = os.open(
                parent.name,
                flags,
                dir_fd=namespace_descriptor,
            )
            parent_metadata = os.fstat(parent_descriptor)
            parent_current = parent.lstat()
            if (
                not stat.S_ISDIR(parent_metadata.st_mode)
                or (parent_metadata.st_dev, parent_metadata.st_ino)
                != (parent_before.st_dev, parent_before.st_ino)
                or (parent_current.st_dev, parent_current.st_ino)
                != (parent_metadata.st_dev, parent_metadata.st_ino)
            ):
                _fail("authority_changed")
        authority_identity = _authority_file_identity(parent_descriptor)
        receipt = AuthorityLockReceipt(
            authority_identity=authority_identity,
            parent_identity=(parent_metadata.st_dev, parent_metadata.st_ino),
            namespace_identity=(
                namespace_metadata.st_dev,
                namespace_metadata.st_ino,
            ),
            parent_descriptor=parent_descriptor,
            namespace_descriptor=namespace_descriptor,
        )
        _assert_authority_receipt(receipt)
        yield receipt
        if validate_on_exit:
            _assert_authority_receipt(receipt)
    except AuthorityError:
        raise
    except OSError:
        _fail("consumer_write_failed")
    finally:
        if os.name == "nt" and mutex_handle is not None:
            kernel32 = ctypes.windll.kernel32
            if mutex_acquired:
                kernel32.ReleaseMutex(ctypes.c_void_p(mutex_handle))
            kernel32.CloseHandle(ctypes.c_void_p(mutex_handle))
        if parent_descriptor >= 0:
            os.close(parent_descriptor)
        if namespace_descriptor >= 0:
            try:
                import fcntl

                fcntl.flock(namespace_descriptor, fcntl.LOCK_UN)
            except OSError:
                pass
            os.close(namespace_descriptor)


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


def _render_workflow(dependencies: tuple[Dependency, ...]) -> str:
    lines = [
        "  python-runtime-dependency-cohorts:",
        "    name: Exact Python dependency (${{ matrix.id }} ${{ matrix.version }})",
        "    runs-on: ubuntu-24.04",
        "    timeout-minutes: 15",
        "    strategy:",
        "      fail-fast: false",
        "      matrix:",
        "        include:",
    ]
    for dependency in dependencies:
        for version in dependency.qualified_versions:
            lines.extend(
                (
                    f"          - id: {json.dumps(dependency.identifier)}",
                    f"            version: {json.dumps(version)}",
                    f"            requirement: {json.dumps(f'{dependency.distribution}=={version}')}",
                )
            )
    lines.extend(
        (
            "    steps:",
            "      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0",
            "      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0",
            "        with:",
            '          python-version: "3.12"',
            "      - name: Install Open Wrangler and exact qualified dependency",
            '        run: python -m pip install -e "python[dev]" "${{ matrix.requirement }}"',
            "      - name: Exercise exact qualified dependency",
            "        run: >-",
            "          python -m pytest",
            "          python/tests/test_runtime_dependency_authority.py::test_exact_qualified_dependency_probe",
            "          -q",
            "        env:",
            "          OPENWRANGLER_QUALIFIED_DEPENDENCY_ID: ${{ matrix.id }}",
            "          OPENWRANGLER_QUALIFIED_DEPENDENCY_VERSION: ${{ matrix.version }}",
        )
    )
    return "\n".join(lines)


def rendered_consumers(
    dependencies: tuple[Dependency, ...],
    snapshots: tuple[ConsumerSnapshot, ...] | None = None,
) -> dict[Path, str]:
    if snapshots is None:
        snapshots = (
            _consumer_snapshot(PYPROJECT_PATH),
            _consumer_snapshot(HOST_PATH),
            _consumer_snapshot(WORKFLOW_PATH),
        )
    sources = {snapshot.path: snapshot.text for snapshot in snapshots}
    if set(sources) != {PYPROJECT_PATH, HOST_PATH, WORKFLOW_PATH}:
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
    workflow = _replace_blocks(
        sources[WORKFLOW_PATH],
        ((WORKFLOW_START, WORKFLOW_END, _render_workflow(dependencies)),),
    )
    return {PYPROJECT_PATH: pyproject, HOST_PATH: host, WORKFLOW_PATH: workflow}


def _synchronize_unlocked(
    *,
    write: bool,
    authority_receipt: AuthorityLockReceipt | None = None,
) -> tuple[Path, ...]:
    if authority_receipt is not None:
        _assert_authority_receipt(authority_receipt)
    dependencies = load_authority()
    if authority_receipt is not None:
        _assert_authority_receipt(authority_receipt)
    snapshots = (
        _consumer_snapshot(PYPROJECT_PATH),
        _consumer_snapshot(HOST_PATH),
        _consumer_snapshot(WORKFLOW_PATH),
    )
    expected = rendered_consumers(dependencies, snapshots)
    mismatches = tuple(
        snapshot.path
        for snapshot in snapshots
        if snapshot.raw != expected[snapshot.path].encode("utf-8")
    )
    if write and mismatches:
        _write_consumers_atomically(
            snapshots,
            expected,
            authority_receipt=authority_receipt,
        )
    elif authority_receipt is not None:
        _assert_authority_receipt(authority_receipt)
    return mismatches


def synchronize(*, write: bool) -> tuple[Path, ...]:
    if not write:
        return _synchronize_unlocked(write=False)
    with _authority_write_lock(validate_on_exit=False) as authority_receipt:
        return _synchronize_unlocked(write=True, authority_receipt=authority_receipt)


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
