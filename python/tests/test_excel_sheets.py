from __future__ import annotations

import base64
import gzip
from pathlib import Path

import pandas as pd
import pytest

from openwrangler_runtime.excel_sheets import ExcelBackend, list_excel_sheet_names

ROOT = Path(__file__).resolve().parents[2]


def _write_legacy_xls(path: Path) -> None:
    encoded = (ROOT / "fixtures" / "legacy.xls.gz.base64").read_text(encoding="ascii")
    path.write_bytes(gzip.decompress(base64.b64decode(encoded)))


@pytest.mark.parametrize("backend", ["pandas", "polars"])
@pytest.mark.parametrize("extension", ["xlsx", "xls"])
def test_lists_actual_workbook_sheet_names_in_order(backend: ExcelBackend, extension: str, tmp_path: Path) -> None:
    path = tmp_path / f"workbook.{extension}"
    if extension == "xls":
        _write_legacy_xls(path)
        expected = ["first", "second"]
    else:
        with pd.ExcelWriter(path) as writer:
            pd.DataFrame({"value": [1]}).to_excel(writer, sheet_name="Overview", index=False)
            pd.DataFrame({"value": [2]}).to_excel(writer, sheet_name="Sales", index=False)
            pd.DataFrame({"value": [3]}).to_excel(writer, sheet_name="2024", index=False)
        expected = ["Overview", "Sales", "2024"]

    assert list_excel_sheet_names(path, backend) == expected


def test_rejects_non_excel_sources(tmp_path: Path) -> None:
    source = tmp_path / "rows.csv"
    source.write_text("value\n1\n", encoding="utf-8")

    with pytest.raises(ValueError, match="only .xls or .xlsx"):
        list_excel_sheet_names(source, "pandas")
