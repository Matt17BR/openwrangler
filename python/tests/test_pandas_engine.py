from __future__ import annotations

from datetime import timedelta
from decimal import MAX_EMAX, Decimal, localcontext
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pandas as pd
import pytest

import openwrangler_runtime.engines.pandas_engine as pandas_engine_module
from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines import AmbiguousViewColumnError, PandasEngine
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import validate_step
from openwrangler_runtime.session import SessionManager

ROOT = Path(__file__).resolve().parents[2]


def test_pandas_file_session_matches_protocol():
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": "sample.tsv", "path": str(ROOT / "fixtures" / "sample.tsv")},
        backend="pandas",
        page_size=10,
    )

    assert opened["metadata"]["backend"] == "pandas"
    assert opened["metadata"]["shape"] == {"rows": 4, "columns": 4}
    assert opened["metadata"]["schema"][0]["name"] == "city"
    assert "stats" not in opened["metadata"]
    assert opened["summaries"] == []

    summaries = manager.get_summary(
        opened["metadata"]["sessionId"],
        0,
        {"filters": [], "sort": []},
        ["c:source:0"],
    )["summaries"]
    assert summaries[0]["visualization"]["kind"] == "categorical"

    stats = manager.get_dataset_stats(opened["metadata"]["sessionId"], 0, {"filters": [], "sort": []})
    assert stats["stats"]["duplicateRows"] == 0

    filter_model = {
        "filters": [
            {
                "column": "year",
                "type": "integer",
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": ["2024"],
                    "includeNulls": False,
                    "includeNaN": False,
                },
                "predicates": [],
            }
        ],
        "sort": [{"column": "sales", "direction": "asc", "nulls": "last"}],
    }
    page = manager.get_page(opened["metadata"]["sessionId"], 0, 0, 10, filter_model)

    assert page["metadata"]["filteredShape"]["rows"] == 2
    assert [row["values"][0]["display"] for row in page["page"]["rows"]] == ["Rome", "Milan"]


def test_pandas_excel_file_session(tmp_path):
    path = tmp_path / "sample.xlsx"
    pd.DataFrame({"name": ["alpha", "beta"], "value": [1, 2]}).to_excel(path, index=False)

    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "label": "sample.xlsx", "path": str(path)}, backend="pandas")

    assert opened["metadata"]["shape"] == {"rows": 2, "columns": 2}


def test_pandas_excel_reader_matches_the_format_dependency(monkeypatch):
    calls: list[tuple[str, str | int, str]] = []

    def read_excel(path: str, *, sheet_name: str | int, engine: str) -> pd.DataFrame:
        calls.append((path, sheet_name, engine))
        return pd.DataFrame({"value": [1]})

    monkeypatch.setattr(pd, "read_excel", read_excel)
    runtime = PandasEngine()

    runtime.read_file("default.xlsx")
    runtime.read_file("modern.xlsx", {"sheetIndex": 1})
    runtime.read_file("legacy.xls", {"sheetName": " résumé "})

    assert calls == [
        ("default.xlsx", 0, "openpyxl"),
        ("modern.xlsx", 1, "openpyxl"),
        ("legacy.xls", " résumé ", "xlrd"),
    ]


def test_pandas_csv_import_options(tmp_path):
    path = tmp_path / "latin1.csv"
    path.write_bytes("city;value\nM\xfcnchen;7\n".encode("latin-1"))

    manager = SessionManager()
    opened = manager.open_session(
        {
            "kind": "file",
            "label": "latin1.csv",
            "path": str(path),
            "importOptions": {"delimiter": ";", "encoding": "latin-1", "hasHeader": True, "quoteChar": '"'},
        },
        backend="pandas",
    )

    assert opened["metadata"]["schema"][0]["name"] == "city"
    assert opened["page"]["rows"][0]["values"][0]["display"] == "München"


def test_pandas_reads_multibyte_delimiter_and_quote_controls(tmp_path):
    manager = SessionManager()
    cases = [
        (
            "unicode-delimiter.csv",
            'city§note\nMilan§"one§two"\n',
            {"delimiter": "§"},
            ["Milan", "one§two"],
        ),
        ("unicode-quote.csv", "city,note\nMilan,“one,two“\n", {"quoteChar": "“"}, ["Milan", "one,two"]),
    ]
    for file_name, contents, controls, expected in cases:
        path = tmp_path / file_name
        path.write_text(contents, encoding="utf-8")
        opened = manager.open_session(
            {
                "kind": "file",
                "label": path.name,
                "path": str(path),
                "importOptions": {
                    **controls,
                    "encoding": "utf-8",
                    "hasHeader": True,
                },
            },
            backend="pandas",
        )

        assert [cell["display"] for cell in opened["page"]["rows"][0]["values"]] == expected
        manager.close_session(opened["metadata"]["sessionId"], 0)
    assert manager.sessions == {}


def test_pandas_utf8_lossy_is_a_replacement_policy_not_a_codec(tmp_path):
    path = tmp_path / "damaged.csv"
    path.write_bytes(b"name,value\nsafe,1\nbroken-\xff,2\n")

    manager = SessionManager()
    opened = manager.open_session(
        {
            "kind": "file",
            "label": path.name,
            "path": str(path),
            "importOptions": {"encoding": "utf8-lossy", "hasHeader": True},
        },
        backend="pandas",
    )

    assert [row["values"][0]["display"] for row in opened["page"]["rows"]] == ["safe", "broken-�"]


def test_pandas_viewing_supports_duplicate_and_non_string_column_labels():
    engine = PandasEngine()
    labels = pd.Index(["duplicate", "duplicate", 7], dtype="object")
    frame = pd.DataFrame([[1, None, 3], [1, 2, 4]], columns=labels)
    frame = engine.ensure_row_ids(frame, "labels")

    schema = engine.schema(frame)
    assert [column["name"] for column in schema] == ["duplicate", "duplicate", "7"]
    assert [column["id"] for column in schema] == ["c:0", "c:1", "c:2"]
    summaries = engine.summaries(frame)
    assert [summary["columnId"] for summary in summaries] == ["c:0", "c:1", "c:2"]
    assert [summary["column"] for summary in summaries] == ["duplicate", "duplicate", "7"]
    assert engine.summaries(frame, [(1, "stable-second-duplicate")])[0] == summaries[1] | {
        "columnId": "stable-second-duplicate"
    }
    assert [cell["display"] for cell in engine.page(frame, 0, 1)["rows"][0]["values"]] == ["1", "NaN", "3"]
    stats = engine.header_stats(frame)
    assert stats["missingCells"] == 1
    assert stats["missingValuesByColumn"] == [
        {"column": "duplicate", "count": 0},
        {"column": "duplicate", "count": 1},
        {"column": "7", "count": 0},
    ]


def test_pandas_numeric_summaries_publish_lossless_wide_integer_and_decimal_extrema() -> None:
    wide_values = [
        -(10**30) + 2,
        10**30 + 3,
        10**30 + 1,
    ]
    decimal_values = [
        Decimal("-12345678901234567890.123456789012345678"),
        Decimal("98765432109876543210.987654321098765432"),
    ]
    frame = pd.DataFrame(
        {
            "wide": pd.Series(wide_values, dtype=object),
            "amount": pd.Series([*decimal_values, None], dtype=object),
        }
    )

    summaries = PandasEngine().summaries(frame)

    assert summaries[0]["numeric"]["exactMin"] == {
        "kind": "integer",
        "raw": str(min(wide_values)),
        "display": str(min(wide_values)),
        "isNull": False,
        "isNaN": False,
    }
    assert summaries[0]["numeric"]["exactMax"] == {
        "kind": "integer",
        "raw": str(max(wide_values)),
        "display": str(max(wide_values)),
        "isNull": False,
        "isNaN": False,
    }
    assert summaries[1]["numeric"]["exactMin"] == {
        "kind": "decimal",
        "raw": str(min(decimal_values)),
        "display": str(min(decimal_values)),
        "isNull": False,
        "isNaN": False,
    }
    assert summaries[1]["numeric"]["exactMax"] == {
        "kind": "decimal",
        "raw": str(max(decimal_values)),
        "display": str(max(decimal_values)),
        "isNull": False,
        "isNaN": False,
    }
    assert isinstance(summaries[0]["numeric"]["min"], float)
    assert isinstance(summaries[1]["numeric"]["max"], float)


def test_pandas_decimal_summaries_keep_native_aggregate_precision_before_approximation() -> None:
    values = [Decimal("1e30"), Decimal("1"), Decimal("-1e30")]

    numeric = PandasEngine().summaries(pd.DataFrame({"value": pd.Series(values, dtype=object)}))[0]["numeric"]

    assert numeric["mean"] == pytest.approx(1 / 3)
    assert numeric["median"] == 1.0
    assert numeric["std"] == pytest.approx(1e30)
    assert numeric["exactMin"]["raw"] == "-1E+30"
    assert numeric["exactMax"]["raw"] == "1E+30"


def test_pandas_decimal_summaries_omit_non_finite_exact_pairs_and_survive_decimal_overflow() -> None:
    frame = pd.DataFrame(
        {
            "positive": pd.Series([Decimal("1"), Decimal("Infinity")], dtype=object),
            "negative": pd.Series([Decimal("-Infinity"), Decimal("1")], dtype=object),
            "mixed": pd.Series([Decimal("-Infinity"), Decimal("1"), Decimal("Infinity")], dtype=object),
            "float_overflow": pd.Series([Decimal("-1e309"), Decimal("1e309")], dtype=object),
            "decimal_overflow": pd.Series(
                [Decimal(f"9e{MAX_EMAX}"), Decimal(f"9e{MAX_EMAX}")],
                dtype=object,
            ),
        }
    )

    summaries = {summary["column"]: summary for summary in PandasEngine().summaries(frame)}

    assert summaries["positive"]["numeric"] == {"min": 1.0}
    assert summaries["negative"]["numeric"] == {"max": 1.0}
    assert summaries["mixed"]["numeric"] == {"median": 1.0}
    for column in ("positive", "negative", "mixed"):
        assert "exactMin" not in summaries[column]["numeric"]
        assert "exactMax" not in summaries[column]["numeric"]
    assert summaries["positive"]["visualization"] == {
        "kind": "numeric",
        "bins": [{"min": 1.0, "max": 1.0, "count": 1}],
    }
    assert summaries["mixed"]["visualization"] == {
        "kind": "numeric",
        "bins": [{"min": 1.0, "max": 1.0, "count": 1}],
    }

    assert summaries["float_overflow"]["numeric"]["mean"] == 0.0
    assert summaries["float_overflow"]["numeric"]["median"] == 0.0
    assert summaries["float_overflow"]["numeric"]["exactMin"]["raw"] == "-1E+309"
    assert summaries["float_overflow"]["numeric"]["exactMax"]["raw"] == "1E+309"
    decimal_overflow = summaries["decimal_overflow"]["numeric"]
    assert set(decimal_overflow) == {"exactMin", "exactMax"}
    assert decimal_overflow["exactMin"]["raw"] == f"9E+{MAX_EMAX}"
    assert decimal_overflow["exactMax"]["raw"] == f"9E+{MAX_EMAX}"


@pytest.mark.parametrize(
    ("labels", "display_name"),
    [
        (["duplicate", "duplicate"], "duplicate"),
        ([7, "7"], "7"),
    ],
)
def test_pandas_name_addressed_view_queries_fail_closed_for_ambiguous_display_names(
    labels: list[object], display_name: str
) -> None:
    engine = PandasEngine()
    frame = engine.ensure_row_ids(
        pd.DataFrame([[1, 100], [2, 200]], columns=pd.Index(labels, dtype="object")),
        "ambiguous",
    )
    message = rf"Pandas view .* column {display_name!r} is ambiguous because 2 dataframe columns share"

    with pytest.raises(AmbiguousViewColumnError, match=message):
        engine.apply_filter_model(
            frame,
            {
                "filters": [
                    {
                        "column": display_name,
                        "type": "integer",
                        "predicates": [{"kind": "predicate", "operator": "gt", "value": 50}],
                    }
                ],
                "sort": [],
            },
        )

    with pytest.raises(AmbiguousViewColumnError, match=message):
        engine.apply_filter_model(
            frame,
            {
                "filters": [],
                "sort": [{"column": display_name, "direction": "asc", "nulls": "last"}],
            },
        )

    with pytest.raises(AmbiguousViewColumnError, match=message):
        engine.column_values(frame, display_name)


def test_pandas_page_projection_addresses_duplicate_columns_by_position() -> None:
    engine = PandasEngine()
    frame = pd.DataFrame([[1, 2, 3]], columns=pd.Index(["duplicate", "duplicate", 7], dtype="object"))
    frame = engine.ensure_row_ids(frame, "projected-duplicates")

    page = engine.page(
        frame,
        0,
        1,
        total_rows=1,
        column_projection=[(1, "stable:second-duplicate"), (2, "stable:integer-label")],
    )

    assert page["columnIds"] == ["stable:second-duplicate", "stable:integer-label"]
    assert [cell["display"] for cell in page["rows"][0]["values"]] == ["2", "3"]


def test_pandas_summaries_separate_nan_from_other_missing_values():
    frame = pd.DataFrame(
        {
            "float": pd.Series([1.0, float("nan")], dtype="float64"),
            "object": pd.Series([None, float("nan")], dtype="object"),
            "nullable": pd.Series([1.0, pd.NA], dtype="Float64"),
            "datetime": pd.Series([pd.Timestamp("2026-01-01"), pd.NaT]),
        }
    )

    summaries = {summary["column"]: summary for summary in PandasEngine().summaries(frame)}

    assert (summaries["float"]["nullCount"], summaries["float"]["nanCount"]) == (0, 1)
    assert (summaries["object"]["nullCount"], summaries["object"]["nanCount"]) == (1, 1)
    assert (summaries["nullable"]["nullCount"], summaries["nullable"]["nanCount"]) == (1, 0)
    assert (summaries["datetime"]["nullCount"], summaries["datetime"]["nanCount"]) == (1, 0)


def test_pandas_text_summaries_are_exact_for_unicode_empty_all_null_and_mixed_display_values():
    frame = pd.DataFrame(
        {
            "text": pd.Series([None, "", "A", "é", "e\u0301", "😀"], dtype="string"),
            "all_null": pd.Series([None, None, None, None, None, None], dtype="string"),
            "mixed_display": pd.Series([b"\x00", "x", None, None, None, None], dtype="object"),
            "numeric_category": pd.Series(pd.Categorical([1, 200, None, None, None, None])),
            "bytes_category": pd.Series(pd.Categorical([b"\xff", b"\x00", None, None, None, None])),
        }
    )

    summaries = {summary["column"]: summary for summary in PandasEngine().summaries(frame)}

    assert summaries["text"]["text"] == {
        "emptyCount": 1,
        "minLength": 0,
        "maxLength": 2,
        "meanLength": 1.0,
    }
    assert summaries["all_null"]["text"] == {"emptyCount": 0}
    assert summaries["mixed_display"]["type"] == "string"
    assert summaries["mixed_display"]["text"] == {
        "emptyCount": 0,
        "minLength": 1,
        "maxLength": 4,
        "meanLength": 2.5,
    }
    assert summaries["numeric_category"]["type"] == "string"
    assert summaries["numeric_category"]["text"] == {
        "emptyCount": 0,
        "minLength": 1,
        "maxLength": 3,
        "meanLength": 2.0,
    }
    assert summaries["bytes_category"]["type"] == "string"
    assert summaries["bytes_category"]["text"] == {
        "emptyCount": 0,
        "minLength": 4,
        "maxLength": 4,
        "meanLength": 4.0,
    }


def test_pandas_summary_omits_non_finite_statistics_but_keeps_finite_histogram_values():
    summary = PandasEngine().summaries(pd.DataFrame({"value": [1.0, float("inf")]}))[0]

    assert summary["numeric"] == {"min": 1.0}
    assert summary["visualization"] == {"kind": "numeric", "bins": [{"min": 1.0, "max": 1.0, "count": 1}]}


def test_pandas_numeric_histogram_is_exact_for_a_large_filtered_view():
    engine = PandasEngine()
    source = pd.DataFrame({"value": [-1.0] * 500 + [float(value) for value in range(5_000)] + [1_000_000.0]})
    frame = engine.apply_filter_model(
        source,
        {
            "logic": "and",
            "filters": [
                {
                    "column": "value",
                    "type": "float",
                    "logic": "and",
                    "predicates": [{"operator": "gte", "value": 500}],
                }
            ],
            "sort": [],
        },
    )

    summary = engine.summaries(frame)[0]
    bins = summary["visualization"]["bins"]

    assert summary["numeric"]["min"] == 500.0
    assert summary["numeric"]["max"] == 1_000_000.0
    assert "sampled" not in summary["visualization"]
    assert len(bins) == 20
    assert bins[0]["min"] == summary["numeric"]["min"]
    assert bins[-1]["max"] == summary["numeric"]["max"]
    assert bins[-1]["count"] == 1
    assert sum(bin_["count"] for bin_ in bins) == 4_501
    assert all(left["max"] == right["min"] for left, right in zip(bins, bins[1:], strict=False))
    assert [bin_["max"] - bin_["min"] for bin_ in bins] == pytest.approx([bins[0]["max"] - bins[0]["min"]] * len(bins))


def test_pandas_custom_code_cannot_mutate_nested_source_objects():
    source = pd.DataFrame({"nested": [[1], [2]], "value": [1, 2]})
    engine = PandasEngine()
    frame = engine.ensure_row_ids(source, "nested-source")
    step = {
        "id": "custom",
        "kind": "customCode",
        "params": {"code": "df.iloc[0, 0].append(99)\nresult = df"},
    }

    transformed = engine.apply_transform(frame, step)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([step]), namespace, namespace)
    generated = namespace["clean_data"](frame)

    assert source["nested"].tolist() == [[1], [2]]
    assert frame["nested"].tolist() == [[1], [2]]
    assert transformed["nested"].tolist() == [[1, 99], [2]]
    assert generated["nested"].tolist() == [[1, 99], [2]]


def test_pandas_object_schema_inference_is_fast_and_exhaustive() -> None:
    values: list[Any] = [1] * 1_000
    values[1] = "mixed"
    mixed = pd.Series(values, dtype=object)
    assert PandasEngine().schema(mixed.to_frame(name="mixed"))[0]["type"] == "string"
    assert pandas_engine_module._pandas_semantic_type(mixed) == "string"
    prepared, sentinel, integer_key = pandas_engine_module._pandas_prepare_group_key(mixed)
    assert prepared is mixed
    assert sentinel is None
    assert integer_key is False

    sparse_wide = pd.Series([None, 10**40, *([None] * 998)], dtype=object)
    assert PandasEngine().schema(sparse_wide.to_frame(name="wide"))[0]["type"] == "integer"
    assert pandas_engine_module._pandas_semantic_type(sparse_wide) == "integer"

    nat_cases = [
        ([10**40, pd.NaT], "integer"),
        ([True, pd.NaT], "boolean"),
        ([1.5, pd.NaT], "float"),
        ([Decimal("1.25"), pd.NaT], "decimal"),
        ([pd.Timestamp("2026-07-16").to_pydatetime(), pd.NA], "datetime"),
        ([timedelta(days=1), pd.NA], "duration"),
        ([b"value", pd.NaT], "binary"),
    ]
    for values, expected in nat_cases:
        frame = pd.Series(values, dtype=object).to_frame(name="value")
        assert PandasEngine().schema(frame)[0]["type"] == expected


def test_pandas_standard_object_schema_types_do_not_use_the_python_materialization_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def reject_python_scan(_series: Any) -> list[Any]:
        raise AssertionError("standard object inference must stay on Pandas' native classifier")

    monkeypatch.setattr(pandas_engine_module, "_pandas_present_values", reject_python_scan)
    frame = pd.DataFrame(
        {
            "text": pd.Series(["x"] * 10_000, dtype=object),
            "wide": pd.Series([10**40] * 10_000, dtype=object),
        }
    )
    assert [column["type"] for column in PandasEngine().schema(frame)] == ["string", "integer"]


def _bound_pandas_group(frame: pd.DataFrame, operations: tuple[str, ...]) -> tuple[PandasEngine, dict[str, Any]]:
    engine = PandasEngine()
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    public = validate_step(
        {
            "id": "pandas-group-regression",
            "kind": "groupBy",
            "params": {
                "keys": [lineage[0]],
                "aggregations": [
                    {"column": lineage[1], "operation": operation, "alias": operation} for operation in operations
                ],
            },
        }
    )
    return engine, bind_step(public, schema, lineage)


def _execute_pandas_generated(engine: PandasEngine, frame: pd.DataFrame, operation: dict[str, Any]) -> pd.DataFrame:
    namespace: dict[str, Any] = {}
    exec(compile(engine.compile_plan([operation]), "<pandas-group-regression>", "exec"), namespace, namespace)
    return namespace["clean_data"](frame)


def test_pandas_group_keys_and_extrema_preserve_integers_beyond_the_arithmetic_envelope() -> None:
    huge = 10**40
    frame = pd.DataFrame(
        {
            "group": pd.Series([huge, huge, None, None], dtype=object),
            "value": pd.Series([huge + 1, huge + 2, None, None], dtype=object),
        }
    )
    engine, operation = _bound_pandas_group(frame, ("min", "max", "first", "last"))

    for result in (
        engine.apply_transform(frame, operation),
        _execute_pandas_generated(engine, frame, operation),
    ):
        assert result.iloc[0].tolist() == [huge, huge + 1, huge + 2, huge + 1, huge + 2]
        assert result.iloc[1, 0] is pd.NA
        assert all(result.iloc[1, position] is pd.NA for position in range(1, 5))
        schema = engine.schema(result)
        assert [column["type"] for column in schema] == ["integer"] * 5
        page = engine.page(
            result,
            0,
            10,
            column_projection=[(column["position"], column["id"]) for column in schema],
        )
        assert [cell["kind"] for cell in page["rows"][0]["values"]] == ["integer"] * 5
        assert [cell["kind"] for cell in page["rows"][1]["values"]] == ["null"] * 5

    sum_frame = pd.DataFrame({"group": ["a"], "value": pd.Series([10**38], dtype=object)})
    sum_engine, sum_operation = _bound_pandas_group(sum_frame, ("sum",))
    with pytest.raises(Exception, match="portable 38-digit envelope"):
        sum_engine.apply_transform(sum_frame, sum_operation)
    with pytest.raises(Exception, match="portable 38-digit envelope"):
        _execute_pandas_generated(sum_engine, sum_frame, sum_operation)


def test_pandas_decimal_group_sum_normalizes_zero_and_typed_schema_live_and_generated() -> None:
    frame = pd.DataFrame(
        {
            "group": ["a", "a", "b", "b"],
            "value": pd.Series([Decimal("1.10"), Decimal("2.20"), None, None], dtype=object),
        }
    )
    engine, operation = _bound_pandas_group(frame, ("sum",))

    live = engine.apply_transform(frame, operation)
    generated = _execute_pandas_generated(engine, frame, operation)
    for result in (live, generated):
        assert result["sum"].tolist() == [Decimal("3.30"), Decimal("0.00")]
        schema = engine.schema(result)
        assert schema[1] == {
            "id": "c:1",
            "name": "sum",
            "position": 1,
            "rawType": "object",
            "type": "decimal",
            "nullable": False,
        }
        page = engine.page(result, 0, 10, column_projection=[(1, schema[1]["id"])])
        assert [row["values"][0]["kind"] for row in page["rows"]] == ["decimal", "decimal"]
        assert [row["values"][0]["raw"] for row in page["rows"]] == ["3.30", "0.00"]

    assert engine.schema(live) == engine.schema(generated)


def test_pandas_decimal_group_sum_is_context_independent_and_skips_decimal_nan() -> None:
    frame = pd.DataFrame(
        {
            "group": ["a", "a", "b", "b"],
            "value": pd.Series(
                [
                    Decimal("9999999999999999999999999999.9"),
                    Decimal("0.2"),
                    Decimal("NaN"),
                    None,
                ],
                dtype=object,
            ),
        }
    )
    engine, operation = _bound_pandas_group(frame, ("sum",))

    with localcontext() as context:
        context.prec = 2
        context.Emax = 5
        context.Emin = -5
        for result in (engine.apply_transform(frame, operation), _execute_pandas_generated(engine, frame, operation)):
            assert result["sum"].tolist() == [
                Decimal("10000000000000000000000000000.1"),
                Decimal("0.0"),
            ]


@pytest.mark.parametrize(
    ("values", "expected"),
    [
        ([np.int64(2**63 - 1), np.int64(1)], 2**63),
        ([np.uint64(2**64 - 1), np.uint64(1)], 2**64),
    ],
)
def test_pandas_object_numpy_integer_group_sum_boxes_to_exact_python_ints(values: list[Any], expected: int) -> None:
    frame = pd.DataFrame({"group": ["a", "a"], "value": pd.Series(values, dtype=object)})
    engine, operation = _bound_pandas_group(frame, ("sum",))

    for result in (engine.apply_transform(frame, operation), _execute_pandas_generated(engine, frame, operation)):
        assert result["sum"].tolist() == [expected]


def test_pandas_integer_group_sum_treats_decimal_nan_as_missing_live_and_generated() -> None:
    valid = pd.DataFrame({"group": ["a", "a"], "value": pd.Series([1, Decimal("NaN")], dtype=object)})
    engine, operation = _bound_pandas_group(valid, ("sum",))
    for result in (engine.apply_transform(valid, operation), _execute_pandas_generated(engine, valid, operation)):
        assert result["sum"].tolist() == [1]
        assert str(result["sum"].dtype) == "Int64"

    overflow = pd.DataFrame({"group": ["a", "a"], "value": pd.Series([10**38, Decimal("NaN")], dtype=object)})
    overflow_engine, overflow_operation = _bound_pandas_group(overflow, ("sum",))
    with pytest.raises(Exception, match="portable 38-digit envelope"):
        overflow_engine.apply_transform(overflow, overflow_operation)
    with pytest.raises(Exception, match="portable 38-digit envelope"):
        _execute_pandas_generated(overflow_engine, overflow, overflow_operation)


@pytest.mark.parametrize(
    ("unit", "expected"),
    [
        ("D", [172_800.0, 86_400.0, 172_800.0, 172_800.0, 86_400.0]),
        ("ns", [2e-9, 1e-9, 2e-9, 2e-9, 1e-9]),
    ],
)
def test_pandas_numpy_duration_group_keys_and_extrema_remain_durations_live_and_generated(
    unit: Literal["D", "ns"],
    expected: list[float],
) -> None:
    frame = pd.DataFrame(
        {
            "group": pd.Series([np.timedelta64(2, unit), np.timedelta64(2, unit)], dtype=object),
            "value": pd.Series([np.timedelta64(2, unit), np.timedelta64(1, unit)], dtype=object),
        }
    )
    engine, operation = _bound_pandas_group(frame, ("min", "max", "first", "last"))

    for result in (engine.apply_transform(frame, operation), _execute_pandas_generated(engine, frame, operation)):
        schema = engine.schema(result)
        assert [column["type"] for column in schema] == ["duration"] * 5
        page = engine.page(
            result,
            0,
            10,
            column_projection=[(column["position"], column["id"]) for column in schema],
        )
        cells = page["rows"][0]["values"]
        assert [cell["kind"] for cell in cells] == ["duration"] * 5
        assert [cell["raw"] for cell in cells] == pytest.approx(expected)


@pytest.mark.parametrize("source_value", [np.int64(2**63 - 1), np.uint64(2**64 - 1)])
def test_pandas_object_numpy_integer_by_example_boxes_before_checked_arithmetic(source_value: Any) -> None:
    frame = pd.DataFrame({"value": pd.Series([source_value], dtype=object)})
    engine = PandasEngine()
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    operation = bind_step(
        validate_step(
            {
                "id": "numpy-integer-by-example",
                "kind": "byExample",
                "params": {
                    "sourceColumns": lineage,
                    "newColumn": "result",
                    "examples": [
                        {"inputs": [1], "output": 2},
                        {"inputs": [2], "output": 3},
                    ],
                },
            }
        ),
        schema,
        lineage,
    )

    for result in (engine.apply_transform(frame, operation), _execute_pandas_generated(engine, frame, operation)):
        assert result["result"].tolist() == [int(source_value) + 1]
