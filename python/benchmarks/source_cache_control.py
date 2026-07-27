"""Apply and report deterministic source-cache preparation for editor benchmarks."""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import TypedDict

READ_BLOCK_BYTES = 1024 * 1024


class CacheControlResult(TypedDict):
    supported: bool
    applied: bool
    method: str


def prepare_source_cache(source: Path, mode: str) -> CacheControlResult:
    """Prepare one regular single-link source without returning its private path."""

    if mode not in {"cold", "warm"}:
        raise ValueError("Source-cache mode must be cold or warm.")

    metadata = source.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError("Source-cache preparation requires a single-link regular file.")

    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(source, flags)
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or opened.st_dev != metadata.st_dev
            or opened.st_ino != metadata.st_ino
        ):
            raise ValueError("The source changed identity during cache preparation.")

        if mode == "warm":
            total = 0
            while True:
                block = os.read(descriptor, READ_BLOCK_BYTES)
                if not block:
                    break
                total += len(block)
            if total != opened.st_size:
                raise OSError("Warm-cache preparation did not read the complete source.")
            return {
                "supported": True,
                "applied": True,
                "method": "complete sequential read through an owned descriptor",
            }

        if sys.platform != "linux" or not hasattr(os, "posix_fadvise") or not hasattr(os, "POSIX_FADV_DONTNEED"):
            return {
                "supported": False,
                "applied": False,
                "method": "POSIX_FADV_DONTNEED unavailable on this host",
            }
        os.posix_fadvise(descriptor, 0, 0, os.POSIX_FADV_DONTNEED)
        return {
            "supported": True,
            "applied": True,
            "method": "POSIX_FADV_DONTNEED on an owned descriptor",
        }
    finally:
        os.close(descriptor)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--mode", choices=["cold", "warm"], required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    result = prepare_source_cache(arguments.source, arguments.mode)
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
