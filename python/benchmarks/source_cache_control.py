"""Prove source page-cache preparation for installed-editor benchmarks."""

from __future__ import annotations

import argparse
import ctypes
import json
import mmap
import os
import stat
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Literal, TypedDict

READ_BLOCK_BYTES = 1024 * 1024
PROOF_PROTOCOL = "openwrangler-source-cache-proof-v1"
_MAP_PRIVATE = 0x02
_PROT_NONE = 0x0


class CacheControlResult(TypedDict):
    protocol: str
    requestedState: Literal["evicted", "resident"]
    fdatasyncApplied: bool
    adviceAccepted: bool
    verification: Literal["linux-mincore", "unavailable"]
    pageSizeBytes: int
    totalPages: int
    residentPagesBefore: int | None
    residentPagesAfter: int | None
    identityStable: bool
    verified: bool


def prepare_source_cache(source: Path, mode: str) -> CacheControlResult:
    """Prepare one regular single-link source and return path-free proof."""

    if mode not in {"cold", "warm"}:
        raise ValueError("Source-cache mode must be cold or warm.")

    metadata = source.lstat()
    _require_regular_single_link(metadata)
    if metadata.st_size <= 0:
        raise ValueError("Source-cache preparation requires a non-empty file.")

    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(source, flags)
    try:
        opened = os.fstat(descriptor)
        _require_regular_single_link(opened)
        if not _same_identity(opened, metadata):
            raise ValueError("The source changed identity during cache preparation.")

        page_size = _page_size_bytes()
        total_pages = (opened.st_size + page_size - 1) // page_size
        requested_state: Literal["evicted", "resident"] = "evicted" if mode == "cold" else "resident"

        if not _linux_cache_proof_available():
            identity_stable = _source_identity_stable(source, descriptor, opened)
            if not identity_stable:
                raise ValueError("The source changed identity during cache preparation.")
            return {
                "protocol": PROOF_PROTOCOL,
                "requestedState": requested_state,
                "fdatasyncApplied": False,
                "adviceAccepted": False,
                "verification": "unavailable",
                "pageSizeBytes": page_size,
                "totalPages": total_pages,
                "residentPagesBefore": None,
                "residentPagesAfter": None,
                "identityStable": True,
                "verified": False,
            }

        _sync_file_data(descriptor)
        resident_before = _resident_page_count(descriptor, opened.st_size, total_pages)
        advice_accepted = False
        if mode == "cold":
            _advise_dont_need(descriptor)
            advice_accepted = True
        else:
            total = 0
            while True:
                block = os.read(descriptor, READ_BLOCK_BYTES)
                if not block:
                    break
                total += len(block)
            if total != opened.st_size:
                raise OSError("Warm-cache preparation did not read the complete source.")
        resident_after = _resident_page_count(descriptor, opened.st_size, total_pages)
        identity_stable = _source_identity_stable(source, descriptor, opened)
        if not identity_stable:
            raise ValueError("The source changed identity during cache preparation.")
        verified = resident_after == (0 if mode == "cold" else total_pages)
        return {
            "protocol": PROOF_PROTOCOL,
            "requestedState": requested_state,
            "fdatasyncApplied": True,
            "adviceAccepted": advice_accepted,
            "verification": "linux-mincore",
            "pageSizeBytes": page_size,
            "totalPages": total_pages,
            "residentPagesBefore": resident_before,
            "residentPagesAfter": resident_after,
            "identityStable": True,
            "verified": verified,
        }
    finally:
        os.close(descriptor)


def _linux_cache_proof_available() -> bool:
    return (
        sys.platform == "linux"
        and callable(getattr(os, "fdatasync", None))
        and callable(getattr(os, "posix_fadvise", None))
        and isinstance(getattr(os, "POSIX_FADV_DONTNEED", None), int)
    )


def _page_size_bytes() -> int:
    page_size = mmap.PAGESIZE
    if not isinstance(page_size, int) or page_size <= 0:
        raise OSError("The host reported an invalid page size.")
    return page_size


def _sync_file_data(descriptor: int) -> None:
    fdatasync = getattr(os, "fdatasync", None)
    if not callable(fdatasync):
        raise OSError("fdatasync is unavailable on this platform.")
    fdatasync(descriptor)


def _advise_dont_need(descriptor: int) -> None:
    posix_fadvise = getattr(os, "posix_fadvise", None)
    dont_need = getattr(os, "POSIX_FADV_DONTNEED", None)
    if not callable(posix_fadvise) or not isinstance(dont_need, int):
        raise OSError("POSIX_FADV_DONTNEED is unavailable on this platform.")
    posix_fadvise(descriptor, 0, 0, dont_need)


def _resident_page_count(descriptor: int, size: int, total_pages: int) -> int:
    libc = ctypes.CDLL(None, use_errno=True)
    mmap_function = libc.mmap
    mmap_function.argtypes = [
        ctypes.c_void_p,
        ctypes.c_size_t,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_longlong,
    ]
    mmap_function.restype = ctypes.c_void_p
    mincore_function = libc.mincore
    mincore_function.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_ubyte)]
    mincore_function.restype = ctypes.c_int
    munmap_function = libc.munmap
    munmap_function.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
    munmap_function.restype = ctypes.c_int

    address = mmap_function(None, size, _PROT_NONE, _MAP_PRIVATE, descriptor, 0)
    failed_address = ctypes.c_void_p(-1).value
    if address is None or address == failed_address:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))
    vector = (ctypes.c_ubyte * total_pages)()
    try:
        if mincore_function(ctypes.c_void_p(address), size, vector) != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number))
        return sum(1 for value in vector if value & 1)
    finally:
        if munmap_function(ctypes.c_void_p(address), size) != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number))


def _source_identity_stable(source: Path, descriptor: int, expected: os.stat_result) -> bool:
    return _same_identity(os.fstat(descriptor), expected) and _same_identity(source.lstat(), expected)


def _same_identity(current: os.stat_result, expected: os.stat_result) -> bool:
    return (
        stat.S_ISREG(current.st_mode)
        and current.st_nlink == 1
        and current.st_dev == expected.st_dev
        and current.st_ino == expected.st_ino
        and current.st_size == expected.st_size
        and current.st_mtime_ns == expected.st_mtime_ns
    )


def _require_regular_single_link(metadata: os.stat_result) -> None:
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError("Source-cache preparation requires a single-link regular file.")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--mode", choices=["cold", "warm"])
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    if arguments.source is None or arguments.mode is None:
        raise ValueError("Source-cache preparation requires --source and --mode.")
    result = prepare_source_cache(arguments.source, arguments.mode)
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
