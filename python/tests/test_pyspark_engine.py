from __future__ import annotations

import json
import re
from collections.abc import Iterator
from datetime import datetime
from decimal import Decimal
from importlib import import_module
from pathlib import Path
from time import monotonic, sleep
from typing import Any

import pytest

import __main__
import openwrangler_runtime.engines.pyspark_engine as pyspark_engine_module
from openwrangler_runtime.engines import EngineError, PySparkEngine
from openwrangler_runtime.engines.base import INTERNAL_ROW_ID_PREFIX
from openwrangler_runtime.session import SessionManager

_PYSPARK_VERSION_CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "fixtures" / "pyspark-version-contract.json").read_text(encoding="utf-8")
)


def test_strict_pyspark_version_contract() -> None:
    assert all(
        pyspark_engine_module._is_supported_pyspark_version(version)
        for version in _PYSPARK_VERSION_CONTRACT["accepted"]
    )
    assert not any(
        pyspark_engine_module._is_supported_pyspark_version(version)
        for version in _PYSPARK_VERSION_CONTRACT["rejected"]
    )


@pytest.fixture(scope="module", params=("classic", "connect"))
def spark_session(request: pytest.FixtureRequest) -> Iterator[Any]:
    pyspark = pytest.importorskip("pyspark")
    assert pyspark.__version__.startswith("4.2.")
    SparkSession = import_module("pyspark.sql").SparkSession

    if request.param == "classic":
        spark = (
            SparkSession.builder.master("local[2]")
            .appName("open-wrangler-pyspark-tests")
            .config("spark.ui.enabled", "false")
            .config("spark.sql.shuffle.partitions", "2")
            .getOrCreate()
        )
        spark.sparkContext.setLogLevel("ERROR")
    else:
        spark = SparkSession.builder.remote("local[2]").getOrCreate()
        spark.conf.set("spark.sql.shuffle.partitions", "2")
    try:
        yield spark
    finally:
        spark.stop()


@pytest.fixture
def sample_frame(spark_session: Any) -> Any:
    return spark_session.createDataFrame(
        [
            ("Beta", 2.0, "x", True, datetime(2026, 1, 1, 12, 0)),
            ("alpha", None, "y", False, datetime(2026, 1, 2, 12, 0)),
            ("ALPHA", float("nan"), "y", None, None),
            ("ÄLPHA", -1.0, "x", True, datetime(2026, 1, 3, 12, 0)),
            ("Beta", 2.0, "x", True, datetime(2026, 1, 1, 12, 0)),
        ],
        "name string, amount double, group_name string, flag boolean, happened timestamp",
    ).repartition(2)


def _open_engine(frame: Any, token: str = "test") -> tuple[PySparkEngine, Any]:
    engine = PySparkEngine()
    assert engine.detect(frame)
    engine.validate_internal_row_id_namespace(frame)
    engine.validate_column_addressability(frame)
    return engine, engine.ensure_row_ids(frame, token)


def _empty_view() -> dict[str, Any]:
    return {"logic": "and", "filters": [], "sort": []}


def test_capabilities_are_explicitly_read_only_and_not_file_backed() -> None:
    capabilities = PySparkEngine.capabilities
    assert capabilities.source_kinds == frozenset({"notebookVariable"})
    assert not capabilities.supports_editing
    assert capabilities.lazy_file_extensions == frozenset()
    assert capabilities.export_formats == frozenset()
    assert not capabilities.supports_shutdown_interrupt
    assert not capabilities.supports_request_cancellation

    engine = PySparkEngine()
    with pytest.raises(EngineError, match="live notebook variables only"):
        engine.read_file("sample.parquet")
    with pytest.raises(EngineError, match="read-only"):
        engine.apply_transform(object(), {})
    with pytest.raises(EngineError, match="does not generate"):
        engine.compile_plan(())
    with pytest.raises(EngineError, match="does not export"):
        engine.export_data(object(), "cleaned.parquet", "parquet")


def test_detects_classic_and_connect_dataframes(spark_session: Any) -> None:
    frame = spark_session.range(3)
    assert PySparkEngine().detect(frame)
    assert not PySparkEngine().detect(object())
    assert type(frame).__module__ in {
        "pyspark.sql.classic.dataframe",
        "pyspark.sql.connect.dataframe",
    }


@pytest.mark.parametrize(
    "raw_type",
    [
        "variant",
        "time(6)",
        "geometry(4326)",
        "geography(any)",
        "interval",
        "interval year",
        "interval month",
        "interval year to month",
    ],
)
def test_classifies_exact_non_profileable_spark_types(raw_type: str) -> None:
    assert pyspark_engine_module._is_unsupported_profile_type(raw_type)


@pytest.mark.parametrize("raw_type", ["void", "custom_type", "interval day to second"])
def test_does_not_blanket_reject_unknown_or_supported_interval_types(raw_type: str) -> None:
    assert not pyspark_engine_module._is_unsupported_profile_type(raw_type)


def test_rejects_streaming_duplicate_casefold_and_private_schemas(spark_session: Any) -> None:
    engine = PySparkEngine()
    duplicate = spark_session.createDataFrame([(1, 2)], ["value", "value"])
    with pytest.raises(EngineError, match="unique without relying on case"):
        engine.validate_column_addressability(duplicate)

    casefold = spark_session.createDataFrame([(1, 2)], ["Value", "value"])
    with pytest.raises(EngineError, match="unique without relying on case"):
        engine.validate_column_addressability(casefold)

    private = spark_session.createDataFrame([(1,)], [f"{INTERNAL_ROW_ID_PREFIX.upper()}user"])
    with pytest.raises(EngineError, match="reserved"):
        engine.validate_internal_row_id_namespace(private)

    streaming = spark_session.readStream.format("rate").load()
    with pytest.raises(EngineError, match="Streaming"):
        engine.validate_column_addressability(streaming)


def test_rejects_variant_before_open_without_blanket_rejecting_unknown_types(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    variant = spark_session.sql("""SELECT parse_json('{"region":"eu"}') AS payload""")
    monkeypatch.setattr(__main__, "open_wrangler_variant_frame", variant, raising=False)
    manager = SessionManager()

    with pytest.raises(
        EngineError,
        match=r"required viewing profiles.*'payload' \(variant\).*Convert these columns in Spark",
    ):
        manager.open_session(
            {
                "kind": "notebookVariable",
                "variableName": "open_wrangler_variant_frame",
                "label": "open_wrangler_variant_frame",
            },
            backend="pyspark",
        )
    assert manager.sessions == {}

    # Spark's void type is also semantically unknown to the shared type
    # classifier, but it supports the required native grouping operations.
    # Exact unsupported Spark types must fail closed without rejecting every
    # column that happens to map to the public "unknown" semantic type.
    supported_unknown = spark_session.sql("SELECT CAST(NULL AS VOID) AS payload")
    engine = PySparkEngine()
    engine.validate_column_addressability(supported_unknown)
    assert engine.schema(supported_unknown) == [
        {
            "id": "c:0",
            "name": "payload",
            "position": 0,
            "rawType": "void",
            "type": "unknown",
            "nullable": True,
        }
    ]


@pytest.mark.parametrize(
    ("expression", "raw_type"),
    [
        (
            """named_struct('x', parse_json('{"region":"eu"}'))""",
            "struct<x:variant>",
        ),
        (
            """array(parse_json('{"region":"eu"}'))""",
            "array<variant>",
        ),
        (
            """map('x', parse_json('{"region":"eu"}'))""",
            "map<string,variant>",
        ),
        (
            """named_struct('x', INTERVAL '1-2' YEAR TO MONTH)""",
            "struct<x:interval year to month>",
        ),
        (
            """array(INTERVAL '1-2' YEAR TO MONTH)""",
            "array<interval year to month>",
        ),
    ],
)
def test_rejects_nested_non_profileable_types_before_indexing(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
    expression: str,
    raw_type: str,
) -> None:
    frame = spark_session.sql(f"SELECT {expression} AS payload")
    assert frame.schema.fields[0].dataType.simpleString() == raw_type
    monkeypatch.setattr(__main__, "open_wrangler_nested_unsupported", frame, raising=False)
    indexing_calls = 0

    def fail_if_indexed(self: PySparkEngine, value: Any, token: str) -> Any:
        del self, value, token
        nonlocal indexing_calls
        indexing_calls += 1
        raise AssertionError("Unsupported nested types must fail before Spark indexing.")

    monkeypatch.setattr(PySparkEngine, "ensure_row_ids", fail_if_indexed)
    manager = SessionManager()
    with pytest.raises(
        EngineError,
        match=rf"required viewing profiles.*'payload' \({re.escape(raw_type)}\).*Convert these columns in Spark",
    ):
        manager.open_session(
            {
                "kind": "notebookVariable",
                "variableName": "open_wrangler_nested_unsupported",
                "label": "open_wrangler_nested_unsupported",
            },
            backend="pyspark",
        )
    assert indexing_calls == 0
    assert manager.sessions == {}


@pytest.mark.parametrize(
    ("first_name", "second_name"),
    [
        ("x", "x"),
        ("Value", "value"),
    ],
)
def test_rejects_ambiguous_nested_struct_fields_before_indexing(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
    first_name: str,
    second_name: str,
) -> None:
    frame = spark_session.sql(f"SELECT named_struct('{first_name}', 1, '{second_name}', 2) AS payload")
    monkeypatch.setattr(__main__, "open_wrangler_ambiguous_nested", frame, raising=False)
    indexing_calls = 0

    def fail_if_indexed(self: PySparkEngine, value: Any, token: str) -> Any:
        del self, value, token
        nonlocal indexing_calls
        indexing_calls += 1
        raise AssertionError("Ambiguous nested fields must fail before Spark indexing.")

    monkeypatch.setattr(PySparkEngine, "ensure_row_ids", fail_if_indexed)
    manager = SessionManager()
    with pytest.raises(
        EngineError,
        match=(
            rf"nested struct fields.*{re.escape(first_name)}.*"
            rf"{re.escape(second_name)}.*Rename the conflicting nested fields"
        ),
    ):
        manager.open_session(
            {
                "kind": "notebookVariable",
                "variableName": "open_wrangler_ambiguous_nested",
                "label": "open_wrangler_ambiguous_nested",
            },
            backend="pyspark",
        )
    assert indexing_calls == 0
    assert manager.sessions == {}


def test_index_materializes_once_and_close_unpersists_once(monkeypatch: pytest.MonkeyPatch) -> None:
    class IndexedFrame:
        columns = [f"{INTERNAL_ROW_ID_PREFIX}unit"]
        isStreaming = False

        def __init__(self) -> None:
            self.persist_calls = 0
            self.count_calls = 0
            self.unpersist_calls = 0

        def zipWithIndex(self, _name: str) -> None:
            raise AssertionError("already indexed")

        def persist(self) -> IndexedFrame:
            self.persist_calls += 1
            return self

        def count(self) -> int:
            self.count_calls += 1
            return 7

        def unpersist(self, *, blocking: bool) -> None:
            assert blocking is False
            self.unpersist_calls += 1

    class SourceFrame:
        columns = ["value"]
        isStreaming = False

        def __init__(self, indexed: IndexedFrame) -> None:
            self.indexed = indexed
            self.zip_calls = 0

        def zipWithIndex(self, name: str) -> IndexedFrame:
            self.zip_calls += 1
            self.indexed.columns = ["value", name]
            return self.indexed

    indexed = IndexedFrame()
    source = SourceFrame(indexed)
    monkeypatch.setattr(
        PySparkEngine,
        "_require_supported_frame",
        staticmethod(lambda _frame: None),
    )
    engine = PySparkEngine()

    result = engine.ensure_row_ids(source, "unit")
    assert result is indexed
    assert source.zip_calls == 1
    assert indexed.persist_calls == 1
    assert indexed.count_calls == 1
    assert engine.shape(indexed) == {"rows": 7, "columns": 1}
    assert indexed.count_calls == 1

    engine.close()
    engine.close()
    assert indexed.unpersist_calls == 1


def test_close_unregisters_the_real_owned_cache_without_stopping_spark(
    spark_session: Any,
    sample_frame: Any,
) -> None:
    storage_level = import_module("pyspark").StorageLevel
    engine, indexed = _open_engine(sample_frame, "cache-release")
    assert indexed.storageLevel != storage_level.NONE

    engine.close()
    deadline = monotonic() + 10
    while indexed.storageLevel != storage_level.NONE and monotonic() < deadline:
        sleep(0.05)

    assert indexed.storageLevel == storage_level.NONE
    assert spark_session.range(1).count() == 1


def test_sorted_state_uses_live_frame_identity_not_reusable_numeric_ids(
    spark_session: Any,
    sample_frame: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    functions = import_module("pyspark.sql.functions")
    engine, indexed = _open_engine(sample_frame, "identity")
    try:
        # This simulates the CPython object-ID reuse that made the previous
        # integer-ID side table misclassify an unrelated frame as ordered.
        monkeypatch.setattr(pyspark_engine_module, "id", lambda _value: 1, raising=False)
        engine.apply_filter_model(
            indexed,
            {
                "logic": "and",
                "filters": [],
                "sort": [{"column": "name", "direction": "asc", "nulls": "last"}],
            },
        )

        row_id = engine.internal_row_id_column(indexed)
        assert isinstance(row_id, str)
        unrelated_descending = indexed.orderBy(functions.col(f"`{row_id.replace('`', '``')}`").desc())
        page = engine.page(
            unrelated_descending,
            0,
            10,
            total_rows=5,
            column_projection=[(0, "name-id")],
        )
        identities = [int(row["id"].rsplit(":", 1)[1]) for row in page["rows"]]
        assert identities == [0, 1, 2, 3, 4]
    finally:
        engine.close()


def test_owned_source_pages_use_the_dense_row_identity_range_instead_of_global_offset(
    sample_frame: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine, indexed = _open_engine(sample_frame, "bounded-source-page")
    dataframe_type = type(indexed)

    def forbidden_global_offset(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("The owned source page must not globally sort and offset the complete dataframe.")

    try:
        with monkeypatch.context() as page_patch:
            page_patch.setattr(dataframe_type, "offset", forbidden_global_offset)
            page = engine.page(
                indexed,
                2,
                2,
                total_rows=5,
                column_projection=[(0, "name-id")],
            )
        assert [row["rowNumber"] for row in page["rows"]] == [2, 3]
        assert [int(row["id"].rsplit(":", 1)[1]) for row in page["rows"]] == [2, 3]
    finally:
        engine.close()


def test_projected_paging_filters_sorts_and_profiles_are_native_and_bounded(
    spark_session: Any,
    sample_frame: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine, indexed = _open_engine(sample_frame, "native")
    dataframe_type = type(indexed)
    original_collect = dataframe_type.collect
    collected_projections: list[tuple[str, ...]] = []

    def forbidden(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("A forbidden dataframe conversion path was called.")

    def observed_collect(value: Any) -> Any:
        collected_projections.append(tuple(value.columns))
        return original_collect(value)

    for method_name in ("toPandas", "toArrow", "mapInPandas", "mapInArrow"):
        if hasattr(dataframe_type, method_name):
            monkeypatch.setattr(dataframe_type, method_name, forbidden)
    monkeypatch.setattr(dataframe_type, "collect", observed_collect)

    try:
        shape = engine.shape(indexed)
        assert shape == {"rows": 5, "columns": 5}
        schema = engine.schema(indexed)
        assert [column["name"] for column in schema] == [
            "name",
            "amount",
            "group_name",
            "flag",
            "happened",
        ]
        assert [column["type"] for column in schema] == [
            "string",
            "float",
            "string",
            "boolean",
            "datetime",
        ]

        full_page = engine.page(
            indexed,
            0,
            10,
            total_rows=shape["rows"],
            column_projection=[(1, "amount-id"), (0, "name-id")],
        )
        page = engine.page(
            indexed,
            1,
            2,
            total_rows=shape["rows"],
            column_projection=[(1, "amount-id"), (0, "name-id")],
        )
        assert page["columnIds"] == ["amount-id", "name-id"]
        assert [row["rowNumber"] for row in page["rows"]] == [1, 2]
        assert page["rows"] == [
            {**row, "rowNumber": position} for position, row in enumerate(full_page["rows"][1:3], start=1)
        ]
        amount_by_name = {row["values"][1]["display"]: row["values"][0] for row in full_page["rows"]}
        assert amount_by_name["alpha"]["isNull"]
        assert amount_by_name["ALPHA"]["isNaN"]

        text_filter = {
            "logic": "and",
            "filters": [
                {
                    "column": "name",
                    "type": "string",
                    "logic": "and",
                    "predicates": [{"operator": "contains", "value": "AlPhA"}],
                }
            ],
            "sort": [],
        }
        text_view = engine.apply_filter_model(indexed, text_filter)
        text_shape = engine.shape(text_view)
        assert text_shape["rows"] == 2
        text_page = engine.page(
            text_view,
            0,
            10,
            total_rows=text_shape["rows"],
            column_projection=[(0, "name-id")],
        )
        assert [row["values"][0]["display"] for row in text_page["rows"]] == ["alpha", "ALPHA"]

        sorted_model = {
            "logic": "and",
            "filters": [
                {
                    "column": "amount",
                    "type": "float",
                    "logic": "and",
                    "predicates": [
                        {"operator": "isNotNull"},
                        {"operator": "isNotNaN"},
                    ],
                }
            ],
            "sort": [
                {
                    "column": "amount",
                    "direction": "asc",
                    "nulls": "last",
                }
            ],
        }
        sorted_view = engine.apply_filter_model(indexed, sorted_model)
        sorted_shape = engine.shape(sorted_view)
        sorted_page = engine.page(
            sorted_view,
            0,
            10,
            total_rows=sorted_shape["rows"],
            column_projection=[(1, "amount-id"), (0, "name-id")],
        )
        assert [row["values"][0]["raw"] for row in sorted_page["rows"]] == [-1.0, 2.0, 2.0]
        assert [row["values"][1]["display"] for row in sorted_page["rows"]] == ["ÄLPHA", "Beta", "Beta"]

        summary = engine.summaries(indexed, [(1, "amount-id")])[0]
        assert summary["columnId"] == "amount-id"
        assert summary["totalCount"] == 5
        assert summary["nullCount"] == 1
        assert summary["nanCount"] == 1
        assert summary["distinctCount"] == 2
        assert summary["numeric"] == pytest.approx(
            {
                "min": -1.0,
                "max": 2.0,
                "mean": 1.0,
                "median": 2.0,
                "std": 3**0.5,
            }
        )
        assert summary["visualization"]["kind"] == "numeric"

        stats = engine.header_stats(indexed)
        assert stats == {
            "missingCells": 4,
            "missingRows": 2,
            "duplicateRows": 1,
            "missingValuesByColumn": [
                {"column": "name", "count": 0},
                {"column": "amount", "count": 2},
                {"column": "group_name", "count": 0},
                {"column": "flag", "count": 1},
                {"column": "happened", "count": 1},
            ],
        }

        values, has_more = engine.column_values(indexed, "name", "alp", 10)
        assert not has_more
        assert [(item["value"], item["count"]) for item in values] == [("ALPHA", 1), ("alpha", 1)]
        assert all("selectionValue" in item for item in values)
        assert collected_projections.count(("count", "__ow_value")) >= 2
        assert all("__ow_group_key" not in projection for projection in collected_projections)
    finally:
        engine.close()

    # The adapter owns only its indexed cached child, never the user's session.
    assert spark_session.range(1).count() == 1


def test_partitioned_skewed_frame_keeps_native_far_paging_multi_sort_and_cleanup(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    functions = import_module("pyspark.sql.functions")
    row_count = 20_000
    hot_row_count = 19_400
    partition_count = 23
    source = (
        spark_session.range(row_count, numPartitions=partition_count)
        .select(
            functions.col("id").alias("record_id"),
            functions.when(functions.col("id") < hot_row_count, functions.lit("hot"))
            .otherwise(functions.concat(functions.lit("tail-"), functions.col("id").cast("string")))
            .alias("segment"),
            functions.when(
                (functions.col("id") % 97) == 0,
                functions.lit(None).cast("double"),
            )
            .otherwise((functions.col("id") % 1_000).cast("double"))
            .alias("score"),
        )
        .repartition(partition_count, "record_id")
    )
    assert source.select(functions.spark_partition_id().alias("partition_id")).distinct().count() == partition_count

    dataframe_type = type(source)

    def forbidden(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("Partitioned PySpark viewing must never use a dataframe conversion path.")

    for method_name in ("toPandas", "toArrow", "mapInPandas", "mapInArrow"):
        if hasattr(dataframe_type, method_name):
            monkeypatch.setattr(dataframe_type, method_name, forbidden)

    engine, indexed = _open_engine(source, "partitioned-skew")
    try:
        assert engine.shape(indexed) == {"rows": row_count, "columns": 3}
        far_page = engine.page(
            indexed,
            row_count - 12,
            20,
            total_rows=row_count,
            column_projection=[(0, "record-id"), (1, "segment-id")],
        )
        assert far_page["columnIds"] == ["record-id", "segment-id"]
        assert [row["rowNumber"] for row in far_page["rows"]] == list(range(row_count - 12, row_count))
        assert [int(row["id"].rsplit(":", 1)[1]) for row in far_page["rows"]] == list(range(row_count - 12, row_count))

        model = {
            "logic": "and",
            "filters": [
                {
                    "column": "segment",
                    "type": "string",
                    "logic": "and",
                    "predicates": [{"operator": "equals", "value": "hot"}],
                }
            ],
            "sort": [
                {"column": "score", "direction": "asc", "nulls": "last"},
                {"column": "record_id", "direction": "desc", "nulls": "last"},
            ],
        }
        view = engine.apply_filter_model(indexed, model)
        assert engine.shape(view) == {"rows": hot_row_count, "columns": 3}

        expected_ids = sorted(
            range(hot_row_count),
            key=lambda value: (
                value % 97 == 0,
                value % 1_000 if value % 97 != 0 else 0,
                -value,
            ),
        )
        first_page = engine.page(
            view,
            0,
            5,
            total_rows=hot_row_count,
            column_projection=[(0, "record-id")],
        )
        last_page = engine.page(
            view,
            hot_row_count - 5,
            5,
            total_rows=hot_row_count,
            column_projection=[(0, "record-id")],
        )
        assert [row["values"][0]["raw"] for row in first_page["rows"]] == expected_ids[:5]
        assert [row["values"][0]["raw"] for row in last_page["rows"]] == expected_ids[-5:]

        score_summary = engine.summaries(view, [(2, "score-id")])[0]
        assert score_summary["totalCount"] == hot_row_count
        assert score_summary["nullCount"] == 200
        assert score_summary["numeric"]["min"] == 0.0
        assert score_summary["numeric"]["max"] == 999.0
    finally:
        engine.close()

    # Closing Open Wrangler releases only its indexed child, not the user's
    # Classic or Connect Spark session.
    assert spark_session.range(1).count() == 1


def test_numeric_histogram_is_exact_for_a_large_filtered_view(spark_session: Any) -> None:
    functions = import_module("pyspark.sql.functions")
    source = (
        spark_session.range(5_000)
        .select(functions.col("id").cast("double").alias("value"))
        .unionByName(spark_session.createDataFrame([(1_000_000.0,)], "value double"))
    )
    engine = PySparkEngine()
    try:
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

        summary = engine.summaries(frame, [(0, "value-id")])[0]
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
        assert [bin_["max"] - bin_["min"] for bin_ in bins] == pytest.approx(
            [bins[0]["max"] - bins[0]["min"]] * len(bins)
        )
    finally:
        engine.close()


def test_numeric_summaries_publish_lossless_wide_integer_and_decimal_extrema(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frame = spark_session.createDataFrame(
        [
            (-9_007_199_254_740_993, Decimal("-123456789012345.123456789012345678")),
            (9_007_199_254_740_995, Decimal("987654321098765.987654321098765432")),
        ],
        "wide long, amount decimal(38,18)",
    )
    engine, indexed = _open_engine(frame, "exact-extrema")
    dataframe_type = type(indexed)

    def forbidden(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("PySpark summaries must never convert through Pandas or Arrow.")

    for method_name in ("toPandas", "toArrow", "mapInPandas", "mapInArrow"):
        if hasattr(dataframe_type, method_name):
            monkeypatch.setattr(dataframe_type, method_name, forbidden)

    try:
        summaries = engine.summaries(indexed, [(0, "wide-id"), (1, "amount-id")])

        assert summaries[0]["numeric"]["exactMin"] == {
            "kind": "integer",
            "raw": "-9007199254740993",
            "display": "-9007199254740993",
            "isNull": False,
            "isNaN": False,
        }
        assert summaries[0]["numeric"]["exactMax"] == {
            "kind": "integer",
            "raw": "9007199254740995",
            "display": "9007199254740995",
            "isNull": False,
            "isNaN": False,
        }
        assert summaries[1]["numeric"]["exactMin"]["display"] == "-123456789012345.123456789012345678"
        assert summaries[1]["numeric"]["exactMax"]["display"] == "987654321098765.987654321098765432"
        assert summaries[1]["numeric"]["exactMin"]["kind"] == "decimal"
        assert summaries[1]["numeric"]["exactMax"]["kind"] == "decimal"
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_text_summaries_are_exact_native_unicode_aggregates(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frame = spark_session.createDataFrame(
        [
            (None, None),
            ("", None),
            ("A", None),
            ("é", None),
            ("e\u0301", None),
            ("😀", None),
        ],
        "text_value string, all_null string",
    )
    engine, indexed = _open_engine(frame, "text-summary")
    dataframe_type = type(indexed)

    def forbidden(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("PySpark summaries must never convert through Pandas or Arrow.")

    for method_name in ("toPandas", "toArrow", "mapInPandas", "mapInArrow"):
        if hasattr(dataframe_type, method_name):
            monkeypatch.setattr(dataframe_type, method_name, forbidden)

    try:
        summaries = engine.summaries(indexed, [(0, "text-id"), (1, "all-null-id")])

        assert summaries[0]["text"] == pytest.approx(
            {
                "emptyCount": 1,
                "minLength": 0,
                "maxLength": 2,
                "meanLength": 1.0,
            }
        )
        assert summaries[0]["nullCount"] == 1
        assert summaries[1]["text"] == {"emptyCount": 0}
        assert summaries[1]["nullCount"] == 6
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_maps_and_nested_maps_use_canonical_native_profile_keys(spark_session: Any) -> None:
    frame = spark_session.sql(
        """
        SELECT
          map_from_arrays(array('a', 'b'), array(1, 2)) AS payload,
          named_struct(
            'nested',
            map_from_arrays(
              array('x'),
              array(map_from_arrays(array('a', 'b'), array(1, 2)))
            )
          ) AS detail
        UNION ALL
        SELECT
          map_from_arrays(array('b', 'a'), array(2, 1)) AS payload,
          named_struct(
            'nested',
            map_from_arrays(
              array('x'),
              array(map_from_arrays(array('b', 'a'), array(2, 1)))
            )
          ) AS detail
        UNION ALL
        SELECT
          map('a', 9) AS payload,
          named_struct('nested', map('x', map('a', 9))) AS detail
        """
    )
    engine, indexed = _open_engine(frame, "map-profiles")
    try:
        assert engine.header_stats(indexed) == {
            "missingCells": 0,
            "missingRows": 0,
            "duplicateRows": 1,
            "missingValuesByColumn": [
                {"column": "payload", "count": 0},
                {"column": "detail", "count": 0},
            ],
        }

        payload_summary = engine.summaries(indexed, [(0, "payload-id")])[0]
        assert payload_summary["distinctCount"] == 2
        assert payload_summary["topValues"] == [
            {"value": '{"a":1,"b":2}', "count": 2},
            {"value": '{"a":9}', "count": 1},
        ]
        values, has_more = engine.column_values(indexed, "payload", limit=10)
        assert not has_more
        assert values == [
            {"value": '{"a":1,"b":2}', "count": 2},
            {"value": '{"a":9}', "count": 1},
        ]

        page = engine.page(
            indexed,
            0,
            3,
            total_rows=3,
            column_projection=[(0, "payload-id"), (1, "detail-id")],
        )
        assert page["columnIds"] == ["payload-id", "detail-id"]
        assert page["rows"][0]["values"][0]["raw"] == {"a": 1, "b": 2}
        assert page["rows"][1]["values"][0]["raw"] == {"b": 2, "a": 1}
        assert page["rows"][0]["values"][1]["raw"] == {"nested": {"x": {"a": 1, "b": 2}}}
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_nested_decimals_keep_exact_page_precision(spark_session: Any) -> None:
    exact = "12345678901234567890.123456789012345678"
    frame = spark_session.sql(
        f"""
        SELECT named_struct(
          'amount', CAST('{exact}' AS DECIMAL(38, 18)),
          'items', array(CAST('{exact}' AS DECIMAL(38, 18))),
          'by_key', map('x', CAST('{exact}' AS DECIMAL(38, 18)))
        ) AS payload
        """
    )
    engine, indexed = _open_engine(frame, "nested-decimal-page")
    try:
        page = engine.page(
            indexed,
            0,
            1,
            total_rows=1,
            column_projection=[(0, "payload-id")],
        )
        assert page["rows"][0]["values"][0]["raw"] == {
            "amount": exact,
            "items": [exact],
            "by_key": {"x": exact},
        }
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_nested_negative_zero_uses_native_profile_equality(spark_session: Any) -> None:
    frame = spark_session.sql(
        """
        SELECT
          array(CAST('-0.0' AS DOUBLE)) AS array_value,
          map('x', CAST('-0.0' AS DOUBLE)) AS map_value,
          named_struct('x', CAST('-0.0' AS DOUBLE)) AS struct_value
        UNION ALL
        SELECT
          array(CAST('0.0' AS DOUBLE)),
          map('x', CAST('0.0' AS DOUBLE)),
          named_struct('x', CAST('0.0' AS DOUBLE))
        """
    )
    engine, indexed = _open_engine(frame, "nested-negative-zero")
    try:
        for position, column_name in enumerate(("array_value", "map_value", "struct_value")):
            summary = engine.summaries(indexed, [(position, f"{column_name}-id")])[0]
            assert summary["distinctCount"] == 1
            assert len(summary["topValues"]) == 1
            assert summary["topValues"][0]["count"] == 2

            values, has_more = engine.column_values(indexed, column_name, limit=10)
            assert not has_more
            assert len(values) == 1
            assert values[0]["count"] == 2
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


@pytest.mark.parametrize(
    "expression",
    [
        "repeat('x', 128)",
        "encode(repeat('x', 128), 'UTF-8')",
        "array_repeat(repeat('x', 8), 32)",
        "map('payload', repeat('x', 128))",
        "named_struct('payload', repeat('x', 128))",
    ],
)
def test_large_variable_width_page_values_fail_before_terminal_collection(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
    expression: str,
) -> None:
    frame = spark_session.sql(f"SELECT {expression} AS payload")
    engine, indexed = _open_engine(frame, "large-page-value")
    dataframe_type = type(indexed)
    original_collect = dataframe_type.collect
    collected_projections: list[tuple[str, ...]] = []

    def guarded_collect(value: Any) -> Any:
        projection = tuple(value.columns)
        collected_projections.append(projection)
        if any(name.startswith("__ow_page_value_") and name != "__ow_page_value_bytes" for name in projection):
            raise AssertionError("Oversized page values must not cross into the notebook process.")
        return original_collect(value)

    try:
        with monkeypatch.context() as page_patch:
            page_patch.setattr(pyspark_engine_module, "PYSPARK_PAGE_TRANSPORT_BYTE_LIMIT", 32)
            page_patch.setattr(dataframe_type, "collect", guarded_collect)
            with pytest.raises(EngineError, match=r"at most 32 UTF-8 bytes"):
                engine.page(
                    indexed,
                    0,
                    1,
                    total_rows=1,
                    column_projection=[(0, "payload-id")],
                )
        assert collected_projections == [("__ow_page_value_bytes",)]
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_large_profile_values_fail_before_terminal_collection(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frame = spark_session.sql(
        """
        SELECT
          repeat('x', 128) AS text_value,
          encode(repeat('x', 128), 'UTF-8') AS binary_value,
          array_repeat(repeat('x', 8), 32) AS array_value,
          map('payload', repeat('x', 128)) AS map_value,
          named_struct('payload', repeat('x', 128)) AS struct_value
        """
    )
    engine, indexed = _open_engine(frame, "large-profile-values")
    dataframe_type = type(indexed)
    original_collect = dataframe_type.collect
    collected_projections: list[tuple[str, ...]] = []

    def guarded_collect(value: Any) -> Any:
        projection = tuple(value.columns)
        collected_projections.append(projection)
        if "__ow_value" in projection:
            raise AssertionError("Oversized profile values must not cross into the notebook process.")
        return original_collect(value)

    try:
        with monkeypatch.context() as profile_patch:
            profile_patch.setattr(pyspark_engine_module, "PYSPARK_PROFILE_TRANSPORT_BYTE_LIMIT", 32)
            profile_patch.setattr(dataframe_type, "collect", guarded_collect)
            for position, column_name in enumerate(
                ("text_value", "binary_value", "array_value", "map_value", "struct_value")
            ):
                with pytest.raises(EngineError, match=r"at most 32 UTF-8 bytes"):
                    engine.summaries(indexed, [(position, f"{column_name}-id")])
                with pytest.raises(EngineError, match=r"at most 32 UTF-8 bytes"):
                    engine.column_values(indexed, column_name, limit=10)
        assert collected_projections.count(("__ow_profile_value_bytes",)) == 10
        assert all("__ow_value" not in projection for projection in collected_projections)
        assert all("__ow_group_key" not in projection for projection in collected_projections)
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_complex_page_depth_and_node_budgets_are_authoritative(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frame = spark_session.sql("SELECT array(array(array(1))) AS nested, array(1, 2, 3, 4) AS many")
    engine, indexed = _open_engine(frame, "complex-page-budgets")
    try:
        with monkeypatch.context() as page_patch:
            page_patch.setattr(pyspark_engine_module, "PYSPARK_PAGE_COMPLEX_DEPTH_LIMIT", 2)
            with pytest.raises(EngineError, match=r"at most 2 nested levels; encountered depth 3"):
                engine.page(
                    indexed,
                    0,
                    1,
                    total_rows=1,
                    column_projection=[(0, "nested-id")],
                )

        with monkeypatch.context() as page_patch:
            page_patch.setattr(pyspark_engine_module, "PYSPARK_PAGE_COMPLEX_NODE_LIMIT", 4)
            with pytest.raises(EngineError, match=r"at most 4 JSON nodes; encountered at least 5"):
                engine.page(
                    indexed,
                    0,
                    1,
                    total_rows=1,
                    column_projection=[(1, "many-id")],
                )

        page = engine.page(
            indexed,
            0,
            1,
            total_rows=1,
            column_projection=[(0, "nested-id"), (1, "many-id")],
        )
        assert page["rows"][0]["values"][0]["raw"] == [[[1]]]
        assert page["rows"][0]["values"][1]["raw"] == [1, 2, 3, 4]
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_page_protocol_byte_budget_accepts_only_the_exact_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = {
        "offset": 0,
        "limit": 1,
        "totalRows": 1,
        "columnIds": ["payload-id"],
        "rows": [
            {
                "id": "r:0",
                "rowNumber": 0,
                "values": [
                    {
                        "kind": "string",
                        "raw": 'quoted "value"',
                        "display": 'quoted "value"',
                        "isNull": False,
                        "isNaN": False,
                    }
                ],
            }
        ],
    }
    exact_size = len(json.dumps(page, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
    with monkeypatch.context() as page_patch:
        page_patch.setattr(pyspark_engine_module, "PYSPARK_PAGE_PROTOCOL_BYTE_LIMIT", exact_size)
        pyspark_engine_module._validate_page_protocol_size(page)

    with monkeypatch.context() as page_patch:
        page_patch.setattr(pyspark_engine_module, "PYSPARK_PAGE_PROTOCOL_BYTE_LIMIT", exact_size - 1)
        with pytest.raises(EngineError, match=rf"at most {exact_size - 1:,} serialized bytes"):
            pyspark_engine_module._validate_page_protocol_size(page)


def test_profile_protocol_byte_budget_accepts_only_the_exact_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    values = [{"value": 'quoted "value"', "count": 1}]
    exact_size = len(json.dumps(values, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
    with monkeypatch.context() as profile_patch:
        profile_patch.setattr(pyspark_engine_module, "PYSPARK_PROFILE_PROTOCOL_BYTE_LIMIT", exact_size)
        pyspark_engine_module._validate_profile_protocol_size(values, "column values")

    with monkeypatch.context() as profile_patch:
        profile_patch.setattr(pyspark_engine_module, "PYSPARK_PROFILE_PROTOCOL_BYTE_LIMIT", exact_size - 1)
        with pytest.raises(EngineError, match=rf"at most {exact_size - 1:,} serialized bytes"):
            pyspark_engine_module._validate_profile_protocol_size(values, "column values")


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
