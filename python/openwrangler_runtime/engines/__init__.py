from importlib import import_module
from typing import TYPE_CHECKING, Any

from .base import AmbiguousViewColumnError, DataFrameEngine, EngineCapabilities, EngineError, SessionDataShape
from .registry import EngineRegistry, UnsupportedDataFrameError, default_engine_registry

if TYPE_CHECKING:
    from .duckdb_engine import DuckDBEngine
    from .pandas_engine import PandasEngine
    from .polars_engine import PolarsEngine
    from .pyspark_engine import PySparkEngine

_IMPLEMENTATION_EXPORTS = {
    "DuckDBEngine": (".duckdb_engine", "DuckDBEngine"),
    "PandasEngine": (".pandas_engine", "PandasEngine"),
    "PolarsEngine": (".polars_engine", "PolarsEngine"),
    "PySparkEngine": (".pyspark_engine", "PySparkEngine"),
}


def __getattr__(name: str) -> Any:
    implementation = _IMPLEMENTATION_EXPORTS.get(name)
    if implementation is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module_name, attribute_name = implementation
    value = getattr(import_module(module_name, __name__), attribute_name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted((*globals(), *_IMPLEMENTATION_EXPORTS))


__all__ = [
    "AmbiguousViewColumnError",
    "DataFrameEngine",
    "DuckDBEngine",
    "EngineCapabilities",
    "EngineError",
    "EngineRegistry",
    "PandasEngine",
    "PolarsEngine",
    "PySparkEngine",
    "SessionDataShape",
    "UnsupportedDataFrameError",
    "default_engine_registry",
]
