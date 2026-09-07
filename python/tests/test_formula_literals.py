from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import pytest

from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines import EngineError
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import OperationError, validate_step
from openwrangler_runtime.session import SessionManager


def formula(value: Any, operator: str = "add") -> dict[str, Any]:
    return {
        "id": "literal",
        "kind": "formula",
        "params": {
            "leftColumn": {"id": "c:source:0", "name": "value"},
            "operator": operator,
            "value": value,
            "newColumn": "result",
        },
    }


@pytest.mark.parametrize("value", ["0", "-1", str(2**53 + 1), str(2**60), str(2**127 - 8), "1" + "0" * 308])
def test_formula_validation_retains_exact_integer_text(value: str) -> None:
    original = formula(value)
    assert validate_step(original) == original
    assert json.loads(json.dumps(validate_step(original)))["params"]["value"] == value


@pytest.mark.parametrize(
    "value",
    ["", " 1", "1 ", "1\n", "+1", "01", "-0", "-01", "1.0", "1e3", "NaN", "Infinity", "١", "9" * 309, "1" + "0" * 309],
)
def test_formula_rejects_noncanonical_or_unbounded_integer_text(value: str) -> None:
    with pytest.raises(OperationError):
        validate_step(formula(value))


@pytest.mark.parametrize("value", [0, -1, 2**60, 0.1, 2.5, 1e21, 1e30])
def test_formula_legacy_numeric_values_keep_their_type(value: int | float) -> None:
    normalized = validate_step(formula(value))["params"]["value"]
    assert normalized == value
    assert type(normalized) is type(value)


def integer_result(page: dict[str, Any]) -> list[int | None]:
    result = []
    for row in page["rows"]:
        cell = row["values"][-1]
        assert cell["kind"] in {"integer", "null"}
        result.append(None if cell["isNull"] else int(cell["raw"]))
    return result


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize("literal", [str(2**53 + 1), str(2**60)])
def test_formula_integer_text_survives_public_apply_generated_execution_and_replay(
    tmp_path: Path, backend: str, literal: str
) -> None:
    path = tmp_path / "integers.parquet"
    pd.DataFrame({"value": pd.array([0, 7, None], dtype="Int64")}).to_parquet(path, index=False)
    source_bytes = path.read_bytes()
    source = {"kind": "file", "path": str(path), "label": path.name}
    manager = SessionManager()
    try:
        opened = manager.open_session(source, backend=backend, mode="editing", page_size=3)
        session_id = opened["metadata"]["sessionId"]
        expected = [int(literal), int(literal) + 7, None]
        preview = manager.preview_step(session_id, 0, json.loads(json.dumps(formula(literal))), 0, 3)
        assert integer_result(preview["page"]) == expected
        applied = manager.apply_draft(session_id, preview["revision"], 0, 3)
        assert integer_result(applied["page"]) == expected
        persisted = json.loads(json.dumps(applied["metadata"]["steps"]))
        assert persisted[0]["params"]["value"] == literal
        session = manager.sessions[session_id]
        namespace: dict[str, Any] = {}
        exec(applied["code"], namespace, namespace)
        generated = namespace["clean_data"](session.original)
        assert integer_result(session.engine.page(generated, 0, 3)) == expected

        reopened = manager.open_session(source, backend=backend, mode="editing", page_size=3)
        replay_id = reopened["metadata"]["sessionId"]
        replay = manager.preview_step(replay_id, 0, persisted[0], 0, 3)
        replayed = manager.apply_draft(replay_id, replay["revision"], 0, 3)
        assert integer_result(replayed["page"]) == expected
        assert replayed["metadata"]["steps"][0]["params"]["value"] == literal

        before = deepcopy(
            manager.get_page(session_id, applied["revision"], 0, 3, {"logic": "and", "filters": [], "sort": []})
        )
        with pytest.raises(EngineError):
            manager.preview_step(session_id, applied["revision"], formula("1\n"), 0, 3)
        assert (
            manager.get_page(session_id, applied["revision"], 0, 3, {"logic": "and", "filters": [], "sort": []})
            == before
        )
        assert path.read_bytes() == source_bytes
    finally:
        manager.close_all()


def test_arrow_integer_modulo_uses_the_literal_that_was_entered(tmp_path: Path) -> None:
    value = 2**53 + 1
    path = tmp_path / "arrow.parquet"
    pd.DataFrame({"value": pd.Series([value, value + 1, None], dtype="uint64[pyarrow]")}).to_parquet(path, index=False)
    before = path.read_bytes()
    manager = SessionManager()
    try:
        opened = manager.open_session(
            {"kind": "file", "path": str(path), "label": path.name}, backend="pandas", mode="editing", page_size=3
        )
        session_id = opened["metadata"]["sessionId"]
        preview = manager.preview_step(session_id, 0, formula(str(value), "modulo"), 0, 3)
        assert integer_result(preview["page"]) == [0, 1, None]
        applied = manager.apply_draft(session_id, preview["revision"], 0, 3)
        session = manager.sessions[session_id]
        namespace: dict[str, Any] = {}
        exec(applied["code"], namespace, namespace)
        generated = namespace["clean_data"](session.original)
        assert integer_result(session.engine.page(generated, 0, 3)) == [0, 1, None]
        assert applied["metadata"]["steps"][0]["params"]["value"] == str(value)
        assert path.read_bytes() == before
    finally:
        manager.close_all()


@pytest.mark.parametrize("literal", [str(-(2**127) - 1), str(2**128)])
def test_duckdb_refuses_integer_text_that_would_become_a_floating_literal(tmp_path: Path, literal: str) -> None:
    path = tmp_path / "values.csv"
    path.write_text("value\n0\n7\n", encoding="utf-8")
    original = path.read_bytes()
    manager = SessionManager()
    try:
        opened = manager.open_session(
            {"kind": "file", "path": str(path), "label": path.name}, backend="duckdb", mode="editing", page_size=2
        )
        session_id = opened["metadata"]["sessionId"]
        before = deepcopy(manager.get_page(session_id, 0, 0, 2, {"logic": "and", "filters": [], "sort": []}))
        with pytest.raises(EngineError, match="128-bit"):
            manager.preview_step(session_id, 0, formula(literal), 0, 2)
        assert manager.get_page(session_id, 0, 0, 2, {"logic": "and", "filters": [], "sort": []}) == before
        assert manager.sessions[session_id].plan == []
        assert path.read_bytes() == original
    finally:
        manager.close_all()


@pytest.mark.parametrize(
    ("literal", "raw_type"),
    [(str(-(2**127)), "HUGEINT"), (str(2**127 - 1), "HUGEINT"), (str(2**128 - 1), "UHUGEINT")],
)
def test_duckdb_integer_text_retains_native_literal_capacity(literal: str, raw_type: str) -> None:
    engine = DuckDBEngine()
    source = duckdb.sql(f"SELECT value::{raw_type} AS value FROM (VALUES (0), (NULL)) source(value)")
    before = source.fetchall()
    try:
        schema = engine.schema(source)
        lineage = source_lineage(schema)
        operation = bind_step(validate_step(formula(literal)), schema, lineage)
        live = engine.apply_transform(source, operation)
        namespace: dict[str, Any] = {}
        exec(engine.compile_plan([operation]), namespace, namespace)
        generated = namespace["clean_data"](source)
        expected = [(0, int(literal)), (None, None)]
        assert engine._terminal_rows(live, "SELECT * FROM ow") == expected
        assert generated.fetchall() == expected
        assert str(generated.types[-1]) == raw_type
        assert source.fetchall() == before
    finally:
        engine.close()
