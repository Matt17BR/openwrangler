from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime.custom_code_scope import CustomCodeScopeError
from openwrangler_runtime.engines import EngineError, PandasEngine, PolarsEngine
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine, DuckDBSqlPlan
from openwrangler_runtime.operations import OperationError, validate_step
from openwrangler_runtime.session import Session, SessionManager

REJECTED_SCOPES = [
    ("future", "from __future__ import annotations\nresult = df", "future imports"),
    ("wildcard", "from math import *\nresult = df", "wildcard imports"),
    ("global", "global result\nresult = df", "global declarations"),
    (
        "nested-nonlocal",
        "value = 1\ndef transform():\n    nonlocal value\n    value += 1\nresult = df",
        "nonlocal declarations",
    ),
    ("return", "return df", "instead of returning"),
    ("yield", "yield df", "instead of yielding"),
    ("yield-from", "yield from ()", "instead of yielding"),
]


def custom_step(code: str, step_id: str = "custom") -> dict[str, Any]:
    return {"id": step_id, "kind": "customCode", "params": {"code": code}}


@pytest.fixture(params=["pandas", "polars", "duckdb"])
def engine_and_frame(request: pytest.FixtureRequest):
    if request.param == "pandas":
        engine = PandasEngine()
        frame = pd.DataFrame({"value": [1, 2]})
    elif request.param == "polars":
        engine = PolarsEngine()
        frame = pl.DataFrame({"value": [1, 2]})
    else:
        engine = DuckDBEngine()
        frame = duckdb.sql("SELECT * FROM (VALUES (1), (2)) source(value)")
    try:
        yield request.param, engine, frame
    finally:
        engine.close()


def accepted_code(backend: str) -> str:
    expression = {
        "pandas": 'frame.assign(value=frame["value"] + offset)',
        "polars": 'frame.with_columns((pl.col("value") + offset).alias("value"))',
        "duckdb": 'frame.project(f"value + {offset} AS value")',
    }[backend]
    return (
        "from math import floor\n"
        "\n"
        "def transform(frame):\n"
        "    offset = floor(1.9)\n"
        f"    return {expression}\n"
        "\n"
        "result = transform(\n"
        "    df\n"
        ")"
    )


def materialize(frame: Any) -> tuple[list[str], list[tuple[Any, ...]]]:
    if isinstance(frame, pd.DataFrame):
        return [str(column) for column in frame.columns], list(frame.itertuples(index=False, name=None))
    if isinstance(frame, pl.LazyFrame):
        frame = frame.collect()
    if isinstance(frame, pl.DataFrame):
        return list(frame.columns), frame.rows()
    if isinstance(frame, DuckDBSqlPlan):
        connection = duckdb.connect(
            config={
                "autoinstall_known_extensions": False,
                "autoload_known_extensions": False,
                "enable_external_file_cache": False,
            }
        )
        try:
            result = connection.execute(frame.sql)
            return [column[0] for column in result.description], result.fetchall()
        finally:
            connection.close()
    return list(frame.columns), frame.fetchall()


def execute_generated(engine: Any, frame: Any, operation: dict[str, Any]) -> Any:
    namespace: dict[str, Any] = {}
    source = engine.compile_plan([operation])
    exec(compile(source, "<generated-custom-code>", "exec"), namespace, namespace)
    return namespace["clean_data"](frame)


@pytest.mark.parametrize(("case_name", "code", "message"), REJECTED_SCOPES)
def test_operation_validation_rejects_incompatible_custom_code_scope(case_name: str, code: str, message: str) -> None:
    with pytest.raises(OperationError, match=message):
        validate_step(custom_step(code, case_name))


def test_operation_validation_rejects_invalid_multiline_syntax() -> None:
    with pytest.raises(OperationError, match=r"invalid Python syntax at line 1"):
        validate_step(custom_step("if True\n    result = df", "invalid-multiline"))


@pytest.mark.parametrize(("_case_name", "code", "message"), REJECTED_SCOPES)
def test_live_and_generated_engine_seams_reject_the_same_scopes(
    engine_and_frame: tuple[str, Any, Any], _case_name: str, code: str, message: str
) -> None:
    _backend, engine, frame = engine_and_frame
    operation = custom_step(code)

    with pytest.raises(EngineError, match=message):
        engine.apply_transform(frame, operation)
    with pytest.raises(CustomCodeScopeError, match=message):
        engine.compile_plan([operation])


def test_import_closure_and_multiline_code_matches_executable_generated_output(
    engine_and_frame: tuple[str, Any, Any],
) -> None:
    backend, engine, frame = engine_and_frame
    operation = validate_step(custom_step(accepted_code(backend)))

    live = engine.apply_transform(frame, operation)
    generated = execute_generated(engine, frame, operation)

    assert materialize(live) == materialize(generated)
    assert materialize(live)[1] == [(2,), (3,)]


def session_state(session: Session) -> dict[str, Any]:
    return {
        "revision": session.revision,
        "committed": id(session.committed),
        "filtered": id(session.filtered),
        "plan": deepcopy(session.plan),
        "boundPlan": deepcopy(session.bound_plan),
        "draftStep": deepcopy(session.draft_step),
        "draftBoundStep": deepcopy(session.draft_bound_step),
        "draftFrame": id(session.draft_frame) if session.draft_frame is not None else None,
        "replaceStepId": session.replace_step_id,
        "schema": deepcopy(session.committed_schema),
        "lineage": deepcopy(session.committed_lineage),
    }


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_invalid_scope_is_rejected_before_new_or_replacement_draft(tmp_path: Path, backend: str) -> None:
    source = tmp_path / f"custom-scope-{backend}.csv"
    source.write_text("value\n1\n2\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": source.name, "path": str(source)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]

    before_new = session_state(session)
    with pytest.raises(EngineError, match="future imports"):
        manager.preview_step(session_id, 0, custom_step(REJECTED_SCOPES[0][1]), 0, 10)
    assert session_state(session) == before_new

    manager.preview_step(session_id, 0, custom_step("result = df"), 0, 10)
    manager.apply_draft(session_id, 1, 0, 10)
    before_replacement = session_state(session)
    with pytest.raises(EngineError, match="wildcard imports"):
        manager.preview_step(
            session_id,
            2,
            custom_step(REJECTED_SCOPES[1][1]),
            0,
            10,
            replace_step_id="custom",
        )
    assert session_state(session) == before_replacement
    assert manager.close_session(session_id, 2) == {"kind": "sessionClosed", "sessionId": session_id}
