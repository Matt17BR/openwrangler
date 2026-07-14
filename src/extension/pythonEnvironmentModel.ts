import type { DataBackend, SessionSource } from "../shared/protocol";

export function requiredModules(backend: DataBackend, source: SessionSource): string[] {
  const extension = source.path?.split(".").pop()?.toLowerCase();
  const modules = new Set<string>([backend]);
  if (extension === "parquet" && backend === "pandas") modules.add("pyarrow");
  if ((extension === "xlsx" || extension === "xls") && backend === "pandas") modules.add("openpyxl");
  if ((extension === "xlsx" || extension === "xls") && backend === "polars") modules.add("fastexcel");
  return [...modules];
}

export function isSupportedPythonVersion(major: number, minor: number): boolean {
  return major === 3 && minor >= 10 && minor <= 14;
}
