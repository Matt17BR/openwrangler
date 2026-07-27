from __future__ import annotations

import ctypes
import os
import re
import stat
import sys


TOKEN_PATH = "/run/openwrangler/token"
TOKEN_PENDING_PATH = "/run/openwrangler/token.pending"
TOKEN_DIRECTORY = "/run/openwrangler"
TOKEN_LIMIT = 43
TOKEN_PATTERN = re.compile(rb"owr_[A-Za-z0-9_-]{39}")
AT_FDCWD = -100
RENAME_NOREPLACE = 1


def publish_no_replace(source: str, destination: str) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = libc.renameat2
    renameat2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameat2.restype = ctypes.c_int
    result = renameat2(
        AT_FDCWD,
        os.fsencode(source),
        AT_FDCWD,
        os.fsencode(destination),
        RENAME_NOREPLACE,
    )
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), destination)


def main() -> None:
    token = sys.stdin.buffer.read(TOKEN_LIMIT + 1)
    if not TOKEN_PATTERN.fullmatch(token):
        raise RuntimeError("Remote Jupyter authentication input is invalid.")

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(TOKEN_PENDING_PATH, flags, stat.S_IRUSR)
    owned_identity: tuple[int, int] | None = None
    published = False
    try:
        view = memoryview(token)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise RuntimeError("Remote Jupyter authentication input could not be written.")
            view = view[written:]
        os.fsync(descriptor)
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or stat.S_IMODE(metadata.st_mode) != stat.S_IRUSR
            or metadata.st_uid != os.getuid()
            or metadata.st_gid != os.getgid()
            or metadata.st_size != len(token)
        ):
            raise RuntimeError("Remote Jupyter authentication input lost its private file identity.")
        owned_identity = (metadata.st_dev, metadata.st_ino)
    finally:
        os.close(descriptor)
    try:
        publish_no_replace(TOKEN_PENDING_PATH, TOKEN_PATH)
        published = True
        directory_flags = os.O_RDONLY | os.O_DIRECTORY
        if hasattr(os, "O_NOFOLLOW"):
            directory_flags |= os.O_NOFOLLOW
        directory_descriptor = os.open(TOKEN_DIRECTORY, directory_flags)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        if not published:
            try:
                pending = os.lstat(TOKEN_PENDING_PATH)
                if (
                    owned_identity is not None
                    and (pending.st_dev, pending.st_ino) == owned_identity
                    and stat.S_ISREG(pending.st_mode)
                    and pending.st_nlink == 1
                    and stat.S_IMODE(pending.st_mode) == stat.S_IRUSR
                    and pending.st_uid == os.getuid()
                    and pending.st_gid == os.getgid()
                ):
                    os.unlink(TOKEN_PENDING_PATH)
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    main()
