import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import {
  CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY,
  MAX_CONFIRMED_FILE_CONFIGURATIONS,
  confirmedFileConfiguration,
  rememberConfirmedFileConfiguration
} from "../extension/files/confirmedFileConfigurations";
import { persistenceKey } from "../extension/sessionPersistence";

class MemoryMemento {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, fallback?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

describe("confirmed file configurations", () => {
  it("preserves automatic selection while restoring the exact resolved-backend persistence key", async () => {
    const workspaceState = new MemoryMemento();
    const uri = vscode.Uri.file("/workspace/sales.csv");
    const importOptions = {
      delimiter: ";",
      encoding: "windows-1252",
      quoteChar: "'",
      hasHeader: false
    } as const;

    await rememberConfirmedFileConfiguration(workspaceState, uri, importOptions, "pandas", "auto");
    const restored = confirmedFileConfiguration(workspaceState, uri);
    const confirmedSource = {
      kind: "file" as const,
      label: "sales.csv",
      path: "/workspace/sales.csv",
      uri: uri.toString(),
      importOptions
    };
    const reloadedSource = { ...confirmedSource, importOptions: restored?.importOptions };

    expect(restored).toEqual({ backend: "pandas", backendPreference: "auto", importOptions });
    expect(workspaceState.get(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY)).toEqual({
      version: 2,
      entries: [
        {
          uri: uri.toString(),
          backend: "pandas",
          backendPreference: "auto",
          importOptions
        }
      ]
    });
    expect(persistenceKey(reloadedSource, "pandas")).toBe(persistenceKey(confirmedSource, "pandas"));
    expect(persistenceKey(reloadedSource, "polars")).not.toBe(persistenceKey(confirmedSource, "pandas"));
  });

  it.each([
    ["csv", "r"],
    ["tsv", "r"],
    ["csv", "auto"]
  ] as const)(
    "retains local R %s configuration with %s preference under its own plan key",
    async (extension, preference) => {
      const workspaceState = new MemoryMemento();
      const uri = vscode.Uri.file(`/workspace/orders.${extension}`);
      const importOptions = {
        delimiter: extension === "tsv" ? "\t" : ",",
        encoding: "utf-8",
        quoteChar: '"',
        hasHeader: true
      };
      await rememberConfirmedFileConfiguration(workspaceState, uri, importOptions, "r", preference);
      const restored = confirmedFileConfiguration(workspaceState, uri);
      expect(restored).toEqual({ backend: "r", backendPreference: preference, importOptions });
      const source = {
        kind: "file" as const,
        label: `orders.${extension}`,
        path: uri.fsPath,
        uri: uri.toString(),
        importOptions
      };
      expect(persistenceKey({ ...source, importOptions: restored?.importOptions }, "r")).toBe(
        persistenceKey(source, "r")
      );
      expect(persistenceKey(source, "r")).not.toBe(persistenceKey(source, "polars"));
      expect(workspaceState.get(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY)).toEqual({
        version: 2,
        entries: [{ uri: uri.toString(), backend: "r", backendPreference: preference, importOptions }]
      });
    }
  );

  it.each([
    { label: "mismatched R preference", resource: "file:///workspace/orders.csv", backend: "polars", preference: "r" },
    {
      label: "mismatched Python preference",
      resource: "file:///workspace/orders.csv",
      backend: "r",
      preference: "polars"
    },
    {
      label: "remote R",
      resource: "vscode-remote://ssh-remote+host/workspace/orders.csv",
      backend: "r",
      preference: "r"
    },
    {
      label: "mixed import options",
      resource: "file:///workspace/orders.csv",
      backend: "r",
      preference: "r",
      mixed: true
    }
  ] as const)("rejects stored and newly confirmed $label", async ({ resource, backend, preference, ...extra }) => {
    const workspaceState = new MemoryMemento();
    const uri = vscode.Uri.parse(resource);
    const importOptions = resource.endsWith(".parquet")
      ? undefined
      : resource.endsWith(".xlsx")
        ? { sheetName: "Sheet1" }
        : {
            delimiter: ",",
            encoding: "utf-8",
            quoteChar: '"',
            hasHeader: true,
            ...("mixed" in extra ? { sheetName: "Sheet1" } : {})
          };
    await rememberConfirmedFileConfiguration(workspaceState, uri, importOptions, backend, preference);
    expect(workspaceState.get(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY)).toBeUndefined();
    await workspaceState.update(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
      version: 2,
      entries: [
        { uri: uri.toString(), backend, backendPreference: preference, ...(importOptions ? { importOptions } : {}) }
      ]
    });
    expect(confirmedFileConfiguration(workspaceState, uri)).toBeUndefined();
  });

  it.each([
    { extension: "parquet", importOptions: undefined },
    { extension: "jsonl", importOptions: undefined },
    { extension: "ndjson", importOptions: undefined },
    { extension: "xlsx", importOptions: { sheetName: "  " } },
    { extension: "xls", importOptions: { sheetIndex: 2 } }
  ])("restores explicit R $extension under the same backend/options plan key", async ({ extension, importOptions }) => {
    const workspaceState = new MemoryMemento();
    const uri = vscode.Uri.file(`/workspace/orders.${extension}`);
    const source = {
      kind: "file" as const,
      label: `orders.${extension}`,
      path: uri.fsPath,
      uri: uri.toString(),
      ...(importOptions ? { importOptions } : {})
    };
    await rememberConfirmedFileConfiguration(workspaceState, uri, importOptions, "r", "r");
    const restored = confirmedFileConfiguration(workspaceState, uri);
    expect(restored).toEqual({ backend: "r", backendPreference: "r", ...(importOptions ? { importOptions } : {}) });
    expect(
      persistenceKey({ ...source, ...(restored?.importOptions ? { importOptions: restored.importOptions } : {}) }, "r")
    ).toBe(persistenceKey(source, "r"));
    expect(persistenceKey(source, "r")).not.toBe(persistenceKey(source, "polars"));
  });

  it.each(["cr", "lf"] as const)(
    "round-trips explicit %s record intent without changing registry version",
    async (lineEnding) => {
      const workspaceState = new MemoryMemento();
      const uri = vscode.Uri.file("/workspace/records.csv");
      const importOptions = { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true, lineEnding };
      await rememberConfirmedFileConfiguration(workspaceState, uri, importOptions, "polars", "auto");
      expect(confirmedFileConfiguration(workspaceState, uri)).toEqual({
        backend: "polars",
        backendPreference: "auto",
        importOptions
      });
      expect(workspaceState.get(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY)).toEqual({
        version: 2,
        entries: [{ uri: uri.toString(), backend: "polars", backendPreference: "auto", importOptions }]
      });
    }
  );

  it.each([undefined, null, "CR", "crlf", "", {}, false])(
    "refuses malformed stored line-ending intent %j",
    async (lineEnding) => {
      const workspaceState = new MemoryMemento();
      const uri = vscode.Uri.file("/workspace/records.csv");
      await workspaceState.update(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
        version: 2,
        entries: [
          {
            uri: uri.toString(),
            backend: "polars",
            backendPreference: "auto",
            importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true, lineEnding }
          }
        ]
      });
      expect(confirmedFileConfiguration(workspaceState, uri)).toBeUndefined();
    }
  );

  it("strictly rejects malformed, mixed-format, wrong-version, inconsistent, and other-URI entries", async () => {
    const workspaceState = new MemoryMemento();
    const csv = vscode.Uri.file("/workspace/data.csv");
    const excel = vscode.Uri.file("/workspace/data.xlsx");
    await workspaceState.update(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
      version: 1,
      entries: [
        {
          uri: csv.toString(),
          backend: "pandas",
          backendPreference: "auto",
          importOptions: {
            delimiter: ",",
            encoding: "utf-8",
            quoteChar: '"',
            hasHeader: true
          }
        }
      ]
    });

    expect(confirmedFileConfiguration(workspaceState, csv)).toBeUndefined();

    await workspaceState.update(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
      version: 2,
      entries: [
        {
          uri: csv.toString(),
          backend: "not-an-engine",
          backendPreference: "auto",
          importOptions: {
            delimiter: ",",
            encoding: "utf-8",
            quoteChar: '"',
            hasHeader: true
          }
        },
        {
          uri: csv.toString(),
          backend: "pandas",
          importOptions: {
            delimiter: ",",
            encoding: "utf-8",
            quoteChar: '"',
            hasHeader: true
          }
        },
        {
          uri: csv.toString(),
          backend: "pandas",
          backendPreference: "not-an-engine",
          importOptions: {
            delimiter: ",",
            encoding: "utf-8",
            quoteChar: '"',
            hasHeader: true
          }
        },
        {
          uri: excel.toString(),
          backend: "pandas",
          backendPreference: "auto",
          importOptions: { sheetName: "Sheet 2", delimiter: "," }
        },
        {
          uri: excel.toString(),
          backend: "pandas",
          backendPreference: "auto",
          importOptions: { sheetName: "Sheet 2", lineEnding: "cr" }
        },
        {
          uri: vscode.Uri.file("/workspace/other.csv").toString(),
          backend: "polars",
          backendPreference: "auto",
          importOptions: {
            delimiter: ";",
            encoding: "utf-8",
            quoteChar: '"',
            hasHeader: true
          }
        }
      ]
    });

    expect(confirmedFileConfiguration(workspaceState, csv)).toBeUndefined();
    expect(confirmedFileConfiguration(workspaceState, excel)).toBeUndefined();

    await workspaceState.update(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
      version: 2,
      entries: [
        {
          uri: csv.toString(),
          backend: "pandas",
          backendPreference: "polars",
          importOptions: {
            delimiter: ";",
            encoding: "utf-8",
            quoteChar: '"',
            hasHeader: true
          }
        }
      ]
    });
    expect(confirmedFileConfiguration(workspaceState, csv)).toBeUndefined();

    const unwrittenState = new MemoryMemento();
    await rememberConfirmedFileConfiguration(
      unwrittenState,
      csv,
      { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true },
      "pandas",
      "polars"
    );
    expect(unwrittenState.get(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY)).toBeUndefined();
  });

  it.each([
    ["Parquet", "/workspace/data.parquet", "duckdb" as const, "auto" as const],
    ["JSONL", "/workspace/data.jsonl", "pandas" as const, "pandas" as const],
    ["NDJSON", "/workspace/data.ndjson", "polars" as const, "auto" as const]
  ])(
    "retains the resolved backend and logical preference for %s without inventing import options",
    async (_label, file, backend, backendPreference) => {
      const workspaceState = new MemoryMemento();
      const uri = vscode.Uri.file(file);

      await rememberConfirmedFileConfiguration(workspaceState, uri, undefined, backend, backendPreference);

      expect(confirmedFileConfiguration(workspaceState, uri)).toEqual({ backend, backendPreference });
    }
  );

  it("rejects an import-options field on non-configurable file formats", async () => {
    const workspaceState = new MemoryMemento();
    const uri = vscode.Uri.file("/workspace/data.parquet");
    await workspaceState.update(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
      version: 2,
      entries: [{ uri: uri.toString(), backend: "duckdb", backendPreference: "auto", importOptions: {} }]
    });

    expect(confirmedFileConfiguration(workspaceState, uri)).toBeUndefined();
  });

  it.each(["pkl", "pickle"])("never retains a Python pickle source configuration (%s)", async (extension) => {
    const workspaceState = new MemoryMemento();
    const uri = vscode.Uri.file(`/workspace/untrusted.${extension}`);

    await rememberConfirmedFileConfiguration(workspaceState, uri, undefined, "pandas", "pandas");

    expect(workspaceState.get(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY)).toBeUndefined();
    expect(confirmedFileConfiguration(workspaceState, uri)).toBeUndefined();
  });

  it.each(["Archive", " "])("retains exact sheet %j and the resolved backend preference", async (sheetName) => {
    const workspaceState = new MemoryMemento();
    const uri = vscode.Uri.file("/workspace/data.xlsx");

    await rememberConfirmedFileConfiguration(workspaceState, uri, { sheetName }, "polars", "auto");
    expect(confirmedFileConfiguration(workspaceState, uri)).toEqual({
      backend: "polars",
      backendPreference: "auto",
      importOptions: { sheetName }
    });

    await rememberConfirmedFileConfiguration(workspaceState, uri, { sheetIndex: 0 }, "pandas", "pandas");
    expect(confirmedFileConfiguration(workspaceState, uri)).toEqual({
      backend: "pandas",
      backendPreference: "pandas",
      importOptions: { sheetIndex: 0 }
    });
  });

  it("keeps only the most recent bounded set of canonical URI entries", async () => {
    const workspaceState = new MemoryMemento();
    for (let index = 0; index < MAX_CONFIRMED_FILE_CONFIGURATIONS + 3; index += 1) {
      await rememberConfirmedFileConfiguration(
        workspaceState,
        vscode.Uri.file(`/workspace/${index}.csv`),
        {
          delimiter: ";",
          encoding: "utf-8",
          quoteChar: '"',
          hasHeader: true
        },
        "polars",
        "auto"
      );
    }

    expect(confirmedFileConfiguration(workspaceState, vscode.Uri.file("/workspace/0.csv"))).toBeUndefined();
    expect(
      confirmedFileConfiguration(
        workspaceState,
        vscode.Uri.file(`/workspace/${MAX_CONFIRMED_FILE_CONFIGURATIONS + 2}.csv`)
      )
    ).toEqual({
      backend: "polars",
      backendPreference: "auto",
      importOptions: {
        delimiter: ";",
        encoding: "utf-8",
        quoteChar: '"',
        hasHeader: true
      }
    });
  });
});
