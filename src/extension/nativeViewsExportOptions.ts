import * as vscode from "vscode";
import type { CsvExportOptions, ExportOptions, RowAxisExportPolicy } from "../shared/protocol";
import type { ActiveSessionSnapshot } from "./sessionCoordinator";

interface ValuePick<T> extends vscode.QuickPickItem {
  readonly value: T;
}

interface DelimiterPick extends ValuePick<string> {
  readonly custom?: boolean;
}

export async function selectNativeExportOptions(
  snapshot: ActiveSessionSnapshot,
  format: "csv" | "parquet",
  rowAxisPolicy?: RowAxisExportPolicy
): Promise<ExportOptions | undefined> {
  if (format === "parquet") {
    return rowAxisPolicy === undefined ? { format } : { format, rowAxisPolicy };
  }
  const defaults = csvExportDefaults(snapshot);
  const hasConfirmedDefaults = hasConfirmedCsvExportDefaults(snapshot);
  const mode = await vscode.window.showQuickPick(
    [
      {
        label: hasConfirmedDefaults ? "Use confirmed source settings" : "Use standard CSV settings",
        description: describeCsvOptions(defaults),
        value: "defaults" as const
      },
      {
        label: "Configure CSV settings",
        description:
          snapshot.metadata.backend === "r"
            ? "Choose delimiter and header; R uses UTF-8 and double quotes"
            : "Choose delimiter, encoding, header, and quote behavior",
        value: "configure" as const
      }
    ],
    { title: "CSV Export Settings", placeHolder: "Use the offered defaults or configure this export" }
  );
  if (!mode) return undefined;
  const selected = mode.value === "defaults" ? defaults : await promptCsvExportOptions(snapshot, defaults);
  if (!selected) return undefined;
  return rowAxisPolicy === undefined ? selected : { ...selected, rowAxisPolicy };
}

function hasConfirmedCsvExportDefaults(snapshot: ActiveSessionSnapshot): boolean {
  const options = snapshot.metadata.source.importOptions;
  return (
    options?.delimiter !== undefined ||
    options?.quoteChar !== undefined ||
    options?.encoding !== undefined ||
    options?.hasHeader !== undefined
  );
}

function csvExportDefaults(snapshot: ActiveSessionSnapshot): CsvExportOptions {
  const imported = snapshot.metadata.source.importOptions;
  const supportsUnicodeDelimiter = snapshot.metadata.backend === "pandas" || snapshot.metadata.backend === "r";
  const supportsUnicodeQuote = snapshot.metadata.backend === "pandas";
  const supportsConfiguredQuote = snapshot.metadata.backend !== "r";
  const fallbackDelimiter = snapshot.metadata.source.label.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  let delimiter = validExportCharacter(imported?.delimiter, supportsUnicodeDelimiter) ?? fallbackDelimiter;
  let quoteChar = supportsConfiguredQuote
    ? (validExportCharacter(imported?.quoteChar, supportsUnicodeQuote) ?? '"')
    : '"';
  if (delimiter === quoteChar) {
    if (supportsConfiguredQuote) quoteChar = quoteChar === '"' ? "'" : '"';
    else delimiter = fallbackDelimiter;
  }
  return {
    format: "csv",
    delimiter,
    quoteChar,
    encoding:
      snapshot.metadata.backend === "pandas" && validPandasExportEncoding(imported?.encoding)
        ? imported.encoding
        : "utf-8",
    header: imported?.hasHeader ?? true
  };
}

async function promptCsvExportOptions(
  snapshot: ActiveSessionSnapshot,
  defaults: CsvExportOptions
): Promise<CsvExportOptions | undefined> {
  const unicodeDelimiter = snapshot.metadata.backend === "pandas" || snapshot.metadata.backend === "r";
  const unicodeQuote = snapshot.metadata.backend === "pandas";
  const delimiterChoice = await vscode.window.showQuickPick(delimiterChoices(defaults.delimiter), {
    title: "CSV Delimiter",
    placeHolder: "Choose the exported field delimiter"
  });
  if (!delimiterChoice) return undefined;
  const delimiter = delimiterChoice.custom
    ? await vscode.window.showInputBox({
        title: "Custom CSV Delimiter",
        prompt: unicodeDelimiter ? "Enter exactly one character." : "Enter one single-byte UTF-8 character.",
        value: defaults.delimiter,
        validateInput: (value) =>
          validateExportCharacter(value, unicodeDelimiter) ??
          (snapshot.metadata.backend === "r" && value === '"'
            ? "R CSV export uses double quotes, so choose a different delimiter."
            : undefined)
      })
    : delimiterChoice.value;
  if (
    delimiter === undefined ||
    validateExportCharacter(delimiter, unicodeDelimiter) ||
    (snapshot.metadata.backend === "r" && delimiter === '"')
  )
    return undefined;

  const encoding = await vscode.window.showQuickPick(encodingChoices(snapshot, defaults.encoding), {
    title: "CSV Encoding",
    placeHolder: "Choose the exported text encoding"
  });
  if (!encoding) return undefined;

  const header = await vscode.window.showQuickPick(
    orderedChoices(
      [
        { label: "Write column names", value: true },
        { label: "Omit column names", value: false }
      ],
      defaults.header
    ),
    { title: "CSV Header", placeHolder: "Choose whether to write column names" }
  );
  if (!header) return undefined;

  let quoteChar = '"';
  if (snapshot.metadata.backend !== "r") {
    const selectedQuote = await vscode.window.showInputBox({
      title: "CSV Quote Character",
      prompt: unicodeQuote ? "Enter exactly one character." : "Enter one single-byte UTF-8 character.",
      value: defaults.quoteChar,
      validateInput: (value) =>
        validateExportCharacter(value, unicodeQuote) ??
        (value === delimiter ? "The quote character must differ from the delimiter." : undefined)
    });
    if (
      selectedQuote === undefined ||
      validateExportCharacter(selectedQuote, unicodeQuote) ||
      selectedQuote === delimiter
    )
      return undefined;
    quoteChar = selectedQuote;
  }
  return {
    format: "csv",
    delimiter,
    quoteChar,
    encoding: encoding.value,
    header: header.value
  };
}

function delimiterChoices(current: string): DelimiterPick[] {
  const choices: DelimiterPick[] = [
    { label: "Comma", description: ",", value: "," },
    { label: "Tab", description: "\\t", value: "\t" },
    { label: "Semicolon", description: ";", value: ";" },
    { label: "Pipe", description: "|", value: "|" }
  ];
  const currentChoice = choices.find(({ value }) => value === current);
  if (!currentChoice)
    choices.unshift({ label: "Confirmed delimiter", description: displayCharacter(current), value: current });
  choices.push({ label: "Custom…", value: current, custom: true });
  return orderedChoices(choices, current);
}

function encodingChoices(snapshot: ActiveSessionSnapshot, current: string): Array<ValuePick<string>> {
  const supported =
    snapshot.metadata.backend === "pandas"
      ? ["utf-8", "utf-16le", "utf-16be", "iso-8859-1", "windows-1252"]
      : ["utf-8"];
  if (snapshot.metadata.backend === "pandas" && !supported.includes(current)) supported.unshift(current);
  return orderedChoices(
    supported.map((encoding) => ({ label: encoding, value: encoding })),
    current
  );
}

function orderedChoices<T>(choices: Array<ValuePick<T>>, current: T): Array<ValuePick<T>> {
  return [...choices].sort((left, right) => Number(right.value === current) - Number(left.value === current));
}

function validateExportCharacter(value: string, unicodeAllowed: boolean): string | undefined {
  if ([...value].length !== 1) return "Enter exactly one character.";
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return "Enter a Unicode scalar value.";
  if (value === "\0" || value === "\r" || value === "\n")
    return "NUL and line breaks are not valid CSV syntax characters.";
  if (!unicodeAllowed && new TextEncoder().encode(value).length !== 1) {
    return "This backend requires a single-byte UTF-8 character.";
  }
  return undefined;
}

function validExportCharacter(value: string | undefined, unicodeAllowed: boolean): string | undefined {
  return value !== undefined && validateExportCharacter(value, unicodeAllowed) === undefined ? value : undefined;
}

function nonBlank(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0 && [...value].length <= 64;
}

function validPandasExportEncoding(value: string | undefined): value is string {
  return nonBlank(value) && value.toLowerCase().replaceAll("_", "-") !== "utf8-lossy";
}

function describeCsvOptions(options: CsvExportOptions): string {
  return `${displayCharacter(options.delimiter)} delimiter · ${options.encoding} · ${
    options.header ? "header" : "no header"
  } · ${displayCharacter(options.quoteChar)} quote`;
}

function displayCharacter(value: string): string {
  return value === "\t" ? "Tab" : JSON.stringify(value);
}
