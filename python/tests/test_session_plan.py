from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, cast

import pytest

from openwrangler_runtime.custom_code_scope import (
    custom_code_definition_lines,
    custom_code_generated_utf8_bytes,
    custom_code_prelude_lines,
    custom_code_step_lines,
)
from openwrangler_runtime.engines import DataFrameEngine, EngineError
from openwrangler_runtime.protocol_limits_generated import (
    MAX_PYTHON_CUSTOM_CODE_UTF8_BYTES,
    MAX_PYTHON_RETAINED_PLAN_UTF8_BYTES,
)
from openwrangler_runtime.response_framing import strict_json_byte_length
from openwrangler_runtime.session_plan import _splitlines_shape, compile_plan_with_limits, preflight_retained_plan

SPLITLINE_SEPARATORS = [
    ("lf", "\n"),
    ("cr", "\r"),
    ("crlf", "\r\n"),
    ("vertical-tab", "\v"),
    ("form-feed", "\f"),
    ("file-separator", "\x1c"),
    ("group-separator", "\x1d"),
    ("record-separator", "\x1e"),
    ("next-line", "\x85"),
    ("line-separator", "\u2028"),
    ("paragraph-separator", "\u2029"),
]
SPLITLINE_CASES = [
    (f"marker = 1{separator}result = df", f"{name}-interior") for name, separator in SPLITLINE_SEPARATORS
] + [(f"result = df{separator}", f"{name}-terminal") for name, separator in SPLITLINE_SEPARATORS]


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
def test_splitline_heavy_custom_plan_is_rejected_before_compile_allocates_lines(separator: str) -> None:
    code = separator * (MAX_PYTHON_CUSTOM_CODE_UTF8_BYTES - len("result=df")) + "result=df"
    plan = [custom_step(f"custom-{index}", code) for index in range(16)]
    engine = CompileMustNotRun("pandas", "compile_plan allocated splitline-expanded custom code")

    with pytest.raises(EngineError, match=r"4,194,304 UTF-8 bytes"):
        compile_plan_with_limits(cast(DataFrameEngine, engine), plan)
    assert engine.calls == 0


@pytest.mark.parametrize("separator", ["\n", "\f"], ids=["terminal-lf", "terminal-form-feed"])
def test_terminal_splitline_separator_preserves_preallocation_limit(separator: str) -> None:
    code = ("x" * (MAX_PYTHON_CUSTOM_CODE_UTF8_BYTES - len(separator.encode("utf-8")))) + separator
    plan = [custom_step(f"custom-{index}", code) for index in range(64)]
    engine = CompileMustNotRun("pandas", "compile_plan allocated terminal-separator custom code")

    with pytest.raises(EngineError, match=r"4,194,304 UTF-8 bytes"):
        compile_plan_with_limits(cast(DataFrameEngine, engine), plan)
    assert engine.calls == 0


@pytest.mark.parametrize("engine_name", ["pandas", "polars", "duckdb"])
def test_many_small_custom_steps_are_rejected_before_generation(engine_name: str) -> None:
    plan = [custom_step(f"custom-{index}", "result=df") for index in range(5_000)]
    engine = CompileMustNotRun(engine_name, "compile_plan allocated many-step Custom Code")

    with pytest.raises(EngineError, match=r"4,194,304 UTF-8 bytes"):
        compile_plan_with_limits(cast(DataFrameEngine, engine), plan)
    assert engine.calls == 0


@pytest.mark.parametrize("code", [case[0] for case in SPLITLINE_CASES], ids=[case[1] for case in SPLITLINE_CASES])
def test_generated_renderer_matches_streaming_splitlines_shape(code: str) -> None:
    line_count, separator_bytes = _splitlines_shape(code)
    definition = custom_code_definition_lines(code, index=0)
    rendered_user_lines = definition[1 : line_count + 1]

    assert rendered_user_lines == [f"    {line}" for line in code.splitlines()]
    assert len(rendered_user_lines) == line_count
    assert sum(len(f"{line}\n".encode()) for line in rendered_user_lines) == (
        len(code.encode("utf-8")) - separator_bytes + (line_count * 5)
    )
    compile("\n".join(definition), "<generated-custom-definition>", "exec")


@pytest.mark.parametrize("engine_name", ["pandas", "polars", "duckdb"])
def test_streaming_preflight_counts_every_generated_custom_line(engine_name: str) -> None:
    code = "marker = 'é'\u2028result = df"
    index = 4_999
    line_count, separator_bytes = _splitlines_shape(code)
    rendered_lines = [
        *custom_code_prelude_lines(),
        *custom_code_definition_lines(code, index=index),
        *custom_code_step_lines(prefix="    ", engine_name=engine_name, index=index),
    ]

    assert custom_code_generated_utf8_bytes(
        code_utf8_bytes=len(code.encode("utf-8")),
        separator_utf8_bytes=separator_bytes,
        line_count=line_count,
        engine_name=engine_name,
        index=index,
        include_prelude=True,
    ) == sum(len(line.encode("utf-8")) + 1 for line in rendered_lines)
