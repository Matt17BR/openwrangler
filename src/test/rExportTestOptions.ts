import type { CsvExportOptions, ExportOptions, ParquetExportOptions } from "../shared/protocol";

export const rCsvExportOptions: CsvExportOptions = Object.freeze({
  format: "csv",
  delimiter: ",",
  quoteChar: '"',
  encoding: "utf-8",
  header: true
});

export const rParquetExportOptions: ParquetExportOptions = Object.freeze({ format: "parquet" });

export function rExportOptions(format: "csv" | "parquet"): ExportOptions {
  return format === "csv" ? rCsvExportOptions : rParquetExportOptions;
}
