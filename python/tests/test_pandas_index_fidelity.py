from __future__ import annotations

import io
import json
import os
from copy import deepcopy
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

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


@pytest.mark.parametrize("family", ["bool8", "uuid"])
@pytest.mark.parametrize("shape", ["present", "empty", "all-null"])
@pytest.mark.parametrize("location", ["column", "index", "multi-index"])
@pytest.mark.parametrize("infer_string", [False, True])
def test_parquet_known_scalar_file_sessions_keep_logical_values_and_native_columns(
    tmp_path: Path, family: str, shape: str, location: str, infer_string: bool
) -> None:
    import pyarrow as pa
    import pyarrow.parquet as pq

    dtype = pa.bool8() if family == "bool8" else pa.uuid()
    values = [1, 0, -1, 2, None] if family == "bool8" else [UUID(int=1), UUID(int=2), UUID(int=0), UUID(int=1), None]
    if shape == "empty":
        values = []
    elif shape == "all-null":
        values = [None, None]
    logical_values = [None if value is None else (value != 0 if family == "bool8" else str(value)) for value in values]
    logical_dtype = "bool[pyarrow]" if family == "bool8" else "string[python]"
    wide_values = [2**64 - 1] * max(0, len(values) - 1) + ([None] if values else [])
    wide = pd.Index(pd.array(wide_values, dtype="UInt64"), name="wide")
    ordinary = pd.DataFrame(
        {
            "value": range(len(values)),
            "text": pd.Series(["text"] * max(0, len(values) - 1) + ([None] if values else []), dtype=object),
            "nullable": pd.Series([1] * len(values), dtype="Int64"),
            "category": pd.Categorical(["a"] * len(values), categories=["unused", "a"], ordered=True),
            "when": pd.date_range("2024-01-01", periods=len(values), tz="Europe/Berlin"),
        }
    )
    ordinary.attrs = {"unchanged": {"metadata": True}}
    if location == "multi-index":
        ordinary.index = pd.MultiIndex.from_arrays([wide, range(len(values))], names=["wide", "value"])
    elif location == "index":
        ordinary.index = pd.Index(range(len(values)), name="value")
    else:
        ordinary.index = wide
    table = pa.Table.from_pandas(ordinary, preserve_index=True)
    metadata = deepcopy(table.schema.pandas_metadata)
    field_name = "value" if location == "column" else metadata["index_columns"][-1]
    field_position = table.schema.get_field_index(field_name)
    array = pa.chunked_array([pa.array(values[:2], type=dtype), pa.array(values[2:], type=dtype)])
    table = table.set_column(field_position, pa.field(field_name, dtype), array)
    descriptor = next(column for column in metadata["columns"] if column["field_name"] == field_name)
    descriptor.update(numpy_type=str(pd.ArrowDtype(dtype)), pandas_type="object")
    table = table.replace_schema_metadata({**table.schema.metadata, b"pandas": json.dumps(metadata).encode()})
    path = tmp_path / "scalars.parquet"
    pq.write_table(table, path)
    before = path.read_bytes()
    manager = SessionManager()
    with pd.option_context("future.infer_string", infer_string):
        # The ordinary native read remains the owner of unrelated dtype/attrs behavior.
        buffer = io.BytesIO()
        ordinary.to_parquet(buffer, index=True)
        expected = pd.read_parquet(io.BytesIO(buffer.getvalue()))
        if location == "column":
            expected.isetitem(0, pd.array(logical_values, dtype=logical_dtype))
            if pd.api.types.is_float_dtype(expected.index.dtype):
                expected.index = pd.Index(pd.array(wide_values, dtype="uint64[pyarrow]"), name="wide")
        elif location == "index":
            expected.index = pd.Index(pd.array(logical_values, dtype=logical_dtype), name="value")
        else:
            wide_index = expected.index.get_level_values(0)
            if pd.api.types.is_float_dtype(wide_index.dtype):
                wide_index = pd.Index(pd.array(wide_values, dtype="uint64[pyarrow]"))
            expected.index = pd.MultiIndex.from_arrays(
                [wide_index, pd.array(logical_values, dtype=logical_dtype)],
                names=["wide", "value"],
            )
        opened = manager.open_session(
            {"kind": "file", "label": path.name, "path": str(path)}, backend="pandas", page_size=20
        )
        session_id = str(opened["metadata"]["sessionId"])
        try:
            loaded = manager.sessions[session_id].original
            pd.testing.assert_frame_equal(PandasEngine()._visible_frame(loaded), expected)
            expected_page = PandasEngine().page(expected, 0, 20)
            assert [(row["rowLabel"], row["values"]) for row in opened["page"]["rows"]] == [
                (row["rowLabel"], row["values"]) for row in expected_page["rows"]
            ]
            assert opened["metadata"]["rowAxis"]["levelNames"] == expected.index.names
        finally:
            manager.close_session(session_id, 0)
    assert path.read_bytes() == before


@pytest.mark.parametrize("family", ["bool8", "uuid"])
@pytest.mark.parametrize("invalid_dtype", ["not_a_dtype", "Int999"])
def test_parquet_known_scalar_reader_retains_unrelated_invalid_dtype_refusal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, family: str, invalid_dtype: str
) -> None:
    import pyarrow as pa
    import pyarrow.parquet as pq

    dtype = pa.bool8() if family == "bool8" else pa.uuid()
    values = [1, None] if family == "bool8" else [UUID(int=1), None]
    source = pd.DataFrame({"value": pd.Series(pd.arrays.ArrowExtensionArray(pa.array(values, type=dtype)))})
    table = pa.Table.from_pandas(source)
    metadata = deepcopy(table.schema.pandas_metadata)
    metadata["columns"][0]["numpy_type"] = invalid_dtype
    table = table.replace_schema_metadata({**table.schema.metadata, b"pandas": json.dumps(metadata).encode()})
    path = tmp_path / "invalid.parquet"
    pq.write_table(table, path)
    before = path.read_bytes()
    with pytest.raises(TypeError) as native_error:
        pd.read_parquet(path)
    streams: list[Any] = []
    read_parquet = pd.read_parquet

    def observe_read(stream: Any, **kwargs: Any) -> Any:
        streams.append(stream)
        return read_parquet(stream, **kwargs)

    monkeypatch.setattr(pd, "read_parquet", observe_read)
    with pytest.raises(type(native_error.value)) as actual_error:
        PandasEngine().read_file(str(path))
    assert str(actual_error.value) == str(native_error.value)
    assert streams and all(stream.closed for stream in streams)
    assert path.read_bytes() == before


@pytest.mark.parametrize("dtype", ["Int64", "UInt64", "int64[pyarrow]", "uint64[pyarrow]", "Int8", "uint8[pyarrow]"])
@pytest.mark.parametrize("shape", ["present", "empty", "missing"])
def test_parquet_file_session_preserves_nullable_integer_index_values(tmp_path: Path, dtype: str, shape: str) -> None:
    if "8" in dtype:
        values = [0, None, 254, 255] if "u" in dtype.lower() else [-128, None, 126, 127]
    else:
        values = [2**64 - 1 if "u" in dtype.lower() else -(2**63), None, 2**53 + 1, 2**53]
    if shape == "empty":
        values = []
    elif shape == "missing":
        values = [None] * 4
    index = pd.Index(pd.array(values, dtype=dtype), name="account")
    source = pd.DataFrame({"value": range(len(index))}, index=index)
    path = tmp_path / "indexed.parquet"
    source.to_parquet(path)
    before = path.read_bytes()
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)}, backend="pandas", page_size=20
    )
    session_id = str(opened["metadata"]["sessionId"])
    try:
        assert opened["metadata"]["rowAxis"] == {"kind": "index", "levelNames": ["account"]}
        assert [column["name"] for column in opened["metadata"]["schema"]] == ["value"]
        assert [row["rowLabel"] for row in opened["page"]["rows"]] == [
            "null" if value is None else str(value) for value in values
        ]
        loaded = manager.sessions[session_id].original
        assert [None if pd.isna(value) else int(value) for value in loaded.index] == values
        assert pd.api.types.is_integer_dtype(loaded.index.dtype)
        assert loaded["value"].tolist() == source["value"].tolist()
        filtered = manager.get_page(
            session_id,
            0,
            0,
            20,
            {
                "filters": [
                    {
                        "column": "value",
                        "type": "integer",
                        "predicates": [{"kind": "predicate", "operator": "gt", "value": 0}],
                    }
                ],
                "sort": [{"column": "value", "direction": "desc", "nulls": "last"}],
            },
        )
        assert [row["rowLabel"] for row in filtered["page"]["rows"]] == [
            "null" if values[position] is None else str(values[position])
            for position in reversed(range(1, len(values)))
        ]
    finally:
        manager.close_session(session_id, 0)
    assert path.read_bytes() == before
    assert [None if pd.isna(value) else int(value) for value in source.index] == values


@pytest.mark.parametrize(
    "case",
    [
        "missing-before",
        "missing-after",
        "range",
        "ignored-range",
        "negative-range",
        "legacy",
        "duplicate-names",
        "data-collision",
        "dotted",
        "category",
        "timezone",
        "float-sign",
    ],
)
def test_parquet_index_repair_preserves_native_metadata_and_other_columns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    pa = pytest.importorskip("pyarrow")
    pq = pytest.importorskip("pyarrow.parquet")
    wide = pd.Index(pd.array([2**64 - 1, None, 2**53 + 1, 2**53], dtype="UInt64"), name="wide")
    source = pd.DataFrame(
        {"value": pd.array([1.5, 2.5, 3.5, 4.5], dtype="float32"), "text": ["a", None, "c", "d"]}, index=wide
    )
    if case == "duplicate-names":
        source.index = pd.MultiIndex.from_arrays([wide, wide], names=["same", "same"])
    elif case == "data-collision":
        source.index = wide.rename("value")
    elif case == "dotted":
        source["nested"] = [{"child": "unrelated data"}] * 4
        source.index = wide.rename("nested.child")
    elif case == "category":
        category = pd.CategoricalIndex(
            ["a", "b", None, "a"], categories=["unused", "b", "a"], ordered=True, name="category"
        )
        source.index = pd.MultiIndex.from_arrays([wide, category])
    elif case == "timezone":
        source.index = pd.MultiIndex.from_arrays(
            [wide, pd.date_range("2020-01-01", periods=4, tz="Europe/Berlin", name="when")]
        )
    elif case == "float-sign":
        source.index = pd.MultiIndex.from_arrays([wide, pd.Index([-0.0, 1.5, None, -2.5], name="float")])
    source.attrs = {"purpose": "preserved metadata"}
    table = pa.Table.from_pandas(source)
    metadata = deepcopy(table.schema.pandas_metadata)
    if case.startswith("missing-"):
        absent = deepcopy(metadata["columns"][-1])
        absent.update(name="old_index", field_name="old_index")
        metadata["columns"].append(absent)
        metadata["index_columns"].insert(0 if case == "missing-before" else 1, "old_index")
    elif case in {"range", "ignored-range", "negative-range"}:
        start, stop, step = (7, -1, -2) if case == "negative-range" else (7, 15 if case == "range" else 9, 2)
        metadata["index_columns"].insert(
            0, {"kind": "range", "name": "range", "start": start, "stop": stop, "step": step}
        )
    elif case == "legacy":
        for column in metadata["columns"]:
            column.pop("field_name")
    table = table.replace_schema_metadata({**table.schema.metadata, b"pandas": json.dumps(metadata).encode()})
    path = tmp_path / "metadata.parquet"
    pq.write_table(table, path)
    before = path.read_bytes()
    ordinary = pd.read_parquet(path)
    exact_index = table.to_pandas(
        types_mapper=lambda dtype: pd.ArrowDtype(dtype) if pa.types.is_integer(dtype) else None
    ).index
    projected: list[list[str]] = []
    streams: list[Any] = []
    read_table = pq.read_table

    def observe_read(stream: Any, **kwargs: Any) -> Any:
        result = read_table(stream, **kwargs)
        if kwargs.get("columns") is not None:
            projected.append(result.column_names)
        if hasattr(stream, "closed"):
            streams.append(stream)
        return result

    monkeypatch.setattr(pq, "read_table", observe_read)
    loaded = PandasEngine().read_file(str(path))
    pd.testing.assert_index_equal(loaded.index, exact_index)
    pd.testing.assert_frame_equal(loaded.reset_index(drop=True), ordinary.reset_index(drop=True))
    assert loaded.attrs == ordinary.attrs == source.attrs
    expected_fields = [
        name
        for name in metadata["index_columns"]
        if isinstance(name, str)
        and table.schema.get_field_index(name) >= 0
        and pa.types.is_integer(table.schema.field(name).type)
    ]
    assert projected == [expected_fields]
    assert streams and all(stream.closed for stream in streams)
    assert path.read_bytes() == before


@pytest.mark.parametrize(
    "index",
    [
        pd.RangeIndex(7, 15, 2, name="range"),
        pd.Index([1, 2, 3, 4], name="integer"),
        pd.Index([1.5, None, -0.0, 4.5], name="float"),
    ],
)
def test_parquet_reader_keeps_ordinary_index_storage_without_supplemental_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, index: pd.Index
) -> None:
    pq = pytest.importorskip("pyarrow.parquet")
    source = pd.DataFrame({"value": pd.array([1, None, 3, 4], dtype="Int64")}, index=index)
    source.attrs = {"unchanged": True}
    path = tmp_path / "ordinary.parquet"
    source.to_parquet(path)
    expected = pd.read_parquet(path)
    read_table = pq.read_table

    def forbid_supplemental_read(*args: Any, **kwargs: Any) -> Any:
        assert kwargs.get("columns") is None
        return read_table(*args, **kwargs)

    monkeypatch.setattr(pq, "read_table", forbid_supplemental_read)
    pd.testing.assert_frame_equal(PandasEngine().read_file(str(path)), expected)


@pytest.mark.parametrize(
    "descriptor", [{"kind": "unknown"}, {"kind": "range", "name": None, "start": 0, "stop": 2, "step": 0}]
)
def test_parquet_reader_retains_native_invalid_index_metadata_refusal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, descriptor: dict[str, Any]
) -> None:
    pa = pytest.importorskip("pyarrow")
    pq = pytest.importorskip("pyarrow.parquet")
    table = pa.Table.from_pandas(
        pd.DataFrame({"value": [1, 2]}, index=pd.Index(pd.array([2**64 - 1, None], dtype="UInt64"), name="wide"))
    )
    metadata = table.schema.pandas_metadata
    metadata["index_columns"].insert(0, descriptor)
    table = table.replace_schema_metadata({**table.schema.metadata, b"pandas": json.dumps(metadata).encode()})
    path = tmp_path / "invalid.parquet"
    pq.write_table(table, path)
    before = path.read_bytes()
    streams: list[Any] = []
    read_parquet = pd.read_parquet

    def observe_read(stream: Any, **kwargs: Any) -> Any:
        streams.append(stream)
        return read_parquet(stream, **kwargs)

    monkeypatch.setattr(pd, "read_parquet", observe_read)
    with pytest.raises(ValueError):
        PandasEngine().read_file(str(path))
    assert streams and all(stream.closed for stream in streams)
    assert path.read_bytes() == before


@pytest.mark.parametrize(
    "source_type,phase",
    [
        ("integer-index", "after-main"),
        ("integer-index", "after-index"),
        ("bool8", "before-main"),
        ("bool8", "after-main"),
        ("uuid", "before-main"),
        ("uuid", "after-main"),
    ],
)
@pytest.mark.parametrize("change", ["rewrite", "replace"])
def test_parquet_reader_refuses_changes_between_reads_and_closes_descriptor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source_type: str, phase: str, change: str
) -> None:
    pa = pytest.importorskip("pyarrow")
    pq = pytest.importorskip("pyarrow.parquet")

    def payload(offset: int) -> bytes:
        if source_type == "integer-index":
            index = pd.Index(pd.array([2**53 + 1 + offset, None, 2**53 + 3 + offset], dtype="UInt64"), name="index")
            frame = pd.DataFrame(
                {"value": [11 + offset, 12 + offset, 13 + offset], "padding": ["A" * 65536] * 3}, index=index
            )
        else:
            dtype = pa.bool8() if source_type == "bool8" else pa.uuid()
            values = (
                [1 + offset, -1 - offset, None]
                if source_type == "bool8"
                else [UUID(int=1 + offset), UUID(int=2 + offset), None]
            )
            frame = pd.DataFrame(
                {
                    "value": pd.Series(pd.arrays.ArrowExtensionArray(pa.array(values, type=dtype))),
                    "padding": ["A" * 65536] * 3,
                }
            )
        output = io.BytesIO()
        frame.to_parquet(output, compression=None, use_dictionary=False, write_statistics=False)
        return output.getvalue()

    first, second = payload(0), payload(4)
    assert len(first) == len(second)
    path = tmp_path / "source.parquet"
    path.write_bytes(first)
    before = path.stat()
    replacement = tmp_path / "replacement.parquet"
    replacement.write_bytes(second)
    streams: list[Any] = []
    mutation_attempted = False
    mutation_denied = False

    def change_source() -> None:
        nonlocal mutation_attempted, mutation_denied
        mutation_attempted = True
        try:
            if change == "replace":
                os.replace(replacement, path)
            else:
                with path.open("r+b", buffering=0) as writer:
                    writer.write(second)
                    writer.truncate()
                    os.fsync(writer.fileno())
                os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
        except PermissionError:
            if os.name != "nt":
                raise
            mutation_denied = True

    read_parquet = pd.read_parquet
    read_table = pq.read_table

    def after_main(stream: Any, **kwargs: Any) -> Any:
        if phase == "before-main":
            change_source()
        frame = read_parquet(stream, **kwargs)
        streams.append(stream)
        if phase == "after-main":
            change_source()
        return frame

    def after_index(stream: Any, **kwargs: Any) -> Any:
        table = read_table(stream, **kwargs)
        if phase == "after-index" and kwargs.get("columns") is not None:
            change_source()
        return table

    monkeypatch.setattr(pd, "read_parquet", after_main)
    monkeypatch.setattr(pq, "read_table", after_index)
    manager = SessionManager()
    try:
        result = manager.open_session({"kind": "file", "label": path.name, "path": str(path)}, backend="pandas")
    except EngineError as error:
        assert "Parquet source changed" in str(error)
        assert manager.sessions == {}
    else:
        assert mutation_denied
        expected_labels = (
            [str(2**53 + 1), "null", str(2**53 + 3)] if source_type == "integer-index" else ["0", "1", "2"]
        )
        assert [row["rowLabel"] for row in result["page"]["rows"]] == expected_labels
        manager.close_session(str(result["metadata"]["sessionId"]), 0)
    assert mutation_attempted
    assert streams and all(stream.closed for stream in streams)


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
