import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import type { OpenSessionRequest, SessionMetadata, SessionMode, SessionSource } from "../shared/protocol";
import { canRequestLiveSessionMode } from "../shared/sessionMode";
import { isSoleOpenNotebookDocument } from "./notebooks/notebookProvenance";

export interface TextDocumentSessionOrigin {
  readonly kind: "textDocument";
  readonly document: vscode.TextDocument;
  readonly version: number;
}

export type CoordinatedSessionOrigin =
  Readonly<{ kind: "notebook"; document: vscode.NotebookDocument }> | TextDocumentSessionOrigin;

export type BridgeSessionOrigin = vscode.NotebookDocument | TextDocumentSessionOrigin;

interface LiveEditingSession {
  readonly metadata: SessionMetadata;
  readonly openRequest: OpenSessionRequest;
  readonly origin?: CoordinatedSessionOrigin;
}

export function sameFileSourceIdentity(current: SessionSource, replacement: SessionSource): boolean {
  if (current.kind !== "file" || replacement.kind !== "file") return false;
  const { importOptions: _currentImportOptions, ...currentIdentity } = current;
  const { importOptions: _replacementImportOptions, ...replacementIdentity } = replacement;
  return isDeepStrictEqual(currentIdentity, replacementIdentity);
}

export function normalizeSessionOrigin(origin: BridgeSessionOrigin | undefined): CoordinatedSessionOrigin | undefined {
  if (!origin) return undefined;
  if (isTextDocumentSessionOrigin(origin)) {
    if (!Number.isSafeInteger(origin.version) || origin.version < 0) {
      throw new TypeError("A source-document origin requires a valid captured document version.");
    }
    return Object.freeze({ kind: "textDocument", document: origin.document, version: origin.version });
  }
  return Object.freeze({ kind: "notebook", document: origin });
}

export function canReopenLiveSessionInMode(session: LiveEditingSession, target: SessionMode): boolean {
  if (!canRequestLiveSessionMode(session.metadata, target)) return false;
  if (session.openRequest.source.kind === "notebookVariable") {
    return session.origin?.kind === "notebook";
  }
  return session.openRequest.source.kind === "rInteractiveVariable" && session.origin === undefined;
}

export function sessionOriginMismatch(
  request: OpenSessionRequest,
  origin: CoordinatedSessionOrigin | undefined
): string | undefined {
  if (request.source.kind === "documentVariable" && origin?.kind !== "textDocument") {
    return "A live document-variable session requires its exact originating text document.";
  }
  if (!origin) return undefined;
  return origin.kind === "notebook"
    ? notebookOriginMismatch(request, origin.document)
    : textDocumentOriginMismatch(request, origin);
}

function isTextDocumentSessionOrigin(origin: BridgeSessionOrigin): origin is TextDocumentSessionOrigin {
  return "kind" in origin && origin.kind === "textDocument";
}

function notebookOriginMismatch(request: OpenSessionRequest, notebook: vscode.NotebookDocument): string | undefined {
  if (request.source.kind !== "notebookVariable" || !request.source.uri) {
    return "Notebook provenance may be attached only to a live notebook-variable session.";
  }
  if (request.source.uri !== notebook.uri.toString()) {
    return "The notebook variable source did not match its originating notebook document.";
  }
  if (!isSoleOpenNotebookDocument(notebook)) {
    return "The originating notebook is no longer open. Reopen it and try again.";
  }
  return undefined;
}

function textDocumentOriginMismatch(
  request: OpenSessionRequest,
  origin: TextDocumentSessionOrigin
): string | undefined {
  if (request.source.kind !== "documentVariable" || !request.source.uri) {
    return "Source-document provenance may be attached only to a live document-variable session.";
  }
  const document = origin.document;
  if (request.source.uri !== document.uri.toString()) {
    return "The document variable source did not match its originating text document.";
  }
  const matches = vscode.workspace.textDocuments.filter((candidate) => candidate.uri.toString() === request.source.uri);
  if (document.isClosed || matches.length !== 1 || matches[0] !== document) {
    return "The originating source document is no longer uniquely open. Reopen it and try again.";
  }
  if (document.version !== origin.version) {
    return "The originating source document changed after Open Wrangler captured it. Run the file again.";
  }
  return undefined;
}
