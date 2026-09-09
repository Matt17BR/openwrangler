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
    confirmed = {"filterModel": _empty_view(), "viewChangeEpoch": 0}
    assert session.spark_confirmed_view is None
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
                    confirmed_view=confirmed,
                )
        assert response_seen
        assert session.spark_confirmed_view is not None
        assert session.spark_confirmed_view.paging.frame is previous_frame
        assert session.spark_confirmed_view.view_change_epoch == 0
        assert session.filter_model is previous_view
        assert session.filtered is previous_frame
        assert session.page_cache is previous_cache
        assert session.view_generation == previous_generation
        assert session.view_change_epoch == previous_epoch
        first = manager.get_page(
            session_id, 0, 0, 2, _empty_view(), column_limit=1, request_id="cached-spark-page", confirmed_view=confirmed
        )
        assert first["page"] is opened["page"]
        following = manager.get_page(
            session_id,
            0,
            2,
            2,
            _empty_view(),
            column_limit=1,
            request_id="continued-spark-page",
            confirmed_view=confirmed,
        )
        assert [row["values"][0]["raw"] for row in following["page"]["rows"]] == [2, 3]
        assert source.count() == 8
    finally:
        manager.close_all()
        assert session.spark_confirmed_view is None


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


def test_host_confirmed_spark_pages_reuse_exact_continuation(
    spark_session: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    import openwrangler_runtime.session as session_module

    source = spark_session.range(8).selectExpr("id AS value")
    variable = "open_wrangler_host_confirmed_continuation"
    monkeypatch.setattr(__main__, variable, source, raising=False)
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "notebookVariable", "variableName": variable}, backend="pyspark", page_size=2, column_limit=1
    )
    sid = opened["metadata"]["sessionId"]
    session = manager.sessions[sid]

    def model(operator: str, value: int) -> dict[str, Any]:
        return {
            "logic": "and",
            "filters": [
                {
                    "column": "value",
                    "type": "integer",
                    "predicates": [{"kind": "predicate", "operator": operator, "value": value}],
                }
            ],
            "sort": [],
        }

    a, b, d = model("gte", 0), model("gte", 4), model("lte", 5)
    invalid = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "string",
                "predicates": [{"kind": "predicate", "operator": "equals", "value": "wrong-type"}],
            }
        ],
        "sort": [],
    }
    empty = {"filterModel": _empty_view(), "viewChangeEpoch": 0}
    confirmed_a = {"filterModel": a, "viewChangeEpoch": 7}

    def page(query: dict[str, Any], confirmed: dict[str, Any], offset: int = 0, **options: Any) -> dict[str, Any]:
        return manager.get_page(sid, 0, offset, 2, query, column_limit=1, confirmed_view=confirmed, **options)

    try:
        assert session.spark_confirmed_view is None
        with pytest.raises(EngineError, match="Stale session revision"):
            manager.get_page(sid, 1, 0, 2, _empty_view(), column_limit=1, confirmed_view=empty)
        assert session.spark_confirmed_view is None
        # A first refused requested view must still retain the exact admitted
        # open frame and host namespace for the next continuation.
        with pytest.raises(EngineError):
            page(invalid, empty)
        assert session.spark_confirmed_view is not None
        assert session.spark_confirmed_view.paging.frame is session.filtered
        assert page(_empty_view(), empty, 2)["page"]["rows"][0]["values"][0]["raw"] == 2
        # Existing contextless restoration establishes a new authoritative
        # query; the first host pair binds that frame to epoch7, not runtime1.
        manager.get_page(sid, 0, 0, 2, a, column_limit=1)
        assert session.view_change_epoch == 1 and session.spark_confirmed_view is None
        recovery_frame = session.filtered
        with pytest.raises(EngineError, match="Restore it first"):
            page(b, {"filterModel": d, "viewChangeEpoch": 7})
        assert session.spark_confirmed_view is None and session.filtered is recovery_frame
        recovered = server.dispatch(
            manager,
            {
                "kind": "getPage",
                "sessionId": sid,
                "revision": 0,
                "offset": 2,
                "limit": 2,
                "columnOffset": 0,
                "columnLimit": 1,
                "viewRequestId": "recovered-a",
                "filterModel": a,
            },
            "recovered-a",
            confirmed_a,
        )
        assert recovered["page"]["rows"][0]["values"][0]["raw"] == 2
        assert session.spark_confirmed_view is not None
        assert session.spark_confirmed_view.paging.frame is recovery_frame
        assert session.spark_confirmed_view.view_change_epoch == 7
        checkpoint = session.spark_confirmed_view
        with pytest.raises(EngineError):
            manager.get_page(sid, 0, 0, 2, invalid, column_limit=1)
        assert session.spark_confirmed_view is checkpoint
        a4 = page(a, confirmed_a, 4)
        assert a4["page"]["totalRows"] is None
        page(a, confirmed_a, 6)
        a0 = page(a, confirmed_a)
        assert a0["page"]["totalRows"] == 8
        confirmed_frame = session.filtered
        filter_calls: list[dict[str, Any]] = []
        native_filter = session.engine.apply_filter_model

        def counted_filter(frame: Any, query: Any) -> Any:
            filter_calls.append(query)
            return native_filter(frame, query)

        monkeypatch.setattr(session.engine, "apply_filter_model", counted_filter)
        page(b, confirmed_a)
        assert page(b, confirmed_a, 2)["page"]["totalRows"] == 4
        page(d, confirmed_a)
        with pytest.raises(EngineError):
            page(invalid, confirmed_a)
        filter_count = len(filter_calls)
        restored = page(a, confirmed_a, 4)
        assert len(filter_calls) == filter_count
        assert restored["page"]["rows"] == a4["page"]["rows"]
        assert restored["page"]["totalRows"] == restored["metadata"]["filteredShape"]["rows"] == 8
        assert session.filtered is confirmed_frame
        # A0 must reuse A's old frame, even if its response will be superseded.
        page(b, confirmed_a)
        filter_count = len(filter_calls)
        assert page(a, confirmed_a)["page"] == a0["page"]
        assert len(filter_calls) == filter_count and session.filtered is confirmed_frame
        with pytest.raises(EngineError):
            page(invalid, confirmed_a)
        assert page(a, confirmed_a, 4)["page"]["rows"] == a4["page"]["rows"]
        with monkeypatch.context() as cap:
            cap.setattr(session_module, "PAGE_CACHE_LIMIT", 2)
            for offset in (0, 2, 4):
                page(a, confirmed_a, offset)
            assert len(session.page_cache) == 2
        assert session.page_cache_bytes <= session_module.PAGE_CACHE_BYTE_LIMIT
        page(b, confirmed_a)
        b_frame = session.filtered
        confirmed_b = {"filterModel": b, "viewChangeEpoch": 8}
        # Promotion records an already accepted B even when the next query C
        # refuses; it must not roll that acceptance back to A.
        with pytest.raises(EngineError):
            page(invalid, confirmed_b)
        assert session.spark_confirmed_view is not None
        assert session.spark_confirmed_view.paging.frame is b_frame
        assert session.spark_confirmed_view.view_change_epoch == 8
        filter_count = len(filter_calls)
        continued_b = page(b, confirmed_b, 2)
        assert len(filter_calls) == filter_count
        assert [row["values"][0]["raw"] for row in continued_b["page"]["rows"]] == [6, 7]
        # Profiles may compute a different query, but cannot promote it or
        # replace the live continuation frame/anchors.
        checkpoint = session.spark_confirmed_view
        manager.get_summary(sid, 0, a)
        assert session.spark_confirmed_view is checkpoint and session.filtered is b_frame
        assert page(b, confirmed_b, 2)["page"] == continued_b["page"]
        page(a, confirmed_b)
        new_a_frame = session.filtered
        assert new_a_frame is not confirmed_frame
        confirmed_new_a = {"filterModel": a, "viewChangeEpoch": 9}
        page(a, confirmed_new_a, 2)
        assert session.spark_confirmed_view.paging.frame is new_a_frame
        assert session.spark_confirmed_view.view_change_epoch == 9
        assert source.count() == 8
        assert manager._metadata(session)["schema"] == opened["metadata"]["schema"]

        replacement = spark_session.range(3).selectExpr("id AS value")

        def replace_source(_response: dict[str, Any]) -> None:
            monkeypatch.setattr(__main__, variable, replacement)

        with pytest.raises(LiveSourceInvalidatedError):
            page(a, confirmed_new_a, 4, response_preflight=replace_source)
        assert session.spark_confirmed_view is None and not session.page_cache
        with pytest.raises(LiveSourceInvalidatedError):
            page(a, confirmed_new_a, 4)
        assert session.spark_confirmed_view is None
    finally:
        manager.close_all()
        assert session.disposed and session.spark_confirmed_view is None
