import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  decodeExcelSheetNames,
  discoverExcelSheetNames,
  type ExcelSheetDiscoveryExecutor
} from "../extension/files/excelSheetNames";

describe("Excel worksheet discovery", () => {
  it("uses the selected interpreter, exact source argument, bundled helper, and sanitized runtime environment", async () => {
    const execute = vi.fn<ExcelSheetDiscoveryExecutor>(async () => ({
      stdout: '["Overview","Résumé","2024"]'
    }));

    await expect(
      discoverExcelSheetNames(
        {
          pythonPath: "/env/bin/python",
          extensionPath: "/extension",
          sourcePath: "/workspace/[Live] report.xlsx",
          backend: "polars"
        },
        execute
      )
    ).resolves.toEqual(["Overview", "Résumé", "2024"]);

    const [executable, arguments_, options] = execute.mock.calls[0]!;
    expect(executable).toBe("/env/bin/python");
    expect(arguments_).toEqual([
      "-s",
      "-m",
      "openwrangler_runtime.excel_sheets",
      "--backend",
      "polars",
      "--source",
      "/workspace/[Live] report.xlsx"
    ]);
    expect(options).toMatchObject({
      cwd: "/extension",
      encoding: "utf8",
      shell: false,
      windowsHide: true
    });
    expect(options.env.PYTHONPATH).toBe(path.join("/extension", "python"));
    expect(options.env.PYTHONNOUSERSITE).toBe("1");
  });

  it.each([
    ["not JSON", "malformed"],
    ["[]", "count"],
    ['["Sheet","Sheet"]', "duplicate"],
    [`["${"x".repeat(1_025)}"]`, "name"]
  ])("rejects bounded or malformed runtime metadata: %s", (value, message) => {
    expect(() => decodeExcelSheetNames(value)).toThrow(message);
  });

  it("rejects unsupported backends and non-workbook paths before launching Python", async () => {
    const execute = vi.fn<ExcelSheetDiscoveryExecutor>();
    const base = {
      pythonPath: "/env/bin/python",
      extensionPath: "/extension",
      sourcePath: "/workspace/report.xlsx"
    };

    await expect(discoverExcelSheetNames({ ...base, backend: "duckdb" }, execute)).rejects.toThrow("does not support");
    await expect(
      discoverExcelSheetNames({ ...base, sourcePath: "/workspace/report.csv", backend: "pandas" }, execute)
    ).rejects.toThrow("only .xls or .xlsx");
    expect(execute).not.toHaveBeenCalled();
  });
});
