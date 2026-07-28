from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Literal

ExcelBackend = Literal["pandas", "polars"]

_MAX_SHEETS = 4_096
_MAX_SHEET_NAME_CHARACTERS = 1_024
_MAX_TOTAL_SHEET_NAME_CHARACTERS = 65_536


def list_excel_sheet_names(source: str | Path, backend: ExcelBackend) -> list[str]:
    path = Path(source)
    extension = path.suffix.lower()
    if extension not in {".xls", ".xlsx"}:
        raise ValueError("Excel sheet discovery accepts only .xls or .xlsx sources.")

    if backend == "polars":
        import fastexcel

        names = list(fastexcel.read_excel(path).sheet_names)
    elif backend == "pandas":
        import pandas as pd

        engine = "openpyxl" if extension == ".xlsx" else "xlrd"
        with pd.ExcelFile(path, engine=engine) as workbook:
            names = list(workbook.sheet_names)
    else:
        raise ValueError(f"Unsupported Excel sheet discovery backend: {backend}")

    return _validated_sheet_names(names)


def _validated_sheet_names(values: object) -> list[str]:
    if not isinstance(values, list) or not 1 <= len(values) <= _MAX_SHEETS:
        raise ValueError("The workbook returned an invalid worksheet count.")

    names: list[str] = []
    seen: set[str] = set()
    total_characters = 0
    for value in values:
        if not isinstance(value, str) or not value or len(value) > _MAX_SHEET_NAME_CHARACTERS:
            raise ValueError("The workbook returned an invalid worksheet name.")
        total_characters += len(value)
        if total_characters > _MAX_TOTAL_SHEET_NAME_CHARACTERS:
            raise ValueError("The workbook returned too much worksheet-name data.")
        if value in seen:
            raise ValueError("The workbook returned duplicate worksheet names.")
        seen.add(value)
        names.append(value)
    return names


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=("pandas", "polars"), required=True)
    parser.add_argument("--source", required=True)
    arguments = parser.parse_args()
    names = list_excel_sheet_names(arguments.source, arguments.backend)
    print(json.dumps(names, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
