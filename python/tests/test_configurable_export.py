from __future__ import annotations

import sys
from contextlib import nullcontext
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime.engines import EngineError
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine
from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.engines.polars_engine import PolarsEngine
from openwrangler_runtime.export_target import ExportTarget, ExportTargetError
from openwrangler_runtime.session import SessionManager


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
        identity = destination.stat()
        with ExportTarget(destination, identity.st_dev, identity.st_ino).pinned_writer_path() as writer:
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
        identity = destination.stat()
        with ExportTarget(destination, identity.st_dev, identity.st_ino).pinned_writer_path() as writer:
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
    details = destination.stat()
    target = ExportTarget(destination, details.st_dev, details.st_ino)

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
    details = destination.stat()
    options = (
        {"format": "parquet"}
        if format_name == "parquet"
        else {"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": "utf-8", "header": True}
    )
    if backend == "pandas":
        options["rowAxisPolicy"] = "omit"
    with ExportTarget(destination, details.st_dev, details.st_ino).pinned_writer_path() as writer:
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
    details = destination.stat()
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
        ExportTarget(destination, details.st_dev, details.st_ino).pinned_writer_path() as writer,
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
