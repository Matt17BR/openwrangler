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


def custom_code_definition_lines(code: str, *, index: int) -> list[str]:
    """Render one validated module-level holder for generated Custom Code."""

    validate_custom_code_scope(code)
    return [
        f"class {_custom_code_holder_name(index)}:",
        *_function_lines(code, prefix="    "),
        "",
        "",
    ]


def custom_code_execution_lines(
    *,
    prefix: str,
    module_name: str,
    index: int,
) -> tuple[list[str], str]:
    """Execute a generated holder with the same fresh globals used live."""

    holder_name = _custom_code_holder_name(index)
    raw_function = f"_open_wrangler_custom_raw_{index}"
    runtime_namespace = f"_open_wrangler_custom_globals_{index}"
    function = f"_open_wrangler_custom_function_{index}"
    result = f"_open_wrangler_custom_result_{index}"
    return (
        [
            f"{prefix}{raw_function} = {holder_name}.__dict__[{CUSTOM_CODE_FUNCTION_NAME!r}]",
            f"{prefix}if {raw_function}.__code__.co_freevars:",
            (
                f"{prefix}    raise NameError('Custom Code cannot access generated-plan local names: ' "
                f"+ ', '.join({raw_function}.__code__.co_freevars))"
            ),
            f"{prefix}{runtime_namespace} = {{'__builtins__': __builtins__, {module_name!r}: {module_name}}}",
            (
                f"{prefix}{function} = type({raw_function})("
                f"{raw_function}.__code__, {runtime_namespace}, {CUSTOM_CODE_FUNCTION_NAME!r})"
            ),
            f"{prefix}{runtime_namespace}[{CUSTOM_CODE_FUNCTION_NAME!r}] = {function}",
            f"{prefix}{result} = {function}(df)",
        ],
        result,
    )


def _function_source(code: str) -> str:
    return "\n".join(_function_lines(code, prefix="")) + "\n"


def _function_lines(code: str, *, prefix: str) -> list[str]:
    return [
        f"{prefix}def {CUSTOM_CODE_FUNCTION_NAME}(df):",
        *[f"{prefix}    {line}" for line in code.splitlines()],
        f"{prefix}    return result",
    ]


def _custom_code_holder_name(index: int) -> str:
    return f"_OpenWranglerCustomCode{index}"


def _outer_scope_nodes(root: ast.AST) -> Iterator[ast.AST]:
    yield root
    if isinstance(root, ast.FunctionDef | ast.AsyncFunctionDef):
        for decorator in root.decorator_list:
            yield from _outer_scope_nodes(decorator)
        yield from _outer_scope_nodes(root.args)
        if root.returns is not None:
            yield from _outer_scope_nodes(root.returns)
        for type_parameter in getattr(root, "type_params", ()):
            yield from _outer_scope_nodes(type_parameter)
        return
    if isinstance(root, ast.Lambda):
        yield from _outer_scope_nodes(root.args)
        return
    for child in ast.iter_child_nodes(root):
        yield from _outer_scope_nodes(child)


def _syntax_error_message(error: SyntaxError, *, wrapper_line: bool = False) -> str:
    line = error.lineno
    if wrapper_line and line is not None:
        line = max(1, line - 1)
    location = f" at line {line}" if line is not None else ""
    return f"Custom Code contains invalid Python syntax{location}: {error.msg}."
