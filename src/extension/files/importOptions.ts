import * as path from "node:path";
import * as vscode from "vscode";
import type { SessionSource } from "../../shared/protocol";

type ImportOptions = NonNullable<SessionSource["importOptions"]>;

export function defaultImportOptions(uri: vscode.Uri): ImportOptions | undefined {
  const extension = path.extname(uri.fsPath).toLowerCase();
  if (extension === ".csv" || extension === ".tsv") {
    return {
      delimiter: extension === ".tsv" ? "\t" : ",",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    };
  }
  if (extension === ".xlsx" || extension === ".xls") return { sheet: 0 };
  return undefined;
}

export async function promptImportOptions(uri: vscode.Uri): Promise<ImportOptions | undefined> {
  const defaults = defaultImportOptions(uri);
  if (!defaults) return undefined;
  const extension = path.extname(uri.fsPath).toLowerCase();
  if (extension === ".xlsx" || extension === ".xls") {
    const sheet = await vscode.window.showInputBox({
      title: "Excel sheet",
      prompt: "Enter a sheet name or zero-based sheet index.",
      value: String(defaults.sheet ?? 0)
    });
    if (sheet === undefined) throw new ImportCancelledError();
    const numeric = Number(sheet);
    return { sheet: Number.isInteger(numeric) && numeric >= 0 ? numeric : sheet };
  }

  const delimiterChoice = await vscode.window.showQuickPick(
    [
      { label: "Comma", value: "," },
      { label: "Tab", value: "\t" },
      { label: "Semicolon", value: ";" },
      { label: "Pipe", value: "|" },
      { label: "Custom…", value: "custom" }
    ],
    { title: "Delimiter", placeHolder: "Choose the field delimiter" }
  );
  if (!delimiterChoice) throw new ImportCancelledError();
  const delimiter =
    delimiterChoice.value === "custom"
      ? await vscode.window.showInputBox({
          title: "Custom delimiter",
          prompt: "Enter exactly one character.",
          validateInput: (value) => (Array.from(value).length === 1 ? undefined : "Enter one character.")
        })
      : delimiterChoice.value;
  if (!delimiter) throw new ImportCancelledError();

  const encoding = await vscode.window.showQuickPick(["utf-8", "utf8-lossy", "iso-8859-1", "windows-1252"], {
    title: "Text encoding",
    placeHolder: "Choose the source encoding"
  });
  if (!encoding) throw new ImportCancelledError();
  const header = await vscode.window.showQuickPick(
    [
      { label: "First row contains column names", value: true },
      { label: "Generate column names", value: false }
    ],
    { title: "Header row" }
  );
  if (!header) throw new ImportCancelledError();
  const quoteChar = await vscode.window.showInputBox({
    title: "Quote character",
    value: '"',
    validateInput: (value) => (Array.from(value).length === 1 ? undefined : "Enter one character.")
  });
  if (!quoteChar) throw new ImportCancelledError();
  return { delimiter, encoding, quoteChar, hasHeader: header.value };
}

export class ImportCancelledError extends Error {}
