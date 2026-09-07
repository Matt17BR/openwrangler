from __future__ import annotations

import sys
from contextlib import nullcontext
from datetime import date, datetime, timedelta, timezone
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
from openwrangler_runtime.export_target import ExportTarget, ExportTargetError, _regular_file_identity
from openwrangler_runtime.session import SessionManager


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
