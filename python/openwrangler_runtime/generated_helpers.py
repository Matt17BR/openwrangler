from __future__ import annotations

import ast
import symtable
from functools import lru_cache

_HELPER_FILENAME = "<open-wrangler-generated-helpers>"


def _bound_names(node: ast.stmt) -> tuple[str, ...]:
    if isinstance(node, ast.Import):
        return tuple(alias.asname or alias.name.partition(".")[0] for alias in node.names)
    if isinstance(node, ast.ImportFrom):
        if node.module == "__future__":
            raise RuntimeError("Generated helpers cannot use future imports.")
        if any(alias.name == "*" for alias in node.names):
            raise RuntimeError("Generated helpers cannot use wildcard imports.")
        return tuple(alias.asname or alias.name for alias in node.names)
    if isinstance(node, ast.Assign):
        if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
            raise RuntimeError("Generated helper constants must use one direct name.")
        return (node.targets[0].id,)
    if isinstance(node, ast.FunctionDef):
        return (node.name,)
    raise RuntimeError(f"Unsupported generated helper statement: {type(node).__name__}.")


def _statement_source(source: str, node: ast.stmt) -> str:
    statement = ast.get_source_segment(source, node)
    if statement is None:
        raise RuntimeError("Generated helper source cannot be recovered exactly.")
    if isinstance(node, ast.FunctionDef) and node.decorator_list:
        lines = source.splitlines(keepends=True)
        statement = "".join(lines[node.decorator_list[0].lineno - 1 : node.lineno - 1]) + statement
    return statement


def _global_references(source: str) -> frozenset[str]:
    root = symtable.symtable(source, _HELPER_FILENAME, "exec")
    references: set[str] = set()
    pending = [root]
    while pending:
        table = pending.pop()
        references.update(
            symbol.get_name() for symbol in table.get_symbols() if symbol.is_global() and symbol.is_referenced()
        )
        pending.extend(table.get_children())
    return frozenset(references)


@lru_cache(maxsize=2)
def _helper_catalog(source: str) -> tuple[tuple[str, tuple[str, ...], frozenset[str]], ...]:
    module = ast.parse(source, filename=_HELPER_FILENAME, mode="exec")
    definitions: set[str] = set()
    catalog = []
    for node in module.body:
        names = _bound_names(node)
        repeated_names = {name for name in names if names.count(name) > 1}
        if repeated_names:
            raise RuntimeError(f"Duplicate generated helper definition: {min(repeated_names)}.")
        duplicates = definitions.intersection(names)
        if duplicates:
            raise RuntimeError(f"Duplicate generated helper definition: {min(duplicates)}.")
        definitions.update(names)
        statement = _statement_source(source, node)
        catalog.append((statement, names, _global_references(statement)))
    return tuple(catalog)


def select_generated_helpers(source: str, entry_point_source: str) -> str:
    """Select canonical declarations through their static global references.

    Candidate source must not require side effects from unreferenced declarations.
    This selects controlled helper libraries, not arbitrary user programs.
    """
    catalog = _helper_catalog(source)
    providers = {name: index for index, (_source, names, _references) in enumerate(catalog) for name in names}
    pending = [name for name in _global_references(entry_point_source) if name in providers]
    selected: set[int] = set()
    while pending:
        name = pending.pop()
        index = providers[name]
        if index in selected:
            continue
        selected.add(index)
        pending.extend(reference for reference in catalog[index][2] if reference in providers)
    return "\n\n".join(catalog[index][0] for index in sorted(selected))
