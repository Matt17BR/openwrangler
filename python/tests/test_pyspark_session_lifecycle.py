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
from openwrangler_runtime.session import ResponsePayloadError, SessionManager
from openwrangler_runtime.session_source import LiveSourceInvalidatedError

sample_frame = _shared_sample_frame
spark_session = _shared_spark_session


@pytest.mark.parametrize("failure_stage", ("response", "request_scope_exit", "cancellation"))
def test_failed_page_preserves_cached_spark_continuation(
    spark_session: Any, monkeypatch: pytest.MonkeyPatch, failure_stage: str
) -> None:
    source = spark_session.range(8).selectExpr("id AS value")
    variable = "open_wrangler_page_continuation"
    monkeypatch.setattr(__main__, variable, source, raising=False)
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "notebookVariable", "variableName": variable},
        backend="pyspark",
        page_size=2,
        column_limit=1,
    )
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    previous_view = session.filter_model
    previous_frame = session.filtered
    previous_cache = session.page_cache
    previous_generation = session.view_generation
    previous_epoch = session.view_change_epoch
    model = {
        "filters": [
            {"column": "value", "type": "integer", "predicates": [{"kind": "predicate", "operator": "gte", "value": 4}]}
        ],
        "sort": [],
    }
    response_seen = False

    def preflight(response: dict[str, Any]) -> None:
        nonlocal response_seen
        response_seen = True
        assert [row["values"][0]["raw"] for row in response["page"]["rows"]] == [4, 5]
        assert session.filter_model is previous_view
        if failure_stage == "response":
            raise ResponsePayloadError("Synthetic correlated response refusal", "response_encoding_failed")
        if failure_stage == "cancellation":
            raise KeyboardInterrupt("Synthetic page cancellation")

    try:
        with monkeypatch.context() as fault:
            if failure_stage == "request_scope_exit":
                # Keep real Spark paging, but fail the existing Classic job-property
                # restoration owner after the complete response has been checked.
                fault.setattr(session.engine, "_indexed_frame", _FakeClassicFrame(_RestoreFailingSparkContext()))
            with pytest.raises(
                (ResponsePayloadError, RuntimeError, KeyboardInterrupt), match="refusal|Could not restore|cancellation"
            ):
                manager.get_page(
                    session_id,
                    0,
                    0,
                    2,
                    model,
                    column_limit=1,
                    request_id="failed-spark-page",
                    response_preflight=preflight,
                )
        assert response_seen
        assert session.filter_model is previous_view
        assert session.filtered is previous_frame
        assert session.page_cache is previous_cache
        assert session.view_generation == previous_generation
        assert session.view_change_epoch == previous_epoch
        first = manager.get_page(session_id, 0, 0, 2, _empty_view(), column_limit=1, request_id="cached-spark-page")
        assert first["page"] is opened["page"]
        following = manager.get_page(
            session_id, 0, 2, 2, _empty_view(), column_limit=1, request_id="continued-spark-page"
        )
        assert [row["values"][0]["raw"] for row in following["page"]["rows"]] == [2, 3]
        assert source.count() == 8
    finally:
        manager.close_all()


def test_failed_terminal_page_keeps_spark_totals_unknown_until_success(
    spark_session: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    variable = "open_wrangler_page_totals"
    source = spark_session.range(3).selectExpr("id AS value")
    monkeypatch.setattr(__main__, variable, source, raising=False)
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "notebookVariable", "variableName": variable},
        backend="pyspark",
        page_size=2,
        column_limit=1,
    )
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    previous_cache = session.page_cache

    def reject(response: dict[str, Any]) -> None:
        assert response["page"]["totalRows"] == 3
        assert response["metadata"]["shape"]["rows"] == 3
        assert response["metadata"]["filteredShape"]["rows"] == 3
        raise ResponsePayloadError("Synthetic terminal page refusal", "response_encoding_failed")

    try:
        with pytest.raises(ResponsePayloadError, match="terminal page refusal"):
            manager.get_page(
                session_id,
                0,
                2,
                2,
                _empty_view(),
                column_limit=1,
                request_id="failed-terminal-page",
                response_preflight=reject,
            )
        assert session.source_shape["rows"] is None
        assert session.committed_shape["rows"] is None
        assert session.filtered_shape["rows"] is None
        assert session.page_cache is previous_cache
        first = manager.get_page(session_id, 0, 0, 2, _empty_view(), column_limit=1)
        assert first["page"] is opened["page"]
        assert first["page"]["totalRows"] is None
        terminal = manager.get_page(session_id, 0, 2, 2, _empty_view(), column_limit=1)
        assert terminal["page"]["totalRows"] == 3
        assert session.source_shape["rows"] == session.committed_shape["rows"] == session.filtered_shape["rows"] == 3
        exact_first = manager.get_page(session_id, 0, 0, 2, _empty_view(), column_limit=1)
        assert exact_first["page"]["totalRows"] == 3
        assert exact_first["page"] is not opened["page"]
        assert source.count() == 3
    finally:
        manager.close_all()


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
        manager.redo_step(metadata["sessionId"], metadata["revision"], 0, 10)
    assert metadata["canRedo"] is False

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
