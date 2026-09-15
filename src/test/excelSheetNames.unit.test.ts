import * as path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  decodeExcelSheetNames,
  discoverExcelSheetNames,
  type ExcelSheetDiscoveryExecutor
} from "../extension/files/excelSheetNames";
import {
  decodeDuckDBTableNames,
  discoverDuckDBTableNames,
  type DuckDBTableDiscoveryExecutor
} from "../extension/files/duckdbTableNames";

const metadataProcess = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: metadataProcess.execute });
  return { execFile };
});

describe("Python metadata process ownership", () => {
  it.each(["Excel", "DuckDB"] as const)("keeps cancelled %s discovery pending until the child closes", async (kind) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true)
    });
    let rejectProcess!: (error: Error) => void;
    const processResult = Object.assign(
      new Promise<{ stdout: string }>((_resolve, reject) => {
        rejectProcess = reject;
      }),
      { child }
    );
    metadataProcess.execute.mockReturnValueOnce(processResult);
    const controller = new AbortController();
    const request = {
      pythonPath: "/env/bin/python",
      extensionPath: "/extension",
      sourcePath: "/data/input.xlsx",
      signal: controller.signal
    };
    const discovery =
      kind === "Excel" ? discoverExcelSheetNames({ ...request, backend: "pandas" }) : discoverDuckDBTableNames(request);
    let settled = false;
    const outcome = discovery.then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    const failure = new Error("The operation was aborted", { cause: "controlled cancellation" });
    failure.name = "AbortError";
    try {
      expect(metadataProcess.execute.mock.lastCall?.[2]).toMatchObject({ killSignal: "SIGKILL" });
      controller.abort();
      rejectProcess(failure);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      child.signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      child.signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
      child.emit("close", null, "SIGKILL");
      expect(await outcome).toBe(failure);
    }
  });

  it("decodes normal metadata when result and close settle in the same turn", async () => {
    const child = new EventEmitter();
    let finish!: (result: { stdout: string }) => void;
    metadataProcess.execute.mockReturnValueOnce(
      Object.assign(
        new Promise<{ stdout: string }>((resolve) => {
          finish = resolve;
        }),
        { child }
      )
    );
    const discovery = discoverDuckDBTableNames({
      pythonPath: "/env/bin/python",
      extensionPath: "/extension",
      sourcePath: "/data/input"
    });
    finish({ stdout: '[{"schema":"main","name":"orders"}]' });
    child.emit("close", 0, null);
    await expect(discovery).resolves.toEqual([{ schema: "main", name: "orders" }]);
  });

  it("preserves a spawn failure after close without waiting for an exit event", async () => {
    const child = new EventEmitter();
    let rejectProcess!: (error: Error) => void;
    metadataProcess.execute.mockReturnValueOnce(
      Object.assign(
        new Promise<{ stdout: string }>((_resolve, reject) => {
          rejectProcess = reject;
        }),
        { child }
      )
    );
    const discovery = discoverDuckDBTableNames({
      pythonPath: "/missing/python",
      extensionPath: "/extension",
      sourcePath: "/data/input"
    });
    const failure = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const outcome = discovery.catch((error: unknown) => error);
    rejectProcess(failure);
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.emit("close", -2, null);
    expect(await outcome).toBe(failure);
  });
});

describe("DuckDB table discovery", () => {
  it("uses the pinned interpreter and literal filename with bounded cancellable native discovery", async () => {
    const execute = vi.fn<DuckDBTableDiscoveryExecutor>(async () => ({
      stdout: '[{"schema":"main","name":"orders"}]'
    }));
    const controller = new AbortController();
    const sourcePath = '/workspace/[data] "quarter"';
    await expect(
      discoverDuckDBTableNames(
        {
          pythonPath: "/env/bin/python",
          extensionPath: "/extension",
          sourcePath,
          signal: controller.signal
        },
        execute
      )
    ).resolves.toEqual([{ schema: "main", name: "orders" }]);
    const [executable, arguments_, options] = execute.mock.calls[0]!;
    expect(executable).toBe("/env/bin/python");
    expect(arguments_).toEqual(["-s", "-m", "openwrangler_runtime.duckdb_tables", "--source", sourcePath]);
    expect(options).toMatchObject({
      cwd: "/extension",
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      timeout: 15_000,
      shell: false,
      windowsHide: true,
      signal: controller.signal
    });
    expect(options.env.PYTHONPATH).toBe(path.join("/extension", "python"));
    expect(options.env.PYTHONNOUSERSITE).toBe("1");
  });

  it("retains exact scalar names, distinguishes schema/table pairs, and accepts empty catalogs", () => {
    const tables = [
      { schema: "a.b", name: "c" },
      { schema: "a", name: "b.c" },
      { schema: " main ", name: ' "订单"\n ' },
      { schema: "main", name: "😀".repeat(1_024) }
    ];
    expect(decodeDuckDBTableNames(JSON.stringify(tables))).toEqual(tables);
    expect(decodeDuckDBTableNames("[]")).toEqual([]);
    const full = Array.from({ length: 4_096 }, (_, index) => ({ schema: "s", name: String(index) }));
    expect(decodeDuckDBTableNames(JSON.stringify(full))).toHaveLength(4_096);
  });

  it.each([
    ["malformed JSON", "not JSON"],
    ["unknown fields", JSON.stringify([{ schema: "main", name: "orders", sql: "SELECT 1" }])],
    ["empty name", JSON.stringify([{ schema: "main", name: "" }])],
    ["NUL", JSON.stringify([{ schema: "main", name: "a\0b" }])],
    ["lone surrogate", '[{"schema":"main","name":"\\ud800"}]'],
    ["character count", JSON.stringify([{ schema: "main", name: "😀".repeat(1_025) }])],
    [
      "duplicate pair",
      JSON.stringify([
        { schema: "s", name: "t" },
        { schema: "s", name: "t" }
      ])
    ],
    [
      "table count",
      JSON.stringify(Array.from({ length: 4_097 }, (_, index) => ({ schema: "s", name: String(index) })))
    ],
    [
      "aggregate UTF-8 bytes",
      JSON.stringify(Array.from({ length: 17 }, (_, index) => ({ schema: String(index), name: "😀".repeat(1_024) })))
    ],
    ["serialized output", " ".repeat(256 * 1024) + "[]"]
  ])("refuses invalid %s metadata", (_name, output) => {
    expect(() => decodeDuckDBTableNames(output)).toThrow("invalid DuckDB table metadata");
  });
});

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
