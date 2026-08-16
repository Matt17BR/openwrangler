from __future__ import annotations

import json
from typing import Any

import duckdb
import pytest
from test_duckdb_engine import install_conversion_guards

import openwrangler_runtime.engines.duckdb_engine as duckdb_runtime
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, allow_nan=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def test_duckdb_numeric_summary_executes_the_source_at_most_three_times(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_conversion_guards(monkeypatch)
    engine = DuckDBEngine()
    frame = engine.normalize(
        duckdb.sql(
            """
            SELECT * FROM (VALUES
                (-1.0::DOUBLE),
                (0.0::DOUBLE),
                (1.0::DOUBLE),
                (2.0::DOUBLE),
                (NULL::DOUBLE),
                ('NaN'::DOUBLE)
            ) AS source(value)
            """
        )
    )
    executions: list[tuple[Any, str, str]] = []
    native_execute_rows = duckdb_runtime._execute_rows
    native_execute_scalar = duckdb_runtime._execute_scalar

    def capture_rows(connection: Any, source_sql: str, query: str) -> list[tuple[Any, ...]]:
        executions.append((connection, source_sql, query))
        return native_execute_rows(connection, source_sql, query)

    def capture_scalar(connection: Any, source_sql: str, query: str) -> Any:
        executions.append((connection, source_sql, query))
        return native_execute_scalar(connection, source_sql, query)

    monkeypatch.setattr(duckdb_runtime, "_execute_rows", capture_rows)
    monkeypatch.setattr(duckdb_runtime, "_execute_scalar", capture_scalar)

    try:
        summary = engine.summaries(frame, [(0, "value-id")])[0]

        assert len(executions) == 3
        assert all(connection is executions[0][0] for connection, _source_sql, _query in executions)
        assert {source_sql for _connection, source_sql, _query in executions} == {frame.sql}
        aggregate_query, top_values_query, histogram_query = [query for _connection, _source, query in executions]
        assert "stddev_samp" in aggregate_query
        assert "count(DISTINCT CAST" in aggregate_query
        assert "GROUP BY" in top_values_query
        assert "ORDER BY value_count DESC" in top_values_query
        assert "histogram(" in histogram_query
        assert sum(bin_["count"] for bin_ in summary["visualization"]["bins"]) == 4
        with engine._lifecycle_lock:
            assert engine._active_connections == set()
    finally:
        engine.close()


def test_duckdb_multicolumn_numeric_summary_fuses_fixed_aggregate_scans(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_conversion_guards(monkeypatch)
    engine = DuckDBEngine()
    frame = engine.normalize(
        duckdb.sql(
            """
            SELECT * FROM (VALUES
                (-1::HUGEINT, -1.0000::DECIMAL(18, 4), -1.0::DOUBLE),
                (0::HUGEINT, 0.0000::DECIMAL(18, 4), 0.0::DOUBLE),
                (1::HUGEINT, 1.0000::DECIMAL(18, 4), 1.0::DOUBLE),
                (2::HUGEINT, 2.0000::DECIMAL(18, 4), 2.0::DOUBLE),
                (NULL::HUGEINT, NULL::DECIMAL(18, 4), 'NaN'::DOUBLE)
            ) AS source(wide, amount, floating)
            """
        )
    )
    executions: list[tuple[Any, str, str]] = []
    native_execute_rows = duckdb_runtime._execute_rows

    def capture_rows(connection: Any, source_sql: str, query: str) -> list[tuple[Any, ...]]:
        executions.append((connection, source_sql, query))
        return native_execute_rows(connection, source_sql, query)

    monkeypatch.setattr(duckdb_runtime, "_execute_rows", capture_rows)

    try:
        summaries = engine.summaries(
            frame,
            [(0, "wide-id"), (1, "amount-id"), (2, "floating-id")],
        )

        assert len(executions) == 7
        assert all(connection is executions[0][0] for connection, _source_sql, _query in executions)
        assert {source_sql for _connection, source_sql, _query in executions} == {frame.sql}
        *profile_queries, histogram_query = [query for _connection, _source, query in executions]
        aggregate_queries = profile_queries[::2]
        top_values_queries = profile_queries[1::2]
        assert len(aggregate_queries) == 3
        assert all(
            query.count("stddev_samp") == 1 and query.count("median(") == 1 and query.count("count(DISTINCT CAST") == 1
            for query in aggregate_queries
        )
        assert len(top_values_queries) == 3
        assert all("GROUP BY" in query and "ORDER BY value_count DESC" in query for query in top_values_queries)
        assert histogram_query.count("histogram(") == 3
        assert "count(*) FILTER" not in histogram_query
        assert [summary["columnId"] for summary in summaries] == ["wide-id", "amount-id", "floating-id"]
        assert [sum(bin_["count"] for bin_ in summary["visualization"]["bins"]) for summary in summaries] == [
            4,
            4,
            4,
        ]
        with engine._lifecycle_lock:
            assert engine._active_connections == set()
    finally:
        engine.close()


def test_duckdb_fused_profiles_preserve_numeric_and_temporal_payload_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_conversion_guards(monkeypatch)
    engine = DuckDBEngine()
    numeric_frame = duckdb.sql(
        """
        SELECT * FROM (VALUES
            (-1::HUGEINT, -1.0000::DECIMAL(18, 4), -1::DOUBLE),
            (0::HUGEINT, 0.0000::DECIMAL(18, 4), 0::DOUBLE),
            (1::HUGEINT, 1.0000::DECIMAL(18, 4), 1::DOUBLE),
            (NULL::HUGEINT, NULL::DECIMAL(18, 4), 'NaN'::DOUBLE),
            (NULL::HUGEINT, NULL::DECIMAL(18, 4), NULL::DOUBLE)
        ) AS source(wide, amount, floating)
        """
    )
    infinity_frame = duckdb.sql(
        "SELECT * FROM (VALUES ('Infinity'::DOUBLE), ('NaN'::DOUBLE), (NULL::DOUBLE)) AS source(floating)"
    )
    temporal_frame = duckdb.sql(
        """
        SELECT * FROM (VALUES
            (TIMESTAMPTZ '2026-01-01 01:30:00+02:00', DATE '2025-12-31'),
            (TIMESTAMPTZ '2025-12-31 23:30:00+00:00', DATE '2026-01-01'),
            (TIMESTAMPTZ '2026-01-02 02:00:00+02:00', DATE '2026-01-01'),
            (TIMESTAMPTZ '2026-01-02 00:00:00+00:00', DATE '2026-01-02'),
            (NULL::TIMESTAMPTZ, NULL::DATE)
        ) AS source(occurred_at, day)
        """
    )
    expected_numeric = [
        {
            "column": "wide",
            "columnId": "wide-id",
            "distinctCount": 3,
            "nanCount": 0,
            "nullCount": 2,
            "numeric": {
                "exactMax": {
                    "display": "1",
                    "isNaN": False,
                    "isNull": False,
                    "kind": "integer",
                    "raw": 1,
                },
                "exactMin": {
                    "display": "-1",
                    "isNaN": False,
                    "isNull": False,
                    "kind": "integer",
                    "raw": -1,
                },
                "max": 1.0,
                "mean": 0.0,
                "median": 0.0,
                "min": -1.0,
                "std": 1.0,
            },
            "rawType": "HUGEINT",
            "topValues": [
                {"count": 1, "value": "-1"},
                {"count": 1, "value": "0"},
                {"count": 1, "value": "1"},
            ],
            "totalCount": 5,
            "type": "integer",
            "visualization": {
                "bins": [
                    {"count": 1, "max": -0.3333333333333334, "min": -1.0},
                    {"count": 1, "max": 0.33333333333333326, "min": -0.3333333333333334},
                    {"count": 1, "max": 1.0, "min": 0.33333333333333326},
                ],
                "kind": "numeric",
            },
        },
        {
            "column": "amount",
            "columnId": "amount-id",
            "distinctCount": 3,
            "nanCount": 0,
            "nullCount": 2,
            "numeric": {
                "exactMax": {
                    "display": "1.0000",
                    "isNaN": False,
                    "isNull": False,
                    "kind": "decimal",
                    "raw": "1.0000",
                },
                "exactMin": {
                    "display": "-1.0000",
                    "isNaN": False,
                    "isNull": False,
                    "kind": "decimal",
                    "raw": "-1.0000",
                },
                "max": 1.0,
                "mean": 0.0,
                "median": 0.0,
                "min": -1.0,
                "std": 1.0,
            },
            "rawType": "DECIMAL(18,4)",
            "topValues": [
                {"count": 1, "value": "-1.0000"},
                {"count": 1, "value": "0.0000"},
                {"count": 1, "value": "1.0000"},
            ],
            "totalCount": 5,
            "type": "decimal",
            "visualization": {
                "bins": [
                    {"count": 1, "max": -0.3333333333333334, "min": -1.0},
                    {"count": 1, "max": 0.33333333333333326, "min": -0.3333333333333334},
                    {"count": 1, "max": 1.0, "min": 0.33333333333333326},
                ],
                "kind": "numeric",
            },
        },
        {
            "column": "floating",
            "columnId": "float-id",
            "distinctCount": 3,
            "nanCount": 1,
            "nullCount": 1,
            "numeric": {"max": 1.0, "mean": 0.0, "median": 0.0, "min": -1.0, "std": 1.0},
            "rawType": "DOUBLE",
            "topValues": [
                {"count": 1, "value": "-1.0"},
                {"count": 1, "value": "0.0"},
                {"count": 1, "value": "1.0"},
            ],
            "totalCount": 5,
            "type": "float",
            "visualization": {
                "bins": [
                    {"count": 1, "max": -0.3333333333333334, "min": -1.0},
                    {"count": 1, "max": 0.33333333333333326, "min": -0.3333333333333334},
                    {"count": 1, "max": 1.0, "min": 0.33333333333333326},
                ],
                "kind": "numeric",
            },
        },
    ]
    expected_infinity = [
        {
            "column": "floating",
            "columnId": "infinity-id",
            "distinctCount": 1,
            "nanCount": 1,
            "nullCount": 1,
            "numeric": {},
            "rawType": "DOUBLE",
            "topValues": [{"count": 1, "value": "Infinity"}],
            "totalCount": 3,
            "type": "float",
            "visualization": {"bins": [], "kind": "numeric"},
        }
    ]
    expected_temporal = [
        {
            "column": "occurred_at",
            "columnId": "temporal-0",
            "distinctCount": 2,
            "nanCount": 0,
            "nullCount": 1,
            "rawType": "TIMESTAMP WITH TIME ZONE",
            "topValues": [
                {"count": 2, "value": "2025-12-31T23:30:00+00:00"},
                {"count": 2, "value": "2026-01-02T00:00:00+00:00"},
            ],
            "totalCount": 5,
            "type": "datetime",
            "visualization": {
                "kind": "datetime",
                "max": "2026-01-02 00:00:00+00:00",
                "min": "2025-12-31 23:30:00+00:00",
            },
        },
        {
            "column": "day",
            "columnId": "temporal-1",
            "distinctCount": 3,
            "nanCount": 0,
            "nullCount": 1,
            "rawType": "DATE",
            "topValues": [
                {"count": 2, "value": "2026-01-01"},
                {"count": 1, "value": "2025-12-31"},
                {"count": 1, "value": "2026-01-02"},
            ],
            "totalCount": 5,
            "type": "date",
            "visualization": {"kind": "datetime", "max": "2026-01-02", "min": "2025-12-31"},
        },
    ]

    try:
        actual_numeric = engine.summaries(
            numeric_frame,
            [(0, "wide-id"), (1, "amount-id"), (2, "float-id")],
        )
        actual_infinity = engine.summaries(infinity_frame, [(0, "infinity-id")])
        actual_temporal = engine.summaries(
            temporal_frame,
            [(0, "temporal-0"), (1, "temporal-1")],
        )

        assert canonical_json_bytes(actual_numeric) == canonical_json_bytes(expected_numeric)
        assert canonical_json_bytes(actual_infinity) == canonical_json_bytes(expected_infinity)
        assert canonical_json_bytes(actual_temporal) == canonical_json_bytes(expected_temporal)
    finally:
        engine.close()
