from __future__ import annotations

import gc
import threading
import weakref
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from copy import deepcopy
from pathlib import Path
from typing import Any

import polars as pl
import pytest

from openwrangler_runtime.engines import EngineError, EngineRegistry, PandasEngine
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine, DuckDBSqlPlan
from openwrangler_runtime.session import Session, SessionManager
from openwrangler_runtime.session_source import SourceChangedError


def step(step_id: str, kind: str, **params: Any) -> dict[str, Any]:
    return {"id": step_id, "kind": kind, "params": params}


def apply_step(
    manager: SessionManager,
    session_id: str,
    revision: int,
    transform: dict[str, Any],
) -> int:
    preview = manager.preview_step(session_id, revision, transform, 0, 10)
    applied = manager.apply_draft(session_id, preview["revision"], 0, 10)
    return int(applied["revision"])


def observable_state(session: Session) -> dict[str, Any]:
    return {
        "original": id(session.original),
        "committed": id(session.committed),
        "filtered": id(session.filtered),
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
        "draftFrame": id(session.draft_frame) if session.draft_frame is not None else None,
        "draftLineage": deepcopy(session.draft_lineage),
        "draftShape": deepcopy(session.draft_shape),
        "draftSchema": deepcopy(session.draft_schema),
        "replaceStepId": session.replace_step_id,
        "pageCache": [(key, deepcopy(cached.payload), cached.size_bytes) for key, cached in session.page_cache.items()],
        "pageCacheBytes": session.page_cache_bytes,
        "viewGeneration": session.view_generation,
        "revision": session.revision,
    }


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_preview_apply_and_inspection_clamp_each_known_row_boundary(backend: str, tmp_path: Path) -> None:
    path = tmp_path / f"inspection-tail-{backend}.csv"
    path.write_text("name,value\na,1\na,1\nb,2\n", encoding="utf-8")
    original = path.read_bytes()
    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "label": path.name, "path": str(path)}, backend=backend, page_size=1)
    session_id = opened["metadata"]["sessionId"]
    revision = 0
    try:
        preview = manager.preview_step(
            session_id,
            revision,
            step("deduplicate", "dropDuplicates", keep="first"),
            25,
            1,
            column_offset=1,
            column_limit=1,
        )
        revision = preview["revision"]
        assert (preview["page"]["offset"], preview["page"]["totalRows"], preview["page"]["rows"]) == (2, 2, [])
        assert preview["diff"]["removedRows"] == 1
        assert preview["diff"]["changedCells"] == 0
        applied = manager.apply_draft(session_id, revision, 25, 1, column_offset=1, column_limit=1)
        revision = applied["revision"]
        assert (applied["page"]["offset"], applied["page"]["totalRows"], applied["page"]["rows"]) == (2, 2, [])
        session = manager.sessions[session_id]
        before = observable_state(session)
        for requested, input_offset, output_offset in [(2, 2, 2), (3, 3, 2), (25, 3, 2)]:
            inspected = manager.inspect_step(
                session_id, revision, "deduplicate", requested, 1, column_offset=1, column_limit=1
            )
            assert inspected["inputPage"]["offset"] == input_offset
            assert inspected["outputPage"]["offset"] == output_offset
            assert inspected["inputPage"]["totalRows"] == 3
            assert inspected["outputPage"]["totalRows"] == 2
            assert inspected["inputPage"]["columnIds"] == inspected["outputPage"]["columnIds"] == ["c:source:1"]
            assert [row["values"][0]["display"] for row in inspected["inputPage"]["rows"]] == (
                ["2"] if requested == 2 else []
            )
            assert inspected["outputPage"]["rows"] == []
            assert inspected["diff"]["removedRows"] == 1
            assert inspected["diff"]["cells"] == []
            assert observable_state(session) == before
        undone = manager.undo_step(session_id, revision, 25, 1, column_offset=1, column_limit=1)
        revision = undone["revision"]
        assert (undone["page"]["offset"], undone["page"]["totalRows"], undone["page"]["rows"]) == (3, 3, [])
        assert undone["metadata"]["steps"] == []
        assert undone["metadata"]["schema"] == opened["metadata"]["schema"]
        assert path.read_bytes() == original
    finally:
        manager.close_session(session_id, revision)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_inspect_applied_step_replays_only_its_prefix_without_publishing_state(
    backend: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / f"inspection-{backend}.csv"
    path.write_text("name,value\na,1.2\nb,2.8\nc,3.4\n", encoding="utf-8")
    if backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Inspection must stay native")),
            raising=False,
        )

    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=2,
    )
    session_id = opened["metadata"]["sessionId"]
    revision = 0
    revision = apply_step(
        manager,
        session_id,
        revision,
        step(
            "add-double",
            "formula",
            leftColumn={"id": "c:source:1", "name": "value"},
            operator="multiply",
            value=2,
            newColumn="doubled",
        ),
    )
    revision = apply_step(
        manager,
        session_id,
        revision,
        step(
            "round-value",
            "roundNumber",
            column={"id": "c:source:1", "name": "value"},
            decimals=0,
        ),
    )
    revision = apply_step(
        manager,
        session_id,
        revision,
        step(
            "rename-double",
            "renameColumn",
            column={"id": "c:step:add-double:0", "name": "doubled"},
            newName="renamed_metric",
        ),
    )
    draft = manager.preview_step(
        session_id,
        revision,
        step(
            "pending-length",
            "textLength",
            column={"id": "c:source:0", "name": "name"},
            newColumn="name_length",
        ),
        0,
        2,
    )
    revision = int(draft["revision"])
    manager.get_page(
        session_id,
        revision,
        0,
        2,
        {"logic": "and", "filters": [], "sort": [{"column": "name", "direction": "desc", "nulls": "last"}]},
    )

    session = manager.sessions[session_id]
    before = observable_state(session)
    applied_during_inspection: list[str] = []
    native_apply = session.engine.apply_transform

    def track_prefix(frame: Any, transform: Any) -> Any:
        applied_during_inspection.append(str(transform["id"]))
        return native_apply(frame, transform)

    monkeypatch.setattr(session.engine, "apply_transform", track_prefix)
    inspection = manager.inspect_step(session_id, revision, "round-value", 1, 1)

    assert inspection["kind"] == "stepInspection"
    assert inspection["revision"] == revision
    assert inspection["stepId"] == "round-value"
    assert inspection["stepIndex"] == 1
    assert inspection["inputPage"]["offset"] == 1
    assert inspection["outputPage"]["offset"] == 1
    assert inspection["inputPage"]["totalRows"] == 3
    assert len(inspection["inputPage"]["rows"]) == 1
    assert inspection["diff"]["truncated"] is True
    assert inspection["inputPage"]["rows"][0]["values"][1]["display"] == "2.8"
    assert inspection["outputPage"]["rows"][0]["values"][1]["display"] in {"3", "3.0"}
    assert inspection["diff"]["changedCells"] == 1
    assert inspection["diff"]["cells"][0]["rowNumber"] == 1
    assert [column["name"] for column in inspection["inputSchema"]] == ["name", "value", "doubled"]
    assert [column["name"] for column in inspection["outputSchema"]] == ["name", "value", "doubled"]
    assert inspection["code"] == session.engine.compile_plan(session.bound_plan[:2])
    assert "renamed_metric" not in inspection["code"]
    assert "name_length" not in inspection["code"]
    assert applied_during_inspection == ["add-double", "round-value"]
    assert observable_state(session) == before
    manager.inspect_step(session_id, revision, "round-value", 0, 1)
    assert applied_during_inspection == ["add-double", "round-value"] * 2
    assert session.inspection_boundary is None

    manager.close_session(session_id, revision)


@pytest.fixture(params=["polars", "duckdb"])
def custom_inspection_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest
) -> Iterator[tuple[SessionManager, Session, Path]]:
    import __main__

    path = tmp_path / "alternating-inspection.csv"
    path.write_text("id,mirror\n0,0\n1,10\n2,20\n3,30\n", encoding="utf-8")
    monkeypatch.setattr(__main__, "inspection_calls", 0, raising=False)
    manager = SessionManager()
    try:
        opened = manager.open_session(
            {"kind": "file", "label": path.name, "path": str(path)},
            backend=request.param,
            mode="editing",
            page_size=4,
        )
        session_id = opened["metadata"]["sessionId"]
        revision = apply_step(
            manager,
            session_id,
            0,
            step(
                "alternate-order",
                "customCode",
                code=(
                    "import __main__\n"
                    "__main__.inspection_calls += 1\n"
                    + (
                        "result = df.sort([pl.col('id')], descending=[__main__.inspection_calls % 2 == 0], "
                        "nulls_last=[True], maintain_order=True)\n"
                        "result = result if isinstance(result, pl.LazyFrame) else result.lazy()"
                        if request.param == "polars"
                        else "result = df.order('id DESC' if __main__.inspection_calls % 2 == 0 else 'id ASC')"
                    )
                ),
            ),
        )
        session = manager.sessions[session_id]
        id_column = next(column for column in session.committed_lineage if column["name"] == "id")
        apply_step(
            manager,
            session_id,
            revision,
            step("copy-id", "cloneColumn", column={"id": id_column["id"], "name": "id"}, newName="id_copy"),
        )
        yield manager, session, path
    finally:
        manager.close_all()


def retained_storage_ref(frame: Any) -> weakref.ReferenceType[Any]:
    if isinstance(frame, DuckDBSqlPlan):
        assert frame.checkpoint is not None
        return weakref.ref(frame.checkpoint)
    return weakref.ref(frame)


def test_custom_inspection_keeps_row_identity_across_row_and_column_windows(custom_inspection_session) -> None:
    import __main__

    manager, session, path = custom_inspection_session
    original = path.read_bytes()
    before = observable_state(session)
    assert __main__.inspection_calls == 1
    for offset in range(4):
        identity = manager.inspect_step(session.session_id, session.revision, "copy-id", offset, 1, 0, 1)
        mirror = manager.inspect_step(session.session_id, session.revision, "copy-id", offset, 1, 1, 1)
        for side in ("inputPage", "outputPage"):
            id_row = identity[side]["rows"][0]
            mirror_row = mirror[side]["rows"][0]
            assert id_row["id"] == mirror_row["id"]
            assert id_row["rowNumber"] == mirror_row["rowNumber"] == offset
            assert id_row["values"][0]["raw"] == 3 - offset
            assert mirror_row["values"][0]["raw"] == id_row["values"][0]["raw"] * 10
        assert identity["diff"]["changedCells"] == mirror["diff"]["changedCells"] == 0
    assert __main__.inspection_calls == 2
    assert observable_state(session) == before
    assert path.read_bytes() == original


def test_custom_inspection_boundary_survives_failed_edits_but_retires_with_its_owner(
    custom_inspection_session, monkeypatch: pytest.MonkeyPatch
) -> None:
    import __main__
    import openwrangler_runtime.session as session_runtime

    manager, session, _path = custom_inspection_session
    session_id, revision = session.session_id, session.revision
    original = manager.inspect_step(session_id, revision, "copy-id", 0, 1)
    boundary = session.inspection_boundary
    assert boundary is not None
    frames = [retained_storage_ref(boundary.before), retained_storage_ref(boundary.after)]
    checkpoint_paths = (
        {Path(checkpoint.path) for checkpoint in session.engine._checkpoints}
        if isinstance(session.engine, DuckDBEngine)
        else set()
    )
    rejected_paths: set[Path] = set()

    def reject(_response: Any, *_args: Any, **_kwargs: Any) -> None:
        if isinstance(session.engine, DuckDBEngine):
            rejected_paths.update(Path(checkpoint.path) for checkpoint in session.engine._checkpoints)
        raise EngineError("rejected response")

    with monkeypatch.context() as patch:
        patch.setattr(session_runtime, "strict_response_payload_size", reject)
        with pytest.raises(EngineError, match="rejected response"):
            manager.inspect_step(session_id, revision, "alternate-order", 0, 1)
    assert session.inspection_boundary is boundary

    before = observable_state(session)
    edit = step("more", "customCode", code="result = df")
    with pytest.raises(EngineError, match="rejected response"):
        manager.preview_step(session_id, revision, edit, 0, 1, response_preflight=reject)
    assert observable_state(session) == before
    assert session.inspection_boundary is boundary
    gc.collect()
    if checkpoint_paths:
        assert rejected_paths - checkpoint_paths
        assert all(path.exists() for path in checkpoint_paths)
        assert all(not path.exists() for path in rejected_paths - checkpoint_paths)
    manager.get_page(
        session_id,
        revision,
        0,
        1,
        {"logic": "and", "filters": [], "sort": [{"column": "id", "direction": "asc", "nulls": "last"}]},
    )
    assert manager.inspect_step(session_id, revision, "copy-id", 0, 1) == original
    assert __main__.inspection_calls == 3  # The refused different inspection ran Custom once.
    del boundary

    manager.inspect_step(session_id, revision, "alternate-order", 0, 1, 0, 1)
    manager.inspect_step(session_id, revision, "alternate-order", 0, 1, 1, 1)
    assert __main__.inspection_calls == 4  # The selected Custom itself is also retained.
    gc.collect()
    assert all(frame() is None for frame in frames)

    manager.inspect_step(session_id, revision, "copy-id", 0, 1)
    assert __main__.inspection_calls == 5
    assert session.inspection_boundary is not None
    frames = [
        retained_storage_ref(session.inspection_boundary.before),
        retained_storage_ref(session.inspection_boundary.after),
    ]
    preview = manager.preview_step(session_id, revision, edit, 0, 1)
    assert session.inspection_boundary is None
    gc.collect()
    assert all(frame() is None for frame in frames)
    manager.inspect_step(session_id, preview["revision"], "copy-id", 0, 1)
    assert session.inspection_boundary is not None
    frames = [
        retained_storage_ref(session.inspection_boundary.before),
        retained_storage_ref(session.inspection_boundary.after),
    ]
    discarded = manager.discard_draft(session_id, preview["revision"], 0, 1)
    assert session.inspection_boundary is None
    gc.collect()
    assert all(frame() is None for frame in frames)

    manager.inspect_step(session_id, discarded["revision"], "copy-id", 0, 1)
    assert session.inspection_boundary is not None
    frames = [
        retained_storage_ref(session.inspection_boundary.before),
        retained_storage_ref(session.inspection_boundary.after),
    ]
    manager.close_session(session_id, discarded["revision"])
    assert session.inspection_boundary is None
    gc.collect()
    assert all(frame() is None for frame in frames)


@pytest.mark.parametrize("invalidation", ["before-read", "during-read", "failed-edit"])
def test_custom_inspection_source_invalidation_releases_retained_frames(
    custom_inspection_session, monkeypatch: pytest.MonkeyPatch, invalidation: str
) -> None:
    manager, session, path = custom_inspection_session
    session_id, revision = session.session_id, session.revision
    manager.inspect_step(session_id, revision, "copy-id", 0, 1)
    assert session.inspection_boundary is not None
    frames = [
        retained_storage_ref(session.inspection_boundary.before),
        retained_storage_ref(session.inspection_boundary.after),
    ]

    def replace_source() -> None:
        replacement = path.with_name("replacement.csv")
        replacement.write_bytes(path.read_bytes())
        replacement.replace(path)

    if invalidation == "before-read":
        replace_source()
    elif invalidation == "during-read":
        page = session.engine.page

        def replace_after_page(*args: Any, **kwargs: Any) -> Any:
            result = page(*args, **kwargs)
            replace_source()
            return result

        monkeypatch.setattr(session.engine, "page", replace_after_page)

    def fail_after_replacement(_response: Any) -> None:
        replace_source()
        raise EngineError("edit response failed after source replacement")

    with pytest.raises(SourceChangedError, match="Reopen"):
        if invalidation == "failed-edit":
            manager.undo_step(session_id, revision, 0, 1, response_preflight=fail_after_replacement)
        else:
            manager.inspect_step(session_id, revision, "copy-id", 0, 1)
    assert session.revision == revision
    assert session.inspection_boundary is None
    gc.collect()
    assert all(frame() is None for frame in frames)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_step_inspection_projects_each_boundary_as_its_own_contiguous_window(
    backend: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / f"inspection-projection-{backend}.csv"
    path.write_text("first,second,third\na,b,c\n", encoding="utf-8")
    if backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Inspection must stay native")),
            raising=False,
        )

    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]
    revision = apply_step(
        manager,
        session_id,
        0,
        step(
            "reverse",
            "selectColumns",
            columns=[
                {"id": "c:source:2", "name": "third"},
                {"id": "c:source:1", "name": "second"},
                {"id": "c:source:0", "name": "first"},
            ],
        ),
    )

    inspection = manager.inspect_step(
        session_id,
        revision,
        "reverse",
        0,
        1,
        column_offset=0,
        column_limit=1,
    )

    assert inspection["inputPage"]["columnIds"] == ["c:source:0"]
    assert inspection["outputPage"]["columnIds"] == ["c:source:2"]
    assert inspection["inputPage"]["rows"][0]["values"][0]["display"] == "a"
    assert inspection["outputPage"]["rows"][0]["values"][0]["display"] == "c"
    assert inspection["diff"]["changedCells"] == 0
    assert inspection["diff"]["cells"] == []
    assert inspection["diff"]["truncated"] is True

    manager.close_session(session_id, revision)


def test_step_inspection_marks_a_nonzero_final_block_as_truncated(tmp_path: Path) -> None:
    path = tmp_path / "inspection-final-block.csv"
    path.write_text("value\n1.2\n2.8\n3.4\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend="pandas",
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]
    revision = apply_step(
        manager,
        session_id,
        0,
        step(
            "round-value",
            "roundNumber",
            column={"id": "c:source:0", "name": "value"},
            decimals=0,
        ),
    )

    inspection = manager.inspect_step(session_id, revision, "round-value", 2, 1)

    assert inspection["inputPage"]["totalRows"] == 3
    assert inspection["inputPage"]["offset"] == 2
    assert len(inspection["inputPage"]["rows"]) == 1
    assert inspection["diff"]["changedCells"] == 1
    assert inspection["diff"]["truncated"] is True

    manager.close_session(session_id, revision)


def test_step_ids_are_unique_and_inspection_errors_leave_state_unchanged(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "inspection-errors.csv"
    path.write_text("value\n1\n2\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend="pandas",
        page_size=2,
    )
    session_id = opened["metadata"]["sessionId"]
    revision = apply_step(
        manager,
        session_id,
        0,
        step(
            "stable-id",
            "formula",
            leftColumn={"id": "c:source:0", "name": "value"},
            operator="multiply",
            value=2,
            newColumn="doubled",
        ),
    )
    session = manager.sessions[session_id]
    before = observable_state(session)

    with pytest.raises(EngineError, match="Applied step IDs must be unique: stable-id"):
        manager.preview_step(
            session_id,
            revision,
            step(
                "stable-id",
                "roundNumber",
                column={"id": "c:source:0", "name": "value"},
                decimals=0,
            ),
            0,
            2,
        )
    with pytest.raises(EngineError, match="Unknown applied step: missing"):
        manager.inspect_step(session_id, revision, "missing", 0, 2)
    with pytest.raises(EngineError, match="Stale session revision"):
        manager.inspect_step(session_id, revision - 1, "stable-id", 0, 2)

    monkeypatch.setattr(
        session.engine,
        "compile_plan",
        lambda _steps: (_ for _ in ()).throw(EngineError("inspection code failed")),
    )
    with pytest.raises(EngineError, match="inspection code failed"):
        manager.inspect_step(session_id, revision, "stable-id", 0, 2)
    assert observable_state(session) == before

    monkeypatch.undo()
    revision = apply_step(
        manager,
        session_id,
        revision,
        step(
            "second-id",
            "roundNumber",
            column={"id": "c:source:0", "name": "value"},
            decimals=0,
        ),
    )
    session.plan[1]["id"] = "stable-id"
    with pytest.raises(EngineError, match="Applied step ID is not unique: stable-id"):
        manager.inspect_step(session_id, revision, "stable-id", 0, 2)
    session.plan[1]["id"] = "second-id"
    manager.close_session(session_id, revision)


def test_step_inspection_serializes_with_plan_mutation(tmp_path: Path) -> None:
    path = tmp_path / "inspection-concurrency.csv"
    path.write_text("value\n1\n2\n", encoding="utf-8")
    inspection_started = threading.Event()
    release_inspection = threading.Event()

    class BlockingInspectionEngine(PandasEngine):
        block_inspection = False

        def apply_transform(self, frame: Any, step: Any) -> Any:
            if self.block_inspection:
                inspection_started.set()
                if not release_inspection.wait(2):
                    raise TimeoutError("Inspection was not released.")
            return super().apply_transform(frame, step)

    manager = SessionManager(EngineRegistry((("pandas", BlockingInspectionEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend="pandas",
        page_size=2,
    )
    session_id = opened["metadata"]["sessionId"]
    revision = apply_step(
        manager,
        session_id,
        0,
        step(
            "round-value",
            "roundNumber",
            column={"id": "c:source:0", "name": "value"},
            decimals=0,
        ),
    )
    engine = manager.sessions[session_id].engine
    assert isinstance(engine, BlockingInspectionEngine)
    engine.block_inspection = True

    with ThreadPoolExecutor(max_workers=2) as executor:
        inspection = executor.submit(manager.inspect_step, session_id, revision, "round-value", 0, 2)
        assert inspection_started.wait(1)
        undo = executor.submit(manager.undo_step, session_id, revision, 0, 2)
        with pytest.raises(TimeoutError):
            undo.result(timeout=0.05)

        release_inspection.set()
        assert inspection.result(timeout=1)["revision"] == revision
        assert undo.result(timeout=1)["revision"] == revision + 1

    assert manager.sessions[session_id].plan == []
    manager.close_session(session_id, revision + 1)
