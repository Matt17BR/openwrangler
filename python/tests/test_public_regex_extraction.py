from __future__ import annotations

import re
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine
from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.engines.polars_engine import PolarsEngine
from openwrangler_runtime.operations import OperationError, validate_step
from openwrangler_runtime.portable_regex import portable_regex_contract

TEXT_LIMIT_MESSAGE = (
    "Regex extraction source values must contain at most 8,192 Unicode scalar values and 8,192 UTF-8 bytes."
)


def regex_step(pattern: str, group: int, output: str = "extracted") -> dict[str, Any]:
    return {
        "id": "regex-public",
        "kind": "extractRegexGroup",
        "params": {
            "column": {"id": "c:source:0", "name": "value", "position": 0},
            "pattern": pattern,
            "group": group,
            "newColumn": output,
        },
    }


def rows(frame: Any) -> list[tuple[Any, ...]]:
    if isinstance(frame, pd.DataFrame):
        return [tuple(None if pd.isna(value) else value for value in row) for row in frame.itertuples(index=False)]
    if isinstance(frame, pl.LazyFrame):
        frame = frame.collect()
    if isinstance(frame, pl.DataFrame):
        return list(frame.iter_rows())
    if hasattr(frame, "sql"):
        return duckdb.sql(frame.sql).fetchall()
    return frame.fetchall()


def execute_generated(engine: Any, frame: Any, step: dict[str, Any]) -> Any:
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([step]), namespace, namespace)
    return namespace["clean_data"](frame)


def frames(values: list[str | None]) -> list[tuple[Any, Any]]:
    quoted_values = []
    for value in values:
        quoted_values.append("NULL" if value is None else "'" + value.replace("'", "''") + "'")
    literals = ", ".join(f"({value})" for value in quoted_values)
    return [
        (PandasEngine(), pd.DataFrame({"value": values})),
        (PolarsEngine(), pl.DataFrame({"value": values})),
        (DuckDBEngine(), duckdb.sql(f"SELECT * FROM (VALUES {literals}) source(value)")),
    ]


@pytest.mark.parametrize(
    ("pattern", "group", "values", "expected"),
    [
        ("([A-Z]{1,4})-([0-9]{2})", 0, ["AB-12", "none", None], ["AB-12", None, None]),
        ("([A-Z]{1,4})-([0-9]{2})", 2, ["AB-12", "none", None], ["12", None, None]),
        ("(a)?", 1, ["ba", "a", "x"], [None, "a", None]),
        ("()", 1, ["x", ""], ["", ""]),
        ("a?", 0, ["ba", "a", None], ["", "a", None]),
        ("(é{1,4})", 1, ["😀ééz", "none"], ["éé", None]),
        ("([A\\-Z]+)", 1, ["A-Z", "---", "none"], ["A-Z", "---", None]),
        ("([a-z]{1,4})", 1, ["one two"], ["one"]),
        ("(a)(b)(c)(d)(e)(f)(g)(h)(i)", 9, ["abcdefghi", "none"], ["i", None]),
    ],
)
def test_public_regex_live_and_generated_semantics(
    pattern: str, group: int, values: list[str | None], expected: list[str | None]
) -> None:
    step = regex_step(pattern, group)
    for engine, frame in frames(values):
        baseline = rows(frame)
        assert [row[-1] for row in rows(engine.apply_transform(frame, step))] == expected
        assert rows(frame) == baseline
        assert [row[-1] for row in rows(execute_generated(engine, frame, step))] == expected
        assert rows(frame) == baseline


@pytest.mark.parametrize(
    "pattern",
    [
        "()?",
        "(a*)?",
        "(a{0})?",
        "(a{0,2})?",
        "a*aa+b",
        "a{0,20}a{0,20}a{0,20}a{0,20}a{0,20}a{0,20}b",
        "a|b",
        "\\d+",
        "[-A]",
        "[A-]",
    ],
)
def test_public_regex_decoder_rejects_nonportable_or_nullable_optional_patterns(pattern: str) -> None:
    with pytest.raises(OperationError):
        validate_step(regex_step(pattern, 1 if "(" in pattern else 0))


def test_public_regex_shared_contract_rejects_lone_surrogates_and_nul() -> None:
    for pattern in ("\ud800", "\udfff", "\0"):
        with pytest.raises(ValueError):
            portable_regex_contract(pattern, 0)


def test_public_regex_contract_bounds_minimum_match_width_including_capture_repeats() -> None:
    portable_regex_contract("(a{1000})" + "a{1000}" * 7, 1)
    with pytest.raises(ValueError, match="minimum match width"):
        portable_regex_contract("(a{1000})" + "a{1000}" * 8, 1)
    with pytest.raises(ValueError, match="UTF-8 bytes"):
        portable_regex_contract("😀{1000}😀{1000}😀{49}", 0)
    with pytest.raises(ValueError, match="UTF-8 bytes"):
        portable_regex_contract("[😀]{1000}[😀]{1000}[😀]{49}", 0)


@pytest.mark.parametrize("output", ["value", "__open_wrangler_internal_row_id_0"])
def test_public_regex_generated_rejects_colliding_and_private_outputs_before_execution(
    output: str,
) -> None:
    for engine, frame in frames(["a"]):
        baseline = rows(frame)
        with pytest.raises(Exception, match="duplicate|reserved private"):
            execute_generated(engine, frame, regex_step("(a)", 1, output))
        assert rows(frame) == baseline


@pytest.mark.parametrize("output", ["first\nsecond", "first\rsecond"])
def test_public_regex_generated_rejects_multiline_output_names_before_execution(output: str) -> None:
    for engine, frame in frames(["a"]):
        baseline = rows(frame)
        with pytest.raises(Exception, match="single-line"):
            execute_generated(engine, frame, regex_step("(a)", 1, output))
        assert rows(frame) == baseline


def test_public_regex_duckdb_rejects_casefold_output_before_live_or_generated_execution() -> None:
    frame = duckdb.sql("SELECT 'a' AS value, 'keep' AS RESULT")
    step = regex_step("(a)", 1, "result")
    baseline = rows(frame)
    with pytest.raises(Exception, match="differs? only by case"):
        DuckDBEngine().apply_transform(frame, step)
    with pytest.raises(Exception, match="differs? only by case"):
        execute_generated(DuckDBEngine(), frame, step)
    assert rows(frame) == baseline


@pytest.mark.parametrize("length", [8_192, 8_193])
def test_public_regex_text_limit_is_identical_in_live_and_generated_paths(length: int) -> None:
    step = regex_step("(a{1,1000})", 1)
    for engine, frame in frames(["a" * length]):
        if length == 8_192:
            assert rows(engine.apply_transform(frame, step))[0][-1] == "a" * 1_000
            assert rows(execute_generated(engine, frame, step))[0][-1] == "a" * 1_000
        else:
            with pytest.raises(Exception, match=re.escape(TEXT_LIMIT_MESSAGE)):
                engine.apply_transform(frame, step)
            with pytest.raises(Exception, match=re.escape(TEXT_LIMIT_MESSAGE)):
                execute_generated(engine, frame, step)


@pytest.mark.parametrize("length", [2_048, 2_049])
def test_public_regex_astral_text_limit_is_identical_in_live_and_generated_paths(length: int) -> None:
    step = regex_step("(😀{1,1000})", 1)
    for engine, frame in frames(["😀" * length]):
        if length == 2_048:
            assert rows(engine.apply_transform(frame, step))[0][-1] == "😀" * 1_000
            assert rows(execute_generated(engine, frame, step))[0][-1] == "😀" * 1_000
        else:
            with pytest.raises(Exception, match=re.escape(TEXT_LIMIT_MESSAGE)):
                engine.apply_transform(frame, step)
            with pytest.raises(Exception, match=re.escape(TEXT_LIMIT_MESSAGE)):
                execute_generated(engine, frame, step)


def test_public_regex_output_name_utf8_boundary() -> None:
    public_step = regex_step("(a)", 1, "é" * 512)
    public_step["params"]["column"] = {"id": "c:source:0", "name": "value"}
    validate_step(public_step)
    public_step = regex_step("(a)", 1, "é" * 513)
    public_step["params"]["column"] = {"id": "c:source:0", "name": "value"}
    with pytest.raises(OperationError):
        validate_step(public_step)


@pytest.mark.parametrize("output", ["first\nsecond", "first\rsecond"])
def test_public_regex_output_name_must_be_single_line(output: str) -> None:
    public_step = regex_step("(a)", 1, output)
    public_step["params"]["column"] = {"id": "c:source:0", "name": "value"}
    with pytest.raises(OperationError, match="single-line"):
        validate_step(public_step)
