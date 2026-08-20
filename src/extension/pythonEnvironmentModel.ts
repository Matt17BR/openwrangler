import { Buffer } from "node:buffer";
import type { DataBackend, SessionSource } from "../shared/protocol";

export type FileDataBackend = Extract<DataBackend, "pandas" | "polars" | "duckdb">;

export interface PythonDependency {
  importModule: string;
  distribution: string;
  installSpec: string;
  exactVersion?: string;
  minimumVersion?: string;
  maximumVersionExclusive?: string;
}

// BEGIN GENERATED PYTHON RUNTIME DEPENDENCIES
type PythonRuntimeDependencyId =
  "polars" | "duckdb" | "fsspec" | "pytz" | "pandas" | "pyarrow" | "openpyxl" | "xlrd" | "ipython" | "fastexcel";

const PYTHON_RUNTIME_DEPENDENCIES: Readonly<Record<PythonRuntimeDependencyId, Readonly<PythonDependency>>> =
  Object.freeze({
    polars: Object.freeze({
      importModule: "polars",
      distribution: "polars",
      installSpec: "polars>=1.35.2,<2",
      minimumVersion: "1.35.2",
      maximumVersionExclusive: "2"
    }),
    duckdb: Object.freeze({
      importModule: "duckdb",
      distribution: "duckdb",
      installSpec: "duckdb>=1.5.4,<1.6",
      minimumVersion: "1.5.4",
      maximumVersionExclusive: "1.6"
    }),
    fsspec: Object.freeze({
      importModule: "fsspec",
      distribution: "fsspec",
      installSpec: "fsspec==2026.7.0",
      exactVersion: "2026.7.0"
    }),
    pytz: Object.freeze({
      importModule: "pytz",
      distribution: "pytz",
      installSpec: "pytz>=2026.3.post1,<2027",
      minimumVersion: "2026.3.post1",
      maximumVersionExclusive: "2027"
    }),
    pandas: Object.freeze({
      importModule: "pandas",
      distribution: "pandas",
      installSpec: "pandas>=2.2,<3",
      minimumVersion: "2.2",
      maximumVersionExclusive: "3"
    }),
    pyarrow: Object.freeze({
      importModule: "pyarrow",
      distribution: "pyarrow",
      installSpec: "pyarrow>=25,<26",
      minimumVersion: "25",
      maximumVersionExclusive: "26"
    }),
    openpyxl: Object.freeze({
      importModule: "openpyxl",
      distribution: "openpyxl",
      installSpec: "openpyxl>=3.1.5,<4",
      minimumVersion: "3.1.5",
      maximumVersionExclusive: "4"
    }),
    xlrd: Object.freeze({
      importModule: "xlrd",
      distribution: "xlrd",
      installSpec: "xlrd>=2.0.1,<3",
      minimumVersion: "2.0.1",
      maximumVersionExclusive: "3"
    }),
    ipython: Object.freeze({
      importModule: "IPython",
      distribution: "ipython",
      installSpec: "ipython>=8.31,<10",
      minimumVersion: "8.31",
      maximumVersionExclusive: "10"
    }),
    fastexcel: Object.freeze({
      importModule: "fastexcel",
      distribution: "fastexcel",
      installSpec: "fastexcel>=0.9,<1",
      minimumVersion: "0.9",
      maximumVersionExclusive: "1"
    })
  });
// END GENERATED PYTHON RUNTIME DEPENDENCIES

export interface BackendImportCapabilityFailure {
  option: "delimiter" | "encoding" | "quoteChar";
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
  const encoding = source.importOptions?.encoding?.toLowerCase();
  if ((encoding === "utf-16le" || encoding === "utf-16be") && backend !== "pandas") {
    const displayEncoding = encoding === "utf-16le" ? "UTF-16LE" : "UTF-16BE";
    return {
      option: "encoding",
      message: `${backendLabel(backend)} cannot open CSV or TSV files with ${displayEncoding} input.`,
      detail: `Choose the Pandas backend for ${displayEncoding} input, or select another text encoding.`
    };
  }
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
    add(runtimeDependency("duckdb"));
    add(runtimeDependency("fsspec"));
    add(runtimeDependency("pytz"));
  } else {
    add(runtimeDependency(backend));
  }
  if (extension === "parquet" && backend === "pandas") {
    add(runtimeDependency("pyarrow"));
  }
  if (extension === "xlsx" && backend === "pandas") {
    add(runtimeDependency("openpyxl"));
  }
  if (extension === "xls" && backend === "pandas") {
    add(runtimeDependency("xlrd"));
  }
  if ((extension === "xlsx" || extension === "xls") && backend === "polars") {
    add(runtimeDependency("fastexcel"));
  }
  return [...dependencies.values()];
}

export function trustedPickleConversionDependencies(): PythonDependency[] {
  return [runtimeDependency("pandas"), runtimeDependency("pyarrow")];
}

export function isSupportedPythonVersion(major: number, minor: number): boolean {
  return major === 3 && minor >= 10 && minor <= 14;
}

function isDelimitedFile(source: SessionSource): boolean {
  if (source.kind !== "file") return false;
  const extension = source.path?.split(".").pop()?.toLowerCase();
  return extension === "csv" || extension === "tsv";
}

function runtimeDependency(identifier: PythonRuntimeDependencyId): PythonDependency {
  return { ...PYTHON_RUNTIME_DEPENDENCIES[identifier] };
}

function isMultibyteCodePoint(value: string): boolean {
  return [...value].length === 1 && Buffer.byteLength(value, "utf8") > 1;
}

function backendLabel(backend: FileDataBackend): string {
  if (backend === "duckdb") return "DuckDB";
  if (backend === "polars") return "Polars";
  return "Pandas";
}
