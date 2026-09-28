from __future__ import annotations

from pathlib import Path
from typing import Any

import duckdb
import polars as pl
import pytest
from generated_code_test_support import (
    ENGINE_NAMES,
    UNSUPPORTED_OPERATIONS,
    assert_same_result,
    bind_plan,
    engine_for,
    execute_generated,
    load_generated_code_plans,
    source_frame,
)

from openwrangler_runtime.engines import EngineError
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine
from openwrangler_runtime.operations import OPERATION_DEFINITIONS

PLANS = load_generated_code_plans()
VARIANTS = [("pandas", False), ("polars", False), ("polars", True), ("duckdb", False)]


@pytest.fixture(autouse=True)
def forbid_conversions(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("Generated-code fixture plans must stay engine-native.")

    for frame_type in (pl.DataFrame, pl.LazyFrame):
        monkeypatch.setattr(frame_type, "to_pandas", refuse, raising=False)
    for method in ("df", "fetchdf", "fetch_df", "pl", "arrow", "fetch_arrow_table", "to_arrow_table"):
        monkeypatch.setattr(duckdb.DuckDBPyRelation, method, refuse, raising=False)


def run_plan(engine_name: str, plan: dict[str, Any], lazy: bool, tmp_path: Path) -> None:
    engine = engine_for(engine_name)
    frame = source_frame(engine_name, plan.get("columns"), lazy=lazy)
    try:
        bound_steps, live = bind_plan(engine, frame, plan["steps"], engine_name)
        generated = execute_generated(engine, frame, engine.compile_plan(bound_steps), tmp_path)
        if isinstance(engine, DuckDBEngine) and bound_steps[-1]["kind"] == "customCode":
            # A captured Custom Code result is readable only through the engine that captured it.
            assert engine.page(live, 0, 10_000)["rows"] == engine.page(generated, 0, 10_000)["rows"]
        else:
            assert_same_result(engine, live, generated)
    finally:
        engine.close()


def test_the_fixture_has_one_plan_per_operation_in_catalog_order() -> None:
    assert list(PLANS["oneStep"]) == [definition.kind for definition in OPERATION_DEFINITIONS]
    assert all(len(plan["steps"]) == 1 for plan in PLANS["oneStep"].values())
    assert 3 <= len(PLANS["multiStep"]) <= 4
    assert all(4 <= len(plan["steps"]) <= 8 for plan in PLANS["multiStep"])


@pytest.mark.parametrize(("engine_name", "kind"), sorted(UNSUPPORTED_OPERATIONS))
def test_unsupported_operations_are_refused_live(engine_name: str, kind: str) -> None:
    with pytest.raises(EngineError):
        run_plan(engine_name, PLANS["oneStep"][kind], False, Path())


@pytest.mark.parametrize("kind", list(PLANS["oneStep"]))
@pytest.mark.parametrize(("engine_name", "lazy"), VARIANTS, ids=["pandas", "polars", "polars-lazy", "duckdb"])
def test_one_step_plans_generate_code_that_matches_live(
    engine_name: str, lazy: bool, kind: str, tmp_path: Path
) -> None:
    if (engine_name, kind) in UNSUPPORTED_OPERATIONS:
        pytest.skip(f"{engine_name} doesn't run {kind}.")
    run_plan(engine_name, PLANS["oneStep"][kind], lazy, tmp_path)


@pytest.mark.parametrize("name", [plan["name"] for plan in PLANS["multiStep"]])
@pytest.mark.parametrize(("engine_name", "lazy"), VARIANTS, ids=["pandas", "polars", "polars-lazy", "duckdb"])
def test_multi_step_plans_generate_code_that_matches_live(
    engine_name: str, lazy: bool, name: str, tmp_path: Path
) -> None:
    plan = next(plan for plan in PLANS["multiStep"] if plan["name"] == name)
    run_plan(engine_name, plan, lazy, tmp_path)


def test_every_engine_is_covered() -> None:
    assert {engine_name for engine_name, _lazy in VARIANTS} == set(ENGINE_NAMES)
