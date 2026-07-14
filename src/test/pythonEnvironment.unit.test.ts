import { describe, expect, it } from "vitest";
import type { SessionSource } from "../shared/protocol";
import { isSupportedPythonVersion, requiredModules } from "../extension/pythonEnvironmentModel";

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

    expect(requiredModules("polars", parquet)).toEqual(["polars"]);
    expect(requiredModules("pandas", parquet)).toEqual(["pandas", "pyarrow"]);
    expect(requiredModules("polars", excel)).toEqual(["polars", "fastexcel"]);
  });
});
