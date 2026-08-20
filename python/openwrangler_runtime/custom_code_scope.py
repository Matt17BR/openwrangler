from __future__ import annotations

import ast
from collections.abc import Iterator, Mapping
from typing import Any

CUSTOM_CODE_FUNCTION_NAME = "_open_wrangler_custom_code"
_CUSTOM_CODE_FILENAME = "<open-wrangler-custom-code>"


class CustomCodeScopeError(ValueError):
    """Raised when Custom Code cannot use the shared function-body scope."""


def validate_custom_code_scope(code: str) -> None:
    """Validate the syntax and scope shared by live and generated Custom Code."""

    if not isinstance(code, str) or not code.strip():
        raise CustomCodeScopeError("Custom Code must be non-empty Python code assigning a dataframe to result.")
    try:
        tree = ast.parse(code, filename=_CUSTOM_CODE_FILENAME, mode="exec")
    except SyntaxError as error:
        raise CustomCodeScopeError(_syntax_error_message(error)) from error

    for node in ast.walk(tree):
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

    for node in _outer_scope_nodes(tree):
        if isinstance(node, ast.Return):
            raise CustomCodeScopeError(
                "Custom Code must assign the dataframe to result instead of returning from its outer scope."
            )
        if isinstance(node, ast.Yield | ast.YieldFrom):
            raise CustomCodeScopeError(
                "Custom Code must assign the dataframe to result instead of yielding from its outer scope."
            )

    try:
        compile(_function_source(code), _CUSTOM_CODE_FILENAME, "exec")
    except SyntaxError as error:
        raise CustomCodeScopeError(_syntax_error_message(error, wrapper_line=True)) from error


def execute_custom_code(code: str, dataframe: Any, namespace: Mapping[str, Any]) -> Any:
    """Execute Custom Code in the same function scope emitted by generated scripts."""

    validate_custom_code_scope(code)
    runtime_namespace = dict(namespace)
    exec(compile(_function_source(code), _CUSTOM_CODE_FILENAME, "exec"), runtime_namespace, runtime_namespace)
    function = runtime_namespace[CUSTOM_CODE_FUNCTION_NAME]
    return function(dataframe)


def custom_code_function_lines(code: str, *, prefix: str) -> list[str]:
    """Render validated Custom Code as generated function-body source lines."""

    validate_custom_code_scope(code)
    return _function_lines(code, prefix=prefix)


def _function_source(code: str) -> str:
    return "\n".join(_function_lines(code, prefix="")) + "\n"


def _function_lines(code: str, *, prefix: str) -> list[str]:
    normalized = code.replace("\r\n", "\n").replace("\r", "\n")
    return [
        f"{prefix}def {CUSTOM_CODE_FUNCTION_NAME}(df):",
        *[f"{prefix}    {line}" for line in normalized.split("\n")],
        f"{prefix}    return result",
    ]


def _outer_scope_nodes(root: ast.AST) -> Iterator[ast.AST]:
    yield root
    if isinstance(root, ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda):
        return
    for child in ast.iter_child_nodes(root):
        yield from _outer_scope_nodes(child)


def _syntax_error_message(error: SyntaxError, *, wrapper_line: bool = False) -> str:
    line = error.lineno
    if wrapper_line and line is not None:
        line = max(1, line - 1)
    location = f" at line {line}" if line is not None else ""
    return f"Custom Code contains invalid Python syntax{location}: {error.msg}."
