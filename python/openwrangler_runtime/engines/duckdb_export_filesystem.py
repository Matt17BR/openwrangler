from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, BinaryIO, ClassVar, Literal, NoReturn, cast
from uuid import uuid4

from fsspec import AbstractFileSystem

from ..error_causality import add_exception_note


class DuckDBExportFileSystemError(RuntimeError):
    """Raised when DuckDB exceeds its one-shot exact-writer capability."""


class _NonClosingBinaryWriter:
    def __init__(self, writer: BinaryIO) -> None:
        self._writer: BinaryIO | None = writer
        self._closed = False

    @property
    def closed(self) -> bool:
        return self._closed

    def writable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def write(self, data: bytes | bytearray | memoryview) -> int:
        writer = self._require_writer()
        written = writer.write(data)
        if written != len(data):
            raise OSError("DuckDB did not write the complete native export block.")
        return written

    def flush(self) -> None:
        self._require_writer().flush()

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        return self._require_writer().seek(offset, whence)

    def tell(self) -> int:
        return self._require_writer().tell()

    def truncate(self, size: int | None = None) -> int:
        return self._require_writer().truncate(size)

    def close(self) -> None:
        if self._closed:
            return
        writer = self._require_writer()
        writer.flush()
        self._writer = None
        self._closed = True

    def _require_writer(self) -> BinaryIO:
        if self._closed or self._writer is None:
            raise ValueError("I/O operation on closed DuckDB export writer")
        return self._writer


class _OneShotDuckDBWriterFileSystem(AbstractFileSystem):
    """Expose one already-open writer without granting pathname capabilities."""

    cachable = False
    root_marker = ""
    protocol: ClassVar[str | tuple[str, ...]] = "openwranglerexport-unregistered"

    def __init__(self, writer: BinaryIO, format_name: Literal["csv", "parquet"]) -> None:
        self._token = f"{uuid4().hex}.{format_name}"
        self._uri = f"{self.protocol_name}://{self._token}"
        self._writer: BinaryIO | None = writer
        self._info_calls = 0
        self._opened = False
        self._proxy: _NonClosingBinaryWriter | None = None
        super().__init__(skip_instance_cache=True)

    @property
    def uri(self) -> str:
        return self._uri

    @property
    def protocol_name(self) -> str:
        return cast(str, self.protocol)

    @classmethod
    def request_owned(cls, writer: BinaryIO, format_name: Literal["csv", "parquet"]) -> _OneShotDuckDBWriterFileSystem:
        protocol = f"openwranglerexport{uuid4().hex}"
        request_type = type(f"RequestOwned{cls.__name__}", (cls,), {"protocol": protocol})
        return request_type(writer, format_name)

    @classmethod
    def _strip_protocol(cls, path: str) -> str:
        prefix = f"{cast(str, cls.protocol)}://"
        return path[len(prefix) :] if path.startswith(prefix) else path

    def info(self, path: str, **kwargs: Any) -> dict[str, Any]:
        if kwargs or path != self._uri or self._info_calls >= 2:
            raise DuckDBExportFileSystemError("DuckDB requested an invalid export target capability.")
        self._info_calls += 1
        return {"name": self._token, "size": 0, "type": "file"}

    def _open(
        self,
        path: str,
        mode: str = "rb",
        block_size: int | None = None,
        autocommit: bool = True,
        cache_options: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> Any:
        if (
            path != self._token
            or mode != "wb"
            or self._opened
            or self._writer is None
            or kwargs
            or autocommit is not True
            or block_size is not None
            or cache_options is not None
        ):
            raise DuckDBExportFileSystemError("DuckDB requested an invalid export writer capability.")
        writer = self._writer
        self._writer = None
        self._opened = True
        self._proxy = _NonClosingBinaryWriter(writer)
        return self._proxy

    def assert_completed(self) -> None:
        if self._info_calls != 2 or not self._opened or self._proxy is None or not self._proxy.closed:
            raise DuckDBExportFileSystemError("DuckDB did not complete its one-shot native export write.")
        self._proxy = None

    def ls(self, path: str, detail: bool = True, **kwargs: Any) -> list[Any]:
        del path, detail, kwargs
        self._reject_operation()

    def exists(self, path: str, **kwargs: Any) -> bool:
        del path, kwargs
        self._reject_operation()

    def find(
        self, path: str, maxdepth: int | None = None, withdirs: bool = False, detail: bool = False, **kwargs: Any
    ) -> Any:
        del path, maxdepth, withdirs, detail, kwargs
        self._reject_operation()

    def glob(self, path: str, maxdepth: int | None = None, **kwargs: Any) -> Any:
        del path, maxdepth, kwargs
        self._reject_operation()

    def walk(
        self, path: str, maxdepth: int | None = None, topdown: bool = True, on_error: str = "omit", **kwargs: Any
    ) -> Any:
        del path, maxdepth, topdown, on_error, kwargs
        self._reject_operation()

    def _rm(self, path: str) -> None:
        del path
        self._reject_operation()

    def rm(self, path: str | list[str], recursive: bool = False, maxdepth: int | None = None) -> None:
        del path, recursive, maxdepth
        self._reject_operation()

    def rmdir(self, path: str) -> None:
        del path
        self._reject_operation()

    def mkdir(self, path: str, create_parents: bool = True, **kwargs: Any) -> None:
        del path, create_parents, kwargs
        self._reject_operation()

    def makedirs(self, path: str, exist_ok: bool = False) -> None:
        del path, exist_ok
        self._reject_operation()

    def mv(self, path1: str, path2: str, recursive: bool = False, maxdepth: int | None = None, **kwargs: Any) -> None:
        del path1, path2, recursive, maxdepth, kwargs
        self._reject_operation()

    def rename(self, path1: str, path2: str, **kwargs: Any) -> None:
        del path1, path2, kwargs
        self._reject_operation()

    def cp_file(self, path1: str, path2: str, **kwargs: Any) -> None:
        del path1, path2, kwargs
        self._reject_operation()

    def copy(
        self,
        path1: str,
        path2: str,
        recursive: bool = False,
        maxdepth: int | None = None,
        on_error: str | None = None,
        **kwargs: Any,
    ) -> None:
        del path1, path2, recursive, maxdepth, on_error, kwargs
        self._reject_operation()

    def get(
        self,
        rpath: str,
        lpath: str,
        recursive: bool = False,
        callback: Any = None,
        maxdepth: int | None = None,
        **kwargs: Any,
    ) -> None:
        del rpath, lpath, recursive, callback, maxdepth, kwargs
        self._reject_operation()

    def get_file(
        self,
        rpath: str,
        lpath: str,
        callback: Any = None,
        outfile: Any = None,
        **kwargs: Any,
    ) -> None:
        del rpath, lpath, callback, outfile, kwargs
        self._reject_operation()

    def put(
        self,
        lpath: str,
        rpath: str,
        recursive: bool = False,
        callback: Any = None,
        maxdepth: int | None = None,
        **kwargs: Any,
    ) -> None:
        del lpath, rpath, recursive, callback, maxdepth, kwargs
        self._reject_operation()

    def put_file(
        self,
        lpath: str,
        rpath: str,
        callback: Any = None,
        mode: str = "overwrite",
        **kwargs: Any,
    ) -> None:
        del lpath, rpath, callback, mode, kwargs
        self._reject_operation()

    def touch(self, path: str, truncate: bool = True, **kwargs: Any) -> None:
        del path, truncate, kwargs
        self._reject_operation()

    def pipe_file(self, path: str, value: bytes, mode: str = "overwrite", **kwargs: Any) -> None:
        del path, value, mode, kwargs
        self._reject_operation()

    def cat_file(self, path: str, start: int | None = None, end: int | None = None, **kwargs: Any) -> bytes:
        del path, start, end, kwargs
        self._reject_operation()

    def cat(self, path: str, recursive: bool = False, on_error: str = "raise", **kwargs: Any) -> Any:
        del path, recursive, on_error, kwargs
        self._reject_operation()

    @staticmethod
    def _reject_operation() -> NoReturn:
        raise DuckDBExportFileSystemError("DuckDB export filesystem operations are disabled.")


@contextmanager
def registered_duckdb_export_writer(
    connection: Any,
    writer: BinaryIO,
    format_name: Literal["csv", "parquet"],
) -> Iterator[str]:
    filesystem = _OneShotDuckDBWriterFileSystem.request_owned(writer, format_name)
    registered = False
    try:
        if filesystem.protocol_name in connection.list_filesystems():
            raise DuckDBExportFileSystemError("DuckDB export filesystem protocol was already registered.")
        connection.register_filesystem(filesystem)
        registered = True
        yield filesystem.uri
        filesystem.assert_completed()
    except BaseException as error:
        if registered:
            try:
                connection.unregister_filesystem(filesystem.protocol_name)
            except BaseException as cleanup_error:
                _raise_with_cleanup(error, cleanup_error)
        raise
    else:
        connection.unregister_filesystem(filesystem.protocol_name)


def _raise_with_cleanup(error: BaseException, cleanup_error: BaseException) -> None:
    if error.__cause__ is None:
        raise error from cleanup_error
    detail = f"{type(cleanup_error).__name__}: {cleanup_error}"
    add_exception_note(error, f"DuckDB export filesystem cleanup also failed: {detail[:448]}")
    raise error
