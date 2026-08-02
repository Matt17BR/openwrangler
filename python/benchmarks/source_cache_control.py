"""Prove source page-cache preparation for installed-editor benchmarks."""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import mmap
import os
import platform
import stat
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Literal, TypedDict

READ_BLOCK_BYTES = 1024 * 1024
PROOF_PROTOCOL = "openwrangler-source-cache-proof-v1"
STUDY_V2_PROOF_PROTOCOL = "openwrangler-source-cache-proof-study-v2"
MAXIMUM_AUTHORITY_BYTES = 256 * 1024 * 1024
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


class FilesystemIdentity(TypedDict):
    device: str
    inode: str
    sizeBytes: int
    mtimeNs: str


class ImmutableFileReceipt(TypedDict):
    sha256: str
    filesystemIdentity: FilesystemIdentity


class RunningInterpreterReceipt(ImmutableFileReceipt):
    implementation: str
    version: str


class StudyV2CacheControlResult(CacheControlResult):
    sourceFilesystemIdentityBefore: FilesystemIdentity
    sourceFilesystemIdentityAfter: FilesystemIdentity
    controller: ImmutableFileReceipt
    pythonExecutable: RunningInterpreterReceipt


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


def prepare_study_v2_source_cache(source: Path, mode: str, controller_fd: int) -> StudyV2CacheControlResult:
    """Prepare one study-private copy and bind proof to the running toolchain."""

    if mode not in {"cold", "warm"}:
        raise ValueError("Source-cache mode must be cold or warm.")
    if not _linux_cache_proof_available():
        raise OSError("The study-v2 source-cache contract requires Linux mincore and fadvise support.")

    controller_before = _controller_descriptor_receipt(controller_fd)
    interpreter_before = _running_interpreter_receipt()
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
        source_before = _filesystem_identity(opened)

        page_size = _page_size_bytes()
        total_pages = (opened.st_size + page_size - 1) // page_size
        requested_state: Literal["evicted", "resident"] = "evicted" if mode == "cold" else "resident"
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
        if not _source_identity_stable(source, descriptor, opened):
            raise ValueError("The source changed identity during cache preparation.")
        source_after = _filesystem_identity(os.fstat(descriptor))
        verified = resident_after == (0 if mode == "cold" else total_pages)
    finally:
        os.close(descriptor)

    controller_after = _controller_descriptor_receipt(controller_fd)
    interpreter_after = _running_interpreter_receipt()
    if controller_after != controller_before:
        raise ValueError("The source-cache controller changed while study-v2 proof was collected.")
    if interpreter_after != interpreter_before:
        raise ValueError("The running Python executable changed while study-v2 proof was collected.")

    return {
        "protocol": STUDY_V2_PROOF_PROTOCOL,
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
        "sourceFilesystemIdentityBefore": source_before,
        "sourceFilesystemIdentityAfter": source_after,
        "controller": controller_before,
        "pythonExecutable": interpreter_before,
    }


def _filesystem_identity(metadata: os.stat_result) -> FilesystemIdentity:
    return {
        "device": str(metadata.st_dev),
        "inode": str(metadata.st_ino),
        "sizeBytes": metadata.st_size,
        "mtimeNs": str(metadata.st_mtime_ns),
    }


def _hash_descriptor(descriptor: int, size: int) -> str:
    digest = hashlib.sha256()
    position = 0
    while position < size:
        block = os.pread(descriptor, min(READ_BLOCK_BYTES, size - position), position)
        if not block:
            raise OSError("An authority file ended before its pinned byte size.")
        digest.update(block)
        position += len(block)
    if os.pread(descriptor, 1, position):
        raise OSError("An authority file exceeded its pinned byte size.")
    return digest.hexdigest()


def _immutable_file_receipt(path: Path, *, proc_magic_link: bool = False) -> ImmutableFileReceipt:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW") and not proc_magic_link:
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            raise ValueError("Study-v2 authority must be one single-link regular file.")
        if opened.st_size <= 0 or opened.st_size > MAXIMUM_AUTHORITY_BYTES:
            raise ValueError("Study-v2 authority exceeds its fixed byte bound.")
        named = path.stat() if proc_magic_link else path.lstat()
        if not _same_identity(opened, named):
            raise ValueError("Study-v2 authority changed before it could be opened.")
        receipt: ImmutableFileReceipt = {
            "sha256": _hash_descriptor(descriptor, opened.st_size),
            "filesystemIdentity": _filesystem_identity(opened),
        }
        completed = os.fstat(descriptor)
        named_after = path.stat() if proc_magic_link else path.lstat()
        if not _same_identity(opened, completed) or not _same_identity(opened, named_after):
            raise ValueError("Study-v2 authority changed while it was hashed.")
        return receipt
    finally:
        os.close(descriptor)


def _controller_descriptor_receipt(descriptor: int) -> ImmutableFileReceipt:
    if not isinstance(descriptor, int) or isinstance(descriptor, bool) or descriptor < 3:
        raise ValueError("The study-v2 controller descriptor must be one inherited descriptor at or above fd 3.")
    opened = os.fstat(descriptor)
    if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
        raise ValueError("The study-v2 controller descriptor must name one single-link regular file.")
    if opened.st_size <= 0 or opened.st_size > MAXIMUM_AUTHORITY_BYTES:
        raise ValueError("The study-v2 controller descriptor exceeds its fixed byte bound.")
    named = Path(__file__).lstat()
    if not _same_identity(opened, named):
        raise ValueError("The inherited controller descriptor does not match the running controller source.")
    receipt: ImmutableFileReceipt = {
        "sha256": _hash_descriptor(descriptor, opened.st_size),
        "filesystemIdentity": _filesystem_identity(opened),
    }
    completed = os.fstat(descriptor)
    named_after = Path(__file__).lstat()
    if not _same_identity(opened, completed) or not _same_identity(opened, named_after):
        raise ValueError("The inherited controller descriptor changed while it was hashed.")
    return receipt


def _running_interpreter_receipt() -> RunningInterpreterReceipt:
    if sys.platform != "linux":
        raise OSError("The study-v2 running-interpreter receipt requires Linux procfs.")
    receipt = _immutable_file_receipt(Path("/proc/self/exe"), proc_magic_link=True)
    return {
        "implementation": platform.python_implementation(),
        "version": platform.python_version(),
        **receipt,
    }


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
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--mode", choices=["cold", "warm"], required=True)
    parser.add_argument("--contract", choices=["v1", "study-v2"], default="v1")
    parser.add_argument("--controller-fd", type=int)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    if arguments.contract == "study-v2" and arguments.controller_fd is None:
        raise ValueError("The study-v2 source-cache contract requires --controller-fd.")
    if arguments.contract == "v1" and arguments.controller_fd is not None:
        raise ValueError("The v1 source-cache contract does not accept --controller-fd.")
    result = (
        prepare_study_v2_source_cache(arguments.source, arguments.mode, arguments.controller_fd)
        if arguments.contract == "study-v2"
        else prepare_source_cache(arguments.source, arguments.mode)
    )
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
