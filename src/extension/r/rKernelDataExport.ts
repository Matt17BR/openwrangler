import * as path from "node:path";
import * as vscode from "vscode";
import type { ExportDataRequest, OpenWranglerResponse } from "../../shared/protocol";
import { isExportOptions } from "../../shared/protocolValidation";
import type { BridgeRequestOptions } from "../dataBridge";
import { beginAtomicFileTransaction, type AtomicFileTransaction } from "../files/safeFileExport";
import {
  assertRExportResult,
  diagnosticResponse,
  errorResponse,
  kernelChangedError,
  rExportProtectedSourceUris,
  staleResponseError,
  staleRevisionError,
  transportOptions,
  unknownSessionError,
  type RBridgeSession
} from "./rKernelBridgeContract";
import type { RKernelBridgeTransport } from "./rKernelBridgeTransport";
import { RKernelDiagnosticError } from "./rKernelTransport";

const R_DATA_EXPORT_TIMEOUT_MS = 30 * 60_000;

export interface RKernelBridgeFileOperations {
  readonly beginTransaction?: typeof beginAtomicFileTransaction;
}

export class RKernelDataExport {
  constructor(
    private readonly transport: Pick<RKernelBridgeTransport, "exportData">,
    private readonly sessions: ReadonlyMap<string, RBridgeSession>,
    private readonly beginFileTransaction: typeof beginAtomicFileTransaction,
    private readonly readDisposed: () => boolean,
    private readonly readKernelGeneration: () => number
  ) {}

  private get disposed(): boolean {
    return this.readDisposed();
  }

  private get kernelGeneration(): number {
    return this.readKernelGeneration();
  }

  async exportData(request: ExportDataRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    if (!session) return unknownSessionError(request.sessionId);
    if (session.invalidated) return kernelChangedError(request.sessionId);
    if (!isExportOptions(request.options)) {
      return errorResponse("invalid_request", "R export options are invalid.", true, request.sessionId);
    }
    const exportOptions = request.options;
    const format = exportOptions.format;
    if (exportOptions.rowAxisPolicy !== undefined) {
      return errorResponse(
        "invalid_request",
        "R export does not accept a Pandas row-axis policy.",
        true,
        request.sessionId
      );
    }
    if (format === "csv" && !["utf-8", "utf8"].includes(exportOptions.encoding.toLowerCase().replaceAll("_", "-"))) {
      return errorResponse("invalid_request", "R CSV export supports UTF-8 encoding only.", true, request.sessionId);
    }
    if (format === "csv" && exportOptions.quoteChar !== '"') {
      return errorResponse(
        "invalid_request",
        "R CSV export supports the double-quote character only.",
        true,
        request.sessionId
      );
    }
    const writer = this.transport.exportData;
    const supportsFormat = format === "csv" ? session.exportCsv : session.exportParquet;
    if (!supportsFormat || !writer) {
      return errorResponse(
        "unsupported_operation",
        format === "parquet"
          ? "Parquet export requires nanoparquet 0.5.1 or newer in the selected local R runtime."
          : "Cleaned-data export is available for local R notebook and document sessions opened in Editing mode.",
        true,
        request.sessionId
      );
    }
    if (session.mode !== "editing") {
      return errorResponse(
        "unsupported_mode",
        "Change this R session to Editing mode before exporting cleaned data.",
        true,
        request.sessionId
      );
    }
    const stale = staleRevisionError(session, request.revision);
    if (stale) return stale;
    if (session.draftStep) {
      return errorResponse(
        "invalid_request",
        "Apply or discard the current R draft before exporting cleaned data.",
        true,
        request.sessionId
      );
    }
    if (!path.isAbsolute(request.path)) {
      return errorResponse(
        "invalid_request",
        "Choose an absolute file-system destination for the R export.",
        true,
        request.sessionId
      );
    }

    const expectedGeneration = this.kernelGeneration;
    const expectedRevision = session.revision;
    const expectedRows = session.committedRows;
    const expectedColumns = session.committedSchema.length;
    let transaction: AtomicFileTransaction | undefined;
    let settled = false;
    try {
      transaction = await this.beginFileTransaction({
        destination: vscode.Uri.file(request.path),
        protectedSources: rExportProtectedSourceUris(session.source)
      });
      const output = transaction;
      if (this.disposed || this.sessions.get(request.sessionId) !== session) {
        await transaction.rollback();
        settled = true;
        return unknownSessionError(request.sessionId);
      }
      if (session.invalidated || expectedGeneration !== this.kernelGeneration) {
        await transaction.rollback();
        settled = true;
        return kernelChangedError(request.sessionId);
      }
      if (session.revision !== expectedRevision) {
        await transaction.rollback();
        settled = true;
        return staleResponseError(request.sessionId);
      }
      const result = await writer.call(
        this.transport,
        request.sessionId,
        expectedRevision,
        exportOptions,
        (chunk) => output.write(chunk),
        transportOptions({
          ...options,
          timeoutMs: options.timeoutMs ?? R_DATA_EXPORT_TIMEOUT_MS
        })
      );

      if (this.disposed || this.sessions.get(request.sessionId) !== session) {
        await transaction.rollback();
        settled = true;
        return unknownSessionError(request.sessionId);
      }
      if (session.invalidated || expectedGeneration !== this.kernelGeneration) {
        await transaction.rollback();
        settled = true;
        return kernelChangedError(request.sessionId);
      }
      if (session.revision !== expectedRevision) {
        await transaction.rollback();
        settled = true;
        return staleResponseError(request.sessionId);
      }
      assertRExportResult(result, request.sessionId, expectedRevision, format, expectedRows, expectedColumns);
      await transaction.commit();
      settled = true;
      return {
        kind: "dataExported",
        revision: expectedRevision,
        path: request.path,
        format,
        shape: { rows: result.rows, columns: result.columns }
      };
    } catch (error) {
      if (transaction && !settled) {
        try {
          await transaction.rollback();
          settled = true;
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "R data export failed and its unpublished temporary file could not be settled safely."
          );
        }
      }
      if (error instanceof RKernelDiagnosticError) return diagnosticResponse(error, request.sessionId);
      throw error;
    }
  }
}
