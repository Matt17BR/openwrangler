import { Buffer } from "node:buffer";
import type { DataBackend, SessionSource } from "../shared/protocol";

export type FileDataBackend = Extract<DataBackend, "pandas" | "polars" | "duckdb">;

export interface PythonDependency {
  importModule: string;
  distribution: string;
  installSpec: string;
  minimumVersion?: string;
  maximumVersionExclusive?: string;
}

export interface BackendImportCapabilityFailure {
  option: "delimiter" | "quoteChar";
  message: string;
  detail: string;
}

export function isFileDataBackend(backend: DataBackend): backend is FileDataBackend {
  return backend === "polars" || backend === "duckdb" || backend === "pandas";
}

export function automaticBackends(source: SessionSource): FileDataBackend[] {
  const extension = source.path?.split(".").pop()?.toLowerCase();
  const encoding = source.importOptions?.encoding?.toLowerCase();
  if (encoding === "utf8-lossy") return ["pandas"];
  const nativeUtf8 = !encoding || ["utf-8", "utf8"].includes(encoding);
  if (!nativeUtf8) return ["pandas"];
  if (extension === "xlsx" || extension === "xls") return ["polars", "pandas"];
  return (["polars", "duckdb", "pandas"] as const).filter(
    (backend) => backendImportCapabilityFailure(backend, source) === undefined
  );
}

export function backendImportCapabilityFailure(
  backend: FileDataBackend,
  source: SessionSource
): BackendImportCapabilityFailure | undefined {
  if (!isDelimitedFile(source)) return undefined;
  const quoteChar = source.importOptions?.quoteChar;
  if (quoteChar && isMultibyteCodePoint(quoteChar) && backend !== "pandas") {
    return {
      option: "quoteChar",
      message: `${backendLabel(backend)} cannot open CSV or TSV files with a multibyte UTF-8 quote character.`,
      detail: `Choose the Pandas backend for quote character ${JSON.stringify(quoteChar)}, or select a one-byte quote character.`
    };
  }
  const delimiter = source.importOptions?.delimiter;
  if (delimiter && isMultibyteCodePoint(delimiter) && backend === "polars") {
    return {
      option: "delimiter",
      message: "Polars cannot open CSV or TSV files with a multibyte UTF-8 delimiter.",
      detail: `Choose the DuckDB or Pandas backend for delimiter ${JSON.stringify(delimiter)}, or select a one-byte delimiter.`
    };
  }
  return undefined;
}

export function requiredDependencies(backend: FileDataBackend, source: SessionSource): PythonDependency[] {
  const extension = source.path?.split(".").pop()?.toLowerCase();
  const dependencies = new Map<string, PythonDependency>();
  const add = (dependency: PythonDependency): void => {
    dependencies.set(dependency.importModule, dependency);
  };
  if (backend === "duckdb") {
    add({
      importModule: "duckdb",
      distribution: "duckdb",
      installSpec: "duckdb>=1.5.4,<1.6",
      minimumVersion: "1.5.4",
      maximumVersionExclusive: "1.6"
    });
    add({
      importModule: "pytz",
      distribution: "pytz",
      installSpec: "pytz"
    });
  } else {
    add({ importModule: backend, distribution: backend, installSpec: backend });
  }
  if (extension === "parquet" && backend === "pandas") {
    add({ importModule: "pyarrow", distribution: "pyarrow", installSpec: "pyarrow" });
  }
  if (extension === "xlsx" && backend === "pandas") {
    add({
      importModule: "openpyxl",
      distribution: "openpyxl",
      installSpec: "openpyxl>=3.1.5",
      minimumVersion: "3.1.5"
    });
  }
  if (extension === "xls" && backend === "pandas") {
    add({
      importModule: "xlrd",
      distribution: "xlrd",
      installSpec: "xlrd>=2.0.1",
      minimumVersion: "2.0.1"
    });
  }
  if ((extension === "xlsx" || extension === "xls") && backend === "polars") {
    add({
      importModule: "fastexcel",
      distribution: "fastexcel",
      installSpec: "fastexcel>=0.9",
      minimumVersion: "0.9"
    });
  }
  return [...dependencies.values()];
}

export function trustedPickleConversionDependencies(): PythonDependency[] {
  return [
    { importModule: "pandas", distribution: "pandas", installSpec: "pandas" },
    { importModule: "pyarrow", distribution: "pyarrow", installSpec: "pyarrow" }
  ];
}

export function isSupportedPythonVersion(major: number, minor: number): boolean {
  return major === 3 && minor >= 10 && minor <= 14;
}

function isDelimitedFile(source: SessionSource): boolean {
  if (source.kind !== "file") return false;
  const extension = source.path?.split(".").pop()?.toLowerCase();
  return extension === "csv" || extension === "tsv";
}

function isMultibyteCodePoint(value: string): boolean {
  return [...value].length === 1 && Buffer.byteLength(value, "utf8") > 1;
}

function backendLabel(backend: FileDataBackend): string {
  if (backend === "duckdb") return "DuckDB";
  if (backend === "polars") return "Polars";
  return "Pandas";
}
