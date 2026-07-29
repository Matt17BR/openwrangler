# Product gallery

The two primary README images stay compact. This gallery records additional engine surfaces from deterministic,
license-clean fixtures without implying support that the extension does not provide.

## DuckDB rich Parquet file

![Open Wrangler displaying a file-backed DuckDB Parquet source with decimal, time-zone, list, and struct columns](images/readme/v1.1/gallery/duckdb-rich-parquet.png)

This scene uses the production webview bundle and a native DuckDB session over a deterministic 100,000-row
Parquet file. Decimal, time-zone-aware timestamp, list, and struct values remain typed through the grid and
summaries. DuckDB notebook relations are not currently supported.

## Polars live notebook

![Open Wrangler displaying a live native Polars notebook session with a formula draft, data diff, and generated Polars code](images/readme/v1.1/gallery/notebook-polars.png)

This unaltered packaged VS Code capture shows the notebook and Open Wrangler workbench together. The session
keeps the dataframe in Polars while paging, profiling, previewing the draft, and generating executable Polars
code.

## PySpark Classic live notebook

![Open Wrangler displaying a 100,000-row PySpark Classic notebook DataFrame with selected revenue insights](images/readme/v1.1/gallery/pyspark-live-notebook.png)

This scene comes from the real packaged VS Code and Jupyter path over deterministic regional-orders data. It is
an experimental, viewing-only live notebook session. Filtering, sorting, bounded paging, and requested profiling
run in Spark. No PySpark file opening, cleaning, data export, code insertion, or saved inline snapshot is shown or
supported here.
