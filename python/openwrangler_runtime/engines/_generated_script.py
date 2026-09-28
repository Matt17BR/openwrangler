"""Assemble generated cleaning scripts in the shape every Python engine shares."""

from __future__ import annotations

import ast
from dataclasses import dataclass, field

from ..operations import OPERATION_BY_KIND

REGENERATE_ADVICE = "Open the new data in Open Wrangler and generate the code again."
CHECK_COMMENT = "# Stop if the data differs from the data this code was generated for."
CUSTOM_CODE_CHECK_COMMENT = "# Stop if the custom code changed columns the next steps use."

TYPE_ERROR_HELPER = (
    f"def type_error(column, found, expected, advice={REGENERATE_ADVICE!r}):",
    '    """Return the error for a column whose type differs from the type this code was generated for."""',
    '    return TypeError(f"Column {column!r} is {found}, but this code was generated for {expected}. {advice}")',
)

_FAMILY_WORDS = {"string": "text", "object": "mixed-value object"}
_BARE_CONDITIONS = (ast.Attribute, ast.Call, ast.Constant, ast.Name, ast.Subscript)


def expected_columns(column_type: str, time_zone: str | None = None) -> str:
    """Return how a stop message names the columns this code was generated for, such as ``integer columns``."""

    if column_type == "datetime":
        return f"datetime columns in {time_zone}" if time_zone else "datetime columns without a time zone"
    return f"{_FAMILY_WORDS.get(column_type, column_type)} columns"


@dataclass
class GeneratedScript:
    """One ``def clean_data(df):`` script: imports, nested helpers, then check and step blocks."""

    function_name: str = "clean_data"
    parameters: str = "df"
    imports: list[str] = field(default_factory=list)
    helpers: dict[str, list[str]] = field(default_factory=dict)
    blocks: list[list[str]] = field(default_factory=list)

    def add_import(self, line: str) -> None:
        """Add an import line once, keeping first-use order."""

        if line not in self.imports:
            self.imports.append(line)

    def add_helper(self, name: str, lines: list[str]) -> None:
        """Add a nested helper once; ``lines`` is its unindented ``def`` with a one-line docstring."""

        if not lines or not lines[0].startswith(f"def {name}("):
            raise ValueError(f"Helper {name!r} must start with its def line.")
        self.helpers.setdefault(name, lines)

    def add_checks(self, lines: list[str], *, after_custom_code: bool = False) -> None:
        """Add a check block, which is omitted when it has no lines."""

        if lines:
            self.blocks.append([CUSTOM_CODE_CHECK_COMMENT if after_custom_code else CHECK_COMMENT, *lines])

    def type_check(
        self,
        condition: str,
        column: str,
        found: str,
        expected: str,
        *,
        conversion: str | None = None,
    ) -> list[str]:
        """Return check lines that raise the shared ``type_error`` unless ``condition`` holds.

        ``column`` and ``found`` are Python expressions for the column label and its native type; ``expected`` comes
        from ``expected_columns``. ``conversion`` is one exact statement to run first, offered only when it can't
        change a value.
        """

        self.add_helper("type_error", list(TYPE_ERROR_HELPER))
        if not isinstance(ast.parse(condition, mode="eval").body, _BARE_CONDITIONS):
            condition = f"({condition})"
        arguments = [column, found, repr(expected)]
        if conversion is not None:
            arguments.append(repr(f"Run this first: {conversion}"))
        return [f"if not {condition}:", f"    raise type_error({', '.join(arguments)})"]

    def add_step(self, kind: str, lines: list[str]) -> None:
        """Add one step's lines under a comment holding the operation's catalog title."""

        self.blocks.append([f"# {OPERATION_BY_KIND[kind].title}", *lines])

    def render(self, result: str = "df") -> str:
        """Return the script text, ending with ``return <result>``."""

        body: list[list[str]] = []
        if self.imports:
            body.append(list(self.imports))
        body.extend(self.helpers.values())
        body.extend(self.blocks)
        body.append([f"return {result}"])
        lines = [f"def {self.function_name}({self.parameters}):"]
        for index, block in enumerate(body):
            if index:
                lines.append("")
            lines.extend(f"    {line}" if line else "" for line in block)
        return "\n".join(lines) + "\n"
