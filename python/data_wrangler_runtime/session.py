from __future__ import annotations

import importlib
import threading
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .engines import DataFrameEngine, EngineError, PandasEngine, PolarsEngine


@dataclass
class Session:
    session_id: str
    source: dict[str, Any]
    backend: str
    engine: DataFrameEngine
    original: Any
    filtered: Any
    filter_model: dict[str, Any]
    stats: dict[str, Any] | None
    source_shape: dict[str, int]
    source_schema: list[dict[str, Any]]
    revision: int
    mode: str
    lock: Any


class SessionManager:
    def __init__(self) -> None:
        self.engines: dict[str, DataFrameEngine] = {
            "polars": PolarsEngine(),
            "pandas": PandasEngine(),
        }
        self.sessions: dict[str, Session] = {}
        self._sessions_lock = threading.RLock()

    def initialize(self) -> dict[str, Any]:
        return {
            "kind": "initialized",
            "protocolVersion": 2,
            "runtimeVersion": "0.2.0a1",
            "capabilities": {
                "editable": True,
                "lazy": True,
                "cancel": True,
                "exportCsv": True,
                "exportParquet": True,
                "notebookInsert": True,
            },
        }

    def open_session(
        self,
        source: Mapping[str, Any],
        backend: str | None = None,
        page_size: int = 200,
        mode: str | None = None,
    ) -> dict[str, Any]:
        engine = self._engine_for_source(source, backend)
        frame = self._load_source(source, engine)
        if source.get("kind") != "file":
            frame = getattr(engine, "normalize", lambda value: value)(frame)
        session_id = str(uuid.uuid4())
        filter_model = {"filters": [], "sort": []}
        filtered = engine.apply_filter_model(frame, filter_model)
        source_shape = engine.shape(frame)
        source_schema = engine.schema(frame)
        session = Session(
            session_id=session_id,
            source=dict(source),
            backend=engine.name,
            engine=engine,
            original=frame,
            filtered=filtered,
            filter_model=filter_model,
            stats=None,
            source_shape=source_shape,
            source_schema=source_schema,
            revision=0,
            mode=mode or ("editing" if source.get("kind") == "file" else "viewing"),
            lock=threading.RLock(),
        )
        with self._sessions_lock:
            self.sessions[session_id] = session
        return {
            "kind": "sessionOpened",
            "metadata": self._metadata(session),
            "page": engine.page(filtered, 0, page_size),
            "summaries": engine.summaries(
                filtered,
                [column["name"] for column in source_schema[:8]],
            ),
        }

    def get_page(
        self,
        session_id: str,
        revision: int,
        offset: int,
        limit: int,
        filter_model: Mapping[str, Any],
    ) -> dict[str, Any]:
        session = self._session(session_id)
        with session.lock:
            self._assert_revision(session, revision)
            filtered = self._filtered(session, filter_model)
            return {
                "kind": "page",
                "revision": session.revision,
                "page": session.engine.page(filtered, offset, limit),
                "metadata": self._metadata(session),
            }

    def get_summary(
        self,
        session_id: str,
        revision: int,
        filter_model: Mapping[str, Any],
        columns: list[str] | None = None,
    ) -> dict[str, Any]:
        session = self._session(session_id)
        with session.lock:
            self._assert_revision(session, revision)
            filtered = self._filtered(session, filter_model)
            return {
                "kind": "summary",
                "revision": session.revision,
                "summaries": session.engine.summaries(filtered, columns),
            }

    def get_column_values(
        self,
        session_id: str,
        revision: int,
        column: str,
        filter_model: Mapping[str, Any],
        search: str | None = None,
        limit: int = 100,
    ) -> dict[str, Any]:
        session = self._session(session_id)
        with session.lock:
            self._assert_revision(session, revision)
            filtered = self._filtered(session, filter_model)
            values, has_more = session.engine.column_values(filtered, column, search, limit)
            return {
                "kind": "columnValues",
                "revision": session.revision,
                "column": column,
                "values": values,
                "hasMore": has_more,
            }

    def get_dataset_stats(
        self,
        session_id: str,
        revision: int,
        filter_model: Mapping[str, Any],
    ) -> dict[str, Any]:
        session = self._session(session_id)
        with session.lock:
            self._assert_revision(session, revision)
            filtered = self._filtered(session, filter_model)
            session.stats = session.engine.header_stats(filtered)
            return {
                "kind": "datasetStats",
                "revision": session.revision,
                "stats": session.stats,
            }

    def close_session(self, session_id: str, revision: int) -> dict[str, Any]:
        self._assert_revision(self._session(session_id), revision)
        with self._sessions_lock:
            session = self.sessions.pop(session_id, None)
        if session is None:
            raise EngineError(f"Unknown session: {session_id}")
        return {"kind": "sessionClosed", "sessionId": session_id}

    def _filtered(self, session: Session, filter_model: Mapping[str, Any]) -> Any:
        model = dict(filter_model)
        if model != session.filter_model:
            session.filtered = session.engine.apply_filter_model(session.original, model)
            session.filter_model = model
            session.stats = None
        return session.filtered

    def _metadata(self, session: Session) -> dict[str, Any]:
        metadata = {
            "protocolVersion": 2,
            "sessionId": session.session_id,
            "revision": session.revision,
            "backend": session.backend,
            "mode": session.mode,
            "source": session.source,
            "capabilities": self._capabilities(session),
            "shape": session.source_shape,
            "filteredShape": session.engine.shape(session.filtered),
            "schema": session.source_schema,
            "filterModel": session.filter_model,
        }
        if session.stats is not None:
            metadata["stats"] = session.stats
        return metadata

    def _session(self, session_id: str) -> Session:
        with self._sessions_lock:
            try:
                return self.sessions[session_id]
            except KeyError as error:
                raise EngineError(f"Unknown session: {session_id}") from error

    def _capabilities(self, session: Session) -> dict[str, bool]:
        source_kind = session.source.get("kind")
        extension = str(session.source.get("path", "")).lower()
        return {
            "editable": session.mode == "editing",
            "lazy": session.backend == "polars"
            and source_kind == "file"
            and extension.endswith((".csv", ".tsv", ".parquet", ".jsonl")),
            "cancel": True,
            "exportCsv": session.mode == "editing",
            "exportParquet": session.mode == "editing",
            "notebookInsert": source_kind == "notebookVariable",
        }

    def _assert_revision(self, session: Session, revision: int) -> None:
        if revision != session.revision:
            raise EngineError(f"Stale session revision {revision}; current revision is {session.revision}.")

    def _engine_for_source(self, source: Mapping[str, Any], backend: str | None) -> DataFrameEngine:
        if backend:
            return self._engine(backend)
        if source.get("kind") == "file":
            return self._engine("polars")
        value = self._resolve_notebook_variable(source)
        for engine in self.engines.values():
            if engine.detect(value):
                return engine
        raise EngineError("Could not detect a supported dataframe backend for the source.")

    def _engine(self, backend: str) -> DataFrameEngine:
        try:
            return self.engines[backend]
        except KeyError as error:
            raise EngineError(f"Unsupported backend: {backend}") from error

    def _load_source(self, source: Mapping[str, Any], engine: DataFrameEngine) -> Any:
        kind = source.get("kind")
        if kind == "file":
            path = source.get("path")
            if not path:
                raise EngineError("File source is missing a path.")
            options = source.get("importOptions")
            return engine.read_file(str(path), options if isinstance(options, Mapping) else None)
        if kind in {"notebookVariable", "notebookOutput"}:
            return self._resolve_notebook_variable(source)
        raise EngineError(f"Unsupported source kind: {kind}")

    def _resolve_notebook_variable(self, source: Mapping[str, Any]) -> Any:
        variable_name = source.get("variableName")
        if not variable_name:
            raise EngineError("Notebook source is missing a variable name.")

        main = importlib.import_module("__main__")
        if hasattr(main, variable_name):
            return getattr(main, variable_name)
        raise EngineError(
            "Notebook variable launch requires running the Data Explorer runtime inside the active kernel. "
            f"Variable not found: {variable_name}"
        )
