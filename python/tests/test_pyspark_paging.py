from __future__ import annotations

from importlib import import_module
from typing import Any

import pytest
from python.tests.pyspark_engine_test_support import (
    _open_engine,
)
from python.tests.pyspark_engine_test_support import (
    sample_frame as _shared_sample_frame,
)
from python.tests.pyspark_engine_test_support import (
    spark_session as _shared_spark_session,
)

from openwrangler_runtime.engines import EngineError

sample_frame = _shared_sample_frame
spark_session = _shared_spark_session


def test_first_page_does_not_cache_the_complete_relation_or_stop_spark(
    spark_session: Any,
    sample_frame: Any,
) -> None:
    storage_level = import_module("pyspark").StorageLevel
    engine, indexed = _open_engine(sample_frame, "bounded-open")
    assert indexed.storageLevel == storage_level.NONE

    page = engine.page(indexed, 0, 2, total_rows=None, column_projection=[(0, "name-id")])
    assert len(page["rows"]) == 2
    assert page["totalRows"] is None
    assert page["hasMore"] is True
    assert indexed.storageLevel == storage_level.NONE

    engine.close()
    assert indexed.storageLevel == storage_level.NONE
    assert spark_session.range(1).count() == 1


def test_classic_first_page_schedules_only_bounded_partition_work(spark_session: Any) -> None:
    if ".connect." in type(spark_session).__module__:
        pytest.skip("Spark Connect uses the same local server plan, but does not expose its status tracker.")
    partition_count = 32
    source = spark_session.range(1_000_000, numPartitions=partition_count).selectExpr("id", "id * 2 AS value")
    engine, indexed = _open_engine(source, "bounded-stage")
    tracker = spark_session.sparkContext.statusTracker()
    jobs_before = set(tracker.getJobIdsForGroup(None))
    try:
        page = engine.page(indexed, 0, 50, total_rows=None, column_projection=[(0, "id")])
        assert len(page["rows"]) == 50
        jobs_after = set(tracker.getJobIdsForGroup(None))
        stage_task_counts: list[int] = []
        for job_id in jobs_after - jobs_before:
            job = tracker.getJobInfo(job_id)
            if job is None:
                continue
            for stage_id in job.stageIds:
                stage = tracker.getStageInfo(stage_id)
                if stage is not None:
                    stage_task_counts.append(stage.numTasks)
        assert stage_task_counts
        assert max(stage_task_counts) < partition_count
        assert len(spark_session.sparkContext._jsc.sc().getRDDStorageInfo()) == 0
    finally:
        engine.close()


def test_progressive_page_rejects_a_changed_partition_traversal(
    sample_frame: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    functions = import_module("pyspark.sql.functions")
    engine, indexed = _open_engine(sample_frame, "changed-traversal")
    dataframe_type = type(indexed)
    original_offset = dataframe_type.offset
    row_id = engine.internal_row_id_column(indexed)
    assert isinstance(row_id, str)
    try:
        first = engine.page(indexed, 0, 2, total_rows=None, column_projection=[(0, "name-id")])
        assert first["hasMore"] is True

        def reordered_offset(frame: Any, value: int) -> Any:
            reordered = frame.orderBy(functions.col(f"`{row_id.replace('`', '``')}`").desc())
            return original_offset(reordered, value)

        with monkeypatch.context() as page_patch:
            page_patch.setattr(dataframe_type, "offset", reordered_offset)
            with pytest.raises(EngineError, match="traversal changed"):
                engine.page(indexed, 2, 2, total_rows=None, column_projection=[(0, "name-id")])
    finally:
        engine.close()


def test_explicit_sort_page_preserves_sort_order_and_stable_row_identity(
    spark_session: Any,
    sample_frame: Any,
) -> None:
    engine, indexed = _open_engine(sample_frame, "identity")
    try:
        ascending = engine.apply_filter_model(
            indexed,
            {
                "logic": "and",
                "filters": [],
                "sort": [{"column": "name", "direction": "asc", "nulls": "last"}],
            },
        )

        row_id = engine.internal_row_id_column(indexed)
        assert isinstance(row_id, str)
        page = engine.page(
            ascending,
            0,
            10,
            total_rows=None,
            column_projection=[(0, "name-id")],
        )
        assert [row["values"][0]["display"] for row in page["rows"]] == [
            "ALPHA",
            "Beta",
            "Beta",
            "alpha",
            "ÄLPHA",
        ]
        identities = [row["id"] for row in page["rows"]]
        assert len(identities) == len(set(identities)) == 5
        assert page["totalRows"] == 5
    finally:
        engine.close()


def test_owned_source_pages_use_progressive_offset_without_inventing_a_total(
    sample_frame: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine, indexed = _open_engine(sample_frame, "bounded-source-page")
    dataframe_type = type(indexed)

    original_offset = dataframe_type.offset
    offsets: list[int] = []

    def observed_offset(frame: Any, value: int) -> Any:
        offsets.append(value)
        return original_offset(frame, value)

    try:
        with monkeypatch.context() as page_patch:
            page_patch.setattr(dataframe_type, "offset", observed_offset)
            first_page = engine.page(
                indexed,
                0,
                2,
                total_rows=None,
                column_projection=[(0, "name-id")],
            )
            page = engine.page(
                indexed,
                2,
                2,
                total_rows=None,
                column_projection=[(0, "name-id")],
            )
        assert offsets == [0, 1]
        assert [row["rowNumber"] for row in first_page["rows"]] == [0, 1]
        assert [row["rowNumber"] for row in page["rows"]] == [2, 3]
        assert page["totalRows"] is None
        assert page["hasMore"] is True
        assert len({row["id"] for row in page["rows"]}) == 2
    finally:
        engine.close()


def test_projected_progressive_paging_filters_sorts_and_profiles_are_native_and_bounded(
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
        assert shape == {"rows": None, "columns": 5}
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

        first_page = engine.page(
            indexed,
            0,
            2,
            total_rows=shape["rows"],
            column_projection=[(1, "amount-id"), (0, "name-id")],
        )
        page = engine.page(
            indexed,
            2,
            2,
            total_rows=shape["rows"],
            column_projection=[(1, "amount-id"), (0, "name-id")],
        )
        assert page["totalRows"] is None
        assert page["hasMore"] is True
        assert page["columnIds"] == ["amount-id", "name-id"]
        assert [row["rowNumber"] for row in first_page["rows"]] == [0, 1]
        assert [row["rowNumber"] for row in page["rows"]] == [2, 3]
        full_page = engine.page(
            indexed,
            0,
            10,
            total_rows=shape["rows"],
            column_projection=[(1, "amount-id"), (0, "name-id")],
        )
        assert full_page["totalRows"] == 5
        assert "hasMore" not in full_page
        assert first_page["rows"] == full_page["rows"][:2]
        assert page["rows"] == [
            {**row, "rowNumber": position} for position, row in enumerate(full_page["rows"][2:4], start=2)
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
        assert text_shape["rows"] is None
        text_page = engine.page(
            text_view,
            0,
            10,
            total_rows=text_shape["rows"],
            column_projection=[(0, "name-id")],
        )
        assert text_page["totalRows"] == 2
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
        assert sorted_page["totalRows"] == 3
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
        assert collected_projections.count(("count", "__ow_value")) == 0
        assert collected_projections.count(("count", "__ow_value", "__ow_profile_total_bytes")) == 2
        assert all("__ow_group_key" not in projection for projection in collected_projections)
    finally:
        engine.close()

    # The adapter owns only its indexed cached child, never the user's session.
    assert spark_session.range(1).count() == 1


def test_partitioned_skewed_frame_keeps_native_progressive_paging_multi_sort_and_cleanup(
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
        assert engine.shape(indexed) == {"rows": None, "columns": 3}
        with pytest.raises(EngineError, match="requested contiguously"):
            engine.page(
                indexed,
                row_count - 12,
                20,
                total_rows=None,
                column_projection=[(0, "record-id"), (1, "segment-id")],
            )
        with pytest.raises(EngineError, match="requested contiguously"):
            engine.page(
                indexed,
                row_count - 12,
                20,
                total_rows=row_count,
                column_projection=[(0, "record-id"), (1, "segment-id")],
            )
        first_source_page = engine.page(
            indexed,
            0,
            20,
            total_rows=None,
            column_projection=[(0, "record-id"), (1, "segment-id")],
        )
        second_source_page = engine.page(
            indexed,
            20,
            20,
            total_rows=None,
            column_projection=[(0, "record-id"), (1, "segment-id")],
        )
        assert first_source_page["columnIds"] == ["record-id", "segment-id"]
        assert [row["rowNumber"] for row in first_source_page["rows"]] == list(range(20))
        assert [row["rowNumber"] for row in second_source_page["rows"]] == list(range(20, 40))
        assert len({row["id"] for row in [*first_source_page["rows"], *second_source_page["rows"]]}) == 40
        assert first_source_page["totalRows"] is None
        assert second_source_page["totalRows"] is None

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
        assert engine.shape(view) == {"rows": None, "columns": 3}

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
            total_rows=None,
            column_projection=[(0, "record-id")],
        )
        second_page = engine.page(
            view,
            5,
            5,
            total_rows=None,
            column_projection=[(0, "record-id")],
        )
        assert [row["values"][0]["raw"] for row in first_page["rows"]] == expected_ids[:5]
        assert [row["values"][0]["raw"] for row in second_page["rows"]] == expected_ids[5:10]
        assert first_page["totalRows"] is None
        assert first_page["hasMore"] is True
        assert second_page["totalRows"] is None
        assert second_page["hasMore"] is True

        score_summary = engine.summaries(view, [(2, "score-id")])[0]
        assert score_summary["totalCount"] == hot_row_count
        assert score_summary["nullCount"] == 200
        assert score_summary["numeric"]["min"] == 0.0
        assert score_summary["numeric"]["max"] == 999.0
    finally:
        engine.close()

    # Closing Open Wrangler releases only its logical child, not the user's
    # Classic or Connect Spark session.
    assert spark_session.range(1).count() == 1
