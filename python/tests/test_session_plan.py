from __future__ import annotations

import ast
from collections.abc import Iterable, Mapping
from typing import Any, cast

import pytest

from openwrangler_runtime.custom_code_scope import (
    CUSTOM_CODE_FUNCTION_NAME,
    CustomCodeScopeError,
    custom_code_definition_lines,
    custom_code_generated_utf8_bytes,
    custom_code_prelude_lines,
    custom_code_step_lines,
    execute_custom_code,
    validate_custom_code_scope,
)
from openwrangler_runtime.engines import DataFrameEngine, EngineError
from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.protocol_limits_generated import (
    MAX_GENERATED_PYTHON_CODE_UTF8_BYTES,
    MAX_PYTHON_CUSTOM_CODE_UTF8_BYTES,
    MAX_PYTHON_RETAINED_PLAN_UTF8_BYTES,
)
from openwrangler_runtime.response_framing import strict_json_byte_length
from openwrangler_runtime.session_plan import compile_plan_with_limits, preflight_retained_plan

PHYSICAL_NEWLINES = [("lf", "\n"), ("cr", "\r"), ("crlf", "\r\n")]
SOURCE_LINE_CASES = [
    (f"marker = 1{separator}result = df", f"{name}-interior") for name, separator in PHYSICAL_NEWLINES
] + [(f"result = df{separator}", f"{name}-terminal") for name, separator in PHYSICAL_NEWLINES]


def custom_step(step_id: str, code: str) -> dict[str, Any]:
    return {"id": step_id, "kind": "customCode", "params": {"code": code}}


class CompileMustNotRun:
    def __init__(self, name: str, message: str) -> None:
        self.name = name
        self.message = message
        self.calls = 0

    def compile_plan(self, _steps: Iterable[Mapping[str, Any]]) -> str:
        self.calls += 1
        raise AssertionError(self.message)


def test_retained_plan_budget_accepts_exact_limit_and_rejects_one_byte_over() -> None:
    full_steps = [custom_step(f"custom-{index}", "x" * MAX_PYTHON_CUSTOM_CODE_UTF8_BYTES) for index in range(63)]
    empty_tail = custom_step("custom-63", "")
    fixed_size = strict_json_byte_length(
        [*full_steps, empty_tail],
        MAX_PYTHON_RETAINED_PLAN_UTF8_BYTES + MAX_PYTHON_CUSTOM_CODE_UTF8_BYTES,
    )
    exact = [
        *full_steps,
        custom_step("custom-63", "x" * (MAX_PYTHON_RETAINED_PLAN_UTF8_BYTES - fixed_size)),
    ]

    assert preflight_retained_plan(exact) == MAX_PYTHON_RETAINED_PLAN_UTF8_BYTES
    exact[-1]["params"]["code"] += "x"
    with pytest.raises(EngineError, match=r"4,194,304 compact strict-JSON UTF-8 bytes"):
        preflight_retained_plan(exact)


@pytest.mark.parametrize("separator", ["\n", "\f"], ids=["line-feed", "form-feed"])
def test_large_blank_custom_plan_is_not_rejected_for_indentation_expansion(separator: str) -> None:
    import pandas as pd

    code = separator * (MAX_PYTHON_CUSTOM_CODE_UTF8_BYTES - len("result=df")) + "result=df"
    plan = [custom_step(f"custom-{index}", code) for index in range(16)]
    frame = pd.DataFrame({"value": [1, 2]})
    before = frame.copy(deep=True)
    engine = PandasEngine()
    try:
        generated = compile_plan_with_limits(engine, plan)
        assert len(generated.encode("utf-8")) <= MAX_GENERATED_PYTHON_CODE_UTF8_BYTES
        namespace: dict[str, Any] = {}
        exec(compile(generated, "<large-custom-plan>", "exec", dont_inherit=True), namespace)
        pd.testing.assert_frame_equal(namespace["clean_data"](frame), before)
        pd.testing.assert_frame_equal(frame, before)
    finally:
        engine.close()


@pytest.mark.parametrize("separator", ["\n", "\f"], ids=["terminal-lf", "terminal-form-feed"])
def test_terminal_splitline_separator_preserves_preallocation_limit(separator: str) -> None:
    code = ("x" * (MAX_PYTHON_CUSTOM_CODE_UTF8_BYTES - len(separator.encode("utf-8")))) + separator
    plan = [custom_step(f"custom-{index}", code) for index in range(64)]
    engine = CompileMustNotRun("pandas", "compile_plan allocated terminal-separator custom code")

    with pytest.raises(EngineError, match=r"4,194,304 UTF-8 bytes"):
        compile_plan_with_limits(cast(DataFrameEngine, engine), plan)
    assert engine.calls == 0


@pytest.mark.parametrize(("engine_name", "step_count"), [("pandas", 5_000), ("polars", 5_000), ("duckdb", 6_100)])
def test_many_small_custom_steps_are_rejected_before_generation(engine_name: str, step_count: int) -> None:
    plan = [custom_step(f"custom-{index}", "result=df") for index in range(step_count)]
    engine = CompileMustNotRun(engine_name, "compile_plan allocated many-step Custom Code")

    with pytest.raises(EngineError, match=r"4,194,304 UTF-8 bytes"):
        compile_plan_with_limits(cast(DataFrameEngine, engine), plan)
    assert engine.calls == 0


def test_escaped_custom_plan_is_rejected_before_generation() -> None:
    code = "#" + '\\"' * 32_650 + "\nresult=df"
    plan = [custom_step(f"custom-{index}", code) for index in range(32)]
    engine = CompileMustNotRun("pandas", "compile_plan allocated escaped Custom Code")

    assert len(code.encode("utf-8")) <= MAX_PYTHON_CUSTOM_CODE_UTF8_BYTES
    assert preflight_retained_plan(plan) <= MAX_PYTHON_RETAINED_PLAN_UTF8_BYTES
    with pytest.raises(EngineError, match=r"4,194,304 UTF-8 bytes"):
        compile_plan_with_limits(cast(DataFrameEngine, engine), plan)
    assert engine.calls == 0


@pytest.mark.parametrize("code", [case[0] for case in SOURCE_LINE_CASES], ids=[case[1] for case in SOURCE_LINE_CASES])
def test_generated_custom_source_preserves_python_physical_lines(code: str) -> None:
    definition = custom_code_definition_lines(code, index=0)
    statement = ast.parse("\n".join(definition)).body[0]
    assert isinstance(statement, ast.Assign)
    user_source = ast.literal_eval(statement.value)
    assert ast.dump(ast.parse(user_source)) == ast.dump(ast.parse(code))

    namespace: dict[str, Any] = {"CodeType": object(), "str": object()}
    exec(compile("\n".join(custom_code_prelude_lines()), "<generated-custom-compiler>", "exec"), namespace)
    exec(namespace["_compile_function_source"](user_source), namespace)
    sentinel = object()
    assert namespace[CUSTOM_CODE_FUNCTION_NAME](sentinel) is sentinel


@pytest.mark.parametrize("separator", ["\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"])
def test_non_newline_separators_follow_python_literal_and_syntax_rules(separator: str) -> None:
    code = f'result = "left{separator}right"'
    namespace: dict[str, Any] = {}
    exec(compile(code, "<ordinary-python-source>", "exec"), namespace)
    assert execute_custom_code(code, object(), {}) == namespace["result"]
    definition = custom_code_definition_lines(code, index=0)
    statement = ast.parse("\n".join(definition)).body[0]
    assert isinstance(statement, ast.Assign)
    assert ast.dump(ast.parse(ast.literal_eval(statement.value))) == ast.dump(ast.parse(code))

    with pytest.raises(CustomCodeScopeError, match="invalid Python syntax"):
        validate_custom_code_scope(f"result = df{separator}result = None")


@pytest.mark.parametrize("statement", ["break", "result = ("])
def test_custom_code_syntax_errors_keep_original_user_line_numbers(statement: str) -> None:
    with pytest.raises(CustomCodeScopeError, match="invalid Python syntax at line 2"):
        validate_custom_code_scope(f'text = "left\u2028right"\n{statement}')


@pytest.mark.parametrize("engine_name", ["pandas", "polars", "duckdb"])
def test_streaming_preflight_counts_every_generated_custom_line(engine_name: str) -> None:
    marker = 'é\\"'
    code = f"marker = {marker!r}\r\nresult = df"
    index = 4_999
    rendered_lines = [
        *[f"    {line}" if line else "" for line in custom_code_prelude_lines()],
        *custom_code_definition_lines(code, index=index, prefix="    "),
        *custom_code_step_lines(prefix="    ", engine_name=engine_name, index=index),
    ]

    assert custom_code_generated_utf8_bytes(
        code_utf8_bytes=len(code.encode("utf-8")),
        literal_escape_bytes=code.count("\\") + code.count('"'),
        engine_name=engine_name,
        index=index,
        include_prelude=True,
    ) == sum(len(line.encode("utf-8")) + 1 for line in rendered_lines)


@pytest.mark.parametrize("source_kind", ["notebookVariable", "notebookOutput"])
def test_generated_entry_point_preserves_a_notebook_source_named_clean_data(source_kind: str) -> None:
    import pandas as pd

    frame = pd.DataFrame({"value": [1, 2]})
    before = frame.copy(deep=True)
    engine = PandasEngine()
    try:
        code = compile_plan_with_limits(
            engine,
            [custom_step("identity", "result = df")],
            source={"kind": source_kind, "variableName": "clean_data"},
        )
        namespace: dict[str, Any] = {"clean_data": frame}
        exec(compile(code, "<generated-notebook-source>", "exec", dont_inherit=True), namespace)
        assert namespace["clean_data"] is frame
        pd.testing.assert_frame_equal(namespace["clean_data_1"](namespace["clean_data"]), frame)
        pd.testing.assert_frame_equal(frame, before)
        assert namespace["clean_data"] is frame
    finally:
        engine.close()
