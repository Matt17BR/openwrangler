import type { DataBackend, SessionSource } from "../shared/protocol";

export interface PythonDependency {
  importModule: string;
  distribution: string;
  installSpec: string;
  minimumVersion?: string;
  maximumVersionExclusive?: string;
}

export function automaticBackends(source: SessionSource): DataBackend[] {
  const extension = source.path?.split(".").pop()?.toLowerCase();
  const encoding = source.importOptions?.encoding?.toLowerCase();
  const nativeUtf8 = !encoding || ["utf-8", "utf8", "utf8-lossy"].includes(encoding);
  if (!nativeUtf8) return ["pandas"];
  if (extension === "xlsx" || extension === "xls") return ["polars", "pandas"];
  return ["polars", "duckdb", "pandas"];
}

export function requiredDependencies(backend: DataBackend, source: SessionSource): PythonDependency[] {
  const extension = source.path?.split(".").pop()?.toLowerCase();
  const dependencies = new Map<string, PythonDependency>();
  const add = (dependency: PythonDependency): void => {
    dependencies.set(dependency.importModule, dependency);
  };
  if (backend === "duckdb") {
    add({
      importModule: "duckdb",
      distribution: "duckdb",
      installSpec: "duckdb>=1.4.5,<1.6",
      minimumVersion: "1.4.5",
      maximumVersionExclusive: "1.6"
    });
  } else {
    add({ importModule: backend, distribution: backend, installSpec: backend });
  }
  if (extension === "parquet" && backend === "pandas") {
    add({ importModule: "pyarrow", distribution: "pyarrow", installSpec: "pyarrow" });
  }
  if ((extension === "xlsx" || extension === "xls") && backend === "pandas") {
    add({ importModule: "openpyxl", distribution: "openpyxl", installSpec: "openpyxl" });
  }
  if ((extension === "xlsx" || extension === "xls") && backend === "polars") {
    add({ importModule: "fastexcel", distribution: "fastexcel", installSpec: "fastexcel" });
  }
  return [...dependencies.values()];
}

export function isSupportedPythonVersion(major: number, minor: number): boolean {
  return major === 3 && minor >= 10 && minor <= 14;
}
