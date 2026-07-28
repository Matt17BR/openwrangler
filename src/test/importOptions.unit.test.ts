import { beforeEach, describe, expect, it, vi } from "vitest";

interface PromptOptions {
  readonly title?: string;
  readonly prompt?: string;
  readonly value?: string;
  readonly validateInput?: (value: string) => string | undefined;
  readonly ignoreFocusOut?: boolean;
}

interface Pick {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly value: unknown;
  readonly custom?: boolean;
}

const importOptionMocks = vi.hoisted(() => ({
  showQuickPick: vi.fn<(items: readonly unknown[], options?: PromptOptions) => Promise<unknown>>(async () => undefined),
  showInputBox: vi.fn<(options?: PromptOptions) => Promise<string | undefined>>(async () => undefined),
  read: vi.fn(),
  close: vi.fn(async () => undefined),
  open: vi.fn()
}));

vi.mock("node:fs/promises", () => ({
  default: { open: importOptionMocks.open },
  open: importOptionMocks.open
}));

vi.mock("vscode", () => ({
  Uri: {
    file: (fsPath: string) => ({
      scheme: "file",
      authority: "",
      path: fsPath,
      fsPath,
      toString: () => `file://${fsPath}`
    })
  },
  window: {
    showQuickPick: importOptionMocks.showQuickPick,
    showInputBox: importOptionMocks.showInputBox
  }
}));

import * as vscode from "vscode";
import {
  defaultImportOptions,
  detectImportOptions,
  ImportCancelledError,
  promptImportOptions
} from "../extension/files/importOptions";
import { IMPORT_DETECTION_SAMPLE_BYTES } from "../extension/files/importDetection";

describe("import option defaults", () => {
  it.each(["workbook.xlsx", "legacy.xls", "UPPER.XLS"])("uses the public zero-based sheet index for %s", (name) => {
    expect(defaultImportOptions(vscode.Uri.file(`/tmp/${name}`))).toEqual({ sheetIndex: 0 });
  });

  it("does not invent options for formats without interactive import settings", () => {
    expect(defaultImportOptions(vscode.Uri.file("/tmp/data.parquet"))).toBeUndefined();
  });
});

describe("automatic import option sampling", () => {
  beforeEach(() => {
    importOptionMocks.read.mockReset();
    importOptionMocks.close.mockClear();
    importOptionMocks.open.mockReset();
    importOptionMocks.open.mockResolvedValue({
      read: importOptionMocks.read,
      close: importOptionMocks.close
    });
  });

  it("performs one bounded positional local read and closes the descriptor", async () => {
    const bytes = new TextEncoder().encode("name\tvalue\none\t1\ntwo\t2\n");
    importOptionMocks.read.mockImplementationOnce(
      async (buffer: Uint8Array, offset: number, _length: number, position: number) => {
        expect(position).toBe(0);
        buffer.set(bytes, offset);
        return { bytesRead: bytes.length, buffer };
      }
    );

    await expect(detectImportOptions(vscode.Uri.file("/tmp/misleading.csv"))).resolves.toEqual({
      delimiter: "\t",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });

    expect(importOptionMocks.open).toHaveBeenCalledWith("/tmp/misleading.csv", "r");
    expect(importOptionMocks.read).toHaveBeenCalledOnce();
    const [buffer, offset, length, position] = importOptionMocks.read.mock.calls[0] ?? [];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer).toHaveLength(IMPORT_DETECTION_SAMPLE_BYTES);
    expect([offset, length, position]).toEqual([0, IMPORT_DETECTION_SAMPLE_BYTES, 0]);
    expect(importOptionMocks.close).toHaveBeenCalledOnce();
  });

  it("uses the same bounded host-local read for remote-workspace files", async () => {
    const remote = {
      scheme: "vscode-remote",
      fsPath: "/workspace/data.tsv"
    } as vscode.Uri;
    const bytes = new TextEncoder().encode("name;value\none;1\n");
    importOptionMocks.read.mockImplementationOnce(async (buffer: Uint8Array) => {
      buffer.set(bytes);
      return { bytesRead: bytes.length, buffer };
    });

    await expect(detectImportOptions(remote)).resolves.toEqual({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    expect(importOptionMocks.open).toHaveBeenCalledWith("/workspace/data.tsv", "r");
    expect(importOptionMocks.read).toHaveBeenCalledOnce();
    expect(importOptionMocks.close).toHaveBeenCalledOnce();
  });

  it("falls back safely and closes the descriptor when sampling fails", async () => {
    importOptionMocks.read.mockRejectedValueOnce(new Error("unreadable"));

    await expect(detectImportOptions(vscode.Uri.file("/tmp/data.csv"))).resolves.toEqual({
      delimiter: ",",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    expect(importOptionMocks.close).toHaveBeenCalledOnce();
  });
});

describe("Excel import prompts", () => {
  beforeEach(resetPromptMocks);

  it("keeps a numeric worksheet name unambiguously name-addressed and prefills the current name", async () => {
    importOptionMocks.showQuickPick.mockImplementationOnce(async (items) => items[0]);
    importOptionMocks.showInputBox.mockResolvedValueOnce("0");

    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"), { sheetName: "2024" })).resolves.toEqual({
      sheetName: "0"
    });

    expect(picksAt(0).map(({ value }) => value)).toEqual(["name", "index"]);
    expect(picksAt(0)[0]).toMatchObject({
      label: "Sheet name",
      detail: "Current: 2024",
      value: "name"
    });
    expect(inputOptionsAt(0)).toMatchObject({
      title: "Excel sheet name",
      value: "2024",
      ignoreFocusOut: true
    });
    expect(importOptionMocks.showQuickPick.mock.calls.map(([, options]) => options?.ignoreFocusOut)).toEqual([true]);
  });

  it("uses an explicit zero-based index mode and prefills the current index", async () => {
    importOptionMocks.showQuickPick.mockImplementationOnce(async (items) => items[0]);
    importOptionMocks.showInputBox.mockResolvedValueOnce("7");

    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.xls"), { sheetIndex: 3 })).resolves.toEqual({
      sheetIndex: 7
    });

    expect(picksAt(0).map(({ value }) => value)).toEqual(["index", "name"]);
    expect(picksAt(0)[0]).toMatchObject({
      label: "Sheet index",
      detail: "Current: 3",
      value: "index"
    });
    expect(inputOptionsAt(0)).toMatchObject({
      title: "Excel sheet index",
      value: "3",
      ignoreFocusOut: true
    });
    expect(importOptionMocks.showQuickPick.mock.calls.map(([, options]) => options?.ignoreFocusOut)).toEqual([true]);
  });

  it("switches from a current index to an exact numeric name without coercion", async () => {
    importOptionMocks.showQuickPick.mockImplementationOnce(async (items) =>
      (items as Pick[]).find(({ value }) => value === "name")
    );
    importOptionMocks.showInputBox.mockResolvedValueOnce("12");

    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"), { sheetIndex: 4 })).resolves.toEqual({
      sheetName: "12"
    });

    expect(inputOptionsAt(0).value).toBe("");
  });

  it("switches from a current name to a zero-based index with a safe default", async () => {
    importOptionMocks.showQuickPick.mockImplementationOnce(async (items) =>
      (items as Pick[]).find(({ value }) => value === "index")
    );
    importOptionMocks.showInputBox.mockResolvedValueOnce("0");

    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"), { sheetName: "Data" })).resolves.toEqual({
      sheetIndex: 0
    });

    expect(inputOptionsAt(0).value).toBe("0");
  });

  it("validates blank names and invalid index syntax before the input can be accepted", async () => {
    importOptionMocks.showQuickPick
      .mockImplementationOnce(async (items) => (items as Pick[]).find(({ value }) => value === "name"))
      .mockImplementationOnce(async (items) => (items as Pick[]).find(({ value }) => value === "index"));
    importOptionMocks.showInputBox.mockResolvedValueOnce("Data").mockResolvedValueOnce("2");

    await promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"));
    await promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"));

    const nameValidator = inputOptionsAt(0).validateInput;
    const indexValidator = inputOptionsAt(1).validateInput;
    expect(nameValidator?.("")).toBe("Enter a non-blank sheet name.");
    expect(nameValidator?.("   ")).toBe("Enter a non-blank sheet name.");
    expect(nameValidator?.("0")).toBeUndefined();
    expect(indexValidator?.("")).toBe("Enter a non-negative whole number.");
    expect(indexValidator?.("true")).toBe("Enter a non-negative whole number.");
    expect(indexValidator?.("-1")).toBe("Enter a non-negative whole number.");
    expect(indexValidator?.("1.5")).toBe("Enter a non-negative whole number.");
    expect(indexValidator?.("01")).toBe("Enter a non-negative whole number.");
    expect(indexValidator?.("0")).toBeUndefined();
    expect(indexValidator?.("12")).toBeUndefined();
    expect(indexValidator?.("9007199254740992")).toBe("Enter a smaller sheet index.");
  });

  it("fails closed if an invalid index is returned despite the UI validator", async () => {
    importOptionMocks.showQuickPick.mockImplementationOnce(async (items) => items[0]);
    importOptionMocks.showInputBox.mockResolvedValueOnce("true");

    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"))).rejects.toThrow(
      "Expected a non-negative, zero-based Excel sheet index."
    );
  });

  it("preserves cancellation at the mode and value prompts", async () => {
    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"))).rejects.toBeInstanceOf(ImportCancelledError);

    importOptionMocks.showQuickPick.mockImplementationOnce(async (items) => items[0]);
    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"))).rejects.toBeInstanceOf(ImportCancelledError);
  });
});

describe("delimited-file import prompts", () => {
  beforeEach(resetPromptMocks);

  it("prefills and preserves every current CSV field, including custom values", async () => {
    chooseFirstItems();
    importOptionMocks.showInputBox.mockImplementation(async (options) => options?.value);

    await expect(
      promptImportOptions(vscode.Uri.file("/tmp/data.csv"), {
        delimiter: "§",
        encoding: "windows-1252",
        quoteChar: "'",
        hasHeader: false
      })
    ).resolves.toEqual({
      delimiter: "§",
      encoding: "windows-1252",
      quoteChar: "'",
      hasHeader: false
    });

    expect(picksAt(0)[0]).toMatchObject({
      label: "Current: §",
      description: "Custom delimiter",
      value: "§"
    });
    expect(picksAt(1)[0]).toMatchObject({
      description: "Current",
      value: "windows-1252"
    });
    expect(picksAt(2)[0]).toMatchObject({
      label: "Generate column names",
      description: "Current",
      value: false
    });
    expect(inputOptionsAt(0)).toMatchObject({
      title: "Quote character",
      value: "'",
      ignoreFocusOut: true
    });
    expect(importOptionMocks.showQuickPick.mock.calls.map(([, options]) => options?.ignoreFocusOut)).toEqual([
      true,
      true,
      true
    ]);
  });

  it("prefills the custom-delimiter field from the current value", async () => {
    importOptionMocks.showQuickPick.mockImplementation(async (items, options) => {
      const choices = items as Pick[];
      if (options?.title === "Delimiter") return choices.find(({ custom }) => custom === true);
      return choices[0];
    });
    importOptionMocks.showInputBox.mockImplementation(async (options) =>
      options?.title === "Custom delimiter" ? ":" : options?.value
    );

    await expect(
      promptImportOptions(vscode.Uri.file("/tmp/data.tsv"), {
        delimiter: "\t",
        encoding: "utf-8",
        quoteChar: '"',
        hasHeader: true
      })
    ).resolves.toEqual({
      delimiter: ":",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });

    expect(inputOptionsAt(0)).toMatchObject({
      title: "Custom delimiter",
      value: "\t",
      ignoreFocusOut: true
    });
    expect(inputOptionsAt(1)).toMatchObject({
      title: "Quote character",
      ignoreFocusOut: true
    });
  });

  it.each(["delimiter", "custom delimiter", "encoding", "header", "quote"] as const)(
    "preserves cancellation at the %s prompt",
    async (stage) => {
      importOptionMocks.showQuickPick.mockImplementation(async (items, options) => {
        const choices = items as Pick[];
        if (options?.title === "Delimiter") {
          if (stage === "delimiter") return undefined;
          if (stage === "custom delimiter") return choices.find(({ custom }) => custom === true);
          return choices[0];
        }
        if (options?.title === "Text encoding" && stage === "encoding") return undefined;
        if (options?.title === "Header row" && stage === "header") return undefined;
        return choices[0];
      });
      importOptionMocks.showInputBox.mockImplementation(async (options) => {
        if (options?.title === "Custom delimiter" && stage === "custom delimiter") return undefined;
        if (options?.title === "Quote character" && stage === "quote") return undefined;
        return options?.value;
      });

      await expect(promptImportOptions(vscode.Uri.file("/tmp/data.csv"))).rejects.toBeInstanceOf(ImportCancelledError);
    }
  );

  it("does not prompt for a format without interactive import settings", async () => {
    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.parquet"))).resolves.toBeUndefined();
    expect(importOptionMocks.showQuickPick).not.toHaveBeenCalled();
    expect(importOptionMocks.showInputBox).not.toHaveBeenCalled();
  });
});

function resetPromptMocks(): void {
  importOptionMocks.showQuickPick.mockReset();
  importOptionMocks.showQuickPick.mockResolvedValue(undefined);
  importOptionMocks.showInputBox.mockReset();
  importOptionMocks.showInputBox.mockResolvedValue(undefined);
}

function chooseFirstItems(): void {
  importOptionMocks.showQuickPick.mockImplementation(async (items) => items[0]);
}

function picksAt(call: number): Pick[] {
  return importOptionMocks.showQuickPick.mock.calls[call]?.[0] as Pick[];
}

function inputOptionsAt(call: number): PromptOptions {
  return importOptionMocks.showInputBox.mock.calls[call]?.[0] as PromptOptions;
}
