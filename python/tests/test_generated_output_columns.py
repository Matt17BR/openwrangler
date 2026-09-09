from __future__ import annotations

from datetime import datetime
from math import copysign
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime._column_binding import ColumnBindingError, bind_step
from openwrangler_runtime.engines import DuckDBEngine, EngineError, PandasEngine, PolarsEngine
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import validate_step
from openwrangler_runtime.protocol_limits_generated import MAX_GENERATED_PYTHON_CODE_UTF8_BYTES
from openwrangler_runtime.session import SessionManager
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


def test_duckdb_rename_chain_keeps_private_relation_and_evaluates_only_on_retrieval():
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
        clean_data = generated(engine, plan)
        assert calls == []
        result = clean_data(frame)
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


@pytest.mark.parametrize("case", _STATIC_OUTPUTS, ids=[case[0] for case in _STATIC_OUTPUTS])
def test_duckdb_static_outputs_reject_casefold_residents(case):
    engine = DuckDBEngine()
    try:
        seed = input_frame(engine)
        public = operation(engine, seed, case, "Flag")
        clean_data = generated(engine, [bind(engine, seed, public)])
        resident = input_frame(engine, "flag")
        before = snapshot(resident)
        try:
            with pytest.raises(ValueError, match="(?i)collid|case"):
                clean_data(resident)
        finally:
            assert snapshot(resident) == before
    finally:
        engine.close()


@pytest.mark.parametrize("first_kind", ["cloneColumn", "customCode"])
def test_duckdb_public_generated_plan_cannot_read_a_casefold_resident(tmp_path, first_kind):
    seed_path = tmp_path / "seed.csv"
    resident_path = tmp_path / "resident.csv"
    seed_path.write_text("key\n2\n3\n", encoding="utf-8")
    resident_path.write_text(
        "key,flag\n2,99\n3,98\n" if first_kind == "cloneColumn" else "key\n20\n30\n", encoding="utf-8"
    )
    before_files = [path.read_bytes() for path in (seed_path, resident_path)]
    manager = SessionManager()
    try:
        opened = manager.open_session(
            {"kind": "file", "label": seed_path.name, "path": str(seed_path)}, backend="duckdb", page_size=10
        )
        session_id = opened["metadata"]["sessionId"]
        column = opened["metadata"]["schema"][0]
        first_step = (
            public_step("cloneColumn", column={"id": column["id"], "name": column["name"]}, newName="Flag")
            if first_kind == "cloneColumn"
            else public_step(
                "customCode",
                code="result = df.project('key + 90 AS \"KEY\", key AS key') "
                'if df.aggregate("max(key)").fetchone()[0] > 10 else df',
            )
        )
        preview = manager.preview_step(session_id, 0, first_step, 0, 10)
        confirmed = manager.apply_draft(session_id, preview["revision"], 0, 10)
        formula_source = "Flag" if first_kind == "cloneColumn" else "key"
        column = next(item for item in confirmed["metadata"]["schema"] if item["name"] == formula_source)
        formula = public_step(
            "formula",
            leftColumn={"id": column["id"], "name": column["name"]},
            operator="add",
            value=1,
            newColumn="plus",
        )
        preview = manager.preview_step(session_id, confirmed["revision"], formula, 0, 10)
        confirmed = manager.apply_draft(session_id, preview["revision"], 0, 10)
        column = next(item for item in confirmed["metadata"]["schema"] if item["name"] == "plus")
        select = public_step("selectColumns", columns=[{"id": column["id"], "name": column["name"]}])
        preview = manager.preview_step(session_id, confirmed["revision"], select, 0, 10)
        confirmed = manager.apply_draft(session_id, preview["revision"], 0, 10)
        namespace: dict[str, Any] = {}
        exec(confirmed["code"], namespace)
        clean_data = namespace["clean_data"]
        seed = duckdb.sql("SELECT * FROM (VALUES (2), (3)) source(key)")
        before = snapshot(seed)
        result = clean_data(seed)
        assert result.columns == ["plus"] and result.fetchall() == [(3,), (4,)]
        assert snapshot(seed) == before

        resident = manager.open_session(
            {"kind": "file", "label": resident_path.name, "path": str(resident_path)}, backend="duckdb", page_size=10
        )
        resident_id = resident["metadata"]["sessionId"]
        column = resident["metadata"]["schema"][0]
        resident_step = (
            public_step("cloneColumn", column={"id": column["id"], "name": column["name"]}, newName="Flag")
            if first_kind == "cloneColumn"
            else first_step
        )
        before_page = manager.get_page(resident_id, 0, 0, 10, resident["metadata"]["filterModel"])
        with pytest.raises(EngineError, match="case"):
            manager.preview_step(resident_id, 0, resident_step, 0, 10)
        assert manager.get_page(resident_id, 0, 0, 10, resident["metadata"]["filterModel"]) == before_page

        caller = duckdb.sql(
            "SELECT * FROM (VALUES (2, 99), (3, 98)) source(key, flag)"
            if first_kind == "cloneColumn"
            else "SELECT * FROM (VALUES (20), (30)) source(key)"
        )
        before = snapshot(caller)
        try:
            with pytest.raises(ValueError, match="(?i)collid|case"):
                clean_data(caller)
        finally:
            assert snapshot(caller) == before
    finally:
        manager.close_all()
        assert not manager.sessions
        assert [path.read_bytes() for path in (seed_path, resident_path)] == before_files


@pytest.mark.parametrize("empty", [False, True])
@pytest.mark.parametrize("mixed", [False, True], ids=["all-rename-private", "mixed"])
def test_duckdb_case_only_rename_preserves_the_selected_source(empty, mixed):
    engine = DuckDBEngine()
    try:
        with duckdb.connect() as connection:
            query = 'SELECT value AS "Mi""X", payload FROM (VALUES (\'a\', 99), (NULL, 98)) source(value, payload)'
            if empty:
                query += " WHERE FALSE"
            frame = duckdb.sql(query) if mixed else connection.sql(query)
            before = snapshot(frame)
            ref = source_lineage(engine.schema(frame))[0]
            rename = bind(engine, frame, public_step("renameColumn", column=ref, newName='mi"x'))
            plan = [rename]
            if mixed:
                middle = frame.project('* RENAME ("Mi""X" AS "mi""x")')
                ref = source_lineage(engine.schema(middle))[0]
                plan.append(bind(engine, middle, public_step("cloneColumn", column=ref, newName="copy")))
            result = generated(engine, plan)(frame)
            assert result.columns == ['mi"x', "payload", *(["copy"] if mixed else [])]
            expected = [("a", 99, "a"), (None, 98, None)] if mixed else [("a", 99), (None, 98)]
            assert result.fetchall() == ([] if empty else expected)
            assert snapshot(frame) == before
    finally:
        engine.close()


@pytest.mark.parametrize("kind", ["upperText", "cloneColumn"])
def test_duckdb_casefold_rule_distinguishes_optional_append_and_unicode_names(kind):
    engine = DuckDBEngine()
    try:
        seed = input_frame(engine)
        ref = source_lineage(engine.schema(seed))[1]
        public = (
            public_step("upperText", column=ref, newColumn="TEXT")
            if kind == "upperText"
            else public_step("cloneColumn", column=ref, newName="STRASSE")
        )
        clean_data = generated(engine, [bind(engine, seed, public)])
        frame = seed if kind == "upperText" else input_frame(engine, "Straße")
        before = snapshot(frame)
        try:
            with pytest.raises(ValueError, match="(?i)collid|case"):
                clean_data(frame)
        finally:
            assert snapshot(frame) == before
    finally:
        engine.close()


def test_pandas_case_distinct_output_preserves_both_columns():
    engine = PandasEngine()
    frame = pd.DataFrame({"key": [2, None], "flag": [99, 98]}, index=pd.Index([4, 4], name="row"))
    before = frame.copy(deep=True)
    ref = source_lineage(engine.schema(frame))[0]
    public = public_step("cloneColumn", column=ref, newName="Flag")
    result = generated(engine, [bind(engine, frame, public)])(frame)
    pd.testing.assert_frame_equal(result.iloc[:, :-1], frame)
    pd.testing.assert_series_equal(result["Flag"], frame.iloc[:, 0].rename("Flag"))
    pd.testing.assert_frame_equal(frame, before)


@pytest.mark.parametrize("kind", ["oneHotEncode", "multiLabelBinarize"])
@pytest.mark.parametrize("collision", ["resident", "generated-pair"])
def test_duckdb_categorical_outputs_reject_casefold_collisions(kind, collision):
    engine = DuckDBEngine()
    try:
        seed = duckdb.sql("SELECT * FROM (VALUES ('x', 2), ('y', 3)) source(cat, value)")
        ref = source_lineage(engine.schema(seed))[0]
        params = (
            {"columns": [ref], "prefixSeparator": "_", "dropOriginal": False}
            if kind == "oneHotEncode"
            else {"column": ref, "delimiter": "|", "prefix": "cat_", "dropOriginal": False}
        )
        clean_data = generated(engine, [bind(engine, seed, public_step(kind, **params))])
        before = snapshot(seed)
        result = clean_data(seed)
        assert result.columns == ["cat", "value", "cat_x", "cat_y"]
        assert result.fetchall() == [("x", 2, 1, 0), ("y", 3, 0, 1)]
        assert snapshot(seed) == before

        frame = duckdb.sql(
            "SELECT * FROM (VALUES ('x', 2, 99), ('y', 3, 98)) source(cat, value, CAT_X)"
            if collision == "resident"
            else "SELECT * FROM (VALUES ('x', 2), ('X', 3)) source(cat, value)"
        )
        before = snapshot(frame)
        try:
            with pytest.raises(ValueError, match="(?i)case|collid"):
                clean_data(frame)
        finally:
            assert snapshot(frame) == before
    finally:
        engine.close()


def test_duckdb_generated_plan_rejects_ambiguous_input_before_native_projection():
    engine = DuckDBEngine()
    try:
        seed = duckdb.sql("SELECT 2 AS key")
        ref = source_lineage(engine.schema(seed))[0]
        public = public_step("cloneColumn", column=ref, newName="flag")
        clean_data = generated(engine, [bind(engine, seed, public)])
        result = clean_data(seed)
        assert result.columns == ["key", "flag"] and result.fetchall() == [(2, 2)]
        assert seed.columns == ["key"] and seed.fetchall() == [(2,)]

        caller = duckdb.sql("SELECT 99 AS KEY, 2 AS key")
        before = snapshot(caller)
        with pytest.raises(EngineError, match="differ only by case"):
            engine.validate_column_addressability(caller)
        try:
            with pytest.raises(ValueError, match="(?i)case|collid"):
                clean_data(caller)
        finally:
            assert snapshot(caller) == before
    finally:
        engine.close()
