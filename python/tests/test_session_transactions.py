from __future__ import annotations

import os
from collections.abc import Iterable, Mapping
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from openwrangler_runtime import server
from openwrangler_runtime import session as session_runtime
from openwrangler_runtime.engines import EngineError, EngineRegistry, PolarsEngine
from openwrangler_runtime.session import ResponsePayloadError, Session, SessionManager

VIEW_FILTER = {
    "logic": "and",
    "filters": [
        {
            "column": "value",
            "type": "integer",
            "predicates": [{"kind": "predicate", "operator": "gte", "value": 2}],
        }
    ],
    "sort": [{"column": "value", "direction": "desc", "nulls": "last"}],
}


def formula_step(step_id: str, new_column: str = "doubled") -> dict[str, Any]:
    return {
        "id": step_id,
        "kind": "formula",
        "params": {
            "leftColumn": {"id": "c:source:1", "name": "value"},
            "operator": "multiply",
            "value": 2,
            "newColumn": new_column,
        },
    }


def open_pandas_session(tmp_path: Path) -> tuple[SessionManager, str]:
    path = tmp_path / "transactions.csv"
    path.write_text("name,value\na,1\nb,2\nc,3\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend="pandas",
        page_size=2,
    )
    return manager, opened["metadata"]["sessionId"]


def prime_filtered_page(manager: SessionManager, session_id: str, revision: int) -> None:
    manager.get_page(session_id, revision, 0, 1, VIEW_FILTER)


def session_state(session: Session) -> dict[str, Any]:
    """Comparable state without copying dataframe objects."""
    return {
        "committedId": id(session.committed),
        "filteredId": id(session.filtered),
        "filterModel": deepcopy(session.filter_model),
        "filteredShape": deepcopy(session.filtered_shape),
        "plan": deepcopy(session.plan),
        "boundPlan": deepcopy(session.bound_plan),
        "planInputSchemas": deepcopy(session.plan_input_schemas),
        "committedLineage": deepcopy(session.committed_lineage),
        "committedShape": deepcopy(session.committed_shape),
        "committedSchema": deepcopy(session.committed_schema),
        "draftStep": deepcopy(session.draft_step),
        "draftBoundStep": deepcopy(session.draft_bound_step),
        "draftFrameId": id(session.draft_frame) if session.draft_frame is not None else None,
        "draftBaseFilterModel": deepcopy(session.draft_base_filter_model),
        "draftBaseViewChangeEpoch": session.draft_base_view_change_epoch,
        "draftBaseLineage": deepcopy(session.draft_base_lineage),
        "draftBaseSchema": deepcopy(session.draft_base_schema),
        "draftLineage": deepcopy(session.draft_lineage),
        "draftShape": deepcopy(session.draft_shape),
        "draftSchema": deepcopy(session.draft_schema),
        "replaceStepId": session.replace_step_id,
        "sourceShape": deepcopy(session.source_shape),
        "sourceSchema": deepcopy(session.source_schema),
        "pageCache": [(key, deepcopy(cached.payload), cached.size_bytes) for key, cached in session.page_cache.items()],
        "pageCacheBytes": session.page_cache_bytes,
        "viewGeneration": session.view_generation,
        "viewChangeEpoch": session.view_change_epoch,
        "lastAppliedViewRestore": deepcopy(session.last_applied_view_restore),
        "revision": session.revision,
    }


def fail_after_response_page(monkeypatch: pytest.MonkeyPatch, session: Session, previous_revision: int) -> None:
    def fail_compile(_steps: Iterable[Mapping[str, Any]]) -> str:
        assert session.revision == previous_revision + 1
        assert any(key[1] == session.revision for key in session.page_cache)
        raise EngineError("late response construction failure")

    monkeypatch.setattr(session.engine, "compile_plan", fail_compile)


def assert_unchanged_and_closable(
    manager: SessionManager,
    session_id: str,
    revision: int,
    expected: dict[str, Any],
) -> None:
    assert session_state(manager.sessions[session_id]) == expected
    assert manager.close_session(session_id, revision) == {"kind": "sessionClosed", "sessionId": session_id}


def inject_preview_response_fault(
    monkeypatch: pytest.MonkeyPatch,
    manager: SessionManager,
    session: Session,
    field: str,
    value: object,
) -> None:
    if field == "code":
        monkeypatch.setattr(session.engine, "compile_plan", lambda _steps: value)
        return
    if field == "metadata":
        original = manager._metadata
        monkeypatch.setattr(manager, "_metadata", lambda active: {**original(active), "fault": value})
        return
    if field == "page":
        original = manager._page
        monkeypatch.setattr(manager, "_page", lambda *args: {**original(*args), "fault": value})
        return
    if field == "diff":
        original = manager._diff
        monkeypatch.setattr(manager, "_diff", lambda *args, **kwargs: {**original(*args, **kwargs), "fault": value})
        return
    if field == "warnings":
        original = session_runtime.validate_step

        def validate_with_fault(step: Mapping[str, Any]) -> dict[str, Any]:
            normalized = original(step)
            normalized["params"] = {**normalized["params"], "warnings": [value]}
            return normalized

        monkeypatch.setattr(session_runtime, "validate_step", validate_with_fault)
        return
    raise AssertionError(f"Unknown response field: {field}")


def observe_session(manager: SessionManager, session_id: str, revision: int) -> dict[str, Any]:
    session = manager.sessions[session_id]
    return manager.get_page(
        session_id,
        revision,
        0,
        2,
        deepcopy(session.filter_model),
    )


def test_preview_rolls_back_after_late_response_construction_failure(tmp_path: Path, monkeypatch) -> None:
    manager, session_id = open_pandas_session(tmp_path)
    prime_filtered_page(manager, session_id, 0)
    session = manager.sessions[session_id]
    before = session_state(session)
    fail_after_response_page(monkeypatch, session, 0)

    with pytest.raises(EngineError, match="late response construction"):
        manager.preview_step(session_id, 0, formula_step("preview"), 0, 2)

    assert_unchanged_and_closable(manager, session_id, 0, before)


def test_apply_rolls_back_after_late_response_construction_failure(tmp_path: Path, monkeypatch) -> None:
    manager, session_id = open_pandas_session(tmp_path)
    manager.preview_step(session_id, 0, formula_step("apply"), 0, 2)
    prime_filtered_page(manager, session_id, 1)
    session = manager.sessions[session_id]
    before = session_state(session)
    fail_after_response_page(monkeypatch, session, 1)

    with pytest.raises(EngineError, match="late response construction"):
        manager.apply_draft(session_id, 1, 0, 2)

    assert_unchanged_and_closable(manager, session_id, 1, before)


def test_discard_rolls_back_after_late_response_construction_failure(tmp_path: Path, monkeypatch) -> None:
    manager, session_id = open_pandas_session(tmp_path)
    manager.preview_step(session_id, 0, formula_step("kept"), 0, 2)
    manager.apply_draft(session_id, 1, 0, 2)
    manager.preview_step(session_id, 2, formula_step("discard", "also_doubled"), 0, 2)
    prime_filtered_page(manager, session_id, 3)
    session = manager.sessions[session_id]
    before = session_state(session)
    fail_after_response_page(monkeypatch, session, 3)

    with pytest.raises(EngineError, match="late response construction"):
        manager.discard_draft(session_id, 3, 0, 2)

    assert_unchanged_and_closable(manager, session_id, 3, before)


def test_undo_rolls_back_after_late_response_construction_failure(tmp_path: Path, monkeypatch) -> None:
    manager, session_id = open_pandas_session(tmp_path)
    manager.preview_step(session_id, 0, formula_step("kept"), 0, 2)
    manager.apply_draft(session_id, 1, 0, 2)
    manager.preview_step(session_id, 2, formula_step("undo", "also_doubled"), 0, 2)
    manager.apply_draft(session_id, 3, 0, 2)
    prime_filtered_page(manager, session_id, 4)
    session = manager.sessions[session_id]
    before = session_state(session)
    fail_after_response_page(monkeypatch, session, 4)

    with pytest.raises(EngineError, match="late response construction"):
        manager.undo_step(session_id, 4, 0, 2)

    assert_unchanged_and_closable(manager, session_id, 4, before)


@pytest.mark.parametrize("field", ["code", "metadata", "page", "diff", "warnings"])
@pytest.mark.parametrize("fault_kind", ["invalid-json", "oversized"])
def test_preview_preflight_restores_every_state_owner_for_each_response_field(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    fault_kind: str,
) -> None:
    manager, session_id = open_pandas_session(tmp_path)
    prime_filtered_page(manager, session_id, 0)
    session = manager.sessions[session_id]
    expected_observation = observe_session(manager, session_id, 0)
    before = session_state(session)
    expected_code = "response_encoding_failed"
    fault: object = object()
    if fault_kind == "oversized":
        monkeypatch.setattr(session_runtime, "MAX_STRICT_RESPONSE_PAYLOAD_BYTES", 64 * 1024)
        fault = "x" * (128 * 1024)
        expected_code = "response_too_large"

    with monkeypatch.context() as response_fault:
        inject_preview_response_fault(response_fault, manager, session, field, fault)
        with pytest.raises(ResponsePayloadError) as raised:
            manager.preview_step(session_id, 0, formula_step(f"{field}-{fault_kind}"), 0, 2)

    assert raised.value.code == expected_code
    assert session_state(session) == before
    assert observe_session(manager, session_id, 0) == expected_observation


@pytest.mark.parametrize("operation", ["preview", "apply", "discard", "undo", "replace"])
def test_every_mutation_path_rolls_back_when_the_correlated_response_preflight_fails(
    tmp_path: Path,
    operation: str,
) -> None:
    manager, session_id = open_pandas_session(tmp_path)
    revision = 0
    arguments: tuple[Any, ...]
    keyword_arguments: dict[str, Any] = {}
    mutation = manager.preview_step
    if operation == "preview":
        arguments = (session_id, revision, formula_step("preview"), 0, 2)
    elif operation in {"apply", "discard"}:
        manager.preview_step(session_id, revision, formula_step(operation), 0, 2)
        revision = 1
        mutation = manager.apply_draft if operation == "apply" else manager.discard_draft
        arguments = (session_id, revision, 0, 2)
    elif operation == "undo":
        manager.preview_step(session_id, revision, formula_step("undo"), 0, 2)
        manager.apply_draft(session_id, 1, 0, 2)
        revision = 2
        mutation = manager.undo_step
        arguments = (session_id, revision, 0, 2)
    else:
        manager.preview_step(session_id, revision, formula_step("replace"), 0, 2)
        manager.apply_draft(session_id, 1, 0, 2)
        revision = 2
        arguments = (session_id, revision, formula_step("replace", "replacement"), 0, 2)
        keyword_arguments["replace_step_id"] = "replace"

    expected_observation = observe_session(manager, session_id, revision)
    before = session_state(manager.sessions[session_id])

    def reject(_response: dict[str, Any]) -> None:
        raise ResponsePayloadError("correlated response rejected", "response_encoding_failed")

    with pytest.raises(ResponsePayloadError, match="correlated response rejected"):
        mutation(*arguments, **keyword_arguments, response_preflight=reject)

    assert session_state(manager.sessions[session_id]) == before
    assert observe_session(manager, session_id, revision) == expected_observation


def test_server_preflights_the_complete_correlated_envelope_before_committing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, session_id = open_pandas_session(tmp_path)
    expected_observation = observe_session(manager, session_id, 0)
    before = session_state(manager.sessions[session_id])
    monkeypatch.setattr(server, "MAX_RESPONSE_FRAME_BYTES", 256)

    with pytest.raises(ResponsePayloadError) as raised:
        server.dispatch(
            manager,
            {
                "kind": "previewStep",
                "sessionId": session_id,
                "revision": 0,
                "step": formula_step("correlated"),
                "offset": 0,
                "limit": 2,
                "columnOffset": 0,
                "columnLimit": 64,
            },
            "correlated-mutation",
        )

    assert raised.value.code == "response_too_large"
    assert session_state(manager.sessions[session_id]) == before
    assert observe_session(manager, session_id, 0) == expected_observation


def test_source_post_validation_rolls_back_preview_but_keeps_cache_invalidated(tmp_path: Path) -> None:
    path = tmp_path / "lazy-source.csv"
    path.write_text("name,value\na,1\nb,2\nc,3\n", encoding="utf-8")

    class ReplacingSourcePolarsEngine(PolarsEngine):
        def compile_plan(self, steps: Iterable[Mapping[str, Any]]) -> str:
            code = super().compile_plan(steps)
            original = path.stat()
            replacement = path.with_name(f".{path.name}.replacement")
            replacement.write_text("name,value\nreplacement,100\n", encoding="utf-8")
            os.utime(replacement, ns=(original.st_atime_ns, original.st_mtime_ns))
            os.replace(replacement, path)
            return code

    manager = SessionManager(EngineRegistry((("polars", ReplacingSourcePolarsEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend="polars",
        page_size=2,
    )
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    before = session_state(session)
    assert before["pageCache"]

    with pytest.raises(EngineError, match=r"changed or is no longer available.*Reopen"):
        manager.preview_step(session_id, 0, formula_step("source-change"), 0, 2)

    expected = {**before, "pageCache": [], "pageCacheBytes": 0}
    assert session_state(session) == expected
    assert manager.close_session(session_id, 0) == {"kind": "sessionClosed", "sessionId": session_id}
