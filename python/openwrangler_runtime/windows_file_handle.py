# pyright: strict

from __future__ import annotations

import ctypes
import os
from collections.abc import Callable
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from .error_causality import add_exception_note

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
FILE_READ_DATA = 0x00000001
FILE_LIST_DIRECTORY = 0x00000001
FILE_SHARE_READ = 0x00000001
FILE_SHARE_WRITE = 0x00000002
OPEN_EXISTING = 3
FILE_ATTRIBUTE_DIRECTORY = 0x00000010
FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
FILE_TYPE_DISK = 0x0001
INVALID_HANDLE_VALUE = int(cast(int, ctypes.c_void_p(-1).value))


class WindowsFileHandleValidationError(ValueError):
    """Raised when a Windows path or handle no longer names the expected file."""


class WindowsFileHandleCleanupError(OSError):
    def __init__(self, errors: list[OSError]) -> None:
        super().__init__("Windows export path pins could not be closed completely.")
        self.errors = tuple(errors)


class FileTime(ctypes.Structure):
    _fields_ = [
        ("low_date_time", wintypes.DWORD),
        ("high_date_time", wintypes.DWORD),
    ]


class ByHandleFileInformation(ctypes.Structure):
    _fields_ = [
        ("file_attributes", wintypes.DWORD),
        ("creation_time", FileTime),
        ("last_access_time", FileTime),
        ("last_write_time", FileTime),
        ("volume_serial_number", wintypes.DWORD),
        ("file_size_high", wintypes.DWORD),
        ("file_size_low", wintypes.DWORD),
        ("number_of_links", wintypes.DWORD),
        ("file_index_high", wintypes.DWORD),
        ("file_index_low", wintypes.DWORD),
    ]


class SecurityAttributes(ctypes.Structure):
    _fields_ = [
        ("length", wintypes.DWORD),
        ("security_descriptor", wintypes.LPVOID),
        ("inherit_handle", wintypes.BOOL),
    ]


@dataclass(frozen=True, slots=True)
class WindowsFileIdentity:
    volume_serial_number: int
    file_index: int


@dataclass(slots=True)
class WindowsPinnedExportTarget:
    path: Path
    expected_identity: WindowsFileIdentity
    parent_identity: WindowsFileIdentity
    parent_handle: int
    target_handle: int
    kernel32: Any
    get_osfhandle: Callable[[int], int]
    open_osfhandle: Callable[[int, int], int]

    @classmethod
    def open(
        cls,
        path: Path,
        expected_identity: tuple[int, int],
        *,
        kernel32: Any | None = None,
        get_osfhandle: Callable[[int], int] | None = None,
        open_osfhandle: Callable[[int, int], int] | None = None,
    ) -> WindowsPinnedExportTarget:
        active_kernel32 = kernel32 or _load_kernel32()
        active_get_osfhandle = get_osfhandle or _load_get_osfhandle()
        active_open_osfhandle = open_osfhandle or _load_open_osfhandle()
        parent_handle = _open_identity_handle(path.parent, active_kernel32, directory=True)
        try:
            parent_identity = _validated_handle_identity(active_kernel32, parent_handle, directory=True)
            target_handle = _open_identity_handle(path, active_kernel32, directory=False)
        except BaseException as error:
            _close_after_error(active_kernel32, [parent_handle], error)
            raise
        try:
            target_identity = _validated_handle_identity(active_kernel32, target_handle, directory=False)
            expected = WindowsFileIdentity(*expected_identity)
            if target_identity != expected:
                raise WindowsFileHandleValidationError("The Windows export target identity changed unexpectedly.")
            result = cls(
                path=path,
                expected_identity=expected,
                parent_identity=parent_identity,
                parent_handle=parent_handle,
                target_handle=target_handle,
                kernel32=active_kernel32,
                get_osfhandle=active_get_osfhandle,
                open_osfhandle=active_open_osfhandle,
            )
            result.assert_unchanged()
            return result
        except BaseException as error:
            _close_after_error(active_kernel32, [target_handle, parent_handle], error)
            raise

    def assert_unchanged(self) -> None:
        if _validated_handle_identity(self.kernel32, self.parent_handle, directory=True) != self.parent_identity:
            raise WindowsFileHandleValidationError("The Windows export parent identity changed unexpectedly.")
        if _validated_handle_identity(self.kernel32, self.target_handle, directory=False) != self.expected_identity:
            raise WindowsFileHandleValidationError("The Windows export target identity changed unexpectedly.")

        named_parent = _open_identity_handle(self.path.parent, self.kernel32, directory=True)
        try:
            if _validated_handle_identity(self.kernel32, named_parent, directory=True) != self.parent_identity:
                raise WindowsFileHandleValidationError("The Windows export parent path changed unexpectedly.")
        except BaseException as error:
            _close_after_error(self.kernel32, [named_parent], error)
            raise
        else:
            _close_handles(self.kernel32, [named_parent])

        named_target = _open_identity_handle(self.path, self.kernel32, directory=False)
        try:
            if _validated_handle_identity(self.kernel32, named_target, directory=False) != self.expected_identity:
                raise WindowsFileHandleValidationError("The Windows export target path changed unexpectedly.")
        except BaseException as error:
            _close_after_error(self.kernel32, [named_target], error)
            raise
        else:
            _close_handles(self.kernel32, [named_target])

    def sync(self) -> None:
        descriptor = _open_regular_file_descriptor(self.path, self.kernel32, self.open_osfhandle)
        try:
            if descriptor_identity(
                descriptor,
                kernel32=self.kernel32,
                get_osfhandle=self.get_osfhandle,
            ) != (
                self.expected_identity.volume_serial_number,
                self.expected_identity.file_index,
            ):
                raise WindowsFileHandleValidationError("The Windows export target identity changed unexpectedly.")
            os.fsync(descriptor)
            if descriptor_identity(
                descriptor,
                kernel32=self.kernel32,
                get_osfhandle=self.get_osfhandle,
            ) != (
                self.expected_identity.volume_serial_number,
                self.expected_identity.file_index,
            ):
                raise WindowsFileHandleValidationError("The Windows export target identity changed unexpectedly.")
        except BaseException as error:
            try:
                os.close(descriptor)
            except OSError as close_error:
                _raise_with_cleanup(error, close_error, "Windows export sync descriptor cleanup")
            raise
        else:
            os.close(descriptor)
        self.assert_unchanged()

    def close(self) -> None:
        handles = [self.target_handle, self.parent_handle]
        self.target_handle = INVALID_HANDLE_VALUE
        self.parent_handle = INVALID_HANDLE_VALUE
        _close_handles(self.kernel32, handles)


def open_regular_file_descriptor(path: Path) -> int:
    return _open_regular_file_descriptor(path, _load_kernel32(), _load_open_osfhandle())


def descriptor_identity(
    descriptor: int,
    *,
    kernel32: Any | None = None,
    get_osfhandle: Callable[[int], int] | None = None,
) -> tuple[int, int]:
    active_get_osfhandle = get_osfhandle or _load_get_osfhandle()
    identity = _validated_handle_identity(
        kernel32 or _load_kernel32(),
        active_get_osfhandle(descriptor),
        directory=False,
    )
    return identity.volume_serial_number, identity.file_index


def _open_identity_handle(path: Path, kernel32: Any, *, directory: bool) -> int:
    flags = FILE_FLAG_OPEN_REPARSE_POINT | (FILE_FLAG_BACKUP_SEMANTICS if directory else 0)
    desired_access = FILE_LIST_DIRECTORY if directory else FILE_READ_DATA
    return _open_raw_handle(path, kernel32, desired_access=desired_access, flags=flags)


def _open_regular_file_descriptor(
    path: Path,
    kernel32: Any,
    open_osfhandle: Callable[[int, int], int],
) -> int:
    handle = _open_raw_handle(
        path,
        kernel32,
        desired_access=GENERIC_READ | GENERIC_WRITE,
        flags=FILE_FLAG_OPEN_REPARSE_POINT,
    )
    try:
        _validated_handle_identity(kernel32, handle, directory=False)
        descriptor_flags = os.O_RDWR | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOINHERIT", 0)
        descriptor = open_osfhandle(handle, descriptor_flags)
    except BaseException as error:
        _close_after_error(kernel32, [handle], error)
        raise
    return descriptor


def _open_raw_handle(path: Path, kernel32: Any, *, desired_access: int, flags: int) -> int:
    security_attributes = SecurityAttributes(
        length=ctypes.sizeof(SecurityAttributes),
        security_descriptor=None,
        inherit_handle=False,
    )
    # A real read-class access makes the no-delete share mask participate in link-share checks, while shared write
    # lets the trusted-workspace native engine update this exact inode. The pin cannot distinguish that engine from
    # another same-UID shared writer, so this is not process isolation.
    handle = kernel32.CreateFileW(
        str(path),
        desired_access,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        ctypes.byref(security_attributes),
        OPEN_EXISTING,
        flags,
        None,
    )
    handle_value = _handle_value(handle)
    if handle_value == INVALID_HANDLE_VALUE:
        raise _windows_error("CreateFileW failed for the host-owned export path")
    return handle_value


def _validated_handle_identity(kernel32: Any, handle: int, *, directory: bool) -> WindowsFileIdentity:
    if kernel32.GetFileType(handle) != FILE_TYPE_DISK:
        raise WindowsFileHandleValidationError("The Windows export path is not on a disk filesystem.")
    information = ByHandleFileInformation()
    if not kernel32.GetFileInformationByHandle(handle, ctypes.byref(information)):
        raise _windows_error("GetFileInformationByHandle failed for the host-owned export path")
    is_directory = bool(information.file_attributes & FILE_ATTRIBUTE_DIRECTORY)
    if information.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT or is_directory != directory:
        raise WindowsFileHandleValidationError("The Windows export path has an unexpected file type.")
    if not directory and information.number_of_links != 1:
        raise WindowsFileHandleValidationError("The Windows export target is not singly linked.")
    return WindowsFileIdentity(
        volume_serial_number=int(information.volume_serial_number),
        file_index=(int(information.file_index_high) << 32) | int(information.file_index_low),
    )


def _close_after_error(kernel32: Any, handles: list[int], error: BaseException) -> None:
    try:
        _close_handles(kernel32, handles)
    except OSError as close_error:
        _raise_with_cleanup(error, close_error, "Windows export raw-handle cleanup")


def _raise_with_cleanup(error: BaseException, cleanup_error: BaseException, label: str) -> None:
    if error.__cause__ is None:
        raise error from cleanup_error
    detail = f"{type(cleanup_error).__name__}: {cleanup_error}"[:512]
    add_exception_note(error, f"{label} also failed: {detail}")
    raise error


def _close_handles(kernel32: Any, handles: list[int]) -> None:
    errors: list[OSError] = []
    for handle in handles:
        if handle == INVALID_HANDLE_VALUE:
            continue
        if not kernel32.CloseHandle(handle):
            errors.append(_windows_error("CloseHandle failed for a host-owned export path pin"))
    if len(errors) == 1:
        raise errors[0]
    if errors:
        raise WindowsFileHandleCleanupError(errors)


def _handle_value(handle: Any) -> int:
    value = getattr(handle, "value", handle)
    if value is None:
        return 0
    return int(value)


def _windows_error(message: str) -> OSError:
    get_last_error = getattr(ctypes, "get_last_error", None)
    error_code = int(get_last_error()) if get_last_error is not None else 0
    win_error = getattr(ctypes, "WinError", None)
    if win_error is not None:
        error = win_error(error_code)
        error.args = (*error.args, message)
        return error
    return OSError(error_code, message)


def _load_open_osfhandle() -> Callable[[int, int], int]:
    import msvcrt

    return cast(Callable[[int, int], int], vars(msvcrt)["open_osfhandle"])


def _load_get_osfhandle() -> Callable[[int], int]:
    import msvcrt

    return cast(Callable[[int], int], vars(msvcrt)["get_osfhandle"])


def _load_kernel32() -> Any:
    win_dll = cast(Callable[..., Any], vars(ctypes)["WinDLL"])
    kernel32 = win_dll("kernel32", use_last_error=True)
    kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(SecurityAttributes),
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.GetFileType.argtypes = [wintypes.HANDLE]
    kernel32.GetFileType.restype = wintypes.DWORD
    kernel32.GetFileInformationByHandle.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(ByHandleFileInformation),
    ]
    kernel32.GetFileInformationByHandle.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    return kernel32
