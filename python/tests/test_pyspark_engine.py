from __future__ import annotations

import re
from collections.abc import Iterator
from datetime import datetime
from importlib import import_module
from typing import Any

import pytest

import __main__
import openwrangler_runtime.engines.pyspark_engine as pyspark_engine_module
from openwrangler_runtime.engines import EngineError, PySparkEngine
from openwrangler_runtime.engines.base import INTERNAL_ROW_ID_PREFIX
from openwrangler_runtime.session import SessionManager


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

    def forbidden(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("A forbidden dataframe conversion path was called.")

    for method_name in ("toPandas", "toArrow", "mapInPandas", "mapInArrow"):
        if hasattr(dataframe_type, method_name):
            monkeypatch.setattr(dataframe_type, method_name, forbidden)

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
    finally:
        engine.close()

    # The adapter owns only its indexed cached child, never the user's session.
    assert spark_session.range(1).count() == 1


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
