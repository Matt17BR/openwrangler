import * as vscode from "vscode";
import type { TextDocumentSessionOrigin } from "../sessionCoordinator";
import { formatGeneratedRDocumentCode } from "./rDocumentSource";

export type RDocumentInsertionResult =
  { status: "applied" } | { status: "stale" } | { status: "indeterminate" } | { status: "rejected" };

interface InsertionSnapshot {
  readonly version: number;
  readonly text: string;
  readonly insertionText: string;
  readonly expectedText: string;
  readonly position: vscode.Position;
}

const INSERTION_TIMEOUT_MS = 10_000;
const insertionQueues = new WeakMap<vscode.TextDocument, Promise<RDocumentInsertionResult>>();

export function insertGeneratedRDocumentCode(
  origin: TextDocumentSessionOrigin,
  code: string
): Promise<RDocumentInsertionResult> {
  if (!code.trim()) throw new Error("Generated R code must not be empty.");
  const document = origin.document;
  const snapshot = captureInsertionSnapshot(origin, code);
  const previous = insertionQueues.get(document);
  const operation = previous
    ? previous.then((result) => (result.status === "indeterminate" ? result : performInsertion(origin, snapshot)))
    : Promise.resolve().then(() => performInsertion(origin, snapshot));
  insertionQueues.set(document, operation);
  void operation.then(
    () => {
      if (insertionQueues.get(document) === operation) insertionQueues.delete(document);
    },
    () => {
      if (insertionQueues.get(document) === operation) insertionQueues.delete(document);
    }
  );
  return operation;
}

function captureInsertionSnapshot(origin: TextDocumentSessionOrigin, code: string): InsertionSnapshot {
  const document = origin.document;
  const text = document.getText();
  const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  const documentCode = formatGeneratedRDocumentCode(document.uri.fsPath, code);
  const normalizedCode = documentCode.replace(/\r\n|\r|\n/gu, eol).trimEnd();
  const separator = text.length === 0 ? "" : endsWithLineBreak(text) ? eol : `${eol}${eol}`;
  const insertionText = `${separator}${normalizedCode}${eol}`;
  return Object.freeze({
    version: origin.version,
    text,
    insertionText,
    expectedText: text + insertionText,
    position: document.positionAt(text.length)
  });
}

async function performInsertion(
  origin: TextDocumentSessionOrigin,
  snapshot: InsertionSnapshot
): Promise<RDocumentInsertionResult> {
  if (!isCurrentOrigin(origin, snapshot)) return { status: "stale" };

  let edit: vscode.WorkspaceEdit;
  try {
    edit = new vscode.WorkspaceEdit();
    edit.insert(origin.document.uri, snapshot.position, snapshot.insertionText);
  } catch {
    return { status: "rejected" };
  }
  if (!isCurrentOrigin(origin, snapshot)) return { status: "stale" };
  return observeInsertion(origin, snapshot, edit);
}

function observeInsertion(
  origin: TextDocumentSessionOrigin,
  snapshot: InsertionSnapshot,
  edit: vscode.WorkspaceEdit
): Promise<RDocumentInsertionResult> {
  const document = origin.document;
  return new Promise((resolve) => {
    let settled = false;
    const subscriptions: vscode.Disposable[] = [];

    const finish = (result: RDocumentInsertionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const subscription of subscriptions) subscription.dispose();
      resolve(result);
    };
    const inspect = (): void => {
      if (settled) return;
      if (isExpectedResult(document, snapshot)) {
        finish({ status: "applied" });
        return;
      }
      if (document.isClosed || !isSoleOpenTextDocument(document)) {
        finish({ status: "indeterminate" });
      }
    };

    subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === document) inspect();
      }),
      vscode.workspace.onDidOpenTextDocument((opened) => {
        if (opened === document || opened.uri.toString() === document.uri.toString()) inspect();
      }),
      vscode.workspace.onDidCloseTextDocument((closed) => {
        if (closed === document || closed.uri.toString() === document.uri.toString()) inspect();
      })
    );
    const timer = setTimeout(() => {
      inspect();
      if (!settled) finish({ status: "indeterminate" });
    }, INSERTION_TIMEOUT_MS);

    let application: Thenable<boolean>;
    try {
      application = vscode.workspace.applyEdit(edit);
    } catch {
      finish({ status: "rejected" });
      return;
    }
    void Promise.resolve(application).then(
      (accepted) => {
        if (!accepted) {
          finish({ status: "rejected" });
          return;
        }
        inspect();
      },
      () => finish({ status: "indeterminate" })
    );
  });
}

function isCurrentOrigin(origin: TextDocumentSessionOrigin, snapshot: InsertionSnapshot): boolean {
  const document = origin.document;
  return (
    !document.isClosed &&
    origin.version === snapshot.version &&
    document.version === snapshot.version &&
    document.getText() === snapshot.text &&
    isSoleOpenTextDocument(document)
  );
}

function isExpectedResult(document: vscode.TextDocument, snapshot: InsertionSnapshot): boolean {
  return (
    !document.isClosed &&
    document.version > snapshot.version &&
    document.getText() === snapshot.expectedText &&
    isSoleOpenTextDocument(document)
  );
}

function isSoleOpenTextDocument(document: vscode.TextDocument): boolean {
  const uri = document.uri.toString();
  let exactMatches = 0;
  for (const candidate of vscode.workspace.textDocuments) {
    if (candidate === document) exactMatches += 1;
    else if (candidate.uri.toString() === uri) return false;
  }
  return exactMatches === 1;
}

function endsWithLineBreak(text: string): boolean {
  return text.endsWith("\n") || text.endsWith("\r");
}
