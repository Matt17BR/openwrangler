from __future__ import annotations

import importlib
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .engines import DataFrameEngine, EngineError
from .trusted_pickle_to_parquet import _confirmed_source_path_fingerprint


class SourceChangedError(EngineError):
    """Recoverable source invalidation that must invalidate session caches."""


class LiveSourceInvalidatedError(SourceChangedError):
    """Raised when an exact live notebook source can no longer serve reads."""

    def __init__(self, session_id: str, message: str) -> None:
        self.session_id = session_id
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class _SourceFingerprint:
    requested_path: str
    resolved_path: str
    device: int
    inode: int
    size: int
    modified_ns: int
    changed_ns: int


@dataclass(slots=True)
class SessionSource:
    """Own the exact source version bound to one live runtime session."""

    session_id: str
    metadata: dict[str, Any]
    _fingerprint: _SourceFingerprint | None
    _live_value: Any | None = None

    @classmethod
    def capture(
        cls,
        session_id: str,
        source: Mapping[str, Any],
        engine: DataFrameEngine,
    ) -> SessionSource:
        metadata = dict(source)
        return cls(session_id, metadata, cls._capture_fingerprint(metadata, engine))

    def clone_for(self, session_id: str) -> SessionSource:
        return SessionSource(session_id, dict(self.metadata), self._fingerprint, self._live_value)

    @property
    def kind(self) -> str:
        return str(self.metadata.get("kind", ""))

    @property
    def resolved_metadata(self) -> dict[str, Any]:
        resolved = dict(self.metadata)
        if self._fingerprint is not None:
            resolved["path"] = self._fingerprint.resolved_path
        return resolved

    def bind_loaded_value(self, engine: DataFrameEngine, value: Any) -> None:
        if engine.name == "pyspark" and self.kind == "notebookVariable":
            self._live_value = value

    def validate(self, engine: DataFrameEngine) -> None:
        self.validate_live(engine)
        expected = self._fingerprint
        if expected is None:
            return
        try:
            current = self._fingerprint_path(expected.requested_path)
        except (OSError, ValueError) as error:
            raise self._changed_error() from error
        if current != expected:
            raise self._changed_error()

    @contextmanager
    def validated_read(self, engine: DataFrameEngine) -> Iterator[None]:
        self.validate(engine)
        try:
            yield
        except BaseException as error:
            try:
                self.validate(engine)
            except EngineError as source_error:
                raise source_error from error
            raise
        else:
            self.validate(engine)

    def release(self) -> None:
        self._live_value = None

    def matches_public_source(self, source: Mapping[str, Any]) -> bool:
        return dict(source) == self.metadata

    def is_same_path(self, path: str) -> bool:
        source_path = self.metadata.get("path")
        return bool(source_path) and Path(path).absolute() == Path(str(source_path)).absolute()

    def matches_file_identity(self, device: int, inode: int) -> bool:
        fingerprint = self._fingerprint
        return fingerprint is not None and (device, inode) == (fingerprint.device, fingerprint.inode)

    def validate_live(self, engine: DataFrameEngine) -> None:
        expected = self._live_value
        if engine.name != "pyspark" or expected is None:
            return

        try:
            current = resolve_notebook_variable(self.metadata)
        except EngineError as error:
            raise self._live_invalidated_error("is no longer available in the notebook kernel") from error
        if current is not expected:
            raise self._live_invalidated_error("was replaced in the notebook kernel")

        stopped_probe = getattr(engine, "live_source_is_stopped", None)
        if callable(stopped_probe) and stopped_probe(expected) is True:
            raise self._live_invalidated_error("belongs to a Spark session that has stopped")

    def _live_invalidated_error(self, reason: str) -> LiveSourceInvalidatedError:
        label = self.metadata.get("label") or self.metadata.get("variableName") or "PySpark dataframe"
        return LiveSourceInvalidatedError(
            self.session_id,
            f"The live PySpark dataframe {label!r} {reason}. "
            "Recreate it or run the cell that defines it, then retry in Open Wrangler. "
            "If its columns or types changed, reopen the variable instead.",
        )

    def _changed_error(self) -> SourceChangedError:
        label = self.metadata.get("label") or self.metadata.get("path") or "source file"
        return SourceChangedError(
            f"The source file for {label} changed or is no longer available. Reopen the file to refresh this session."
        )

    @classmethod
    def _capture_fingerprint(
        cls,
        source: Mapping[str, Any],
        engine: DataFrameEngine,
    ) -> _SourceFingerprint | None:
        if source.get("kind") != "file":
            return None
        path = source.get("path")
        if not path:
            return None
        if Path(str(path)).suffix.lower() not in engine.capabilities.lazy_file_extensions:
            return None
        try:
            return cls._fingerprint_path(str(path))
        except (OSError, ValueError) as error:
            label = source.get("label") or path
            raise EngineError(f"Could not read {label}: {error}") from error

    @staticmethod
    def _fingerprint_path(path: str) -> _SourceFingerprint:
        requested = Path(path).expanduser().absolute()
        resolved = requested.resolve(strict=True)
        fingerprint = _confirmed_source_path_fingerprint(resolved)
        return _SourceFingerprint(
            requested_path=str(requested),
            resolved_path=str(resolved),
            device=fingerprint.device,
            inode=fingerprint.inode,
            size=fingerprint.size,
            modified_ns=fingerprint.modified_time_ns,
            changed_ns=fingerprint.changed_time_ns,
        )


def resolve_notebook_variable(source: Mapping[str, Any]) -> Any:
    variable_name = source.get("variableName")
    if not variable_name:
        raise EngineError("Notebook source is missing a variable name.")

    from . import notebook as notebook_runtime

    if notebook_runtime.is_live_result_handle(variable_name):
        return notebook_runtime.resolve_live_result(variable_name)
    if notebook_runtime.is_reserved_live_result_name(variable_name):
        raise EngineError("The notebook source contains an invalid Open Wrangler live-result handle.")

    main = importlib.import_module("__main__")
    if hasattr(main, variable_name):
        return getattr(main, variable_name)
    raise EngineError(
        f"Live dataframe '{variable_name}' is not available in the selected notebook kernel. "
        "Run the cell that defines it, then choose Open in Open Wrangler again."
    )
