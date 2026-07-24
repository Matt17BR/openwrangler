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
  it("restores the exact source-and-backend persistence key after a custom-editor reload", async () => {
    const workspaceState = new MemoryMemento();
    const uri = vscode.Uri.file("/workspace/sales.csv");
    const importOptions = {
      delimiter: ";",
      encoding: "windows-1252",
      quoteChar: "'",
      hasHeader: false
    } as const;

    await rememberConfirmedFileConfiguration(workspaceState, uri, importOptions, "pandas");
    const restored = confirmedFileConfiguration(workspaceState, uri);
    const confirmedSource = {
      kind: "file" as const,
      label: "sales.csv",
      path: "/workspace/sales.csv",
      uri: uri.toString(),
      importOptions
    };
    const reloadedSource = { ...confirmedSource, importOptions: restored?.importOptions };

    expect(restored).toEqual({ backend: "pandas", importOptions });
    expect(persistenceKey(reloadedSource, "pandas")).toBe(persistenceKey(confirmedSource, "pandas"));
    expect(persistenceKey(reloadedSource, "polars")).not.toBe(persistenceKey(confirmedSource, "pandas"));
  });

  it("strictly rejects malformed, mixed-format, wrong-version, unknown-backend, and other-URI entries", async () => {
    const workspaceState = new MemoryMemento();
    const csv = vscode.Uri.file("/workspace/data.csv");
    const excel = vscode.Uri.file("/workspace/data.xlsx");
    await workspaceState.update(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
      version: 1,
      entries: [
        {
          uri: csv.toString(),
          backend: "not-an-engine",
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
          importOptions: { sheetName: "Sheet 2", delimiter: "," }
        },
        {
          uri: vscode.Uri.file("/workspace/other.csv").toString(),
          backend: "polars",
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
  });

  it.each([
    ["Parquet", "/workspace/data.parquet", "duckdb" as const],
    ["JSONL", "/workspace/data.jsonl", "pandas" as const]
  ])("retains the resolved backend for %s without inventing import options", async (_label, file, backend) => {
    const workspaceState = new MemoryMemento();
    const uri = vscode.Uri.file(file);

    await rememberConfirmedFileConfiguration(workspaceState, uri, undefined, backend);

    expect(confirmedFileConfiguration(workspaceState, uri)).toEqual({ backend });
  });

  it("rejects an import-options field on non-configurable file formats", async () => {
    const workspaceState = new MemoryMemento();
    const uri = vscode.Uri.file("/workspace/data.parquet");
    await workspaceState.update(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
      version: 1,
      entries: [{ uri: uri.toString(), backend: "duckdb", importOptions: {} }]
    });

    expect(confirmedFileConfiguration(workspaceState, uri)).toBeUndefined();
  });

  it("retains the resolved backend when the confirmed format default is restored", async () => {
    const workspaceState = new MemoryMemento();
    const uri = vscode.Uri.file("/workspace/data.xlsx");

    await rememberConfirmedFileConfiguration(workspaceState, uri, { sheetName: "Archive" }, "polars");
    expect(confirmedFileConfiguration(workspaceState, uri)).toEqual({
      backend: "polars",
      importOptions: { sheetName: "Archive" }
    });

    await rememberConfirmedFileConfiguration(workspaceState, uri, { sheetIndex: 0 }, "pandas");
    expect(confirmedFileConfiguration(workspaceState, uri)).toEqual({
      backend: "pandas",
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
        "polars"
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
      importOptions: {
        delimiter: ";",
        encoding: "utf-8",
        quoteChar: '"',
        hasHeader: true
      }
    });
  });
});
