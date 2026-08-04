from __future__ import annotations

import os
import stat
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import BinaryIO, NamedTuple

INVALID_INVOCATION_MESSAGE = "Open Wrangler received an invalid trusted-pickle conversion request."
NON_DATAFRAME_MESSAGE = "Open Wrangler can convert only a Pandas DataFrame pickle."
CONVERSION_FAILED_MESSAGE = "Open Wrangler could not convert the trusted pickle to Parquet."

EXIT_INVALID_INVOCATION = 2
EXIT_NON_DATAFRAME = 3
EXIT_CONVERSION_FAILED = 4

_WINDOWS_JOB_HANDLE: int | None = None


class NonDataFramePickleError(TypeError):
    """Raised when a trusted pickle does not contain a Pandas DataFrame."""


class SourceFingerprint(NamedTuple):
    device: int
    inode: int
    size: int
    modified_time_ns: int
    changed_time_ns: int


def convert_trusted_pickle_to_parquet(
    source: str | Path,
    destination: str | Path,
    expected_source_fingerprint: SourceFingerprint,
) -> None:
    """Load one trusted Pandas pickle and write it to a reserved Parquet file."""

    source_path = Path(source)
    destination_path = Path(destination)
    source_descriptor = _open_confirmed_source(source_path, expected_source_fingerprint)
    try:
        destination_identity = _regular_file_identity(destination_path)
    except BaseException:
        os.close(source_descriptor)
        raise
    if expected_source_fingerprint[:2] == destination_identity:
        os.close(source_descriptor)
        raise ValueError("The trusted pickle source and Parquet destination must be different files.")
    try:
        destination_descriptor = _open_reserved_destination(destination_path, destination_identity)
    except BaseException:
        os.close(source_descriptor)
        raise

    try:
        source_stream = os.fdopen(source_descriptor, "rb", closefd=True)
        source_descriptor = -1
        with source_stream:
            import pandas as pd

            value = pd.read_pickle(source_stream)
            _recheck_source(source_path, source_stream, expected_source_fingerprint)
            if not isinstance(value, pd.DataFrame):
                raise NonDataFramePickleError

            os.ftruncate(destination_descriptor, 0)
            os.lseek(destination_descriptor, 0, os.SEEK_SET)
            output = os.fdopen(destination_descriptor, "wb", closefd=True)
            destination_descriptor = -1
            with output:
                value.to_parquet(output, engine="pyarrow", index=False)
                output.flush()
                os.fsync(output.fileno())

            _recheck_source(source_path, source_stream, expected_source_fingerprint)
    finally:
        if source_descriptor >= 0:
            os.close(source_descriptor)
        if destination_descriptor >= 0:
            os.close(destination_descriptor)

    if _regular_file_identity(destination_path) != destination_identity:
        raise RuntimeError("The Parquet destination changed during conversion.")


def main(arguments: Sequence[str] | None = None) -> int:
    values = list(sys.argv[1:] if arguments is None else arguments)
    if len(values) != 7:
        print(INVALID_INVOCATION_MESSAGE, file=sys.stderr)
        return EXIT_INVALID_INVOCATION

    try:
        expected_source_fingerprint = SourceFingerprint(*(int(value, 10) for value in values[2:]))
    except (TypeError, ValueError):
        print(INVALID_INVOCATION_MESSAGE, file=sys.stderr)
        return EXIT_INVALID_INVOCATION

    try:
        _ensure_windows_descendant_containment()
        _enable_selected_environment_packages()
        convert_trusted_pickle_to_parquet(values[0], values[1], expected_source_fingerprint)
    except NonDataFramePickleError:
        print(NON_DATAFRAME_MESSAGE, file=sys.stderr)
        return EXIT_NON_DATAFRAME
    except BaseException:
        print(CONVERSION_FAILED_MESSAGE, file=sys.stderr)
        return EXIT_CONVERSION_FAILED
    return 0


def _ensure_windows_descendant_containment() -> None:
    global _WINDOWS_JOB_HANDLE

    if sys.platform != "win32" or _WINDOWS_JOB_HANDLE is not None:
        return

    import ctypes
    from ctypes import wintypes

    class JobObjectBasicLimitInformation(ctypes.Structure):
        _fields_ = [
            ("per_process_user_time_limit", ctypes.c_longlong),
            ("per_job_user_time_limit", ctypes.c_longlong),
            ("limit_flags", wintypes.DWORD),
            ("minimum_working_set_size", ctypes.c_size_t),
            ("maximum_working_set_size", ctypes.c_size_t),
            ("active_process_limit", wintypes.DWORD),
            ("affinity", ctypes.c_size_t),
            ("priority_class", wintypes.DWORD),
            ("scheduling_class", wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [
            ("read_operation_count", ctypes.c_ulonglong),
            ("write_operation_count", ctypes.c_ulonglong),
            ("other_operation_count", ctypes.c_ulonglong),
            ("read_transfer_count", ctypes.c_ulonglong),
            ("write_transfer_count", ctypes.c_ulonglong),
            ("other_transfer_count", ctypes.c_ulonglong),
        ]

    class JobObjectExtendedLimitInformation(ctypes.Structure):
        _fields_ = [
            ("basic_limit_information", JobObjectBasicLimitInformation),
            ("io_info", IoCounters),
            ("process_memory_limit", ctypes.c_size_t),
            ("job_memory_limit", ctypes.c_size_t),
            ("peak_process_memory_used", ctypes.c_size_t),
            ("peak_job_memory_used", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.GetCurrentProcess.argtypes = []
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    job_handle = kernel32.CreateJobObjectW(None, None)
    if not job_handle:
        raise ctypes.WinError(ctypes.get_last_error())

    try:
        information = JobObjectExtendedLimitInformation()
        information.basic_limit_information.limit_flags = 0x00002000
        if not kernel32.SetInformationJobObject(
            job_handle,
            9,
            ctypes.byref(information),
            ctypes.sizeof(information),
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel32.AssignProcessToJobObject(job_handle, kernel32.GetCurrentProcess()):
            raise ctypes.WinError(ctypes.get_last_error())
    except BaseException:
        kernel32.CloseHandle(job_handle)
        raise

    _WINDOWS_JOB_HANDLE = int(job_handle)


def _enable_selected_environment_packages() -> None:
    """Load site packages only after Windows descendant containment is active."""

    if not sys.flags.no_site:
        return
    import site

    site.main()


def _regular_file_identity(path: Path) -> tuple[int, int]:
    details = path.lstat()
    if not stat.S_ISREG(details.st_mode) or stat.S_ISLNK(details.st_mode):
        raise ValueError("Trusted-pickle conversion accepts regular files only.")
    identity = (details.st_dev, details.st_ino)
    if identity == (0, 0):
        raise ValueError("The filesystem did not provide a usable file identity.")
    return identity


def _source_fingerprint(details: os.stat_result, descriptor: int | None = None) -> SourceFingerprint:
    changed_time_ns = (
        _windows_change_time_ns(descriptor)
        if sys.platform == "win32" and descriptor is not None
        else details.st_ctime_ns
    )
    return SourceFingerprint(
        details.st_dev,
        details.st_ino,
        details.st_size,
        details.st_mtime_ns,
        changed_time_ns,
    )


def _source_fingerprint_matches(actual: SourceFingerprint, expected: SourceFingerprint) -> bool:
    return actual == expected


def _windows_change_time_ns(descriptor: int) -> int:
    if sys.platform != "win32":
        raise RuntimeError("Windows file change time is available only on Windows.")

    import ctypes
    import msvcrt
    from ctypes import wintypes

    class FileBasicInfo(ctypes.Structure):
        _fields_ = [
            ("creation_time", ctypes.c_longlong),
            ("last_access_time", ctypes.c_longlong),
            ("last_write_time", ctypes.c_longlong),
            ("change_time", ctypes.c_longlong),
            ("file_attributes", wintypes.DWORD),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetFileInformationByHandleEx.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    kernel32.GetFileInformationByHandleEx.restype = wintypes.BOOL
    information = FileBasicInfo()
    handle = wintypes.HANDLE(msvcrt.get_osfhandle(descriptor))
    if not kernel32.GetFileInformationByHandleEx(
        handle,
        0,
        ctypes.byref(information),
        ctypes.sizeof(information),
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    windows_to_unix_epoch_ticks = 116_444_736_000_000_000
    return (information.change_time - windows_to_unix_epoch_ticks) * 100


def _confirmed_source_path_fingerprint(path: Path) -> SourceFingerprint:
    details = path.lstat()
    if not stat.S_ISREG(details.st_mode) or stat.S_ISLNK(details.st_mode):
        raise ValueError("Trusted-pickle conversion accepts regular files only.")
    if sys.platform == "win32":
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOINHERIT", 0)
        descriptor = os.open(path, flags)
        try:
            descriptor_details = os.fstat(descriptor)
            current_path_details = path.lstat()
            if (
                not stat.S_ISREG(descriptor_details.st_mode)
                or not stat.S_ISREG(current_path_details.st_mode)
                or stat.S_ISLNK(current_path_details.st_mode)
                or (descriptor_details.st_dev, descriptor_details.st_ino)
                != (current_path_details.st_dev, current_path_details.st_ino)
            ):
                raise ValueError("Trusted-pickle conversion accepts regular files only.")
            fingerprint = _source_fingerprint(descriptor_details, descriptor)
        finally:
            os.close(descriptor)
    else:
        fingerprint = _source_fingerprint(details)
    if fingerprint[:2] == (0, 0):
        raise ValueError("The filesystem did not provide a usable file identity.")
    return fingerprint


def _open_confirmed_source(path: Path, expected_fingerprint: SourceFingerprint) -> int:
    if not _source_fingerprint_matches(_confirmed_source_path_fingerprint(path), expected_fingerprint):
        raise RuntimeError("The trusted pickle source changed before conversion.")

    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or not _source_fingerprint_matches(
            _source_fingerprint(details, descriptor), expected_fingerprint
        ):
            raise RuntimeError("The trusted pickle source changed before conversion.")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _recheck_source(path: Path, source_stream: BinaryIO, expected_fingerprint: SourceFingerprint) -> None:
    descriptor_details = os.fstat(source_stream.fileno())
    if (
        not stat.S_ISREG(descriptor_details.st_mode)
        or not _source_fingerprint_matches(
            _source_fingerprint(descriptor_details, source_stream.fileno()), expected_fingerprint
        )
        or not _source_fingerprint_matches(_confirmed_source_path_fingerprint(path), expected_fingerprint)
    ):
        raise RuntimeError("The trusted pickle source changed during conversion.")


def _open_reserved_destination(path: Path, expected_identity: tuple[int, int]) -> int:
    flags = os.O_WRONLY | getattr(os, "O_BINARY", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or (details.st_dev, details.st_ino) != expected_identity:
            raise RuntimeError("The Parquet destination changed during conversion.")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
