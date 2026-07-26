"""Crash-safe dependency mutation guard for a selected Python environment.

This module intentionally uses only the Python standard library and can be
executed directly with ``python -I dependency_guard.py <mode>``.  Its JSONL
protocol is consumed by the extension host; package and import output never
crosses that protocol boundary.
"""

from __future__ import annotations

import contextlib
import ctypes
import errno
import importlib
import importlib.metadata
import json
import os
import re
import runpy
import stat
import sys
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any, NoReturn

PROTOCOL = "openwrangler-dependency-guard-v1"
JOURNAL_NAME = ".openwrangler-dependency-journal-v1"
LOCK_NAME = "mutation.lock"
MAX_FRAME_BYTES = 65_536
MAX_MARKER_BYTES = 65_536
MAX_DEPENDENCIES = 64

EXIT_SUCCESS = 0
EXIT_INVALID_REQUEST = 10
EXIT_BUSY = 11
EXIT_MALFORMED_STATE = 12
EXIT_VALIDATION_FAILED = 13
EXIT_PIP_FAILED = 14
EXIT_STALE_OR_MISSING_MARKER = 15
EXIT_ENVIRONMENT_CHANGED = 16
EXIT_INTERNAL_ERROR = 17

_EXIT_BY_CODE = {
    "invalid_request": EXIT_INVALID_REQUEST,
    "busy": EXIT_BUSY,
    "malformed_state": EXIT_MALFORMED_STATE,
    "validation_failed": EXIT_VALIDATION_FAILED,
    "pip_failed": EXIT_PIP_FAILED,
    "stale_or_missing_marker": EXIT_STALE_OR_MISSING_MARKER,
    "environment_changed": EXIT_ENVIRONMENT_CHANGED,
    "internal_error": EXIT_INTERNAL_ERROR,
}

_MARKER_PATTERN = re.compile(r"^mutation-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$")
_TEMP_PATTERN = re.compile(r"^\.pending-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$")
_MODULE_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$")
_DISTRIBUTION_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$")
_INSTALL_SPEC_PATTERN = re.compile(
    r"^(?P<name>[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127}))"
    r"(?P<constraints>(?:(?:==|!=|<=|>=|<|>|~=)[0-9]+(?:\.[0-9]+){0,7}"
    r"(?:,(?:==|!=|<=|>=|<|>|~=)[0-9]+(?:\.[0-9]+){0,7})*)?)$"
)
_BOUND_VERSION_PATTERN = re.compile(r"^[0-9]+(?:\.[0-9]+){0,7}$")
_RELEASE_PREFIX_PATTERN = re.compile(r"^[0-9]+(?:\.[0-9]+)*")

_ENVIRONMENT_KEYS = {
    "executable",
    "executableIdentity",
    "packageRoot",
    "packageRootIdentity",
    "pythonVersion",
}
_EXECUTABLE_IDENTITY_KEYS = {"device", "inode", "size", "mtimeNs", "ctimeNs"}
_ROOT_IDENTITY_KEYS = {"device", "inode"}
_DEPENDENCY_KEYS = {
    "importModule",
    "distribution",
    "installSpec",
    "minimumVersion",
    "maximumVersionExclusive",
}


class GuardError(Exception):
    """A deliberately bounded protocol failure."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _fail(code: str) -> NoReturn:
    raise GuardError(code)


def _read_frame() -> dict[str, Any]:
    raw = sys.stdin.buffer.readline(MAX_FRAME_BYTES + 1)
    if not raw or len(raw) > MAX_FRAME_BYTES or not raw.endswith(b"\n") or raw.endswith(b"\r\n"):
        _fail("invalid_request")
    payload = raw[:-1]
    if not payload or b"\x00" in payload:
        _fail("invalid_request")
    try:
        decoded = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=lambda _value: _fail("invalid_request"),
        )
    except GuardError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError):
        _fail("invalid_request")
    if not isinstance(decoded, dict):
        _fail("invalid_request")
    return decoded


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("invalid_request")
        result[key] = value
    return result


def _emit(payload: dict[str, Any]) -> None:
    encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("ascii") + b"\n"
    if len(encoded) > MAX_FRAME_BYTES:
        _fail("internal_error")
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def _emit_error(code: str) -> None:
    _emit({"code": code, "kind": "error", "protocol": PROTOCOL})


def _canonical_uuid(value: Any) -> str:
    if not isinstance(value, str) or len(value) != 36:
        _fail("invalid_request")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        _fail("invalid_request")
    if str(parsed) != value:
        _fail("invalid_request")
    return value


def _bounded_string(value: Any, *, maximum: int, code: str = "invalid_request") -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > maximum
        or "\x00" in value
        or any(ord(character) < 0x20 for character in value)
    ):
        _fail(code)
    return value


def _decimal_identity_part(value: Any, *, bits: int, code: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 40 or not value.isascii() or not value.isdecimal():
        _fail(code)
    if len(value) > 1 and value.startswith("0"):
        _fail(code)
    number = int(value)
    if number < 0 or number >= 1 << bits:
        _fail(code)
    return value


def _signed_decimal_identity_part(value: Any, *, bits: int, code: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 41 or not value.isascii():
        _fail(code)
    negative = value.startswith("-")
    digits = value[1:] if negative else value
    if not digits or not digits.isdecimal() or (len(digits) > 1 and digits.startswith("0")) or value == "-0":
        _fail(code)
    number = int(value)
    if number < -(1 << (bits - 1)) or number >= 1 << (bits - 1):
        _fail(code)
    return value


def _normalize_root_identity(value: Any, *, code: str) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != _ROOT_IDENTITY_KEYS:
        _fail(code)
    device = _decimal_identity_part(value["device"], bits=64, code=code)
    inode = _decimal_identity_part(value["inode"], bits=128, code=code)
    if int(device) == 0 and int(inode) == 0:
        _fail(code)
    return {"device": device, "inode": inode}


def _normalize_executable_identity(value: Any, *, code: str) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != _EXECUTABLE_IDENTITY_KEYS:
        _fail(code)
    normalized = {
        "device": _decimal_identity_part(value["device"], bits=64, code=code),
        "inode": _decimal_identity_part(value["inode"], bits=128, code=code),
        "size": _decimal_identity_part(value["size"], bits=128, code=code),
        "mtimeNs": _signed_decimal_identity_part(value["mtimeNs"], bits=128, code=code),
        "ctimeNs": _signed_decimal_identity_part(value["ctimeNs"], bits=128, code=code),
    }
    if (
        (int(normalized["device"]) == 0 and int(normalized["inode"]) == 0)
        or int(normalized["size"]) == 0
        or (int(normalized["mtimeNs"]) == 0 and int(normalized["ctimeNs"]) == 0)
    ):
        _fail(code)
    return normalized


def _stat_root_identity(result: os.stat_result) -> dict[str, str]:
    return {"device": str(result.st_dev), "inode": str(result.st_ino)}


def _stat_executable_identity(result: os.stat_result) -> dict[str, str]:
    return {
        "device": str(result.st_dev),
        "inode": str(result.st_ino),
        "size": str(result.st_size),
        "mtimeNs": str(result.st_mtime_ns),
        "ctimeNs": str(result.st_ctime_ns),
    }


def _path_key(value: str) -> str:
    return os.path.normcase(os.path.normpath(os.path.abspath(value)))


def _actual_environment() -> dict[str, Any]:
    executable = os.path.abspath(sys.executable)
    package_root = os.path.realpath(os.path.abspath(sys.prefix))
    try:
        executable_stat = os.stat(executable)
        root_stat = os.stat(package_root)
    except OSError:
        _fail("environment_changed")
    if not stat.S_ISREG(executable_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
        _fail("environment_changed")
    return {
        "executable": executable,
        "executableIdentity": _stat_executable_identity(executable_stat),
        "packageRoot": package_root,
        "packageRootIdentity": _stat_root_identity(root_stat),
        "pythonVersion": ".".join(str(part) for part in sys.version_info[:3]),
    }


def _normalize_environment(value: Any, *, compare_actual: bool, code: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != _ENVIRONMENT_KEYS:
        _fail(code)
    executable = _bounded_string(value["executable"], maximum=4096, code=code)
    package_root = _bounded_string(value["packageRoot"], maximum=4096, code=code)
    python_version = _bounded_string(value["pythonVersion"], maximum=32, code=code)
    if not os.path.isabs(executable) or not os.path.isabs(package_root):
        _fail(code)
    if not _BOUND_VERSION_PATTERN.fullmatch(python_version):
        _fail(code)
    normalized = {
        "executable": os.path.abspath(executable),
        "executableIdentity": _normalize_executable_identity(value["executableIdentity"], code=code),
        "packageRoot": os.path.realpath(os.path.abspath(package_root)),
        "packageRootIdentity": _normalize_root_identity(value["packageRootIdentity"], code=code),
        "pythonVersion": python_version,
    }
    if _path_key(package_root) != _path_key(normalized["packageRoot"]):
        _fail(code)
    if compare_actual:
        actual = _actual_environment()
        if (
            _path_key(normalized["executable"]) != _path_key(actual["executable"])
            or _path_key(normalized["packageRoot"]) != _path_key(actual["packageRoot"])
            or normalized["executableIdentity"] != actual["executableIdentity"]
            or normalized["packageRootIdentity"] != actual["packageRootIdentity"]
            or normalized["pythonVersion"] != actual["pythonVersion"]
        ):
            _fail("environment_changed")
        return actual
    return normalized


def _normalize_dependency(value: Any, *, code: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != _DEPENDENCY_KEYS:
        _fail(code)
    import_module = _bounded_string(value["importModule"], maximum=256, code=code)
    distribution = _bounded_string(value["distribution"], maximum=128, code=code)
    install_spec = _bounded_string(value["installSpec"], maximum=2048, code=code)
    if not _MODULE_PATTERN.fullmatch(import_module) or not _DISTRIBUTION_PATTERN.fullmatch(distribution):
        _fail(code)
    install_match = _INSTALL_SPEC_PATTERN.fullmatch(install_spec)
    if install_match is None:
        _fail(code)
    install_distribution = _normalized_distribution_name(install_match.group("name"))
    if install_distribution != _normalized_distribution_name(distribution):
        _fail(code)
    minimum = value["minimumVersion"]
    maximum = value["maximumVersionExclusive"]
    if minimum is not None:
        minimum = _bounded_string(minimum, maximum=64, code=code)
        if not _BOUND_VERSION_PATTERN.fullmatch(minimum):
            _fail(code)
    if maximum is not None:
        maximum = _bounded_string(maximum, maximum=64, code=code)
        if not _BOUND_VERSION_PATTERN.fullmatch(maximum):
            _fail(code)
    return {
        "importModule": import_module,
        "distribution": distribution,
        "installSpec": install_spec,
        "minimumVersion": minimum,
        "maximumVersionExclusive": maximum,
    }


def _normalized_distribution_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def _normalize_dependencies(value: Any, *, code: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_DEPENDENCIES:
        _fail(code)
    dependencies = [_normalize_dependency(dependency, code=code) for dependency in value]
    modules: set[str] = set()
    for dependency in dependencies:
        import_module = dependency["importModule"]
        if import_module in modules:
            _fail(code)
        modules.add(import_module)
    return dependencies


def _normalize_request(mode: str, request: dict[str, Any]) -> dict[str, Any]:
    if mode == "install":
        if set(request) != {"protocol", "kind", "token", "environment", "dependencies"}:
            _fail("invalid_request")
        token = _canonical_uuid(request["token"])
        dependencies = _normalize_dependencies(request["dependencies"], code="invalid_request")
        normalized = {
            "protocol": request["protocol"],
            "kind": request["kind"],
            "token": token,
            "environment": _normalize_environment(request["environment"], compare_actual=True, code="invalid_request"),
            "dependencies": dependencies,
        }
    elif mode == "status":
        if set(request) != {"protocol", "kind", "environment"}:
            _fail("invalid_request")
        normalized = {
            "protocol": request["protocol"],
            "kind": request["kind"],
            "environment": _normalize_environment(request["environment"], compare_actual=True, code="invalid_request"),
        }
    elif mode == "validate":
        if set(request) != {"protocol", "kind", "environment", "expectedToken"}:
            _fail("invalid_request")
        expected_token = _canonical_uuid(request["expectedToken"])
        normalized = {
            "protocol": request["protocol"],
            "kind": request["kind"],
            "environment": _normalize_environment(request["environment"], compare_actual=True, code="invalid_request"),
            "expectedToken": expected_token,
        }
    else:
        _fail("invalid_request")
    if normalized["protocol"] != PROTOCOL or normalized["kind"] != mode:
        _fail("invalid_request")
    return normalized


def _has_reparse_point(path: Path) -> bool:
    if os.name != "nt":
        return False
    try:
        from ctypes import wintypes

        kernel32 = _windows_kernel32()
        get_attributes = kernel32.GetFileAttributesW
        get_attributes.argtypes = [ctypes.c_wchar_p]
        get_attributes.restype = wintypes.DWORD
        attributes = get_attributes(str(path))
    except (AttributeError, OSError):
        _fail("malformed_state")
    if attributes == 0xFFFFFFFF:
        _fail("malformed_state")
    return bool(attributes & 0x400)


def _validate_private_directory(path: Path, expected_identity: tuple[int, int] | None = None) -> tuple[int, int]:
    try:
        result = path.lstat()
    except OSError:
        _fail("malformed_state")
    if not stat.S_ISDIR(result.st_mode) or path.is_symlink() or _has_reparse_point(path):
        _fail("malformed_state")
    if os.name != "nt" and (result.st_uid != os.geteuid() or stat.S_IMODE(result.st_mode) & 0o077):
        _fail("malformed_state")
    identity = (result.st_dev, result.st_ino)
    if expected_identity is not None and identity != expected_identity:
        _fail("malformed_state")
    return identity


def _validate_private_file(result: os.stat_result, *, code: str) -> None:
    if not stat.S_ISREG(result.st_mode) or result.st_nlink != 1:
        _fail(code)
    if os.name != "nt" and (result.st_uid != os.geteuid() or stat.S_IMODE(result.st_mode) & 0o077):
        _fail(code)


def _lstat_private_file(path: Path, *, code: str) -> os.stat_result:
    try:
        result = path.lstat()
    except OSError:
        _fail(code)
    if path.is_symlink() or _has_reparse_point(path):
        _fail(code)
    _validate_private_file(result, code=code)
    return result


def _same_file_snapshot(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        left.st_dev == right.st_dev
        and left.st_ino == right.st_ino
        and left.st_size == right.st_size
        and left.st_mtime_ns == right.st_mtime_ns
        and left.st_ctime_ns == right.st_ctime_ns
    )


def _same_file_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def _same_leaf_descriptor_snapshot(leaf: os.stat_result, descriptor: os.stat_result) -> bool:
    # CPython's Windows path stat preserves the legacy creation-time value in
    # st_ctime_ns while fstat exposes the handle's change time.  Comparing that
    # field across the two APIs therefore rejects an unchanged file.  The two
    # handle snapshots taken around every read still compare change time below.
    return (
        _same_file_identity(leaf, descriptor)
        and leaf.st_size == descriptor.st_size
        and leaf.st_mtime_ns == descriptor.st_mtime_ns
        and (os.name == "nt" or leaf.st_ctime_ns == descriptor.st_ctime_ns)
    )


def _assert_leaf_matches(path: Path, expected: os.stat_result, *, code: str) -> os.stat_result:
    observed = _lstat_private_file(path, code=code)
    if not _same_file_snapshot(observed, expected):
        _fail(code)
    return observed


def _assert_leaf_matches_descriptor(path: Path, expected: os.stat_result, *, code: str) -> os.stat_result:
    observed = _lstat_private_file(path, code=code)
    if not _same_leaf_descriptor_snapshot(observed, expected):
        _fail(code)
    return observed


def _assert_leaf_identity_matches(path: Path, expected: os.stat_result, *, code: str) -> os.stat_result:
    observed = _lstat_private_file(path, code=code)
    if not _same_file_identity(observed, expected):
        _fail(code)
    return observed


def _assert_leaf_absent(path: Path, *, code: str) -> None:
    try:
        path.lstat()
    except FileNotFoundError:
        return
    except OSError:
        _fail(code)
    _fail(code)


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _revalidate_actual_environment(expected: dict[str, Any]) -> None:
    actual = _actual_environment()
    if actual != expected:
        _fail("environment_changed")


def _create_journal(environment: dict[str, Any]) -> tuple[Path, tuple[int, int]]:
    root = Path(environment["packageRoot"])
    journal = root / JOURNAL_NAME
    created = False
    try:
        journal.mkdir(mode=0o700)
        created = True
    except FileExistsError:
        pass
    except OSError:
        _fail("malformed_state")
    if created:
        try:
            os.chmod(journal, 0o700)
            _fsync_directory(root)
        except OSError:
            _fail("malformed_state")
    identity = _validate_private_directory(journal)
    _revalidate_actual_environment(environment)
    return journal, identity


def _existing_journal(environment: dict[str, Any]) -> tuple[Path | None, tuple[int, int] | None]:
    root = Path(environment["packageRoot"])
    journal = root / JOURNAL_NAME
    try:
        journal.lstat()
    except FileNotFoundError:
        _revalidate_actual_environment(environment)
        try:
            journal.lstat()
        except FileNotFoundError:
            return None, None
        except OSError:
            _fail("malformed_state")
    except OSError:
        _fail("malformed_state")
    identity = _validate_private_directory(journal)
    _revalidate_actual_environment(environment)
    return journal, identity


def _status_journal(environment: dict[str, Any]) -> tuple[Path | None, tuple[int, int] | None, bool]:
    root = Path(environment["packageRoot"])
    journal = root / JOURNAL_NAME
    created = False
    try:
        journal.lstat()
    except FileNotFoundError:
        try:
            journal.mkdir(mode=0o700)
            created = True
        except FileExistsError:
            pass
        except OSError as error:
            if error.errno not in {errno.EACCES, errno.EPERM, errno.EROFS}:
                _fail("malformed_state")
            _revalidate_actual_environment(environment)
            try:
                journal.lstat()
            except FileNotFoundError:
                _revalidate_actual_environment(environment)
                return None, None, False
            except OSError:
                _fail("malformed_state")
    except OSError:
        _fail("malformed_state")
    if created:
        try:
            os.chmod(journal, 0o700)
            _fsync_directory(root)
        except OSError:
            _fail("malformed_state")
    identity = _validate_private_directory(journal)
    _revalidate_actual_environment(environment)
    return journal, identity, created


def _prepare_status_lock(journal: Path) -> None:
    lock = journal / LOCK_NAME
    try:
        lock.lstat()
    except FileNotFoundError:
        pass
    except OSError:
        _fail("malformed_state")
    else:
        _lstat_private_file(lock, code="malformed_state")
        return
    try:
        entries = list(os.scandir(journal))
    except OSError:
        _fail("malformed_state")
    if not entries:
        return
    # Another status/install may create the lock after our first ENOENT and
    # before (or during) directory enumeration.  Recheck the exact leaf rather
    # than misclassifying that ordinary race as malformed.  Retained marker or
    # temporary state with a still-missing lock remains fail-closed.
    try:
        lock.lstat()
    except FileNotFoundError:
        _fail("malformed_state")
    except OSError:
        _fail("malformed_state")
    _lstat_private_file(lock, code="malformed_state")


class _JournalLock:
    def __init__(self, journal: Path, journal_identity: tuple[int, int], *, create: bool) -> None:
        self._journal = journal
        self._journal_identity = journal_identity
        self._create = create
        self._descriptor = -1
        self._windows_overlapped: Any | None = None
        self._windows_unlock: Any | None = None
        self._windows_handle: Any | None = None

    def __enter__(self) -> _JournalLock:
        _validate_private_directory(self._journal, self._journal_identity)
        path = self._journal / LOCK_NAME
        base_flags = os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        created = False
        before: os.stat_result | None = None
        try:
            if self._create:
                try:
                    path.lstat()
                except FileNotFoundError:
                    try:
                        self._descriptor = os.open(path, base_flags | os.O_CREAT | os.O_EXCL, 0o600)
                        created = True
                    except FileExistsError:
                        before = _lstat_private_file(path, code="malformed_state")
                        self._descriptor = os.open(path, base_flags)
                except OSError:
                    _fail("malformed_state")
                else:
                    before = _lstat_private_file(path, code="malformed_state")
                    self._descriptor = os.open(path, base_flags)
            else:
                before = _lstat_private_file(path, code="malformed_state")
                self._descriptor = os.open(path, base_flags)
            if created and os.name != "nt":
                os.fchmod(self._descriptor, 0o600)
            opened = os.fstat(self._descriptor)
            _validate_private_file(opened, code="malformed_state")
            if before is not None and not _same_file_identity(before, opened):
                _fail("malformed_state")
            _assert_leaf_identity_matches(path, opened, code="malformed_state")
            os.set_inheritable(self._descriptor, False)
            if created:
                os.fsync(self._descriptor)
                _fsync_directory(self._journal)
            self._acquire()
            _assert_leaf_identity_matches(path, opened, code="malformed_state")
            _validate_private_directory(self._journal, self._journal_identity)
            return self
        except GuardError:
            self._close()
            raise
        except OSError as error:
            self._close()
            if error.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                _fail("busy")
            _fail("malformed_state")

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        try:
            self._release()
        finally:
            self._close()

    def _acquire(self) -> None:
        if os.name == "nt":
            self._acquire_windows()
            return
        import fcntl

        try:
            fcntl.flock(self._descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            _fail("busy")

    def _release(self) -> None:
        if self._descriptor < 0:
            return
        if os.name == "nt":
            if (
                self._windows_overlapped is not None
                and self._windows_unlock is not None
                and self._windows_handle is not None
            ):
                with contextlib.suppress(AttributeError, OSError):
                    self._windows_unlock(
                        self._windows_handle,
                        0,
                        1,
                        0,
                        ctypes.byref(self._windows_overlapped),
                    )
            return
        try:
            import fcntl

            fcntl.flock(self._descriptor, fcntl.LOCK_UN)
        except OSError:
            pass

    def _acquire_windows(self) -> None:
        import msvcrt
        from ctypes import wintypes

        class Overlapped(ctypes.Structure):
            _fields_ = [
                ("Internal", ctypes.c_size_t),
                ("InternalHigh", ctypes.c_size_t),
                ("Offset", wintypes.DWORD),
                ("OffsetHigh", wintypes.DWORD),
                ("hEvent", wintypes.HANDLE),
            ]

        overlapped = Overlapped()
        get_osfhandle = getattr(msvcrt, "get_osfhandle", None)
        set_last_error = getattr(ctypes, "set_last_error", None)
        get_last_error = getattr(ctypes, "get_last_error", None)
        if not callable(get_osfhandle) or not callable(set_last_error) or not callable(get_last_error):
            _fail("malformed_state")
        handle_value = get_osfhandle(self._descriptor)
        if not isinstance(handle_value, int):
            _fail("malformed_state")
        handle = wintypes.HANDLE(handle_value)
        kernel32 = _windows_kernel32()
        lock_file_ex = kernel32.LockFileEx
        lock_file_ex.argtypes = [
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.POINTER(Overlapped),
        ]
        lock_file_ex.restype = wintypes.BOOL
        unlock_file_ex = kernel32.UnlockFileEx
        unlock_file_ex.argtypes = [
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.POINTER(Overlapped),
        ]
        unlock_file_ex.restype = wintypes.BOOL
        set_last_error(0)
        locked = lock_file_ex(handle, 0x00000002 | 0x00000001, 0, 1, 0, ctypes.byref(overlapped))
        if not locked:
            error = get_last_error()
            if error in {32, 33, 158}:
                _fail("busy")
            _fail("malformed_state")
        self._windows_overlapped = overlapped
        self._windows_unlock = unlock_file_ex
        self._windows_handle = handle

    def _close(self) -> None:
        if self._descriptor >= 0:
            try:
                os.close(self._descriptor)
            finally:
                self._descriptor = -1


def _marker_bytes(marker: dict[str, Any]) -> bytes:
    encoded = json.dumps(marker, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("ascii")
    if not encoded or len(encoded) > MAX_MARKER_BYTES:
        _fail("invalid_request")
    return encoded


def _write_all(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        written = os.write(descriptor, payload[offset:])
        if written <= 0:
            _fail("malformed_state")
        offset += written


def _settled_written_snapshot(
    path: Path,
    descriptor_snapshot: os.stat_result,
    expected_size: int,
    *,
    code: str,
) -> os.stat_result:
    if descriptor_snapshot.st_size != expected_size:
        _fail(code)
    if os.name != "nt":
        return _assert_leaf_matches_descriptor(path, descriptor_snapshot, code=code)

    # Windows finalizes a file's last-write metadata only after every writing
    # handle is closed.  Establish the canonical snapshot from the leaf after
    # close, while still binding it to the opened file's identity and size.
    settled = _lstat_private_file(path, code=code)
    if not _same_file_identity(settled, descriptor_snapshot) or settled.st_size != expected_size:
        _fail(code)
    return _assert_leaf_matches(path, settled, code=code)


def _durable_replace(source: Path, destination: Path) -> None:
    if os.name != "nt":
        os.replace(source, destination)
        return
    move_file_ex = _windows_kernel32().MoveFileExW
    move_file_ex.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]
    move_file_ex.restype = ctypes.c_int
    if not move_file_ex(str(source), str(destination), 0x1 | 0x8):
        _fail("malformed_state")


def _windows_kernel32() -> Any:
    loader = getattr(ctypes, "WinDLL", None)
    if loader is None:
        _fail("malformed_state")
    try:
        return loader("kernel32", use_last_error=True)
    except OSError:
        _fail("malformed_state")


def _publish_marker(
    journal: Path,
    journal_identity: tuple[int, int],
    token: str,
    environment: dict[str, Any],
    dependencies: list[dict[str, Any]],
) -> tuple[Path, bytes, tuple[int, int]]:
    _validate_private_directory(journal, journal_identity)
    markers = _scan_markers(journal, journal_identity, clean_temps=True)
    if markers:
        _fail("malformed_state")
    marker = {
        "dependencies": dependencies,
        "environment": environment,
        "protocol": PROTOCOL,
        "token": token,
    }
    payload = _marker_bytes(marker)
    temporary = journal / f".pending-{token}.tmp"
    destination = journal / f"mutation-{token}.json"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = -1
    try:
        _assert_leaf_absent(temporary, code="malformed_state")
        descriptor = os.open(temporary, flags, 0o600)
        if os.name != "nt":
            os.fchmod(descriptor, 0o600)
        os.set_inheritable(descriptor, False)
        _write_all(descriptor, payload)
        os.fsync(descriptor)
        descriptor_snapshot = os.fstat(descriptor)
        _validate_private_file(descriptor_snapshot, code="malformed_state")
        os.close(descriptor)
        descriptor = -1
        written = _settled_written_snapshot(
            temporary,
            descriptor_snapshot,
            len(payload),
            code="malformed_state",
        )
        _assert_leaf_absent(destination, code="malformed_state")
        _durable_replace(temporary, destination)
        _fsync_directory(journal)
        _validate_private_directory(journal, journal_identity)
        result = _lstat_private_file(destination, code="malformed_state")
        if not _same_file_identity(result, written) or result.st_size != len(payload):
            _fail("malformed_state")
        return destination, payload, (result.st_dev, result.st_ino)
    except GuardError:
        if descriptor >= 0:
            os.close(descriptor)
        _safe_remove_temporary(temporary)
        raise
    except OSError:
        if descriptor >= 0:
            os.close(descriptor)
        _safe_remove_temporary(temporary)
        _fail("malformed_state")


def _safe_remove_temporary(path: Path) -> None:
    try:
        _lstat_private_file(path, code="malformed_state")
    except GuardError:
        return
    with contextlib.suppress(OSError):
        path.unlink()


def _read_marker(path: Path, *, code: str) -> tuple[dict[str, Any], bytes, tuple[int, int]]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        leaf_before = _lstat_private_file(path, code=code)
        descriptor = os.open(path, flags)
        try:
            before = os.fstat(descriptor)
            _validate_private_file(before, code=code)
            if not _same_leaf_descriptor_snapshot(leaf_before, before):
                _fail(code)
            if not 1 <= before.st_size <= MAX_MARKER_BYTES:
                _fail(code)
            payload = b""
            while len(payload) <= MAX_MARKER_BYTES:
                chunk = os.read(descriptor, min(8192, MAX_MARKER_BYTES + 1 - len(payload)))
                if not chunk:
                    break
                payload += chunk
            after = os.fstat(descriptor)
        finally:
            os.close(descriptor)
    except GuardError:
        raise
    except OSError:
        _fail(code)
    if (
        len(payload) != before.st_size
        or before.st_dev != after.st_dev
        or before.st_ino != after.st_ino
        or before.st_size != after.st_size
        or before.st_mtime_ns != after.st_mtime_ns
        or before.st_ctime_ns != after.st_ctime_ns
    ):
        _fail(code)
    _assert_leaf_matches_descriptor(path, after, code=code)
    try:
        decoded = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=_reject_marker_duplicate_keys,
            parse_constant=lambda _value: _fail(code),
        )
    except GuardError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError):
        _fail(code)
    if not isinstance(decoded, dict) or set(decoded) != {"protocol", "token", "environment", "dependencies"}:
        _fail(code)
    if decoded["protocol"] != PROTOCOL:
        _fail(code)
    try:
        token = _canonical_uuid(decoded["token"])
        environment = _normalize_environment(decoded["environment"], compare_actual=False, code=code)
        dependencies = _normalize_dependencies(decoded["dependencies"], code=code)
    except GuardError:
        _fail(code)
    marker = {
        "dependencies": dependencies,
        "environment": environment,
        "protocol": PROTOCOL,
        "token": token,
    }
    filename_match = _MARKER_PATTERN.fullmatch(path.name)
    if filename_match is None or filename_match.group(1) != token:
        _fail(code)
    return marker, payload, (before.st_dev, before.st_ino)


def _reject_marker_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("malformed_state")
        result[key] = value
    return result


def _scan_markers(
    journal: Path, journal_identity: tuple[int, int], *, clean_temps: bool
) -> list[tuple[Path, dict[str, Any], bytes, tuple[int, int]]]:
    _validate_private_directory(journal, journal_identity)
    marker_paths: list[Path] = []
    temporary_paths: list[Path] = []
    try:
        entries = list(os.scandir(journal))
    except OSError:
        _fail("malformed_state")
    if len(entries) > MAX_DEPENDENCIES + 4:
        _fail("malformed_state")
    for entry in entries:
        name = entry.name
        if name == LOCK_NAME:
            _lstat_private_file(journal / name, code="malformed_state")
            continue
        marker_match = _MARKER_PATTERN.fullmatch(name)
        if marker_match is not None and str(uuid.UUID(marker_match.group(1))) == marker_match.group(1):
            marker_paths.append(journal / name)
            continue
        temp_match = _TEMP_PATTERN.fullmatch(name)
        if temp_match is not None and str(uuid.UUID(temp_match.group(1))) == temp_match.group(1):
            temporary_paths.append(journal / name)
            continue
        _fail("malformed_state")
    if temporary_paths and not clean_temps:
        _fail("malformed_state")
    for temporary in temporary_paths:
        try:
            result = _lstat_private_file(temporary, code="malformed_state")
            if result.st_size > MAX_MARKER_BYTES:
                _fail("malformed_state")
            temporary.unlink()
        except GuardError:
            raise
        except OSError:
            _fail("malformed_state")
    if temporary_paths:
        _fsync_directory(journal)
    if len(marker_paths) > 1:
        _fail("malformed_state")
    return [(path, *_read_marker(path, code="malformed_state")) for path in marker_paths]


def _remove_exact_marker(
    journal: Path,
    journal_identity: tuple[int, int],
    path: Path,
    token: str,
    payload: bytes,
    file_identity: tuple[int, int],
    *,
    code: str,
) -> None:
    _validate_private_directory(journal, journal_identity)
    marker, current_payload, current_identity = _read_marker(path, code=code)
    if marker["token"] != token or current_payload != payload or current_identity != file_identity:
        _fail(code)
    try:
        path.unlink()
        _fsync_directory(journal)
    except OSError:
        _fail(code)


def _assert_exact_marker(
    journal: Path,
    journal_identity: tuple[int, int],
    path: Path,
    token: str,
    payload: bytes,
    file_identity: tuple[int, int],
    *,
    code: str,
) -> None:
    _validate_private_directory(journal, journal_identity)
    marker, current_payload, current_identity = _read_marker(path, code=code)
    if marker["token"] != token or current_payload != payload or current_identity != file_identity:
        _fail(code)
    _validate_private_directory(journal, journal_identity)


@contextlib.contextmanager
def _silence_file_descriptors() -> Iterator[None]:
    stdout_object = sys.stdout
    stderr_object = sys.stderr
    saved_stdout = -1
    saved_stderr = -1
    devnull = -1
    try:
        try:
            stdout_object.flush()
            stderr_object.flush()
        except (OSError, ValueError):
            pass
        saved_stdout = os.dup(1)
        saved_stderr = os.dup(2)
        os.set_inheritable(saved_stdout, False)
        os.set_inheritable(saved_stderr, False)
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, 1)
        os.dup2(devnull, 2)
        yield
    finally:
        sys.stdout = stdout_object
        sys.stderr = stderr_object
        if saved_stdout >= 0:
            os.dup2(saved_stdout, 1)
        if saved_stderr >= 0:
            os.dup2(saved_stderr, 2)
        for descriptor in (devnull, saved_stdout, saved_stderr):
            if descriptor >= 0:
                with contextlib.suppress(OSError):
                    os.close(descriptor)


def _run_pip(dependencies: list[dict[str, Any]]) -> int:
    arguments = ["pip", "install", "--no-input", "--no-user", "--"]
    arguments.extend(dependency["installSpec"] for dependency in dependencies)
    prior_arguments = sys.argv
    exit_code = EXIT_PIP_FAILED
    try:
        sys.argv = arguments
        with _silence_file_descriptors():
            try:
                runpy.run_module("pip", run_name="__main__", alter_sys=True)
            except SystemExit as error:
                exit_code = EXIT_SUCCESS if error.code is None or error.code == 0 else EXIT_PIP_FAILED
            except BaseException:
                exit_code = EXIT_PIP_FAILED
            else:
                exit_code = EXIT_SUCCESS
    finally:
        sys.argv = prior_arguments
    return exit_code


def _release_parts(value: str) -> tuple[int, ...]:
    match = _RELEASE_PREFIX_PATTERN.match(value)
    if match is None:
        _fail("validation_failed")
    parts = tuple(int(part) for part in match.group(0).split("."))
    if len(parts) > 32 or any(part >= 1 << 31 for part in parts):
        _fail("validation_failed")
    return parts


def _compare_release_versions(left: str, right: str) -> int:
    left_parts = _release_parts(left)
    right_parts = _release_parts(right)
    length = max(len(left_parts), len(right_parts))
    for index in range(length):
        difference = (left_parts[index] if index < len(left_parts) else 0) - (
            right_parts[index] if index < len(right_parts) else 0
        )
        if difference:
            return 1 if difference > 0 else -1
    return 0


def _validate_dependencies(dependencies: list[dict[str, Any]]) -> None:
    with _silence_file_descriptors():
        for dependency in dependencies:
            try:
                importlib.import_module(dependency["importModule"])
                observed = importlib.metadata.version(dependency["distribution"])
            except BaseException:
                _fail("validation_failed")
            if (
                not isinstance(observed, str)
                or not observed
                or len(observed) > 256
                or "\x00" in observed
                or any(ord(character) < 0x20 for character in observed)
            ):
                _fail("validation_failed")
            minimum = dependency["minimumVersion"]
            maximum = dependency["maximumVersionExclusive"]
            if minimum is not None and _compare_release_versions(observed, minimum) < 0:
                _fail("validation_failed")
            if maximum is not None and _compare_release_versions(observed, maximum) >= 0:
                _fail("validation_failed")


def _run_install(request: dict[str, Any]) -> int:
    environment = request["environment"]
    token = request["token"]
    journal, journal_identity = _create_journal(environment)
    with _JournalLock(journal, journal_identity, create=True):
        _revalidate_actual_environment(environment)
        marker_path, marker_payload, marker_identity = _publish_marker(
            journal, journal_identity, token, environment, request["dependencies"]
        )
        ready_sent = False
        package_write_may_have_started = False
        try:
            _revalidate_actual_environment(environment)
            _emit({"kind": "ready", "protocol": PROTOCOL, "token": token})
            ready_sent = True
            go = _read_frame()
            if set(go) != {"protocol", "kind", "token"}:
                _fail("invalid_request")
            if go["protocol"] != PROTOCOL or go["kind"] != "go" or go["token"] != token:
                _fail("invalid_request")
            _revalidate_actual_environment(environment)
            _assert_exact_marker(
                journal,
                journal_identity,
                marker_path,
                token,
                marker_payload,
                marker_identity,
                code="malformed_state",
            )
            _revalidate_actual_environment(environment)
            package_write_may_have_started = True
            return _run_pip(request["dependencies"])
        except GuardError as error:
            if not package_write_may_have_started:
                with contextlib.suppress(GuardError):
                    _remove_exact_marker(
                        journal,
                        journal_identity,
                        marker_path,
                        token,
                        marker_payload,
                        marker_identity,
                        code="malformed_state",
                    )
            if ready_sent:
                return _EXIT_BY_CODE.get(error.code, EXIT_INTERNAL_ERROR)
            raise
        except (BrokenPipeError, OSError):
            if not package_write_may_have_started:
                try:
                    _remove_exact_marker(
                        journal,
                        journal_identity,
                        marker_path,
                        token,
                        marker_payload,
                        marker_identity,
                        code="malformed_state",
                    )
                except GuardError:
                    return EXIT_INTERNAL_ERROR
            if ready_sent:
                return EXIT_INTERNAL_ERROR
            raise GuardError("internal_error") from None


def _run_status(request: dict[str, Any]) -> int:
    environment = request["environment"]
    journal, journal_identity, _created = _status_journal(environment)
    if journal is None or journal_identity is None:
        _emit({"kind": "status", "protocol": PROTOCOL, "state": "clean", "token": None})
        return EXIT_SUCCESS
    _prepare_status_lock(journal)
    with _JournalLock(journal, journal_identity, create=True):
        _revalidate_actual_environment(environment)
        markers = _scan_markers(journal, journal_identity, clean_temps=True)
        if not markers:
            _emit({"kind": "status", "protocol": PROTOCOL, "state": "clean", "token": None})
            return EXIT_SUCCESS
        _path, marker, _payload, _identity = markers[0]
        if marker["environment"] != environment:
            _fail("environment_changed")
        _emit({"kind": "status", "protocol": PROTOCOL, "state": "dirty", "token": marker["token"]})
        return EXIT_SUCCESS


def _run_validate(request: dict[str, Any]) -> int:
    environment = request["environment"]
    journal, journal_identity = _existing_journal(environment)
    if journal is None or journal_identity is None:
        _fail("stale_or_missing_marker")
    with _JournalLock(journal, journal_identity, create=False):
        _revalidate_actual_environment(environment)
        markers = _scan_markers(journal, journal_identity, clean_temps=True)
        if not markers:
            _fail("stale_or_missing_marker")
        marker_path, marker, marker_payload, marker_identity = markers[0]
        if marker["environment"] != environment:
            _fail("environment_changed")
        expected_token = request["expectedToken"]
        if expected_token != marker["token"]:
            _fail("stale_or_missing_marker")
        _validate_dependencies(marker["dependencies"])
        _revalidate_actual_environment(environment)
        _remove_exact_marker(
            journal,
            journal_identity,
            marker_path,
            marker["token"],
            marker_payload,
            marker_identity,
            code="malformed_state",
        )
        _emit({"kind": "validated", "protocol": PROTOCOL, "token": marker["token"]})
        return EXIT_SUCCESS


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"install", "status", "validate"}:
        with contextlib.suppress(BrokenPipeError, GuardError, OSError):
            _emit_error("invalid_request")
        return EXIT_INVALID_REQUEST
    mode = sys.argv[1]
    try:
        request = _normalize_request(mode, _read_frame())
        if mode == "install":
            return _run_install(request)
        if mode == "status":
            return _run_status(request)
        return _run_validate(request)
    except GuardError as error:
        code = error.code if error.code in _EXIT_BY_CODE else "internal_error"
        with contextlib.suppress(BrokenPipeError, GuardError, OSError):
            _emit_error(code)
        return _EXIT_BY_CODE[code]
    except (BrokenPipeError, OSError):
        return EXIT_INTERNAL_ERROR
    except BaseException:
        with contextlib.suppress(BrokenPipeError, GuardError, OSError):
            _emit_error("internal_error")
        return EXIT_INTERNAL_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
