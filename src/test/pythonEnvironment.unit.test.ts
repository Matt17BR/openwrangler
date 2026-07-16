import { describe, expect, it } from "vitest";
import type { SessionSource } from "../shared/protocol";
import { automaticBackends, isSupportedPythonVersion, requiredDependencies } from "../extension/pythonEnvironmentModel";

describe("Python environment requirements", () => {
  it("accepts exactly the supported Python minor range", () => {
    expect(isSupportedPythonVersion(3, 10)).toBe(true);
    expect(isSupportedPythonVersion(3, 14)).toBe(true);
    expect(isSupportedPythonVersion(3, 9)).toBe(false);
    expect(isSupportedPythonVersion(3, 15)).toBe(false);
    expect(isSupportedPythonVersion(2, 14)).toBe(false);
  });

  it("probes only modules required by the selected engine and format", () => {
    const parquet: SessionSource = { kind: "file", label: "data.parquet", path: "/tmp/data.parquet" };
    const excel: SessionSource = { kind: "file", label: "data.xlsx", path: "/tmp/data.xlsx" };

    expect(requiredDependencies("polars", parquet).map((item) => item.installSpec)).toEqual(["polars"]);
    expect(requiredDependencies("duckdb", parquet)).toEqual([
      {
        importModule: "duckdb",
        distribution: "duckdb",
        installSpec: "duckdb>=1.4.5,<1.6",
        minimumVersion: "1.4.5",
        maximumVersionExclusive: "1.6"
      }
    ]);
    expect(requiredDependencies("pandas", parquet).map((item) => item.installSpec)).toEqual(["pandas", "pyarrow"]);
    expect(requiredDependencies("polars", excel).map((item) => item.installSpec)).toEqual(["polars", "fastexcel"]);
  });

  it("prefers native engines deterministically without offering unsupported DuckDB inputs", () => {
    const parquet: SessionSource = { kind: "file", label: "data.parquet", path: "/tmp/data.parquet" };
    const excel: SessionSource = { kind: "file", label: "data.xlsx", path: "/tmp/data.xlsx" };
    const latin1: SessionSource = {
      kind: "file",
      label: "legacy.csv",
      path: "/tmp/legacy.csv",
      importOptions: { encoding: "latin-1" }
    };

    expect(automaticBackends(parquet)).toEqual(["polars", "duckdb", "pandas"]);
    expect(automaticBackends(excel)).toEqual(["polars", "pandas"]);
    expect(automaticBackends(latin1)).toEqual(["pandas"]);
  });
});
