from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from textwrap import dedent

import pytest

IMPLEMENTATION_MODULES = (
    "openwrangler_runtime.engines.duckdb_engine",
    "openwrangler_runtime.engines.pandas_engine",
    "openwrangler_runtime.engines.polars_engine",
    "openwrangler_runtime.engines.pyspark_engine",
)
PYTHON_ROOT = Path(__file__).parents[1]


def _run_fresh_runtime(script: str) -> dict[str, object]:
    environment = dict(os.environ)
    environment["PYTHONPATH"] = os.pathsep.join(
        item for item in (str(PYTHON_ROOT), environment.get("PYTHONPATH", "")) if item
    )
    completed = subprocess.run(
        [sys.executable, "-c", dedent(script)],
        check=True,
        capture_output=True,
        text=True,
        timeout=20,
        env=environment,
    )
    return json.loads(completed.stdout)


def test_fresh_standalone_initialize_imports_no_backend_implementations() -> None:
    result = _run_fresh_runtime(
        f"""
        import json
        import sys

        import openwrangler_runtime.engines as engines
        from openwrangler_runtime.server import dispatch
        from openwrangler_runtime.session import SessionManager

        response = dispatch(SessionManager(), {{"kind": "initialize"}})
        implementations = {IMPLEMENTATION_MODULES!r}
        print(json.dumps({{
            "kind": response["kind"],
            "loaded": [name for name in implementations if name in sys.modules],
            "publicClassesVisible": all(
                name in dir(engines)
                for name in ("DuckDBEngine", "PandasEngine", "PolarsEngine", "PySparkEngine")
            ),
        }}))
        """
    )

    assert result == {"kind": "initialized", "loaded": [], "publicClassesVisible": True}


@pytest.mark.parametrize("backend", ["polars", "pyspark", "duckdb", "pandas"])
def test_explicit_backend_creation_imports_only_its_implementation(backend: str) -> None:
    result = _run_fresh_runtime(
        f"""
        import json
        import sys

        from openwrangler_runtime.engines import default_engine_registry

        engine = default_engine_registry().create({backend!r})
        implementations = {IMPLEMENTATION_MODULES!r}
        print(json.dumps({{
            "backend": engine.name,
            "loaded": [name for name in implementations if name in sys.modules],
            "typeModule": type(engine).__module__,
        }}))
        engine.close()
        """
    )

    expected_module = f"openwrangler_runtime.engines.{backend}_engine"
    assert result == {
        "backend": backend,
        "loaded": [expected_module],
        "typeModule": expected_module,
    }


def test_public_engine_class_import_remains_lazy_and_compatible() -> None:
    result = _run_fresh_runtime(
        f"""
        import json
        import sys

        from openwrangler_runtime.engines import PandasEngine

        implementations = {IMPLEMENTATION_MODULES!r}
        print(json.dumps({{
            "className": PandasEngine.__name__,
            "loaded": [name for name in implementations if name in sys.modules],
            "module": PandasEngine.__module__,
        }}))
        """
    )

    assert result == {
        "className": "PandasEngine",
        "loaded": ["openwrangler_runtime.engines.pandas_engine"],
        "module": "openwrangler_runtime.engines.pandas_engine",
    }


def test_automatic_notebook_detection_intentionally_imports_candidates_in_order() -> None:
    result = _run_fresh_runtime(
        f"""
        import json
        import sys

        from openwrangler_runtime.engines import UnsupportedDataFrameError, default_engine_registry

        registry = default_engine_registry()
        try:
            registry.detect(object())
        except UnsupportedDataFrameError:
            pass
        else:
            raise AssertionError("An arbitrary object unexpectedly matched a dataframe backend.")
        implementations = {IMPLEMENTATION_MODULES!r}
        print(json.dumps({{
            "backends": registry.backends,
            "loaded": [name for name in implementations if name in sys.modules],
        }}))
        """
    )

    assert result == {
        "backends": ["polars", "pyspark", "duckdb", "pandas"],
        "loaded": list(IMPLEMENTATION_MODULES),
    }
