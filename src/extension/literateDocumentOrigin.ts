import * as vscode from "vscode";
import {
  findLiterateCodeChunkAtLine,
  literateDocumentKind,
  type LiterateCodeChunk,
  type LiterateDocumentKind
} from "./literateDocumentChunks";

interface PositionSnapshot {
  readonly line: number;
  readonly character: number;
}

interface SelectionSnapshot {
  readonly anchor: PositionSnapshot;
  readonly active: PositionSnapshot;
}

export interface LiterateDocumentOrigin {
  readonly editor: vscode.TextEditor;
  readonly document: vscode.TextDocument;
  readonly version: number;
  readonly uri: string;
  readonly kind: LiterateDocumentKind;
  readonly viewColumn: vscode.ViewColumn;
  readonly selections: readonly SelectionSnapshot[];
  readonly chunk?: LiterateCodeChunk;
}

/** Captures the exact active source editor before any command activation can await. */
export function captureLiterateDocumentOrigin(expectedUri?: vscode.Uri): LiterateDocumentOrigin | undefined {
  const editor = vscode.window.activeTextEditor;
  const document = editor?.document;
  if (!editor || !document || !isSupportedLiterateDocument(document) || !isSoleOpenTextDocument(document)) {
    return undefined;
  }
  if (expectedUri && document.uri.toString() !== expectedUri.toString()) return undefined;
  const kind = literateDocumentKind(document.uri.fsPath);
  if (!kind) return undefined;
  const selections = Object.freeze(editor.selections.map(freezeSelection));
  const active = selections[0]?.active;
  if (!active) return undefined;
  const chunk = findLiterateCodeChunkAtLine(document.uri.fsPath, document.getText(), active.line);
  return Object.freeze({
    editor,
    document,
    version: document.version,
    uri: document.uri.toString(),
    kind,
    viewColumn: editor.viewColumn ?? vscode.ViewColumn.Active,
    selections,
    ...(chunk ? { chunk } : {})
  });
}

export function isCurrentLiterateDocumentOrigin(origin: LiterateDocumentOrigin): boolean {
  const document = origin.document;
  const editor = origin.editor;
  return (
    vscode.window.activeTextEditor === editor &&
    editor.document === document &&
    !document.isClosed &&
    document.version === origin.version &&
    document.uri.toString() === origin.uri &&
    literateDocumentKind(document.uri.fsPath) === origin.kind &&
    isSoleOpenTextDocument(document) &&
    sameSelections(editor.selections, origin.selections)
  );
}

export function isSupportedLiterateUri(uri: vscode.Uri): boolean {
  return (uri.scheme === "file" || uri.scheme === "vscode-remote") && literateDocumentKind(uri.fsPath) !== undefined;
}

function isSupportedLiterateDocument(document: vscode.TextDocument): boolean {
  return !document.isClosed && !document.isUntitled && isSupportedLiterateUri(document.uri);
}

function isSoleOpenTextDocument(document: vscode.TextDocument): boolean {
  const serialized = document.uri.toString();
  const matches = vscode.workspace.textDocuments.filter(
    (candidate) => !candidate.isClosed && candidate.uri.toString() === serialized
  );
  return matches.length === 1 && matches[0] === document;
}

function freezeSelection(selection: vscode.Selection): SelectionSnapshot {
  return Object.freeze({
    anchor: Object.freeze({ line: selection.anchor.line, character: selection.anchor.character }),
    active: Object.freeze({ line: selection.active.line, character: selection.active.character })
  });
}

function sameSelections(current: readonly vscode.Selection[], captured: readonly SelectionSnapshot[]): boolean {
  return (
    current.length === captured.length &&
    current.every((selection, index) => {
      const expected = captured[index];
      return (
        expected !== undefined &&
        selection.anchor.line === expected.anchor.line &&
        selection.anchor.character === expected.anchor.character &&
        selection.active.line === expected.active.line &&
        selection.active.character === expected.active.character
      );
    })
  );
}
