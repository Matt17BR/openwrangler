from __future__ import annotations

from datetime import datetime
from math import copysign
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime._column_binding import ColumnBindingError, bind_step
from openwrangler_runtime.engines import DuckDBEngine, PandasEngine, PolarsEngine
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import validate_step
from openwrangler_runtime.protocol_limits_generated import MAX_GENERATED_PYTHON_CODE_UTF8_BYTES
from openwrangler_runtime.session_plan import compile_plan_with_limits, preflight_retained_plan


@pytest.fixture(params=["pandas", "polars", "duckdb"])
def engine(request):
    adapter = {"pandas": PandasEngine, "polars": PolarsEngine, "duckdb": DuckDBEngine}[request.param]()
    try:
        yield adapter
    finally:
        adapter.close()


def input_frame(engine: Any, extra: str | None = None) -> Any:
    data = {
        "n": [1.25, 2.75],
        "text": ["a-x", "b-y"],
        "when": [datetime(2024, 1, 2), datetime(2024, 2, 3)],
    }
    if extra is not None:
        data[extra] = [99, 98]
    if isinstance(engine, PandasEngine):
        return pd.DataFrame(data, index=pd.Index([4, 4], name="row"))
    if isinstance(engine, PolarsEngine):
        return pl.DataFrame(data)
    suffix = "" if extra is None else f', resident AS "{extra}"'
    return duckdb.sql(
        'SELECT n, text, "when"' + suffix + " FROM (VALUES "
        "(1.25::DOUBLE, 'a-x', TIMESTAMP '2024-01-02', 99), "
        "(2.75::DOUBLE, 'b-y', TIMESTAMP '2024-02-03', 98)) data(n, text, \"when\", resident)"
    )


def snapshot(frame: Any) -> tuple[Any, ...]:
    if isinstance(frame, pd.DataFrame):
        return (
            list(frame.columns),
            list(frame.itertuples(index=False, name=None)),
            (list(frame.index), frame.index.names),
            frame.dtypes.tolist(),
        )
    if isinstance(frame, pl.DataFrame):
        return frame.columns, frame.rows(), frame.schema
    return frame.columns, frame.fetchall(), frame.types


def public_step(kind: str, **params: Any) -> dict[str, Any]:
    return validate_step({"id": "output-" + kind, "kind": kind, "params": params})


def bind(engine: Any, frame: Any, public: dict[str, Any]) -> dict[str, Any]:
    schema = engine.schema(frame)
    return bind_step(public, schema, source_lineage(schema))


def generated(engine: Any, plan: list[dict[str, Any]]):
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan(plan), namespace)
    return namespace["clean_data"]


# Each entry is a distinct static renderer, not a copy of the compiler's output policy.
_STATIC_OUTPUTS = [
    ("renameColumn", "text", "newName", {}, ["a-x", "b-y"]),
    ("cloneColumn", "n", "newName", {}, [1.25, 2.75]),
    ("formula", "n", "newColumn", {"operator": "add", "value": 1}, [2.25, 3.75]),
    ("textLength", "text", "newColumn", {}, [3, 3]),
    ("denseRank", "n", "newColumn", {"direction": "asc"}, [1, 2]),
    ("byExample", "text", "newColumn", {}, ["a-x", "b-y"]),
    ("findReplace", "text", "newColumn", {"find": "a", "replacement": "z"}, ["z-x", "b-y"]),
    ("stripText", "text", "newColumn", {}, ["a-x", "b-y"]),
    ("splitText", "text", "newColumn", {"delimiter": "-", "index": 0}, ["a", "b"]),
    ("capitalizeText", "text", "newColumn", {}, ["A-x", "B-y"]),
    ("lowerText", "text", "newColumn", {}, ["a-x", "b-y"]),
    ("upperText", "text", "newColumn", {}, ["A-X", "B-Y"]),
    ("minMaxScale", "n", "newColumn", {}, [0, 1]),
    ("roundNumber", "n", "newColumn", {"decimals": 0}, [1, 3]),
    ("floorNumber", "n", "newColumn", {}, [1, 2]),
    ("ceilNumber", "n", "newColumn", {}, [2, 3]),
    ("formatDatetime", "when", "newColumn", {"format": "%Y"}, ["2024", "2024"]),
]


def operation(engine: Any, frame: Any, case: tuple[Any, ...], target: str) -> dict[str, Any]:
    kind, selected, field, options, _expected = case
    refs = {ref["name"]: ref for ref in source_lineage(engine.schema(frame))}
    params = {**options, field: target}
    if kind == "byExample":
        params.update(
            sourceColumns=[refs[selected]],
            examples=[{"inputs": [value], "output": value} for value in ("a-x", "b-y")],
            program={"kind": "column", "column": refs[selected]},
        )
    else:
        params["leftColumn" if kind == "formula" else "column"] = refs[selected]
    return public_step(kind, **params)


@pytest.mark.parametrize("case", _STATIC_OUTPUTS, ids=[case[0] for case in _STATIC_OUTPUTS])
def test_static_outputs_recheck_actual_input_without_rejecting_harmless_extras(engine, case):
    source = input_frame(engine)
    public = operation(engine, source, case, "flag")
    clean_data = generated(engine, [bind(engine, source, public)])
    for extra in (None, "spare"):
        frame = input_frame(engine, extra)
        before = snapshot(frame)
        bind(engine, frame, public)
        result = clean_data(frame)
        columns, rows = snapshot(result)[:2]
        expected_columns = ["n", "flag", "when"] if case[0] == "renameColumn" else ["n", "text", "when"]
        if extra is not None:
            expected_columns.append(extra)
        if case[0] != "renameColumn":
            expected_columns.append("flag")
        assert columns == expected_columns
        assert [row[columns.index("flag")] for row in rows] == case[4]
        assert [row[columns.index("n")] for row in rows] == [1.25, 2.75]
        if extra is not None:
            assert [row[columns.index(extra)] for row in rows] == [99, 98]
        if isinstance(frame, pd.DataFrame):
            assert result.index.equals(frame.index) and result.index.names == frame.index.names
        assert snapshot(frame) == before

    resident = input_frame(engine, "flag")
    before = snapshot(resident)
    with pytest.raises(ColumnBindingError, match="collides"):
        bind(engine, resident, public)
    try:
        with pytest.raises((ValueError, pl.exceptions.DuplicateError), match="(?i)collid|duplicat|exist"):
            clean_data(resident)
    finally:
        assert snapshot(resident) == before


_REPLACEMENTS = [
    case
    for case in _STATIC_OUTPUTS
    if case[0] not in {"cloneColumn", "formula", "textLength", "denseRank", "byExample"}
]


@pytest.mark.parametrize("case", _REPLACEMENTS, ids=[case[0] for case in _REPLACEMENTS])
def test_explicit_same_source_replacement_keeps_other_columns(engine, case):
    frame = input_frame(engine, "spare")
    before = snapshot(frame)
    public = operation(engine, frame, case, case[1])
    result = generated(engine, [bind(engine, frame, public)])(frame)
    columns, rows = snapshot(result)[:2]
    assert columns == before[0]
    assert [row[columns.index(case[1])] for row in rows] == case[4]
    assert [row[-1] for row in rows] == [99, 98]
    if isinstance(frame, pd.DataFrame):
        assert result.index.equals(frame.index) and result.index.names == frame.index.names
    assert snapshot(frame) == before


@pytest.mark.parametrize("label", [7, ("a", 2)])
def test_pandas_inplace_exemption_uses_one_physical_column(label):
    engine = PandasEngine()
    frame = pd.DataFrame(
        [["a", 91], [None, 81]], columns=pd.Index([label, "spare"]), index=pd.Index([4, 4], name="row")
    )
    before = frame.copy(deep=True)
    ref = source_lineage(engine.schema(frame))[0]
    public = public_step("upperText", column=ref, newColumn=str(label))
    clean_data = generated(engine, [bind(engine, frame, public)])
    result = clean_data(frame)
    assert result.columns.tolist() == [label, "spare"]
    assert type(result.columns[0]) is type(label)
    assert result.iloc[0, 0] == "A" and pd.isna(result.iloc[1, 0])
    pd.testing.assert_series_equal(result.iloc[:, 1], frame.iloc[:, 1])
    pd.testing.assert_frame_equal(frame, before)

    resident = frame.copy(deep=True)
    resident[str(label)] = [99, 98]
    before = resident.copy(deep=True)
    with pytest.raises(ColumnBindingError, match="collides"):
        bind(engine, resident, public)
    try:
        with pytest.raises(ValueError, match="collides"):
            clean_data(resident)
    finally:
        pd.testing.assert_frame_equal(resident, before)


def test_pandas_keeps_unrelated_duplicate_labels_and_rejects_canonical_output_collisions():
    engine = PandasEngine()
    seed = pd.DataFrame({"text": ["a", None]})
    ref = source_lineage(engine.schema(seed))[0]
    for target in ("flag", "7"):
        public = public_step("cloneColumn", column=ref, newName=target)
        clean_data = generated(engine, [bind(engine, seed, public)])
        frame = pd.DataFrame([["a", 91, 92], [None, 81, 82]], columns=pd.Index(["text", 7, 7]), index=pd.Index([3, 3]))
        before = frame.copy(deep=True)
        if target == "7":
            with pytest.raises(ColumnBindingError, match="collides"):
                bind(engine, frame, public)
            try:
                with pytest.raises(ValueError, match="collides"):
                    clean_data(frame)
            finally:
                pd.testing.assert_frame_equal(frame, before)
        else:
            bind(engine, frame, public)
            result = clean_data(frame)
            pd.testing.assert_frame_equal(result.iloc[:, :-1], frame)
            pd.testing.assert_series_equal(result.iloc[:, -1], frame.iloc[:, 0].rename("flag"))
            pd.testing.assert_frame_equal(frame, before)


def test_output_availability_is_checked_after_each_prior_step(engine):
    frame = input_frame(engine, "flag")
    before = snapshot(frame)
    refs = source_lineage(engine.schema(frame))
    drop = bind(engine, frame, public_step("dropColumns", columns=[refs[-1]]))
    middle = engine.apply_transform(frame, drop)
    clone = bind(engine, middle, public_step("cloneColumn", column=refs[1], newName="flag"))
    result = generated(engine, [drop, clone])(frame)
    assert snapshot(result)[0] == ["n", "text", "when", "flag"]
    assert [row[-1] for row in snapshot(result)[1]] == ["a-x", "b-y"]
    assert snapshot(frame) == before


def test_custom_code_cannot_introduce_a_later_static_output_name(engine):
    code = {
        "pandas": "result = df.assign(flag=99) if df.iloc[0, 0] > 10 else df",
        "polars": "result = df.with_columns(pl.lit(99).alias('flag')) if df[0, 'n'] > 10 else df",
        "duckdb": "result = df.project('*, 99 AS flag') if df.aggregate('max(n)').fetchone()[0] > 10 else df",
    }[engine.name]
    custom = public_step("customCode", code=code)
    seed = input_frame(engine)
    middle = engine.apply_transform(seed, custom)
    ref = source_lineage(engine.schema(middle))[1]
    public = public_step("cloneColumn", column=ref, newName="flag")
    clean_data = generated(engine, [custom, bind(engine, middle, public)])
    assert [row[-1] for row in snapshot(clean_data(seed))[1]] == ["a-x", "b-y"]
    if isinstance(engine, PandasEngine):
        frame = seed.assign(n=100.0)
    elif isinstance(engine, PolarsEngine):
        frame = seed.with_columns(pl.lit(100.0).alias("n"))
    else:
        frame = seed.project("* REPLACE (100.0::DOUBLE AS n)")
    before = snapshot(frame)
    introduced = engine.apply_transform(frame, custom)
    with pytest.raises(ColumnBindingError, match="collides"):
        bind(engine, introduced, public)
    try:
        with pytest.raises(ValueError, match="collides"):
            clean_data(frame)
    finally:
        assert snapshot(frame) == before


def test_polars_lazy_guards_use_metadata_without_collecting_rows():
    engine = PolarsEngine()
    seed = pl.DataFrame({"a": [1, None]})
    public = public_step("cloneColumn", column=source_lineage(engine.schema(seed))[0], newName="Flag")
    clean_data = generated(engine, [bind(engine, seed, public)])
    harmless = seed.with_columns(pl.Series("flag", [99, 98]))
    result = clean_data(harmless.lazy())
    assert isinstance(result, pl.LazyFrame)
    assert result.collect().rows() == [(1, 99, 1), (None, 98, None)]
    assert result.collect_schema().names() == ["a", "flag", "Flag"]
    resident = harmless.rename({"flag": "Flag"})
    calls = []

    def observe(frame):
        calls.append(frame.height)
        return frame

    lazy = resident.lazy().map_batches(observe, schema=dict(resident.schema))
    with pytest.raises(ValueError, match="collides"):
        clean_data(lazy)
    assert calls == []
    assert resident.rows() == [(1, 99), (None, 98)]


def test_duckdb_rename_chain_keeps_private_relation_and_evaluates_source_once():
    engine = DuckDBEngine()
    calls = []
    with duckdb.connect() as connection:

        def counted(value):
            calls.append(value)
            return value

        connection.create_function("counted", counted, ["BIGINT"], "BIGINT", side_effects=True)
        frame = connection.sql("SELECT counted(i) AS a, -0.0::DOUBLE AS payload FROM range(3) r(i)")
        middle = frame
        plan = []
        for target in ('middle"quoted', "ow", "a"):
            ref = source_lineage(engine.schema(middle))[0]
            plan.append(bind(engine, middle, public_step("renameColumn", column=ref, newName=target)))
            old_name = ref["name"].replace('"', '""')
            new_name = target.replace('"', '""')
            middle = middle.project(f'* RENAME ("{old_name}" AS "{new_name}")')
        result = generated(engine, plan)(frame)
        assert calls == []
        rows = result.fetchall()
        assert [row[0] for row in rows] == [0, 1, 2] and calls == [0, 1, 2]
        assert all(row[1] == 0 and copysign(1, row[1]) == -1 for row in rows)
        assert result.columns == frame.columns == ["a", "payload"]
    engine.close()


def test_generated_output_names_remain_literal_text(engine):
    frame = input_frame(engine)
    before = snapshot(frame)
    target = "quote'\"slash\\雪"
    ref = source_lineage(engine.schema(frame))[0]
    public = public_step("cloneColumn", column=ref, newName=target)
    result = generated(engine, [bind(engine, frame, public)])(frame)
    assert snapshot(result)[0] == ["n", "text", "when", target]
    assert [row[-1] for row in snapshot(result)[1]] == [1.25, 2.75]
    assert snapshot(frame) == before


def test_large_output_name_remains_within_the_existing_code_capacity(engine):
    frame = input_frame(engine)
    before = snapshot(frame)
    ref = source_lineage(engine.schema(frame))[0]
    public = public_step("cloneColumn", column=ref, newName="x" * 2_150_000)
    preflight_retained_plan([public])
    plan = [bind(engine, frame, public)]
    code = compile_plan_with_limits(engine, plan)
    assert len(code.encode("utf-8")) <= MAX_GENERATED_PYTHON_CODE_UTF8_BYTES
    namespace: dict[str, Any] = {}
    exec(code, namespace)
    result = namespace["clean_data"](frame)
    assert result.columns[-1] == public["params"]["newName"]
    assert [row[-1] for row in snapshot(result)[1]] == [1.25, 2.75]
    assert snapshot(frame) == before
