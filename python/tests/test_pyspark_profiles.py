from __future__ import annotations

import json
from decimal import Decimal
from importlib import import_module
from typing import Any

import pytest
from python.benchmarks.pyspark_profile import PROFILE_COLUMN_NAMES, build_mixed_profile_frame, summary_projection
from python.tests.pyspark_engine_test_support import (
    _open_engine,
)
from python.tests.pyspark_engine_test_support import (
    sample_frame as _shared_sample_frame,
)
from python.tests.pyspark_engine_test_support import (
    spark_session as _shared_spark_session,
)

import openwrangler_runtime.engines.pyspark_engine as pyspark_engine_module
from openwrangler_runtime.engines import EngineError, PySparkEngine

sample_frame = _shared_sample_frame
spark_session = _shared_spark_session


def test_summary_batch_ranges_bound_exact_work_and_action_formula() -> None:
    numeric_shape = (2, 13)
    mixed_shapes = [
        numeric_shape,
        numeric_shape,
        numeric_shape,
        (1, 8),
        (1, 6),
        (1, 6),
        (1, 4),
        (1, 4),
        (1, 4),
        (1, 4),
    ]

    mixed_batches = pyspark_engine_module._summary_metric_batch_ranges(mixed_shapes)
    numeric_batches = pyspark_engine_module._summary_metric_batch_ranges([numeric_shape] * 50)
    mixed_top_batches = pyspark_engine_module._summary_terminal_batch_ranges([True] * 10)
    mixed_histogram_batches = pyspark_engine_module._summary_terminal_batch_ranges([True] * 3)
    numeric_top_batches = pyspark_engine_module._summary_terminal_batch_ranges([True] * 50)
    numeric_histogram_batches = pyspark_engine_module._summary_terminal_batch_ranges([True] * 50)
    interval_fallback_batches = pyspark_engine_module._summary_terminal_batch_ranges(
        [True, True, False, True, True, True, True, True]
    )

    assert mixed_batches == [(0, 2), (2, 5), (5, 9), (9, 10)]
    assert mixed_top_batches == [(0, 4), (4, 8), (8, 10)]
    assert mixed_histogram_batches == [(0, 3)]
    assert len(mixed_batches) + len(mixed_top_batches) + len(mixed_histogram_batches) == 8
    assert len(numeric_batches) == 25
    assert len(numeric_top_batches) == 13
    assert len(numeric_histogram_batches) == 13
    assert len(numeric_batches) + len(numeric_top_batches) + len(numeric_histogram_batches) == 51
    assert all(end - start == 2 for start, end in numeric_batches)
    assert interval_fallback_batches == [(0, 2), (2, 3), (3, 7), (7, 8)]
    assert all(
        end - start <= pyspark_engine_module.PYSPARK_SUMMARY_TERMINAL_BRANCH_LIMIT for start, end in numeric_top_batches
    )


def test_profile_display_decoder_keeps_unsupported_types_on_singleton_plans() -> None:
    pytest.importorskip("pyspark")
    data_types = import_module("pyspark.sql.types")

    assert pyspark_engine_module._profile_display_decoder(data_types.StringType()) == "string"
    assert pyspark_engine_module._profile_display_decoder(data_types.StringType("UTF8_LCASE")) is None
    assert pyspark_engine_module._profile_display_decoder(data_types.CharType(8)) is None
    assert pyspark_engine_module._profile_display_decoder(data_types.VarcharType(8)) is None
    assert pyspark_engine_module._profile_display_decoder(data_types.DayTimeIntervalType()) is None


def test_mixed_profile_fixture_is_native_ordered_and_complete(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frame = build_mixed_profile_frame(spark_session, rows=96, partitions=4)
    engine, indexed = _open_engine(frame, "mixed-profile")
    dataframe_type = type(indexed)
    original_collect = dataframe_type.collect
    collected_projections: list[tuple[str, ...]] = []
    optimized_plans: list[tuple[tuple[str, ...], str]] = []

    def forbidden(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("The shared PySpark profile fixture must never use a dataframe conversion path.")

    for method_name in ("toPandas", "toArrow", "mapInPandas", "mapInArrow"):
        if hasattr(dataframe_type, method_name):
            monkeypatch.setattr(dataframe_type, method_name, forbidden)

    def observed_collect(value: Any) -> Any:
        projection = tuple(value.columns)
        collected_projections.append(projection)
        if ".connect." not in type(value).__module__:
            optimized_plans.append((projection, str(value._jdf.queryExecution().optimizedPlan().toString())))
        return original_collect(value)

    monkeypatch.setattr(dataframe_type, "collect", observed_collect)

    try:
        schema = engine.schema(indexed)
        assert [column["name"] for column in schema] == list(PROFILE_COLUMN_NAMES)
        projection = summary_projection(schema)

        score = engine.summaries(indexed, [projection[1]])[0]
        assert score["columnId"] == "profile:score"
        assert score["column"] == "score"
        assert score["totalCount"] == 96
        assert score["nullCount"] == 2
        assert score["nanCount"] == 2
        assert score["numeric"]["min"] == -1_000_000.25
        assert score["numeric"]["max"] == 1_000_000.75
        assert sum(bin_["count"] for bin_ in score["visualization"]["bins"]) == 92
        assert len(collected_projections) == 3
        assert (
            sum(
                bool(columns) and all(column.startswith("__ow_summary_") for column in columns)
                for columns in collected_projections
            )
            == 1
        )
        assert collected_projections.count(("count", "__ow_value", "__ow_profile_total_bytes")) == 1
        assert (
            sum(
                bool(columns) and all(column.startswith("__ow_hist_") for column in columns)
                for columns in collected_projections
            )
            == 1
        )

        collected_projections.clear()
        optimized_plans.clear()
        summaries = engine.summaries(indexed, projection)
        assert [summary["columnId"] for summary in summaries] == [column_id for _position, column_id in projection]
        assert [summary["column"] for summary in summaries] == list(PROFILE_COLUMN_NAMES)
        assert summaries[2]["rawType"] == "decimal(18,2)"
        assert summaries[5]["rawType"] == "timestamp"
        assert summaries[6]["rawType"] == "binary"
        assert summaries[7]["rawType"] == "array<string>"
        assert summaries[8]["rawType"] == "map<string,string>"
        assert summaries[9]["rawType"] == "struct<region:string,priority:int>"
        assert all(summaries[position]["topValues"] for position in (6, 7, 8, 9))
        guarded_top_value_projection = (
            "__ow_profile_index",
            "count",
            "__ow_value",
            "__ow_profile_total_bytes",
        )
        fixed_metric_projections = [
            columns
            for columns in collected_projections
            if columns and all(column.startswith("__ow_summary_") for column in columns)
        ]
        histogram_projections = [
            columns
            for columns in collected_projections
            if columns and all(column.startswith("__ow_hist_") for column in columns)
        ]
        assert len(fixed_metric_projections) == 4
        assert collected_projections.count(guarded_top_value_projection) == 3
        assert len(histogram_projections) == 1
        assert len(collected_projections) == 8
        assert ("__ow_profile_value_bytes",) not in collected_projections
        if optimized_plans:
            top_plans = [plan for columns, plan in optimized_plans if columns == guarded_top_value_projection]
            histogram_plans = [
                plan
                for columns, plan in optimized_plans
                if columns and all(column.startswith("__ow_hist_") for column in columns)
            ]
            assert len(top_plans) == 3
            assert len(histogram_plans) == 1
            assert all("Union" not in plan for _columns, plan in optimized_plans)
            assert all("Generate explode" in plan and plan.count("Range (") == 1 for plan in top_plans)
            assert all("Aggregate" in plan and plan.count("Range (") == 1 for plan in histogram_plans)

        ordered = engine.apply_filter_model(
            indexed,
            {
                "logic": "and",
                "filters": [],
                "sort": [{"column": "record_id", "direction": "asc", "nulls": "last"}],
            },
        )
        page = engine.page(
            ordered,
            0,
            2,
            total_rows=None,
            column_projection=projection,
        )
        assert page["columnIds"] == [column_id for _position, column_id in projection]
        assert [row["values"][0]["raw"] for row in page["rows"]] == [0, 1]
        assert page["rows"][0]["values"][1]["raw"] == -1_000_000.25
        assert page["rows"][1]["values"][7]["raw"] == ["Enterprise", "tier-1"]
        assert page["rows"][1]["values"][8]["raw"] == {"region": "Nordics", "bucket": "1"}
        assert page["rows"][1]["values"][9]["raw"] == {"region": "Nordics", "priority": 1}
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_column_values_use_one_guarded_terminal_action(
    spark_session: Any,
    sample_frame: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine, indexed = _open_engine(sample_frame, "single-column-values-action")
    dataframe_type = type(indexed)
    original_collect = dataframe_type.collect
    collected_projections: list[tuple[str, ...]] = []

    def observed_collect(value: Any) -> Any:
        collected_projections.append(tuple(value.columns))
        return original_collect(value)

    monkeypatch.setattr(dataframe_type, "collect", observed_collect)
    try:
        values, has_more = engine.column_values(indexed, "name", limit=2)

        assert has_more is True
        assert [(item["value"], item["count"]) for item in values] == [("Beta", 2), ("ALPHA", 1)]
        assert all("selectionValue" in item for item in values)
        assert collected_projections == [("count", "__ow_value", "__ow_profile_total_bytes")]
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_fused_summaries_match_per_column_objects_and_canonical_utf8_bytes(spark_session: Any) -> None:
    frame = spark_session.sql(
        """
        SELECT * FROM VALUES
          (CAST(-9007199254740993 AS BIGINT),
           CAST('-123456789012345.123456789012345678' AS DECIMAL(38, 18)),
           CAST(NULL AS DOUBLE), CAST(NULL AS STRING), CAST(NULL AS DATE), CAST(NULL AS TIMESTAMP)),
          (CAST(9007199254740995 AS BIGINT),
           CAST('987654321098765.987654321098765432' AS DECIMAL(38, 18)),
           CAST('NaN' AS DOUBLE), '', DATE '2026-01-01', TIMESTAMP '2026-01-01 00:00:00'),
          (CAST(0 AS BIGINT), CAST('0.000000000000000000' AS DECIMAL(38, 18)),
           CAST('Infinity' AS DOUBLE), 'é', DATE '2026-01-02', TIMESTAMP '2026-01-01 12:30:00'),
          (CAST(1 AS BIGINT), CAST('1.000000000000000000' AS DECIMAL(38, 18)),
           CAST('-Infinity' AS DOUBLE), 'é', DATE '2026-01-03', TIMESTAMP '2026-01-02 00:00:00'),
          (CAST(2 AS BIGINT), CAST(NULL AS DECIMAL(38, 18)),
           CAST(-0.0 AS DOUBLE), '😀', CAST(NULL AS DATE), CAST(NULL AS TIMESTAMP)),
          (CAST(NULL AS BIGINT), CAST('2.000000000000000000' AS DECIMAL(38, 18)),
           CAST(3.5 AS DOUBLE), '|,:[]{}東京😀', DATE '2026-01-04', TIMESTAMP '2026-01-03 23:59:59'),
          (CAST(3 AS BIGINT), CAST('3.000000000000000000' AS DECIMAL(38, 18)),
           CAST(0.0 AS DOUBLE), CAST(NULL AS STRING), CAST(NULL AS DATE),
           CAST('1969-12-31T23:59:59.999999Z' AS TIMESTAMP)),
          (CAST(4 AS BIGINT), CAST('4.000000000000000000' AS DECIMAL(38, 18)),
           CAST('1.0' AS DOUBLE), CAST(NULL AS STRING), CAST(NULL AS DATE),
           CAST('2024-10-27T02:30:00+02:00' AS TIMESTAMP)),
          (CAST(5 AS BIGINT), CAST('5.000000000000000000' AS DECIMAL(38, 18)),
           CAST('1.0000000000000002' AS DOUBLE), CAST(NULL AS STRING), CAST(NULL AS DATE),
           CAST('2024-10-27T00:30:00Z' AS TIMESTAMP))
        AS fixture(wide, amount, floating, text_value, day_value, timestamp_value)
        """
    )
    engine, indexed = _open_engine(frame, "fused-summary-equality")
    try:
        schema = engine.schema(indexed)
        projection = [(int(column["position"]), f"fixture:{column['name']}") for column in schema]

        fused = engine.summaries(indexed, projection)
        per_column = [engine.summaries(indexed, [item])[0] for item in projection]

        def encode(value: Any) -> bytes:
            return json.dumps(
                value,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")

        assert fused == per_column
        assert encode(fused) == encode(per_column)
        assert fused[0]["numeric"]["exactMin"]["display"] == "-9007199254740993"
        assert fused[1]["numeric"]["exactMax"]["display"] == "987654321098765.987654321098765432"
        assert fused[0]["distinctCount"] == 8
        assert fused[1]["distinctCount"] == 8
        assert {item["value"] for item in fused[0]["topValues"]} >= {
            "-9007199254740993",
            "9007199254740995",
        }
        assert {item["value"] for item in fused[1]["topValues"]} >= {
            "-123456789012345.123456789012345678",
            "987654321098765.987654321098765432",
        }
        assert fused[2]["nullCount"] == 1
        assert fused[2]["nanCount"] == 1
        float_top_values = {item["value"]: item["count"] for item in fused[2]["topValues"]}
        assert fused[2]["distinctCount"] == 6
        assert float_top_values["0.0"] == 2
        assert float_top_values["1.0"] == 1
        assert float_top_values["1.0000000000000002"] == 1
        assert float_top_values["Infinity"] == 1
        assert float_top_values["-Infinity"] == 1
        assert fused[3]["text"] == pytest.approx({"emptyCount": 1, "minLength": 0, "maxLength": 10, "meanLength": 2.8})
        assert fused[4]["visualization"]["kind"] == "datetime"
        assert fused[5]["visualization"]["kind"] == "datetime"
        assert fused[5]["distinctCount"] == 6
        assert sorted(item["count"] for item in fused[5]["topValues"]) == [1, 1, 1, 1, 1, 2]
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_batched_terminal_summaries_match_temporal_complex_and_interval_bytes(spark_session: Any) -> None:
    frame = spark_session.sql(
        """
        SELECT 1 AS record_id, true AS active,
          DATE '2026-01-01' AS day_value, TIMESTAMP '2026-01-01 00:00:00.123456' AS timestamp_value,
          TIMESTAMP_NTZ '2026-01-01 00:00:00.123456' AS timestamp_ntz_value,
          encode('|,:[]{}é😀', 'UTF-8') AS binary_value, array('x', 'y') AS array_value,
          map_from_arrays(array('a', 'b'), array(1, 2)) AS map_value,
          named_struct('region', 'DACH', 'priority', 1) AS struct_value,
          INTERVAL '1 02:03:04.500000' DAY TO SECOND AS interval_value
        UNION ALL
        SELECT 2, false,
          DATE '2026-01-02', TIMESTAMP '2026-01-01 00:00:00.123457',
          TIMESTAMP_NTZ '2026-01-01 00:00:00.123457',
          encode('beta', 'UTF-8'), array('x', 'y'),
          map_from_arrays(array('b', 'a'), array(2, 1)),
          named_struct('region', 'DACH', 'priority', 1),
          INTERVAL '1 02:03:04.500000' DAY TO SECOND
        UNION ALL
        SELECT 3, CAST(NULL AS BOOLEAN),
          CAST(NULL AS DATE), CAST(NULL AS TIMESTAMP),
          CAST(NULL AS TIMESTAMP_NTZ),
          CAST(NULL AS BINARY), CAST(NULL AS ARRAY<STRING>),
          CAST(NULL AS MAP<STRING, INT>), CAST(NULL AS STRUCT<region: STRING, priority: INT>),
          INTERVAL '2 00:00:00.000001' DAY TO SECOND
        """
    )
    engine, indexed = _open_engine(frame, "batched-terminal-equality")
    try:
        schema = engine.schema(indexed)
        projection = [(int(column["position"]), f"terminal:{column['name']}") for column in schema]

        batched = engine.summaries(indexed, projection)
        per_column = [engine.summaries(indexed, [item])[0] for item in projection]

        def encode(value: Any) -> bytes:
            return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")

        assert batched == per_column
        assert encode(batched) == encode(per_column)
        assert batched[3]["distinctCount"] == 2
        assert batched[4]["distinctCount"] == 2
        assert batched[7]["distinctCount"] == 1
        assert batched[7]["topValues"] == [{"value": '{"a":1,"b":2}', "count": 2}]
        assert batched[9]["topValues"][0]["count"] == 2
    finally:
        engine.close()

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

        projection = [(0, "payload-id"), (1, "detail-id")]
        summaries = engine.summaries(indexed, projection)
        per_column = [engine.summaries(indexed, [item])[0] for item in projection]
        assert summaries == per_column
        assert json.dumps(summaries, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(
            "utf-8"
        ) == json.dumps(per_column, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")

        payload_summary = summaries[0]
        assert payload_summary["distinctCount"] == 2
        assert payload_summary["topValues"] == [
            {"value": '{"a":1,"b":2}', "count": 2},
            {"value": '{"a":9}', "count": 1},
        ]
        assert summaries[1]["distinctCount"] == 2
        assert summaries[1]["topValues"][0]["count"] == 2
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
        projection = [
            (position, f"{column_name}-id")
            for position, column_name in enumerate(("array_value", "map_value", "struct_value"))
        ]
        summaries = engine.summaries(indexed, projection)
        per_column = [engine.summaries(indexed, [item])[0] for item in projection]
        assert summaries == per_column
        assert json.dumps(summaries, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(
            "utf-8"
        ) == json.dumps(per_column, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")

        for position, column_name in enumerate(("array_value", "map_value", "struct_value")):
            summary = summaries[position]
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
def test_large_variable_width_page_values_use_one_guarded_terminal_collection(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
    expression: str,
) -> None:
    frame = spark_session.sql(f"SELECT {expression} AS payload")
    engine, indexed = _open_engine(frame, "large-page-value")
    dataframe_type = type(indexed)
    original_collect = dataframe_type.collect
    collected_projections: list[tuple[str, ...]] = []

    transported_payloads: list[Any] = []

    def guarded_collect(value: Any) -> Any:
        projection = tuple(value.columns)
        collected_projections.append(projection)
        rows = original_collect(value)
        if "__ow_page_value_bytes" in projection:
            payload_index = projection.index("__ow_page_value_0")
            transported_payloads.extend(row[payload_index] for row in rows)
        return rows

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
        assert collected_projections == [("__ow_page_row_id", "__ow_page_value_bytes", "__ow_page_value_0")]
        assert transported_payloads == [None]
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_large_profile_values_fail_without_transporting_terminal_values(
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
    transported_profile_values: list[Any] = []

    def guarded_collect(value: Any) -> Any:
        projection = tuple(value.columns)
        collected_projections.append(projection)
        rows = original_collect(value)
        if "__ow_profile_total_bytes" in projection:
            value_index = projection.index("__ow_value")
            transported_profile_values.extend(row[value_index] for row in rows)
        return rows

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
        assert collected_projections.count(("__ow_profile_value_bytes",)) == 0
        assert collected_projections.count(("count", "__ow_value", "__ow_profile_total_bytes")) == 10
        assert transported_profile_values == [None] * 10
        assert all("__ow_group_key" not in projection for projection in collected_projections)
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_batched_profile_values_fail_without_transporting_terminal_values(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frame = spark_session.sql(
        """
        SELECT
          repeat('a', 128) AS first_value,
          repeat('b', 128) AS second_value,
          encode(repeat('c', 128), 'UTF-8') AS binary_value,
          array_repeat(repeat('d', 8), 32) AS array_value
        """
    )
    engine, indexed = _open_engine(frame, "large-batched-profile-values")
    dataframe_type = type(indexed)
    original_collect = dataframe_type.collect
    collected_projections: list[tuple[str, ...]] = []
    transported_profile_values: list[Any] = []

    def guarded_collect(value: Any) -> Any:
        projection = tuple(value.columns)
        collected_projections.append(projection)
        rows = original_collect(value)
        if "__ow_profile_total_bytes" in projection:
            value_index = projection.index("__ow_value")
            transported_profile_values.extend(row[value_index] for row in rows)
        return rows

    try:
        projection = [(position, f"profile:{name}") for position, name in enumerate(frame.columns)]
        with monkeypatch.context() as profile_patch:
            profile_patch.setattr(pyspark_engine_module, "PYSPARK_PROFILE_TRANSPORT_BYTE_LIMIT", 32)
            profile_patch.setattr(dataframe_type, "collect", guarded_collect)
            with pytest.raises(EngineError, match=r"at most 32 UTF-8 bytes"):
                engine.summaries(indexed, projection)

        assert collected_projections[-1] == (
            "__ow_profile_index",
            "count",
            "__ow_value",
            "__ow_profile_total_bytes",
        )
        assert transported_profile_values == [None, None, None, None]
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
