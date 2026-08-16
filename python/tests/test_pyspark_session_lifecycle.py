from __future__ import annotations

from typing import Any

import pytest
from python.tests.pyspark_engine_test_support import (
    _ClosablePySparkSession,
    _empty_view,
    _FakeClassicFrame,
    _RestoreFailingSparkContext,
    _StoppedSparkContext,
)
from python.tests.pyspark_engine_test_support import (
    sample_frame as _shared_sample_frame,
)
from python.tests.pyspark_engine_test_support import (
    spark_session as _shared_spark_session,
)

import __main__
import openwrangler_runtime.server as server
from openwrangler_runtime.engines import EngineError, PySparkEngine
from openwrangler_runtime.session import LiveSourceInvalidatedError, SessionManager

sample_frame = _shared_sample_frame
spark_session = _shared_spark_session


def test_session_manager_detects_live_variable_and_disables_mutation_capabilities(
    spark_session: Any,
    sample_frame: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(__main__, "open_wrangler_spark_frame", sample_frame, raising=False)
    manager = SessionManager()
    opened = manager.open_session(
        {
            "kind": "notebookVariable",
            "variableName": "open_wrangler_spark_frame",
            "label": "open_wrangler_spark_frame",
        },
        page_size=2,
        mode="editing",
        column_limit=2,
    )
    metadata = opened["metadata"]
    assert metadata["backend"] == "pyspark"
    assert metadata["mode"] == "viewing"
    assert metadata["capabilities"] == {
        "editable": False,
        "lazy": False,
        "cancel": False,
        "exportCsv": False,
        "exportParquet": False,
        "notebookInsert": False,
    }
    assert opened["page"]["columnIds"] == ["c:source:0", "c:source:1"]
    assert len(opened["page"]["rows"]) == 2
    assert metadata["shape"] == {"rows": None, "columns": 5}
    assert metadata["filteredShape"] == {"rows": None, "columns": 5}
    assert opened["page"]["totalRows"] is None
    assert opened["page"]["hasMore"] is True

    middle = manager.get_page(
        metadata["sessionId"],
        metadata["revision"],
        2,
        2,
        _empty_view(),
        column_limit=2,
    )
    assert middle["page"]["totalRows"] is None
    assert middle["page"]["hasMore"] is True

    terminal = manager.get_page(
        metadata["sessionId"],
        metadata["revision"],
        4,
        2,
        _empty_view(),
        column_limit=2,
    )
    assert terminal["page"]["totalRows"] == 5
    assert "hasMore" not in terminal["page"]
    assert terminal["metadata"]["shape"] == {"rows": 5, "columns": 5}
    assert terminal["metadata"]["filteredShape"] == {"rows": 5, "columns": 5}

    first_again = manager.get_page(
        metadata["sessionId"],
        metadata["revision"],
        0,
        2,
        _empty_view(),
        column_limit=2,
    )
    assert first_again["page"]["totalRows"] == 5
    assert "hasMore" not in first_again["page"]

    middle_again = manager.get_page(
        metadata["sessionId"],
        metadata["revision"],
        2,
        2,
        _empty_view(),
        column_limit=2,
    )
    assert middle_again["page"]["totalRows"] == 5
    assert [row["rowNumber"] for row in middle_again["page"]["rows"]] == [2, 3]

    with pytest.raises(EngineError, match="viewing mode"):
        manager.preview_step(
            metadata["sessionId"],
            metadata["revision"],
            {"id": "step", "kind": "dropDuplicates", "params": {}},
            0,
            10,
        )
    assert manager.close_session(metadata["sessionId"], metadata["revision"]) == {
        "kind": "sessionClosed",
        "sessionId": metadata["sessionId"],
    }
    assert manager.sessions == {}
    assert spark_session.range(1).count() == 1


def test_terminal_close_never_enters_pyspark_request_ownership() -> None:
    contexts = (_StoppedSparkContext(), _RestoreFailingSparkContext())
    for index, spark_context in enumerate(contexts):
        session_id = f"close-without-spark-scope-{index}"
        engine = PySparkEngine()
        engine._indexed_frame = _FakeClassicFrame(spark_context)
        session = _ClosablePySparkSession(session_id, engine)
        manager = SessionManager()
        manager.sessions[session_id] = session  # type: ignore[assignment]

        response = server.dispatch(
            manager,
            {"kind": "closeSession", "sessionId": session_id, "revision": 0},
            f"close-request-{index}",
        )

        assert response == {"kind": "sessionClosed", "sessionId": session_id}
        assert spark_context.ownership_calls == 0
        assert session.disposed
        assert manager.sessions == {}


def test_replacing_classic_or_connect_variable_invalidates_cached_pages_before_read(
    spark_session: Any,
    sample_frame: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    variable_name = "open_wrangler_replaced_spark_frame"
    monkeypatch.setattr(__main__, variable_name, sample_frame, raising=False)
    manager = SessionManager()
    opened = manager.open_session(
        {
            "kind": "notebookVariable",
            "variableName": variable_name,
            "label": variable_name,
        },
        backend="pyspark",
        page_size=2,
        column_limit=2,
    )
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    assert session.live_source_value is sample_frame
    assert len(session.page_cache) == 1

    replacement = spark_session.range(10, 13).selectExpr("id AS replacement_value")
    monkeypatch.setattr(__main__, variable_name, replacement)
    with pytest.raises(LiveSourceInvalidatedError, match="was replaced") as invalidated:
        manager.get_page(
            session_id,
            0,
            0,
            2,
            {"logic": "and", "filters": [], "sort": []},
            column_limit=2,
        )

    assert invalidated.value.session_id == session_id
    assert session.page_cache == {}
    assert session.page_cache_bytes == 0
    assert manager.close_session(session_id, 0) == {"kind": "sessionClosed", "sessionId": session_id}
    assert replacement.count() == 3
