from __future__ import annotations

_NUMBER_SOURCES = frozenset({"string", "integer", "float", "decimal", "boolean"})
_CALENDAR_SOURCES = frozenset({"string", "date", "datetime"})

CAST_SOURCE_TYPES: dict[str, frozenset[str]] = {
    "string": _NUMBER_SOURCES | _CALENDAR_SOURCES,
    "integer": _NUMBER_SOURCES,
    "float": _NUMBER_SOURCES,
    "boolean": _NUMBER_SOURCES,
    "date": _CALENDAR_SOURCES,
    "datetime": _CALENDAR_SOURCES,
}

_TYPE_LABELS = {
    "string": "Text",
    "integer": "Integer",
    "float": "Float",
    "decimal": "Decimal",
    "boolean": "Boolean",
    "date": "Date",
    "datetime": "Datetime",
    "duration": "Duration",
    "binary": "Binary",
    "list": "List",
    "struct": "Struct",
}


def cast_refusal(source_type: str, dtype: str) -> str | None:
    if source_type in CAST_SOURCE_TYPES.get(dtype, frozenset()):
        return None
    source = _TYPE_LABELS.get(source_type)
    values = f"{source} values" if source else "values of this column type"
    return f"Convert type cannot turn {values} into {_TYPE_LABELS.get(dtype, dtype)}."
