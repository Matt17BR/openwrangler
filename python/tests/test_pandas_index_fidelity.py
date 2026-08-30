from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

import pandas as pd
import pytest

import openwrangler_runtime.session as session_runtime
from openwrangler_runtime.engines import EngineError
from openwrangler_runtime.engines.base import RowAxisExportPolicy
from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.export_target import _regular_file_identity
from openwrangler_runtime.session import SessionManager


def notebook_source() -> dict[str, str]:
    return {
        "kind": "notebookVariable",
        "label": "indexed_frame",
        "variableName": "indexed_frame",
        "uri": "file:///workspace/index-fidelity.ipynb",
    }


def open_frame(
    manager: SessionManager,
    monkeypatch: pytest.MonkeyPatch,
    frame: pd.DataFrame,
) -> dict[str, Any]:
    monkeypatch.setattr(session_runtime, "resolve_notebook_variable", lambda _source: frame)
    return manager.open_session(notebook_source(), backend="pandas", page_size=20, mode="editing")


def reserve_export_target(path: Path) -> dict[str, str]:
    path.touch(exist_ok=False)
    device, inode = _regular_file_identity(path)
    return {"device": str(device), "inode": str(inode)}


def test_named_index_metadata_and_labels_follow_the_exact_filtered_sorted_slice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frame = pd.DataFrame(
        [[10, 100, 2], [20, 200, 3], [30, 300, 1]],
        columns=pd.Index(["score", "score", 7], dtype="object"),
        index=pd.Index([101, 101, None], dtype="object", name="account"),
    )
    manager = SessionManager()
    opened = open_frame(manager, monkeypatch, frame)
    session_id = str(opened["metadata"]["sessionId"])

    assert opened["metadata"]["rowAxis"] == {"kind": "index", "levelNames": ["account"]}
    assert [column["name"] for column in opened["metadata"]["schema"]] == ["score", "score", "7"]
    assert [row["rowLabel"] for row in opened["page"]["rows"]] == ["101", "101", "null"]

    filtered = manager.get_page(
        session_id,
        0,
        0,
        20,
        {
            "logic": "and",
            "filters": [
                {
                    "column": "7",
                    "type": "integer",
                    "predicates": [{"kind": "predicate", "operator": "gt", "value": 1}],
                }
            ],
            "sort": [{"column": "7", "direction": "desc", "nulls": "last"}],
        },
    )

    assert filtered["metadata"]["rowAxis"] == {"kind": "index", "levelNames": ["account"]}
    assert [row["rowLabel"] for row in filtered["page"]["rows"]] == ["101", "101"]
    assert [row["rowNumber"] for row in filtered["page"]["rows"]] == [0, 1]
    assert frame.index.tolist() == [101, 101, None]
    manager.close_session(session_id, 0)


def test_positional_index_stays_positional_after_a_filtered_sort(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frame = pd.DataFrame({"score": [10, 30, 20], "city": ["Oslo", "Rome", "Lima"]})
    manager = SessionManager()
    opened = open_frame(manager, monkeypatch, frame)
    session_id = str(opened["metadata"]["sessionId"])

    filtered = manager.get_page(
        session_id,
        0,
        0,
        20,
        {
            "logic": "and",
            "filters": [
                {
                    "column": "score",
                    "type": "integer",
                    "predicates": [{"kind": "predicate", "operator": "gt", "value": 10}],
                }
            ],
            "sort": [{"column": "score", "direction": "desc", "nulls": "last"}],
        },
    )

    assert filtered["metadata"]["rowAxis"] == {"kind": "positional", "levelNames": []}
    assert [row["values"][0]["display"] for row in filtered["page"]["rows"]] == ["30", "20"]
    assert all("rowLabel" not in row for row in filtered["page"]["rows"])
    assert isinstance(frame.index, pd.RangeIndex)
    assert frame.index.tolist() == [0, 1, 2]
    manager.close_session(session_id, 0)


def test_multiindex_survives_preview_inspection_apply_and_undo_without_becoming_columns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    index = pd.MultiIndex.from_tuples(
        [("north", 2), ("south", 1)],
        names=["region", 2024],
    )
    frame = pd.DataFrame({"value": [20, 10]}, index=index)
    manager = SessionManager()
    opened = open_frame(manager, monkeypatch, frame)
    session_id = str(opened["metadata"]["sessionId"])

    assert opened["metadata"]["rowAxis"] == {
        "kind": "multiIndex",
        "levelNames": ["region", "2024"],
    }
    assert [row["rowLabel"] for row in opened["page"]["rows"]] == ["north · 2", "south · 1"]
    assert [column["name"] for column in opened["metadata"]["schema"]] == ["value"]

    preview = manager.preview_step(
        session_id,
        0,
        {
            "id": "reset-index",
            "kind": "customCode",
            "params": {"code": "result = df.reset_index(drop=True)"},
        },
        0,
        20,
    )
    assert preview["metadata"]["rowAxis"] == {"kind": "positional", "levelNames": []}
    assert all("rowLabel" not in row for row in preview["page"]["rows"])

    applied = manager.apply_draft(session_id, int(preview["revision"]), 0, 20)
    inspection = manager.inspect_step(session_id, int(applied["revision"]), "reset-index", 0, 20)
    assert inspection["inputRowAxis"] == {"kind": "multiIndex", "levelNames": ["region", "2024"]}
    assert inspection["outputRowAxis"] == {"kind": "positional", "levelNames": []}
    assert [row["rowLabel"] for row in inspection["inputPage"]["rows"]] == ["north · 2", "south · 1"]
    assert all("rowLabel" not in row for row in inspection["outputPage"]["rows"])

    undone = manager.undo_step(session_id, int(applied["revision"]), 0, 20)
    assert undone["metadata"]["rowAxis"] == {"kind": "multiIndex", "levelNames": ["region", "2024"]}
    assert [row["rowLabel"] for row in undone["page"]["rows"]] == ["north · 2", "south · 1"]
    assert frame.index.equals(index)
    manager.close_session(session_id, int(undone["revision"]))


@pytest.mark.parametrize("format_name", ["csv", "parquet"])
@pytest.mark.parametrize("policy", ["preserve", "omit"])
def test_pandas_export_requires_and_applies_the_explicit_index_policy(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    format_name: Literal["csv", "parquet"],
    policy: RowAxisExportPolicy,
) -> None:
    source = pd.DataFrame(
        {"amount": [10, 20]},
        index=pd.Index(["invoice-a", "invoice-b"], name="invoice_id"),
    )
    manager = SessionManager()
    opened = open_frame(manager, monkeypatch, source)
    session_id = str(opened["metadata"]["sessionId"])
    destination = tmp_path / f"indexed-{policy}.{format_name}"

    exported = manager.export_data(
        session_id,
        0,
        str(destination),
        (
            {
                "format": "csv",
                "delimiter": ",",
                "quoteChar": '"',
                "encoding": "utf-8",
                "header": True,
                "rowAxisPolicy": policy,
            }
            if format_name == "csv"
            else {"format": "parquet", "rowAxisPolicy": policy}
        ),
        reserve_export_target(destination),
    )

    assert exported["shape"] == {"rows": 2, "columns": 1}
    if format_name == "csv":
        loaded = pd.read_csv(destination, index_col=0 if policy == "preserve" else None)
    else:
        loaded = pd.read_parquet(destination)
    if policy == "preserve":
        assert loaded.index.tolist() == ["invoice-a", "invoice-b"]
        assert loaded.index.name == "invoice_id"
    else:
        assert isinstance(loaded.index, pd.RangeIndex)
        assert loaded.index.name is None
    assert loaded["amount"].tolist() == [10, 20]
    assert source.index.tolist() == ["invoice-a", "invoice-b"]
    assert source.index.name == "invoice_id"
    manager.close_session(session_id, 0)


def test_export_policy_is_mandatory_for_pandas_and_rejected_by_other_backends(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pandas_manager = SessionManager()
    opened = open_frame(
        pandas_manager,
        monkeypatch,
        pd.DataFrame({"value": [1]}, index=pd.Index(["source-row"], name="source_id")),
    )
    pandas_session_id = str(opened["metadata"]["sessionId"])
    with pytest.raises(EngineError, match="explicit preserve-or-omit"):
        pandas_manager.export_data(
            pandas_session_id,
            0,
            str(tmp_path / "missing.csv"),
            {"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": "utf-8", "header": True},
        )

    source_path = tmp_path / "polars.csv"
    source_path.write_text("value\n1\n", encoding="utf-8")
    polars_manager = SessionManager()
    polars_opened = polars_manager.open_session(
        {"kind": "file", "label": source_path.name, "path": str(source_path)},
        backend="polars",
    )
    with pytest.raises(EngineError, match="does not accept a Pandas row-axis policy"):
        polars_manager.export_data(
            str(polars_opened["metadata"]["sessionId"]),
            0,
            str(tmp_path / "polars-export.csv"),
            {
                "format": "csv",
                "delimiter": ",",
                "quoteChar": '"',
                "encoding": "utf-8",
                "header": True,
                "rowAxisPolicy": "preserve",
            },
        )
    pandas_manager.close_session(pandas_session_id, 0)
    polars_manager.close_session(str(polars_opened["metadata"]["sessionId"]), 0)


def test_row_axis_rejects_unbounded_levels_and_labels() -> None:
    engine = PandasEngine()
    excessive_levels = pd.MultiIndex.from_tuples([tuple(range(65))], names=[None] * 65)
    with pytest.raises(EngineError, match="at most 64 levels"):
        engine.row_axis(pd.DataFrame({"value": [1]}, index=excessive_levels))

    oversized = pd.DataFrame({"value": [1]}, index=pd.Index(["x" * 1_025], name="source"))
    identified = engine.ensure_row_ids(oversized, "oversized-index")
    with pytest.raises(EngineError, match="exceeds 1024 characters"):
        engine.page(identified, 0, 1)
