import { open } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { SessionSource } from "../../shared/protocol";
import { detectedImportOptionsFromSample, IMPORT_DETECTION_SAMPLE_BYTES } from "./importDetection";

type ImportOptions = NonNullable<SessionSource["importOptions"]>;

interface ValuePick<T> extends vscode.QuickPickItem {
  readonly value: T;
}

interface DelimiterPick extends ValuePick<string> {
  readonly custom?: boolean;
}

type ExcelSheetMode = "name" | "index";

type ExcelSheetModePick = ValuePick<ExcelSheetMode>;

type ExcelSheetPick = ValuePick<string>;

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
  if (extension === ".xlsx" || extension === ".xls") return { sheetIndex: 0 };
  return undefined;
}

export async function detectImportOptions(uri: vscode.Uri): Promise<ImportOptions | undefined> {
  const defaults = defaultImportOptions(uri);
  if (!defaults || (uri.scheme !== "file" && uri.scheme !== "vscode-remote")) return defaults;
  const extension = path.extname(uri.fsPath).toLowerCase();
  if (extension !== ".csv" && extension !== ".tsv") return defaults;

  let handle;
  try {
    handle = await open(uri.fsPath, "r");
    const sample = Buffer.allocUnsafe(IMPORT_DETECTION_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    return detectedImportOptionsFromSample(uri.fsPath, sample.subarray(0, bytesRead));
  } catch {
    return defaults;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function promptImportOptions(
  uri: vscode.Uri,
  currentImportOptions?: ImportOptions,
  cancellation?: vscode.CancellationToken,
  sheetNames?: readonly string[]
): Promise<ImportOptions | undefined> {
  ensureNotCancelled(cancellation);
  const defaults = defaultImportOptions(uri);
  if (!defaults) return undefined;
  const extension = path.extname(uri.fsPath).toLowerCase();
  await focusActiveEditorGroupBeforeImportPrompt();
  ensureNotCancelled(cancellation);
  if (extension === ".xlsx" || extension === ".xls") {
    return promptExcelImportOptions(currentImportOptions, cancellation, sheetNames);
  }

  const currentDelimiter = validCharacter(currentImportOptions?.delimiter) ?? defaults.delimiter ?? ",";
  const delimiterChoice = await showImportQuickPick(
    delimiterChoices(currentDelimiter),
    {
      title: "Delimiter",
      placeHolder: "Choose the field delimiter",
      ignoreFocusOut: true
    },
    cancellation
  );
  ensureNotCancelled(cancellation);
  if (!delimiterChoice) throw new ImportCancelledError();
  const delimiter =
    delimiterChoice.custom === true
      ? await showImportInputBox(
          {
            title: "Custom delimiter",
            prompt: "Enter exactly one character.",
            value: currentDelimiter,
            validateInput: validateCharacter,
            ignoreFocusOut: true
          },
          cancellation
        )
      : delimiterChoice.value;
  ensureNotCancelled(cancellation);
  if (delimiter === undefined) throw new ImportCancelledError();
  if (validateCharacter(delimiter)) throw new Error("Expected a one-character delimiter.");

  const currentEncoding = nonBlank(currentImportOptions?.encoding) ?? nonBlank(defaults.encoding) ?? "utf-8";
  const encodingChoice = await showImportQuickPick(
    valueChoices(
      ["utf-8", "utf8-lossy", "utf-16le", "utf-16be", "iso-8859-1", "windows-1252"],
      currentEncoding,
      (value) => value
    ),
    {
      title: "Text encoding",
      placeHolder: "Choose the source encoding",
      ignoreFocusOut: true
    },
    cancellation
  );
  ensureNotCancelled(cancellation);
  if (!encodingChoice) throw new ImportCancelledError();

  const currentHasHeader = currentImportOptions?.hasHeader ?? defaults.hasHeader ?? true;
  const header = await showImportQuickPick(
    valueChoices(
      [
        { label: "First row contains column names", value: true },
        { label: "Generate column names", value: false }
      ],
      currentHasHeader
    ),
    { title: "Header row", ignoreFocusOut: true },
    cancellation
  );
  ensureNotCancelled(cancellation);
  if (!header) throw new ImportCancelledError();

  const currentQuoteChar = validCharacter(currentImportOptions?.quoteChar) ?? defaults.quoteChar ?? '"';
  const quoteChar = await showImportInputBox(
    {
      title: "Quote character",
      value: currentQuoteChar,
      validateInput: validateCharacter,
      ignoreFocusOut: true
    },
    cancellation
  );
  ensureNotCancelled(cancellation);
  if (quoteChar === undefined) throw new ImportCancelledError();
  if (validateCharacter(quoteChar)) throw new Error("Expected a one-character quote character.");
  return { delimiter, encoding: encodingChoice.value, quoteChar, hasHeader: header.value };
}

export class ImportCancelledError extends Error {}

async function promptExcelImportOptions(
  currentImportOptions?: ImportOptions,
  cancellation?: vscode.CancellationToken,
  sheetNames?: readonly string[]
): Promise<ImportOptions> {
  const availableSheets = validExcelSheetNames(sheetNames);
  if (availableSheets) {
    const currentSheetName = nonBlank(currentImportOptions?.sheetName);
    const currentIndex = validSheetIndex(currentImportOptions?.sheetIndex) ? currentImportOptions.sheetIndex : 0;
    const current =
      (currentSheetName !== undefined && availableSheets.includes(currentSheetName)
        ? currentSheetName
        : availableSheets[currentIndex]) ?? availableSheets[0]!;
    const sheet = await showImportQuickPick(
      excelSheetChoices(availableSheets, current),
      {
        title: "Excel sheet",
        placeHolder: "Choose a worksheet",
        ignoreFocusOut: true
      },
      cancellation
    );
    ensureNotCancelled(cancellation);
    if (!sheet) throw new ImportCancelledError();
    return { sheetName: sheet.value };
  }

  const currentSheetName = nonBlank(currentImportOptions?.sheetName);
  const currentSheetIndex = validSheetIndex(currentImportOptions?.sheetIndex) ? currentImportOptions.sheetIndex : 0;
  const currentMode: ExcelSheetMode = currentSheetName === undefined ? "index" : "name";
  const mode = await showImportQuickPick(
    excelSheetModeChoices(currentMode, currentSheetName, currentSheetIndex),
    {
      title: "Excel sheet",
      placeHolder: "Choose how to identify the worksheet",
      ignoreFocusOut: true
    },
    cancellation
  );
  ensureNotCancelled(cancellation);
  if (!mode) throw new ImportCancelledError();

  if (mode.value === "name") {
    const sheetName = await showImportInputBox(
      {
        title: "Excel sheet name",
        prompt: "Enter the exact worksheet name. Numeric names remain names.",
        value: currentMode === "name" ? currentSheetName : "",
        validateInput: validateSheetName,
        ignoreFocusOut: true
      },
      cancellation
    );
    ensureNotCancelled(cancellation);
    if (sheetName === undefined) throw new ImportCancelledError();
    if (validateSheetName(sheetName)) throw new Error("Expected a non-blank Excel sheet name.");
    return { sheetName };
  }

  const sheetIndex = await showImportInputBox(
    {
      title: "Excel sheet index",
      prompt: "Enter a zero-based worksheet index.",
      value: currentMode === "index" ? String(currentSheetIndex) : "0",
      validateInput: validateSheetIndex,
      ignoreFocusOut: true
    },
    cancellation
  );
  ensureNotCancelled(cancellation);
  if (sheetIndex === undefined) throw new ImportCancelledError();
  if (validateSheetIndex(sheetIndex)) throw new Error("Expected a non-negative, zero-based Excel sheet index.");
  return { sheetIndex: Number(sheetIndex) };
}

async function showImportQuickPick<T extends vscode.QuickPickItem>(
  items: readonly T[],
  options: vscode.QuickPickOptions,
  cancellation?: vscode.CancellationToken
): Promise<T | undefined> {
  const selection = vscode.window.showQuickPick(items, options, cancellation);
  await focusImportQuickInput();
  return selection;
}

async function showImportInputBox(
  options: vscode.InputBoxOptions,
  cancellation?: vscode.CancellationToken
): Promise<string | undefined> {
  const value = vscode.window.showInputBox(options, cancellation);
  await focusImportQuickInput();
  return value;
}

async function focusImportQuickInput(): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.action.focusQuickOpen");
  } catch {
    // Experimental forks may not expose this workbench command. Their native
    // Quick Input focus behavior remains the fallback.
  }
}

async function focusActiveEditorGroupBeforeImportPrompt(): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  } catch {
    // Experimental forks may not expose this workbench command. Their native
    // active-editor focus behavior remains the fallback.
  }
}

function excelSheetChoices(sheetNames: readonly string[], current: string): ExcelSheetPick[] {
  const choices = sheetNames.map((sheetName, index): ExcelSheetPick => ({
    label: sheetName,
    description: sheetName === current ? "Current" : undefined,
    detail: `Worksheet ${index + 1} of ${sheetNames.length}`,
    value: sheetName
  }));
  return promoteCurrent(choices, current);
}

function excelSheetModeChoices(
  currentMode: ExcelSheetMode,
  currentSheetName: string | undefined,
  currentSheetIndex: number
): ExcelSheetModePick[] {
  const choices: ExcelSheetModePick[] = [
    {
      label: "Sheet name",
      description: "Exact worksheet name",
      detail: currentMode === "name" ? `Current: ${currentSheetName}` : undefined,
      value: "name"
    },
    {
      label: "Sheet index",
      description: "Zero-based worksheet position",
      detail: currentMode === "index" ? `Current: ${currentSheetIndex}` : undefined,
      value: "index"
    }
  ];
  return promoteCurrent(choices, currentMode);
}

function delimiterChoices(current: string): DelimiterPick[] {
  const known: DelimiterPick[] = [
    { label: "Comma", value: "," },
    { label: "Tab", value: "\t" },
    { label: "Semicolon", value: ";" },
    { label: "Pipe", value: "|" }
  ];
  const currentKnown = known.find((choice) => choice.value === current);
  const currentChoice: DelimiterPick = currentKnown
    ? { ...currentKnown, description: "Current" }
    : {
        label: `Current: ${displayCharacter(current)}`,
        description: "Custom delimiter",
        value: current
      };
  return [
    currentChoice,
    ...known.filter((choice) => choice.value !== current),
    { label: "Custom…", value: current, custom: true }
  ];
}

function valueChoices<T>(
  choices: readonly ValuePick<T>[] | readonly T[],
  current: T,
  label: (value: T) => string = String
): ValuePick<T>[] {
  const normalized: ValuePick<T>[] = choices.map((choice) =>
    typeof choice === "object" && choice !== null && "value" in choice
      ? (choice as ValuePick<T>)
      : { label: label(choice as T), value: choice as T }
  );
  const existing = normalized.find((choice) => Object.is(choice.value, current));
  const currentChoice: ValuePick<T> = existing
    ? { ...existing, description: "Current" }
    : { label: label(current), description: "Current", value: current };
  return [currentChoice, ...normalized.filter((choice) => !Object.is(choice.value, current))];
}

function promoteCurrent<T>(choices: readonly ValuePick<T>[], current: T): ValuePick<T>[] {
  const selected = choices.find((choice) => Object.is(choice.value, current));
  if (!selected) return [...choices];
  return [selected, ...choices.filter((choice) => choice !== selected)];
}

function validateSheetName(value: string): string | undefined {
  return value.trim().length > 0 ? undefined : "Enter a non-blank sheet name.";
}

function validateSheetIndex(value: string): string | undefined {
  if (!/^(0|[1-9]\d*)$/.test(value)) return "Enter a non-negative whole number.";
  return Number.isSafeInteger(Number(value)) ? undefined : "Enter a smaller sheet index.";
}

function validateCharacter(value: string): string | undefined {
  return Array.from(value).length === 1 ? undefined : "Enter one character.";
}

function validCharacter(value: string | undefined): string | undefined {
  return value !== undefined && validateCharacter(value) === undefined ? value : undefined;
}

function validSheetIndex(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validExcelSheetNames(values: readonly string[] | undefined): readonly string[] | undefined {
  if (!values || values.length < 1 || values.length > 4_096) return undefined;
  const seen = new Set<string>();
  for (const value of values) {
    if (!nonBlank(value) || seen.has(value)) return undefined;
    seen.add(value);
  }
  return values;
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

function displayCharacter(value: string): string {
  if (value === "\t") return "Tab";
  if (value === " ") return "Space";
  return value;
}

function ensureNotCancelled(cancellation?: vscode.CancellationToken): void {
  if (cancellation?.isCancellationRequested) throw new ImportCancelledError();
}
