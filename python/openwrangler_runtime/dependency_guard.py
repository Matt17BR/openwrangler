"""Crash-safe dependency mutation guard for a selected Python environment.

This module uses the Python standard library plus the selected interpreter's
pip-vendored PEP 440 implementation and can be executed directly with
``python -I dependency_guard.py <mode>``. Its JSONL protocol is consumed by
the extension host; package and import output never crosses that boundary.
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
import subprocess
import sys
import threading
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any, NoReturn, cast

PROTOCOL = "openwrangler-dependency-guard-v1"
JOURNAL_NAME = ".openwrangler-dependency-journal-v1"
LOCK_NAME = "mutation.lock"
MAX_FRAME_BYTES = 65_536
MAX_MARKER_BYTES = 65_536
MAX_DEPENDENCIES = 64
INTEGRITY_PROTOCOL = "openwrangler-dependency-integrity-v1"
INTEGRITY_CHECK_TIMEOUT_SECONDS = 20
INTEGRITY_HELPER = Path(__file__).with_name("dependency_integrity.py")

EXIT_SUCCESS = 0
EXIT_INVALID_REQUEST = 10
EXIT_BUSY = 11
EXIT_MALFORMED_STATE = 12
EXIT_VALIDATION_FAILED = 13
EXIT_PIP_FAILED = 14
EXIT_STALE_OR_MISSING_MARKER = 15
EXIT_ENVIRONMENT_CHANGED = 16
EXIT_INTERNAL_ERROR = 17
EXIT_ENVIRONMENT_INCONSISTENT = 18
EXIT_POST_INSTALL_INCONSISTENT = 19
EXIT_INTEGRITY_CHECK_FAILED = 20

_EXIT_BY_CODE = {
    "invalid_request": EXIT_INVALID_REQUEST,
    "busy": EXIT_BUSY,
    "malformed_state": EXIT_MALFORMED_STATE,
    "validation_failed": EXIT_VALIDATION_FAILED,
    "pip_failed": EXIT_PIP_FAILED,
    "stale_or_missing_marker": EXIT_STALE_OR_MISSING_MARKER,
    "environment_changed": EXIT_ENVIRONMENT_CHANGED,
    "internal_error": EXIT_INTERNAL_ERROR,
    "environment_inconsistent": EXIT_ENVIRONMENT_INCONSISTENT,
    "post_install_inconsistent": EXIT_POST_INSTALL_INCONSISTENT,
    "integrity_check_failed": EXIT_INTEGRITY_CHECK_FAILED,
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
    "exactVersion",
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


def _require_input_end() -> None:
    if sys.stdin.buffer.read(1):
        _fail("invalid_request")


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
    try:
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
    except (BrokenPipeError, OSError):
        _discard_failed_stdout()
        raise


def _discard_failed_stdout() -> None:
    try:
        stdout_descriptor = sys.stdout.buffer.fileno()
        replacement_descriptor = os.open(os.devnull, os.O_WRONLY)
    except (OSError, ValueError):
        return
    try:
        if replacement_descriptor != stdout_descriptor:
            os.dup2(replacement_descriptor, stdout_descriptor)
    except (OSError, ValueError):
        pass
    finally:
        if replacement_descriptor != stdout_descriptor:
            with contextlib.suppress(OSError):
                os.close(replacement_descriptor)


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
    exact = value["exactVersion"]
    minimum = value["minimumVersion"]
    maximum = value["maximumVersionExclusive"]
    if exact is not None:
        exact = _bounded_string(exact, maximum=64, code=code)
        if not _BOUND_VERSION_PATTERN.fullmatch(exact):
            _fail(code)
    if minimum is not None:
        minimum = _bounded_string(minimum, maximum=64, code=code)
        if not _BOUND_VERSION_PATTERN.fullmatch(minimum):
            _fail(code)
    if maximum is not None:
        maximum = _bounded_string(maximum, maximum=64, code=code)
        if not _BOUND_VERSION_PATTERN.fullmatch(maximum):
            _fail(code)
    constraints = install_match.group("constraints")
    if exact is None:
        if any(constraint.startswith("==") for constraint in constraints.split(",")):
            _fail(code)
    elif constraints != f"=={exact}" or minimum is not None or maximum is not None:
        _fail(code)
    return {
        "importModule": import_module,
        "distribution": distribution,
        "installSpec": install_spec,
        "exactVersion": exact,
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


_WINDOWS_FILE_ALL_ACCESS = 0x001F01FF
_WINDOWS_GENERIC_READ = 0x80000000
_WINDOWS_GENERIC_WRITE = 0x40000000
_WINDOWS_READ_CONTROL = 0x00020000
_WINDOWS_FILE_READ_ATTRIBUTES = 0x00000080
_WINDOWS_FILE_SHARE_READ = 0x00000001
_WINDOWS_FILE_SHARE_WRITE = 0x00000002
_WINDOWS_FILE_SHARE_DELETE = 0x00000004
_WINDOWS_CREATE_NEW = 1
_WINDOWS_OPEN_EXISTING = 3
_WINDOWS_FILE_ATTRIBUTE_DIRECTORY = 0x00000010
_WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
_WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
_WINDOWS_FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
_WINDOWS_ERROR_ACCESS_DENIED = 5
_WINDOWS_ERROR_WRITE_PROTECT = 19
_WINDOWS_ERROR_FILE_EXISTS = 80
_WINDOWS_ERROR_ALREADY_EXISTS = 183
_WINDOWS_ERROR_INSUFFICIENT_BUFFER = 122
_WINDOWS_TOKEN_QUERY = 0x0008
_WINDOWS_TOKEN_USER = 1
_WINDOWS_SE_FILE_OBJECT = 1
_WINDOWS_OWNER_SECURITY_INFORMATION = 0x00000001
_WINDOWS_DACL_SECURITY_INFORMATION = 0x00000004
_WINDOWS_SE_OWNER_DEFAULTED = 0x0001
_WINDOWS_SE_DACL_PRESENT = 0x0004
_WINDOWS_SE_DACL_DEFAULTED = 0x0008
_WINDOWS_SE_DACL_PROTECTED = 0x1000
_WINDOWS_SE_SELF_RELATIVE = 0x8000
_WINDOWS_ACCESS_ALLOWED_ACE_TYPE = 0
_WINDOWS_OBJECT_INHERIT_ACE = 0x01
_WINDOWS_CONTAINER_INHERIT_ACE = 0x02
_WINDOWS_ACL_REVISION = 2
_WINDOWS_ACL_REVISION_INFORMATION = 1
_WINDOWS_ACL_SIZE_INFORMATION = 2
_WINDOWS_FILE_ATTRIBUTE_TAG_INFO = 9
_WINDOWS_SYSTEM_SID = "S-1-5-18"
_WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544"
_WINDOWS_SID_PATTERN = re.compile(r"^S-[0-9]+(?:-[0-9]+)+$")


class _WindowsSecurityAttributes(ctypes.Structure):
    _fields_ = [
        ("nLength", ctypes.c_uint32),
        ("lpSecurityDescriptor", ctypes.c_void_p),
        ("bInheritHandle", ctypes.c_int),
    ]


class _WindowsSidAndAttributes(ctypes.Structure):
    _fields_ = [
        ("Sid", ctypes.c_void_p),
        ("Attributes", ctypes.c_uint32),
    ]


class _WindowsTokenUser(ctypes.Structure):
    _fields_ = [("User", _WindowsSidAndAttributes)]


class _WindowsFileAttributeTagInfo(ctypes.Structure):
    _fields_ = [
        ("FileAttributes", ctypes.c_uint32),
        ("ReparseTag", ctypes.c_uint32),
    ]


class _WindowsAclSizeInformation(ctypes.Structure):
    _fields_ = [
        ("AceCount", ctypes.c_uint32),
        ("AclBytesInUse", ctypes.c_uint32),
        ("AclBytesFree", ctypes.c_uint32),
    ]


class _WindowsAclRevisionInformation(ctypes.Structure):
    _fields_ = [("AclRevision", ctypes.c_uint32)]


class _WindowsAceHeader(ctypes.Structure):
    _fields_ = [
        ("AceType", ctypes.c_ubyte),
        ("AceFlags", ctypes.c_ubyte),
        ("AceSize", ctypes.c_uint16),
    ]


def _windows_last_error() -> int:
    get_last_error = getattr(ctypes, "get_last_error", None)
    if not callable(get_last_error):
        _fail("malformed_state")
    error = get_last_error()
    if not isinstance(error, int):
        _fail("malformed_state")
    return error


def _windows_set_last_error(value: int) -> None:
    set_last_error = getattr(ctypes, "set_last_error", None)
    if not callable(set_last_error):
        _fail("malformed_state")
    set_last_error(value)


def _windows_close_handle(handle: int, *, code: str, suppress_error: bool) -> None:
    from ctypes import wintypes

    close_handle = _windows_kernel32().CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL
    if not close_handle(wintypes.HANDLE(handle)) and not suppress_error:
        _fail(code)


@contextlib.contextmanager
def _windows_owned_handle(handle: int, *, code: str) -> Iterator[int]:
    try:
        yield handle
    except BaseException:
        _windows_close_handle(handle, code=code, suppress_error=True)
        raise
    else:
        _windows_close_handle(handle, code=code, suppress_error=False)


def _windows_local_free(pointer: int, *, code: str, suppress_error: bool) -> None:
    from ctypes import wintypes

    local_free = _windows_kernel32().LocalFree
    local_free.argtypes = [wintypes.HLOCAL]
    local_free.restype = wintypes.HLOCAL
    remaining = local_free(wintypes.HLOCAL(pointer))
    if remaining and not suppress_error:
        _fail(code)


@contextlib.contextmanager
def _windows_owned_local(pointer: int, *, code: str) -> Iterator[int]:
    try:
        yield pointer
    except BaseException:
        _windows_local_free(pointer, code=code, suppress_error=True)
        raise
    else:
        _windows_local_free(pointer, code=code, suppress_error=False)


def _windows_sid_to_string(sid: int, *, code: str) -> str:
    convert_sid = _windows_advapi32().ConvertSidToStringSidW
    convert_sid.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    convert_sid.restype = ctypes.c_int
    encoded = ctypes.c_void_p()
    if not convert_sid(ctypes.c_void_p(sid), ctypes.byref(encoded)) or not encoded.value:
        _fail(code)
    with _windows_owned_local(encoded.value, code=code):
        value = ctypes.wstring_at(encoded.value)
    if not 1 <= len(value) <= 184 or not _WINDOWS_SID_PATTERN.fullmatch(value):
        _fail(code)
    return value


def _windows_token_user_sid(*, code: str) -> str:
    from ctypes import wintypes

    kernel32 = _windows_kernel32()
    get_current_process = kernel32.GetCurrentProcess
    get_current_process.argtypes = []
    get_current_process.restype = wintypes.HANDLE
    open_process_token = _windows_advapi32().OpenProcessToken
    open_process_token.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    open_process_token.restype = wintypes.BOOL
    token = wintypes.HANDLE()
    if not open_process_token(get_current_process(), _WINDOWS_TOKEN_QUERY, ctypes.byref(token)) or not token.value:
        _fail(code)
    with _windows_owned_handle(token.value, code=code):
        get_token_information = _windows_advapi32().GetTokenInformation
        get_token_information.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ]
        get_token_information.restype = wintypes.BOOL
        required = wintypes.DWORD()
        _windows_set_last_error(0)
        if get_token_information(
            token,
            _WINDOWS_TOKEN_USER,
            None,
            0,
            ctypes.byref(required),
        ):
            _fail(code)
        if _windows_last_error() != _WINDOWS_ERROR_INSUFFICIENT_BUFFER or not 1 <= required.value <= 65_536:
            _fail(code)
        buffer = ctypes.create_string_buffer(required.value)
        if not get_token_information(
            token,
            _WINDOWS_TOKEN_USER,
            buffer,
            required,
            ctypes.byref(required),
        ):
            _fail(code)
        token_user = ctypes.cast(buffer, ctypes.POINTER(_WindowsTokenUser)).contents
        if not token_user.User.Sid:
            _fail(code)
        return _windows_sid_to_string(token_user.User.Sid, code=code)


def _windows_expected_sids(*, user_sid: str | None = None, code: str) -> tuple[str, ...]:
    result: list[str] = []
    for sid in (
        user_sid or _windows_token_user_sid(code=code),
        _WINDOWS_SYSTEM_SID,
        _WINDOWS_ADMINISTRATORS_SID,
    ):
        if sid not in result:
            result.append(sid)
    return tuple(result)


@contextlib.contextmanager
def _windows_security_attributes(*, is_directory: bool, code: str) -> Iterator[ctypes.c_void_p]:
    user_sid = _windows_token_user_sid(code=code)
    inheritance = "OICI" if is_directory else ""
    aces = "".join(f"(A;{inheritance};FA;;;{sid})" for sid in _windows_expected_sids(user_sid=user_sid, code=code))
    sddl = f"O:{user_sid}D:P{aces}"
    convert = _windows_advapi32().ConvertStringSecurityDescriptorToSecurityDescriptorW
    convert.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_uint32),
    ]
    convert.restype = ctypes.c_int
    descriptor = ctypes.c_void_p()
    descriptor_size = ctypes.c_uint32()
    if not convert(sddl, 1, ctypes.byref(descriptor), ctypes.byref(descriptor_size)) or not descriptor.value:
        _fail(code)
    with _windows_owned_local(descriptor.value, code=code):
        attributes = _WindowsSecurityAttributes(
            nLength=ctypes.sizeof(_WindowsSecurityAttributes),
            lpSecurityDescriptor=descriptor.value,
            bInheritHandle=0,
        )
        yield ctypes.cast(ctypes.byref(attributes), ctypes.c_void_p)


def _windows_create_secure_directory(
    path: Path,
    *,
    allow_permission_failure: bool,
    code: str,
) -> bool | None:
    create_directory = _windows_kernel32().CreateDirectoryW
    create_directory.argtypes = [ctypes.c_wchar_p, ctypes.c_void_p]
    create_directory.restype = ctypes.c_int
    with _windows_security_attributes(is_directory=True, code=code) as attributes:
        _windows_set_last_error(0)
        if create_directory(str(path), attributes):
            return True
        error = _windows_last_error()
    if error == _WINDOWS_ERROR_ALREADY_EXISTS:
        return False
    if allow_permission_failure and error in {
        _WINDOWS_ERROR_ACCESS_DENIED,
        _WINDOWS_ERROR_WRITE_PROTECT,
    }:
        return None
    _fail(code)


def _windows_create_file_handle(
    path: Path,
    *,
    desired_access: int,
    share_mode: int,
    creation_disposition: int,
    is_directory: bool,
    secure_create: bool,
    code: str,
) -> int:
    from ctypes import wintypes

    create_file = _windows_kernel32().CreateFileW
    create_file.argtypes = [
        ctypes.c_wchar_p,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    create_file.restype = wintypes.HANDLE
    flags = _WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT
    if is_directory:
        flags |= _WINDOWS_FILE_FLAG_BACKUP_SEMANTICS

    def create(attributes: ctypes.c_void_p | None) -> int:
        _windows_set_last_error(0)
        handle = create_file(
            str(path),
            desired_access,
            share_mode,
            attributes,
            creation_disposition,
            flags,
            None,
        )
        invalid_handle = ctypes.c_void_p(-1).value
        if handle is not None and handle != invalid_handle:
            return handle
        error = _windows_last_error()
        if creation_disposition == _WINDOWS_CREATE_NEW and error in {
            _WINDOWS_ERROR_FILE_EXISTS,
            _WINDOWS_ERROR_ALREADY_EXISTS,
        }:
            raise FileExistsError(errno.EEXIST, "secure leaf already exists")
        _fail(code)

    if secure_create:
        with _windows_security_attributes(is_directory=is_directory, code=code) as attributes:
            return create(attributes)
    return create(None)


def _windows_handle_to_descriptor(handle: int, flags: int, *, code: str) -> int:
    import msvcrt

    open_osfhandle = getattr(msvcrt, "open_osfhandle", None)
    if not callable(open_osfhandle):
        _windows_close_handle(handle, code=code, suppress_error=True)
        _fail(code)
    try:
        descriptor = cast(
            int,
            open_osfhandle(
                handle,
                flags | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOINHERIT", 0),
            ),
        )
    except (OSError, ValueError):
        _windows_close_handle(handle, code=code, suppress_error=True)
        _fail(code)
    except BaseException:
        _windows_close_handle(handle, code=code, suppress_error=True)
        raise
    if descriptor < 0:
        _windows_close_handle(handle, code=code, suppress_error=True)
        _fail(code)
    try:
        os.set_inheritable(descriptor, False)
    except OSError:
        with contextlib.suppress(OSError):
            os.close(descriptor)
        _fail(code)
    return descriptor


def _windows_descriptor_handle(descriptor: int, *, code: str) -> int:
    import msvcrt

    get_osfhandle = getattr(msvcrt, "get_osfhandle", None)
    if not callable(get_osfhandle):
        _fail(code)
    try:
        handle = get_osfhandle(descriptor)
    except OSError:
        _fail(code)
    if not isinstance(handle, int) or handle == -1:
        _fail(code)
    return handle


def _windows_validate_handle_security(
    handle: int,
    *,
    is_directory: bool,
    code: str,
) -> None:
    from ctypes import wintypes

    get_information = _windows_kernel32().GetFileInformationByHandleEx
    get_information.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    get_information.restype = wintypes.BOOL
    attributes = _WindowsFileAttributeTagInfo()
    if not get_information(
        wintypes.HANDLE(handle),
        _WINDOWS_FILE_ATTRIBUTE_TAG_INFO,
        ctypes.byref(attributes),
        ctypes.sizeof(attributes),
    ):
        _fail(code)
    if attributes.FileAttributes & _WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT:
        _fail(code)
    if bool(attributes.FileAttributes & _WINDOWS_FILE_ATTRIBUTE_DIRECTORY) != is_directory:
        _fail(code)

    get_security = _windows_advapi32().GetSecurityInfo
    get_security.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
    ]
    get_security.restype = wintypes.DWORD
    owner = ctypes.c_void_p()
    dacl = ctypes.c_void_p()
    security_descriptor = ctypes.c_void_p()
    error = get_security(
        wintypes.HANDLE(handle),
        _WINDOWS_SE_FILE_OBJECT,
        _WINDOWS_OWNER_SECURITY_INFORMATION | _WINDOWS_DACL_SECURITY_INFORMATION,
        ctypes.byref(owner),
        None,
        ctypes.byref(dacl),
        None,
        ctypes.byref(security_descriptor),
    )
    if error or not security_descriptor.value:
        _fail(code)
    with _windows_owned_local(security_descriptor.value, code=code):
        advapi32 = _windows_advapi32()
        user_sid = _windows_token_user_sid(code=code)
        is_valid_descriptor = advapi32.IsValidSecurityDescriptor
        is_valid_descriptor.argtypes = [ctypes.c_void_p]
        is_valid_descriptor.restype = wintypes.BOOL
        if not is_valid_descriptor(security_descriptor):
            _fail(code)

        control = ctypes.c_uint16()
        revision = wintypes.DWORD()
        get_control = advapi32.GetSecurityDescriptorControl
        get_control.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_uint16),
            ctypes.POINTER(wintypes.DWORD),
        ]
        get_control.restype = wintypes.BOOL
        if not get_control(security_descriptor, ctypes.byref(control), ctypes.byref(revision)):
            _fail(code)
        required_control = _WINDOWS_SE_DACL_PRESENT | _WINDOWS_SE_DACL_PROTECTED
        rejected_control = _WINDOWS_SE_OWNER_DEFAULTED | _WINDOWS_SE_DACL_DEFAULTED
        if (
            revision.value != 1
            or control.value & required_control != required_control
            or control.value & _WINDOWS_SE_SELF_RELATIVE != _WINDOWS_SE_SELF_RELATIVE
            or control.value & rejected_control
        ):
            _fail(code)

        descriptor_owner = ctypes.c_void_p()
        owner_defaulted = wintypes.BOOL()
        get_owner = advapi32.GetSecurityDescriptorOwner
        get_owner.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(wintypes.BOOL),
        ]
        get_owner.restype = wintypes.BOOL
        if (
            not get_owner(
                security_descriptor,
                ctypes.byref(descriptor_owner),
                ctypes.byref(owner_defaulted),
            )
            or not descriptor_owner.value
            or owner_defaulted.value
        ):
            _fail(code)

        descriptor_dacl = ctypes.c_void_p()
        dacl_present = wintypes.BOOL()
        dacl_defaulted = wintypes.BOOL()
        get_dacl = advapi32.GetSecurityDescriptorDacl
        get_dacl.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(wintypes.BOOL),
            ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(wintypes.BOOL),
        ]
        get_dacl.restype = wintypes.BOOL
        if (
            not get_dacl(
                security_descriptor,
                ctypes.byref(dacl_present),
                ctypes.byref(descriptor_dacl),
                ctypes.byref(dacl_defaulted),
            )
            or not dacl_present.value
            or not descriptor_dacl.value
            or dacl_defaulted.value
        ):
            _fail(code)
        if owner.value != descriptor_owner.value or dacl.value != descriptor_dacl.value:
            _fail(code)

        is_valid_sid = advapi32.IsValidSid
        is_valid_sid.argtypes = [ctypes.c_void_p]
        is_valid_sid.restype = wintypes.BOOL
        if not is_valid_sid(descriptor_owner):
            _fail(code)
        if _windows_sid_to_string(descriptor_owner.value, code=code) != user_sid:
            _fail(code)

        is_valid_acl = advapi32.IsValidAcl
        is_valid_acl.argtypes = [ctypes.c_void_p]
        is_valid_acl.restype = wintypes.BOOL
        if not is_valid_acl(descriptor_dacl):
            _fail(code)
        acl_revision = _WindowsAclRevisionInformation()
        get_acl_information = advapi32.GetAclInformation
        get_acl_information.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.c_int,
        ]
        get_acl_information.restype = wintypes.BOOL
        if (
            not get_acl_information(
                descriptor_dacl,
                ctypes.byref(acl_revision),
                ctypes.sizeof(acl_revision),
                _WINDOWS_ACL_REVISION_INFORMATION,
            )
            or acl_revision.AclRevision != _WINDOWS_ACL_REVISION
        ):
            _fail(code)
        acl_information = _WindowsAclSizeInformation()
        if not get_acl_information(
            descriptor_dacl,
            ctypes.byref(acl_information),
            ctypes.sizeof(acl_information),
            _WINDOWS_ACL_SIZE_INFORMATION,
        ):
            _fail(code)
        expected_sids = set(_windows_expected_sids(user_sid=user_sid, code=code))
        if (
            acl_information.AceCount != len(expected_sids)
            or acl_information.AclBytesInUse < 8
            or acl_information.AclBytesInUse > 65_535
        ):
            _fail(code)
        get_ace = advapi32.GetAce
        get_ace.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
        get_ace.restype = wintypes.BOOL
        get_length_sid = advapi32.GetLengthSid
        get_length_sid.argtypes = [ctypes.c_void_p]
        get_length_sid.restype = wintypes.DWORD
        expected_flags = _WINDOWS_OBJECT_INHERIT_ACE | _WINDOWS_CONTAINER_INHERIT_ACE if is_directory else 0
        observed_sids: set[str] = set()
        observed_bytes = 8
        acl_start = descriptor_dacl.value
        acl_end = acl_start + acl_information.AclBytesInUse
        for index in range(acl_information.AceCount):
            ace = ctypes.c_void_p()
            if not get_ace(descriptor_dacl, index, ctypes.byref(ace)) or not ace.value:
                _fail(code)
            if ace.value < acl_start + 8 or ace.value + ctypes.sizeof(_WindowsAceHeader) > acl_end:
                _fail(code)
            header = _WindowsAceHeader.from_address(ace.value)
            if (
                header.AceType != _WINDOWS_ACCESS_ALLOWED_ACE_TYPE
                or header.AceFlags != expected_flags
                or header.AceSize < 16
                or ace.value + header.AceSize > acl_end
            ):
                _fail(code)
            mask = ctypes.c_uint32.from_address(ace.value + 4).value
            sid = ace.value + 8
            if sid + 2 > ace.value + header.AceSize:
                _fail(code)
            sid_revision = ctypes.c_ubyte.from_address(sid).value
            sub_authority_count = ctypes.c_ubyte.from_address(sid + 1).value
            if sid_revision != 1 or sub_authority_count > 15:
                _fail(code)
            sid_size = 8 + 4 * sub_authority_count
            if (
                header.AceSize != 8 + sid_size
                or sid + sid_size != ace.value + header.AceSize
                or mask != _WINDOWS_FILE_ALL_ACCESS
                or not is_valid_sid(ctypes.c_void_p(sid))
            ):
                _fail(code)
            sid_length = get_length_sid(ctypes.c_void_p(sid))
            if sid_length != sid_size:
                _fail(code)
            sid_string = _windows_sid_to_string(sid, code=code)
            if sid_string in observed_sids:
                _fail(code)
            observed_sids.add(sid_string)
            observed_bytes += header.AceSize
        if observed_sids != expected_sids or observed_bytes != acl_information.AclBytesInUse:
            _fail(code)


def _windows_open_validated_descriptor(
    path: Path,
    *,
    desired_access: int,
    share_mode: int,
    creation_disposition: int,
    descriptor_flags: int,
    is_directory: bool,
    secure_create: bool,
    code: str,
) -> int:
    handle = _windows_create_file_handle(
        path,
        desired_access=desired_access,
        share_mode=share_mode,
        creation_disposition=creation_disposition,
        is_directory=is_directory,
        secure_create=secure_create,
        code=code,
    )
    descriptor = _windows_handle_to_descriptor(handle, descriptor_flags, code=code)
    try:
        _windows_validate_handle_security(
            _windows_descriptor_handle(descriptor, code=code),
            is_directory=is_directory,
            code=code,
        )
        return descriptor
    except GuardError:
        with contextlib.suppress(OSError):
            os.close(descriptor)
        raise
    except BaseException:
        with contextlib.suppress(OSError):
            os.close(descriptor)
        raise


def _windows_open_private_directory(
    path: Path,
    *,
    expected_identity: tuple[int, int] | None,
    code: str,
) -> tuple[int, os.stat_result]:
    descriptor = _windows_open_validated_descriptor(
        path,
        # Metadata-only directory opens do not reliably participate in delete
        # sharing on Windows. GENERIC_READ includes FILE_LIST_DIRECTORY and
        # SYNCHRONIZE, so omitting FILE_SHARE_DELETE pins the directory name.
        desired_access=_WINDOWS_GENERIC_READ,
        share_mode=_WINDOWS_FILE_SHARE_READ | _WINDOWS_FILE_SHARE_WRITE,
        creation_disposition=_WINDOWS_OPEN_EXISTING,
        descriptor_flags=os.O_RDONLY,
        is_directory=True,
        secure_create=False,
        code=code,
    )
    try:
        opened = os.fstat(descriptor)
        observed = path.lstat()
        if (
            not stat.S_ISDIR(opened.st_mode)
            or not stat.S_ISDIR(observed.st_mode)
            or not _same_file_identity(opened, observed)
        ):
            _fail(code)
        identity = (opened.st_dev, opened.st_ino)
        if expected_identity is not None and identity != expected_identity:
            _fail(code)
        return descriptor, opened
    except GuardError:
        with contextlib.suppress(OSError):
            os.close(descriptor)
        raise
    except OSError:
        with contextlib.suppress(OSError):
            os.close(descriptor)
        _fail(code)
    except BaseException:
        with contextlib.suppress(OSError):
            os.close(descriptor)
        raise


def _windows_create_secure_leaf_descriptor(
    path: Path,
    *,
    desired_access: int,
    share_mode: int,
    descriptor_flags: int,
    code: str,
) -> int:
    return _windows_open_validated_descriptor(
        path,
        desired_access=desired_access,
        share_mode=share_mode,
        creation_disposition=_WINDOWS_CREATE_NEW,
        descriptor_flags=descriptor_flags,
        is_directory=False,
        secure_create=True,
        code=code,
    )


def _windows_open_secure_leaf_descriptor(
    path: Path,
    *,
    desired_access: int,
    share_mode: int,
    descriptor_flags: int,
    code: str,
) -> int:
    return _windows_open_validated_descriptor(
        path,
        desired_access=desired_access,
        share_mode=share_mode,
        creation_disposition=_WINDOWS_OPEN_EXISTING,
        descriptor_flags=descriptor_flags,
        is_directory=False,
        secure_create=False,
        code=code,
    )


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


def _validate_private_directory(
    path: Path,
    expected_identity: tuple[int, int] | None = None,
    *,
    _while_pinned_for_test: Callable[[Path], None] | None = None,
) -> tuple[int, int]:
    if os.name == "nt":
        descriptor, opened = _windows_open_private_directory(
            path,
            expected_identity=expected_identity,
            code="malformed_state",
        )
        try:
            if _while_pinned_for_test is not None:
                _while_pinned_for_test(path)
            after = os.fstat(descriptor)
            observed = path.lstat()
            if (
                not stat.S_ISDIR(after.st_mode)
                or not stat.S_ISDIR(observed.st_mode)
                or not _same_file_identity(opened, after)
                or not _same_file_identity(after, observed)
            ):
                _fail("malformed_state")
            identity = (after.st_dev, after.st_ino)
            if expected_identity is not None and identity != expected_identity:
                _fail("malformed_state")
        except GuardError:
            with contextlib.suppress(OSError):
                os.close(descriptor)
            raise
        except OSError:
            with contextlib.suppress(OSError):
                os.close(descriptor)
            _fail("malformed_state")
        except BaseException:
            with contextlib.suppress(OSError):
                os.close(descriptor)
            raise
        try:
            os.close(descriptor)
        except OSError:
            _fail("malformed_state")
        return identity

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
    if os.name == "nt":
        descriptor = _windows_open_secure_leaf_descriptor(
            path,
            desired_access=_WINDOWS_READ_CONTROL | _WINDOWS_FILE_READ_ATTRIBUTES,
            share_mode=_WINDOWS_FILE_SHARE_READ | _WINDOWS_FILE_SHARE_WRITE,
            descriptor_flags=os.O_RDONLY,
            code=code,
        )
        try:
            opened = os.fstat(descriptor)
            observed = path.lstat()
            _validate_private_file(opened, code=code)
            _validate_private_file(observed, code=code)
            if not _same_leaf_descriptor_snapshot(observed, opened):
                _fail(code)
        except GuardError:
            with contextlib.suppress(OSError):
                os.close(descriptor)
            raise
        except OSError:
            with contextlib.suppress(OSError):
                os.close(descriptor)
            _fail(code)
        except BaseException:
            with contextlib.suppress(OSError):
                os.close(descriptor)
            raise
        try:
            os.close(descriptor)
        except OSError:
            _fail(code)
        return observed

    try:
        result = path.lstat()
    except OSError:
        _fail(code)
    if path.is_symlink() or _has_reparse_point(path):
        _fail(code)
    _validate_private_file(result, code=code)
    return result


def _same_file_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def _same_leaf_descriptor_snapshot(leaf: os.stat_result, descriptor: os.stat_result) -> bool:
    # CPython's Windows path stat preserves the legacy creation-time value in
    # st_ctime_ns while newer fstat implementations expose the handle's change
    # time.  Python 3.10 and 3.11 do not expose that change time at all.  Marker
    # readers therefore use a native Windows handle that excludes writers and
    # compare only metadata that is consistent across supported Python versions.
    return (
        _same_file_identity(leaf, descriptor)
        and leaf.st_size == descriptor.st_size
        and leaf.st_mtime_ns == descriptor.st_mtime_ns
        and (os.name == "nt" or leaf.st_ctime_ns == descriptor.st_ctime_ns)
    )


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
    if os.name == "nt":
        result = _windows_create_secure_directory(
            journal,
            allow_permission_failure=False,
            code="malformed_state",
        )
        created = result is True
    else:
        try:
            journal.mkdir(mode=0o700)
            created = True
        except FileExistsError:
            pass
        except OSError:
            _fail("malformed_state")
    if created:
        try:
            if os.name != "nt":
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
        if os.name == "nt":
            result = _windows_create_secure_directory(
                journal,
                allow_permission_failure=True,
                code="malformed_state",
            )
            created = result is True
            permission_failure = result is None
        else:
            permission_failure = False
            try:
                journal.mkdir(mode=0o700)
                created = True
            except FileExistsError:
                pass
            except OSError as error:
                if error.errno not in {errno.EACCES, errno.EPERM, errno.EROFS}:
                    _fail("malformed_state")
                permission_failure = True
        if permission_failure:
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
            if os.name != "nt":
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
    def __init__(
        self,
        journal: Path,
        journal_identity: tuple[int, int],
        *,
        create: bool,
        allow_read_only_existing: bool = False,
    ) -> None:
        self._journal = journal
        self._journal_identity = journal_identity
        self._create = create
        self._allow_read_only_existing = allow_read_only_existing
        self._descriptor = -1
        self._windows_journal_descriptor = -1
        self._windows_overlapped: Any | None = None
        self._windows_unlock: Any | None = None
        self._windows_handle: Any | None = None

    def __enter__(self) -> _JournalLock:
        if os.name == "nt":
            return self._enter_windows()
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
                        self._descriptor = self._open_existing_posix_lock(path, base_flags)
                except OSError:
                    _fail("malformed_state")
                else:
                    before = _lstat_private_file(path, code="malformed_state")
                    self._descriptor = self._open_existing_posix_lock(path, base_flags)
            else:
                before = _lstat_private_file(path, code="malformed_state")
                self._descriptor = self._open_existing_posix_lock(path, base_flags)
            if created:
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
            self._close(suppress_errors=True)
            raise
        except OSError as error:
            self._close(suppress_errors=True)
            if error.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                _fail("busy")
            _fail("malformed_state")
        except BaseException:
            self._close(suppress_errors=True)
            raise

    def _open_existing_posix_lock(self, path: Path, read_write_flags: int) -> int:
        try:
            return os.open(path, read_write_flags)
        except OSError as error:
            if not self._allow_read_only_existing or error.errno != errno.EROFS:
                raise
        read_only_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        return os.open(path, read_only_flags)

    def _enter_windows(self) -> _JournalLock:
        path = self._journal / LOCK_NAME
        created = False
        try:
            self._windows_journal_descriptor, pinned = _windows_open_private_directory(
                self._journal,
                expected_identity=self._journal_identity,
                code="malformed_state",
            )
            if self._create:
                try:
                    self._descriptor = _windows_create_secure_leaf_descriptor(
                        path,
                        desired_access=_WINDOWS_GENERIC_READ | _WINDOWS_GENERIC_WRITE,
                        share_mode=_WINDOWS_FILE_SHARE_READ | _WINDOWS_FILE_SHARE_WRITE,
                        descriptor_flags=os.O_RDWR,
                        code="malformed_state",
                    )
                    created = True
                except FileExistsError:
                    self._descriptor = _windows_open_secure_leaf_descriptor(
                        path,
                        desired_access=_WINDOWS_GENERIC_READ | _WINDOWS_GENERIC_WRITE,
                        share_mode=_WINDOWS_FILE_SHARE_READ | _WINDOWS_FILE_SHARE_WRITE,
                        descriptor_flags=os.O_RDWR,
                        code="malformed_state",
                    )
            else:
                self._descriptor = _windows_open_secure_leaf_descriptor(
                    path,
                    desired_access=_WINDOWS_GENERIC_READ | _WINDOWS_GENERIC_WRITE,
                    share_mode=_WINDOWS_FILE_SHARE_READ | _WINDOWS_FILE_SHARE_WRITE,
                    descriptor_flags=os.O_RDWR,
                    code="malformed_state",
                )
            opened = os.fstat(self._descriptor)
            _validate_private_file(opened, code="malformed_state")
            _assert_leaf_identity_matches(path, opened, code="malformed_state")
            if created:
                os.fsync(self._descriptor)
            self._acquire_windows()
            _assert_leaf_identity_matches(path, opened, code="malformed_state")
            journal_after = os.fstat(self._windows_journal_descriptor)
            journal_path = self._journal.lstat()
            _windows_validate_handle_security(
                _windows_descriptor_handle(
                    self._windows_journal_descriptor,
                    code="malformed_state",
                ),
                is_directory=True,
                code="malformed_state",
            )
            if (
                not _same_file_identity(pinned, journal_after)
                or not _same_file_identity(journal_after, journal_path)
                or (journal_after.st_dev, journal_after.st_ino) != self._journal_identity
            ):
                _fail("malformed_state")
            return self
        except GuardError:
            self._close(suppress_errors=True)
            raise
        except OSError as error:
            self._close(suppress_errors=True)
            if error.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                _fail("busy")
            _fail("malformed_state")
        except BaseException:
            self._close(suppress_errors=True)
            raise

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        if _type is not None:
            with contextlib.suppress(BaseException):
                self._release()
            with contextlib.suppress(BaseException):
                self._close(suppress_errors=True)
            return
        try:
            self._release()
        except BaseException:
            with contextlib.suppress(BaseException):
                self._close(suppress_errors=True)
            raise
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

    def _close(self, *, suppress_errors: bool = False) -> None:
        first_error: OSError | None = None
        if self._descriptor >= 0:
            try:
                os.close(self._descriptor)
            except OSError as error:
                first_error = error
            finally:
                self._descriptor = -1
        if self._windows_journal_descriptor >= 0:
            try:
                os.close(self._windows_journal_descriptor)
            except OSError as error:
                if first_error is None:
                    first_error = error
            finally:
                self._windows_journal_descriptor = -1
        if first_error is not None and not suppress_errors:
            raise first_error


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


def _open_windows_private_reader(path: Path, *, allow_delete: bool, code: str) -> int:
    # FILE_SHARE_READ permits other validators to inspect the marker.  Omitting
    # FILE_SHARE_WRITE excludes an existing or new writer for this handle's
    # lifetime.  Ordinary reads also omit FILE_SHARE_DELETE so the exact leaf
    # cannot be renamed or deleted.  Publication temporarily allows delete
    # sharing so MoveFileEx can rename the already-verified file while this
    # no-write handle remains open.
    share_mode = _WINDOWS_FILE_SHARE_READ | (_WINDOWS_FILE_SHARE_DELETE if allow_delete else 0)
    return _windows_open_secure_leaf_descriptor(
        path,
        desired_access=_WINDOWS_GENERIC_READ,
        share_mode=share_mode,
        descriptor_flags=os.O_RDONLY,
        code=code,
    )


def _open_private_reader(path: Path, *, allow_delete: bool, code: str) -> tuple[int, os.stat_result]:
    descriptor = -1
    try:
        leaf_before: os.stat_result | None = None
        if os.name == "nt":
            descriptor = _open_windows_private_reader(path, allow_delete=allow_delete, code=code)
        else:
            leaf_before = _lstat_private_file(path, code=code)
            flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(path, flags)
            os.set_inheritable(descriptor, False)
        opened = os.fstat(descriptor)
        _validate_private_file(opened, code=code)
        if leaf_before is not None and not _same_leaf_descriptor_snapshot(leaf_before, opened):
            _fail(code)
        _assert_leaf_matches_descriptor(path, opened, code=code)
        return descriptor, opened
    except GuardError:
        if descriptor >= 0:
            with contextlib.suppress(OSError):
                os.close(descriptor)
        raise
    except OSError:
        if descriptor >= 0:
            with contextlib.suppress(OSError):
                os.close(descriptor)
        _fail(code)


@contextlib.contextmanager
def _private_reader(
    path: Path,
    *,
    allow_delete: bool = False,
    code: str,
) -> Iterator[tuple[int, os.stat_result]]:
    descriptor = -1
    try:
        descriptor, opened = _open_private_reader(path, allow_delete=allow_delete, code=code)
        yield descriptor, opened
    except BaseException:
        if descriptor >= 0:
            with contextlib.suppress(OSError):
                os.close(descriptor)
        raise
    else:
        closing = descriptor
        descriptor = -1
        try:
            os.close(closing)
        except OSError:
            _fail(code)


def _read_open_private_file(
    path: Path,
    descriptor: int,
    opened: os.stat_result,
    *,
    code: str,
    expected_payload: bytes | None = None,
    expected_identity: tuple[int, int] | None = None,
    _after_open_for_test: Callable[[Path], None] | None = None,
) -> tuple[bytes, os.stat_result]:
    if expected_identity is not None and (opened.st_dev, opened.st_ino) != expected_identity:
        _fail(code)
    if not 1 <= opened.st_size <= MAX_MARKER_BYTES:
        _fail(code)
    if expected_payload is not None and opened.st_size != len(expected_payload):
        _fail(code)
    if _after_open_for_test is not None:
        _after_open_for_test(path)
    try:
        os.lseek(descriptor, 0, os.SEEK_SET)
        chunks: list[bytes] = []
        total = 0
        while total <= MAX_MARKER_BYTES:
            chunk = os.read(descriptor, min(8192, MAX_MARKER_BYTES + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        payload = b"".join(chunks)
        after = os.fstat(descriptor)
    except OSError:
        _fail(code)
    _validate_private_file(after, code=code)
    if len(payload) != opened.st_size or not _same_leaf_descriptor_snapshot(opened, after):
        _fail(code)
    _assert_leaf_matches_descriptor(path, after, code=code)
    if expected_payload is not None and payload != expected_payload:
        _fail(code)
    return payload, after


def _read_private_file(
    path: Path,
    *,
    code: str,
    expected_payload: bytes | None = None,
    expected_identity: tuple[int, int] | None = None,
    _after_open_for_test: Callable[[Path], None] | None = None,
) -> tuple[bytes, os.stat_result]:
    with _private_reader(path, code=code) as (descriptor, opened):
        return _read_open_private_file(
            path,
            descriptor,
            opened,
            code=code,
            expected_payload=expected_payload,
            expected_identity=expected_identity,
            _after_open_for_test=_after_open_for_test,
        )


def _durable_replace(source: Path, destination: Path) -> None:
    if os.name != "nt":
        os.replace(source, destination)
        return
    move_file_ex = _windows_kernel32().MoveFileExW
    move_file_ex.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]
    move_file_ex.restype = ctypes.c_int
    # Destination names are UUID-derived and are proved absent immediately
    # before this call.  Never replace an existing leaf if the namespace
    # changes between that check and publication.
    if not move_file_ex(str(source), str(destination), 0x8):
        _fail("malformed_state")


def _windows_kernel32() -> Any:
    loader = getattr(ctypes, "WinDLL", None)
    if loader is None:
        _fail("malformed_state")
    try:
        return loader("kernel32", use_last_error=True)
    except OSError:
        _fail("malformed_state")


def _windows_advapi32() -> Any:
    loader = getattr(ctypes, "WinDLL", None)
    if loader is None:
        _fail("malformed_state")
    try:
        return loader("advapi32", use_last_error=True)
    except OSError:
        _fail("malformed_state")


def _publish_marker(
    journal: Path,
    journal_identity: tuple[int, int],
    token: str,
    environment: dict[str, Any],
    dependencies: list[dict[str, Any]],
    *,
    _after_writer_close_for_test: Callable[[Path], None] | None = None,
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
        if os.name == "nt":
            descriptor = _windows_create_secure_leaf_descriptor(
                temporary,
                desired_access=(_WINDOWS_GENERIC_WRITE | _WINDOWS_READ_CONTROL | _WINDOWS_FILE_READ_ATTRIBUTES),
                share_mode=0,
                descriptor_flags=os.O_WRONLY,
                code="malformed_state",
            )
        else:
            descriptor = os.open(temporary, flags, 0o600)
            os.fchmod(descriptor, 0o600)
        os.set_inheritable(descriptor, False)
        _write_all(descriptor, payload)
        os.fsync(descriptor)
        descriptor_snapshot = os.fstat(descriptor)
        _validate_private_file(descriptor_snapshot, code="malformed_state")
        closing = descriptor
        descriptor = -1
        os.close(closing)
        if _after_writer_close_for_test is not None:
            _after_writer_close_for_test(temporary)
        writer_identity = (descriptor_snapshot.st_dev, descriptor_snapshot.st_ino)
        with _private_reader(temporary, allow_delete=True, code="malformed_state") as (
            verification_descriptor,
            written,
        ):
            _read_open_private_file(
                temporary,
                verification_descriptor,
                written,
                code="malformed_state",
                expected_payload=payload,
                expected_identity=writer_identity,
            )
            _assert_leaf_absent(destination, code="malformed_state")
            _durable_replace(temporary, destination)
            _fsync_directory(journal)
            _validate_private_directory(journal, journal_identity)
            with _private_reader(destination, code="malformed_state") as (
                destination_descriptor,
                result,
            ):
                _read_open_private_file(
                    destination,
                    destination_descriptor,
                    result,
                    code="malformed_state",
                    expected_payload=payload,
                    expected_identity=writer_identity,
                )
                _validate_private_directory(journal, journal_identity)
        return destination, payload, (result.st_dev, result.st_ino)
    except GuardError:
        if descriptor >= 0:
            with contextlib.suppress(OSError):
                os.close(descriptor)
        _safe_remove_temporary(temporary)
        raise
    except OSError:
        if descriptor >= 0:
            with contextlib.suppress(OSError):
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


def _read_marker(
    path: Path,
    *,
    code: str,
    _after_open_for_test: Callable[[Path], None] | None = None,
) -> tuple[dict[str, Any], bytes, tuple[int, int]]:
    payload, before = _read_private_file(
        path,
        code=code,
        _after_open_for_test=_after_open_for_test,
    )
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


def _decode_integrity_frame(raw: bytes) -> str:
    if (
        not raw
        or len(raw) > MAX_FRAME_BYTES
        or raw.count(b"\n") != 1
        or not raw.endswith(b"\n")
        or raw.endswith(b"\r\n")
        or b"\x00" in raw
    ):
        _fail("integrity_check_failed")
    try:
        decoded = json.loads(
            raw[:-1].decode("utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=lambda _value: _fail("integrity_check_failed"),
        )
    except GuardError:
        _fail("integrity_check_failed")
    except (UnicodeDecodeError, json.JSONDecodeError):
        _fail("integrity_check_failed")
    if (
        not isinstance(decoded, dict)
        or set(decoded) != {"kind", "protocol", "state"}
        or decoded["kind"] != "integrity"
        or decoded["protocol"] != INTEGRITY_PROTOCOL
        or decoded["state"] not in {"clean", "inconsistent", "failed"}
    ):
        _fail("integrity_check_failed")
    return cast(str, decoded["state"])


def _bounded_process_output(process: subprocess.Popen[bytes]) -> tuple[bytes, bool]:
    stream = process.stdout
    if stream is None:
        return b"", True
    output = bytearray()
    failed = False

    def read() -> None:
        nonlocal failed
        try:
            while len(output) <= MAX_FRAME_BYTES:
                chunk = stream.read(min(8192, MAX_FRAME_BYTES + 1 - len(output)))
                if not chunk:
                    return
                output.extend(chunk)
            with contextlib.suppress(OSError):
                process.kill()
        except (OSError, ValueError):
            failed = True
            with contextlib.suppress(OSError):
                process.kill()

    reader = threading.Thread(target=read, name="openwrangler-integrity-output", daemon=True)
    reader.start()
    timed_out = False
    try:
        process.wait(timeout=INTEGRITY_CHECK_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        timed_out = True
        with contextlib.suppress(OSError):
            process.kill()
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=5)
    reader.join(timeout=5)
    with contextlib.suppress(OSError):
        stream.close()
    return bytes(output), timed_out or failed or reader.is_alive()


def _check_environment_integrity(*, inconsistent_code: str) -> None:
    try:
        process = subprocess.Popen(
            [sys.executable, "-I", str(INTEGRITY_HELPER)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, ValueError):
        _fail("integrity_check_failed")
    raw, failed = _bounded_process_output(process)
    if failed or process.returncode != 0:
        _fail("integrity_check_failed")
    state = _decode_integrity_frame(raw)
    if state == "inconsistent":
        _fail(inconsistent_code)
    if state != "clean":
        _fail("integrity_check_failed")


def _pep440_specifier(value: str) -> Any:
    from pip._vendor.packaging.specifiers import SpecifierSet

    return SpecifierSet(value)


def _dependency_version_supported(dependency: dict[str, Any], observed: str) -> bool:
    try:
        from pip._vendor.packaging.version import Version

        if dependency["exactVersion"] is not None:
            specifier = f"=={dependency['exactVersion']}"
        else:
            constraints = []
            if dependency["minimumVersion"] is not None:
                constraints.append(f">={dependency['minimumVersion']}")
            if dependency["maximumVersionExclusive"] is not None:
                constraints.append(f"<{dependency['maximumVersionExclusive']}")
            specifier = ",".join(constraints)
        return bool(_pep440_specifier(specifier).contains(Version(observed), prereleases=True))
    except BaseException:
        return False


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
            if not _dependency_version_supported(dependency, observed):
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
            _require_input_end()
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
            _check_environment_integrity(inconsistent_code="environment_inconsistent")
            _revalidate_actual_environment(environment)
            package_write_may_have_started = True
            pip_exit = _run_pip(request["dependencies"])
            if pip_exit != EXIT_SUCCESS:
                return pip_exit
            _revalidate_actual_environment(environment)
            _check_environment_integrity(inconsistent_code="post_install_inconsistent")
            _revalidate_actual_environment(environment)
            return EXIT_SUCCESS
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
    with _JournalLock(journal, journal_identity, create=True, allow_read_only_existing=True):
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
        _check_environment_integrity(inconsistent_code="post_install_inconsistent")
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
        raw_request = _read_frame()
        if mode != "install":
            _require_input_end()
        request = _normalize_request(mode, raw_request)
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
