"""Shared plans and shape assertions for generated cleaning code tests."""

from __future__ import annotations

import ast
import inspect
import io
import json
import tokenize
from collections.abc import Mapping, Sequence
from copy import deepcopy
from datetime import date, datetime
from decimal import Decimal
from math import isnan
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import polars as pl
from polars.testing import assert_frame_equal as assert_polars_frame_equal

from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine, DuckDBSqlPlan
from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.engines.polars_engine import PolarsEngine
from openwrangler_runtime.lineage import derive_lineage, source_lineage
from openwrangler_runtime.operations import OPERATION_BY_KIND, validate_step

FIXTURE_PATH = Path(__file__).resolve().parents[2] / "fixtures" / "generated-code-plans.json"
LOOKUP_DIRECTORY = FIXTURE_PATH.parent / "generated-code-lookup"
ENGINE_NAMES = ("pandas", "polars", "duckdb")
# Live execution refuses these operations on these engines, so they generate no code there.
UNSUPPORTED_OPERATIONS = frozenset(
    {
        ("pandas", "explodeList"),
        ("pandas", "extractStructFields"),
        ("duckdb", "explodeList"),
    }
)
_DECIMAL_SCALE = 2
_PRIVATE_MARKERS = ("open_wrangler", "openwrangler")


def load_generated_code_plans() -> dict[str, Any]:
    """Return the parsed shared plan fixture."""

    with FIXTURE_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def engine_for(engine_name: str) -> PandasEngine | PolarsEngine | DuckDBEngine:
    """Return a fresh engine for a fixture engine name."""

    return {"pandas": PandasEngine, "polars": PolarsEngine, "duckdb": DuckDBEngine}[engine_name]()


def source_frame(engine_name: str, columns: Sequence[str] | None = None, *, lazy: bool = False) -> Any:
    """Build the fixture source table with each engine's natural native types."""

    selected = load_generated_code_plans()["source"]["columns"]
    if columns is not None:
        allowed = set(columns)
        selected = [column for column in selected if column["name"] in allowed]
    decoded = [(column["name"], column["type"], [_decode(value) for value in column["values"]]) for column in selected]
    if engine_name == "pandas":
        return pd.DataFrame({name: _pandas_series(column_type, values) for name, column_type, values in decoded})
    if engine_name == "polars":
        frame = pl.DataFrame([_polars_series(name, column_type, values) for name, column_type, values in decoded])
        return frame.lazy() if lazy else frame
    if engine_name == "duckdb":
        return _duckdb_relation(decoded)
    raise ValueError(f"Unsupported engine {engine_name!r}.")


def bind_plan(
    engine: PandasEngine | PolarsEngine | DuckDBEngine,
    frame: Any,
    steps: Sequence[Mapping[str, Any]],
    engine_name: str,
) -> tuple[list[dict[str, Any]], Any]:
    """Bind each fixture step against the schema and lineage at that step and run it live, as a session does."""

    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    bound_steps: list[dict[str, Any]] = []
    current = frame
    for index, template in enumerate(steps):
        by_name = {str(entry["name"]): {"id": str(entry["id"]), "name": str(entry["name"])} for entry in lineage}
        payload = _column_references(_engine_values(deepcopy(dict(template)), engine_name), by_name)
        public = validate_step({"id": f"s{index + 1}", "kind": payload["kind"], "params": payload["params"]})
        bound = bind_step(public, schema, lineage)
        bound_steps.append(bound)
        current = engine.apply_transform(current, bound)
        schema = engine.schema(current)
        lineage = derive_lineage(lineage, schema, bound)
    return bound_steps, current


def execute_generated(engine: Any, frame: Any, code: str, spill_directory: Path) -> Any:
    """Run generated code the way a user would, on the engine's native source."""

    namespace: dict[str, Any] = {}
    exec(compile(code, "<generated-code-plan>", "exec"), namespace, namespace)
    clean_data = namespace["clean_data"]
    if not isinstance(engine, DuckDBEngine):
        return clean_data(frame)
    source_sql = frame.sql if isinstance(frame, DuckDBSqlPlan) else frame.sql_query()
    if "connection" not in inspect.signature(clean_data).parameters:
        return clean_data(duckdb.sql(source_sql))
    spill = spill_directory / "duckdb-generated.parquet"
    connection = duckdb.connect()
    try:
        clean_data(connection.sql(source_sql), connection=connection).write_parquet(str(spill))
    finally:
        connection.close()
    return duckdb.sql(f"SELECT * FROM read_parquet('{str(spill).replace(chr(39), chr(39) * 2)}')")


def assert_same_result(engine: Any, live: Any, generated: Any) -> None:
    """Compare a live result with a generated one exactly, treating NaN as equal to NaN."""

    if isinstance(engine, PandasEngine):
        pd.testing.assert_frame_equal(live, generated)
        return
    if isinstance(engine, PolarsEngine):
        live = live.collect() if isinstance(live, pl.LazyFrame) else live
        generated = generated.collect() if isinstance(generated, pl.LazyFrame) else generated
        assert_polars_frame_equal(live, generated)
        return
    live_columns, live_rows = _duckdb_snapshot(engine, live)
    generated_columns, generated_rows = _duckdb_snapshot(engine, generated)
    assert live_columns == generated_columns
    assert len(live_rows) == len(generated_rows)
    for live_row, generated_row in zip(live_rows, generated_rows, strict=True):
        for left, right in zip(live_row, generated_row, strict=True):
            if isinstance(left, float) and isinstance(right, float) and isnan(left) and isnan(right):
                continue
            assert repr(left) == repr(right)


def assert_readable_python(
    code: str,
    plan: Sequence[Mapping[str, Any]],
    *,
    function_name: str = "clean_data",
    max_lines: int | None = None,
) -> None:
    """Check the shared generated-code shape rules; Custom Code bodies are the user's and are exempt."""

    module = ast.parse(code)
    assert len(module.body) == 1, "Generated code must define only its entry function."
    entry = module.body[0]
    assert isinstance(entry, ast.FunctionDef) and entry.name == function_name, (
        f"Generated code must define {function_name}(df)."
    )
    user_nodes = _custom_code_nodes(entry, plan)
    for name in sorted(_checked_names(entry, user_nodes)):
        assert not (name.startswith("_") and name != "_" and not name.startswith("__")), (
            f"Generated code uses the private-looking name {name!r}."
        )
        assert not any(marker in name.lower() for marker in _PRIVATE_MARKERS), (
            f"Generated code uses the internal name {name!r}."
        )
        assert not name.startswith("ow_"), f"Generated code uses the internal name {name!r}."

    loaded = {node.id for node in ast.walk(entry) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)}
    for node in ast.walk(entry):
        if node in user_nodes:
            continue
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                bound = alias.asname or alias.name.split(".")[0]
                assert bound in loaded, f"Generated code imports {bound!r} without using it."
        if isinstance(node, ast.FunctionDef) and node is not entry:
            docstring = ast.get_docstring(node, clean=False)
            assert docstring, f"Helper {node.name}() needs a one-line docstring."
            assert "\n" not in docstring.strip(), f"Helper {node.name}() needs a one-line docstring."
            assert node.name in loaded, f"Generated code defines {node.name}() without using it."

    assert_step_comments(code, plan)
    if max_lines is not None:
        assert len(code.splitlines()) <= max_lines, (
            f"Generated code has {len(code.splitlines())} lines; the limit is {max_lines}.\n{code}"
        )


def assert_step_comments(code: str, plan: Sequence[Mapping[str, Any]]) -> None:
    """Every step starts with a comment holding its catalog title, in plan order."""

    comments = [
        token.string[1:].strip()
        for token in tokenize.generate_tokens(io.StringIO(code).readline)
        if token.type == tokenize.COMMENT
    ]
    position = 0
    for step in plan:
        title = OPERATION_BY_KIND[str(step["kind"])].title
        while position < len(comments) and comments[position] != title:
            position += 1
        assert position < len(comments), f"Generated code has no '# {title}' comment for {step['kind']}."
        position += 1


def _decode(value: Any) -> Any:
    if isinstance(value, Mapping) and value.get("$nan") is True:
        return float("nan")
    return value


def _pandas_series(column_type: str, values: list[Any]) -> pd.Series:
    if column_type == "integer":
        return pd.Series(values, dtype="Int64")
    if column_type == "float":
        return pd.Series(values, dtype="float64")
    if column_type == "boolean":
        return pd.Series(values, dtype="boolean")
    if column_type == "datetime":
        return pd.Series(pd.to_datetime(values, format="%Y-%m-%dT%H:%M:%S.%f")).astype("datetime64[us]")
    if column_type == "date":
        return pd.Series([None if value is None else date.fromisoformat(value) for value in values], dtype=object)
    if column_type == "decimal":
        return pd.Series([None if value is None else Decimal(value) for value in values], dtype=object)
    if column_type in {"list", "struct"}:
        return pd.Series(values, dtype=object)
    return pd.Series(values)


def _polars_series(name: str, column_type: str, values: list[Any]) -> pl.Series:
    if column_type == "integer":
        return pl.Series(name, values, dtype=pl.Int64)
    if column_type == "float":
        return pl.Series(name, values, dtype=pl.Float64)
    if column_type == "boolean":
        return pl.Series(name, values, dtype=pl.Boolean)
    if column_type == "datetime":
        parsed = [None if value is None else datetime.fromisoformat(value) for value in values]
        return pl.Series(name, parsed, dtype=pl.Datetime("us"))
    if column_type == "date":
        return pl.Series(
            name, [None if value is None else date.fromisoformat(value) for value in values], dtype=pl.Date
        )
    if column_type == "decimal":
        decimals = [None if value is None else Decimal(value) for value in values]
        return pl.Series(name, decimals, dtype=pl.Decimal(18, _DECIMAL_SCALE))
    if column_type == "list":
        return pl.Series(name, values, dtype=pl.List(pl.Int64))
    if column_type == "struct":
        return pl.Series(name, values, dtype=pl.Struct({"city": pl.String, "zip": pl.String}))
    return pl.Series(name, values, dtype=pl.String)


_DUCKDB_TYPES = {
    "integer": "BIGINT",
    "float": "DOUBLE",
    "boolean": "BOOLEAN",
    "string": "VARCHAR",
    "datetime": "TIMESTAMP",
    "date": "DATE",
    "decimal": f"DECIMAL(18, {_DECIMAL_SCALE})",
    "list": "BIGINT[]",
    "struct": "STRUCT(city VARCHAR, zip VARCHAR)",
}


def _sql_text(value: Any) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _sql_literal(value: Any, column_type: str) -> str:
    if value is None:
        return f"CAST(NULL AS {_DUCKDB_TYPES[column_type]})"
    if column_type == "float":
        return "CAST('NaN' AS DOUBLE)" if isnan(value) else f"CAST({float(value)!r} AS DOUBLE)"
    if column_type == "boolean":
        return "TRUE" if value else "FALSE"
    if column_type == "integer":
        return f"CAST({int(value)} AS BIGINT)"
    if column_type == "list":
        return f"CAST([{', '.join('NULL' if item is None else str(int(item)) for item in value)}] AS BIGINT[])"
    if column_type == "struct":
        return f"struct_pack(city := {_sql_text(value['city'])}, zip := {_sql_text(value['zip'])})"
    return f"CAST({_sql_text(value)} AS {_DUCKDB_TYPES[column_type]})"


def _duckdb_relation(decoded: Sequence[tuple[str, str, list[Any]]]) -> duckdb.DuckDBPyRelation:
    names = ", ".join('"' + name.replace('"', '""') + '"' for name, _column_type, _values in decoded)
    rows = zip(*(values for _name, _column_type, values in decoded), strict=True)
    types = [column_type for _name, column_type, _values in decoded]
    values_sql = ", ".join(
        "(" + ", ".join(_sql_literal(value, column_type) for value, column_type in zip(row, types, strict=True)) + ")"
        for row in rows
    )
    return duckdb.sql(f"SELECT * FROM (VALUES {values_sql}) AS source({names})")


def _engine_values(value: Any, engine_name: str) -> Any:
    if isinstance(value, Mapping):
        if "$engine" in value:
            return value["$engine"][engine_name]
        if "$fixtureLookup" in value:
            path = LOOKUP_DIRECTORY / str(value["$fixtureLookup"])
            return {"path": str(path), "format": path.suffix.lstrip(".")}
        return {key: _engine_values(item, engine_name) for key, item in value.items()}
    if isinstance(value, list):
        return [_engine_values(item, engine_name) for item in value]
    return value


def _column_references(value: Any, by_name: Mapping[str, Mapping[str, str]]) -> Any:
    if isinstance(value, Mapping):
        if set(value) == {"$column"}:
            return dict(by_name[str(value["$column"])])
        return {key: _column_references(item, by_name) for key, item in value.items()}
    if isinstance(value, list):
        return [_column_references(item, by_name) for item in value]
    return value


def _duckdb_snapshot(engine: DuckDBEngine, frame: Any) -> tuple[list[str], list[tuple[Any, ...]]]:
    if isinstance(frame, DuckDBSqlPlan) or frame.sql_query().lstrip().upper().startswith("WITH "):
        with engine._tracked_connection() as connection:
            sql = frame.sql if isinstance(frame, DuckDBSqlPlan) else frame.sql_query()
            relation = connection.sql(f"SELECT * FROM ({sql}) AS ow")
            return list(relation.columns), relation.fetchall()
    return list(frame.columns), frame.fetchall()


def _custom_code_nodes(entry: ast.FunctionDef, plan: Sequence[Mapping[str, Any]]) -> set[ast.AST]:
    user_names: set[str] = set()
    for step in plan:
        if step["kind"] != "customCode":
            continue
        try:
            parsed = ast.parse(str(step["params"]["code"]))
        except SyntaxError:
            continue
        for node in ast.walk(parsed):
            if isinstance(node, ast.Name):
                user_names.add(node.id)
            elif isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                user_names.add(node.name)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                user_names.update(alias.asname or alias.name.split(".")[0] for alias in node.names)

    def user_owned(node: ast.AST) -> bool:
        if isinstance(node, ast.Name):
            return node.id in user_names
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            return all((alias.asname or alias.name.split(".")[0]) in user_names for alias in node.names)
        return False

    return {node for node in ast.walk(entry) if user_owned(node)}


def _checked_names(entry: ast.FunctionDef, exempt: set[ast.AST]) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(entry):
        if node in exempt:
            continue
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node is not entry:
            names.add(node.name)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            names.update(alias.asname or alias.name.split(".")[0] for alias in node.names)
    return names
