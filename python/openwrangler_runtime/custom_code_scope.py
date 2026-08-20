from __future__ import annotations

import ast
import builtins
from collections.abc import Iterator, Mapping
from typing import Any

CUSTOM_CODE_FUNCTION_NAME = "_open_wrangler_custom_code"
_CUSTOM_CODE_FILENAME = "<open-wrangler-custom-code>"
_MAX_CUSTOM_CODE_AST_NODES = 262_144
_MAX_CUSTOM_CODE_AST_DEPTH = 512
_COMPLEXITY_ERROR = "Custom Code syntax is too complex."
_ENGINE_MODULE_NAMES = {
    "duckdb": "duckdb",
    "pandas": "pd",
    "polars": "pl",
}


class CustomCodeScopeError(ValueError):
    """Raised when Custom Code cannot use the shared function-body scope."""


def validate_custom_code_scope(code: str) -> None:
    """Validate the syntax and scope shared by live and generated Custom Code."""

    if not isinstance(code, str) or not code.strip():
        raise CustomCodeScopeError("Custom Code must be non-empty Python code assigning a dataframe to result.")
    try:
        tree = ast.parse(_normalized_source(code), filename=_CUSTOM_CODE_FILENAME, mode="exec")
    except SyntaxError as error:
        raise CustomCodeScopeError(_syntax_error_message(error)) from error
    except (MemoryError, OverflowError, RecursionError) as error:
        raise CustomCodeScopeError(_COMPLEXITY_ERROR) from error

    try:
        for node, in_outer_scope in _scope_nodes(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "__future__":
                raise CustomCodeScopeError("Custom Code does not allow future imports inside its function scope.")
            if isinstance(node, ast.ImportFrom) and any(alias.name == "*" for alias in node.names):
                raise CustomCodeScopeError(
                    "Custom Code does not allow wildcard imports; import each required name explicitly."
                )
            if isinstance(node, ast.Global):
                raise CustomCodeScopeError("Custom Code does not allow global declarations.")
            if isinstance(node, ast.Nonlocal):
                raise CustomCodeScopeError("Custom Code does not allow nonlocal declarations.")
            if in_outer_scope and isinstance(node, ast.Return):
                raise CustomCodeScopeError(
                    "Custom Code must assign the dataframe to result instead of returning from its outer scope."
                )
            if in_outer_scope and isinstance(node, ast.Yield | ast.YieldFrom):
                raise CustomCodeScopeError(
                    "Custom Code must assign the dataframe to result instead of yielding from its outer scope."
                )
        compile(_function_source(code), _CUSTOM_CODE_FILENAME, "exec")
    except SyntaxError as error:
        raise CustomCodeScopeError(_syntax_error_message(error, wrapper_line=True)) from error
    except (MemoryError, OverflowError, RecursionError) as error:
        raise CustomCodeScopeError(_COMPLEXITY_ERROR) from error


def execute_custom_code(code: str, dataframe: Any, namespace: Mapping[str, Any]) -> Any:
    """Execute Custom Code in the same function scope emitted by generated scripts."""

    validate_custom_code_scope(code)
    runtime_namespace = dict(namespace)
    runtime_namespace["__builtins__"] = builtins.__dict__
    exec(compile(_function_source(code), _CUSTOM_CODE_FILENAME, "exec"), runtime_namespace, runtime_namespace)
    function = runtime_namespace[CUSTOM_CODE_FUNCTION_NAME]
    return function(dataframe)


def custom_code_definition_lines(code: str, *, index: int) -> list[str]:
    """Render one validated module-level wrapper retained under a unique name."""

    validate_custom_code_scope(code)
    return [
        *_function_lines(code, prefix=""),
        f"{_custom_code_raw_name(index)} = {CUSTOM_CODE_FUNCTION_NAME}",
        f"del {CUSTOM_CODE_FUNCTION_NAME}",
        "",
        "",
    ]


def custom_code_execution_lines(
    *,
    prefix: str,
    module_name: str,
    index: int,
) -> tuple[list[str], str]:
    """Execute a generated wrapper with the same fresh globals used live."""

    raw_function = _custom_code_raw_name(index)
    runtime_namespace = f"_open_wrangler_custom_globals_{index}"
    function = f"_open_wrangler_custom_function_{index}"
    result = f"_open_wrangler_custom_result_{index}"
    return (
        [
            f"{prefix}if {raw_function}.__code__.co_freevars:",
            (
                f"{prefix}    raise NameError('Custom Code cannot access generated-plan local names: ' "
                f"+ ', '.join({raw_function}.__code__.co_freevars))"
            ),
            f"{prefix}{runtime_namespace} = {{{module_name!r}: {module_name}, '__builtins__': __builtins__}}",
            (
                f"{prefix}{function} = type({raw_function})("
                f"{raw_function}.__code__, {runtime_namespace}, {CUSTOM_CODE_FUNCTION_NAME!r})"
            ),
            f"{prefix}{runtime_namespace}[{CUSTOM_CODE_FUNCTION_NAME!r}] = {function}",
            f"{prefix}{result} = {function}(df)",
        ],
        result,
    )


def custom_code_step_lines(*, prefix: str, engine_name: str, index: int) -> list[str]:
    """Render one complete generated Custom Code invocation for an editing engine."""

    try:
        module_name = _ENGINE_MODULE_NAMES[engine_name]
    except KeyError as error:
        raise ValueError(f"Unsupported Custom Code engine: {engine_name}.") from error
    custom_lines, result = custom_code_execution_lines(prefix=prefix, module_name=module_name, index=index)
    if engine_name == "pandas":
        return [
            f"{prefix}df = _open_wrangler_isolate_objects(df)",
            *custom_lines,
            f"{prefix}if not isinstance({result}, (pd.DataFrame, pd.Series)):",
            (f"{prefix}    raise ValueError('Custom Pandas code must assign a Pandas DataFrame or Series to result.')"),
            f"{prefix}df = {result}.to_frame() if isinstance({result}, pd.Series) else {result}",
        ]
    if engine_name == "polars":
        return [
            *custom_lines,
            f"{prefix}if not isinstance({result}, (pl.DataFrame, pl.LazyFrame, pl.Series)):",
            (
                f"{prefix}    raise ValueError("
                "'Custom Polars code must assign a Polars DataFrame, LazyFrame, or Series to result.')"
            ),
            f"{prefix}df = {result}.to_frame() if isinstance({result}, pl.Series) else {result}",
        ]
    return [
        f"{prefix}df = _ow_visible_relation(df)",
        *custom_lines,
        f"{prefix}if not isinstance({result}, duckdb.DuckDBPyRelation):",
        f"{prefix}    raise ValueError('Custom DuckDB code must assign a DuckDBPyRelation to result.')",
        f"{prefix}df = {result}",
    ]


def custom_code_generated_utf8_bytes(
    *,
    code_utf8_bytes: int,
    separator_utf8_bytes: int,
    line_count: int,
    engine_name: str,
    index: int,
) -> int:
    """Return the exact Custom Code line contribution without splitting user source."""

    fixed_definition_lines = [
        f"def {CUSTOM_CODE_FUNCTION_NAME}(df):",
        "    return result",
        f"{_custom_code_raw_name(index)} = {CUSTOM_CODE_FUNCTION_NAME}",
        f"del {CUSTOM_CODE_FUNCTION_NAME}",
        "",
        "",
    ]
    user_lines = code_utf8_bytes - separator_utf8_bytes + (line_count * 5)
    return (
        user_lines
        + _joined_line_bytes(fixed_definition_lines)
        + _joined_line_bytes(custom_code_step_lines(prefix="    ", engine_name=engine_name, index=index))
    )


def _normalized_source(code: str) -> str:
    return "\n".join(code.splitlines())


def _function_source(code: str) -> str:
    return "\n".join(_function_lines(code, prefix="")) + "\n"


def _function_lines(code: str, *, prefix: str) -> list[str]:
    return [
        f"{prefix}def {CUSTOM_CODE_FUNCTION_NAME}(df):",
        *[f"{prefix}    {line}" for line in code.splitlines()],
        f"{prefix}    return result",
    ]


def _custom_code_raw_name(index: int) -> str:
    return f"_open_wrangler_custom_raw_{index}"


def _scope_nodes(root: ast.AST) -> Iterator[tuple[ast.AST, bool]]:
    pending = [(root, True, 1)]
    visited = 0
    while pending:
        node, in_outer_scope, depth = pending.pop()
        visited += 1
        if visited > _MAX_CUSTOM_CODE_AST_NODES or depth > _MAX_CUSTOM_CODE_AST_DEPTH:
            raise CustomCodeScopeError(_COMPLEXITY_ERROR)
        yield node, in_outer_scope

        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            nested_body = [(child, False, depth + 1) for child in reversed(node.body)]
            evaluated = [
                *node.decorator_list,
                node.args,
                *([node.returns] if node.returns is not None else []),
                *getattr(node, "type_params", ()),
            ]
            pending.extend(nested_body)
            pending.extend((child, in_outer_scope, depth + 1) for child in reversed(evaluated))
            continue
        if isinstance(node, ast.Lambda):
            pending.append((node.body, False, depth + 1))
            pending.append((node.args, in_outer_scope, depth + 1))
            continue
        pending.extend((child, in_outer_scope, depth + 1) for child in reversed(list(ast.iter_child_nodes(node))))


def _joined_line_bytes(lines: list[str]) -> int:
    return sum(len(line.encode("utf-8")) + 1 for line in lines)


def _syntax_error_message(error: SyntaxError, *, wrapper_line: bool = False) -> str:
    line = error.lineno
    if wrapper_line and line is not None:
        line = max(1, line - 1)
    location = f" at line {line}" if line is not None else ""
    return f"Custom Code contains invalid Python syntax{location}: {error.msg}."
