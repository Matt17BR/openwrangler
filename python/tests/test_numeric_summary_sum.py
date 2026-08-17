from __future__ import annotations

from decimal import Decimal

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine
from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.engines.polars_engine import PolarsEngine


def assert_integer_sum(numeric: dict[str, object], expected: str) -> None:
    exact = numeric["exactSum"]
    assert isinstance(exact, dict)
    assert exact == {
        "kind": "integer",
        "raw": int(expected) if -(2**53) + 1 <= int(expected) <= (2**53) - 1 else expected,
        "display": expected,
        "isNull": False,
        "isNaN": False,
    }


def test_pandas_sum_excludes_null_nan_and_preserves_wide_integer_and_decimal_values() -> None:
    frame = pd.DataFrame(
        {
            "wide": pd.Series([9_007_199_254_740_993, 2, pd.NA], dtype=object),
            "amount": pd.Series([Decimal("1.20"), Decimal("2.30"), None], dtype=object),
            "missing": pd.Series([None, float("nan")], dtype="Float64"),
        }
    )

    summaries = {summary["column"]: summary["numeric"] for summary in PandasEngine().summaries(frame)}

    assert summaries["wide"]["sum"] == float(9_007_199_254_740_995)
    assert_integer_sum(summaries["wide"], "9007199254740995")
    assert summaries["amount"]["sum"] == 3.5
    assert summaries["amount"]["exactSum"] == {
        "kind": "decimal",
        "raw": "3.50",
        "display": "3.50",
        "isNull": False,
        "isNaN": False,
    }
    assert summaries["missing"] == {"sum": 0.0}


def test_pandas_sum_is_unavailable_for_included_nonfinite_or_overflowing_decimals() -> None:
    frame = pd.DataFrame(
        {
            "nonfinite": pd.Series([Decimal("Infinity"), Decimal("1")], dtype=object),
            "opposites": pd.Series([Decimal("Infinity"), Decimal("-Infinity")], dtype=object),
        }
    )

    summaries = {summary["column"]: summary["numeric"] for summary in PandasEngine().summaries(frame)}

    assert "sum" not in summaries["nonfinite"]
    assert "exactSum" not in summaries["nonfinite"]
    assert "sum" not in summaries["opposites"]
    assert "exactSum" not in summaries["opposites"]


def test_pandas_all_missing_arrow_decimal_sum_preserves_declared_scale() -> None:
    pyarrow = pytest.importorskip("pyarrow")
    frame = pd.DataFrame({"amount": pd.Series([None, None], dtype=pd.ArrowDtype(pyarrow.decimal128(10, 4)))})

    numeric = PandasEngine().summaries(frame)[0]["numeric"]

    assert numeric["sum"] == 0.0
    assert numeric["exactSum"] == {
        "kind": "decimal",
        "raw": "0.0000",
        "display": "0.0000",
        "isNull": False,
        "isNaN": False,
    }


@pytest.mark.parametrize("lazy", [False, True])
def test_polars_sum_stays_native_and_normalizes_empty_integer_and_scaled_decimal(lazy: bool) -> None:
    frame = pl.DataFrame(
        {
            "missing": pl.Series([None, None, None], dtype=pl.Int64),
            "wide": pl.Series([9_007_199_254_740_993, 2, None], dtype=pl.Int64),
            "amount": pl.Series([Decimal("1.20"), Decimal("2.30"), None], dtype=pl.Decimal(10, 2)),
        }
    )
    source = frame.lazy() if lazy else frame

    summaries = {summary["column"]: summary["numeric"] for summary in PolarsEngine().summaries(source)}

    assert summaries["missing"]["sum"] == 0.0
    assert_integer_sum(summaries["missing"], "0")
    assert_integer_sum(summaries["wide"], "9007199254740995")
    assert summaries["amount"]["sum"] == 3.5
    assert summaries["amount"]["exactSum"]["display"] == "3.50"


def test_duckdb_sum_uses_native_aggregates_and_preserves_empty_decimal_scale() -> None:
    frame = duckdb.sql(
        """
        SELECT * FROM (VALUES
          (9007199254740993::HUGEINT, 1.20::DECIMAL(10,2)),
          (2::HUGEINT, 2.30::DECIMAL(10,2)),
          (NULL::HUGEINT, NULL::DECIMAL(10,2))
        ) source(value, amount)
        """
    )
    empty = duckdb.sql("SELECT NULL::DECIMAL(10,4) AS amount")

    summaries = {summary["column"]: summary["numeric"] for summary in DuckDBEngine().summaries(frame)}
    empty_summary = DuckDBEngine().summaries(empty)[0]["numeric"]

    assert summaries["value"]["sum"] == float(9_007_199_254_740_995)
    assert_integer_sum(summaries["value"], "9007199254740995")
    assert summaries["amount"]["sum"] == 3.5
    assert summaries["amount"]["exactSum"]["display"] == "3.50"
    assert empty_summary["sum"] == 0.0
    assert empty_summary["exactSum"]["display"] == "0.0000"
