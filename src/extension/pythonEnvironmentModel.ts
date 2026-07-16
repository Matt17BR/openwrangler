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
  if (encoding === "utf8-lossy") return ["pandas"];
  const nativeUtf8 = !encoding || ["utf-8", "utf8"].includes(encoding);
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

export function isSupportedPythonVersion(major: number, minor: number): boolean {
  return major === 3 && minor >= 10 && minor <= 14;
}
