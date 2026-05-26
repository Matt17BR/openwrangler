from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from math import isnan
from typing import Any, Iterable, Literal, Mapping

ColumnType = Literal["string", "integer", "float", "boolean", "datetime", "date", "unknown"]


class EngineError(RuntimeError):
    """Raised when a backend cannot satisfy a Data Explorer request."""


@dataclass(frozen=True)
class ColumnSchema:
    name: str
    raw_type: str
    type: ColumnType
    nullable: bool


class DataFrameEngine(ABC):
    name: str

    @abstractmethod
    def detect(self, value: Any) -> bool:
        raise NotImplementedError

    @abstractmethod
    def read_file(self, path: str) -> Any:
        raise NotImplementedError

    @abstractmethod
    def shape(self, frame: Any) -> dict[str, int]:
        raise NotImplementedError

    @abstractmethod
    def schema(self, frame: Any) -> list[dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    def apply_filter_model(self, frame: Any, model: Mapping[str, Any]) -> Any:
        raise NotImplementedError

    @abstractmethod
    def page(self, frame: Any, offset: int, limit: int) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def summaries(self, frame: Any, columns: Iterable[str] | None = None) -> list[dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    def column_values(
        self, frame: Any, column: str, search: str | None = None, limit: int = 100
    ) -> tuple[list[dict[str, Any]], bool]:
        raise NotImplementedError


def normalize_cell(value: Any) -> dict[str, Any]:
    is_null = value is None
    is_nan = False
    if isinstance(value, float):
        is_nan = isnan(value)

    if is_null:
        display = ""
        raw: Any = None
    elif is_nan:
        display = "NaN"
        raw = None
    else:
        display = str(value)
        raw = value if isinstance(value, (str, int, float, bool)) else display

    return {
        "raw": raw,
        "display": display,
        "isNull": is_null,
        "isNaN": is_nan,
    }


def infer_semantic_type(raw_type: str) -> ColumnType:
    lowered = raw_type.lower()
    if any(token in lowered for token in ("int", "uint")):
        return "integer"
    if any(token in lowered for token in ("float", "double", "decimal")):
        return "float"
    if "bool" in lowered:
        return "boolean"
    if "datetime" in lowered or "timestamp" in lowered:
        return "datetime"
    if lowered == "date" or lowered.endswith("[date]"):
        return "date"
    if any(token in lowered for token in ("str", "utf8", "object", "category", "categorical")):
        return "string"
    return "unknown"


def predicate_value(predicate: Mapping[str, Any], key: str = "value") -> Any:
    return predicate.get(key)
