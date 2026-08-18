import * as path from "node:path";
import * as vscode from "vscode";
import type { ExportDataRequest, OpenWranglerResponse, SessionSource } from "../../shared/protocol";
import { beginAtomicFileTransaction, type AtomicFileTransaction } from "./safeFileExport";

export interface SafePythonDataExportOptions {
  readonly request: ExportDataRequest;
  readonly source: SessionSource;
  readonly dispatch: (request: ExportDataRequest) => Promise<OpenWranglerResponse>;
  readonly beginTransaction?: typeof beginAtomicFileTransaction;
}

export async function exportPythonDataSafely({
  request,
  source,
  dispatch,
  beginTransaction = beginAtomicFileTransaction
}: SafePythonDataExportOptions): Promise<OpenWranglerResponse> {
  if (!path.isAbsolute(request.path)) {
    throw new TypeError("Choose an absolute file-system destination for the Python export.");
  }
  let transaction: AtomicFileTransaction | undefined;
  let settled = false;
  try {
    transaction = await beginTransaction({
      destination: vscode.Uri.file(request.path),
      protectedSources: pythonExportProtectedSourceUris(source)
    });
    const target = await transaction.prepareExternalWriter();
    const response = await dispatch({
      ...request,
      path: target.path,
      targetIdentity: {
        device: target.identity.dev.toString(10),
        inode: target.identity.ino.toString(10)
      }
    });
    if (response.kind !== "dataExported") {
      await transaction.rollback();
      settled = true;
      return response;
    }
    if (
      response.path !== target.path ||
      response.format !== request.options.format ||
      response.revision !== request.revision
    ) {
      throw new Error("The Python runtime returned a mismatched cleaned-data export response.");
    }
    await transaction.commit();
    settled = true;
    return { ...response, path: request.path };
  } catch (error) {
    if (transaction && !settled) {
      try {
        await transaction.rollback();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Python data export failed and its unpublished temporary file could not be settled safely."
        );
      }
    }
    throw error;
  }
}

export function copySessionSource(source: SessionSource): SessionSource {
  return {
    ...source,
    ...(source.importOptions ? { importOptions: { ...source.importOptions } } : {})
  };
}

function pythonExportProtectedSourceUris(source: SessionSource): readonly vscode.Uri[] {
  if (source.kind === "notebookVariable") {
    if (!source.uri) return [];
    const notebook = vscode.Uri.parse(source.uri, true);
    if (notebook.scheme === "untitled") return [];
    if ((notebook.scheme === "file" || notebook.scheme === "vscode-remote") && notebook.fsPath) {
      return [notebook];
    }
    throw new TypeError("Python data export requires a concrete notebook source URI.");
  }
  if (source.kind !== "file") return [];

  const candidates: vscode.Uri[] = [];
  if (source.uri) {
    try {
      candidates.push(vscode.Uri.parse(source.uri, true));
    } catch {
      // A concrete path below still protects file metadata with a malformed URI.
    }
  }
  if (source.path) candidates.push(vscode.Uri.file(source.path));
  const concrete = candidates.filter(
    (candidate) => (candidate.scheme === "file" || candidate.scheme === "vscode-remote") && Boolean(candidate.fsPath)
  );
  if (concrete.length === 0) {
    throw new TypeError("Python data export requires a concrete file source.");
  }
  return concrete.filter(
    (candidate, index) =>
      concrete.findIndex(
        (other) =>
          other.scheme === candidate.scheme &&
          other.authority === candidate.authority &&
          other.fsPath === candidate.fsPath
      ) === index
  );
}
