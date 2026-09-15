from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any, cast

import duckdb
import pandas as pd
import polars as pl
import pytest
from polars.testing import assert_frame_equal as assert_polars_frame_equal

from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines import EngineError
from openwrangler_runtime.engines.base import INTERNAL_ROW_ID_PREFIX
from openwrangler_runtime.export_target import _regular_file_identity
from openwrangler_runtime.session import SessionManager


def ref(identifier: str, name: str) -> dict[str, str]:
    return {"id": identifier, "name": name}


def step(step_id: str, kind: str, **params: Any) -> dict[str, Any]:
    return {"id": step_id, "kind": kind, "params": params}


def open_session(tmp_path: Path, backend: str = "pandas") -> tuple[SessionManager, str, list[dict[str, Any]]]:
    path = tmp_path / f"bound-{backend}.csv"
    path.write_text("name,value\na,1\nb,2\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    return manager, opened["metadata"]["sessionId"], opened["metadata"]["schema"]


def contains_private_position(value: Any) -> bool:
    if isinstance(value, dict):
        return "position" in value or any(contains_private_position(item) for item in value.values())
    if isinstance(value, list):
        return any(contains_private_position(item) for item in value)
    return False


def test_polars_literal_column_names_survive_session_apply_history_and_generated_code(tmp_path: Path) -> None:
    source = pl.DataFrame({"^a.*$": [1, 2, None], "amount": [20, 30, 40], "*": [3, 1, 2]})
    before = source.clone()
    path = tmp_path / "literal-columns.parquet"
    source.write_parquet(path)
    contents, stat = path.read_bytes(), path.stat()
    manager = SessionManager()
    try:
        opened = manager.open_session({"kind": "file", "path": str(path)}, backend="polars", mode="editing")
        sid = opened["metadata"]["sessionId"]
        schema = opened["metadata"]["schema"]
        assert [column["name"] for column in schema] == source.columns
        assert [column["id"] for column in schema] == ["c:source:0", "c:source:1", "c:source:2"]
        original_rows = opened["page"]["rows"]
        revision = 0
        for source_index, identifier, output in [(0, "pattern", "copy pattern"), (2, "star", "copy star")]:
            public = step(
                identifier,
                "cloneColumn",
                column=ref(schema[source_index]["id"], schema[source_index]["name"]),
                newName=output,
            )
            preview = manager.preview_step(sid, revision, public, 0, 10)
            assert preview["metadata"]["draftStep"] == public
            assert preview["metadata"]["schema"][-1]["id"] == f"c:step:{identifier}:0"
            assert [row["values"][-1] for row in preview["page"]["rows"]] == [
                row["values"][source_index] for row in original_rows
            ]
            applied = manager.apply_draft(sid, preview["revision"], 0, 10)
            revision = applied["revision"]
            assert applied["metadata"]["schema"][:3] == schema
            assert [row["id"] for row in applied["page"]["rows"]] == [row["id"] for row in original_rows]
            assert [row["rowNumber"] for row in applied["page"]["rows"]] == [0, 1, 2]
            assert not contains_private_position(applied["metadata"]["steps"])
        undone = manager.undo_step(sid, revision, 0, 10)
        assert [column["name"] for column in undone["metadata"]["schema"]] == [*source.columns, "copy pattern"]
        assert undone["metadata"]["schema"][-1]["id"] == "c:step:pattern:0"
        redone = manager.redo_step(sid, undone["revision"], 0, 10)
        assert redone["page"] == applied["page"]
        assert redone["code"] == applied["code"]
        assert [column["id"] for column in redone["metadata"]["schema"]][-2:] == ["c:step:pattern:0", "c:step:star:0"]
        namespace: dict[str, Any] = {}
        exec(redone["code"], namespace)
        generated = namespace["clean_data"](source.lazy()).collect()
        assert generated.rows() == [(1, 20, 3, 1, 3), (2, 30, 1, 2, 1), (None, 40, 2, None, 2)]
        assert generated.columns == [*source.columns, "copy pattern", "copy star"]
        assert all(generated.get_column(column).equals(source.get_column(column)) for column in source.columns)
        assert source.equals(before)
    finally:
        manager.close_all()
    assert not manager.sessions and path.read_bytes() == contents
    after = path.stat()
    assert (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == (
        stat.st_dev,
        stat.st_ino,
        stat.st_size,
        stat.st_mtime_ns,
    )


def test_polars_explode_list_singletons_report_replaced_rows(tmp_path: Path) -> None:
    path = tmp_path / "singletons.parquet"
    pl.DataFrame({"items": [[1], [2]]}).write_parquet(path)
    contents = path.read_bytes()
    manager = SessionManager()
    try:
        opened = manager.open_session({"kind": "file", "path": str(path)}, backend="polars", mode="editing")
        sid = opened["metadata"]["sessionId"]
        preview = manager.preview_step(sid, 0, step("explode", "explodeList", column=ref("c:source:0", "items")), 0, 10)
        assert [row["values"][0]["raw"] for row in preview["page"]["rows"]] == [1, 2]
        assert not {row["id"] for row in opened["page"]["rows"]}.intersection(
            row["id"] for row in preview["page"]["rows"]
        )
        assert preview["diff"] == {
            "addedRows": 2,
            "removedRows": 2,
            "addedColumns": [],
            "removedColumns": [],
            "changedCells": 0,
            "cells": [],
            "truncated": False,
        }
    finally:
        manager.close_all()
    assert path.read_bytes() == contents


def test_polars_explode_list_retains_history_fresh_ids_and_export(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import openwrangler_runtime.engines.polars_engine as polars_engine

    source = pl.DataFrame({"keep": [3, 2, 1], "*": [[30, None], [], None]})
    path = tmp_path / "lists.parquet"
    source.write_parquet(path)
    contents, stat = path.read_bytes(), path.stat()
    manager = SessionManager()
    try:
        opened = manager.open_session({"kind": "file", "path": str(path)}, backend="polars", mode="editing")
        sid, schema = opened["metadata"]["sessionId"], opened["metadata"]["schema"]
        assert "explodeList" in opened["metadata"]["capabilities"]["supportedOperations"]
        sort = step(
            "sort", "sortRows", rules=[{"column": ref(schema[0]["id"], "keep"), "direction": "asc", "nulls": "last"}]
        )
        sorting = manager.preview_step(sid, 0, sort, 0, 10)
        sorted_result = manager.apply_draft(sid, sorting["revision"], 0, 10)
        public = step("explode", "explodeList", column=ref(schema[1]["id"], "*"))
        preview = manager.preview_step(sid, sorted_result["revision"], public, 0, 10)
        assert preview["metadata"]["draftStep"] == public
        assert preview["metadata"]["capabilities"]["lazy"] is True
        wanted = [[1, None], [2, None], [3, 30], [3, None]]
        assert [[cell["raw"] for cell in row["values"]] for row in preview["page"]["rows"]] == wanted
        assert (preview["diff"]["addedRows"], preview["diff"]["removedRows"]) == (4, 3)
        ids = [row["id"] for row in preview["page"]["rows"]]
        assert len(set(ids)) == 4 and not set(ids).intersection(row["id"] for row in sorted_result["page"]["rows"])
        assert [row["rowNumber"] for row in preview["page"]["rows"]] == [0, 1, 2, 3]
        assert [(col["id"], col["name"]) for col in preview["metadata"]["schema"]] == [
            (col["id"], col["name"]) for col in schema
        ]
        assert preview["metadata"]["schema"][1]["type"] == "integer"
        discarded = manager.discard_draft(sid, preview["revision"], 0, 10)
        assert discarded["page"] == sorted_result["page"]
        # A refusal leaves the confirmed plan, native frame and revision intact.
        session = manager.sessions[sid]
        committed, revision = session.committed, session.revision
        with monkeypatch.context() as patch:
            patch.setattr(polars_engine, "_POLARS_EXPLODE_MAX_ROWS", 3)
            with pytest.raises(EngineError, match="3.*row"):
                manager.preview_step(sid, revision, public, 0, 10)
        assert session.committed is committed and session.revision == revision and session.draft_frame is None
        assert session.plan == [sort]
        preview = manager.preview_step(sid, revision, public, 0, 10)
        draft = session.draft_frame
        applied = manager.apply_draft(sid, preview["revision"], 0, 10)
        assert session.committed is draft and applied["metadata"]["steps"] == [sort, public]
        assert [row["id"] for row in applied["page"]["rows"]] == ids
        assert not contains_private_position(applied["metadata"]["steps"])
        undone = manager.undo_step(sid, applied["revision"], 0, 10)
        assert undone["page"] == sorted_result["page"]
        redone = manager.redo_step(sid, undone["revision"], 0, 10)
        assert redone["page"] == applied["page"] and redone["code"] == applied["code"]
        replayed, lineage, shape, replay_schema = manager._replay(session, session.bound_plan)
        assert shape == {"rows": 4, "columns": 2}
        assert lineage == session.committed_lineage and replay_schema == session.committed_schema
        assert_polars_frame_equal(replayed.collect(), session.committed.collect())
        expected = pl.DataFrame({"keep": [1, 2, 3, 3], "*": [None, None, 30, None]})
        namespace: dict[str, Any] = {}
        exec(redone["code"], namespace)
        assert_polars_frame_equal(namespace["clean_data"](pl.scan_parquet(path)).collect(), expected)
        output = tmp_path / "exploded.parquet"
        output.touch(exist_ok=False)
        device, inode = _regular_file_identity(output)
        manager.export_data(
            sid, redone["revision"], str(output), {"format": "parquet"}, {"device": str(device), "inode": str(inode)}
        )
        assert_polars_frame_equal(pl.read_parquet(output), expected)
        for backend in ("pandas", "duckdb"):
            other = manager.open_session({"kind": "file", "path": str(path)}, backend=backend, mode="editing")
            assert "explodeList" not in other["metadata"]["capabilities"]["supportedOperations"]
            other_id = other["metadata"]["sessionId"]
            target = other["metadata"]["schema"][1]
            with pytest.raises(EngineError):
                manager.preview_step(
                    other_id, 0, step("unsupported", "explodeList", column=ref(target["id"], target["name"])), 0, 10
                )
            assert manager.sessions[other_id].revision == 0 and manager.sessions[other_id].plan == []
    finally:
        manager.close_all()
    assert not manager.sessions and path.read_bytes() == contents
    after = path.stat()
    assert (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == (
        stat.st_dev,
        stat.st_ino,
        stat.st_size,
        stat.st_mtime_ns,
    )
    assert_polars_frame_equal(source, pl.read_parquet(path))


@pytest.mark.parametrize("backend", ["polars", "duckdb"])
def test_extract_struct_fields_preserves_parent_rows_and_appended_identity_through_history_and_export(
    tmp_path: Path, backend: str
) -> None:
    path = tmp_path / "addresses.parquet"
    connection = duckdb.connect() if backend == "duckdb" else None
    manager = SessionManager()
    try:
        if connection is None:
            source = pl.DataFrame(
                {"address": [{"city": "Rome", "zip": 100}, None, {"city": None, "zip": 200}], "order": [2, 1, 3]}
            )
            source.write_parquet(path)
        else:
            connection.sql(
                "SELECT CASE WHEN i = 1 THEN NULL ELSE struct_pack("
                "city := CASE WHEN i = 0 THEN 'Rome' ELSE NULL END, zip := CASE WHEN i = 0 THEN 100 ELSE 200 END) "
                'END AS address, CASE WHEN i = 0 THEN 2 WHEN i = 1 THEN 1 ELSE 3 END AS "order" '
                "FROM range(3) t(i)"
            ).write_parquet(str(path))
        original, stat = path.read_bytes(), path.stat()
        opened = manager.open_session(
            {"kind": "file", "path": str(path)}, backend=backend, mode="editing", page_size=10
        )
        sid, schema = opened["metadata"]["sessionId"], opened["metadata"]["schema"]
        assert "extractStructFields" in opened["metadata"]["capabilities"]["supportedOperations"]
        public = step(
            "address-fields",
            "extractStructFields",
            column=ref(schema[0]["id"], "address"),
            fields=[{"field": "zip", "newColumn": "postal"}, {"field": "city", "newColumn": "city name"}],
        )
        preview = manager.preview_step(sid, 0, public, 0, 10)
        assert manager.sessions[sid].plan == []
        assert preview["metadata"]["draftStep"] == public
        applied = manager.apply_draft(sid, preview["revision"], 0, 10)
        assert applied["metadata"]["schema"][:2] == schema
        assert [(c["name"], c["id"]) for c in applied["metadata"]["schema"][2:]] == [
            ("postal", "c:step:address-fields:0"),
            ("city name", "c:step:address-fields:1"),
        ]
        assert [row["id"] for row in applied["page"]["rows"]] == [row["id"] for row in opened["page"]["rows"]]
        assert [row["values"][:2] for row in applied["page"]["rows"]] == [
            row["values"] for row in opened["page"]["rows"]
        ]
        assert [[v["raw"] for v in row["values"][2:]] for row in applied["page"]["rows"]] == [
            [100, "Rome"],
            [None, None],
            [200, None],
        ]
        assert applied["metadata"]["steps"] == [public]
        assert not contains_private_position(applied["metadata"]["steps"])
        undone = manager.undo_step(sid, applied["revision"], 0, 10)
        assert undone["metadata"]["schema"] == schema
        assert undone["page"] == opened["page"]
        redone = manager.redo_step(sid, undone["revision"], 0, 10)
        assert redone["page"] == applied["page"]
        assert redone["code"] == applied["code"]
        target = tmp_path / "extracted.parquet"
        target.touch(exist_ok=False)
        device, inode = _regular_file_identity(target)
        manager.export_data(
            sid, redone["revision"], str(target), {"format": "parquet"}, {"device": str(device), "inode": str(inode)}
        )
        namespace: dict[str, Any] = {}
        exec(redone["code"], namespace)
        if connection is None:
            generated = namespace["clean_data"](pl.scan_parquet(path)).collect()
            assert_polars_frame_equal(pl.read_parquet(target), generated)
            assert_polars_frame_equal(generated.select("address", "order"), pl.read_parquet(path))
        else:
            source_relation = connection.read_parquet(str(path))
            generated = namespace["clean_data"](source_relation)
            exported = connection.read_parquet(str(target))
            assert exported.columns == generated.columns == ["address", "order", "postal", "city name"]
            assert exported.types == generated.types
            assert exported.fetchall() == generated.fetchall()
            assert [row[:2] for row in generated.fetchall()] == source_relation.fetchall()
        assert path.read_bytes() == original
        after = path.stat()
        assert (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == (
            stat.st_dev,
            stat.st_ino,
            stat.st_size,
            stat.st_mtime_ns,
        )
    finally:
        manager.close_all()
        if connection is not None:
            connection.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_conditional_column_retains_output_identity_through_edit_and_replay(tmp_path: Path, backend: str) -> None:
    path = tmp_path / f"conditional-{backend}.csv"
    original = b"name,value\na,1\nb,3\nc,\n"
    path.write_bytes(original)
    identity = (path.stat().st_dev, path.stat().st_ino)
    manager = SessionManager()
    try:
        opened = manager.open_session({"kind": "file", "label": path.name, "path": str(path)}, backend=backend)
        sid = opened["metadata"]["sessionId"]
        schema = opened["metadata"]["schema"]
        value = schema[1]
        public = step(
            "label",
            "conditionalColumn",
            column=ref(value["id"], value["name"]),
            columnType=value["type"],
            predicate={"kind": "predicate", "operator": "gt", "value": "2"},
            newColumn="label",
            resultType="string",
            trueValue="high",
            falseValue="",
            missingValue=None,
        )
        preview = manager.preview_step(sid, 0, public, 0, 10)
        assert manager.sessions[sid].plan == []
        assert preview["metadata"]["schema"][-1]["id"] == "c:step:label:0"
        assert preview["metadata"]["draftStep"] == public
        applied = manager.apply_draft(sid, preview["revision"], 0, 10)
        assert applied["metadata"]["schema"][:2] == schema
        assert [(row["values"][2]["kind"], row["values"][2]["raw"]) for row in applied["page"]["rows"]] == [
            ("string", ""),
            ("string", "high"),
            ("null", None),
        ]
        assert applied["metadata"]["steps"] == [public]
        assert not contains_private_position(applied["metadata"]["steps"])
        undone = manager.undo_step(sid, applied["revision"], 0, 10)
        assert undone["metadata"]["schema"] == schema
        redone = manager.redo_step(sid, undone["revision"], 0, 10)
        assert redone["page"] == applied["page"]
        assert redone["code"] == applied["code"]
        assert redone["metadata"]["steps"] == [public]
        edited = {**public, "params": {**public["params"], "trueValue": "large"}}
        preview_edit = manager.preview_step(sid, redone["revision"], edited, 0, 10, replace_step_id="label")
        confirmed = manager.apply_draft(sid, preview_edit["revision"], 0, 10)
        assert confirmed["metadata"]["schema"][-1]["id"] == "c:step:label:0"
        assert [(row["values"][2]["kind"], row["values"][2]["raw"]) for row in confirmed["page"]["rows"]] == [
            ("string", ""),
            ("string", "large"),
            ("null", None),
        ]
        assert confirmed["metadata"]["steps"] == [edited]
        assert path.read_bytes() == original
        assert (path.stat().st_dev, path.stat().st_ino) == identity
    finally:
        manager.close_all()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_bound_plan_survives_apply_replay_inspection_edit_and_undo(tmp_path: Path, backend: str) -> None:
    manager, session_id, schema = open_session(tmp_path, backend)
    value = ref(schema[1]["id"], schema[1]["name"])

    rename = step("rename", "renameColumn", column=value, newName="amount")
    preview = manager.preview_step(session_id, 0, rename, 0, 10)
    runtime = manager.sessions[session_id]
    assert runtime.draft_bound_step is not None
    assert runtime.draft_bound_step["params"]["column"] == {**value, "position": 1}
    assert not contains_private_position(preview["metadata"]["draftStep"])

    applied = manager.apply_draft(session_id, 1, 0, 10)
    assert runtime.plan == [rename]
    assert runtime.bound_plan[0]["params"]["column"] == {**value, "position": 1}
    assert not contains_private_position(applied["metadata"]["steps"])

    amount = ref(value["id"], "amount")
    formula = step(
        "double",
        "formula",
        leftColumn=amount,
        operator="multiply",
        value=2,
        newColumn="double",
    )
    manager.preview_step(session_id, 2, formula, 0, 10)
    manager.apply_draft(session_id, 3, 0, 10)

    inspected = manager.inspect_step(session_id, 4, "rename", 0, 10)
    assert [column["name"] for column in inspected["outputSchema"]] == ["name", "amount"]
    assert "def clean_data" in inspected["code"]

    undone = manager.undo_step(session_id, 4, 0, 10)
    assert undone["revision"] == 5
    assert [column["name"] for column in undone["metadata"]["schema"]] == ["name", "amount"]
    assert len(runtime.bound_plan) == len(runtime.plan) == 1

    edited = manager.preview_step(
        session_id,
        5,
        step("rename", "renameColumn", column=value, newName="measure"),
        0,
        10,
        replace_step_id="rename",
    )
    assert [column["name"] for column in edited["metadata"]["schema"]] == ["name", "measure"]


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_group_and_by_example_bind_replay_inspect_and_undo_without_leaking_positions(
    tmp_path: Path, backend: str
) -> None:
    path = tmp_path / f"group-example-binding-{backend}.csv"
    original = "group,value\na,1\na,2\nb,3\n"
    path.write_text(original, encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    group = ref(opened["metadata"]["schema"][0]["id"], "group")
    value = ref(opened["metadata"]["schema"][1]["id"], "value")
    runtime = manager.sessions[session_id]

    grouped_step = step(
        "grouped",
        "groupBy",
        keys=[group],
        aggregations=[
            {"column": value, "operation": "sum", "alias": "total"},
            {"column": value, "operation": "mean", "alias": "average"},
        ],
    )
    preview = manager.preview_step(session_id, 0, grouped_step, 0, 10)
    assert runtime.draft_bound_step is not None
    assert runtime.draft_bound_step["params"]["keys"] == [{**group, "position": 0}]
    assert [item["column"] for item in runtime.draft_bound_step["params"]["aggregations"]] == [
        {**value, "position": 1},
        {**value, "position": 1},
    ]
    assert not contains_private_position(preview["metadata"]["draftStep"])
    applied = manager.apply_draft(session_id, 1, 0, 10)
    assert not contains_private_position(applied["metadata"]["steps"])
    inspection = manager.inspect_step(session_id, 2, "grouped", 0, 10)
    assert [column["name"] for column in inspection["outputSchema"]] == ["group", "total", "average"]
    assert "def clean_data" in inspection["code"]

    undone = manager.undo_step(session_id, 2, 0, 10)
    assert undone["revision"] == 3
    assert [column["name"] for column in undone["metadata"]["schema"]] == ["group", "value"]

    example_step = step(
        "combined",
        "byExample",
        sourceColumns=[group, value],
        newColumn="label",
        examples=[
            {"inputs": ["a", 1], "output": "a1"},
            {"inputs": ["b", 3], "output": "b3"},
        ],
    )
    preview = manager.preview_step(session_id, 3, example_step, 0, 10)
    assert runtime.draft_bound_step is not None
    assert runtime.draft_bound_step["params"]["sourceColumns"] == [
        {**group, "position": 0},
        {**value, "position": 1},
    ]
    assert not contains_private_position(preview["metadata"]["draftStep"])
    assert [row["values"][2]["display"] for row in preview["page"]["rows"]] == ["a1", "a2", "b3"]
    applied = manager.apply_draft(session_id, 4, 0, 10)
    assert not contains_private_position(applied["metadata"]["steps"])
    inspection = manager.inspect_step(session_id, 5, "combined", 0, 10)
    assert [column["name"] for column in inspection["outputSchema"]] == ["group", "value", "label"]
    assert "def clean_data" in inspection["code"]

    undone = manager.undo_step(session_id, 5, 0, 10)
    assert undone["revision"] == 6
    assert [column["name"] for column in undone["metadata"]["schema"]] == ["group", "value"]
    assert path.read_text(encoding="utf-8") == original
    redone = manager.redo_step(session_id, 6, 0, 10)
    assert redone["page"] == applied["page"]
    assert redone["code"] == applied["code"]
    assert redone["metadata"]["steps"] == applied["metadata"]["steps"]
    manager.close_session(session_id, 7)
    assert session_id not in manager.sessions


def test_edit_rejects_a_replacement_step_with_a_different_identity(tmp_path: Path) -> None:
    manager, session_id, schema = open_session(tmp_path)
    value = ref(schema[1]["id"], schema[1]["name"])
    manager.preview_step(session_id, 0, step("clone", "cloneColumn", column=value, newName="copy"), 0, 10)
    manager.apply_draft(session_id, 1, 0, 10)

    with pytest.raises(EngineError, match="must retain the applied step ID"):
        manager.preview_step(
            session_id,
            2,
            step("replacement", "cloneColumn", column=value, newName="copy"),
            0,
            10,
            replace_step_id="clone",
        )


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_edited_output_identity_remains_replayable_by_later_steps(tmp_path: Path, backend: str) -> None:
    manager, session_id, schema = open_session(tmp_path, backend)
    name = ref(schema[0]["id"], schema[0]["name"])
    manager.preview_step(session_id, 0, step("clone", "cloneColumn", column=name, newName="copy"), 0, 10)
    manager.apply_draft(session_id, 1, 0, 10)

    manager.preview_step(
        session_id,
        2,
        step("clone", "cloneColumn", column=name, newName="renamed_copy"),
        0,
        10,
        replace_step_id="clone",
    )
    edited = manager.apply_draft(session_id, 3, 0, 10)
    created = next(column for column in edited["metadata"]["schema"] if column["name"] == "renamed_copy")

    manager.preview_step(
        session_id,
        4,
        step("length", "textLength", column=ref(created["id"], created["name"]), newColumn="copy_length"),
        0,
        10,
    )
    manager.apply_draft(session_id, 5, 0, 10)
    undone = manager.undo_step(session_id, 6, 0, 10)

    assert [column["name"] for column in undone["metadata"]["schema"]] == ["name", "value", "renamed_copy"]
    assert [item["id"] for item in undone["metadata"]["steps"]] == ["clone"]


def test_stale_reference_is_rejected_before_adapter_dispatch(tmp_path: Path, monkeypatch) -> None:
    manager, session_id, schema = open_session(tmp_path)
    value = ref(schema[1]["id"], schema[1]["name"])

    manager.preview_step(session_id, 0, step("drop", "dropColumns", columns=[value]), 0, 10)
    manager.apply_draft(session_id, 1, 0, 10)
    runtime = manager.sessions[session_id]

    def unexpected_dispatch(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("stale references must fail before adapter dispatch")

    monkeypatch.setattr(runtime.engine, "apply_transform", unexpected_dispatch)
    with pytest.raises(EngineError, match="Unknown or stale column identity"):
        manager.preview_step(
            session_id,
            2,
            step("cast-stale", "castColumn", column=value, dtype="float"),
            0,
            10,
        )


def test_output_collision_is_rejected_before_adapter_dispatch(tmp_path: Path, monkeypatch) -> None:
    manager, session_id, schema = open_session(tmp_path)
    value = ref(schema[1]["id"], schema[1]["name"])
    runtime = manager.sessions[session_id]

    def unexpected_dispatch(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("output collisions must fail before adapter dispatch")

    monkeypatch.setattr(runtime.engine, "apply_transform", unexpected_dispatch)
    with pytest.raises(EngineError, match="collides with an existing column"):
        manager.preview_step(
            session_id,
            0,
            step("clone", "cloneColumn", column=value, newName="name"),
            0,
            10,
        )


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_pivot_wider_container_identifier_rejects_before_adapter_dispatch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    backend: str,
) -> None:
    path = tmp_path / f"pivot-wider-container-{backend}.jsonl"
    path.write_text(
        '{"identifier":[1],"key":"x","value":1}\n{"identifier":[1],"key":"y","value":2}\n',
        encoding="utf-8",
    )
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    schema = opened["metadata"]["schema"]
    runtime = manager.sessions[session_id]
    before = {
        "revision": runtime.revision,
        "plan": deepcopy(runtime.plan),
        "draft": deepcopy(runtime.draft_step),
        "schema": deepcopy(runtime.committed_schema),
        "cache": deepcopy(runtime.page_cache),
    }

    def unexpected_dispatch(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("Pivot wider container identifiers must fail before adapter dispatch")

    monkeypatch.setattr(runtime.engine, "apply_transform", unexpected_dispatch)
    names_from = next(column for column in schema if column["name"] == "key")
    values_from = next(column for column in schema if column["name"] == "value")

    def token(value: str) -> dict[str, Any]:
        return {
            "kind": "typedSelection",
            "version": 1,
            "columnType": "string",
            "cell": {"kind": "string", "raw": value, "display": value, "isNull": False, "isNaN": False},
        }

    operation = step(
        "pivot-wider-container",
        "pivotWider",
        namesFrom=ref(names_from["id"], names_from["name"]),
        valuesFrom=ref(values_from["id"], values_from["name"]),
        outputs=[
            {"key": token("x"), "name": "x_value"},
            {"key": token("y"), "name": "y_value"},
        ],
    )
    with pytest.raises(EngineError, match="identifier columns must use the portable group-key scalar family"):
        manager.preview_step(session_id, 0, operation, 0, 10)
    assert {
        "revision": runtime.revision,
        "plan": runtime.plan,
        "draft": runtime.draft_step,
        "schema": runtime.committed_schema,
        "cache": runtime.page_cache,
    } == before


def test_preview_failure_restores_private_bound_state(tmp_path: Path, monkeypatch) -> None:
    manager, session_id, schema = open_session(tmp_path)
    value = ref(schema[1]["id"], schema[1]["name"])
    runtime = manager.sessions[session_id]
    before = {
        "plan": deepcopy(runtime.plan),
        "boundPlan": deepcopy(runtime.bound_plan),
        "draft": deepcopy(runtime.draft_step),
        "boundDraft": deepcopy(runtime.draft_bound_step),
        "revision": runtime.revision,
    }

    def fail_compile(_steps: Any) -> str:
        raise EngineError("compile failed after draft publication")

    monkeypatch.setattr(runtime.engine, "compile_plan", fail_compile)
    with pytest.raises(EngineError, match="compile failed"):
        manager.preview_step(
            session_id,
            0,
            step("cast", "castColumn", column=value, dtype="float"),
            0,
            10,
        )

    assert {
        "plan": runtime.plan,
        "boundPlan": runtime.bound_plan,
        "draft": runtime.draft_step,
        "boundDraft": runtime.draft_bound_step,
        "revision": runtime.revision,
    } == before


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize("attack", ["overwrite", "aggregate"])
@pytest.mark.parametrize("case_variant", ["exact", "upper"])
def test_private_row_identity_cannot_be_named_by_legacy_operations(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    backend: str,
    attack: str,
    case_variant: str,
) -> None:
    manager, session_id, _ = open_session(tmp_path, backend)
    runtime = manager.sessions[session_id]
    hidden = f"{INTERNAL_ROW_ID_PREFIX}{session_id}:source"
    if case_variant == "upper":
        hidden = hidden.upper()
    malicious = (
        step("attack", "roundNumber", column=ref("c:source:1", "value"), newColumn=hidden)
        if attack == "overwrite"
        else step(
            "attack",
            "groupBy",
            keys=[ref("c:source:0", "name")],
            aggregations=[{"column": ref("private-row-id", hidden), "operation": "first", "alias": "leaked"}],
        )
    )
    before = {
        "revision": runtime.revision,
        "cache": deepcopy(runtime.page_cache),
        "cacheBytes": runtime.page_cache_bytes,
        "lineage": deepcopy(runtime.committed_lineage),
    }

    def unexpected_dispatch(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("private namespace attacks must fail before adapter dispatch")

    monkeypatch.setattr(runtime.engine, "apply_transform", unexpected_dispatch)
    with pytest.raises(EngineError, match="reserved private row-identity prefix"):
        manager.preview_step(session_id, 0, malicious, 0, 10)

    assert {
        "revision": runtime.revision,
        "cache": runtime.page_cache,
        "cacheBytes": runtime.page_cache_bytes,
        "lineage": runtime.committed_lineage,
    } == before


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_drop_columns_must_retain_one_visible_column(tmp_path: Path, backend: str) -> None:
    manager, session_id, schema = open_session(tmp_path, backend)
    runtime = manager.sessions[session_id]
    references = [ref(column["id"], column["name"]) for column in schema]
    before_cache = deepcopy(runtime.page_cache)

    with pytest.raises(EngineError, match="must leave at least one visible column"):
        manager.preview_step(session_id, 0, step("drop-all", "dropColumns", columns=references), 0, 10)

    assert runtime.revision == 0
    assert runtime.draft_step is None
    assert runtime.page_cache == before_cache


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize("kind", ["oneHotEncode", "multiLabelBinarize"])
def test_every_transform_must_retain_one_visible_column(tmp_path: Path, backend: str, kind: str) -> None:
    path = tmp_path / f"zero-output-{backend}.csv"
    path.write_text("only\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    runtime = manager.sessions[session_id]
    operation = (
        step("empty-output", kind, columns=[ref("c:source:0", "only")], dropOriginal=True)
        if kind == "oneHotEncode"
        else step(
            "empty-output",
            kind,
            column=ref("c:source:0", "only"),
            delimiter="|",
            dropOriginal=True,
        )
    )
    before_cache = deepcopy(runtime.page_cache)

    with pytest.raises(EngineError, match="must leave at least one visible column"):
        manager.preview_step(session_id, 0, operation, 0, 10)

    assert runtime.revision == 0
    assert runtime.draft_step is None
    assert runtime.page_cache == before_cache


@pytest.mark.parametrize("backend", ["pandas", "polars", "polars-lazy"])
@pytest.mark.parametrize("kind", ["oneHotEncode", "multiLabelBinarize"])
@pytest.mark.parametrize("values", [[], [None, None], ["", ""]])
def test_generated_categorical_rechecks_no_indicator_result(backend, kind, values, monkeypatch) -> None:
    import __main__

    pandas = backend == "pandas"
    source: Any = (
        pd.DataFrame({"only": pd.Series(values, dtype="string")})
        if pandas
        else pl.DataFrame({"only": pl.Series(values, dtype=pl.String)})
    )
    if pandas:
        source.index = pd.Index([7] * len(values), name="source-row")
        source.attrs = {"origin": "categorical-source"}
    original = source.copy(deep=True) if pandas else source.clone()
    if backend == "polars-lazy":
        source = source.lazy()
    monkeypatch.setattr(__main__, "categorical_empty_source", source, raising=False)
    manager = SessionManager()
    try:
        opened = manager.open_session(
            {"kind": "notebookVariable", "variableName": "categorical_empty_source"},
            backend="pandas" if pandas else "polars",
            mode="editing",
        )
        metadata = opened["metadata"]
        session_id = metadata["sessionId"]
        runtime = manager.sessions[session_id]
        operation = (
            step("empty-output", kind, columns=[ref("c:source:0", "only")])
            if kind == "oneHotEncode"
            else step("empty-output", kind, column=ref("c:source:0", "only"), delimiter="|", dropOriginal=True)
        )
        before_cache = deepcopy(runtime.page_cache)
        with pytest.raises(EngineError, match="must leave at least one visible column"):
            manager.preview_step(session_id, 0, operation, 0, 10)
        assert runtime.revision == 0
        assert runtime.draft_step is None
        assert runtime.page_cache == before_cache

        bound = bind_step(operation, metadata["schema"], runtime.committed_lineage)
        caller_bindings = {"Any": object(), "is_internal_row_id_label": object()}
        namespace: dict[str, Any] = dict(caller_bindings)
        exec(runtime.engine.compile_plan([bound]), namespace)
        assert all(namespace[name] is value for name, value in caller_bindings.items())
        clean = namespace["clean_data"]
        with pytest.raises(ValueError, match="must leave at least one visible column"):
            clean(source)

        private_name = INTERNAL_ROW_ID_PREFIX.upper() + "SOURCE"
        private_names: list[Any] = [private_name, (private_name, "")] if pandas else [private_name]
        for name in private_names:
            private = original.copy(deep=True) if pandas else original.clone()
            if pandas:
                private[name] = range(len(values))
            else:
                private = private.with_columns(pl.Series(name, range(len(values))))
                if backend == "polars-lazy":
                    private = private.lazy()
            with pytest.raises(ValueError, match="must leave at least one visible column"):
                clean(private)

        if pandas:
            retained = original.assign(retained=pd.Series(range(len(values)), index=original.index, dtype="Int64"))
            pd.testing.assert_frame_equal(clean(retained), retained[["retained"]])
            pd.testing.assert_frame_equal(source, original)
            assert source.attrs == original.attrs
        else:
            retained = original.with_columns(pl.Series("retained", range(len(values)), dtype=pl.Int64))
            assert_polars_frame_equal(
                clean(retained.lazy() if backend == "polars-lazy" else retained), retained.select("retained")
            )
            assert_polars_frame_equal(source.collect() if isinstance(source, pl.LazyFrame) else source, original)
    finally:
        manager.close_all()
    assert not manager.sessions


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_custom_code_must_retain_one_visible_column(tmp_path: Path, backend: str) -> None:
    manager, session_id, _ = open_session(tmp_path, backend)
    runtime = manager.sessions[session_id]
    code = "result = df.iloc[:, 0:0]" if backend == "pandas" else "result = df.select([])"
    before = {
        "revision": runtime.revision,
        "draft": runtime.draft_step,
        "boundDraft": runtime.draft_bound_step,
        "cache": deepcopy(runtime.page_cache),
        "cacheBytes": runtime.page_cache_bytes,
        "lineage": deepcopy(runtime.committed_lineage),
        "shape": deepcopy(runtime.committed_shape),
        "schema": deepcopy(runtime.committed_schema),
    }
    committed = runtime.committed

    with pytest.raises(EngineError, match="must leave at least one visible column"):
        manager.preview_step(session_id, 0, step("empty-custom", "customCode", code=code), 0, 10)

    assert runtime.committed is committed
    assert {
        "revision": runtime.revision,
        "draft": runtime.draft_step,
        "boundDraft": runtime.draft_bound_step,
        "cache": runtime.page_cache,
        "cacheBytes": runtime.page_cache_bytes,
        "lineage": runtime.committed_lineage,
        "shape": runtime.committed_shape,
        "schema": runtime.committed_schema,
    } == before


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_existing_draft_cannot_be_replaced_by_another_preview(
    tmp_path: Path, backend: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, session_id, schema = open_session(tmp_path, backend)
    name = ref(schema[0]["id"], schema[0]["name"])
    manager.preview_step(session_id, 0, step("first", "cloneColumn", column=name, newName="copy"), 0, 10)
    runtime = manager.sessions[session_id]
    before = {
        "revision": runtime.revision,
        "draft": deepcopy(runtime.draft_step),
        "boundDraft": deepcopy(runtime.draft_bound_step),
        "cache": deepcopy(runtime.page_cache),
    }

    def unexpected_dispatch(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("a second preview must fail before adapter dispatch")

    monkeypatch.setattr(runtime.engine, "apply_transform", unexpected_dispatch)
    with pytest.raises(EngineError, match="Apply or discard the current draft"):
        manager.preview_step(session_id, 1, step("second", "cloneColumn", column=name, newName="other"), 0, 10)

    assert {
        "revision": runtime.revision,
        "draft": runtime.draft_step,
        "boundDraft": runtime.draft_bound_step,
        "cache": runtime.page_cache,
    } == before


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_dynamic_latest_step_edit_keeps_output_identities_replay_stable(tmp_path: Path, backend: str) -> None:
    path = tmp_path / f"dynamic-edit-{backend}.csv"
    path.write_text("left,right\nx,u\ny,v\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    manager.preview_step(
        session_id,
        0,
        step("hot", "oneHotEncode", columns=[ref("c:source:1", "right")], dropOriginal=False),
        0,
        10,
    )
    manager.apply_draft(session_id, 1, 0, 10)

    preview = manager.preview_step(
        session_id,
        2,
        step(
            "hot",
            "oneHotEncode",
            columns=[ref("c:source:0", "left"), ref("c:source:1", "right")],
            dropOriginal=False,
        ),
        0,
        10,
        replace_step_id="hot",
    )
    schema = preview["metadata"]["schema"]
    identities = [column["id"] for column in schema]
    assert len(identities) == len(set(identities))
    value_output = next(column for column in schema if column["name"] == "right_u")

    manager.apply_draft(session_id, 3, 0, 10)
    manager.preview_step(
        session_id,
        4,
        step(
            "select-output",
            "selectColumns",
            columns=[ref(value_output["id"], value_output["name"])],
        ),
        0,
        10,
    )
    manager.apply_draft(session_id, 5, 0, 10)
    undone = manager.undo_step(session_id, 6, 0, 10)

    assert [(column["id"], column["name"]) for column in undone["metadata"]["schema"]] == [
        (column["id"], column["name"]) for column in schema
    ]
    assert [item["id"] for item in undone["metadata"]["steps"]] == ["hot"]


def test_duplicate_encoder_edit_replay_and_undo_preserve_the_exact_surviving_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import __main__

    source = pd.DataFrame(
        [["left-a", "right-u", 1.2], ["left-b", "right-v", 2.8]],
        columns=cast(Any, ["duplicate", "duplicate", 7]),
    )
    monkeypatch.setattr(__main__, "stable_value_duplicate_frame", source, raising=False)
    manager = SessionManager()
    opened = manager.open_session(
        {
            "kind": "notebookVariable",
            "label": "stable_value_duplicate_frame",
            "variableName": "stable_value_duplicate_frame",
        },
        backend="pandas",
        mode="editing",
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    first = ref("c:source:0", "duplicate")
    second = ref("c:source:1", "duplicate")

    manager.preview_step(
        session_id,
        0,
        step("hot", "oneHotEncode", columns=[first], dropOriginal=True),
        0,
        10,
    )
    initial = manager.apply_draft(session_id, 1, 0, 10)
    assert [(column["id"], column["name"]) for column in initial["metadata"]["schema"][:2]] == [
        ("c:source:1", "duplicate"),
        ("c:source:2", "7"),
    ]

    manager.preview_step(
        session_id,
        2,
        step("hot", "oneHotEncode", columns=[second], dropOriginal=True),
        0,
        10,
        replace_step_id="hot",
    )
    edited = manager.apply_draft(session_id, 3, 0, 10)
    edited_schema = [(column["id"], column["name"]) for column in edited["metadata"]["schema"]]
    assert edited_schema[:2] == [("c:source:0", "duplicate"), ("c:source:2", "7")]
    assert any(name == "duplicate_right-u" for _, name in edited_schema)

    inspection = manager.inspect_step(session_id, 4, "hot", 0, 10)
    assert [(column["id"], column["name"]) for column in inspection["outputSchema"]] == edited_schema

    manager.preview_step(
        session_id,
        4,
        step("upper", "upperText", column=first, newColumn="upper_duplicate"),
        0,
        10,
    )
    manager.apply_draft(session_id, 5, 0, 10)
    undone = manager.undo_step(session_id, 6, 0, 10)

    assert [(column["id"], column["name"]) for column in undone["metadata"]["schema"]] == edited_schema
    pd.testing.assert_frame_equal(
        source,
        pd.DataFrame(
            [["left-a", "right-u", 1.2], ["left-b", "right-v", 2.8]],
            columns=cast(Any, ["duplicate", "duplicate", 7]),
        ),
    )
    manager.close_session(session_id, 7)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_cross_kind_latest_step_edit_does_not_reuse_a_live_source_identity(tmp_path: Path, backend: str) -> None:
    manager, session_id, schema = open_session(tmp_path, backend)
    name = ref(schema[0]["id"], schema[0]["name"])
    value = ref(schema[1]["id"], schema[1]["name"])
    manager.preview_step(
        session_id,
        0,
        step("edit", "renameColumn", column=value, newName="X"),
        0,
        10,
    )
    manager.apply_draft(session_id, 1, 0, 10)

    preview = manager.preview_step(
        session_id,
        2,
        step("edit", "cloneColumn", column=name, newName="X"),
        0,
        10,
        replace_step_id="edit",
    )
    identities = [column["id"] for column in preview["metadata"]["schema"]]

    assert len(identities) == len(set(identities))
    assert next(column for column in preview["metadata"]["schema"] if column["name"] == "X")["id"] not in {
        name["id"],
        value["id"],
    }


@pytest.mark.parametrize("kind", ["renameColumn", "cloneColumn", "formula", "textLength"])
def test_duckdb_rejects_case_folded_output_collisions_atomically(tmp_path: Path, kind: str) -> None:
    path = tmp_path / "duckdb-case.csv"
    path.write_text("A,b\n1,2\n3,4\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend="duckdb",
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    schema = opened["metadata"]["schema"]
    source = ref(schema[1]["id"], schema[1]["name"])
    params: dict[str, Any]
    if kind in {"renameColumn", "cloneColumn"}:
        params = {"column": source, "newName": "a"}
    elif kind == "formula":
        params = {"leftColumn": source, "operator": "add", "value": 0, "newColumn": "a"}
    else:
        params = {"column": source, "newColumn": "a"}
    runtime = manager.sessions[session_id]
    before_cache = deepcopy(runtime.page_cache)

    with pytest.raises(EngineError, match="differ only by case"):
        manager.preview_step(session_id, 0, step("casefold", kind, **params), 0, 10)

    assert runtime.revision == 0
    assert runtime.draft_step is None
    assert runtime.page_cache == before_cache


@pytest.mark.parametrize("change", ["reorder", "float", "nullable", "missing", "collision"])
def test_redo_rebinds_saved_by_example_without_reexecuting_custom_prefix(
    monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    import builtins

    import __main__

    source = pd.DataFrame({"left": pd.Series([10, 20], dtype="Int64"), "right": [90, 80]})
    original = source.copy(deep=True)
    state = {"changed": False, "calls": 0}
    monkeypatch.setattr(builtins, "_ow_redo_binding_state", state, raising=False)
    monkeypatch.setattr(__main__, "redo_binding_source", source, raising=False)
    changes = {
        "reorder": "result = result[['right', 'left']]",
        "float": "result['left'] = result['left'].astype('Float64') + 0.5",
        "nullable": "result['left'] = pd.Series([10, pd.NA], dtype='Int64')",
        "missing": "result = result[['right']]",
        "collision": "result['derived'] = 999",
    }
    code = (
        "import builtins\nstate = builtins._ow_redo_binding_state\nstate['calls'] += 1\n"
        f"result = df.copy()\nif state['changed']:\n    {changes[change]}"
    )
    manager = SessionManager()
    try:
        opened = manager.open_session(
            {"kind": "notebookVariable", "variableName": "redo_binding_source"}, backend="pandas", mode="editing"
        )
        sid = opened["metadata"]["sessionId"]
        session = manager.sessions[sid]
        manager.preview_step(sid, 0, step("prefix", "customCode", code=code), 0, 10)
        manager.apply_draft(sid, 1, 0, 10)
        example = step(
            "saved",
            "byExample",
            sourceColumns=[ref("c:source:0", "left")],
            newColumn="derived",
            examples=[{"inputs": [10], "output": 11}, {"inputs": [20], "output": 21}],
        )
        manager.preview_step(sid, 2, example, 0, 10)
        manager.apply_draft(sid, 3, 0, 10)
        public = deepcopy(session.plan[-1])
        state["changed"] = True
        manager.undo_step(sid, 4, 0, 10)
        assert state["calls"] == 2
        before = session.committed
        if change in {"missing", "collision"}:
            with pytest.raises(EngineError, match="stale column identity|collides"):
                manager.redo_step(sid, 5, 0, 10)
            assert session.committed is before and session.revision == 5
            assert session.undone_steps == [public] and state["calls"] == 2
        else:
            redone = manager.redo_step(sid, 5, 0, 10)
            assert state["calls"] == 2 and session.plan[-1] == public
            assert redone["revision"] == 6 and redone["metadata"]["canRedo"] is False
            expected = [11.5, 21.5] if change == "float" else [11, None] if change == "nullable" else [11, 21]
            assert session.committed["derived"].fillna(-1).tolist() == [
                value if value is not None else -1 for value in expected
            ]
            if change == "reorder":
                assert session.bound_plan[-1]["params"]["sourceColumns"][0]["position"] == 1
            if change == "float":
                assert session.bound_plan[-1]["params"]["program"]["_owLeftType"] == "float"
            namespace: dict[str, Any] = {}
            exec(redone["code"], namespace)
            generated = namespace["clean_data"](source)
            pd.testing.assert_frame_equal(generated, session.committed.loc[:, generated.columns])
        pd.testing.assert_frame_equal(source, original)
    finally:
        manager.close_all()


def test_redo_preserves_duplicate_occurrence_binding_and_index(monkeypatch: pytest.MonkeyPatch) -> None:
    import __main__

    source = pd.DataFrame(
        [[1, 10], [2, 20]], columns=pd.Index(["same", "same"]), index=pd.Index(["x", "x"], name="rows")
    )
    original = source.copy(deep=True)
    monkeypatch.setattr(__main__, "redo_duplicate_source", source, raising=False)
    manager = SessionManager()
    try:
        opened = manager.open_session(
            {"kind": "notebookVariable", "variableName": "redo_duplicate_source"}, backend="pandas", mode="editing"
        )
        sid = opened["metadata"]["sessionId"]
        manager.preview_step(
            sid, 0, step("copy", "cloneColumn", column=ref("c:source:1", "same"), newName="selected"), 0, 10
        )
        manager.apply_draft(sid, 1, 0, 10)
        manager.undo_step(sid, 2, 0, 10)
        redone = manager.redo_step(sid, 3, 0, 10)
        session = manager.sessions[sid]
        assert session.committed["selected"].tolist() == [10, 20]
        namespace: dict[str, Any] = {}
        exec(redone["code"], namespace)
        pd.testing.assert_frame_equal(namespace["clean_data"](source), source.assign(selected=[10, 20]))
        pd.testing.assert_frame_equal(source, original)
    finally:
        manager.close_all()
