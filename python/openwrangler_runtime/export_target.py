# pyright: strict

from __future__ import annotations

import os
import stat
import sys
from collections.abc import Generator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

from .error_causality import add_exception_note


class ExportTargetError(RuntimeError):
    """Raised when the host-owned unpublished export target is not intact."""


@dataclass(frozen=True, slots=True)
class ExportWriterPath(os.PathLike[str]):
    path: Path
    device: int
    inode: int

    def __fspath__(self) -> str:
        return str(self.path)

    def __str__(self) -> str:
        return str(self.path)

    @contextmanager
    def open_binary_writer(self) -> Generator[BinaryIO, None, None]:
        descriptor = _open_regular_file(self.path)
        try:
            if _descriptor_identity(descriptor) != (self.device, self.inode):
                raise ExportTargetError("Open Wrangler's host-owned temporary export file changed unexpectedly.")
            os.ftruncate(descriptor, 0)
            writer = os.fdopen(descriptor, "wb", closefd=True)
        except BaseException as error:
            try:
                os.close(descriptor)
            except BaseException as close_error:
                _raise_with_cleanup(error, close_error, "Export descriptor cleanup")
            raise
        try:
            yield writer
            writer.flush()
        except BaseException as error:
            try:
                writer.close()
            except BaseException as close_error:
                _raise_with_cleanup(error, close_error, "Export writer cleanup")
            raise
        else:
            writer.close()


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
    def pinned_writer_path(self) -> Generator[ExportWriterPath, None, None]:
        writer_path = ExportWriterPath(self.path, self.device, self.inode)
        if sys.platform == "win32":
            with self._pinned_windows_writer_path():
                yield writer_path
            return

        descriptor = _open_regular_file(self.path)
        try:
            if _descriptor_identity(descriptor) != (self.device, self.inode):
                raise ExportTargetError("Open Wrangler's host-owned temporary export file changed unexpectedly.")
            self.assert_unchanged()
            yield writer_path
            if _descriptor_identity(descriptor) != (self.device, self.inode):
                raise ExportTargetError("Open Wrangler's host-owned temporary export file changed unexpectedly.")
            self.assert_unchanged()
            os.fsync(descriptor)
            self.assert_unchanged()
        except BaseException as error:
            try:
                os.close(descriptor)
            except BaseException as close_error:
                _raise_with_cleanup(error, close_error, "Pinned export descriptor cleanup")
            raise
        else:
            os.close(descriptor)

    @contextmanager
    def _pinned_windows_writer_path(self) -> Generator[None, None, None]:
        from .windows_file_handle import WindowsFileHandleValidationError, WindowsPinnedExportTarget

        try:
            pinned = WindowsPinnedExportTarget.open(self.path, (self.device, self.inode))
        except WindowsFileHandleValidationError as error:
            raise ExportTargetError("Open Wrangler's host-owned temporary export file changed unexpectedly.") from error
        try:
            self.assert_unchanged()
            yield
            pinned.assert_unchanged()
            self.assert_unchanged()
            pinned.sync()
            pinned.assert_unchanged()
            self.assert_unchanged()
        except WindowsFileHandleValidationError as error:
            validation_error = ExportTargetError(
                "Open Wrangler's host-owned temporary export file changed unexpectedly."
            )
            try:
                pinned.close()
            except BaseException as close_error:
                _add_cleanup_note(validation_error, close_error, "Windows export target pin cleanup")
            raise validation_error from error
        except BaseException as error:
            try:
                pinned.close()
            except BaseException as close_error:
                _raise_with_cleanup(error, close_error, "Windows export target pin cleanup")
            raise
        else:
            pinned.close()


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
    if sys.platform == "win32":
        from .windows_file_handle import WindowsFileHandleValidationError, open_regular_file_descriptor

        try:
            descriptor = open_regular_file_descriptor(path)
        except WindowsFileHandleValidationError as error:
            raise ExportTargetError(
                "Python data export accepts only the host's singly linked regular temporary file."
            ) from error
    else:
        flags = os.O_RDWR | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOINHERIT", 0)
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(path, flags)
    try:
        descriptor_details = os.fstat(descriptor)
        if not stat.S_ISREG(descriptor_details.st_mode) or descriptor_details.st_nlink != 1:
            raise ExportTargetError("Python data export accepts only the host's singly linked regular temporary file.")
        return descriptor
    except BaseException as error:
        try:
            os.close(descriptor)
        except BaseException as close_error:
            _raise_with_cleanup(error, close_error, "Export descriptor cleanup")
        raise


def _raise_with_cleanup(error: BaseException, cleanup_error: BaseException, label: str) -> None:
    if error.__cause__ is None:
        raise error from cleanup_error
    _add_cleanup_note(error, cleanup_error, label)
    raise error


def _add_cleanup_note(error: BaseException, cleanup_error: BaseException, label: str) -> None:
    note = f"{label} also failed: {_bounded_cleanup_detail(cleanup_error)}"
    add_exception_note(error, note)


def _bounded_cleanup_detail(error: BaseException) -> str:
    from .windows_file_handle import WindowsFileHandleCleanupError

    if isinstance(error, WindowsFileHandleCleanupError) and error.errors:
        children = "; ".join(f"{type(item).__name__}: {item}" for item in error.errors)
        detail = f"{type(error).__name__} ({children})"
    else:
        detail = f"{type(error).__name__}: {error}"
    return detail[:512]


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
    from .windows_file_handle import WindowsFileHandleValidationError, descriptor_identity

    try:
        return descriptor_identity(descriptor)
    except WindowsFileHandleValidationError as error:
        raise ExportTargetError(
            "Python data export accepts only the host's singly linked regular temporary file."
        ) from error
