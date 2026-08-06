import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { DataBackend } from "../../shared/protocol";

export type NotebookInsertionLanguage = "python" | "r";

export interface NotebookInsertionMetadata {
  source: string;
  backend: DataBackend;
  languageId: NotebookInsertionLanguage;
}

export type NotebookInsertionResult =
  { status: "applied" } | { status: "stale" } | { status: "indeterminate" } | { status: "rejected" };

interface NotebookSnapshot {
  readonly version: number;
  readonly cellCount: number;
}

const NOTEBOOK_INSERTION_TIMEOUT_MS = 10_000;
const insertionQueues = new WeakMap<vscode.NotebookDocument, Promise<NotebookInsertionResult>>();

export async function insertGeneratedNotebookCell(
  notebook: vscode.NotebookDocument,
  index: number,
  code: string,
  metadata: NotebookInsertionMetadata
): Promise<NotebookInsertionResult> {
  if (!code.trim()) throw new Error("Generated notebook code must not be empty.");
  if (metadata.languageId !== "python" && metadata.languageId !== "r") {
    throw new Error("Generated notebook cells support only Python or R.");
  }
  if (!Number.isInteger(index) || index < 0 || index > notebook.cellCount) {
    throw new Error(`Notebook insertion index ${index} is outside the document.`);
  }

  const snapshot: NotebookSnapshot = {
    version: notebook.version,
    cellCount: notebook.cellCount
  };
  const previous = insertionQueues.get(notebook);
  const operation = previous
    ? previous.then((result) =>
        result.status === "indeterminate" ? result : performInsertion(notebook, snapshot, index, code, metadata)
      )
    : Promise.resolve().then(() => performInsertion(notebook, snapshot, index, code, metadata));
  insertionQueues.set(notebook, operation);
  void operation.then(
    () => {
      if (insertionQueues.get(notebook) === operation) insertionQueues.delete(notebook);
    },
    () => {
      if (insertionQueues.get(notebook) === operation) insertionQueues.delete(notebook);
    }
  );
  return operation;
}

async function performInsertion(
  notebook: vscode.NotebookDocument,
  snapshot: NotebookSnapshot,
  index: number,
  code: string,
  metadata: NotebookInsertionMetadata
): Promise<NotebookInsertionResult> {
  if (!isCurrentNotebook(notebook, snapshot, index)) return { status: "stale" };

  let insertionId: string;
  let edit: vscode.WorkspaceEdit;
  try {
    insertionId = randomUUID();
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, metadata.languageId);
    cell.metadata = {
      openWrangler: {
        source: metadata.source,
        backend: metadata.backend,
        languageId: metadata.languageId,
        generated: true,
        insertionId
      }
    };
    edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(index, [cell])]);
  } catch {
    return { status: "rejected" };
  }

  // Notebook workspace edits are URI-addressed. Recheck after building the edit so any
  // replacement observed before dispatch fails closed instead of being retargeted.
  if (!isCurrentNotebook(notebook, snapshot, index)) return { status: "stale" };

  return observeInsertion(notebook, snapshot, code, metadata, insertionId, edit);
}

function observeInsertion(
  notebook: vscode.NotebookDocument,
  snapshot: NotebookSnapshot,
  code: string,
  metadata: NotebookInsertionMetadata,
  insertionId: string,
  edit: vscode.WorkspaceEdit
): Promise<NotebookInsertionResult> {
  return new Promise((resolve) => {
    let settled = false;
    const observation: { timer?: ReturnType<typeof setTimeout> } = {};
    const subscriptions: vscode.Disposable[] = [];

    const finish = (result: NotebookInsertionResult): void => {
      if (settled) return;
      settled = true;
      if (observation.timer) clearTimeout(observation.timer);
      for (const subscription of subscriptions) subscription.dispose();
      resolve(result);
    };
    const inspect = (): void => {
      if (settled) return;
      try {
        if (isExpectedAppliedCell(notebook, snapshot, code, metadata, insertionId)) {
          finish({ status: "applied" });
          return;
        }
      } catch {
        // A transient read cannot prove success. Keep waiting until the bounded deadline.
      }
      if (notebook.isClosed || !isOnlyOpenDocumentForUri(notebook)) {
        finish({ status: "indeterminate" });
      }
    };

    subscriptions.push(
      vscode.workspace.onDidChangeNotebookDocument((event) => {
        if (event.notebook === notebook) inspect();
      }),
      vscode.workspace.onDidOpenNotebookDocument((opened) => {
        if (opened === notebook || opened.uri.toString() === notebook.uri.toString()) inspect();
      }),
      vscode.workspace.onDidCloseNotebookDocument((closed) => {
        if (closed === notebook || closed.uri.toString() === notebook.uri.toString()) inspect();
      })
    );
    observation.timer = setTimeout(() => {
      inspect();
      if (!settled) finish({ status: "indeterminate" });
    }, NOTEBOOK_INSERTION_TIMEOUT_MS);

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

function isCurrentNotebook(notebook: vscode.NotebookDocument, snapshot: NotebookSnapshot, index: number): boolean {
  if (
    notebook.isClosed ||
    notebook.version !== snapshot.version ||
    notebook.cellCount !== snapshot.cellCount ||
    index > snapshot.cellCount
  ) {
    return false;
  }

  const uri = notebook.uri.toString();
  let foundExactDocument = false;
  for (const openNotebook of vscode.workspace.notebookDocuments) {
    if (openNotebook === notebook) {
      foundExactDocument = true;
    } else if (openNotebook.uri.toString() === uri) {
      return false;
    }
  }
  return foundExactDocument;
}

function isExpectedAppliedCell(
  notebook: vscode.NotebookDocument,
  snapshot: NotebookSnapshot,
  code: string,
  metadata: NotebookInsertionMetadata,
  insertionId: string
): boolean {
  if (
    notebook.isClosed ||
    notebook.version <= snapshot.version ||
    notebook.cellCount < snapshot.cellCount + 1 ||
    !isOnlyOpenDocumentForUri(notebook)
  ) {
    return false;
  }

  let markerMatches = 0;
  let expectedMatches = 0;
  for (let index = 0; index < notebook.cellCount; index += 1) {
    const cell = notebook.cellAt(index);
    const marker: unknown = cell.metadata.openWrangler;
    if (!hasInsertionId(marker, insertionId)) continue;
    markerMatches += 1;
    if (
      cell.kind === vscode.NotebookCellKind.Code &&
      cell.document.languageId === metadata.languageId &&
      cell.document.getText() === code &&
      isInsertionMarker(marker, metadata, insertionId)
    ) {
      expectedMatches += 1;
    }
  }
  return markerMatches === 1 && expectedMatches === 1;
}

function isOnlyOpenDocumentForUri(notebook: vscode.NotebookDocument): boolean {
  const uri = notebook.uri.toString();
  let exactMatches = 0;
  for (const openNotebook of vscode.workspace.notebookDocuments) {
    if (openNotebook === notebook) exactMatches += 1;
    else if (openNotebook.uri.toString() === uri) return false;
  }
  return exactMatches === 1;
}

function isInsertionMarker(value: unknown, metadata: NotebookInsertionMetadata, insertionId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const marker = value as Record<string, unknown>;
  return (
    marker.source === metadata.source &&
    marker.backend === metadata.backend &&
    marker.languageId === metadata.languageId &&
    marker.generated === true &&
    marker.insertionId === insertionId
  );
}

function hasInsertionId(value: unknown, insertionId: string): boolean {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).insertionId === insertionId);
}
