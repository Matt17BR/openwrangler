from __future__ import annotations

import os
import stat
import sys
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class ExportTargetError(RuntimeError):
    """Raised when the host-owned unpublished export target is not intact."""


@dataclass(frozen=True, slots=True)
class ExportTarget:
    path: Path
    device: int
    inode: int

    @classmethod
    def from_request(cls, path: str, identity: Mapping[str, Any] | None) -> ExportTarget:
        target = Path(path)
        if not target.is_absolute():
            raise ExportTargetError("Python data export requires an absolute host-owned target path.")
        if not isinstance(identity, Mapping) or set(identity) != {"device", "inode"}:
            raise ExportTargetError("Python data export requires the host-owned target identity.")
        device = _identity_component(identity["device"], "device")
        inode = _identity_component(identity["inode"], "inode")
        if device == 0 and inode == 0:
            raise ExportTargetError("Python data export requires a usable host-owned target identity.")
        result = cls(target, device, inode)
        result.assert_unchanged()
        return result

    def assert_unchanged(self) -> None:
        try:
            identity = _regular_file_identity(self.path)
        except (OSError, ValueError) as error:
            raise ExportTargetError("Open Wrangler's host-owned temporary export file changed unexpectedly.") from error
        if identity != (self.device, self.inode):
            raise ExportTargetError("Open Wrangler's host-owned temporary export file changed unexpectedly.")

    @contextmanager
    def pinned_writer_path(self) -> Iterator[str]:
        descriptor = _open_regular_file(self.path)
        try:
            if _descriptor_identity(descriptor) != (self.device, self.inode):
                raise ExportTargetError("Open Wrangler's host-owned temporary export file changed unexpectedly.")
            self.assert_unchanged()
            yield str(self.path)
            if _descriptor_identity(descriptor) != (self.device, self.inode):
                raise ExportTargetError("Open Wrangler's host-owned temporary export file changed unexpectedly.")
            self.assert_unchanged()
            os.fsync(descriptor)
            self.assert_unchanged()
        finally:
            os.close(descriptor)


def _identity_component(value: Any, label: str) -> int:
    if not isinstance(value, str) or not value or len(value) > 39:
        raise ExportTargetError(f"The host-owned export target {label} is invalid.")
    if value != "0" and (value[0] == "0" or not value.isascii() or not value.isdecimal()):
        raise ExportTargetError(f"The host-owned export target {label} is invalid.")
    result = int(value, 10)
    if result < 0 or result > (1 << 128) - 1:
        raise ExportTargetError(f"The host-owned export target {label} is invalid.")
    return result


def _open_regular_file(path: Path) -> int:
    details = path.lstat()
    if not stat.S_ISREG(details.st_mode) or stat.S_ISLNK(details.st_mode) or details.st_nlink != 1:
        raise ExportTargetError("Python data export accepts only the host's singly linked regular temporary file.")
    flags = os.O_RDWR | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOINHERIT", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        descriptor_details = os.fstat(descriptor)
        if not stat.S_ISREG(descriptor_details.st_mode) or descriptor_details.st_nlink != 1:
            raise ExportTargetError("Python data export accepts only the host's singly linked regular temporary file.")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _regular_file_identity(path: Path) -> tuple[int, int]:
    descriptor = _open_regular_file(path)
    try:
        identity = _descriptor_identity(descriptor)
        current_descriptor = _open_regular_file(path)
        try:
            if _descriptor_identity(current_descriptor) != identity:
                raise ExportTargetError("Open Wrangler's host-owned temporary export file changed unexpectedly.")
        finally:
            os.close(current_descriptor)
        return identity
    finally:
        os.close(descriptor)


def _descriptor_identity(descriptor: int) -> tuple[int, int]:
    if sys.platform != "win32":
        details = os.fstat(descriptor)
        return int(details.st_dev), int(details.st_ino)

    import ctypes
    import msvcrt
    from ctypes import wintypes

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

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetFileInformationByHandle.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(ByHandleFileInformation),
    ]
    kernel32.GetFileInformationByHandle.restype = wintypes.BOOL
    information = ByHandleFileInformation()
    handle = wintypes.HANDLE(msvcrt.get_osfhandle(descriptor))
    if not kernel32.GetFileInformationByHandle(handle, ctypes.byref(information)):
        raise ctypes.WinError(ctypes.get_last_error())
    if information.number_of_links != 1:
        raise ExportTargetError("Python data export accepts only the host's singly linked regular temporary file.")
    return (
        int(information.volume_serial_number),
        (int(information.file_index_high) << 32) | int(information.file_index_low),
    )
