# Data Explorer

Data Explorer is a visualization-first VS Code extension for exploring dataframes and local data files. It focuses on fast viewing, paging, summaries, and Excel-like filters instead of transformation pipelines.

## Features

- Native Polars and Pandas runtime backends.
- Direct launch for CSV, TSV, Parquet, JSONL, XLSX, and XLS files.
- Paged dataframe grid with sticky headers and row numbers.
- Column schema, summary statistics, top values, and missing value counts.
- Multi-column sorting and column filters from the webview.
- Notebook variable launch command for Pandas and Polars dataframe names.

## Development

```bash
npm install
python3 -m venv .venv
.venv/bin/python -m pip install -e "python[dev]"
npm run build
npm test
```

Run the extension from VS Code with `Launch Extension`, or package it with:

```bash
npm run package
```
