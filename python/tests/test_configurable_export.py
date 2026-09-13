from __future__ import annotations

import csv
import io
import sys
from contextlib import nullcontext
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime.engines import EngineError
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine
from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.engines.polars_engine import PolarsEngine
from openwrangler_runtime.export_target import ExportTarget, ExportTargetError, ExportWriterPath, _regular_file_identity
from openwrangler_runtime.session import SessionManager

PANDAS_CSV_OPTIONS = {"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": "utf-8", "header": True}


@pytest.mark.parametrize("shape", ["chunked", "empty", "all-null"])
def test_pandas_negative_scale_decimal_parquet_preserves_exact_values(tmp_path: Path, shape: str) -> None:
    from decimal import localcontext

    import pyarrow as pa
    import pyarrow.parquet as pq

    columns, expected = {}, {}
    for bits, precision, scale, coefficient in [
        (32, 8, -2, 12),
        (64, 18, -2, 10**18 - 1),
        (128, 38, -2, 10**38 - 1),
        (128, 38, -50, 1),
        (256, 76, -1, 10**75 - 1),
        (256, 76, -76, 0),
    ]:
        name = f"decimal{bits}_{scale}"
        coefficients = (
            [coefficient, -coefficient, None] if shape == "chunked" else [] if shape == "empty" else [None] * 3
        )
        native_type = getattr(pa, f"decimal{bits}")
        physical = pa.array(
            [Decimal(0), *(None if value is None else Decimal(value) for value in coefficients)],
            type=native_type(precision, 0),
        )
        values = physical.view(native_type(precision, scale)).slice(1)
        chunks = pa.chunked_array([values.slice(0, 1), values.slice(1)])
        columns[name] = pd.Series(pd.arrays.ArrowExtensionArray(chunks))
        expected[name] = [None if value is None else Decimal(value * 10**-scale) for value in coefficients]
    source = pd.DataFrame(columns)
    source["neighbor"] = range(len(source))
    source.index = pd.Index([7] * len(source), dtype="int64", name="row")
    source.attrs = {"owner": "unchanged"}
    original_arrays = {}
    for name in columns:
        original_array: Any = source[name].array
        original_arrays[name] = original_array.__arrow_array__()
    original_index = source.index
    destination = tmp_path / "decimals.parquet"
    destination.touch()
    with (
        localcontext() as context,
        ExportTarget(destination, *_regular_file_identity(destination)).pinned_writer_path() as writer,
    ):
        context.prec = 2
        context.clear_flags()
        PandasEngine().export_data(source, writer, {"format": "parquet", "rowAxisPolicy": "preserve"})
        assert not any(context.flags.values())
    table = pq.read_table(destination)
    reopened = PandasEngine().read_file(str(destination))
    for name, values in expected.items():
        assert table[name].to_pylist() == values
        assert table[name].type.scale == 0
        assert [None if pd.isna(value) else value for value in reopened[name]] == values
        current_array: Any = source[name].array
        assert current_array.__arrow_array__().equals(original_arrays[name])
    assert table["neighbor"].to_pylist() == source["neighbor"].tolist() == list(range(len(source)))
    pd.testing.assert_index_equal(reopened.index, original_index)
    assert source.index is original_index and source.attrs == {"owner": "unchanged"}


@pytest.mark.parametrize("index_kind", ["single", "multi", "omitted"])
def test_pandas_negative_scale_decimal_parquet_exports_only_requested_index_values(
    tmp_path: Path, index_kind: str
) -> None:
    import pyarrow as pa
    import pyarrow.parquet as pq

    physical = pa.array([Decimal(120), Decimal(-30), Decimal(10**75)], type=pa.decimal256(76, 0))
    level = pd.Index(pd.arrays.ArrowExtensionArray(physical.view(pa.decimal256(76, -1))), name="decimal row")
    if index_kind == "single":
        index = pd.Index(level.array.take([0, 1, -1, 0], allow_fill=True), name=level.name)
    else:
        index = pd.MultiIndex(
            levels=[level, pd.Index(["a", "b"])],
            codes=[[2 if index_kind == "omitted" else 0, 1, -1, 0], [0, 1, 0, 0]],
            names=["decimal row", "label"],
        )
    source = pd.DataFrame({"value": range(4)}, index=index)
    destination = tmp_path / "index.parquet"
    destination.touch()
    with ExportTarget(destination, *_regular_file_identity(destination)).pinned_writer_path() as writer:
        PandasEngine().export_data(
            source, writer, {"format": "parquet", "rowAxisPolicy": "omit" if index_kind == "omitted" else "preserve"}
        )
    table = pq.read_table(destination)
    assert table["value"].to_pylist() == [0, 1, 2, 3]
    if index_kind == "omitted":
        assert table.column_names == ["value"]
    else:
        assert table["decimal row"].to_pylist() == [Decimal(1200), Decimal(-300), None, Decimal(1200)]
        if index_kind == "multi":
            assert table["label"].to_pylist() == ["a", "b", "a", "a"]
    assert source.index is index
    if isinstance(index, pd.MultiIndex):
        assert list(index.codes[0]) == [2 if index_kind == "omitted" else 0, 1, -1, 0]
        current_level: Any = index.levels[0]
        expected_array: Any = level.array
        assert current_level.array.__arrow_array__().equals(expected_array.__arrow_array__())


@pytest.mark.parametrize(
    ("bits", "precision", "scale", "coefficient", "message"),
    [
        pytest.param(256, 76, -1, 10**75, "76 digits", id="actual-77-digits"),
        pytest.param(256, 76, -2, (2**256 // 100) + 10**74, "76 digits", id="native-multiple-wrap"),
        pytest.param(256, 76, -76, 1, "76 digits", id="scale-76-overflow"),
        pytest.param(256, 76, -77, 1, "scales down to -76", id="unsupported-scale"),
        pytest.param(32, 9, -70, 1, "declared range", id="decimal32-wide-declaration"),
        pytest.param(64, 18, -70, 1, "declared range", id="decimal64-wide-declaration"),
        pytest.param(256, 74, -2, (2**256 // 100) + 10**74, "precision", id="invalid-storage"),
        pytest.param(128, 14, -62, -(2**127), "precision", id="invalid-physical-minimum128"),
        pytest.param(256, 76, -1, -(2**255), "76 digits", id="invalid-physical-minimum256"),
    ],
)
def test_pandas_negative_scale_decimal_parquet_refuses_before_writer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    bits: int,
    precision: int,
    scale: int,
    coefficient: int,
    message: str,
) -> None:
    import pyarrow as pa

    native_type = getattr(pa, f"decimal{bits}")
    if coefficient < 0:
        array = pa.Array.from_buffers(
            native_type(precision, scale),
            2,
            [
                pa.py_buffer(b"\x01"),
                pa.py_buffer(coefficient.to_bytes(bits // 8, "little", signed=True) + bytes(bits // 8)),
            ],
        )
    else:
        physical = pa.array(
            [Decimal(coefficient), Decimal(-coefficient), None],
            type=native_type(9 if bits == 32 else 18 if bits == 64 else 76, 0),
        )
        array = physical.view(native_type(precision, scale))
    source = pd.DataFrame({"value": pd.arrays.ArrowExtensionArray(array)})
    destination = tmp_path / "retained.parquet"
    destination.write_bytes(b"retained destination")

    def opened_writer(_writer: Any) -> Any:
        raise AssertionError("An unrepresentable Decimal reached the destination writer")

    monkeypatch.setattr(ExportWriterPath, "open_binary_writer", opened_writer)
    with (
        ExportTarget(destination, *_regular_file_identity(destination)).pinned_writer_path() as writer,
        pytest.raises((EngineError, pa.ArrowInvalid), match=message),
    ):
        PandasEngine().export_data(source, writer, {"format": "parquet", "rowAxisPolicy": "omit"})
    assert destination.read_bytes() == b"retained destination"
    source_array: Any = source["value"].array
    assert source_array.__arrow_array__().equals(pa.chunked_array([array]))


@pytest.mark.parametrize("family", ["fitting", "hidden-overflow", "invalid-precision"])
def test_session_negative_scale_decimal_parquet_preserves_confirmed_formula_and_destination(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, family: str
) -> None:
    from copy import deepcopy

    import pyarrow as pa
    import pyarrow.parquet as pq

    from openwrangler_runtime import session as runtime

    scale = -1 if family == "fitting" else -2
    coefficients = [120, 10**75 - 1 if family == "fitting" else (2**256 // 100) + 10**74, None]
    physical = pa.array(
        [None if value is None else Decimal(value) for value in coefficients], type=pa.decimal256(76, 0)
    )
    values = physical.view(pa.decimal256(74 if family == "invalid-precision" else 76, scale))
    source = pd.DataFrame({"value": pd.arrays.ArrowExtensionArray(values)})
    before = source.copy(deep=True)
    monkeypatch.setattr(runtime, "resolve_notebook_variable", lambda _: source)
    manager = SessionManager()
    try:
        opened = manager.open_session(
            {"kind": "notebookVariable", "variableName": "frame"}, backend="pandas", mode="editing", page_size=1
        )
        sid = opened["metadata"]["sessionId"]
        session = manager.sessions[sid]
        engine = session.engine
        assert isinstance(engine, PandasEngine)
        if family != "invalid-precision":
            column = opened["metadata"]["schema"][0]
            operation = {
                "id": "keep-unit",
                "kind": "formula",
                "params": {
                    "leftColumn": {"id": column["id"], "name": column["name"]},
                    "operator": "multiply",
                    "value": 1,
                    "newColumn": "result",
                },
            }
            preview = manager.preview_step(sid, 0, operation, 0, 1)
            manager.apply_draft(sid, preview["revision"], 0, 1)
            namespace: dict[str, Any] = {}
            exec(engine.compile_plan(session.bound_plan), namespace, namespace)
            pd.testing.assert_frame_equal(namespace["clean_data"](source), engine._visible_frame(session.committed))
            assert session.committed["result"].dtype == pd.ArrowDtype(pa.decimal256(76, scale))
        revision, plan, filter_model = session.revision, deepcopy(session.plan), deepcopy(session.filter_model)
        committed = session.committed.copy(deep=True)
        destination = tmp_path / "session.parquet"
        destination.write_bytes(b"retained destination")
        device, inode = _regular_file_identity(destination)
        error = nullcontext() if family == "fitting" else pytest.raises((EngineError, pa.ArrowInvalid))
        with error:
            response = manager.export_data(
                sid,
                revision,
                str(destination),
                {"format": "parquet", "rowAxisPolicy": "preserve"},
                {"device": str(device), "inode": str(inode)},
            )
            assert response["kind"] == "dataExported"
        if family == "fitting":
            expected = [None if value is None else Decimal(value * 10) for value in coefficients]
            table = pq.read_table(destination)
            reopened = PandasEngine().read_file(str(destination))
            for name in ("value", "result"):
                assert table[name].to_pylist() == expected
                assert [None if pd.isna(value) else value for value in reopened[name]] == expected
        else:
            assert destination.read_bytes() == b"retained destination"
        pd.testing.assert_frame_equal(source, before)
        pd.testing.assert_frame_equal(session.committed, committed)
        assert session.revision == revision and session.plan == plan and session.filter_model == filter_model
    finally:
        manager.close_all()


@pytest.mark.parametrize("format_name", ["csv", "parquet"])
def test_pandas_scalar_export_does_not_materialize_range_axis(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, format_name: str
) -> None:
    import io

    source = pd.DataFrame({"value": [1, 2, 3]}, index=pd.RangeIndex(7, 13, 2, name="row"))
    expected = source.to_csv().encode() if format_name == "csv" else source.to_parquet(index=True)

    def materialized_array(_index: Any) -> Any:
        raise AssertionError("Scalar export preparation materialized a RangeIndex array")

    monkeypatch.setattr(pd.RangeIndex, "array", property(materialized_array))
    destination = tmp_path / f"range.{format_name}"
    destination.touch()
    identity = _regular_file_identity(destination)
    options: Any = {"format": format_name, "rowAxisPolicy": "preserve"}
    if format_name == "csv":
        options.update(delimiter=",", quoteChar='"', encoding="utf-8", header=True)
    with ExportTarget(destination, *identity).pinned_writer_path() as writer:
        PandasEngine().export_data(source, writer, options)
    if format_name == "csv":
        assert destination.read_bytes() == expected
    else:
        pd.testing.assert_frame_equal(pd.read_parquet(destination), pd.read_parquet(io.BytesIO(expected)))
    assert source.index.equals(pd.RangeIndex(7, 13, 2, name="row"))


@pytest.mark.parametrize("format_name", ["csv", "parquet"])
@pytest.mark.parametrize("index_policy", ["preserve", "omit"])
def test_pandas_object_uuid_exports_write_canonical_text_without_changing_source(
    tmp_path: Path, format_name: str, index_policy: str
) -> None:
    import io

    identifier = UUID("98765432-1234-4567-89ab-fedcba987654")
    values = [identifier, str(identifier), None, UUID(int=0), str(identifier).upper()]
    source = pd.DataFrame({"value": pd.Series(values, dtype=object), "row": range(len(values))})
    source.index = pd.MultiIndex.from_arrays([values, [0] * len(values)], names=["uuid row", "order"])
    source.attrs = {"origin": "retained"}
    original_index = source.index
    logical_values = [str(value) if isinstance(value, UUID) else value for value in values]
    logical = pd.DataFrame({"value": pd.Series(logical_values, dtype=object), "row": range(len(values))})
    logical.index = pd.MultiIndex.from_arrays([logical_values, [0] * len(values)], names=source.index.names)
    logical.attrs = source.attrs
    options: Any = {"format": format_name, "rowAxisPolicy": index_policy}
    if format_name == "csv":
        options.update(delimiter=";", quoteChar='"', encoding="utf-8", header=True)
    destination = tmp_path / f"object-uuid.{format_name}"
    destination.touch()
    identity = _regular_file_identity(destination)
    engine = PandasEngine()
    with ExportTarget(destination, *identity).pinned_writer_path() as writer:
        engine.export_data(source, writer, options)
    preserve_index = index_policy == "preserve"
    if format_name == "csv":
        assert destination.read_bytes() == logical.to_csv(index=preserve_index, sep=";").encode()
        assert destination.read_bytes() == source.to_csv(index=preserve_index, sep=";").encode()
    else:
        expected = pd.read_parquet(io.BytesIO(logical.to_parquet(index=preserve_index)))
        pd.testing.assert_frame_equal(engine.read_file(str(destination)), expected)
    assert source.index is original_index and source.attrs == {"origin": "retained"}
    assert source["value"].dtype == object
    assert all(value is expected for value, expected in zip(source["value"].array, values, strict=True))
    assert source["row"].tolist() == list(range(len(values)))


@pytest.mark.parametrize("shape", ["chunked", "empty", "all-null"])
@pytest.mark.parametrize("format_name", ["csv", "parquet"])
@pytest.mark.parametrize("index_policy", ["preserve", "omit"])
def test_pandas_arrow_scalar_exports_write_logical_values(
    tmp_path: Path, shape: str, format_name: str, index_policy: str
) -> None:
    import io

    import pyarrow as pa
    import pyarrow.parquet as pq

    first = UUID("00112233-4455-6677-8899-aabbccddeeff")
    second = UUID("ffeeddcc-bbaa-9988-7766-554433221100")
    boolean_values = [1, 0, -1, 2, None] if shape == "chunked" else ([] if shape == "empty" else [None, None])
    uuid_values = [first, second, None, first, second] if shape == "chunked" else [None] * len(boolean_values)
    source_columns = {}
    for name, dtype, values in [("boolean", pa.bool8(), boolean_values), ("uuid", pa.uuid(), uuid_values)]:
        array = pa.chunked_array([pa.array(values[:2], type=dtype), pa.array(values[2:], type=dtype)])
        source_columns[name] = pd.Series(pd.arrays.ArrowExtensionArray(array))
    source = pd.DataFrame(source_columns)
    source["text"] = pd.Series(["É;quoted'" if position % 2 else None for position in range(len(source))], dtype=object)
    source.index = pd.MultiIndex.from_arrays([["same"] * len(source), list(range(len(source)))], names=["group", "row"])
    source.attrs = {"owner": {"unchanged": True}}
    original_index = source.index
    original_arrays = [source.iloc[:, position].array.__arrow_array__() for position in range(2)]
    logical = pd.DataFrame(
        {
            "boolean": pd.Series(
                pd.array([None if value is None else value != 0 for value in boolean_values], dtype="bool[pyarrow]")
            ),
            "uuid": pd.Series(
                pd.array([None if value is None else str(value) for value in uuid_values], dtype="string[python]")
            ),
            "text": source["text"].reset_index(drop=True),
        }
    )
    logical.index = source.index
    logical.attrs = source.attrs
    options: Any = {"format": format_name, "rowAxisPolicy": index_policy}
    if format_name == "csv":
        options.update(delimiter=";", quoteChar="'", encoding="utf-16", header=True)
    destination = tmp_path / f"logical.{format_name}"
    destination.touch()
    identity = _regular_file_identity(destination)
    with ExportTarget(destination, *identity).pinned_writer_path() as writer:
        PandasEngine().export_data(source, writer, options)
    preserve_index = index_policy == "preserve"
    if format_name == "csv":
        expected = logical.to_csv(index=preserve_index, sep=";", quotechar="'", header=True).encode("utf-16")
        assert destination.read_bytes() == expected
    else:
        actual_table = pq.read_table(destination)
        assert pa.types.is_boolean(actual_table.schema.field("boolean").type)
        assert pa.types.is_string(actual_table.schema.field("uuid").type)
        expected = pd.read_parquet(io.BytesIO(logical.to_parquet(index=preserve_index)))
        pd.testing.assert_frame_equal(PandasEngine().read_file(str(destination)), expected)
    assert source.index is original_index
    assert source.attrs == {"owner": {"unchanged": True}}
    for position, original in enumerate(original_arrays):
        array: Any = source.iloc[:, position].array
        assert array.__arrow_array__().equals(original)


@pytest.mark.parametrize("family", ["bool8", "uuid", "bool8-multi"])
@pytest.mark.parametrize("format_name", ["csv", "parquet"])
@pytest.mark.parametrize("index_policy", ["preserve", "omit"])
def test_pandas_arrow_scalar_index_exports_preserve_logical_labels(
    tmp_path: Path, family: str, format_name: str, index_policy: str
) -> None:
    import io

    import pyarrow as pa

    is_boolean = family.startswith("bool8")
    dtype = pa.bool8() if is_boolean else pa.uuid()
    values = [1, -1, 2, 0, None] if is_boolean else [UUID(int=1), UUID(int=2), UUID(int=1), UUID(int=0), None]
    array = pa.array(values, type=dtype)
    level = pd.Index(pd.arrays.ArrowExtensionArray(array), name="label")
    logical_values = [None if value is None else (value != 0 if is_boolean else str(value)) for value in values]
    logical_level = pd.Index(
        pd.array(logical_values, dtype="bool[pyarrow]" if is_boolean else "string[python]"), name="label"
    )
    if family == "bool8-multi":
        # Bool8 lacks a native dictionary_encode kernel for level validation.
        # These distinct physical entries deliberately collapse to logical True.
        index = pd.MultiIndex(
            levels=[level, pd.Index([0])],
            codes=[[0, 1, 2, 3, 4, -1], [0] * 6],
            names=["label", "order"],
            verify_integrity=False,
        )
        logical_index = pd.MultiIndex.from_arrays(
            [pd.array([*logical_values, None], dtype="bool[pyarrow]"), [0] * 6], names=index.names
        )
    else:
        index, logical_index = level, logical_level
    source = pd.DataFrame({"value": range(len(index))}, index=index)
    source.attrs = {"kept": True}
    logical = pd.DataFrame({"value": range(len(index))}, index=logical_index)
    logical.attrs = source.attrs
    options: Any = {"format": format_name, "rowAxisPolicy": index_policy}
    if format_name == "csv":
        options.update(delimiter=",", quoteChar='"', encoding="utf-8", header=True)
    destination = tmp_path / f"indexed.{format_name}"
    destination.touch()
    identity = _regular_file_identity(destination)
    with ExportTarget(destination, *identity).pinned_writer_path() as writer:
        PandasEngine().export_data(source, writer, options)
    preserve_index = index_policy == "preserve"
    if format_name == "csv":
        assert destination.read_bytes() == logical.to_csv(index=preserve_index).encode()
    else:
        expected = pd.read_parquet(io.BytesIO(logical.to_parquet(index=preserve_index)))
        pd.testing.assert_frame_equal(PandasEngine().read_file(str(destination)), expected)
    assert source.index is index
    assert source.attrs == {"kept": True}
    current_level: Any = source.index.levels[0] if isinstance(source.index, pd.MultiIndex) else source.index
    current_array: Any = current_level.array
    assert current_array.__arrow_array__().equals(pa.chunked_array([array]))
    if isinstance(source.index, pd.MultiIndex):
        assert list(source.index.codes[0]) == [0, 1, 2, 3, 4, -1]


@pytest.mark.parametrize("shape", ["chunked", "empty", "all-null"])
@pytest.mark.parametrize("format_name", ["csv", "parquet"])
@pytest.mark.parametrize("index_policy", ["preserve", "omit"])
def test_pandas_dictionary_exports_use_logical_values_and_reopen(
    tmp_path: Path, shape: str, format_name: str, index_policy: str
) -> None:
    import pyarrow as pa
    import pyarrow.parquet as pq

    from openwrangler_runtime.engines.base import normalize_cell

    families = {
        "text": (pa.string(), "É;quoted'", "a"),
        "large_text": (pa.large_string(), "É;quoted'", "a"),
        "signed": (pa.int64(), 2**53 + 3, -1),
        "unsigned": (pa.uint64(), 2**64 - 1, 1),
        "float": (pa.float64(), 2.5, -0.0),
        "decimal": (pa.decimal128(30, 6), Decimal("2.000001"), Decimal("-1.123456")),
        "negative_decimal": (pa.decimal256(76, -1), Decimal("1200"), Decimal("-300")),
        "boolean": (pa.bool_(), True, False),
        "date": (pa.date32(), date(2024, 2, 29), date(1960, 1, 1)),
        "timestamp": (
            pa.timestamp("us", "UTC"),
            datetime(2024, 2, 29, tzinfo=timezone.utc),
            datetime(1960, 1, 1, tzinfo=timezone.utc),
        ),
        "duration": (pa.duration("us"), timedelta(days=2), timedelta(seconds=-1)),
    }
    codes = [0, 1, 2, 3, None] if shape == "chunked" else ([] if shape == "empty" else [1, None, 1])
    encoded_columns = {}
    logical_columns = {}
    for name, (value_type, first, second) in families.items():
        values = [first, None, second, first]
        books = [values, list(reversed(values)) if shape == "chunked" else values]
        encoded = pa.chunked_array(
            [
                pa.DictionaryArray.from_arrays(
                    pa.array(codes, type=pa.uint8()), pa.array(book, type=value_type), ordered=True
                )
                for book in books
            ]
        )
        encoded_columns[name] = pd.Series(pd.arrays.ArrowExtensionArray(encoded))
        logical_columns[name] = pd.Series(pd.arrays.ArrowExtensionArray(encoded.cast(value_type)))
    source = pd.DataFrame(encoded_columns)
    logical = pd.DataFrame(logical_columns)
    index = pd.MultiIndex.from_arrays(
        [["same"] * len(source), [position % 2 for position in range(len(source))]], names=["group", "label"]
    )
    source.index = index
    logical.index = index
    source.attrs = {"owner": "source"}
    before = source.copy(deep=True)
    engine = PandasEngine()
    paths = {}
    options: Any = {"format": format_name, "rowAxisPolicy": index_policy}
    if format_name == "csv":
        options.update(delimiter=";", quoteChar="'", encoding="utf-16", header=True)
    for name, frame in [("encoded", source), ("logical", logical)]:
        destination = tmp_path / f"{name}.{format_name}"
        destination.touch()
        identity = _regular_file_identity(destination)
        with ExportTarget(destination, *identity).pinned_writer_path() as writer:
            engine.export_data(frame, writer, options)
        paths[name] = destination

    if format_name == "csv":
        assert paths["encoded"].read_bytes() == paths["logical"].read_bytes()
    else:
        actual_table = pq.read_table(paths["encoded"])
        expected_table = pq.read_table(paths["logical"])
        assert actual_table.column_names == expected_table.column_names
        for name in actual_table.column_names:
            actual_column, expected_column = actual_table[name], expected_table[name]
            if name in {"text", "large_text"}:
                # Native StringDtype export chooses its own string offset width.
                actual_column = actual_column.cast(pa.large_string())
                expected_column = expected_column.cast(pa.large_string())
            assert actual_column.equals(expected_column)
        actual = engine.read_file(str(paths["encoded"]))
        expected = engine.read_file(str(paths["logical"]))
        for name in families:
            assert [normalize_cell(value) for value in actual[name].array] == [
                normalize_cell(value) for value in expected[name].array
            ]
        pd.testing.assert_index_equal(actual.index, expected.index)
        assert [column["type"] for column in engine.schema(actual)] == [
            column["type"] for column in engine.schema(expected)
        ]
    pd.testing.assert_index_equal(source.index, before.index)
    pd.testing.assert_index_equal(source.columns, before.columns)
    assert source.dtypes.equals(before.dtypes)
    for name in families:
        current_array: Any = source[name].array
        original_array: Any = before[name].array
        assert current_array.__arrow_array__().equals(original_array.__arrow_array__())
    assert source.attrs == before.attrs


@pytest.mark.parametrize("family", ["text", "unsigned"])
@pytest.mark.parametrize("multi_index", [False, True])
@pytest.mark.parametrize("format_name", ["csv", "parquet"])
@pytest.mark.parametrize("index_policy", ["preserve", "omit"])
def test_pandas_dictionary_index_export_preserves_exact_stored_labels(
    tmp_path: Path, family: str, multi_index: bool, format_name: str, index_policy: str
) -> None:
    import pyarrow as pa
    import pyarrow.parquet as pq

    value_type, values = (
        (pa.string(), ["É;row", None, "other"]) if family == "text" else (pa.uint64(), [2**64 - 1, None, 2**53 + 1])
    )
    encoded = pa.DictionaryArray.from_arrays(pa.array([0, 1, 2], type=pa.uint8()), pa.array(values, type=value_type))
    source_level = pd.Index(pd.arrays.ArrowExtensionArray(encoded), name="label")
    logical_level = pd.Index(pd.arrays.ArrowExtensionArray(encoded.cast(value_type)), name="label")
    if multi_index:
        source_index = pd.MultiIndex(
            levels=[source_level, pd.Index([0, 1])], codes=[[0, 1, -1, 2], [0, 0, 1, 1]], names=["label", "order"]
        )
        logical_index = pd.MultiIndex(
            levels=[logical_level, pd.Index([0, 1])], codes=[[0, 1, -1, 2], [0, 0, 1, 1]], names=["label", "order"]
        )
    else:
        source_index, logical_index = source_level, logical_level
    source = pd.DataFrame({"value": range(len(source_index))}, index=source_index)
    logical = pd.DataFrame({"value": range(len(logical_index))}, index=logical_index)
    before = source.copy(deep=True)
    options: Any = {"format": format_name, "rowAxisPolicy": index_policy}
    if format_name == "csv":
        options.update(delimiter=";", quoteChar="'", encoding="utf-8", header=True)
    engine = PandasEngine()
    paths = {}
    for name, frame in [("encoded", source), ("logical", logical)]:
        destination = tmp_path / f"{name}.{format_name}"
        destination.touch()
        identity = _regular_file_identity(destination)
        with ExportTarget(destination, *identity).pinned_writer_path() as writer:
            engine.export_data(frame, writer, options)
        paths[name] = destination
    if format_name == "csv":
        assert paths["encoded"].read_bytes() == paths["logical"].read_bytes()
    else:
        actual_table, expected_table = [pq.read_table(paths[name]) for name in ["encoded", "logical"]]
        assert actual_table.equals(expected_table, check_metadata=False)
        reopened = engine.read_file(str(paths["encoded"]))
        assert reopened["value"].tolist() == source["value"].tolist()
        if index_policy == "preserve":
            assert reopened.index.names == logical.index.names
            if family == "text":
                pd.testing.assert_index_equal(reopened.index, engine.read_file(str(paths["logical"])).index)
        else:
            pd.testing.assert_index_equal(reopened.index, pd.RangeIndex(len(source)))
    pd.testing.assert_series_equal(source["value"].reset_index(drop=True), before["value"].reset_index(drop=True))
    assert source.index is source_index
    assert source.index.names == before.index.names
    current_levels = list(source.index.levels) if isinstance(source.index, pd.MultiIndex) else [source.index]
    before_levels = list(before.index.levels) if isinstance(before.index, pd.MultiIndex) else [before.index]
    for current_level, before_level in zip(current_levels, before_levels, strict=True):
        if isinstance(current_level.dtype, pd.ArrowDtype):
            current_array: Any = current_level.array
            before_array: Any = before_level.array
            assert current_array.__arrow_array__().equals(before_array.__arrow_array__())
        else:
            pd.testing.assert_index_equal(current_level, before_level)
    if multi_index:
        assert isinstance(source.index, pd.MultiIndex) and isinstance(before.index, pd.MultiIndex)
        assert all(
            (actual == expected).all() for actual, expected in zip(source.index.codes, before.index.codes, strict=True)
        )


@pytest.mark.parametrize("pinned", [False, True])
@pytest.mark.parametrize("encoding", ["utf-8", "utf-16", "latin-1"])
def test_pandas_csv_export_applies_the_exact_dialect_encoding_header_and_index_policy(
    tmp_path: Path, pinned: bool, encoding: str
) -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        {"city": ["café;Nord", "Berlin"], "value": [1, 2]},
        index=pd.Index(["invoice-a", "invoice-b"], name="invoice_id"),
    )
    frame = engine.ensure_row_ids(source, "configured-pandas")
    destination = tmp_path / "configured.csv"
    destination.touch()
    identity = _regular_file_identity(destination)
    target = ExportTarget(destination, *identity)

    with target.pinned_writer_path() if pinned else nullcontext(destination) as writer:
        engine.export_data(
            frame,
            writer,
            {
                "format": "csv",
                "delimiter": ";",
                "quoteChar": "'",
                "encoding": encoding,
                "header": False,
                "rowAxisPolicy": "preserve",
            },
        )

    assert "café;Nord" in destination.read_text(encoding=encoding)
    loaded = pd.read_csv(destination, sep=";", quotechar="'", encoding=encoding, header=None, index_col=0)
    assert loaded.index.tolist() == ["invoice-a", "invoice-b"]
    assert loaded.iloc[:, 0].tolist() == ["café;Nord", "Berlin"]
    assert loaded.iloc[:, 1].tolist() == [1, 2]
    assert source.index.tolist() == ["invoice-a", "invoice-b"]


@pytest.mark.parametrize("unit", ["2s", "3ms", "us", "ns"])
@pytest.mark.parametrize("index_only", [False, True])
def test_pandas_sparse_duration_csv_preserves_reserved_destination(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, unit: str, index_only: bool
) -> None:
    import numpy as np

    import __main__

    native = np.array([1, 0, 1, -(2**63)], dtype=np.int64).view(f"timedelta64[{unit}]")
    values = pd.arrays.SparseArray(native, fill_value=np.timedelta64(0, "s"))
    if unit == "ns":
        values = pd.arrays.SparseArray(values, fill_value=pd.Timedelta(1, "ns"))
    source = pd.DataFrame({"value": values})
    if index_only:
        source = pd.DataFrame({"row": range(4)}, index=pd.Index(source["value"].array, name="duration"))
    else:
        source.index = pd.Index(["same"] * 4, name="rows")
    source.attrs = {"origin": "retained"}
    before = source.copy(deep=True)
    monkeypatch.setattr(__main__, "sparse_export_source", source, raising=False)
    manager = SessionManager()
    destination = tmp_path / "sparse.csv"
    destination.write_bytes(b"preserved destination\n")
    identity = _regular_file_identity(destination)
    options = {
        "format": "csv",
        "delimiter": ",",
        "quoteChar": '"',
        "encoding": "utf-8",
        "header": True,
        "rowAxisPolicy": "preserve" if index_only else "omit",
    }
    try:
        opened = manager.open_session(
            {"kind": "notebookVariable", "label": "Sparse export", "variableName": "sparse_export_source"},
            backend="pandas",
            page_size=4,
            mode="editing",
        )
        metadata = opened["metadata"]
        if unit in {"2s", "3ms"}:
            with pytest.raises(EngineError):
                manager.export_data(
                    metadata["sessionId"],
                    metadata["revision"],
                    str(destination),
                    options,
                    {"device": str(identity[0]), "inode": str(identity[1])},
                )
            assert destination.read_bytes() == b"preserved destination\n"
            assert _regular_file_identity(destination) == identity
            assert (
                manager.get_page(metadata["sessionId"], metadata["revision"], 0, 4, {"filters": [], "sort": []})["page"]
                == opened["page"]
            )
        else:
            exported = manager.export_data(
                metadata["sessionId"],
                metadata["revision"],
                str(destination),
                options,
                {"device": str(identity[0]), "inode": str(identity[1])},
            )
            assert exported["kind"] == "dataExported"
            expected = [["value"], ["0 days 00:00:00.000001"], ["0 days 00:00:00"], ["0 days 00:00:00.000001"], [""]]
            if unit == "ns":
                expected = [["value"], *[["0 days 00:00:00.000000001"]] * 3, [""]]
            if index_only:
                expected = [
                    ["duration", "row"],
                    *[[value[0], str(position)] for position, value in enumerate(expected[1:])],
                ]
            assert list(csv.reader(io.StringIO(destination.read_text()))) == expected
    finally:
        manager.close_all()
    pd.testing.assert_frame_equal(source, before, check_exact=True)
    assert source.attrs == before.attrs

    empty = tmp_path / "empty.csv"
    empty.touch()
    PandasEngine().export_data(source.iloc[:0], empty, options)
    assert empty.read_text() == ("duration,row\n" if index_only else "value\n")
    if index_only:
        retained = source.iloc[:0].copy()
        retained.index = pd.MultiIndex(levels=[source.index[:2]], codes=[[]], names=["duration"])
        retained_level: Any = retained.index.levels[0]
        assert isinstance(retained_level.dtype, pd.SparseDtype)
        PandasEngine().export_data(retained, empty, options)
        assert empty.read_text() == "duration,row\n"
        omitted = tmp_path / "omitted.csv"
        omitted.touch()
        PandasEngine().export_data(source, omitted, {**options, "rowAxisPolicy": "omit"})
        assert omitted.read_text() == "row\n0\n1\n2\n3\n"


@pytest.mark.parametrize("family", ["timestamp", "duration"])
@pytest.mark.parametrize("storage", ["direct", "dictionary", "categorical", "index", "multiindex"])
def test_pandas_temporal_csv_preserves_exact_fields_and_source(tmp_path: Path, family: str, storage: str) -> None:
    import pyarrow as pa

    ticks = [0, -(2**63), -(2**63) + 1, None, -1, 2**63 - 1, 123456000]
    timestamp = family == "timestamp"
    dtype = pa.timestamp("ns", "America/New_York") if timestamp else pa.duration("ns")
    expected = (
        [
            "1969-12-31 19:00:00-05:00",
            "1677-09-20 19:16:41.145224192-04:56:02",
            "1677-09-20 19:16:41.145224193-04:56:02",
            "",
            "1969-12-31 18:59:59.999999999-05:00",
            "2262-04-11 19:47:16.854775807-04:00",
            "1969-12-31 19:00:00.123456-05:00",
        ]
        if timestamp
        else [
            "0 days 00:00:00",
            "-9223372036854775808 ns",
            "-106752 days +00:12:43.145224193",
            "",
            "-1 days +23:59:59.999999999",
            "106751 days 23:47:16.854775807",
            "0 days 00:00:00.123456",
        ]
    )
    native = pa.array(ticks, type=dtype)
    chunks = [native.slice(0, 3), native.slice(3)]
    if storage == "dictionary":
        chunks = [chunk.dictionary_encode() for chunk in chunks]
    values = pd.Series(pd.arrays.ArrowExtensionArray(pa.chunked_array(chunks)))
    if storage == "categorical":
        categories = pd.Index(
            pd.arrays.ArrowExtensionArray(pa.array([value for value in ticks if value is not None], type=dtype))
        )
        values = pd.Series(pd.Categorical.from_codes([0, 1, 2, -1, 3, 4, 5], categories=categories, ordered=True))
    source = pd.DataFrame({"value": values, "text": ["é;quoted'\n"] * len(values)})
    logical = pd.DataFrame({"value": expected, "text": source["text"]})
    preserve_index = storage in {"index", "multiindex"}
    if preserve_index:
        index = pd.Index(values.array, name="value")
        source = source.drop(columns="value")
        logical = logical.drop(columns="value")
        source.index = index
        logical.index = pd.Index(expected, name="value")
        if storage == "multiindex":
            source.index = pd.MultiIndex.from_arrays([index, ["same"] * len(source)], names=["value", "group"])
            logical.index = pd.MultiIndex.from_arrays([expected, ["same"] * len(source)], names=source.index.names)
    source.attrs = {"owner": "unchanged"}
    before = source.copy(deep=True)
    original_index = source.index
    destination = tmp_path / "temporal.csv"
    destination.write_bytes(b"reserved destination")
    identity = _regular_file_identity(destination)
    options: Any = {
        "format": "csv",
        "delimiter": ";",
        "quoteChar": "'",
        "encoding": "utf-16",
        "header": True,
        "rowAxisPolicy": "preserve" if preserve_index else "omit",
    }
    PandasEngine().export_data(source, ExportWriterPath(destination, *identity), options)
    assert destination.read_bytes() == logical.to_csv(index=preserve_index, sep=";", quotechar="'").encode("utf-16")
    assert _regular_file_identity(destination) == identity
    pd.testing.assert_frame_equal(source, before, check_exact=True)
    assert source.index is original_index and source.attrs == {"owner": "unchanged"}


@pytest.mark.parametrize(
    "zone,seconds",
    [
        ("Europe/Amsterdam", -2208988800),
        ("America/New_York", -5364662400),
        ("UTC+01:00", 1672531200),
        ("dateutil/Europe/London", 1672531200),
    ],
)
def test_pandas_temporal_csv_preserves_native_timezone_names_and_fractional_fields(
    tmp_path: Path, zone: str, seconds: int
) -> None:
    import pyarrow as pa

    values = pa.array(
        [seconds * 10**9, seconds * 10**9 + 145224000, seconds * 10**9 + 145224193, None], type=pa.timestamp("ns", zone)
    )
    source = pd.DataFrame({"value": pd.arrays.ArrowExtensionArray(values)})
    ordinary = source.iloc[:2].to_csv(index=False).splitlines()[1:]
    assert ".145224" in ordinary[1]
    expected = ordinary[1].replace(".145224", ".145224193", 1)
    destination = tmp_path / "offset.csv"
    destination.touch()
    PandasEngine().export_data(source, destination, {**PANDAS_CSV_OPTIONS, "rowAxisPolicy": "omit"})
    fields = list(csv.reader(io.StringIO(destination.read_text())))[1:]
    assert fields == [[value] for value in [*ordinary, expected, ""]]
    current: Any = source["value"].array
    assert current.__arrow_array__().equals(pa.chunked_array([values]))


@pytest.mark.parametrize(
    "unit,zone,tick,expected",
    [
        ("ns", "UTC+01:00", -(2**63), "1677-09-21 01:12:43.145224192+01:00"),
        ("s", "dateutil/Europe/London", -62135596800 + 75, "0001-01-01 00:00:00-00:01:15"),
        ("ms", "UTC+01:00", 253402300800000 - 3600000 - 1, "9999-12-31 23:59:59.999000+01:00"),
        ("us", "dateutil/Europe/London", (-62135596800 + 75) * 1000000 + 1, "0001-01-01 00:00:00.000001-00:01:15"),
    ],
)
def test_pandas_temporal_csv_preserves_timezone_boundary_values(
    tmp_path: Path, unit: str, zone: str, tick: int, expected: str
) -> None:
    import pyarrow as pa

    values = pa.array([tick, None], type=pa.timestamp(unit, zone))
    source = pd.DataFrame({"value": pd.arrays.ArrowExtensionArray(values), "row": [0, 1]})
    original_index = source.index
    destination = tmp_path / "boundary.csv"
    destination.write_bytes(b"reserved destination")
    identity = _regular_file_identity(destination)
    PandasEngine().export_data(
        source, ExportWriterPath(destination, *identity), {**PANDAS_CSV_OPTIONS, "rowAxisPolicy": "omit"}
    )
    assert list(csv.reader(io.StringIO(destination.read_text()))) == [["value", "row"], [expected, "0"], ["", "1"]]
    assert _regular_file_identity(destination) == identity
    current: Any = source["value"].array
    assert current.__arrow_array__().equals(pa.chunked_array([values]))
    assert source.index is original_index and source["row"].tolist() == [0, 1]


@pytest.mark.parametrize("unit", ["s", "ms", "us"])
def test_pandas_temporal_csv_preserves_coarse_duration_sentinels(tmp_path: Path, unit: str) -> None:
    import pyarrow as pa

    values = pa.array([0, -(2**63), None], type=pa.duration(unit))
    source = pd.DataFrame({"value": pd.arrays.ArrowExtensionArray(values), "row": [0, 1, 2]})
    destination = tmp_path / "duration.csv"
    destination.touch()
    PandasEngine().export_data(source, destination, {**PANDAS_CSV_OPTIONS, "rowAxisPolicy": "omit"})
    assert list(csv.reader(io.StringIO(destination.read_text()))) == [
        ["value", "row"],
        ["0 days 00:00:00", "0"],
        [f"{-(2**63)} {unit}", "1"],
        ["", "2"],
    ]
    current: Any = source["value"].array
    assert current.__arrow_array__().equals(pa.chunked_array([values]))


@pytest.mark.parametrize("family", ["timestamp", "duration"])
def test_pandas_temporal_csv_categorical_nulls_keep_coarse_native_spelling(tmp_path: Path, family: str) -> None:
    import pyarrow as pa

    timestamp = family == "timestamp"
    dtype = pa.timestamp("us", "UTC") if timestamp else pa.duration("us")
    values = pa.array([0, 1, 16725225600000000 if timestamp else 10000000000000000], type=dtype)
    categories = pd.Index(pd.arrays.ArrowExtensionArray(values))
    source = pd.DataFrame({"value": pd.Categorical.from_codes([0, -1, 1, 2], categories=categories)})
    destination = tmp_path / "category.csv"
    destination.touch()
    PandasEngine().export_data(source, destination, {**PANDAS_CSV_OPTIONS, "rowAxisPolicy": "omit"})
    expected = (
        ["1970-01-01 00:00:00+00:00", "", "1970-01-01 00:00:00.000001+00:00", "2500-01-01 00:00:00+00:00"]
        if timestamp
        else ["0 days 00:00:00", "", "0 days 00:00:00.000001", "115740 days 17:46:40"]
    )
    assert list(csv.reader(io.StringIO(destination.read_text())))[1:] == [[value] for value in expected]
    assert source["value"].cat.codes.tolist() == [0, -1, 1, 2]
    assert source["value"].cat.categories.array.__arrow_array__().equals(pa.chunked_array([values]))


@pytest.mark.parametrize(
    "unit,zone,bound",
    [
        ("s", None, "minimum"),
        ("ms", "UTC", "maximum"),
        ("us", None, "minimum"),
        ("s", "-01:00", "local-minimum"),
        ("ms", "+01:00", "local-maximum"),
        ("us", "America/New_York", "local-minimum"),
        ("s", "dateutil/Europe/London", "london-local-minimum"),
        ("ms", "UTC+01:00", "utc-plus-one-local-maximum"),
    ],
)
def test_pandas_temporal_csv_calendar_refusal_precedes_writer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, unit: str, zone: str | None, bound: str
) -> None:
    import pyarrow as pa

    scale = {"s": 1, "ms": 1000, "us": 1000000}[unit]
    tick = {
        "minimum": -(2**63),
        "maximum": 2**63 - 1,
        "local-minimum": -62135596800 * scale,
        "local-maximum": 253402300800 * scale - 1,
        "london-local-minimum": (-62135596800 + 75) * scale - 1,
        "utc-plus-one-local-maximum": (253402300800 - 3600) * scale,
    }[bound]
    values = pa.array([0, tick, None], type=pa.timestamp(unit, zone))
    source = pd.DataFrame({"value": pd.arrays.ArrowExtensionArray(values)})
    destination = tmp_path / "calendar.csv"
    destination.write_bytes(b"preserved destination\n")
    identity = _regular_file_identity(destination)
    # This guard also makes the original-regression run safe: native formatting
    # of coarse out-of-calendar timestamps has crashed supported Pandas versions.
    monkeypatch.setattr(
        ExportWriterPath, "open_binary_writer", lambda *_: pytest.fail("calendar refusal opened the writer")
    )
    with pytest.raises(EngineError, match="CSV.*timestamp.*years 1.*9999"):
        PandasEngine().export_data(
            source, ExportWriterPath(destination, *identity), {**PANDAS_CSV_OPTIONS, "rowAxisPolicy": "omit"}
        )
    assert destination.read_bytes() == b"preserved destination\n"
    assert _regular_file_identity(destination) == identity
    current: Any = source["value"].array
    assert current.__arrow_array__().equals(pa.chunked_array([values]))


@pytest.mark.parametrize("storage", ["categorical", "multiindex"])
def test_pandas_temporal_csv_ignores_unused_empty_and_omitted_labels(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, storage: str
) -> None:
    import pyarrow as pa

    values = pa.array([0, 1, -(2**63)], type=pa.timestamp("us"))
    labels = pd.Index(pd.arrays.ArrowExtensionArray(values), name="value")
    native_astype = pd.arrays.ArrowExtensionArray.astype

    def safe_astype(array: Any, dtype: Any, *args: Any, **kwargs: Any) -> Any:
        if isinstance(array.dtype, pd.ArrowDtype) and pa.types.is_timestamp(array.dtype.pyarrow_dtype):
            assert -(2**63) not in array.__arrow_array__().cast(pa.int64()).to_pylist(), (
                "unused unsafe label reached boxing"
            )
        return native_astype(array, dtype, *args, **kwargs)

    monkeypatch.setattr(pd.arrays.ArrowExtensionArray, "astype", safe_astype)
    codes = [0, -1, 1, 0]
    source = pd.DataFrame({"row": range(len(codes))})
    if storage == "categorical":
        source.insert(0, "value", pd.Categorical.from_codes(codes, categories=labels))
    else:
        source.index = pd.MultiIndex(levels=[labels], codes=[codes], names=["value"])
    original_index = source.index
    destination = tmp_path / "unused.csv"
    destination.touch()
    options = {**PANDAS_CSV_OPTIONS, "rowAxisPolicy": "preserve" if storage == "multiindex" else "omit"}
    PandasEngine().export_data(source, destination, options)
    assert list(csv.reader(io.StringIO(destination.read_text()))) == [
        ["value", "row"],
        ["1970-01-01 00:00:00", "0"],
        ["", "1"],
        ["1970-01-01 00:00:00.000001", "2"],
        ["1970-01-01 00:00:00", "3"],
    ]
    PandasEngine().export_data(source.iloc[:0], destination, options)
    assert destination.read_text() == "value,row\n"
    if storage == "multiindex":
        omitted = pd.DataFrame({"row": [0]}, index=pd.Index(labels.array.take([2]), name="value"))
        omitted_index = omitted.index
        PandasEngine().export_data(omitted, destination, {**PANDAS_CSV_OPTIONS, "rowAxisPolicy": "omit"})
        assert destination.read_text() == "row\n0\n"
        assert omitted.index is omitted_index
        assert omitted["row"].tolist() == [0]
        assert isinstance(source.index, pd.MultiIndex)
        current_codes: Any = source.index.codes[0]
        assert current_codes.tolist() == codes
        current_labels: Any = source.index.levels[0]
    else:
        assert source["value"].cat.codes.tolist() == codes
        current_labels = source["value"].cat.categories
    assert current_labels.array.__arrow_array__().equals(pa.chunked_array([values]))
    assert source.index is original_index


@pytest.mark.parametrize("unsafe", [False, True])
def test_pandas_temporal_csv_session_preserves_revision_and_reserved_destination(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, unsafe: bool
) -> None:
    import pyarrow as pa

    import __main__

    values = pa.array(
        [0, 253402300800000000 if unsafe else -(2**63), None], type=pa.timestamp("us" if unsafe else "ns", "UTC")
    )
    source = pd.DataFrame({"value": pd.arrays.ArrowExtensionArray(values)})
    monkeypatch.setattr(__main__, "temporal_export_source", source, raising=False)
    manager = SessionManager()
    destination = tmp_path / "session.csv"
    destination.write_bytes(b"preserved destination\n")
    identity = _regular_file_identity(destination)
    try:
        opened = manager.open_session(
            {"kind": "notebookVariable", "label": "Temporal export", "variableName": "temporal_export_source"},
            backend="pandas",
            page_size=1,
            mode="editing",
        )
        session_id, revision = opened["metadata"]["sessionId"], opened["metadata"]["revision"]
        if unsafe:
            monkeypatch.setattr(
                ExportWriterPath, "open_binary_writer", lambda *_: pytest.fail("calendar refusal opened the writer")
            )
        with pytest.raises(EngineError, match="CSV.*timestamp.*years 1.*9999") if unsafe else nullcontext():
            result = manager.export_data(
                session_id,
                revision,
                str(destination),
                {**PANDAS_CSV_OPTIONS, "rowAxisPolicy": "omit"},
                {"device": str(identity[0]), "inode": str(identity[1])},
            )
            assert result["kind"] == "dataExported"
        if unsafe:
            assert destination.read_bytes() == b"preserved destination\n"
        else:
            assert list(csv.reader(io.StringIO(destination.read_text())))[1:] == [
                ["1970-01-01 00:00:00+00:00"],
                ["1677-09-21 00:12:43.145224192+00:00"],
                [""],
            ]
        after = manager.get_page(session_id, revision, 0, 1, {"filters": [], "sort": []})
        assert after["metadata"] == opened["metadata"] and after["page"] == opened["page"]
        assert _regular_file_identity(destination) == identity
        current: Any = source["value"].array
        assert current.__arrow_array__().equals(pa.chunked_array([values]))
    finally:
        manager.close_all()


def test_pandas_temporal_csv_bounds_high_cardinality_category_boxing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import pyarrow as pa

    ticks = [*range(70000), -(2**63)]
    values = pa.array(ticks, type=pa.duration("ns"))
    categories = pd.Index(pd.arrays.ArrowExtensionArray(values))
    codes = list(range(len(ticks)))
    source = pd.DataFrame({"value": pd.Categorical.from_codes(codes, categories=categories)})
    native_astype = pd.arrays.ArrowExtensionArray.astype

    def bounded_astype(array: Any, dtype: Any, *args: Any, **kwargs: Any) -> Any:
        if (
            isinstance(array.dtype, pd.ArrowDtype)
            and pa.types.is_duration(array.dtype.pyarrow_dtype)
            and pd.api.types.is_object_dtype(dtype)
        ):
            assert len(array) <= 64000, "temporal export boxed a complete high-cardinality category dictionary"
        return native_astype(array, dtype, *args, **kwargs)

    monkeypatch.setattr(pd.arrays.ArrowExtensionArray, "astype", bounded_astype)
    destination = tmp_path / "bounded.csv"
    destination.touch()
    PandasEngine().export_data(source, destination, {**PANDAS_CSV_OPTIONS, "rowAxisPolicy": "omit"})
    fields = [row[0] for row in list(csv.reader(io.StringIO(destination.read_text())))[1:]]
    assert fields == [
        *[str(pd.Timedelta(value, unit="ns")) for value in range(70000)],
        "-9223372036854775808 ns",
    ]
    assert source["value"].cat.codes.tolist() == codes
    assert source["value"].cat.categories.array.__arrow_array__().equals(pa.chunked_array([values]))


@pytest.mark.parametrize("unit", ["ns", "us", "ms"])
def test_pandas_temporal_parquet_keeps_native_ticks(tmp_path: Path, unit: str) -> None:
    import pyarrow as pa
    import pyarrow.parquet as pq

    source = pd.DataFrame(
        {
            name: pd.arrays.ArrowExtensionArray(pa.array([0, -(2**63), None], type=dtype))
            for name, dtype in [("timestamp", pa.timestamp(unit, "UTC")), ("duration", pa.duration(unit))]
        }
    )
    arrays: list[Any] = [source[name].array for name in source]
    original = [array.__arrow_array__() for array in arrays]
    destination = tmp_path / "temporal.parquet"
    destination.touch()
    PandasEngine().export_data(source, destination, {"format": "parquet", "rowAxisPolicy": "omit"})
    loaded = pq.read_table(destination)
    for name, expected in zip(source, original, strict=True):
        assert loaded[name].equals(expected)
        current: Any = source[name].array
        assert current.__arrow_array__().equals(expected)


@pytest.fixture(params=["pandas", "polars-eager", "polars-lazy"])
def native_export(request: pytest.FixtureRequest) -> tuple[Any, Any, str]:
    engine: Any
    frame: Any
    if request.param == "pandas":
        engine = PandasEngine()
        frame = pd.DataFrame({"value": [1, 2]})
    else:
        engine = PolarsEngine()
        frame = pl.DataFrame({"value": [1, 2]})
        if request.param == "polars-lazy":
            frame = frame.lazy()
    return engine, engine.ensure_row_ids(frame, "pinned-export"), str(request.param)


@pytest.mark.parametrize(
    "dtype, values",
    [
        ("HUGEINT", [2**53 + 1, -(2**53 + 1), 10**38 - 1, -(10**38 - 1), None]),
        ("UHUGEINT", [2**53 + 1, 10**38 - 1, None]),
        ("HUGEINT", [None, None]),
        ("UHUGEINT", []),
    ],
)
def test_duckdb_parquet_preserves_exact_128_bit_columns(tmp_path: Path, dtype: str, values: list[int | None]) -> None:
    query = (
        " UNION ALL ".join(
            f"SELECT {repr(str(value)) if value is not None else 'NULL'}::{dtype} AS value" for value in values
        )
        if values
        else f"SELECT NULL::{dtype} AS value WHERE FALSE"
    )
    source = duckdb.sql(query).project('value AS "exact "" amount"')
    before, types, columns = source.fetchall(), source.types, source.columns
    destination = tmp_path / "integers.parquet"
    destination.touch()
    identity = _regular_file_identity(destination)
    engine = DuckDBEngine()
    try:
        with ExportTarget(destination, *identity).pinned_writer_path() as writer:
            engine.export_data(source, writer, {"format": "parquet"})
        loaded = duckdb.read_parquet(str(destination))
        assert loaded.fetchall() == before
        assert loaded.columns == columns
        assert [str(dtype) for dtype in loaded.types] == ["DECIMAL(38,0)"]
        assert all(isinstance(row[0], Decimal) for row in loaded.fetchall() if row[0] is not None)
        assert _regular_file_identity(destination) == identity
        assert source.fetchall() == before and source.types == types and source.columns == columns
    finally:
        engine.close()


@pytest.mark.parametrize("dtype, outside", [("HUGEINT", 10**38), ("HUGEINT", -(10**38)), ("UHUGEINT", 2**128 - 1)])
def test_duckdb_parquet_refuses_out_of_capacity_after_a_valid_row(tmp_path: Path, dtype: str, outside: int) -> None:
    source = duckdb.sql(f"SELECT '1'::{dtype} AS value UNION ALL SELECT '{outside}'::{dtype}")
    before, types = source.fetchall(), source.types
    destination = tmp_path / "unpublished.parquet"
    destination.touch()
    identity = _regular_file_identity(destination)
    engine = DuckDBEngine()
    try:
        with (
            ExportTarget(destination, *identity).pinned_writer_path() as writer,
            pytest.raises(EngineError, match="DECIMAL"),
        ):
            engine.export_data(source, writer, {"format": "parquet"})
        # A native write may leave partial unpublished bytes; publication requires success.
        assert _regular_file_identity(destination) == identity
        assert source.fetchall() == before and source.types == types
    finally:
        engine.close()


@pytest.mark.parametrize(
    "expression",
    [
        "{'outer': [{'inner': 9007199254740993::HUGEINT}]}",
        "[9007199254740993::UHUGEINT, NULL]",
        "[9007199254740993::HUGEINT, NULL]::HUGEINT[2]",
        "MAP([9007199254740993::HUGEINT], [1])",
        "MAP(['a'], [{'value': 9007199254740993::UHUGEINT}])",
        "union_value(value := 9007199254740993::HUGEINT)",
    ],
)
def test_duckdb_parquet_refuses_nested_128_bit_types_before_opening_writer(tmp_path: Path, expression: str) -> None:
    source = duckdb.sql(f"SELECT {expression} AS nested")
    before, types = source.fetchall(), source.types
    destination = tmp_path / "unpublished.parquet"
    destination.write_bytes(b"host reserved")
    identity = _regular_file_identity(destination)
    engine = DuckDBEngine()
    try:
        with (
            ExportTarget(destination, *identity).pinned_writer_path() as writer,
            pytest.raises(EngineError, match="nested 128-bit integers"),
        ):
            engine.export_data(source, writer, {"format": "parquet"})
        assert destination.read_bytes() == b"host reserved"
        assert _regular_file_identity(destination) == identity
        assert source.fetchall() == before and source.types == types
    finally:
        engine.close()


def test_duckdb_parquet_retains_other_native_types_and_same_spelling_names(tmp_path: Path) -> None:
    source = duckdb.sql(
        "SELECT 9007199254740993::BIGINT AS HUGEINT, 18446744073709551615::UBIGINT AS UHUGEINT, "
        "'12345678901234567890.123'::DECIMAL(38,3) AS amount, 0.5::DOUBLE AS fraction, "
        "{'HUGEINT': [9007199254740993::BIGINT, NULL]} AS nested, "
        "'HUGEINT'::ENUM('HUGEINT', 'UHUGEINT') AS category"
    )
    before, types = source.fetchall(), source.types
    native = tmp_path / "native.parquet"
    source.write_parquet(str(native))
    destination = tmp_path / "owned.parquet"
    destination.touch()
    identity = _regular_file_identity(destination)
    engine = DuckDBEngine()
    try:
        with ExportTarget(destination, *identity).pinned_writer_path() as writer:
            engine.export_data(source, writer, {"format": "parquet"})
        loaded, expected = duckdb.read_parquet(str(destination)), duckdb.read_parquet(str(native))
        assert loaded.fetchall() == expected.fetchall() == before
        # Parquet's existing Enum-to-VARCHAR behavior remains native.
        assert loaded.types == expected.types and loaded.columns == expected.columns
        assert source.fetchall() == before and source.types == types
    finally:
        engine.close()


@pytest.mark.parametrize(
    "expression",
    [
        "INTERVAL '1 microsecond'",
        "to_microseconds(4294967296000::BIGINT)",
        "[INTERVAL '1 microsecond', NULL]",
        "[INTERVAL '1 millisecond', INTERVAL '1001 microseconds']::INTERVAL[2]",
        '[struct_pack("_ow_nested_1" := [struct_pack("quote\' -> ""name" := INTERVAL \'1 microsecond\')])]',
        "MAP(['a'], [INTERVAL '1 microsecond'])",
        "MAP([INTERVAL '1 microsecond', INTERVAL '2 microseconds'], ['a', 'b'])",
        "union_value(value := INTERVAL '1 microsecond')::UNION(value INTERVAL, other VARCHAR)",
        "MAP(['12:00:00+02'::TIMETZ], ['value'])",
        "MAP([[struct_pack(clock := '12:00:00+02'::TIMETZ)]], ['value'])",
    ],
)
def test_duckdb_parquet_refuses_altered_temporal_values(tmp_path: Path, expression: str) -> None:
    source = duckdb.sql(f'SELECT {expression} AS "_ow_nested_0", 42 AS "_ow_nested_1"')
    before = source.project('"_ow_nested_0"::VARCHAR, "_ow_nested_1"').fetchall()
    types, columns = source.types, source.columns
    destination = tmp_path / "unpublished.parquet"
    destination.touch()
    identity = _regular_file_identity(destination)
    engine = DuckDBEngine()
    try:
        with (
            ExportTarget(destination, *identity).pinned_writer_path() as writer,
            pytest.raises(EngineError, match="cannot preserve.*temporal"),
        ):
            engine.export_data(source, writer, {"format": "parquet"})
        assert _regular_file_identity(destination) == identity
        assert source.project('"_ow_nested_0"::VARCHAR, "_ow_nested_1"').fetchall() == before
        assert source.types == types and source.columns == columns
    finally:
        engine.close()


@pytest.mark.parametrize(
    "expression, legacy_refuses_values",
    [
        ("[INTERVAL '1 month 2 days 3 milliseconds', NULL]", False),
        ("[INTERVAL '1 millisecond', NULL]::INTERVAL[2]", False),
        ("struct_pack(value := to_microseconds(4294967295000::BIGINT), other := 'TIMETZ')", False),
        ("MAP([INTERVAL '1 month', INTERVAL '2 months'], ['a', 'b'])", False),
        ("union_value(value := INTERVAL '1 millisecond')::UNION(value INTERVAL, other VARCHAR)", False),
        ("[]::INTERVAL[]", False),
        ("MAP([]::TIMETZ[], []::VARCHAR[])", False),
        ("MAP(['10:00:00+00'::TIMETZ], ['value'])", False),
        ("['12:00:00+02'::TIMETZ, NULL]", True),
        ("['12:00:00+02'::TIMETZ, NULL]::TIMETZ[2]", True),
        ("struct_pack(clock := '12:00:00+02'::TIMETZ)", True),
        ("MAP(['a'], ['12:00:00+02'::TIMETZ])", True),
        ("union_value(clock := '12:00:00+02'::TIMETZ)::UNION(clock TIMETZ, other VARCHAR)", True),
        ("union_value(other := 'ordinary')::UNION(clock TIMETZ, value INTERVAL, other VARCHAR)", False),
    ],
)
def test_duckdb_parquet_preserves_supported_nested_temporal_values(
    tmp_path: Path, expression: str, legacy_refuses_values: bool
) -> None:
    source = duckdb.sql(f"SELECT {expression} AS \"value 'quoted'\" UNION ALL SELECT NULL")
    before = source.project("\"value 'quoted'\"::VARCHAR").fetchall()
    engine = DuckDBEngine()
    try:
        for shape, selected in (
            ("values", source),
            ("null", source.filter("\"value 'quoted'\" IS NULL")),
            ("empty", source.limit(0)),
        ):
            native = tmp_path / f"native-{shape}.parquet"
            selected.write_parquet(str(native))
            destination = tmp_path / f"owned-{shape}.parquet"
            destination.touch()
            identity = _regular_file_identity(destination)
            refuses = legacy_refuses_values and duckdb.__version__ == "1.5.4" and shape == "values"
            with (
                ExportTarget(destination, *identity).pinned_writer_path() as writer,
                pytest.raises(EngineError, match="cannot preserve.*temporal") if refuses else nullcontext(),
            ):
                engine.export_data(selected, writer, {"format": "parquet"})
            if not refuses:
                loaded, expected = duckdb.read_parquet(str(destination)), duckdb.read_parquet(str(native))
                assert (
                    loaded.project("\"value 'quoted'\"::VARCHAR").fetchall()
                    == expected.project("\"value 'quoted'\"::VARCHAR").fetchall()
                )
                assert loaded.types == expected.types and loaded.columns == expected.columns
            assert _regular_file_identity(destination) == identity
        assert source.project("\"value 'quoted'\"::VARCHAR").fetchall() == before
    finally:
        engine.close()


def test_duckdb_parquet_top_level_timetz_preserves_native_utc_and_corrects_offsets(tmp_path: Path) -> None:
    source = duckdb.sql(
        "SELECT clock::TIMETZ AS clock FROM (VALUES ('12:34:56.123456+02'), "
        "('00:01:00+14'), ('24:00:00+00'), (NULL)) AS clocks(clock)"
    )
    before = source.project("clock::VARCHAR").fetchall()
    expected = duckdb.sql(
        "SELECT clock::TIMETZ AS clock FROM (VALUES ('10:34:56.123456+00'), "
        "('10:01:00+00'), ('24:00:00+00'), (NULL)) AS clocks(clock)"
    )
    native = tmp_path / "native-utc.parquet"
    expected.write_parquet(str(native))
    destination = tmp_path / "clocks.parquet"
    destination.touch()
    engine = DuckDBEngine()
    try:
        with ExportTarget(destination, *_regular_file_identity(destination)).pinned_writer_path() as writer:
            engine.export_data(source, writer, {"format": "parquet"})
        loaded, control = duckdb.read_parquet(str(destination)), duckdb.read_parquet(str(native))
        assert loaded.project("clock::VARCHAR").fetchall() == control.project("clock::VARCHAR").fetchall()
        assert loaded.types == control.types == source.types
        assert source.project("clock::VARCHAR").fetchall() == before
    finally:
        engine.close()


@pytest.mark.parametrize("key", ["'24:00:00+00'::TIMETZ", "struct_pack(clock := '24:00:00+00'::TIMETZ)"])
def test_duckdb_parquet_map_keys_retain_native_midnight_identity(tmp_path: Path, key: str) -> None:
    source = duckdb.sql(f"SELECT MAP([{key}], ['value']) AS value")
    lookup = f"map_extract_value(value, {key})"
    assert source.project(lookup).fetchall() == [("value",)]
    destination = tmp_path / "keys.parquet"
    destination.touch()
    engine = DuckDBEngine()
    try:
        with (
            ExportTarget(destination, *_regular_file_identity(destination)).pinned_writer_path() as writer,
            nullcontext()
            if duckdb.__version__ == "1.5.4"
            else pytest.raises(EngineError, match="cannot preserve.*temporal"),
        ):
            engine.export_data(source, writer, {"format": "parquet"})
        if duckdb.__version__ == "1.5.4":
            assert duckdb.read_parquet(str(destination)).project(lookup).fetchall() == [("value",)]
        assert source.project(lookup).fetchall() == [("value",)]
    finally:
        engine.close()


@pytest.mark.parametrize("format_name", ["csv", "parquet"])
def test_native_exports_write_the_host_pinned_target(
    tmp_path: Path, native_export: tuple[Any, Any, str], format_name: str
) -> None:
    engine, frame, backend = native_export
    destination = tmp_path / f"host-reserved.{format_name}"
    destination.touch()
    identity = _regular_file_identity(destination)
    options = (
        {"format": "parquet"}
        if format_name == "parquet"
        else {"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": "utf-8", "header": True}
    )
    if backend == "pandas":
        options["rowAxisPolicy"] = "omit"
    with ExportTarget(destination, *identity).pinned_writer_path() as writer:
        engine.export_data(frame, writer, options)
    loaded = pl.read_parquet(destination) if format_name == "parquet" else pl.read_csv(destination)
    assert loaded.to_dict(as_series=False) == {"value": [1, 2]}


@pytest.mark.skipif(sys.platform == "win32", reason="Windows pins prevent target replacement")
@pytest.mark.parametrize("format_name", ["csv", "parquet"])
@pytest.mark.parametrize("replacement", ["symlink", "regular"])
@pytest.mark.parametrize("replace_during_write", [False, True])
def test_native_exports_never_write_a_replacement_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    native_export: tuple[Any, Any, str],
    format_name: str,
    replacement: str,
    replace_during_write: bool,
) -> None:
    engine, frame, backend = native_export
    destination = tmp_path / f"host-reserved.{format_name}"
    destination.touch()
    identity = _regular_file_identity(destination)
    displaced = tmp_path / "displaced.tmp"
    source = tmp_path / "source.csv"
    source.write_bytes(b"original source data\n")

    def replace_target() -> None:
        destination.rename(displaced)
        if replacement == "symlink":
            destination.symlink_to(source)
        else:
            destination.write_bytes(b"foreign replacement\n")

    if replace_during_write:
        frame_type = pd.DataFrame if backend == "pandas" else pl.LazyFrame if backend == "polars-lazy" else pl.DataFrame
        prefix = "to_" if backend == "pandas" else "sink_" if backend == "polars-lazy" else "write_"
        method_name = prefix + format_name
        original_write = getattr(frame_type, method_name)

        def write_after_replacement(native_frame, *args, **kwargs):
            replace_target()
            return original_write(native_frame, *args, **kwargs)

        monkeypatch.setattr(frame_type, method_name, write_after_replacement)

    options = (
        {"format": "parquet"}
        if format_name == "parquet"
        else {"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": "utf-8", "header": True}
    )
    if backend == "pandas":
        options["rowAxisPolicy"] = "omit"
    with (
        pytest.raises(ExportTargetError),
        ExportTarget(destination, *identity).pinned_writer_path() as writer,
    ):
        if not replace_during_write:
            replace_target()
        engine.export_data(frame, writer, options)

    assert source.read_bytes() == b"original source data\n"
    assert destination.read_bytes() == (
        b"original source data\n" if replacement == "symlink" else b"foreign replacement\n"
    )


@pytest.mark.parametrize("backend", ["polars", "duckdb"])
def test_native_utf8_csv_export_applies_ascii_dialect_and_header_options(tmp_path: Path, backend: str) -> None:
    destination = tmp_path / f"configured-{backend}.csv"
    options = {
        "format": "csv",
        "delimiter": ";",
        "quoteChar": "'",
        "encoding": "utf-8",
        "header": False,
    }
    if backend == "polars":
        engine = PolarsEngine()
        frame: Any = pl.LazyFrame({"city": ["Milan;'North", "Berlin"], "value": [1, 2]})
    else:
        engine = DuckDBEngine()
        frame = engine._relation_from_sql(
            "SELECT 'Milan;''North' AS city, 1 AS value UNION ALL SELECT 'Berlin' AS city, 2 AS value"
        )

    engine.export_data(frame, destination, options)

    loaded = pl.read_csv(destination, separator=";", quote_char="'", has_header=False, new_columns=["city", "value"])
    assert loaded.to_dict(as_series=False) == {"city": ["Milan;'North", "Berlin"], "value": [1, 2]}


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize("field", ["delimiter", "quoteChar"])
@pytest.mark.parametrize(
    "dtype,values,syntax",
    [
        (pl.Int64, [-12, None], "-"),
        (pl.UInt64, [12, None], "1"),
        (pl.Float64, [1e20, None], "+"),
        (pl.Float32, [float("inf"), None], "i"),
        (pl.Float64, [float("nan"), None], "N"),
        (pl.Decimal(9, 2), [Decimal("-1.25"), None], "."),
        (pl.Boolean, [True, None], "t"),
        (pl.Date, [date(2026, 1, 1), None], "-"),
        (pl.Date, [3_000_000, None], "+"),
        (pl.Time, [time(3, 4, 5, 123456), None], ":"),
        (pl.Datetime("ns", "UTC"), [datetime(2026, 1, 1, tzinfo=timezone.utc), None], "T"),
        (pl.Float64, [], "."),
        (pl.Float64, [None, None], "."),
    ],
)
def test_polars_csv_restricted_syntax_refuses_before_writer_or_lazy_execution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, lazy: bool, field: str, dtype: Any, values: list[Any], syntax: str
) -> None:
    source = pl.DataFrame(
        {"value": pl.Series(values, dtype=dtype), "text": pl.Series(['é,"\n'] * len(values), dtype=pl.String)}
    )
    before = source.clone()
    engine = PolarsEngine()
    frame = engine.ensure_row_ids(source.lazy() if lazy else source, "csv-syntax")
    evaluated: list[int] = []
    if lazy:

        def observe(batch: pl.DataFrame) -> pl.DataFrame:
            evaluated.append(batch.height)
            return batch

        frame = frame.map_batches(observe, schema=frame.collect_schema(), projection_pushdown=False)
    destination = tmp_path / "reserved.csv"
    destination.write_bytes(b"untouched destination\n")
    identity = _regular_file_identity(destination)
    writer = ExportWriterPath(destination, *identity)
    options = {"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": "utf-8", "header": True}
    options[field] = syntax
    with monkeypatch.context() as blocked:
        blocked.setattr(
            ExportWriterPath, "open_binary_writer", lambda *_: pytest.fail("unsafe CSV syntax opened the writer")
        )
        with pytest.raises(EngineError, match="Polars CSV export"):
            engine.export_data(frame, writer, options)
    assert evaluated == []
    assert source.equals(before)
    assert destination.read_bytes() == b"untouched destination\n"
    assert _regular_file_identity(destination) == identity

    options.update(delimiter=",", quoteChar='"')
    engine.export_data(frame, writer, options)
    assert destination.read_text(encoding="utf-8") == source.write_csv()
    assert source.equals(before)
    assert _regular_file_identity(destination) == identity


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize("header", [False, True])
@pytest.mark.parametrize("delimiter,quote", [("1", "-"), (".", "t"), ("T", "2"), (";", "'")])
def test_polars_csv_textlike_syntax_preserves_fields_nulls_and_empty_strings(
    tmp_path: Path, lazy: bool, header: bool, delimiter: str, quote: str
) -> None:
    source = pl.DataFrame(
        {
            "null": pl.Series([None, None, None], dtype=pl.Null),
            "text": ["é-1.tT2;\"'\n", "", None],
            "category": pl.Series(["a-1.tT2", "", None], dtype=pl.Categorical),
            "enum": pl.Series(["a-1.tT2", "", None], dtype=pl.Enum(["a-1.tT2", ""])),
        }
    )
    before = source.clone()
    engine = PolarsEngine()
    frame = engine.ensure_row_ids(source.lazy() if lazy else source, "hidden-csv-identity")
    destination = tmp_path / "escaped.csv"
    engine.export_data(
        frame,
        destination,
        {"format": "csv", "delimiter": delimiter, "quoteChar": quote, "encoding": "utf-8", "header": header},
    )
    content = destination.read_text(encoding="utf-8")
    decoded = list(csv.reader(io.StringIO(content), delimiter=delimiter, quotechar=quote, strict=True))
    expected = [["" if value is None else value for value in row] for row in source.rows()]
    assert decoded == ([source.columns] if header else []) + expected
    loaded = pl.read_csv(
        destination,
        separator=delimiter,
        quote_char=quote,
        has_header=header,
        new_columns=source.columns,
        schema_overrides={name: pl.String for name in source.columns},
    )
    assert loaded.to_dict(as_series=False) == source.to_dict(as_series=False)
    assert source.equals(before)


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize("header", [False, True])
@pytest.mark.parametrize("delimiter", [",", "\t", ";", "|"])
@pytest.mark.parametrize("quote", ['"', "'"])
def test_polars_csv_standard_syntax_retains_native_primitive_values(
    tmp_path: Path, lazy: bool, header: bool, delimiter: str, quote: str
) -> None:
    source = pl.DataFrame(
        {
            "signed": [1, -2, None],
            "unsigned": pl.Series([1, 2, None], dtype=pl.UInt64),
            "float": [1.25, float("nan"), None],
            "decimal": pl.Series([Decimal("1.25"), Decimal("-2.50"), None], dtype=pl.Decimal(9, 2)),
            "bool": [True, False, None],
            "date": [date(2026, 1, 1), date(2026, 1, 2), None],
            "time": [time(3, 4, 5, 123456), time(0), None],
            "datetime": [datetime(2026, 1, 1, 3, 4, 5), datetime(2026, 1, 2), None],
            "text": ["é,\";'\n", "", None],
        }
    )
    before = source.clone()
    destination = tmp_path / "standard.csv"
    PolarsEngine().export_data(
        source.lazy() if lazy else source,
        destination,
        {"format": "csv", "delimiter": delimiter, "quoteChar": quote, "encoding": "utf-8", "header": header},
    )
    loaded = pl.read_csv(
        destination,
        separator=delimiter,
        quote_char=quote,
        has_header=header,
        new_columns=source.columns,
        schema_overrides=source.schema,
    )
    assert loaded.equals(source)
    assert source.equals(before)


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize("field", ["delimiter", "quoteChar"])
def test_polars_csv_unsigned_values_allow_minus_syntax(tmp_path: Path, lazy: bool, field: str) -> None:
    source = pl.DataFrame({"value": pl.Series([1, 2, None], dtype=pl.UInt64)})
    options = {"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": "utf-8", "header": True}
    options[field] = "-"
    destination = tmp_path / "unsigned.csv"
    PolarsEngine().export_data(source.lazy() if lazy else source, destination, options)
    loaded = pl.read_csv(
        destination, separator=options["delimiter"], quote_char=options["quoteChar"], schema_overrides=source.schema
    )
    assert loaded.equals(source)


@pytest.mark.parametrize(
    ("backend", "options", "message"),
    [
        (
            "pandas",
            {
                "format": "csv",
                "delimiter": ",",
                "quoteChar": '"',
                "encoding": "not-a-real-codec",
                "header": True,
                "rowAxisPolicy": "omit",
            },
            "does not support CSV text encoding",
        ),
        (
            "pandas",
            {
                "format": "csv",
                "delimiter": ",",
                "quoteChar": '"',
                "encoding": "x" * 65,
                "header": True,
                "rowAxisPolicy": "omit",
            },
            "at most 64",
        ),
        (
            "pandas",
            {
                "format": "csv",
                "delimiter": ",",
                "quoteChar": '"',
                "encoding": "base64_codec",
                "header": True,
                "rowAxisPolicy": "omit",
            },
            "does not support CSV text encoding",
        ),
        (
            "pandas",
            {
                "format": "csv",
                "delimiter": ",",
                "quoteChar": ",",
                "encoding": "utf-8",
                "header": True,
                "rowAxisPolicy": "omit",
            },
            "delimiter and quoteChar must differ",
        ),
        (
            "pandas",
            {
                "format": "csv",
                "delimiter": "\n",
                "quoteChar": '"',
                "encoding": "utf-8",
                "header": True,
                "rowAxisPolicy": "omit",
            },
            "non-NUL, non-line-break",
        ),
        (
            "polars",
            {"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": "latin-1", "header": True},
            "supports UTF-8 encoding only",
        ),
        (
            "duckdb",
            {"format": "csv", "delimiter": "§", "quoteChar": '"', "encoding": "utf-8", "header": True},
            "delimiter must encode as exactly one UTF-8 byte",
        ),
        (
            "duckdb",
            {"format": "parquet", "delimiter": ","},
            "invalid for parquet",
        ),
    ],
)
def test_unsupported_export_options_fail_before_target_reservation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    backend: str,
    options: dict[str, object],
    message: str,
) -> None:
    source = tmp_path / f"source-{backend}.csv"
    source.write_text("city,value\nMilan,1\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "label": source.name, "path": str(source)}, backend=backend)
    destination = tmp_path / f"must-not-exist-{backend}.csv"
    monkeypatch.setattr(
        ExportTarget,
        "from_request",
        staticmethod(lambda *_args, **_kwargs: pytest.fail("unsupported options reached ExportTarget reservation")),
    )

    with pytest.raises(EngineError, match=message):
        manager.export_data(str(opened["metadata"]["sessionId"]), 0, str(destination), options)

    assert not destination.exists()
    manager.close_session(str(opened["metadata"]["sessionId"]), 0)


def test_duckdb_configured_csv_export_remains_native(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for method in ("arrow", "df", "fetch_arrow_table", "fetchdf", "pl", "to_arrow_table", "to_df"):
        if hasattr(duckdb.DuckDBPyRelation, method):
            monkeypatch.setattr(
                duckdb.DuckDBPyRelation,
                method,
                lambda *_args, method=method, **_kwargs: pytest.fail(
                    f"DuckDB configured export must not convert through {method}"
                ),
            )
    engine = DuckDBEngine()
    destination = tmp_path / "native.csv"
    engine.export_data(
        engine._relation_from_sql("SELECT 7 AS value"),
        destination,
        {"format": "csv", "delimiter": "|", "quoteChar": '"', "encoding": "utf-8", "header": True},
    )
    assert destination.read_text(encoding="utf-8") == "value\n7\n"


def test_pandas_extended_float_csv_and_explicit_floor_remain_native(tmp_path: Path) -> None:
    import numpy as np

    from openwrangler_runtime._column_binding import bind_step
    from openwrangler_runtime.lineage import source_lineage
    from openwrangler_runtime.operations import validate_step

    if np.finfo(np.longdouble).nmant <= 52:
        pytest.skip("Native longdouble aliases binary64")
    neighbor = np.nextafter(np.longdouble(1), np.longdouble(2))
    source = pd.DataFrame({"value": pd.Series([np.longdouble(1), neighbor], dtype=np.longdouble)})
    before = source.copy(deep=True)
    destination = tmp_path / "exact.csv"
    destination.touch()
    identity = _regular_file_identity(destination)
    engine = PandasEngine()
    with ExportTarget(destination, *identity).pinned_writer_path() as writer:
        engine.export_data(
            source,
            writer,
            {
                "format": "csv",
                "rowAxisPolicy": "omit",
                "delimiter": ",",
                "quoteChar": '"',
                "encoding": "utf-8",
                "header": True,
            },
        )
    assert destination.read_text().splitlines() == ["value", str(np.longdouble(1)), str(neighbor)]
    pa = pytest.importorskip("pyarrow")
    parquet = tmp_path / "unsupported.parquet"
    parquet.touch()
    parquet_identity = _regular_file_identity(parquet)
    with (
        ExportTarget(parquet, *parquet_identity).pinned_writer_path() as writer,
        pytest.raises(pa.ArrowNotImplementedError, match="Unsupported numpy type"),
    ):
        engine.export_data(source, writer, {"format": "parquet", "rowAxisPolicy": "omit"})
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    operation = bind_step(
        validate_step({"id": "floor", "kind": "floorNumber", "params": {"column": lineage[0]}}), schema, lineage
    )
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    for result in (engine.apply_transform(source, operation), namespace["clean_data"](source)):
        assert [row["values"][0]["raw"] for row in engine.page(result, 0, 10)["rows"]] == [1.0, 1.0]
    pd.testing.assert_frame_equal(source, before)
