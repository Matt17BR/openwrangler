import * as vscode from "vscode";
import {
  isCurrentLiterateDocumentOrigin,
  isUnchangedLiterateDocumentOrigin,
  type LiterateDocumentOrigin
} from "../literateDocumentOrigin";
import { findLiterateCodeChunkAtLine } from "../literateDocumentChunks";
import { isSoleOpenNotebookDocument } from "./notebookProvenance";

const PYTHON_CELL_MARKER = /^\s*#\s*(?:%%|<codecell>|In\[\d*?\]|In\[ \])/u;
const MARKDOWN_CELL_MARKER = /^\s*#\s*(?:%%\s*\[markdown\]|<markdowncell>)/iu;
const MAX_INTERACTIVE_CELL_METADATA_TEXT = 64 * 1024;

export interface PythonCellOrigin {
  readonly editor: vscode.TextEditor;
  readonly document: vscode.TextDocument;
  readonly version: number;
  readonly sourceUri: string;
  readonly executionKind: "cell" | "chunk" | "file";
  readonly command: "jupyter.execSelectionInteractive" | "jupyter.runcurrentcell" | "jupyter.runFileInteractive";
  readonly commandArguments: readonly unknown[];
  readonly startLine: number;
  readonly endLine: number;
  readonly selection: vscode.Selection;
  readonly selections: readonly vscode.Selection[];
  readonly viewColumn: vscode.ViewColumn;
  readonly literateOrigin?: LiterateDocumentOrigin;
}

interface InteractiveCellIdentity {
  readonly cell: vscode.NotebookCell;
  readonly id: string | undefined;
  readonly lineIndex: number | undefined;
}

export interface PreviousInteractiveCells {
  readonly cells: ReadonlySet<vscode.NotebookCell>;
  readonly ids: ReadonlySet<string>;
}

interface AssociatedNotebook {
  readonly notebook: vscode.NotebookDocument;
  readonly cells: readonly InteractiveCellIdentity[];
}

export function capturePythonCellOrigin(): PythonCellOrigin | undefined {
  const editor = vscode.window.activeTextEditor;
  const document = editor?.document;
  if (!editor || !document || !isPythonSourceDocument(document) || !isSoleOpenTextDocument(document)) return undefined;
  let hasCellMarker = false;
  for (let line = 0; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text;
    if (PYTHON_CELL_MARKER.test(text) || MARKDOWN_CELL_MARKER.test(text)) {
      hasCellMarker = true;
      break;
    }
  }
  if (!hasCellMarker) {
    return {
      editor,
      document,
      version: document.version,
      sourceUri: document.uri.toString(),
      executionKind: "file",
      command: "jupyter.runFileInteractive",
      commandArguments: [document.uri],
      startLine: 0,
      endLine: 0,
      selection: editor.selection,
      selections: Object.freeze([...editor.selections]),
      viewColumn: editor.viewColumn ?? vscode.ViewColumn.Active
    };
  }
  const activeLine = editor.selection.active.line;
  let startLine = -1;
  for (let line = Math.min(activeLine, document.lineCount - 1); line >= 0; line -= 1) {
    const text = document.lineAt(line).text;
    if (MARKDOWN_CELL_MARKER.test(text)) return undefined;
    if (!PYTHON_CELL_MARKER.test(text)) continue;
    startLine = line;
    break;
  }
  if (startLine < 0) return undefined;
  return {
    editor,
    document,
    version: document.version,
    sourceUri: document.uri.toString(),
    executionKind: "cell",
    command: "jupyter.runcurrentcell",
    commandArguments: [],
    startLine,
    endLine: startLine,
    selection: editor.selection,
    selections: Object.freeze([...editor.selections]),
    viewColumn: editor.viewColumn ?? vscode.ViewColumn.Active
  };
}

export function pythonOriginFromLiterateDocument(
  origin: LiterateDocumentOrigin,
  requireChunk = true
): PythonCellOrigin | undefined {
  if (!isCurrentLiterateDocumentOrigin(origin)) return undefined;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== origin.document) return undefined;
  const chunk = origin.chunk;
  if (requireChunk && chunk?.language !== "python") return undefined;
  if (requireChunk && origin.pythonExecutionOwner !== "jupyter") return undefined;
  const startLine = chunk?.openingLine ?? origin.selections[0]?.active.line;
  if (startLine === undefined) return undefined;
  return Object.freeze({
    editor,
    document: origin.document,
    version: origin.version,
    sourceUri: origin.uri,
    executionKind: "chunk",
    command: "jupyter.execSelectionInteractive",
    commandArguments: Object.freeze([chunk?.code ?? ""]),
    startLine,
    endLine: chunk?.closingLine ?? startLine,
    selection: editor.selection,
    selections: Object.freeze([...editor.selections]),
    viewColumn: origin.viewColumn,
    literateOrigin: origin
  });
}

export function isPythonSourceDocument(document: vscode.TextDocument): boolean {
  const scheme = document.uri.scheme;
  return (
    document.languageId === "python" &&
    (scheme === "file" || scheme === "vscode-remote" || scheme === "untitled") &&
    document.uri.path.toLowerCase().endsWith(".py")
  );
}

export function isExactPythonOrigin(origin: PythonCellOrigin): boolean {
  if (origin.literateOrigin) return isCurrentLiterateDocumentOrigin(origin.literateOrigin);
  return (
    !origin.document.isClosed &&
    origin.document.version === origin.version &&
    isSoleOpenTextDocument(origin.document) &&
    origin.document.uri.toString() === origin.sourceUri
  );
}

export function isSoleOpenTextDocument(document: vscode.TextDocument): boolean {
  if (document.isClosed) return false;
  const uri = document.uri.toString();
  let found = false;
  for (const openDocument of vscode.workspace.textDocuments) {
    if (openDocument.isClosed || openDocument.uri.toString() !== uri) continue;
    if (openDocument !== document || found) return false;
    found = true;
  }
  return found;
}

function isSupportedPythonNotebook(notebook: vscode.NotebookDocument): boolean {
  if (notebook.notebookType !== "interactive" && notebook.notebookType !== "jupyter-notebook") return false;
  const language = notebookLanguageHint(notebook);
  return language === undefined || language === "python";
}

export function isSupportedLiveNotebook(notebook: vscode.NotebookDocument): boolean {
  return notebook.notebookType === "interactive" || notebook.notebookType === "jupyter-notebook";
}

function notebookLanguageHint(notebook: vscode.NotebookDocument): string | undefined {
  const metadataLanguage = notebookMetadataLanguageHint(notebook);
  if (metadataLanguage) return metadataLanguage;
  for (const cell of notebook.getCells()) {
    if (cell.kind !== vscode.NotebookCellKind.Code) continue;
    const languageId = cell.document.languageId.trim().toLowerCase();
    if (languageId) return languageId;
  }
  return undefined;
}

function notebookMetadataLanguageHint(notebook: vscode.NotebookDocument): string | undefined {
  const metadata = notebook.metadata;
  const contentMetadata = isRecord(metadata) ? metadata.metadata : undefined;
  const candidates = [
    nestedString(metadata, "kernelspec", "language"),
    nestedString(metadata, "language_info", "name"),
    nestedString(contentMetadata, "kernelspec", "language"),
    nestedString(contentMetadata, "language_info", "name")
  ]
    .map((candidate) => candidate?.trim().toLowerCase())
    .filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  const unique = new Set(candidates);
  if (unique.size === 0) return undefined;
  return unique.size === 1 ? candidates[0] : "conflicting";
}

type FreshJupyterKernelMetadata = "absent" | "python" | "notPython" | "ambiguous";

export function freshJupyterKernelMetadata(notebook: vscode.NotebookDocument): FreshJupyterKernelMetadata {
  const metadata = notebook.metadata;
  if (!isRecord(metadata)) return "ambiguous";
  const owns = (record: Readonly<Record<string, unknown>>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(record, key);

  // Jupyter writes nbformat metadata below NotebookDocument.metadata.metadata.
  // A flat lookalike must not authorize skipping its public kernel picker.
  if (owns(metadata, "kernelspec") || owns(metadata, "language_info")) return "ambiguous";
  if (!owns(metadata, "metadata")) return "absent";
  const content = metadata.metadata;
  if (!isRecord(content)) return "ambiguous";
  const hasKernelSpec = owns(content, "kernelspec");
  const hasLanguageInfo = owns(content, "language_info");
  if (!hasKernelSpec && !hasLanguageInfo) return "absent";
  if (!hasKernelSpec || !isRecord(content.kernelspec)) return "ambiguous";

  const kernelLanguage = content.kernelspec.language;
  if (typeof kernelLanguage !== "string" || kernelLanguage.trim().length === 0) return "ambiguous";
  const normalizedKernelLanguage = kernelLanguage.trim().toLowerCase();
  if (hasLanguageInfo) {
    if (!isRecord(content.language_info)) return "ambiguous";
    if (owns(content.language_info, "name")) {
      const languageName = content.language_info.name;
      if (typeof languageName !== "string" || languageName.trim().length === 0) return "ambiguous";
      if (languageName.trim().toLowerCase() !== normalizedKernelLanguage) return "ambiguous";
    }
  }
  return normalizedKernelLanguage === "python" ? "python" : "notPython";
}

function nestedString(record: unknown, parent: string, child: string): string | undefined {
  if (!isRecord(record)) return undefined;
  const nested = record[parent];
  return isRecord(nested) && typeof nested[child] === "string" ? nested[child] : undefined;
}

export function associatedNotebooks(sourceUri: string): AssociatedNotebook[] {
  return allAssociatedCells(sourceUri).filter(({ cells }) => cells.length > 0);
}

export function associatedLiterateNotebooks(origin: LiterateDocumentOrigin): AssociatedNotebook[] {
  if (origin.pythonExecutionOwner !== "jupyter") return [];
  let source: string;
  try {
    source = origin.document.getText();
  } catch {
    return [];
  }
  return allExactSourceCells(origin.uri).flatMap(({ notebook, cells }) => {
    if (!isSupportedLiteratePythonNotebook(notebook)) return [];
    const matches = cells.filter((identity) => isDocumentLiteratePythonCell(identity, origin, source));
    return matches.length > 0 ? [{ notebook, cells: matches }] : [];
  });
}

function allAssociatedCells(sourceUri: string): AssociatedNotebook[] {
  return allExactSourceCells(sourceUri).filter(({ notebook }) => isSupportedPythonNotebook(notebook));
}

function allExecutionAssociatedCells(origin: PythonCellOrigin): AssociatedNotebook[] {
  if (!origin.literateOrigin) return allAssociatedCells(origin.sourceUri);
  return allExactSourceCells(origin.sourceUri).flatMap(({ notebook, cells }) => {
    if (!isSupportedLiteratePythonNotebook(notebook)) return [];
    const matches = cells.filter((identity) => isExactLiteratePythonCell(identity, origin));
    return matches.length > 0 ? [{ notebook, cells: matches }] : [];
  });
}

export function allExactSourceCells(sourceUri: string): AssociatedNotebook[] {
  const matches: AssociatedNotebook[] = [];
  for (const notebook of vscode.workspace.notebookDocuments) {
    if (!isSupportedLiveNotebook(notebook) || !isSoleOpenNotebookDocument(notebook)) continue;
    const cells = notebook.getCells().flatMap((cell): InteractiveCellIdentity[] => {
      const identity = interactiveCellIdentity(cell, sourceUri);
      return identity ? [identity] : [];
    });
    if (cells.length > 0) matches.push({ notebook, cells });
  }
  return matches;
}

function isExactLiteratePythonCell(identity: InteractiveCellIdentity, origin: PythonCellOrigin): boolean {
  const literate = origin.literateOrigin;
  const languageId = identity.cell.document.languageId.trim().toLowerCase();
  return (
    literate?.chunk?.language === "python" &&
    literate.pythonExecutionOwner === "jupyter" &&
    identity.cell.kind === vscode.NotebookCellKind.Code &&
    (languageId === "python" || (literate.kind === "quarto" && languageId === "quarto")) &&
    identity.lineIndex !== undefined &&
    identity.lineIndex >= origin.startLine &&
    identity.lineIndex <= origin.endLine
  );
}

function isDocumentLiteratePythonCell(
  identity: InteractiveCellIdentity,
  origin: LiterateDocumentOrigin,
  source: string
): boolean {
  const lineIndex = identity.lineIndex;
  const languageId = identity.cell.document.languageId.trim().toLowerCase();
  if (
    lineIndex === undefined ||
    identity.cell.kind !== vscode.NotebookCellKind.Code ||
    (languageId !== "python" && (origin.kind !== "quarto" || languageId !== "quarto"))
  ) {
    return false;
  }
  try {
    const chunk = findLiterateCodeChunkAtLine(origin.document.uri.fsPath, source, lineIndex);
    return chunk?.language === "python" && chunk.executableSyntax && chunk.supportedFence && chunk.enabled;
  } catch {
    return false;
  }
}

function isSupportedLiteratePythonNotebook(notebook: vscode.NotebookDocument): boolean {
  if (notebook.notebookType !== "interactive" && notebook.notebookType !== "jupyter-notebook") return false;
  const kernelLanguage = notebookMetadataLanguageHint(notebook);
  return kernelLanguage === undefined || kernelLanguage === "python";
}

function interactiveCellIdentity(
  cell: vscode.NotebookCell,
  expectedSourceUri: string
): InteractiveCellIdentity | undefined {
  try {
    const metadata = cell.metadata;
    if (!isRecord(metadata) || !isRecord(metadata.interactive)) return undefined;
    const source = metadata.interactive.uristring;
    if (
      typeof source !== "string" ||
      source.length === 0 ||
      source.length > MAX_INTERACTIVE_CELL_METADATA_TEXT ||
      source !== expectedSourceUri
    ) {
      return undefined;
    }
    const id =
      typeof metadata.id === "string" && metadata.id.length > 0 && metadata.id.length <= 256 ? metadata.id : undefined;
    const lineIndex =
      typeof metadata.interactive.lineIndex === "number" &&
      Number.isSafeInteger(metadata.interactive.lineIndex) &&
      metadata.interactive.lineIndex >= 0
        ? metadata.interactive.lineIndex
        : undefined;
    return { cell, id, lineIndex };
  } catch {
    return undefined;
  }
}

export function newlyExecutedCell(
  origin: PythonCellOrigin,
  before: PreviousInteractiveCells
):
  | { readonly kind: "found"; readonly notebook: vscode.NotebookDocument; readonly cell: vscode.NotebookCell }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" } {
  const candidates = allExecutionAssociatedCells(origin).flatMap(({ notebook, cells }) =>
    cells.flatMap(({ cell, id, lineIndex }) =>
      lineIndex !== undefined &&
      lineIndex >= origin.startLine &&
      lineIndex <= origin.endLine &&
      !before.cells.has(cell) &&
      (id === undefined || !before.ids.has(id))
        ? [{ notebook, cell }]
        : []
    )
  );
  if (candidates.length === 0) return { kind: "missing" };
  if (candidates.length !== 1) return { kind: "ambiguous" };
  return { kind: "found", ...candidates[0]! };
}

export function newlyOpenedBlankInteractiveWindow(
  before: ReadonlySet<vscode.NotebookDocument>,
  expectedSourceUri: string
):
  | { readonly kind: "found"; readonly notebook: vscode.NotebookDocument }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" } {
  const candidates = vscode.workspace.notebookDocuments.filter(
    (notebook) =>
      !before.has(notebook) &&
      !notebook.isClosed &&
      notebook.notebookType === "interactive" &&
      isRecoverablePythonInteractiveWindow(notebook, expectedSourceUri) &&
      isSoleOpenNotebookDocument(notebook)
  );
  if (candidates.length === 0) return { kind: "missing" };
  if (candidates.length !== 1) return { kind: "ambiguous" };
  return { kind: "found", notebook: candidates[0]! };
}

function isRecoverablePythonInteractiveWindow(notebook: vscode.NotebookDocument, expectedSourceUri: string): boolean {
  const cells = notebook.getCells();
  if (cells.length === 0) return isSupportedPythonNotebook(notebook);
  if (cells.length !== 1) return false;
  const [cell] = cells;
  if (
    cell?.kind !== vscode.NotebookCellKind.Markup ||
    cell.document.languageId.trim().toLowerCase() !== "markdown" ||
    !isRecord(cell.metadata) ||
    interactiveCellIdentity(cell, expectedSourceUri) !== undefined
  ) {
    return false;
  }

  // Jupyter adds this marked system cell before a kernel is selected. Its
  // temporary language and execution summary do not represent user code.
  if (cell.metadata.isInteractiveWindowMessageCell === true) return true;

  return isSupportedPythonNotebook(notebook) && cell.executionSummary === undefined;
}

export function newlyOpenedKernelSelectableInteractiveWindow(
  before: ReadonlySet<vscode.NotebookDocument>
):
  | { readonly kind: "found"; readonly notebook: vscode.NotebookDocument }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" } {
  const candidates = vscode.workspace.notebookDocuments.filter(
    (notebook) => !before.has(notebook) && !notebook.isClosed && notebook.notebookType === "interactive"
  );
  if (candidates.length === 0) return { kind: "missing" };
  if (candidates.length !== 1) return { kind: "ambiguous" };
  const notebook = candidates[0]!;
  if (!isSoleOpenNotebookDocument(notebook)) {
    return { kind: "ambiguous" };
  }
  const cells = notebook.getCells();
  if (cells.length === 0) {
    const metadata = freshJupyterKernelMetadata(notebook);
    return metadata === "python"
      ? { kind: "found", notebook }
      : metadata === "absent"
        ? { kind: "missing" }
        : { kind: "ambiguous" };
  }
  if (cells.length !== 1) return { kind: "ambiguous" };
  const cell = cells[0]!;
  if (
    cell.kind !== vscode.NotebookCellKind.Markup ||
    cell.document.languageId.trim().toLowerCase() !== "markdown" ||
    !isRecord(cell.metadata) ||
    cell.metadata.isInteractiveWindowMessageCell !== true
  ) {
    return { kind: "ambiguous" };
  }
  return { kind: "found", notebook };
}

export function isOnlyNewInteractiveWindow(
  before: ReadonlySet<vscode.NotebookDocument>,
  expected: vscode.NotebookDocument
): boolean {
  const candidates = vscode.workspace.notebookDocuments.filter(
    (notebook) => !before.has(notebook) && !notebook.isClosed && notebook.notebookType === "interactive"
  );
  return candidates.length === 1 && candidates[0] === expected && isSoleOpenNotebookDocument(expected);
}

export function isUnchangedPythonOrigin(origin: PythonCellOrigin): boolean {
  return origin.literateOrigin ? isUnchangedLiterateDocumentOrigin(origin.literateOrigin) : isExactPythonOrigin(origin);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
