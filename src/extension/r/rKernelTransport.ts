import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { Jupyter, Kernel, KernelStatus } from "@vscode/jupyter-extension";
import * as vscode from "vscode";
import type { ColumnSummary, ExportOptions, ValueCount } from "../../shared/protocol";
import { DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS } from "../configuration";
import { DetachedBridgeRequestError, type DetachedBridgeRequestReason } from "../dataBridge";
import {
  KernelRequestCancelledError,
  type KernelCancellationLike,
  withKernelTimeout
} from "../notebooks/kernelLifecycle";
import { kernelOutputsToText } from "../notebooks/kernelBridge";
import { isSoleOpenNotebookDocument } from "../notebooks/notebookProvenance";
import {
  decodeRKernelResponseJson,
  encodeRKernelRequest,
  R_KERNEL_EXPORT_CHUNK_BYTES,
  R_KERNEL_MAX_RESPONSE_BYTES,
  R_KERNEL_TRANSPORT_VERSION,
  type RKernelDatasetStatsResult,
  type RKernelDataExportResult,
  type RKernelErrorResponse,
  type RKernelExportFormat,
  type RKernelColumnReference,
  type RKernelPageWindow,
  type RKernelPlanUpdatedResult,
  type RKernelTransformStep,
  type RKernelRequest,
  type RKernelResponseDecodeContext,
  type RKernelResponse,
  type RKernelStepInspectionResult,
  type RKernelStepPreviewResult,
  type RKernelViewQuery
} from "./rKernelProtocol";
import {
  buildRKernelBootstrapCode,
  buildRKernelDispatchCode,
  buildRKernelTeardownCode,
  readRRuntimeFiles
} from "./rKernelRuntimeBundle";
import type { RColumnSchema, RFramePageContract } from "./rFrameContract";
import type { RNotebookKernelSelectionBinding } from "./rNotebookVariableDiscovery";

const FAILED_OPEN_CLOSE_TIMEOUT_MS = 5_000;
const DATA_EXPORT_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_RETIRED_SESSION_IDS = 1_024;
const MAX_PENDING_CLEANUP_ATTEMPTS = 64;

export interface RKernelRequestOptions {
  readonly cancellation?: KernelCancellationLike;
  readonly timeoutMs?: number;
  /** Host-owned candidate identity used for exact cleanup after an ambiguous open. */
  readonly requestedSessionId?: string;
}

export interface RKernelOpenResult {
  readonly sessionId: string;
  readonly exportFormats: readonly RKernelExportFormat[];
  readonly page: RFramePageContract;
}

export class RKernelDiagnosticError extends Error {
  constructor(readonly diagnostic: RKernelErrorResponse) {
    super(diagnostic.message);
    this.name = "RKernelDiagnosticError";
  }
}

interface KernelObservation {
  readonly kernel: Kernel;
  readonly jupyter: Jupyter;
  subscription?: vscode.Disposable;
}

export class RKernelSessionTransport {
  private readonly notebookUri: vscode.Uri;
  private readonly bootstrapCode: string;
  private readonly teardownCode: string;
  private readonly bootstrappedKernels = new Set<Kernel>();
  private readonly sessionKernels = new Map<string, Kernel>();
  private readonly retiredSessionIds = new Set<string>();
  private readonly failedOpenCleanupSessionIds = new Set<string>();
  private readonly cleanupAttempts = new WeakMap<Kernel, Map<string, Promise<boolean>>>();
  private readonly bootstrapPromises = new WeakMap<Kernel, Promise<void>>();
  private readonly kernelSettlementBarriers = new WeakMap<Kernel, Promise<void>>();
  private deferredExportCleanupFailure: unknown;
  private observation: KernelObservation | undefined;
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private activeOpens = 0;
  private openIdle: Promise<void> = Promise.resolve();
  private resolveOpenIdle: (() => void) | undefined;
  private readonly kernelInvalidatedEmitter = new vscode.EventEmitter<void>();
  readonly onDidInvalidateKernel = this.kernelInvalidatedEmitter.event;

  constructor(
    context: vscode.ExtensionContext,
    private readonly notebookDocument: vscode.NotebookDocument,
    private readonly createId: () => string = randomUUID,
    runtimeOwnerToken: string = randomUUID(),
    private readonly verifiedSelection?: RNotebookKernelSelectionBinding
  ) {
    this.notebookUri = notebookDocument.uri;
    const runtimeFiles = readRRuntimeFiles(path.join(context.extensionPath, "r"));
    this.bootstrapCode = buildRKernelBootstrapCode(runtimeFiles, runtimeOwnerToken);
    this.teardownCode = buildRKernelTeardownCode(runtimeFiles, runtimeOwnerToken);
  }

  async open(
    variableName: string,
    page: RKernelPageWindow,
    options: RKernelRequestOptions = {}
  ): Promise<RKernelOpenResult> {
    this.assertActive();
    if (this.verifiedSelection && variableName !== this.verifiedSelection.variable.name) {
      throw new Error("The R variable no longer matches the dataframe selected from the notebook picker.");
    }
    this.beginOpen();
    let detachedSettlement: Promise<void> | undefined;
    try {
      const started = performance.now();
      const timeoutMs = requestTimeout(options.timeoutMs);
      const sessionId = options.requestedSessionId ?? this.createId();
      this.assertSessionIdentityAvailable(sessionId);
      const request = this.request("openSession", { sessionId, variableName, page });
      encodeRKernelRequest(request);
      const preparation = (async () => {
        const acquired = await this.acquireKernel();
        await this.ensureBootstrapped(acquired);
        await this.assertKernelStillSelected(acquired);
        return acquired;
      })();
      void preparation.catch(() => undefined);
      let preparationDetachedReason: DetachedBridgeRequestReason | undefined;
      let acquired: KernelObservation;
      try {
        acquired = await withKernelTimeout(
          preparation,
          timeoutMs,
          () => {
            preparationDetachedReason = "timeout";
          },
          options.cancellation,
          () => {
            preparationDetachedReason = "cancellation";
          }
        );
      } catch (error) {
        if (!preparationDetachedReason) throw error;
        detachedSettlement = observeSettlement(preparation);
        throw new DetachedBridgeRequestError(
          error instanceof Error ? error.message : detachedRequestMessage(preparationDetachedReason, timeoutMs),
          preparationDetachedReason,
          false,
          detachedSettlement
        );
      }
      this.assertActive();
      this.assertSessionIdentityAvailable(sessionId);
      await this.waitForKernelSettlement(acquired.kernel, timeoutMs, started, options.cancellation);
      const settlementPostflight = this.assertKernelStillSelected(acquired);
      void settlementPostflight.catch(() => undefined);
      await withKernelTimeout(
        settlementPostflight,
        remainingTimeout(timeoutMs, started),
        () => undefined,
        options.cancellation
      );
      assertDispatchAllowed(options.cancellation, remainingTimeout(timeoutMs, started));

      this.sessionKernels.set(sessionId, acquired.kernel);
      const completion = this.executeRequest(acquired.kernel, request, { expectExportFormats: true });
      void completion.catch(() => undefined);
      let detachedReason: DetachedBridgeRequestReason | undefined;
      let response: RKernelResponse;
      try {
        response = await withKernelTimeout(
          completion,
          remainingTimeout(timeoutMs, started),
          () => {
            detachedReason = "timeout";
          },
          options.cancellation,
          () => {
            detachedReason = "cancellation";
          }
        );
      } catch (error) {
        if (detachedReason) {
          detachedSettlement = this.cleanupAfterOpenSettlement(sessionId, acquired.kernel, completion);
          this.installKernelSettlementBarrier(acquired.kernel, detachedSettlement);
          throw new DetachedBridgeRequestError(
            detachedRequestMessage(detachedReason, timeoutMs),
            detachedReason,
            true,
            detachedSettlement
          );
        }
        await this.cleanupFailedOpen(sessionId, acquired.kernel);
        throw error;
      }

      try {
        const postflight = this.assertKernelStillSelected(acquired);
        void postflight.catch(() => undefined);
        await withKernelTimeout(
          postflight,
          remainingTimeout(timeoutMs, started),
          () => undefined,
          options.cancellation
        );
        this.assertActive();
        if (response.kind === "error") throw new RKernelDiagnosticError(response);
        if (response.kind !== "page" || response.sessionId !== sessionId) {
          throw new Error("The R kernel returned a mismatched session identity.");
        }
        if (!response.exportFormats) {
          throw new Error("The R kernel did not report its data-export capabilities.");
        }
        if (
          this.verifiedSelection &&
          response.page.dataframeFlavor !== this.verifiedSelection.variable.dataframeFlavor
        ) {
          throw new Error("The selected R dataframe changed before Open Wrangler opened it.");
        }
        return Object.freeze({ sessionId, exportFormats: response.exportFormats, page: response.page });
      } catch (error) {
        await this.cleanupFailedOpen(sessionId, acquired.kernel);
        throw error;
      }
    } finally {
      if (detachedSettlement) {
        void detachedSettlement.then(
          () => this.endOpen(),
          () => this.endOpen()
        );
      } else {
        this.endOpen();
      }
    }
  }

  async getPage(
    sessionId: string,
    page: RKernelPageWindow,
    options: RKernelRequestOptions = {}
  ): Promise<RFramePageContract> {
    const request = this.request("getPage", { sessionId, page });
    encodeRKernelRequest(request);
    const response = await this.executeMappedRequest(sessionId, request, options);
    if (response.kind === "error") throw new RKernelDiagnosticError(response);
    if (response.kind !== "page" || response.sessionId !== sessionId) {
      throw new Error("The R kernel returned a mismatched page session identity.");
    }
    return response.page;
  }

  async getSummary(
    sessionId: string,
    columns: readonly RKernelColumnReference[],
    view: RKernelViewQuery,
    options: RKernelRequestOptions = {}
  ): Promise<readonly ColumnSummary[]> {
    const request = this.request("getSummary", { sessionId, columns, view });
    encodeRKernelRequest(request);
    const response = await this.executeMappedRequest(sessionId, request, options);
    if (response.kind === "error") throw new RKernelDiagnosticError(response);
    if (response.kind !== "summary" || response.sessionId !== sessionId) {
      throw new Error("The R kernel returned a mismatched summary session identity.");
    }
    return response.summaries;
  }

  async getDatasetStats(
    sessionId: string,
    view: RKernelViewQuery,
    options: RKernelRequestOptions = {}
  ): Promise<RKernelDatasetStatsResult> {
    const request = this.request("getDatasetStats", { sessionId, view });
    encodeRKernelRequest(request);
    const response = await this.executeMappedRequest(sessionId, request, options);
    if (response.kind === "error") throw new RKernelDiagnosticError(response);
    if (response.kind !== "datasetStats" || response.sessionId !== sessionId) {
      throw new Error("The R kernel returned mismatched dataset statistics.");
    }
    return { totalRows: response.totalRows, stats: response.stats };
  }

  async getColumnValues(
    sessionId: string,
    column: RKernelColumnReference,
    view: RKernelViewQuery,
    search: string | undefined,
    limit: number,
    options: RKernelRequestOptions = {}
  ): Promise<Readonly<{ column: string; values: readonly ValueCount[]; hasMore: boolean; sampleSize?: number }>> {
    const request = this.request("getColumnValues", {
      sessionId,
      column,
      view,
      search: search ?? null,
      limit
    });
    encodeRKernelRequest(request);
    const response = await this.executeMappedRequest(sessionId, request, options);
    if (response.kind === "error") throw new RKernelDiagnosticError(response);
    if (response.kind !== "columnValues" || response.sessionId !== sessionId) {
      throw new Error("The R kernel returned mismatched column values.");
    }
    return Object.freeze({
      column: response.column,
      values: response.values,
      hasMore: response.hasMore,
      ...(response.sampleSize === undefined ? {} : { sampleSize: response.sampleSize })
    });
  }

  async exportData(
    sessionId: string,
    revision: number,
    exportOptions: ExportOptions,
    writeChunk: (chunk: Uint8Array) => Promise<void>,
    options: RKernelRequestOptions = {}
  ): Promise<RKernelDataExportResult> {
    this.assertActive();
    if (typeof writeChunk !== "function") throw new TypeError("The R export chunk writer must be a function.");
    const format = exportOptions.format;
    const kernel = this.requireMappedKernel(sessionId);
    const exportId = this.createId();
    const started = performance.now();
    const timeoutMs = requestTimeout(options.timeoutMs);
    const remainingOptions = (): RKernelRequestOptions => ({
      ...options,
      timeoutMs: Math.floor(remainingTimeout(timeoutMs, started))
    });
    let failure: unknown;
    let result: RKernelDataExportResult | undefined;

    try {
      const begin = this.request("exportData", { sessionId, revision, exportId, options: exportOptions });
      encodeRKernelRequest(begin);
      const ready = await this.executeMappedRequest(sessionId, begin, remainingOptions());
      if (ready.kind === "error") throw new RKernelDiagnosticError(ready);
      if (
        ready.kind !== "dataExported" ||
        ready.sessionId !== sessionId ||
        ready.revision !== revision ||
        ready.exportId !== exportId ||
        ready.format !== format
      ) {
        throw new Error("The R kernel returned a mismatched data export.");
      }

      let offset = 0;
      while (offset < ready.bytes) {
        const limit = Math.min(R_KERNEL_EXPORT_CHUNK_BYTES, ready.bytes - offset);
        const request = this.request("readDataExport", { sessionId, revision, exportId, offset, limit });
        encodeRKernelRequest(request);
        const response = await this.executeMappedRequest(sessionId, request, remainingOptions());
        if (response.kind === "error") throw new RKernelDiagnosticError(response);
        if (
          response.kind !== "dataExportChunk" ||
          response.sessionId !== sessionId ||
          response.revision !== revision ||
          response.exportId !== exportId ||
          response.offset !== offset ||
          response.bytes < 1 ||
          response.bytes > limit ||
          response.data.byteLength !== response.bytes ||
          offset + response.bytes > ready.bytes
        ) {
          throw new Error("The R kernel returned a mismatched data-export chunk.");
        }
        await writeChunk(response.data);
        offset += response.bytes;
      }
      if (offset !== ready.bytes) throw new Error("The R kernel returned an incomplete data export.");
      result = Object.freeze({
        sessionId,
        revision,
        format,
        rows: ready.rows,
        columns: ready.columns
      });
    } catch (error) {
      if (error instanceof DetachedBridgeRequestError && error.dispatched) {
        const cleanup = error.settlement.then(async () => {
          try {
            await this.closeMappedDataExport(sessionId, revision, exportId, kernel, DATA_EXPORT_CLEANUP_TIMEOUT_MS);
          } catch (cleanupError) {
            await this.recoverFromExportCleanupFailure(sessionId, kernel, cleanupError);
          }
        });
        throw new DetachedBridgeRequestError(error.message, error.reason, true, cleanup);
      }
      failure = error;
    }

    try {
      await this.closeMappedDataExport(sessionId, revision, exportId, kernel, DATA_EXPORT_CLEANUP_TIMEOUT_MS);
    } catch (cleanupError) {
      await this.recoverFromExportCleanupFailure(sessionId, kernel, cleanupError);
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, cleanupError],
          "R notebook export failed and its private kernel artifact could not be closed safely."
        );
      }
      throw cleanupError;
    }
    if (failure !== undefined) throw failure;
    if (!result) throw new Error("The R kernel did not return a completed data export.");
    return result;
  }

  async previewStep(
    sessionId: string,
    revision: number,
    step: RKernelTransformStep,
    page: RKernelPageWindow,
    inputSchema: readonly RColumnSchema[],
    replaceStepId?: string,
    options: RKernelRequestOptions = {}
  ): Promise<RKernelStepPreviewResult> {
    const request = this.request("previewStep", {
      sessionId,
      revision,
      step,
      page,
      ...(replaceStepId === undefined ? {} : { replaceStepId })
    });
    encodeRKernelRequest(request);
    const response = await this.executeMappedRequest(sessionId, request, options, { inputSchema, previewStep: step });
    if (response.kind === "error") throw new RKernelDiagnosticError(response);
    if (response.kind !== "stepPreview" || response.sessionId !== sessionId || response.revision !== revision + 1) {
      throw new Error("The R kernel returned a mismatched step preview.");
    }
    return Object.freeze({
      sessionId,
      revision: response.revision,
      page: response.page,
      diff: response.diff,
      code: response.code,
      ...(response.remainingMissingCells === undefined
        ? {}
        : { remainingMissingCells: response.remainingMissingCells }),
      ...(response.retainedStep === undefined ? {} : { retainedStep: response.retainedStep }),
      ...(response.effectiveView === undefined ? {} : { effectiveView: response.effectiveView })
    });
  }

  applyDraft(
    sessionId: string,
    revision: number,
    page: RKernelPageWindow,
    options: RKernelRequestOptions = {}
  ): Promise<RKernelPlanUpdatedResult> {
    return this.updatePlan("applyDraft", "apply", sessionId, revision, page, options);
  }

  discardDraft(
    sessionId: string,
    revision: number,
    page: RKernelPageWindow,
    options: RKernelRequestOptions = {}
  ): Promise<RKernelPlanUpdatedResult> {
    return this.updatePlan("discardDraft", "discard", sessionId, revision, page, options);
  }

  undoStep(
    sessionId: string,
    revision: number,
    page: RKernelPageWindow,
    options: RKernelRequestOptions = {}
  ): Promise<RKernelPlanUpdatedResult> {
    return this.updatePlan("undoStep", "undo", sessionId, revision, page, options);
  }

  async inspectStep(
    sessionId: string,
    revision: number,
    stepId: string,
    page: RKernelPageWindow,
    inputSchema: readonly RColumnSchema[],
    outputSchema: readonly RColumnSchema[],
    options: RKernelRequestOptions = {}
  ): Promise<RKernelStepInspectionResult> {
    const started = performance.now();
    const timeoutMs = requestTimeout(options.timeoutMs);
    const remainingOptions = (): RKernelRequestOptions => ({
      ...options,
      timeoutMs: Math.floor(remainingTimeout(timeoutMs, started))
    });
    const infoRequest = this.request("inspectStepInfo", { sessionId, revision, stepId });
    encodeRKernelRequest(infoRequest);
    const info = await this.executeMappedRequest(sessionId, infoRequest, remainingOptions());
    if (info.kind === "error") throw new RKernelDiagnosticError(info);
    if (
      info.kind !== "stepInspectionInfo" ||
      info.sessionId !== sessionId ||
      info.stepId !== stepId ||
      info.revision !== revision
    ) {
      throw new Error("The R kernel returned mismatched applied-step inspection metadata.");
    }
    const inspectPage = async (side: "input" | "output") => {
      const request = this.request("inspectStepPage", { sessionId, revision, stepId, side, page });
      encodeRKernelRequest(request);
      const response = await this.executeMappedRequest(sessionId, request, remainingOptions(), {
        inputSchema,
        outputSchema,
        inspectionSide: side
      });
      if (response.kind === "error") throw new RKernelDiagnosticError(response);
      if (
        response.kind !== "stepInspectionPage" ||
        response.sessionId !== sessionId ||
        response.stepId !== stepId ||
        response.revision !== revision ||
        response.side !== side
      ) {
        throw new Error("The R kernel returned a mismatched applied-step inspection page.");
      }
      return response;
    };
    const input = await inspectPage("input");
    const output = await inspectPage("output");
    if (info.stepIndex !== input.stepIndex || info.stepIndex !== output.stepIndex) {
      throw new Error("The R kernel returned mismatched applied-step inspection pages.");
    }
    return Object.freeze({
      sessionId,
      revision: output.revision,
      stepId: output.stepId,
      stepIndex: output.stepIndex,
      inputPage: input.page,
      outputPage: output.page,
      inputSchema,
      outputSchema,
      code: info.code
    });
  }

  async close(sessionId: string, options: RKernelRequestOptions = {}): Promise<void> {
    this.assertActive();
    if (this.retiredSessionIds.has(sessionId)) return;
    const kernel = this.requireMappedKernel(sessionId);
    await this.closeMappedSession(sessionId, kernel, requestTimeout(options.timeoutMs), options.cancellation);
  }

  async closeAll(): Promise<void> {
    this.assertActive();
    await this.closeMappedSessions();
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true;
      this.disposal = this.disposeOnce();
    }
    return this.disposal;
  }

  isSessionMapped(sessionId: string): boolean {
    return this.sessionKernels.has(sessionId);
  }

  private async executeMappedRequest(
    sessionId: string,
    request: Extract<
      RKernelRequest,
      {
        kind:
          | "getPage"
          | "getSummary"
          | "getDatasetStats"
          | "getColumnValues"
          | "previewStep"
          | "applyDraft"
          | "discardDraft"
          | "undoStep"
          | "inspectStepInfo"
          | "inspectStepPage"
          | "exportData"
          | "readDataExport";
      }
    >,
    options: RKernelRequestOptions,
    decodeContext?: RKernelResponseDecodeContext
  ): Promise<RKernelResponse> {
    this.assertActive();
    const started = performance.now();
    const timeoutMs = requestTimeout(options.timeoutMs);
    const kernel = this.requireMappedKernel(sessionId);
    const acquired = this.requireObservation(kernel);
    const preflight = this.assertKernelStillSelected(acquired);
    void preflight.catch(() => undefined);
    await withKernelTimeout(preflight, timeoutMs, () => undefined, options.cancellation);
    await this.waitForKernelSettlement(kernel, timeoutMs, started, options.cancellation);
    const settlementPostflight = this.assertKernelStillSelected(acquired);
    void settlementPostflight.catch(() => undefined);
    await withKernelTimeout(
      settlementPostflight,
      remainingTimeout(timeoutMs, started),
      () => undefined,
      options.cancellation
    );
    assertDispatchAllowed(options.cancellation, remainingTimeout(timeoutMs, started));
    const completion = this.executeRequest(kernel, request, decodeContext);
    void completion.catch(() => undefined);
    let detachedReason: DetachedBridgeRequestReason | undefined;
    let response: RKernelResponse;
    try {
      response = await withKernelTimeout(
        completion,
        remainingTimeout(timeoutMs, started),
        () => {
          detachedReason = "timeout";
        },
        options.cancellation,
        () => {
          detachedReason = "cancellation";
        }
      );
    } catch (error) {
      if (!detachedReason) throw error;
      const detached = new DetachedBridgeRequestError(
        detachedRequestMessage(detachedReason, timeoutMs),
        detachedReason,
        true,
        observeSettlement(completion)
      );
      this.installKernelSettlementBarrier(kernel, detached.settlement);
      throw detached;
    }
    // Once an edit returns its own decoded response, the R session may already
    // have advanced. A later selection lookup, cancellation, or host disposal
    // must not hide that result and leave the coordinator at a stale revision.
    if (isRMutationRequest(request)) return response;
    const postflight = this.assertKernelStillSelected(acquired);
    void postflight.catch(() => undefined);
    await withKernelTimeout(postflight, remainingTimeout(timeoutMs, started), () => undefined, options.cancellation);
    this.assertActive();
    return response;
  }

  private async updatePlan(
    kind: "applyDraft" | "discardDraft" | "undoStep",
    expectedAction: RKernelPlanUpdatedResult["action"],
    sessionId: string,
    revision: number,
    page: RKernelPageWindow,
    options: RKernelRequestOptions
  ): Promise<RKernelPlanUpdatedResult> {
    const request = this.request(kind, { sessionId, revision, page });
    encodeRKernelRequest(request);
    const response = await this.executeMappedRequest(sessionId, request, options);
    if (response.kind === "error") throw new RKernelDiagnosticError(response);
    if (
      response.kind !== "planUpdated" ||
      response.sessionId !== sessionId ||
      response.action !== expectedAction ||
      response.revision !== revision + 1
    ) {
      throw new Error("The R kernel returned a mismatched cleaning-plan update.");
    }
    return Object.freeze({
      sessionId,
      action: response.action,
      revision: response.revision,
      page: response.page,
      code: response.code
    });
  }

  private async closeMappedSession(
    sessionId: string,
    kernel: Kernel,
    timeoutMs: number,
    cancellation?: KernelCancellationLike
  ): Promise<void> {
    const started = performance.now();
    await this.waitForKernelSettlement(kernel, timeoutMs, started, cancellation);
    if (this.sessionKernels.get(sessionId) !== kernel) {
      if (this.retiredSessionIds.has(sessionId)) return;
      throw new Error(`Open Wrangler no longer owns R kernel session ${sessionId}.`);
    }
    assertDispatchAllowed(cancellation, remainingTimeout(timeoutMs, started));
    const completion = this.executeRequest(kernel, this.request("closeSession", { sessionId })).then((response) => {
      if (isCorrelatedClose(response, sessionId)) this.retireSession(sessionId, kernel);
      return response;
    });
    void completion.catch(() => undefined);
    let detachedReason: DetachedBridgeRequestReason | undefined;
    let response: RKernelResponse;
    try {
      response = await withKernelTimeout(
        completion,
        remainingTimeout(timeoutMs, started),
        () => {
          detachedReason = "timeout";
        },
        cancellation,
        () => {
          detachedReason = "cancellation";
        }
      );
    } catch (error) {
      if (!detachedReason) throw error;
      const settlement = observeSettlement(completion);
      this.installKernelSettlementBarrier(kernel, settlement);
      throw new DetachedBridgeRequestError(
        detachedRequestMessage(detachedReason, timeoutMs),
        detachedReason,
        true,
        settlement
      );
    }
    if (response.kind === "error") {
      if (response.code === "unknown_session") return;
      throw new RKernelDiagnosticError(response);
    }
    if (response.kind !== "closed" || response.sessionId !== sessionId) {
      throw new Error("The R kernel returned a mismatched close session identity.");
    }
  }

  private async closeMappedDataExport(
    sessionId: string,
    revision: number,
    exportId: string,
    kernel: Kernel,
    timeoutMs: number
  ): Promise<void> {
    const started = performance.now();
    await this.waitForKernelSettlement(kernel, timeoutMs, started);
    if (invalidatesKernel(kernel.status)) {
      // A restarted or dead kernel has already discarded its process-local artifact.
      this.bootstrappedKernels.delete(kernel);
      return;
    }
    // Cleanup is bound to the exact kernel captured before export. A notebook
    // selection change removes the public session mapping but does not make a
    // still-running old kernel safe to ignore.
    if (!this.bootstrappedKernels.has(kernel)) return;
    assertDispatchAllowed(undefined, remainingTimeout(timeoutMs, started));
    const request = this.request("closeDataExport", { sessionId, revision, exportId });
    encodeRKernelRequest(request);
    const completion = this.executeRequest(kernel, request);
    void completion.catch(() => undefined);
    let detachedReason: DetachedBridgeRequestReason | undefined;
    let response: RKernelResponse;
    try {
      response = await withKernelTimeout(completion, remainingTimeout(timeoutMs, started), () => {
        detachedReason = "timeout";
      });
    } catch (error) {
      if (!detachedReason) throw error;
      const settlement = observeSettlement(completion);
      this.installKernelSettlementBarrier(kernel, settlement);
      throw new DetachedBridgeRequestError(
        detachedRequestMessage(detachedReason, timeoutMs),
        detachedReason,
        true,
        settlement
      );
    }
    if (response.kind === "error") {
      if (response.code === "unknown_session") return;
      throw new RKernelDiagnosticError(response);
    }
    if (
      response.kind !== "dataExportClosed" ||
      response.sessionId !== sessionId ||
      response.revision !== revision ||
      response.exportId !== exportId
    ) {
      throw new Error("The R kernel returned a mismatched data-export cleanup response.");
    }
  }

  private async recoverFromExportCleanupFailure(
    sessionId: string,
    kernel: Kernel,
    cleanupError: unknown
  ): Promise<void> {
    try {
      await this.closeExactKernelSessionAfterExportFailure(sessionId, kernel, DATA_EXPORT_CLEANUP_TIMEOUT_MS);
    } catch (terminalError) {
      this.deferredExportCleanupFailure = new AggregateError(
        [cleanupError, terminalError],
        "Open Wrangler could not close a private R notebook export or its exact kernel session."
      );
      this.invalidateAfterExportCleanupFailure(kernel);
    }
  }

  private async closeExactKernelSessionAfterExportFailure(
    sessionId: string,
    kernel: Kernel,
    timeoutMs: number
  ): Promise<void> {
    if (invalidatesKernel(kernel.status)) {
      this.bootstrappedKernels.delete(kernel);
      return;
    }
    const started = performance.now();
    await this.waitForKernelSettlement(kernel, timeoutMs, started);
    if (invalidatesKernel(kernel.status) || !this.bootstrappedKernels.has(kernel)) return;
    const completion = this.executeRequest(kernel, this.request("closeSession", { sessionId }));
    void completion.catch(() => undefined);
    let timedOut = false;
    let response: RKernelResponse;
    try {
      response = await withKernelTimeout(completion, remainingTimeout(timeoutMs, started), () => {
        timedOut = true;
      });
    } catch (error) {
      if (!timedOut) throw error;
      const settlement = observeSettlement(completion);
      this.installKernelSettlementBarrier(kernel, settlement);
      throw new DetachedBridgeRequestError(detachedRequestMessage("timeout", timeoutMs), "timeout", true, settlement);
    }
    if (!isCorrelatedClose(response, sessionId)) {
      if (response.kind === "error") throw new RKernelDiagnosticError(response);
      throw new Error("The R kernel returned a mismatched terminal export-cleanup response.");
    }
    this.retireSession(sessionId, kernel);
    this.invalidateAfterExportCleanupFailure(kernel);
  }

  private invalidateAfterExportCleanupFailure(kernel: Kernel): void {
    const observation = this.observation;
    if (!observation || observation.kernel !== kernel) return;
    this.invalidateKernel(observation);
    this.kernelInvalidatedEmitter.fire();
  }

  private async closeMappedSessions(): Promise<void> {
    const sessions = [...this.sessionKernels.keys()];
    const failures: unknown[] = [];
    for (const sessionId of sessions) {
      try {
        const kernel = this.sessionKernels.get(sessionId);
        if (!kernel) continue;
        if (this.failedOpenCleanupSessionIds.has(sessionId)) {
          failures.push(new Error(`Open Wrangler could not confirm cleanup of failed R kernel open ${sessionId}.`));
          continue;
        }
        await this.closeMappedSession(sessionId, kernel, DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Open Wrangler could not close every R kernel session.");
  }

  private async disposeOnce(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.openIdle;
      try {
        await this.closeMappedSessions();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.teardownRuntimeBindings();
      } catch (error) {
        failures.push(error);
      }
      if (this.deferredExportCleanupFailure !== undefined) failures.push(this.deferredExportCleanupFailure);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Open Wrangler could not finish R kernel cleanup.");
      }
    } finally {
      this.verifiedSelection?.dispose();
      this.invalidateKernel();
      this.kernelInvalidatedEmitter.dispose();
    }
  }

  private request<TKind extends RKernelRequest["kind"]>(
    kind: TKind,
    payload: Extract<RKernelRequest, { kind: TKind }>["payload"]
  ): Extract<RKernelRequest, { kind: TKind }> {
    return {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: this.createId(),
      kind,
      payload
    } as Extract<RKernelRequest, { kind: TKind }>;
  }

  private async acquireKernel(): Promise<KernelObservation> {
    this.assertActive();
    this.assertNotebookProvenance();
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before Open Wrangler accesses an R kernel.");
    if (this.verifiedSelection) return this.acquireVerifiedKernel(this.verifiedSelection);
    const extension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
    if (!extension) throw new Error("Install or enable the VS Code Jupyter extension to open R notebook dataframes.");
    const jupyter = await extension.activate();
    this.assertActive();
    this.assertNotebookProvenance();
    if (!isJupyter(jupyter)) throw new Error("Open Wrangler could not access the public Jupyter kernel API.");
    const kernel = await jupyter.kernels.getKernel(this.notebookUri);
    this.assertActive();
    this.assertNotebookProvenance();
    if (!isKernel(kernel)) {
      throw new Error(
        "Select or start an R kernel, run the cell that defines the dataframe, and choose Open in Open Wrangler again."
      );
    }
    if (kernel.language.toLowerCase() !== "r") {
      throw new Error(`Open Wrangler requires an R notebook kernel; the selected kernel uses ${kernel.language}.`);
    }
    return this.observeKernel({ kernel, jupyter });
  }

  private async acquireVerifiedKernel(binding: RNotebookKernelSelectionBinding): Promise<KernelObservation> {
    if (binding.notebook !== this.notebookDocument || binding.isInvalidated()) {
      throw new Error("The verified R notebook kernel changed before Open Wrangler opened the dataframe.");
    }
    const selected = await binding.jupyter.kernels.getKernel(this.notebookUri);
    this.assertActive();
    this.assertNotebookProvenance();
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before Open Wrangler accesses an R kernel.");
    if (binding.isInvalidated() || selected !== binding.kernel) {
      throw new Error("The verified R notebook kernel changed before Open Wrangler opened the dataframe.");
    }
    if (binding.kernel.language.toLowerCase() !== "r") {
      throw new Error(
        `Open Wrangler requires an R notebook kernel; the selected kernel uses ${binding.kernel.language}.`
      );
    }
    const acquired = this.observeKernel({ kernel: binding.kernel, jupyter: binding.jupyter });
    await this.assertKernelStillSelected(acquired);
    if (binding.isInvalidated()) {
      this.invalidateKernel(acquired);
      this.kernelInvalidatedEmitter.fire();
      throw new Error("The verified R notebook kernel restarted before Open Wrangler opened the dataframe.");
    }
    return acquired;
  }

  private observeKernel(acquired: KernelObservation): KernelObservation {
    this.assertActive();
    const existing = this.observation;
    if (existing?.kernel === acquired.kernel) return existing;
    if (existing) {
      this.invalidateKernel(existing);
      this.kernelInvalidatedEmitter.fire();
    }
    this.observation = acquired;
    const subscription = acquired.kernel.onDidChangeStatus((status) => {
      if (this.observation !== acquired || !invalidatesKernel(status)) return;
      this.invalidateKernel(acquired);
      this.kernelInvalidatedEmitter.fire();
    });
    acquired.subscription = subscription;
    if (this.observation !== acquired) {
      subscription.dispose();
      throw new Error("The R kernel changed while Open Wrangler registered its lifecycle observer.");
    }
    if (invalidatesKernel(acquired.kernel.status)) {
      this.invalidateKernel(acquired);
      throw new Error(`Open Wrangler cannot use the R kernel while its status is ${acquired.kernel.status}.`);
    }
    return acquired;
  }

  private async ensureBootstrapped(acquired: KernelObservation): Promise<void> {
    this.assertActive();
    let bootstrap = this.bootstrapPromises.get(acquired.kernel);
    if (!bootstrap) {
      bootstrap = (async () => {
        await this.executeKernelText(acquired.kernel, this.bootstrapCode);
        this.bootstrappedKernels.add(acquired.kernel);
        this.assertActive();
        this.assertNotebookProvenance();
        if (this.observation !== acquired) throw new Error("The R kernel changed during runtime bootstrap.");
      })();
      this.bootstrapPromises.set(acquired.kernel, bootstrap);
      void bootstrap.catch(() => {
        if (this.bootstrapPromises.get(acquired.kernel) === bootstrap) this.bootstrapPromises.delete(acquired.kernel);
      });
    }
    await bootstrap;
    this.assertActive();
  }

  private async teardownRuntimeBindings(): Promise<void> {
    const kernels = [...this.bootstrappedKernels];
    const failures: unknown[] = [];
    for (const kernel of kernels) {
      try {
        await this.executeKernelText(kernel, this.teardownCode);
        this.bootstrappedKernels.delete(kernel);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Open Wrangler could not remove every private R kernel runtime binding.");
    }
  }

  private async assertKernelStillSelected(acquired: KernelObservation): Promise<void> {
    this.assertActive();
    if (this.observation !== acquired) throw new Error("The R kernel generation changed before request dispatch.");
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before Open Wrangler accesses an R kernel.");
    this.assertNotebookProvenance();
    const selected = await acquired.jupyter.kernels.getKernel(this.notebookUri);
    this.assertActive();
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before Open Wrangler accesses an R kernel.");
    this.assertNotebookProvenance();
    if (this.observation !== acquired) throw new Error("The R kernel generation changed before request dispatch.");
    if (selected === acquired.kernel) return;
    this.invalidateKernel(acquired);
    this.kernelInvalidatedEmitter.fire();
    throw new Error("The selected R notebook kernel changed before Open Wrangler dispatched its request.");
  }

  private async executeRequest(
    kernel: Kernel,
    request: RKernelRequest,
    decodeContext?: RKernelResponseDecodeContext
  ): Promise<RKernelResponse> {
    const payload = encodeRKernelRequest(request);
    const marker = request.requestId.replaceAll("-", "");
    const output = await this.executeKernelText(kernel, buildRKernelDispatchCode(payload, marker));
    return decodeRKernelResponseJson(parseMarkedResponse(output, marker), request.requestId, decodeContext);
  }

  private async executeKernelText(kernel: Kernel, code: string): Promise<string> {
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      // Jupyter maps token cancellation to a whole-kernel interrupt. Host
      // deadlines detach their waiter; they never interrupt unrelated R work.
      return await kernelOutputsToText(
        kernel.executeCode(code, tokenSource.token),
        R_KERNEL_MAX_RESPONSE_BYTES + 64 * 1_024
      );
    } finally {
      tokenSource.dispose();
    }
  }

  private installKernelSettlementBarrier(kernel: Kernel, settlement: Promise<void>): void {
    const preceding = this.kernelSettlementBarriers.get(kernel) ?? Promise.resolve();
    const barrier = preceding.then(
      () => settlement,
      () => settlement
    );
    this.kernelSettlementBarriers.set(kernel, barrier);
    void barrier.then(() => {
      if (this.kernelSettlementBarriers.get(kernel) === barrier) this.kernelSettlementBarriers.delete(kernel);
    });
  }

  private async waitForKernelSettlement(
    kernel: Kernel,
    timeoutMs: number,
    started: number,
    cancellation?: KernelCancellationLike
  ): Promise<void> {
    while (true) {
      const barrier = this.kernelSettlementBarriers.get(kernel);
      if (!barrier) return;
      let detachedReason: DetachedBridgeRequestReason | undefined;
      try {
        await withKernelTimeout(
          barrier,
          remainingTimeout(timeoutMs, started),
          () => {
            detachedReason = "timeout";
          },
          cancellation,
          () => {
            detachedReason = "cancellation";
          }
        );
      } catch (error) {
        if (!detachedReason) throw error;
        throw new DetachedBridgeRequestError(
          detachedRequestMessage(detachedReason, timeoutMs),
          detachedReason,
          false,
          barrier
        );
      }
    }
  }

  private cleanupAfterOpenSettlement(
    sessionId: string,
    kernel: Kernel,
    completion: Promise<RKernelResponse>
  ): Promise<void> {
    return observeSettlement(completion)
      .then(() => this.cleanupFailedOpen(sessionId, kernel))
      .then(() => undefined);
  }

  private cleanupFailedOpen(sessionId: string, kernel: Kernel): Promise<boolean> {
    let completion = this.cleanupAttempts.get(kernel)?.get(sessionId);
    if (!completion) {
      this.failedOpenCleanupSessionIds.add(sessionId);
      const attempt = this.performFailedOpenCleanup(sessionId, kernel);
      completion = attempt;
      this.rememberCleanupAttempt(kernel, sessionId, attempt);
      const forget = () => this.forgetCleanupAttempt(kernel, sessionId, attempt);
      void attempt.then(forget, forget);
    }
    return waitForFailedOpenCleanup(completion);
  }

  private rememberCleanupAttempt(kernel: Kernel, sessionId: string, attempt: Promise<boolean>): void {
    const attempts = this.cleanupAttempts.get(kernel) ?? new Map<string, Promise<boolean>>();
    while (attempts.size >= MAX_PENDING_CLEANUP_ATTEMPTS) {
      const oldest = attempts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      attempts.delete(oldest);
    }
    attempts.set(sessionId, attempt);
    this.cleanupAttempts.set(kernel, attempts);
  }

  private forgetCleanupAttempt(kernel: Kernel, sessionId: string, attempt: Promise<boolean>): void {
    const attempts = this.cleanupAttempts.get(kernel);
    if (attempts?.get(sessionId) !== attempt) return;
    attempts.delete(sessionId);
    if (attempts.size === 0) this.cleanupAttempts.delete(kernel);
  }

  private async performFailedOpenCleanup(sessionId: string, kernel: Kernel): Promise<boolean> {
    try {
      const response = await this.executeRequest(kernel, this.request("closeSession", { sessionId }));
      const confirmedAbsent = isCorrelatedClose(response, sessionId);
      if (confirmedAbsent) this.retireSession(sessionId, kernel);
      return confirmedAbsent;
    } catch {
      return false;
    }
  }

  private requireMappedKernel(sessionId: string): Kernel {
    const kernel = this.sessionKernels.get(sessionId);
    if (!kernel) throw new Error(`Open Wrangler has no live R kernel session named ${sessionId}.`);
    return kernel;
  }

  private requireObservation(kernel: Kernel): KernelObservation {
    const observation = this.observation;
    if (!observation || observation.kernel !== kernel) throw new Error("The R kernel session is no longer active.");
    return observation;
  }

  private assertSessionIdentityAvailable(sessionId: string): void {
    if (this.sessionKernels.has(sessionId)) throw new Error(`The R kernel session ${sessionId} is already open.`);
    if (this.retiredSessionIds.has(sessionId)) throw new Error(`The R kernel session ${sessionId} is already retired.`);
  }

  private retireSession(sessionId: string, kernel: Kernel): void {
    if (this.sessionKernels.get(sessionId) !== kernel) return;
    this.sessionKernels.delete(sessionId);
    this.failedOpenCleanupSessionIds.delete(sessionId);
    this.rememberRetiredSessionId(sessionId);
  }

  private rememberRetiredSessionId(sessionId: string): void {
    this.retiredSessionIds.add(sessionId);
    while (this.retiredSessionIds.size > MAX_RETIRED_SESSION_IDS) {
      const oldest = this.retiredSessionIds.values().next().value as string | undefined;
      if (oldest === undefined) return;
      this.retiredSessionIds.delete(oldest);
    }
  }

  private invalidateKernel(expected?: KernelObservation): void {
    const observation = this.observation;
    if (!observation || (expected && observation !== expected)) return;
    this.observation = undefined;
    observation.subscription?.dispose();
    this.bootstrapPromises.delete(observation.kernel);
    // A restarting or dead kernel has already discarded its process-local
    // globals. Trying to execute teardown against it would turn normal kernel
    // recovery into a cleanup failure.
    if (invalidatesKernel(observation.kernel.status)) {
      this.bootstrappedKernels.delete(observation.kernel);
    }
    for (const [sessionId, kernel] of this.sessionKernels) {
      if (kernel === observation.kernel) {
        this.sessionKernels.delete(sessionId);
        this.failedOpenCleanupSessionIds.delete(sessionId);
        this.rememberRetiredSessionId(sessionId);
      }
    }
  }

  private assertNotebookProvenance(): void {
    if (!isSoleOpenNotebookDocument(this.notebookDocument)) {
      throw new Error("The notebook that originated this R session is no longer the sole open document for its URI.");
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("The R kernel transport is disposed.");
  }

  private beginOpen(): void {
    if (this.activeOpens === 0) {
      this.openIdle = new Promise<void>((resolve) => {
        this.resolveOpenIdle = resolve;
      });
    }
    this.activeOpens += 1;
  }

  private endOpen(): void {
    this.activeOpens -= 1;
    if (this.activeOpens !== 0) return;
    const resolve = this.resolveOpenIdle;
    this.resolveOpenIdle = undefined;
    resolve?.();
  }
}

function isRMutationRequest(request: RKernelRequest): boolean {
  return (
    request.kind === "previewStep" ||
    request.kind === "applyDraft" ||
    request.kind === "discardDraft" ||
    request.kind === "undoStep"
  );
}

async function waitForFailedOpenCleanup(completion: Promise<boolean>): Promise<boolean> {
  try {
    return await withKernelTimeout(completion, FAILED_OPEN_CLOSE_TIMEOUT_MS, () => undefined);
  } catch {
    return false;
  }
}

function isCorrelatedClose(response: RKernelResponse, sessionId: string): boolean {
  return (
    (response.kind === "closed" && response.sessionId === sessionId) ||
    (response.kind === "error" && response.code === "unknown_session")
  );
}

function parseMarkedResponse(output: string, marker: string): string {
  const start = `__OPEN_WRANGLER_R_START_${marker}__`;
  const end = `__OPEN_WRANGLER_R_END_${marker}__`;
  const startIndex = output.indexOf(start);
  const secondStart = output.indexOf(start, startIndex + start.length);
  const endIndex = output.indexOf(end, startIndex + start.length);
  const secondEnd = output.indexOf(end, endIndex + end.length);
  if (startIndex < 0 || endIndex <= startIndex || secondStart >= 0 || secondEnd >= 0) {
    throw new Error("Open Wrangler could not parse the R kernel response markers.");
  }
  return output.slice(startIndex + start.length, endIndex).trim();
}

function invalidatesKernel(status: KernelStatus): boolean {
  return status === "restarting" || status === "autorestarting" || status === "terminating" || status === "dead";
}

function requestTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2_147_483_647)
    throw new TypeError("R kernel timeout is outside the supported integer range.");
  return timeout;
}

function remainingTimeout(timeoutMs: number, started: number): number {
  return Math.max(0, timeoutMs - (performance.now() - started));
}

function assertDispatchAllowed(cancellation: KernelCancellationLike | undefined, remainingMs: number): void {
  if (cancellation?.isCancellationRequested) throw new KernelRequestCancelledError();
  if (remainingMs <= 0) throw new Error("Open Wrangler R kernel request timed out before dispatch.");
}

function detachedRequestMessage(reason: DetachedBridgeRequestReason, timeoutMs: number): string {
  return reason === "timeout"
    ? `Open Wrangler stopped waiting after ${timeoutMs} ms; the R kernel request is still finishing.`
    : "Open Wrangler stopped waiting after host cancellation; the R kernel request is still finishing.";
}

function observeSettlement(work: Promise<unknown>): Promise<void> {
  return work.then(
    () => undefined,
    () => undefined
  );
}

function isJupyter(value: unknown): value is Jupyter {
  if (typeof value !== "object" || value === null) return false;
  const kernels = (value as { kernels?: unknown }).kernels;
  return (
    typeof kernels === "object" &&
    kernels !== null &&
    typeof (kernels as { getKernel?: unknown }).getKernel === "function"
  );
}

function isKernel(value: unknown): value is Kernel {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { executeCode?: unknown; language?: unknown; onDidChangeStatus?: unknown };
  return (
    typeof candidate.executeCode === "function" &&
    typeof candidate.language === "string" &&
    typeof candidate.onDidChangeStatus === "function"
  );
}
