from __future__ import annotations

import json
import os
import weakref
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from math import isnan
from pathlib import Path
from threading import Event
from typing import Any

import duckdb
import pytest

import __main__
import openwrangler_runtime.engines.duckdb_engine as duckdb_runtime
from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines.base import EngineError, typed_selection_value
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine, DuckDBNotebookPlan, DuckDBSqlPlan
from openwrangler_runtime.engines.registry import EngineRegistry
from openwrangler_runtime.export_target import _regular_file_identity
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import operation_catalog, validate_step
from openwrangler_runtime.session import SessionManager


def step(kind: str, **params: Any) -> dict[str, Any]:
    return validate_step({"id": f"duckdb-{kind}", "kind": kind, "params": params})


def bound_ref(identifier: str, name: str, position: int) -> dict[str, str | int]:
    return {"id": identifier, "name": name, "position": position}


def bound_step(kind: str, **params: Any) -> dict[str, Any]:
    return {"id": f"duckdb-{kind}", "kind": kind, "params": params}


def export_options(format_name: str) -> dict[str, object]:
    return (
        {"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": "utf-8", "header": True}
        if format_name == "csv"
        else {"format": "parquet"}
    )


def source_relation() -> Any:
    return duckdb.sql(
        """
        SELECT * FROM (VALUES
            ('a', ' alpha-one ', 'red|blue', CAST(1.2 AS DOUBLE), 2, '2024-01-02'),
            ('a', 'BETA-two', 'blue', CAST(2.8 AS DOUBLE), 3, '2024-02-03'),
            ('b', NULL, NULL, CAST(NULL AS DOUBLE), 4, '2024-03-04'),
            ('b', 'alpha-one', 'red', CAST(2.8 AS DOUBLE), 3, '2024-02-03')
        ) AS source("group", "text", "tags", "value", "other", "date")
        """
    )


def reserve_export_target(path: Path) -> dict[str, str]:
    path.touch(exist_ok=False)
    device, inode = _regular_file_identity(path)
    return {"device": str(device), "inode": str(inode)}


def rows(frame: Any) -> list[tuple[Any, ...]]:
    if not isinstance(frame, DuckDBSqlPlan):
        return list(frame.fetchall())
    connection = duckdb.connect(
        config={
            "autoinstall_known_extensions": False,
            "autoload_known_extensions": False,
            "enable_external_file_cache": False,
        }
    )
    try:
        return list(connection.execute(frame.sql).fetchall())
    finally:
        connection.close()


def records(frame: Any) -> list[dict[str, Any]]:
    return [dict(zip(frame.columns, row, strict=True)) for row in rows(frame)]


def assert_same_relation(left: Any, right: Any) -> None:
    assert list(left.columns) == list(right.columns)
    left_rows = rows(left)
    right_rows = rows(right)
    assert len(left_rows) == len(right_rows)
    for left_row, right_row in zip(left_rows, right_rows, strict=True):
        assert len(left_row) == len(right_row)
        for left_value, right_value in zip(left_row, right_row, strict=True):
            if isinstance(left_value, float) and isnan(left_value):
                assert isinstance(right_value, float) and isnan(right_value)
            else:
                assert left_value == right_value


def reference_header_stats(engine: DuckDBEngine, frame: Any) -> dict[str, Any]:
    """Preserve the former two-query dataset-statistics semantics for comparison."""

    plan = engine.normalize(frame)
    visible = engine._visible_columns(plan)
    types = dict(zip(engine._columns(plan), (str(item) for item in plan.types), strict=True))
    missing_expressions = [
        f"({duckdb_runtime._quote_ident(column)} IS NULL OR "
        f"{duckdb_runtime._nan_predicate(duckdb_runtime._quote_ident(column), types[column])})"
        for column in visible
    ]
    projections = ", ".join(f"count(*) FILTER (WHERE {expression})" for expression in missing_expressions)
    missing_row_expression = " OR ".join(missing_expressions)
    group_columns = ", ".join(duckdb_runtime._quote_ident(column) for column in visible)
    with engine._terminal_connection(plan) as (connection, source_sql):
        counts = duckdb_runtime._execute_rows(
            connection,
            source_sql,
            f"SELECT {projections}, count(*) FILTER (WHERE {missing_row_expression}) FROM ow",
        )[0]
        duplicate_rows = int(
            duckdb_runtime._execute_scalar(
                connection,
                source_sql,
                "SELECT coalesce(sum(group_count - 1), 0) FROM "
                f"(SELECT count(*) AS group_count FROM ow GROUP BY {group_columns}) AS groups",
            )
            or 0
        )
    per_column = [int(value or 0) for value in counts[:-1]]
    return {
        "missingCells": sum(per_column),
        "missingRows": int(counts[-1] or 0),
        "duplicateRows": duplicate_rows,
        "missingValuesByColumn": [
            {"column": column, "count": count} for column, count in zip(visible, per_column, strict=True)
        ],
    }


def execute_generated(engine: DuckDBEngine, frame: Any, plan: list[dict[str, Any]]) -> Any:
    code = engine.compile_plan(plan)
    assert "openwrangler_runtime" not in code
    namespace: dict[str, Any] = {}
    exec(compile(code, "<generated-duckdb-plan>", "exec"), namespace, namespace)
    result = namespace["clean_data"](frame)
    assert isinstance(result, duckdb.DuckDBPyRelation)
    return result


@pytest.mark.parametrize(
    ("dtype", "source_expression", "expected_type", "expected_value"),
    [
        ("string", "42::INTEGER", "VARCHAR", "42"),
        ("integer", "'42'::VARCHAR", "BIGINT", 42),
        ("float", "1.25::ow_cast_source", "DOUBLE", 1.25),
        ("boolean", "'true'::VARCHAR", "BOOLEAN", True),
        ("date", "'2024-01-02'::VARCHAR", "DATE", date(2024, 1, 2)),
        (
            "datetime",
            "'2024-01-02 03:04:05'::VARCHAR",
            "TIMESTAMP",
            datetime(2024, 1, 2, 3, 4, 5),
        ),
    ],
)
def test_duckdb_cast_targets_match_live_and_generated_code(
    dtype: str,
    source_expression: str,
    expected_type: str,
    expected_value: Any,
) -> None:
    engine = DuckDBEngine()
    source = None
    live = None
    generated = None

    try:
        duckdb.execute("CREATE TYPE ow_cast_source AS DECIMAL(9, 2)")
        source = duckdb.sql(f'SELECT {source_expression} AS "source""value"')
        operation = bound_step(
            "castColumn",
            column=bound_ref("c:source:0", 'source"value', 0),
            dtype=dtype,
        )
        live = engine.apply_transform(engine.normalize_notebook_relation(source), operation)
        generated = execute_generated(engine, source, [operation])

        assert live.types == [expected_type]
        assert [str(item) for item in generated.types] == [expected_type]
        assert engine._terminal_rows(live, "SELECT * FROM ow") == [(expected_value,)]
        assert generated.fetchall() == [(expected_value,)]
    finally:
        source = None
        live = None
        generated = None
        try:
            engine.close()
        finally:
            duckdb.execute("DROP TYPE IF EXISTS ow_cast_source")


def test_duckdb_rename_only_generated_code_matches_live_with_quoted_names() -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql('SELECT 1 AS "source""one", 2 AS "source""two"')
    plan = [
        bound_step(
            "renameColumn",
            column=bound_ref("c:source:0", 'source"one', 0),
            newName='renamed"one',
        ),
        bound_step(
            "renameColumn",
            column=bound_ref("c:source:1", 'source"two', 1),
            newName='renamed"two',
        ),
    ]

    try:
        live = frame
        for operation in plan:
            live = engine.apply_transform(live, operation)

        code = engine.compile_plan(plan)
        generated = execute_generated(engine, frame, plan)

        assert_same_relation(live, generated)
        assert "_ow_pivot_wider" not in code
    finally:
        engine.close()


def test_duckdb_generated_code_emits_only_reachable_helpers() -> None:
    engine = DuckDBEngine()
    plain_plan = [
        bound_step(
            "upperText",
            column=bound_ref("c:source:1", "text", 1),
            newColumn="upper_text",
        )
    ]
    categorical_plans = [
        [
            bound_step(
                "oneHotEncode",
                columns=[bound_ref("c:source:0", "group", 0)],
                prefixSeparator="_",
                dropOriginal=True,
            )
        ],
        [
            bound_step(
                "multiLabelBinarize",
                column=bound_ref("c:source:2", "tags", 2),
                delimiter="|",
                prefix="tag_",
                dropOriginal=False,
            )
        ],
    ]

    try:
        assert engine.compile_plan([]) == "def clean_data(df):\n    return df\n"
        plain_code = engine.compile_plan(plain_plan)
        assert "from collections import Counter" not in plain_code
        assert plain_code.startswith("import math")
        assert "def _ow_text(" in plain_code
        assert "def _ow_assign(" in plain_code
        assert "def _ow_query(" in plain_code
        assert "def _ow_fill_missing(" not in plain_code
        assert "def _ow_group_by(" not in plain_code
        assert "def _ow_pivot_wider(" not in plain_code
        assert_same_relation(
            engine.apply_transform(source_relation(), plain_plan[0]),
            execute_generated(engine, source_relation(), plain_plan),
        )
        for plan in categorical_plans:
            code = engine.compile_plan(plan)
            assert "from collections import Counter" in code
            assert "def _ow_pivot_wider(" not in code
            assert_same_relation(
                engine.apply_transform(source_relation(), plan[0]),
                execute_generated(engine, source_relation(), plan),
            )
    finally:
        engine.close()


def test_duckdb_generated_helper_reachability_preserves_decorated_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = """import math as numbers
from functools import wraps as copy_metadata
DEFAULT = 2.75

def decorate(function):
    @copy_metadata(function)
    def wrapped(value: float = DEFAULT) -> float:
        return function(value) + 1
    return wrapped

@decorate
def helper(value: float = DEFAULT) -> float:
    return numbers.floor(value)
"""
    monkeypatch.setattr(duckdb_runtime, "_generated_helper_source", lambda: source)
    duckdb_runtime._generated_helper_catalog.cache_clear()
    try:
        selected = duckdb_runtime._reachable_generated_helper_source("def clean_data(df):\n    return helper()\n")
        namespace: dict[str, Any] = {}
        exec(selected, namespace)

        assert selected.index("import math as numbers") < selected.index("@decorate")
        assert "from functools import wraps as copy_metadata" in selected
        assert "DEFAULT = 2.75" in selected
        assert "@copy_metadata(function)" in selected
        assert namespace["helper"]() == 3
        assert namespace["helper"].__name__ == "helper"
    finally:
        duckdb_runtime._generated_helper_catalog.cache_clear()


@pytest.mark.parametrize(
    "source",
    [
        "import math as duplicate, cmath as duplicate\n",
        "import math as duplicate\nimport cmath as duplicate\n",
        "from math import *\n",
        "from __future__ import annotations\n",
        "FIRST, SECOND = (1, 2)\n",
        "VALUE: int = 1\n",
        "class Helper:\n    pass\n",
        "async def helper():\n    return None\n",
    ],
)
def test_duckdb_generated_helper_catalog_rejects_unsupported_source(
    monkeypatch: pytest.MonkeyPatch,
    source: str,
) -> None:
    monkeypatch.setattr(duckdb_runtime, "_generated_helper_source", lambda: source)
    duckdb_runtime._generated_helper_catalog.cache_clear()
    try:
        with pytest.raises(RuntimeError):
            duckdb_runtime._generated_helper_catalog()
    finally:
        duckdb_runtime._generated_helper_catalog.cache_clear()


@pytest.mark.parametrize(
    "operation",
    [
        step("oneHotEncode", columns=[{"id": "c:source:0", "name": "group"}]),
        step("upperText", column={"id": "c:source:1", "name": "text"}),
        step("roundNumber", column={"id": "c:source:3", "name": "value"}),
        step("formatDatetime", column={"id": "c:source:5", "name": "date"}, format="%Y"),
    ],
)
def test_duckdb_value_adapters_reject_unbound_public_references(operation: dict[str, Any]) -> None:
    engine = DuckDBEngine()
    try:
        with pytest.raises(EngineError, match="requires a bound column reference"):
            engine.apply_transform(source_relation(), operation)
        with pytest.raises(EngineError, match="requires a bound column reference"):
            engine.compile_plan([operation])
    finally:
        engine.close()


@pytest.mark.parametrize(
    ("replacement", "expected"),
    [
        ("\\", ["\\a\\b\\", "\\", None, "\\é\\🙂\\"]),
        (r"\1", [r"\1a\1b\1", r"\1", None, r"\1é\1🙂\1"]),
        ("$1", ["$1a$1b$1", "$1", None, "$1é$1🙂$1"]),
    ],
)
def test_duckdb_empty_literal_find_replaces_boundaries_and_matches_generated_code(
    replacement: str, expected: list[str | None]
) -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql("SELECT * FROM (VALUES ('ab'), (''), (NULL), ('é🙂')) AS source(text)")
    operation = bound_step(
        "findReplace",
        column=bound_ref("c:source:0", "text", 0),
        find="",
        replacement=replacement,
        regex=False,
        newColumn="expanded",
    )

    try:
        transformed = engine.apply_transform(frame, operation)
        generated = execute_generated(engine, frame, [operation])

        assert [row["expanded"] for row in records(transformed)] == expected
        assert_same_relation(transformed, generated)
        assert "array_to_string" in engine.compile_plan([operation])
    finally:
        engine.close()


def install_conversion_guards(monkeypatch: pytest.MonkeyPatch) -> None:
    def reject_conversion(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("DuckDB operations must never convert to Pandas, Polars, or Arrow")

    for method in ("df", "to_df", "fetchdf", "pl", "arrow"):
        monkeypatch.setattr(duckdb.DuckDBPyRelation, method, reject_conversion)


def test_duckdb_rejects_case_fold_ambiguous_source_columns() -> None:
    engine = DuckDBEngine()
    ambiguous = duckdb.sql('SELECT 1 AS "A", 2 AS "a"')

    with pytest.raises(EngineError, match="differ only by case"):
        engine.validate_column_addressability(ambiguous)


def test_duckdb_page_uses_an_explicit_terminal_projection(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = DuckDBEngine()
    frame = engine.ensure_row_ids(source_relation(), "projected-page")
    queries: list[str] = []
    terminal_timezones: list[str] = []
    native_execute_rows = duckdb_runtime._execute_rows

    def capture_query(connection: Any, source_sql: str, query: str) -> list[tuple[Any, ...]]:
        queries.append(query)
        terminal_timezones.append(str(connection.execute("SELECT current_setting('TimeZone')").fetchone()[0]))
        return native_execute_rows(connection, source_sql, query)

    monkeypatch.setattr(duckdb_runtime, "_execute_rows", capture_query)

    page = engine.page(
        frame,
        0,
        2,
        total_rows=4,
        column_projection=[(1, "stable:text"), (4, "stable:other")],
    )

    assert len(queries) == 1
    assert queries[0].startswith("SELECT ")
    assert "SELECT *" not in queries[0].upper()
    assert '"text"' in queries[0] and '"other"' in queries[0]
    assert '"group"' not in queries[0] and '"value"' not in queries[0]
    assert page["columnIds"] == ["stable:text", "stable:other"]
    assert [cell["display"] for cell in page["rows"][0]["values"]] == [" alpha-one ", "2"]
    assert terminal_timezones == ["UTC"]


@pytest.mark.parametrize(
    ("source_sql", "expected_counts"),
    [
        pytest.param(
            """
            SELECT * FROM (VALUES
                (1::BIGINT, 1.25::DECIMAL(10, 2), 1.0::DOUBLE),
                (1::BIGINT, 1.25::DECIMAL(10, 2), 1.0::DOUBLE),
                (NULL::BIGINT, NULL::DECIMAL(10, 2), NULL::DOUBLE),
                (2::BIGINT, 2.50::DECIMAL(10, 2), 'NaN'::DOUBLE),
                (2::BIGINT, 2.50::DECIMAL(10, 2), 'NaN'::DOUBLE),
                (3::BIGINT, 3.75::DECIMAL(10, 2), 'Infinity'::DOUBLE),
                (3::BIGINT, 3.75::DECIMAL(10, 2), 'Infinity'::DOUBLE),
                (4::BIGINT, 4.00::DECIMAL(10, 2), '-Infinity'::DOUBLE),
                (4::BIGINT, 4.00::DECIMAL(10, 2), '-Infinity'::DOUBLE),
                (5::BIGINT, 5.00::DECIMAL(10, 2), -0.0::DOUBLE),
                (5::BIGINT, 5.00::DECIMAL(10, 2), 0.0::DOUBLE)
            ) AS source(integer_value, decimal_value, float_value)
            """,
            {"missingCells": 5, "missingRows": 3, "duplicateRows": 5},
            id="numeric-null-nan-infinity-signed-zero-decimal",
        ),
        pytest.param(
            """
            SELECT * FROM (VALUES
                (DATE '2024-03-31', TIMESTAMP '2024-03-31 01:30:00',
                    TIMESTAMPTZ '2024-03-31 01:30:00+01:00'),
                (DATE '2024-03-31', TIMESTAMP '2024-03-31 01:30:00',
                    TIMESTAMPTZ '2024-03-31 00:30:00+00:00'),
                (NULL::DATE, NULL::TIMESTAMP, NULL::TIMESTAMPTZ),
                (NULL::DATE, NULL::TIMESTAMP, NULL::TIMESTAMPTZ)
            ) AS source(date_value, timestamp_value, zoned_value)
            """,
            {"missingCells": 6, "missingRows": 2, "duplicateRows": 2},
            id="date-timestamp-utc-normalization",
        ),
    ],
)
def test_duckdb_header_stats_use_one_source_execution_with_exact_existing_semantics(
    monkeypatch: pytest.MonkeyPatch,
    source_sql: str,
    expected_counts: dict[str, int],
) -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql(source_sql)
    reference = reference_header_stats(engine, frame)
    row_queries: list[str] = []
    scalar_queries: list[str] = []
    terminal_threads: list[int] = []
    native_execute_rows = duckdb_runtime._execute_rows
    native_execute_scalar = duckdb_runtime._execute_scalar

    def capture_rows(connection: Any, plan_sql: str, query: str) -> list[tuple[Any, ...]]:
        row_queries.append(query)
        terminal_threads.append(int(connection.execute("SELECT current_setting('threads')").fetchone()[0]))
        return native_execute_rows(connection, plan_sql, query)

    def capture_scalar(connection: Any, plan_sql: str, query: str) -> Any:
        scalar_queries.append(query)
        return native_execute_scalar(connection, plan_sql, query)

    monkeypatch.setattr(duckdb_runtime, "_execute_rows", capture_rows)
    monkeypatch.setattr(duckdb_runtime, "_execute_scalar", capture_scalar)
    try:
        actual = engine.header_stats(frame)
    finally:
        engine.close()

    assert actual == reference
    assert {key: actual[key] for key in expected_counts} == expected_counts
    assert json.dumps(actual, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    ) == json.dumps(reference, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    )
    assert len(row_queries) == 1
    assert scalar_queries == []
    assert terminal_threads == [1]
    assert "GROUP BY" in row_queries[0]


def test_duckdb_header_stats_thread_pin_is_request_local_and_connection_closes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = DuckDBEngine()
    frame = engine.normalize(
        duckdb.sql("SELECT * FROM (VALUES (1, NULL::DOUBLE), (1, 'NaN'::DOUBLE)) AS source(key, value)")
    )
    native_connect = duckdb_runtime._connect
    connections: list[Any] = []
    set_queries: list[str] = []
    observed_threads: list[int] = []

    class TrackedConnection:
        def __init__(self) -> None:
            self.inner = native_connect()
            self.closed = False
            connections.append(self)

        def execute(self, query: str, *args: Any, **kwargs: Any) -> Any:
            if query.strip().casefold() == "set threads = 1":
                set_queries.append(query)
            result = self.inner.execute(query, *args, **kwargs)
            if query.strip().casefold() == "set threads = 1":
                observed_threads.append(int(self.inner.execute("SELECT current_setting('threads')").fetchone()[0]))
            return result

        def close(self) -> None:
            self.inner.close()
            self.closed = True

        def __getattr__(self, name: str) -> Any:
            return getattr(self.inner, name)

    monkeypatch.setattr(duckdb_runtime, "_connect", TrackedConnection)
    stats = engine.header_stats(frame)

    assert stats["missingCells"] == 2
    assert set_queries == ["SET threads = 1"]
    assert observed_threads == [1]
    assert len(connections) == 1
    assert connections[0].closed is True
    with pytest.raises(duckdb.ConnectionException, match="closed"):
        connections[0].inner.execute("SELECT 1")
    with engine._lifecycle_lock:
        assert engine._active_connections == set()
    engine.close()


def test_duckdb_notebook_header_stats_keep_two_queries_without_mutating_user_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_connection = duckdb.connect()
    relation = user_connection.sql(
        "SELECT * FROM (VALUES (1, 1.0::DOUBLE), (1, 1.0::DOUBLE), "
        "(NULL::BIGINT, 'NaN'::DOUBLE), (NULL::BIGINT, 'NaN'::DOUBLE)) AS source(key, value)"
    )
    engine = DuckDBEngine()
    frame = engine.normalize_notebook_relation(relation)
    initial_thread_row = user_connection.execute("SELECT current_setting('threads')").fetchone()
    assert initial_thread_row is not None
    initial_threads = int(initial_thread_row[0])
    row_queries: list[str] = []
    scalar_queries: list[str] = []
    terminal_statements: list[str] = []
    native_execute_rows = duckdb_runtime._execute_rows
    native_execute_scalar = duckdb_runtime._execute_scalar
    native_terminal_execute = duckdb_runtime._DuckDBNotebookTerminal.execute

    def capture_rows(connection: Any, plan_sql: str, query: str) -> list[tuple[Any, ...]]:
        row_queries.append(query)
        return native_execute_rows(connection, plan_sql, query)

    def capture_scalar(connection: Any, plan_sql: str, query: str) -> Any:
        scalar_queries.append(query)
        return native_execute_scalar(connection, plan_sql, query)

    def capture_terminal_execute(terminal: Any, query: str) -> Any:
        terminal_statements.append(query)
        return native_terminal_execute(terminal, query)

    monkeypatch.setattr(duckdb_runtime, "_execute_rows", capture_rows)
    monkeypatch.setattr(duckdb_runtime, "_execute_scalar", capture_scalar)
    monkeypatch.setattr(duckdb_runtime._DuckDBNotebookTerminal, "execute", capture_terminal_execute)
    try:
        actual = engine.header_stats(frame)
        assert actual == {
            "missingCells": 4,
            "missingRows": 2,
            "duplicateRows": 2,
            "missingValuesByColumn": [
                {"column": "key", "count": 2},
                {"column": "value", "count": 2},
            ],
        }
        assert len(row_queries) == 1
        assert len(scalar_queries) == 1
        assert len(terminal_statements) == 2
        assert all("SET threads" not in statement for statement in terminal_statements)
        current_thread_row = user_connection.execute("SELECT current_setting('threads')").fetchone()
        assert current_thread_row is not None
        assert int(current_thread_row[0]) == initial_threads
    finally:
        engine.close()
        relation = None
        assert user_connection.execute("SELECT 1").fetchone() == (1,)
        user_connection.close()


def test_duckdb_header_stats_keep_unique_wide_groups_inside_one_native_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = DuckDBEngine()
    wide_columns = ", ".join(
        f"CASE WHEN i % {modulus} = 0 THEN NULL ELSE i + {modulus} END AS value_{modulus}" for modulus in range(2, 34)
    )
    frame = duckdb.sql(
        f"SELECT i AS unique_key, {wide_columns} FROM range(2048) AS source(i), range(2) AS duplicate(copy)"
    )
    reference = reference_header_stats(engine, frame)
    row_queries: list[str] = []
    result_sizes: list[int] = []
    native_execute_rows = duckdb_runtime._execute_rows

    def capture_rows(connection: Any, plan_sql: str, query: str) -> list[tuple[Any, ...]]:
        row_queries.append(query)
        result = native_execute_rows(connection, plan_sql, query)
        result_sizes.append(len(result))
        return result

    monkeypatch.setattr(duckdb_runtime, "_execute_rows", capture_rows)
    try:
        actual = engine.header_stats(frame)
    finally:
        engine.close()

    assert actual == reference
    assert actual["duplicateRows"] == 2048
    assert json.dumps(actual, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    ) == json.dumps(reference, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    )
    assert len(row_queries) == 1
    assert result_sizes == [1]


def test_duckdb_header_stats_zero_visible_columns_use_one_count(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "empty.csv"
    source.write_bytes(b"")
    engine = DuckDBEngine()
    frame = engine.read_file(str(source))
    scalar_queries: list[str] = []
    native_execute_scalar = duckdb_runtime._execute_scalar

    def capture_scalar(connection: Any, plan_sql: str, query: str) -> Any:
        scalar_queries.append(query)
        return native_execute_scalar(connection, plan_sql, query)

    monkeypatch.setattr(duckdb_runtime, "_execute_scalar", capture_scalar)
    try:
        actual = engine.header_stats(frame)
    finally:
        engine.close()

    assert actual == {
        "missingCells": 0,
        "missingRows": 0,
        "duplicateRows": 0,
        "missingValuesByColumn": [],
    }
    assert scalar_queries == ["SELECT count(*) FROM ow"]


def test_duckdb_file_readers_are_lazy_hardened_and_export_natively(tmp_path: Path) -> None:
    csv_path = tmp_path / "sample.csv"
    csv_path.write_text('city;value\n"Milan";1\n"Berlin";2\n', encoding="utf-8")
    unicode_delimiter_path = tmp_path / "unicode-delimiter.csv"
    unicode_delimiter_path.write_text("city§value\nMilan§1\nBerlin§2\n", encoding="utf-8")
    tsv_path = tmp_path / "sample.tsv"
    tsv_path.write_text("city\tvalue\nMilan\t1\nBerlin\t2\n", encoding="utf-8")
    jsonl_path = tmp_path / "sample.jsonl"
    jsonl_path.write_text('{"city":"Milan","value":1}\n{"city":"Berlin","value":2}\n', encoding="utf-8")
    malformed_jsonl_path = tmp_path / "malformed.jsonl"
    malformed_jsonl_path.write_text('{"city":"Milan","value":1}\n{"city":\n', encoding="utf-8")
    parquet_path = tmp_path / "sample.parquet"
    duckdb.sql("SELECT * FROM (VALUES ('Milan', 1), ('Berlin', 2)) AS data(city, value)").write_parquet(
        str(parquet_path)
    )

    engine = DuckDBEngine()
    settings_connection = duckdb_runtime._connect()
    try:
        settings = settings_connection.execute(
            "SELECT current_setting('autoinstall_known_extensions'), "
            "current_setting('autoload_known_extensions'), current_setting('enable_external_file_cache'), "
            "current_setting('preserve_insertion_order'), "
            "current_setting('TimeZone')"
        ).fetchone()
        assert settings_connection.execute("FROM duckdb_external_file_cache()").fetchall() == []
    finally:
        settings_connection.close()
    assert settings == (False, False, False, True, "UTC")

    csv_frame = engine.read_file(
        str(csv_path),
        {"delimiter": ";", "encoding": "utf-8", "quoteChar": '"', "hasHeader": True},
    )
    assert isinstance(csv_frame, DuckDBSqlPlan)
    assert "read_csv" in csv_frame.sql_query().lower()
    assert engine.shape(csv_frame) == {"rows": 2, "columns": 2}
    assert rows(engine.read_file(str(unicode_delimiter_path), {"delimiter": "§"})) == [
        ("Milan", 1),
        ("Berlin", 2),
    ]
    assert rows(engine.read_file(str(tsv_path))) == [("Milan", 1), ("Berlin", 2)]
    assert rows(engine.read_file(str(jsonl_path))) == [("Milan", 1), ("Berlin", 2)]
    assert rows(engine.read_file(str(parquet_path))) == [("Milan", 1), ("Berlin", 2)]
    with pytest.raises(EngineError, match=r"newline-delimited JSON.*Malformed JSON") as malformed:
        engine.read_file(str(malformed_jsonl_path))
    assert "JSON support is unavailable" not in str(malformed.value)

    adversarial_missing_path = tmp_path / "missing" / "json extension not loaded.jsonl"
    with pytest.raises(EngineError, match="newline-delimited JSON") as adversarial_missing:
        engine.read_file(str(adversarial_missing_path))
    assert "JSON support is unavailable" not in str(adversarial_missing.value)

    adversarial_malformed_path = tmp_path / "malformed" / "json extension not loaded.jsonl"
    adversarial_malformed_path.parent.mkdir()
    adversarial_malformed_path.write_text('{"city":\n', encoding="utf-8")
    with pytest.raises(EngineError, match=r"newline-delimited JSON.*Malformed JSON") as adversarial_malformed:
        engine.read_file(str(adversarial_malformed_path))
    assert "JSON support is unavailable" not in str(adversarial_malformed.value)

    with pytest.raises(EngineError, match="does not support Excel"):
        engine.read_file(str(tmp_path / "unsupported.xlsx"))
    with pytest.raises(EngineError, match="supports UTF-8"):
        engine.read_file(str(csv_path), {"encoding": "latin-1"})

    identified = engine.ensure_row_ids(csv_frame, "export")
    csv_export = tmp_path / "cleaned.csv"
    parquet_export = tmp_path / "cleaned.parquet"
    engine.export_data(identified, str(csv_export), export_options("csv"))
    engine.export_data(identified, str(parquet_export), export_options("parquet"))
    assert duckdb.read_csv(str(csv_export)).columns == ["city", "value"]
    assert duckdb.read_parquet(str(parquet_export)).fetchall() == [("Milan", 1), ("Berlin", 2)]

    engine.close()
    engine.close()
    with pytest.raises(EngineError, match="closed"):
        engine.read_file(str(csv_path))


def test_duckdb_live_session_releases_rich_parquet_for_atomic_replacement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "replaceable.parquet"
    replacement = tmp_path / "replaceable.parquet.replacement"
    connection = duckdb.connect()
    try:
        connection.execute(
            """
            CREATE TABLE rich AS SELECT
                CAST('123456789012345678901234567890.12345678' AS DECIMAL(38,8)) AS exact_decimal,
                TIMESTAMPTZ '2026-07-16 14:30:00+02:00' AS zoned,
                [1, 2, NULL]::INTEGER[] AS items,
                {'label': 'alpha', 'score': 7} AS record
            """
        )
        connection.execute("COPY rich TO ? (FORMAT PARQUET)", [str(source)])
        connection.execute("COPY rich TO ? (FORMAT PARQUET)", [str(replacement)])
    finally:
        connection.close()

    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": source.name, "path": str(source)},
        backend="duckdb",
        page_size=200,
    )
    session_id = opened["metadata"]["sessionId"]
    try:
        session = manager.sessions[session_id]
        assert isinstance(session.engine, DuckDBEngine)
        assert isinstance(session.original, DuckDBSqlPlan)
        assert isinstance(session.committed, DuckDBSqlPlan)
        assert isinstance(session.filtered, DuckDBSqlPlan)
        assert "parquet_scan" in session.original.sql_query().lower()
        assert opened["metadata"]["shape"] == {"rows": 1, "columns": 4}
        assert opened["page"]["rows"][0]["values"][0]["raw"] == "123456789012345678901234567890.12345678"

        paged = manager.get_page(
            session_id,
            0,
            0,
            20,
            {"logic": "and", "filters": [], "sort": []},
        )
        assert paged["page"]["rows"][0]["values"][0]["raw"] == "123456789012345678901234567890.12345678"
        assert isinstance(session.filtered, DuckDBSqlPlan)

        native_execute_rows = duckdb_runtime._execute_rows
        summary_read_completed = Event()
        release_summary_connection = Event()

        def hold_completed_summary_read(connection: Any, source_sql: str, query: str) -> list[tuple[Any, ...]]:
            result = native_execute_rows(connection, source_sql, query)
            if "count(DISTINCT" in query:
                summary_read_completed.set()
                if not release_summary_connection.wait(timeout=10):
                    raise AssertionError("Timed out releasing the completed DuckDB summary read.")
            return result

        monkeypatch.setattr(duckdb_runtime, "_execute_rows", hold_completed_summary_read)
        with ThreadPoolExecutor(max_workers=2) as pool:
            summary_future = pool.submit(session.engine.summaries, session.filtered, [(0, "c:exact_decimal")])
            assert summary_read_completed.wait(timeout=10)
            with session.engine._lifecycle_lock:
                assert len(session.engine._active_connections) == 1
            page_future = pool.submit(session.engine.page, session.filtered, 0, 20, total_rows=1)
            try:
                concurrent_page = page_future.result(timeout=10)
                assert concurrent_page["rows"][0]["values"][0]["raw"] == ("123456789012345678901234567890.12345678")
                with session.engine._lifecycle_lock:
                    assert len(session.engine._active_connections) == 1
            finally:
                release_summary_connection.set()
            concurrent_summary = summary_future.result(timeout=10)
        assert concurrent_summary[0]["columnId"] == "c:exact_decimal"
        with session.engine._lifecycle_lock:
            assert session.engine._active_connections == set()

        os.replace(replacement, source)
        with pytest.raises(EngineError, match="changed or is no longer available"):
            manager.get_page(
                session_id,
                0,
                0,
                20,
                {"logic": "and", "filters": [], "sort": []},
            )
    finally:
        manager.close_session(session_id, 0)
        manager.close_all()


def test_duckdb_session_releases_every_temporary_relation_before_connection_close(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "detached.csv"
    source.write_text("value\n1\n2\n", encoding="utf-8")
    destination = tmp_path / "detached.parquet"
    native_connect = duckdb_runtime._connect
    native_project = duckdb.DuckDBPyRelation.project
    relation_refs: list[weakref.ReferenceType[Any]] = []
    connections: list[Any] = []

    def reject_relation_close(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("DuckDBPyRelation.close() executes an unexecuted relation")

    class TrackedConnection:
        def __init__(self) -> None:
            self.inner = native_connect()
            self.closed = False
            connections.append(self)

        def _capture(self, relation: Any) -> Any:
            relation_refs.append(weakref.ref(relation))
            return relation

        def sql(self, *args: Any, **kwargs: Any) -> Any:
            return self._capture(self.inner.sql(*args, **kwargs))

        def read_csv(self, *args: Any, **kwargs: Any) -> Any:
            return self._capture(self.inner.read_csv(*args, **kwargs))

        def read_parquet(self, *args: Any, **kwargs: Any) -> Any:
            return self._capture(self.inner.read_parquet(*args, **kwargs))

        def read_json(self, *args: Any, **kwargs: Any) -> Any:
            return self._capture(self.inner.read_json(*args, **kwargs))

        def close(self) -> None:
            self.inner.close()
            self.closed = True

        def __getattr__(self, name: str) -> Any:
            return getattr(self.inner, name)

    def tracked_connect() -> TrackedConnection:
        return TrackedConnection()

    def tracked_project(relation: Any, *args: Any, **kwargs: Any) -> Any:
        projected = native_project(relation, *args, **kwargs)
        relation_refs.append(weakref.ref(projected))
        return projected

    def assert_fully_detached() -> None:
        assert relation_refs
        assert all(reference() is None for reference in relation_refs)
        assert all(connection.closed for connection in connections)
        for connection in connections:
            with pytest.raises(duckdb.ConnectionException, match="closed"):
                connection.inner.execute("SELECT 1")

    monkeypatch.setattr(duckdb_runtime, "_connect", tracked_connect)
    monkeypatch.setattr(duckdb.DuckDBPyRelation, "close", reject_relation_close)
    monkeypatch.setattr(duckdb.DuckDBPyRelation, "project", tracked_project)

    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": source.name, "path": str(source)},
        backend="duckdb",
        page_size=2,
    )
    session_id = opened["metadata"]["sessionId"]
    try:
        session = manager.sessions[session_id]
        assert all(
            isinstance(frame, DuckDBSqlPlan) for frame in (session.original, session.committed, session.filtered)
        )
        assert_fully_detached()

        manager.get_page(
            session_id,
            0,
            0,
            20,
            {"logic": "and", "filters": [], "sort": []},
        )
        assert_fully_detached()

        operation = step("customCode", code="result = df.project('value + 1 AS value')")
        preview = manager.preview_step(session_id, 0, operation, 0, 20)
        assert preview["revision"] == 1
        assert isinstance(session.draft_frame, DuckDBSqlPlan)
        assert_fully_detached()

        applied = manager.apply_draft(session_id, 1, 0, 20)
        assert applied["revision"] == 2
        assert isinstance(session.committed, DuckDBSqlPlan)
        assert isinstance(session.filtered, DuckDBSqlPlan)
        assert_fully_detached()

        manager.export_data(
            session_id, 2, str(destination), export_options("parquet"), reserve_export_target(destination)
        )
        assert rows(duckdb.read_parquet(str(destination))) == [(2,), (3,)]
        assert_fully_detached()
    finally:
        manager.close_session(session_id, manager.sessions[session_id].revision)
        manager.close_all()


def test_duckdb_jsonl_missing_reader_retains_dependency_guidance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class MissingJsonReader:
        def read_json(self, *_args: Any, **_kwargs: Any) -> Any:
            raise duckdb.CatalogException("Catalog Error: Table Function with name read_json_auto does not exist!")

        def close(self) -> None:
            return None

    engine = DuckDBEngine()
    monkeypatch.setattr(duckdb_runtime, "_connect", MissingJsonReader)

    with pytest.raises(EngineError, match=r"JSON support is unavailable.*compatible DuckDB build"):
        engine.read_file(str(tmp_path / "sample.jsonl"))
    engine.close()


def test_duckdb_json_reader_availability_classifier_requires_anchored_duckdb_diagnostic() -> None:
    assert duckdb_runtime._json_reader_is_unavailable(
        duckdb.CatalogException("Catalog Error: Table Function with name read_json_auto does not exist!")
    )
    assert duckdb_runtime._json_reader_is_unavailable(
        duckdb.HTTPException(
            "Extension Autoloading Error: An error occurred while trying to automatically install "
            "the required extension 'json': download failed"
        )
    )

    assert not duckdb_runtime._json_reader_is_unavailable(
        RuntimeError("Catalog Error: Table Function with name read_json_auto does not exist!")
    )
    assert not duckdb_runtime._json_reader_is_unavailable(
        duckdb.IOException('IO Error: No files found that match "/tmp/json extension not loaded.jsonl"')
    )
    assert not duckdb_runtime._json_reader_is_unavailable(
        duckdb.InvalidInputException(
            "Invalid Input Error: Malformed JSON in file \"/tmp/extension 'json' not installed.jsonl\""
        )
    )


def test_duckdb_rich_parquet_is_utc_native_and_strict_json_safe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_conversion_guards(monkeypatch)
    path = tmp_path / "rich.parquet"
    writer = duckdb.connect()
    try:
        writer.execute("SET TimeZone = 'America/New_York'")
        writer.execute(
            """
            COPY (
                SELECT * FROM (VALUES
                    (
                        'match',
                        18446744073709551615::UBIGINT,
                        1.2300::DECIMAL(10, 4),
                        TIMESTAMPTZ '2026-01-01 00:30:00+01:00',
                        INTERVAL '93784 seconds',
                        from_hex('00ff'),
                        [1, 2]::INTEGER[],
                        {'label': 'é🙂', 'score': 7},
                        'Infinity'::DOUBLE
                    ),
                    (
                        'other',
                        7::UBIGINT,
                        2.5000::DECIMAL(10, 4),
                        TIMESTAMPTZ '2026-01-02 10:00:00+00:00',
                        INTERVAL '0 seconds',
                        from_hex('61'),
                        [3]::INTEGER[],
                        {'label': 'x', 'score': 8},
                        'NaN'::DOUBLE
                    ),
                    (
                        'missing',
                        NULL::UBIGINT,
                        NULL::DECIMAL(10, 4),
                        NULL::TIMESTAMPTZ,
                        NULL::INTERVAL,
                        NULL::BLOB,
                        NULL::INTEGER[],
                        NULL::STRUCT(label VARCHAR, score INTEGER),
                        NULL::DOUBLE
                    )
                ) AS rich(label, huge, amount, occurred_at, elapsed, payload, items, record, floating)
            ) TO ? (FORMAT PARQUET)
            """,
            [str(path)],
        )
    finally:
        writer.close()

    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend="duckdb",
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    try:
        schema = {column["name"]: column["type"] for column in opened["metadata"]["schema"]}
        schema_ids = {column["name"]: column["id"] for column in opened["metadata"]["schema"]}
        first_row = opened["page"]["rows"][0]["values"]

        assert schema == {
            "label": "string",
            "huge": "integer",
            "amount": "decimal",
            "occurred_at": "datetime",
            "elapsed": "duration",
            "payload": "binary",
            "items": "list",
            "record": "struct",
            "floating": "float",
        }
        assert [cell["kind"] for cell in first_row] == [
            "string",
            "integer",
            "decimal",
            "datetime",
            "duration",
            "binary",
            "list",
            "struct",
            "infinity",
        ]
        assert first_row[1]["raw"] == "18446744073709551615"
        assert first_row[2]["raw"] == "1.2300"
        assert first_row[3]["raw"] == "2025-12-31T23:30:00+00:00"
        assert first_row[4]["raw"] == 93784.0
        assert first_row[5]["raw"] == "AP8="
        assert first_row[6]["raw"] == [1, 2]
        assert first_row[7]["raw"] == {"label": "é🙂", "score": 7}
        assert opened["page"]["rows"][1]["values"][8]["kind"] == "nan"
        assert all(cell["kind"] == "null" for cell in opened["page"]["rows"][2]["values"][1:])
        json.dumps(opened, allow_nan=False)

        summaries = manager.get_summary(
            session_id,
            0,
            {"filters": [], "sort": []},
            [schema_ids[name] for name in ["amount", "occurred_at", "items", "record"]],
        )["summaries"]
        assert [summary["type"] for summary in summaries] == ["decimal", "datetime", "list", "struct"]
        assert summaries[0]["numeric"]["min"] == 1.23
        assert summaries[1]["visualization"] == {
            "kind": "datetime",
            "min": "2025-12-31 23:30:00+00:00",
            "max": "2026-01-02 10:00:00+00:00",
        }
        assert summaries[2]["topValues"][0]["value"] == "[1,2]"
        assert {item["value"] for item in summaries[3]["topValues"]} == {
            '{"label":"x","score":8}',
            '{"label":"é🙂","score":7}',
        }

        filtered = manager.get_page(
            session_id,
            0,
            0,
            10,
            {
                "logic": "and",
                "filters": [
                    {
                        "column": "amount",
                        "type": "decimal",
                        "logic": "and",
                        "predicates": [{"operator": "gte", "value": "1.2"}],
                    }
                ],
                "sort": [{"column": "occurred_at", "direction": "desc", "nulls": "last"}],
            },
        )["page"]
        assert filtered["totalRows"] == 2
        assert [row["values"][0]["raw"] for row in filtered["rows"]] == ["other", "match"]

        exported_path = tmp_path / "rich-cleaned.parquet"
        assert manager.export_data(
            session_id,
            0,
            str(exported_path),
            export_options("parquet"),
            reserve_export_target(exported_path),
        )["shape"] == {
            "rows": 3,
            "columns": 9,
        }
        inspector = duckdb.connect()
        try:
            inspector.execute("SET TimeZone = 'UTC'")
            exported = inspector.read_parquet(str(exported_path))
            assert [str(value) for value in exported.types] == [
                "VARCHAR",
                "UBIGINT",
                "DECIMAL(10,4)",
                "TIMESTAMP WITH TIME ZONE",
                "INTERVAL",
                "BLOB",
                "INTEGER[]",
                'STRUCT("label" VARCHAR, score INTEGER)',
                "DOUBLE",
            ]
            exported_row = exported.fetchone()
            assert exported_row is not None
            assert exported_row[3].isoformat() == "2025-12-31T23:30:00+00:00"
        finally:
            inspector.close()
    finally:
        manager.close_session(session_id, 0)


def test_duckdb_view_queries_are_typed_exact_and_concurrency_safe(monkeypatch: pytest.MonkeyPatch) -> None:
    install_conversion_guards(monkeypatch)
    engine = DuckDBEngine()
    frame = duckdb.sql(
        """
        SELECT * FROM (VALUES
            (0, 'alpha', CAST(1.0 AS DOUBLE), 9007199254740993::HUGEINT, [1, 2], {'x': 1}),
            (1, 'alpha', CAST(1.0 AS DOUBLE), 2::HUGEINT, [1, 2], {'x': 1}),
            (2, 'beta', CAST(NULL AS DOUBLE), 3::HUGEINT, [3], {'x': 2}),
            (3, 'nan', CAST('NaN' AS DOUBLE), 4::HUGEINT, NULL, NULL)
        ) AS source(id, label, value, huge, items, record)
        """
    )
    frame = engine.ensure_row_ids(frame, "typed")

    assert [item["type"] for item in engine.schema(frame)] == [
        "integer",
        "string",
        "float",
        "integer",
        "list",
        "struct",
    ]
    first_page = engine.page(frame, 0, 4)
    second_page = engine.page(frame, 0, 4)
    assert first_page == second_page
    assert first_page["rows"][0]["values"][3] == {
        "kind": "integer",
        "raw": "9007199254740993",
        "display": "9007199254740993",
        "isNull": False,
        "isNaN": False,
    }
    assert first_page["rows"][3]["values"][2]["kind"] == "nan"

    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "float",
                "logic": "or",
                "predicates": [
                    {"operator": "isNull"},
                    {"operator": "isNaN"},
                    {"operator": "gte", "value": 1},
                ],
            }
        ],
        "sort": [{"column": "label", "direction": "desc", "nulls": "last"}],
    }
    assert [row["label"] for row in records(engine.apply_filter_model(frame, model))] == [
        "nan",
        "beta",
        "alpha",
        "alpha",
    ]

    summary = engine.summaries(frame, [(2, "c:value"), (4, "c:items")])
    assert [item["columnId"] for item in summary] == ["c:value", "c:items"]
    assert summary[0]["nullCount"] == 1
    assert summary[0]["nanCount"] == 1
    assert summary[0]["distinctCount"] == 1
    assert summary[0]["topValues"] == [{"value": "1.0", "count": 2}]
    assert summary[0]["numeric"]["mean"] == 1.0
    assert summary[1]["topValues"][0] == {"value": "[1,2]", "count": 2}
    stats = engine.header_stats(frame)
    assert stats["missingCells"] == 4
    assert stats["missingRows"] == 2
    assert stats["duplicateRows"] == 0
    values, has_more = engine.column_values(frame, "value")
    assert values == [{"value": "1.0", "count": 2, "selectionValue": typed_selection_value(1.0, "float")}]
    assert has_more is False

    def read_page() -> list[str]:
        return [row["id"] for row in engine.page(frame, 0, 4)["rows"]]

    def read_summary() -> int:
        return engine.summaries(frame, [(1, "c:label")])[0]["distinctCount"]

    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(read_page if index % 2 == 0 else read_summary) for index in range(24)]
        results = [future.result(timeout=10) for future in futures]
    assert all(result == first_page_ids(first_page) for result in results[::2])
    assert results[1::2] == [3] * 12
    engine.close()


def test_duckdb_nested_float_containers_use_container_missing_semantics() -> None:
    engine = DuckDBEngine()
    source = duckdb.sql(
        """
        SELECT CAST([1.0] AS DOUBLE[]) AS items,
               {'score': CAST(1.0 AS DOUBLE)} AS record
        UNION ALL
        SELECT NULL::DOUBLE[], NULL::STRUCT(score DOUBLE)
        """
    )
    columns = [
        bound_ref("c:source:0", "items", 0),
        bound_ref("c:source:1", "record", 1),
    ]
    operation = bound_step("dropMissingRows", columns=columns, how="any")

    try:
        summaries = engine.summaries(source, [(0, "c:items"), (1, "c:record")])
        assert [(summary["type"], summary["nullCount"], summary["nanCount"]) for summary in summaries] == [
            ("list", 1, 0),
            ("struct", 1, 0),
        ]
        assert engine.header_stats(source) == {
            "missingCells": 2,
            "missingRows": 1,
            "duplicateRows": 0,
            "missingValuesByColumn": [
                {"column": "items", "count": 1},
                {"column": "record", "count": 1},
            ],
        }

        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        assert_same_relation(live, generated)
        assert rows(live) == [([1.0], {"score": 1.0})]
    finally:
        engine.close()


def test_duckdb_text_summaries_are_exact_native_unicode_aggregates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_conversion_guards(monkeypatch)
    engine = DuckDBEngine()
    frame = duckdb.sql(
        """
        SELECT * FROM (VALUES
            (CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)),
            ('', NULL),
            ('A', NULL),
            ('é', NULL),
            ('é', NULL),
            ('😀', NULL)
        ) AS source(text_value, all_null)
        """
    )

    try:
        summaries = engine.summaries(frame, [(0, "c:text"), (1, "c:all-null")])

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


def test_duckdb_numeric_summaries_publish_lossless_wide_integer_and_decimal_extrema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_conversion_guards(monkeypatch)
    engine = DuckDBEngine()
    frame = duckdb.sql(
        """
        SELECT * FROM (VALUES
            (
                CAST('-999999999999999999999999999998' AS HUGEINT),
                CAST('-12345678901234567890.123456789012345678' AS DECIMAL(38, 18))
            ),
            (
                CAST('1000000000000000000000000000003' AS HUGEINT),
                CAST('98765432109876543210.987654321098765432' AS DECIMAL(38, 18))
            )
        ) AS source(wide, amount)
        """
    )

    try:
        summaries = engine.summaries(frame, [(0, "wide-id"), (1, "amount-id")])

        assert summaries[0]["numeric"]["exactMin"]["display"] == "-999999999999999999999999999998"
        assert summaries[0]["numeric"]["exactMax"]["display"] == "1000000000000000000000000000003"
        assert summaries[0]["numeric"]["exactMin"]["kind"] == "integer"
        assert summaries[0]["numeric"]["exactMax"]["kind"] == "integer"
        assert summaries[1]["numeric"]["exactMin"]["display"] == "-12345678901234567890.123456789012345678"
        assert summaries[1]["numeric"]["exactMax"]["display"] == "98765432109876543210.987654321098765432"
        assert summaries[1]["numeric"]["exactMin"]["kind"] == "decimal"
        assert summaries[1]["numeric"]["exactMax"]["kind"] == "decimal"
    finally:
        engine.close()


def test_duckdb_numeric_histogram_is_exact_for_a_large_filtered_view() -> None:
    engine = DuckDBEngine()
    source = duckdb.sql(
        """
        SELECT CAST(-1 AS DOUBLE) AS value FROM range(500)
        UNION ALL
        SELECT CAST(value AS DOUBLE) FROM range(5000) AS source(value)
        UNION ALL
        SELECT CAST(1000000 AS DOUBLE)
        """
    )
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
        assert [bin_["max"] - bin_["min"] for bin_ in bins] == pytest.approx(
            [bins[0]["max"] - bins[0]["min"]] * len(bins)
        )
    finally:
        engine.close()


def test_duckdb_non_float_include_nan_value_filter_is_an_explicit_false_condition() -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql("SELECT * FROM (VALUES (1), (2)) AS source(value)")
    operation = bound_step(
        "filterRows",
        filterModel={
            "filters": [
                {
                    "column": bound_ref("c:source:0", "value", 0),
                    "type": "integer",
                    "valueFilter": {
                        "kind": "values",
                        "selectedValues": [],
                        "includeNulls": False,
                        "includeNaN": True,
                    },
                    "predicates": [],
                }
            ],
            "sort": [],
        },
    )

    transformed = engine.apply_transform(frame, operation)
    generated = execute_generated(engine, frame, [operation])

    assert rows(transformed) == []
    assert_same_relation(transformed, generated)


def first_page_ids(page: dict[str, Any]) -> list[str]:
    return [row["id"] for row in page["rows"]]


def test_duckdb_all_operations_and_generated_code_stay_native(monkeypatch: pytest.MonkeyPatch) -> None:
    install_conversion_guards(monkeypatch)
    engine = DuckDBEngine()
    source = source_relation()
    row_plan = [
        bound_step(
            "sortRows",
            rules=[
                {
                    "column": bound_ref("c:source:3", "value", 3),
                    "direction": "desc",
                    "nulls": "last",
                }
            ],
        ),
        bound_step(
            "filterRows",
            filterModel={
                "logic": "and",
                "filters": [
                    {
                        "column": bound_ref("c:source:1", "text", 1),
                        "type": "string",
                        "logic": "and",
                        "predicates": [{"operator": "contains", "value": "alpha"}],
                    }
                ],
                "sort": [],
            },
        ),
        bound_step(
            "fillMissingValues",
            column=bound_ref("c:source:3", "value", 3),
            replacement={"kind": "median"},
        ),
        bound_step(
            "dropMissingRows",
            columns=[bound_ref("c:source:3", "value", 3)],
            how="any",
        ),
        bound_step(
            "dropDuplicates",
            columns=[
                bound_ref("c:source:3", "value", 3),
                bound_ref("c:source:4", "other", 4),
            ],
            keep="first",
        ),
    ]
    column_plan = [
        bound_step(
            "cloneColumn",
            column=bound_ref("c:source:3", "value", 3),
            newName="value_copy",
        ),
        bound_step(
            "formula",
            leftColumn=bound_ref("c:source:4", "other", 4),
            operator="multiply",
            value=10,
            newColumn="score",
        ),
        bound_step(
            "textLength",
            column=bound_ref("c:source:1", "text", 1),
            newColumn="text_length",
        ),
        bound_step(
            "castColumn",
            column=bound_ref("c:source:4", "other", 4),
            dtype="float",
        ),
        bound_step(
            "renameColumn",
            column=bound_ref("c:source:0", "group", 0),
            newName="category",
        ),
        bound_step(
            "dropColumns",
            columns=[
                bound_ref("c:source:2", "tags", 2),
                bound_ref("c:source:5", "date", 5),
            ],
        ),
        bound_step(
            "selectColumns",
            columns=[
                bound_ref("c:source:0", "category", 0),
                bound_ref("c:source:1", "text", 1),
                bound_ref("c:source:3", "value", 2),
                bound_ref("c:source:4", "other", 3),
                bound_ref("c:step:duckdb-cloneColumn:0", "value_copy", 4),
                bound_ref("c:step:duckdb-formula:0", "score", 5),
                bound_ref("c:step:duckdb-textLength:0", "text_length", 6),
            ],
        ),
    ]
    text_numeric_plan = [
        bound_step("stripText", column=bound_ref("c:source:1", "text", 1), newColumn="clean"),
        bound_step(
            "findReplace",
            column=bound_ref("c:source:1", "text", 1),
            find="-",
            replacement=" ",
            newColumn="replaced",
        ),
        bound_step(
            "splitText",
            column=bound_ref("c:source:1", "text", 1),
            delimiter="-",
            index=1,
            newColumn="suffix",
        ),
        bound_step(
            "splitTextColumns",
            column=bound_ref("c:source:1", "text", 1),
            delimiter="-",
            newColumns=["text_part", "text_remainder"],
        ),
        bound_step(
            "extractRegexGroup",
            column=bound_ref("c:source:1", "text", 1),
            pattern="([A-Za-z]+)-",
            group=1,
            newColumn="regex_word",
        ),
        bound_step("lowerText", column=bound_ref("c:source:1", "text", 1), newColumn="lower"),
        bound_step("upperText", column=bound_ref("c:source:1", "text", 1), newColumn="upper"),
        bound_step("capitalizeText", column=bound_ref("c:source:1", "text", 1), newColumn="capitalized"),
        bound_step(
            "oneHotEncode",
            columns=[bound_ref("c:source:0", "group", 0)],
            prefixSeparator="_",
            dropOriginal=False,
        ),
        bound_step(
            "multiLabelBinarize",
            column=bound_ref("c:source:2", "tags", 2),
            delimiter="|",
            prefix="tag_",
            dropOriginal=False,
        ),
        bound_step("minMaxScale", column=bound_ref("c:source:3", "value", 3), newColumn="scaled"),
        bound_step(
            "roundNumber",
            column=bound_ref("c:source:3", "value", 3),
            decimals=0,
            newColumn="rounded",
        ),
        bound_step("floorNumber", column=bound_ref("c:source:3", "value", 3), newColumn="floored"),
        bound_step("ceilNumber", column=bound_ref("c:source:3", "value", 3), newColumn="ceiled"),
        bound_step(
            "formatDatetime",
            column=bound_ref("c:source:5", "date", 5),
            format="%Y/%m",
            newColumn="month",
        ),
    ]
    source_schema = engine.schema(source)
    source_columns = source_lineage(source_schema)
    group_plan = [
        bind_step(
            step(
                "groupBy",
                keys=[{"id": "c:source:0", "name": "group"}],
                aggregations=[
                    {"column": {"id": "c:source:3", "name": "value"}, "operation": "sum", "alias": "total"},
                    {"column": {"id": "c:source:4", "name": "other"}, "operation": "mean", "alias": "average"},
                    {"column": {"id": "c:source:1", "name": "text"}, "operation": "count", "alias": "texts"},
                    {"column": {"id": "c:source:2", "name": "tags"}, "operation": "nUnique", "alias": "tag_sets"},
                ],
            ),
            source_schema,
            source_columns,
        )
    ]
    example_plan = [
        bind_step(
            step(
                "byExample",
                sourceColumns=[
                    {"id": "c:source:0", "name": "group"},
                    {"id": "c:source:4", "name": "other"},
                ],
                newColumn="label",
                examples=[
                    {"inputs": ["a", 2], "output": "a-2"},
                    {"inputs": ["b", 4], "output": "b-4"},
                ],
            ),
            source_schema,
            source_columns,
        )
    ]
    pivot_plan = [
        bound_step(
            "pivotLonger",
            columns=[
                bound_ref("c:source:0", "group", 0),
                bound_ref("c:source:1", "text", 1),
            ],
            labelColumn="measure",
            valueColumn="reading",
        )
    ]
    pivot_wider_a = typed_selection_value("a", "string")
    pivot_wider_b = typed_selection_value("b", "string")
    assert pivot_wider_a is not None and pivot_wider_b is not None
    pivot_wider_plan = [
        bound_step(
            "selectColumns",
            columns=[
                bound_ref("c:source:4", "other", 4),
                bound_ref("c:source:0", "group", 0),
                bound_ref("c:source:3", "value", 3),
            ],
        ),
        bound_step(
            "pivotWider",
            namesFrom=bound_ref("c:source:0", "group", 1),
            valuesFrom=bound_ref("c:source:3", "value", 2),
            outputs=[
                {"key": pivot_wider_a, "name": "group_a_value"},
                {"key": pivot_wider_b, "name": "group_b_value"},
            ],
        ),
    ]
    custom_plan = [step("customCode", code='result = df.filter("other > 2")')]

    plans = [
        row_plan,
        column_plan,
        text_numeric_plan,
        pivot_plan,
        pivot_wider_plan,
        group_plan,
        example_plan,
        custom_plan,
    ]
    covered = {operation["kind"] for plan in plans for operation in plan}
    assert covered == {item["kind"] for item in operation_catalog()}
    for plan in plans:
        live = source
        for operation in plan:
            live = engine.apply_transform(live, operation)
        generated = execute_generated(engine, source, plan)
        assert_same_relation(live, generated)

    transformed = source
    for operation in text_numeric_plan:
        transformed = engine.apply_transform(transformed, operation)
    output = records(transformed)
    assert output[0]["clean"] == "alpha-one"
    assert output[1]["suffix"] == "two"
    assert output[0]["group_a"] == 1
    assert output[2]["group_b"] == 1
    assert output[0]["tag_blue"] == 1
    assert output[1]["tag_red"] == 0
    assert output[0]["scaled"] == 0.0
    assert output[1]["scaled"] == 1.0
    assert output[0]["month"] == "2024/01"

    grouped = engine.apply_transform(source, group_plan[0])
    assert records(grouped)[0] == {"group": "a", "total": 4.0, "average": 2.5, "texts": 2, "tag_sets": 2}
    engine.close()


def test_duckdb_grouping_treats_nan_as_missing_for_keys_and_aggregates() -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql(
        """
        SELECT * FROM (VALUES
            (NULL::DOUBLE, NULL::DOUBLE),
            ('NaN'::DOUBLE, 'NaN'::DOUBLE),
            (1.0, 2.0),
            (NULL::DOUBLE, NULL::DOUBLE),
            ('NaN'::DOUBLE, 'NaN'::DOUBLE),
            (1.0, 3.0)
        ) AS source("key", "value")
        """
    )
    value = bound_ref("c:source:1", "value", 1)
    operation = bound_step(
        "groupBy",
        keys=[bound_ref("c:source:0", "key", 0)],
        aggregations=[
            {"column": value, "operation": "sum", "alias": "total"},
            {"column": value, "operation": "mean", "alias": "average"},
            {"column": value, "operation": "min", "alias": "minimum"},
            {"column": value, "operation": "max", "alias": "maximum"},
            {"column": value, "operation": "median", "alias": "middle"},
            {"column": value, "operation": "count", "alias": "count"},
            {"column": value, "operation": "nUnique", "alias": "unique"},
            {"column": value, "operation": "first", "alias": "first"},
            {"column": value, "operation": "last", "alias": "last"},
        ],
    )

    try:
        transformed = engine.apply_transform(frame, operation)
        generated = execute_generated(engine, frame, [operation])

        assert records(transformed) == [
            {
                "key": None,
                "total": 0.0,
                "average": None,
                "minimum": None,
                "maximum": None,
                "middle": None,
                "count": 0,
                "unique": 0,
                "first": None,
                "last": None,
            },
            {
                "key": 1.0,
                "total": 5.0,
                "average": 2.5,
                "minimum": 2.0,
                "maximum": 3.0,
                "middle": 2.5,
                "count": 2,
                "unique": 2,
                "first": 2.0,
                "last": 3.0,
            },
        ]
        assert_same_relation(transformed, generated)
    finally:
        engine.close()


def test_duckdb_decimal_median_is_a_portable_float_and_matches_generated_code() -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql(
        "SELECT * FROM (VALUES "
        "('a', 1.10::DECIMAL(10, 2)), "
        "('a', 2.20::DECIMAL(10, 2)), "
        "('b', NULL::DECIMAL(10, 2))) AS source(\"group\", value)"
    )
    operation = bound_step(
        "groupBy",
        keys=[bound_ref("c:source:0", "group", 0)],
        aggregations=[
            {
                "column": bound_ref("c:source:1", "value", 1),
                "operation": "median",
                "alias": "middle",
            }
        ],
    )

    try:
        transformed = engine.apply_transform(frame, operation)
        generated = execute_generated(engine, frame, [operation])

        assert records(transformed) == [
            {"group": "a", "middle": pytest.approx(1.65)},
            {"group": "b", "middle": None},
        ]
        assert str(transformed.types[1]) == "DOUBLE"
        assert_same_relation(transformed, generated)
    finally:
        engine.close()


def test_duckdb_column_values_break_equal_counts_by_display_text() -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql("SELECT * FROM (VALUES ('Milan'), ('Berlin'), ('Milan'), ('Berlin'), ('Paris')) AS source(city)")

    try:
        values, has_more = engine.column_values(frame, "city")
        assert values == [
            {"value": "Berlin", "count": 2, "selectionValue": typed_selection_value("Berlin", "string")},
            {"value": "Milan", "count": 2, "selectionValue": typed_selection_value("Milan", "string")},
            {"value": "Paris", "count": 1, "selectionValue": typed_selection_value("Paris", "string")},
        ]
        assert has_more is False
    finally:
        engine.close()


def test_duckdb_missing_modes_encoders_collisions_and_custom_failures() -> None:
    engine = DuckDBEngine()
    missing = duckdb.sql(
        "SELECT * FROM (VALUES (1.0, NULL), (NULL, 2.0), (NULL, NULL), "
        "(CAST('NaN' AS DOUBLE), 3.0), (4.0, 4.0)) AS source(left_value, right_value)"
    )
    missing_columns = [
        bound_ref("c:source:0", "left_value", 0),
        bound_ref("c:source:1", "right_value", 1),
    ]
    drop_any = bound_step("dropMissingRows", columns=missing_columns, how="any")
    drop_all = bound_step("dropMissingRows", columns=missing_columns, how="all")
    assert len(rows(engine.apply_transform(missing, drop_any))) == 1
    assert len(rows(engine.apply_transform(missing, drop_all))) == 4
    assert_same_relation(engine.apply_transform(missing, drop_any), execute_generated(engine, missing, [drop_any]))
    drop_all_columns = bound_step("dropMissingRows", columns=[], how="any")
    assert len(rows(engine.apply_transform(missing, drop_all_columns))) == 1
    assert_same_relation(
        engine.apply_transform(missing, drop_all_columns),
        execute_generated(engine, missing, [drop_all_columns]),
    )

    duplicate = duckdb.sql(
        "SELECT * FROM (VALUES ('a', 1.0), ('a', 1.0), ('b', NULL), ('b', NULL), ('c', 3.0)) AS source(key, value)"
    )
    duplicate_columns = [
        bound_ref("c:source:0", "key", 0),
        bound_ref("c:source:1", "value", 1),
    ]
    keep_last = bound_step("dropDuplicates", columns=duplicate_columns, keep="last")
    keep_none = bound_step("dropDuplicates", columns=duplicate_columns, keep="none")
    assert [row[0] for row in rows(engine.apply_transform(duplicate, keep_last))] == ["a", "b", "c"]
    assert [row[0] for row in rows(engine.apply_transform(duplicate, keep_none))] == ["c"]
    keep_all = bound_step("dropDuplicates", keep="first")
    assert [row[0] for row in rows(engine.apply_transform(duplicate, keep_all))] == ["a", "b", "c"]
    assert_same_relation(
        engine.apply_transform(duplicate, keep_all),
        execute_generated(engine, duplicate, [keep_all]),
    )

    collision = duckdb.sql("SELECT 'a' AS group_name, 7 AS group_name_a")
    operation = bound_step(
        "oneHotEncode",
        columns=[bound_ref("c:source:0", "group_name", 0)],
        prefixSeparator="_",
        dropOriginal=False,
    )
    with pytest.raises(EngineError, match="duplicate column names: group_name_a"):
        engine.apply_transform(collision, operation)
    with pytest.raises(ValueError, match="duplicate column names: group_name_a"):
        execute_generated(engine, collision, [operation])

    private_output = duckdb.sql("SELECT 'open_wrangler_internal_row_id_forged' AS tags, 1 AS keep")
    private_operation = bound_step(
        "multiLabelBinarize",
        column=bound_ref("c:source:0", "tags", 0),
        delimiter="|",
        prefix="__",
        dropOriginal=False,
    )
    with pytest.raises(EngineError, match="reserved private row-identity column"):
        engine.apply_transform(private_output, private_operation)
    with pytest.raises(ValueError, match="reserved private row-identity column"):
        execute_generated(engine, private_output, [private_operation])

    scalar_categories = duckdb.sql(
        """
        SELECT * FROM (VALUES
            (CAST(1.0 AS DOUBLE), TRUE, DATE '2024-01-02'),
            (CAST('NaN' AS DOUBLE), FALSE, DATE '2024-01-03'),
            (CAST(NULL AS DOUBLE), NULL, NULL)
        ) AS source(value, flag, day)
        """
    )
    scalar_operation = bound_step(
        "oneHotEncode",
        columns=[
            bound_ref("c:source:0", "value", 0),
            bound_ref("c:source:1", "flag", 1),
            bound_ref("c:source:2", "day", 2),
        ],
        dropOriginal=False,
    )
    scalar_result = engine.apply_transform(scalar_categories, scalar_operation)
    assert list(scalar_result.columns) == [
        "value",
        "flag",
        "day",
        "day_2024-01-02",
        "day_2024-01-03",
        "flag_False",
        "flag_True",
        "value_1.0",
    ]
    assert_same_relation(scalar_result, execute_generated(engine, scalar_categories, [scalar_operation]))

    padded = "\t\n\r\v\f\u00a0\u2003X\t\n\r\v\f\u00a0\u2003"
    whitespace = duckdb.sql(f"SELECT '{padded}' AS text")
    strip_operation = bound_step(
        "stripText",
        column=bound_ref("c:source:0", "text", 0),
        newColumn="clean",
    )
    stripped = engine.apply_transform(whitespace, strip_operation)
    assert records(stripped)[0]["clean"] == "X"
    assert_same_relation(stripped, execute_generated(engine, whitespace, [strip_operation]))

    with pytest.raises(EngineError, match="Custom DuckDB code failed: boom"):
        engine.apply_transform(source_relation(), step("customCode", code="raise ValueError('boom')"))
    with pytest.raises(EngineError, match="must assign a DuckDBPyRelation"):
        engine.apply_transform(source_relation(), step("customCode", code="result = 42"))
    engine.close()


def test_duckdb_file_session_preview_apply_profile_export_and_close(tmp_path: Path) -> None:
    source = tmp_path / "session.csv"
    source.write_text("group,value\na,1\na,2\nb,3\n", encoding="utf-8")
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": source.name, "path": str(source)},
        backend="duckdb",
        page_size=2,
    )
    session_id = opened["metadata"]["sessionId"]
    assert opened["metadata"]["backend"] == "duckdb"
    assert opened["metadata"]["shape"] == {"rows": 3, "columns": 2}
    assert isinstance(manager.sessions[session_id].original, DuckDBSqlPlan)
    session_engine = manager.sessions[session_id].engine
    assert isinstance(session_engine, DuckDBEngine)
    assert "read_csv" in manager.sessions[session_id].original.sql_query().lower()

    operation = step(
        "formula",
        leftColumn={"id": "c:source:1", "name": "value"},
        operator="multiply",
        value=10,
        newColumn="score",
    )
    preview = manager.preview_step(session_id, 0, operation, 0, 10)
    assert preview["revision"] == 1
    assert preview["diff"]["addedColumns"] == ["score"]
    applied = manager.apply_draft(session_id, 1, 0, 10)
    assert applied["revision"] == 2
    assert "import duckdb" in applied["code"]
    summary = manager.get_summary(
        session_id,
        2,
        {"logic": "and", "filters": [], "sort": []},
        ["c:step:duckdb-formula:0"],
    )["summaries"][0]
    assert summary["numeric"] == {
        "min": 10.0,
        "max": 30.0,
        "mean": 20.0,
        "median": 20.0,
        "std": 10.0,
        "sum": 60.0,
        "exactSum": {
            "kind": "integer",
            "raw": 60,
            "display": "60",
            "isNull": False,
            "isNaN": False,
        },
        "exactMin": {
            "kind": "integer",
            "raw": 10,
            "display": "10",
            "isNull": False,
            "isNaN": False,
        },
        "exactMax": {
            "kind": "integer",
            "raw": 30,
            "display": "30",
            "isNull": False,
            "isNaN": False,
        },
    }

    destination = tmp_path / "cleaned.parquet"
    exported = manager.export_data(
        session_id,
        2,
        str(destination),
        export_options("parquet"),
        reserve_export_target(destination),
    )
    assert exported["shape"] == {"rows": 3, "columns": 3}
    assert duckdb.read_parquet(str(destination)).fetchall() == [("a", 1, 10), ("a", 2, 20), ("b", 3, 30)]
    assert manager.close_session(session_id, 2) == {"kind": "sessionClosed", "sessionId": session_id}
    assert manager.sessions == {}
    manager.close_all()


def test_duckdb_live_notebook_session_owns_the_exact_relation_without_conversion_or_sql_replay(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    install_conversion_guards(monkeypatch)
    connection = duckdb.connect()
    connection.execute(
        "CREATE TABLE private_orders AS "
        "SELECT * FROM (VALUES (7, 'Milan'), (11, 'Berlin'), (9, 'Paris')) AS rows(order_id, city)"
    )
    relation = connection.table("private_orders")
    monkeypatch.setattr(__main__, "duck_orders", relation, raising=False)

    def reject_unrelated_connection() -> Any:
        raise AssertionError("A live notebook relation must never replay SQL on an unrelated DuckDB connection")

    monkeypatch.setattr(duckdb_runtime, "_connect", reject_unrelated_connection)
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    owner = None
    try:
        opened = manager.open_session(
            {"kind": "notebookVariable", "label": "duck_orders", "variableName": "duck_orders"},
            backend="duckdb",
            mode="editing",
            page_size=2,
        )
        session_id = opened["metadata"]["sessionId"]
        assert opened["metadata"]["backend"] == "duckdb"
        assert opened["metadata"]["mode"] == "viewing"
        assert opened["metadata"]["capabilities"] == {
            "editable": False,
            "lazy": False,
            "cancel": False,
            "exportCsv": False,
            "exportParquet": False,
            "notebookInsert": False,
        }
        assert opened["metadata"]["shape"] == {"rows": 3, "columns": 2}
        assert [row["values"][0]["display"] for row in opened["page"]["rows"]] == ["7", "11"]
        original = manager.sessions[session_id].original
        assert isinstance(original, DuckDBNotebookPlan)
        owner = original.owner

        sorted_page = manager.get_page(
            session_id,
            0,
            0,
            10,
            {
                "logic": "and",
                "filters": [],
                "sort": [{"column": "order_id", "direction": "desc", "nulls": "last"}],
            },
        )
        assert [row["values"][0]["display"] for row in sorted_page["page"]["rows"]] == ["11", "9", "7"]
        summary = manager.get_summary(
            session_id,
            0,
            {"logic": "and", "filters": [], "sort": []},
            ["c:source:0"],
        )["summaries"][0]
        assert summary["numeric"]["min"] == 7.0
        assert summary["numeric"]["max"] == 11.0

        with pytest.raises(EngineError, match="viewing mode"):
            manager.preview_step(
                session_id,
                0,
                step(
                    "sortRows",
                    rules=[
                        {
                            "column": {"id": "c:source:0", "name": "order_id"},
                            "direction": "asc",
                            "nulls": "last",
                        }
                    ],
                ),
                0,
                10,
            )
        with pytest.raises(EngineError, match="viewing mode"):
            manager.export_data(session_id, 0, str(tmp_path / "must-not-export.csv"), export_options("csv"))

        assert manager.close_session(session_id, 0) == {"kind": "sessionClosed", "sessionId": session_id}
        assert owner.closed is True
        assert relation.fetchall() == [(7, "Milan"), (11, "Berlin"), (9, "Paris")]
    finally:
        manager.close_all()
        connection.close()
