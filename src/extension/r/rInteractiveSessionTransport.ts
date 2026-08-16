import { randomUUID } from "node:crypto";
import { watch, type BigIntStats, type FSWatcher } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import type { ColumnSummary, ValueCount } from "../../shared/protocol";
import { DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS } from "../configuration";
import { DetachedBridgeRequestError, type DetachedBridgeRequestReason } from "../dataBridge";
import { KernelRequestCancelledError, withKernelTimeout } from "../notebooks/kernelLifecycle";
import type { RKernelBridgeTransport } from "./rKernelBridge";
import {
  decodeRKernelResponseJson,
  encodeRKernelRequest,
  R_KERNEL_EXPORT_CHUNK_BYTES,
  R_KERNEL_MAX_REQUEST_BYTES,
  R_KERNEL_MAX_RESPONSE_BYTES,
  R_KERNEL_TRANSPORT_VERSION,
  type RKernelColumnReference,
  type RKernelDataExportResult,
  type RKernelDatasetStatsResult,
  type RKernelExportFormat,
  type RKernelPageWindow,
  type RKernelPlanUpdatedResult,
  type RKernelRequest,
  type RKernelResponse,
  type RKernelResponseDecodeContext,
  type RKernelStepInspectionResult,
  type RKernelStepPreviewResult,
  type RKernelTransformStep,
  type RKernelViewQuery
} from "./rKernelProtocol";
import { RKernelDiagnosticError, type RKernelOpenResult, type RKernelRequestOptions } from "./rKernelTransport";
import type { RColumnSchema, RDataframeFlavor, RFramePageContract } from "./rFrameContract";
import type { RProcessVariableDescriptor, RProcessVariableDiscovery } from "./rProcessTransport";
import { buildRInteractiveDispatchCode, rInteractiveRuntimeBundleId } from "./rInteractiveRuntime";
import {
  createNodeRPrivateArtifactOperations,
  readRPrivateArtifact,
  rPrivateArtifactFailureRequiresContainerPreservation,
  type RPrivateArtifactOperations
} from "./rPrivateArtifactBoundary";

const INTERACTIVE_PROTOCOL_VERSION = 1;
const RESPONSE_POLL_MS = 20;
const MAX_DISCOVERY_BYTES = 64 * 1_024;
const MAX_EVALUATION_CODE_BYTES = 1_024 * 1_024;
const MAX_WORKING_DIRECTORY_BYTES = 32 * 1_024;
const MAX_DISCOVERY_VARIABLES = 256;
const MAX_VARIABLE_NAME_BYTES = 1_024;
const MAX_RETIRED_SESSION_IDS = 1_024;
const DISPOSAL_SETTLEMENT_MS = 5_000;
const DATA_EXPORT_CLEANUP_TIMEOUT_MS = 5_000;
const TERMINAL_CHANGED_MESSAGE = "The active R terminal changed.";

export interface RInteractiveSessionTransportOptions {
  readonly temporaryParent?: string;
  readonly createId?: () => string;
  /** Test seam; production sends through the exact terminal created by the official R extension. */
  readonly runSelection?: (code: string) => Promise<unknown>;
  /** Test seam for exercising the production process handshake against a real child R process. */
  readonly testProcessId?: number;
  /** Test seam for deterministic cleanup-failure coverage. */
  readonly removeFile?: (filePath: string) => Promise<void>;
  /** Test seam for bounded disposal coverage. */
  readonly disposalSettlementMs?: number;
  /** Test seam for bounded data-export cleanup coverage. */
  readonly dataExportCleanupTimeoutMs?: number;
  /** Bind only to the currently active official R terminal, or create one when none is available. */
  readonly terminalMode?: "active" | "activeOrCreate";
  /** Exact official R terminal captured by the caller before any asynchronous work. */
  readonly terminal?: vscode.Terminal;
}

interface InteractiveMailbox {
  readonly root: string;
  readonly requests: string;
  readonly responses: string;
  readonly notificationPath: string;
  readonly notificationSentinelPath: string;
  readonly attachmentPath: string;
  readonly notificationWatcher: FSWatcher;
  readonly identity: BigIntStats;
}

interface ScheduledRequest<T> {
  readonly completion: Promise<T>;
  readonly state: {
    dispatched: boolean;
    abandonBeforeDispatch: boolean;
  };
}

interface RInteractiveEvaluationOptions extends RKernelRequestOptions {
  readonly workingDirectory?: string;
  /** Revalidated synchronously at the final boundary before terminal dispatch. */
  readonly isRequestCurrent?: () => boolean;
}

/**
 * Runs the shared native-R agent inside the official R extension's active
 * interactive terminal. The public R command carries only a short dispatcher;
 * request and response JSON travel through a private, bounded mailbox.
 */
export class RInteractiveSessionTransport implements RKernelBridgeTransport {
  private readonly runtimeRoot: string;
  private readonly runtimeBundleId: string;
  private readonly ownerToken: string;
  private readonly notificationRequestId: string;
  private readonly attachmentNonce: string;
  private readonly createId: () => string;
  private readonly prepareSelectionTarget: () => Promise<number | undefined>;
  private readonly verifySelectionTarget: (expectedProcessId: number | undefined) => Promise<void>;
  private readonly dispatchSelection: (code: string) => unknown;
  private readonly terminalCloseSubscription: vscode.Disposable | undefined;
  private readonly temporaryParent: string;
  private readonly removeFile: (filePath: string) => Promise<void>;
  private readonly artifactOperations: RPrivateArtifactOperations;
  private readonly disposalSettlementMs: number;
  private readonly dataExportCleanupTimeoutMs: number;
  private readonly terminalMode: "active" | "activeOrCreate";
  private readonly invalidatedEmitter = new vscode.EventEmitter<void>();
  private readonly variablesChangedEmitter = new vscode.EventEmitter<RProcessVariableDiscovery>();
  readonly onDidInvalidateKernel = this.invalidatedEmitter.event;
  readonly onDidChangeVariables = this.variablesChangedEmitter.event;

  private mailboxPromise: Promise<InteractiveMailbox> | undefined;
  private mailbox: InteractiveMailbox | undefined;
  private queueTail: Promise<void> = Promise.resolve();
  private readonly mappedSessions = new Set<string>();
  private readonly openingSessions = new Set<string>();
  private readonly abandonedOpenSessions = new Set<string>();
  private readonly retiredSessions = new Set<string>();
  private runtimeLoaded = false;
  private terminalClaimed = false;
  private dispatcherLoaded = false;
  private attachmentVerified = false;
  private boundTerminal: vscode.Terminal | undefined;
  private readonly terminalAmbiguousAtCreation: boolean;
  private terminalUnavailable = false;
  private stopping = false;
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private terminalCleanup: Promise<void> | undefined;
  private hostCleanup: Promise<void> | undefined;
  private readonly artifactCleanupFailures: unknown[] = [];
  private readonly exportCleanupFailures: unknown[] = [];
  private readonly activeExportWork = new Set<Promise<unknown>>();
  private invalidationPublished = false;
  private notificationReadTimer: NodeJS.Timeout | undefined;
  private notificationReadTail: Promise<void> = Promise.resolve();
  private mailboxCleanupSafe = true;

  constructor(context: vscode.ExtensionContext, options: RInteractiveSessionTransportOptions = {}) {
    this.runtimeRoot = path.join(context.extensionPath, "r");
    this.runtimeBundleId = rInteractiveRuntimeBundleId(this.runtimeRoot);
    this.ownerToken = `interactive-${randomUUID()}`;
    this.createId = options.createId ?? randomUUID;
    this.notificationRequestId = this.createId();
    this.attachmentNonce = this.createId();
    this.temporaryParent = options.temporaryParent ?? tmpdir();
    this.removeFile = options.removeFile ?? unlink;
    this.artifactOperations = createNodeRPrivateArtifactOperations(this.removeFile);
    this.disposalSettlementMs = options.disposalSettlementMs ?? DISPOSAL_SETTLEMENT_MS;
    this.dataExportCleanupTimeoutMs = options.dataExportCleanupTimeoutMs ?? DATA_EXPORT_CLEANUP_TIMEOUT_MS;
    this.terminalMode = options.terminalMode ?? "activeOrCreate";
    if (!path.isAbsolute(this.runtimeRoot)) throw new TypeError("The bundled R runtime path must be absolute.");
    if (!path.isAbsolute(this.temporaryParent)) {
      throw new TypeError("The R interactive temporary parent must be absolute.");
    }
    if (!Number.isSafeInteger(this.disposalSettlementMs) || this.disposalSettlementMs < 1) {
      throw new TypeError("The R interactive disposal timeout must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.dataExportCleanupTimeoutMs) || this.dataExportCleanupTimeoutMs < 1) {
      throw new TypeError("The R interactive export cleanup timeout must be a positive integer.");
    }
    if (options.runSelection) {
      this.terminalAmbiguousAtCreation = false;
      if (
        options.testProcessId !== undefined &&
        (!Number.isSafeInteger(options.testProcessId) || options.testProcessId < 1)
      ) {
        throw new TypeError("The test R process identity must be a positive integer.");
      }
      this.prepareSelectionTarget = () => Promise.resolve(options.testProcessId);
      this.verifySelectionTarget = async (expectedProcessId) => {
        if (expectedProcessId !== options.testProcessId) {
          throw new Error("The selected R terminal process changed during attachment.");
        }
      };
      this.dispatchSelection = options.runSelection;
      this.terminalCloseSubscription = undefined;
    } else {
      if (options.testProcessId !== undefined) {
        throw new TypeError("The test R process identity is available only with the injected selection seam.");
      }
      const captured = captureRSelectionTarget(this.terminalMode, options.terminal);
      this.boundTerminal = captured.terminal;
      this.terminalAmbiguousAtCreation = captured.ambiguous;
      this.prepareSelectionTarget = () => this.ensureBoundTerminal();
      this.verifySelectionTarget = (expectedProcessId) => this.verifyBoundTerminal(expectedProcessId);
      this.dispatchSelection = (code) => this.sendSelectionToBoundTerminal(code);
      this.terminalCloseSubscription = vscode.window.onDidCloseTerminal((terminal) => {
        if (terminal !== this.boundTerminal) return;
        this.publishInvalidation(true);
      });
    }
  }

  async discoverVariables(options: RKernelRequestOptions = {}): Promise<RProcessVariableDiscovery> {
    this.assertActive();
    const requestId = this.createId();
    const request = Object.freeze({
      protocolVersion: INTERACTIVE_PROTOCOL_VERSION,
      requestId,
      kind: "discoverInteractiveVariables"
    });
    const payload = JSON.stringify(request);
    const scheduled = this.schedule(requestId, payload, MAX_DISCOVERY_BYTES, (response) =>
      decodeDiscoveryResponse(response, requestId)
    );
    try {
      return await this.waitForScheduled(scheduled, options);
    } catch (error) {
      if (isTerminalChangedError(error)) this.publishInvalidation();
      throw error;
    }
  }

  async evaluateAndDiscoverVariables(
    code: string,
    options: RInteractiveEvaluationOptions = {}
  ): Promise<RProcessVariableDiscovery> {
    this.assertActive();
    if (typeof code !== "string" || code.length === 0 || Buffer.byteLength(code, "utf8") > MAX_EVALUATION_CODE_BYTES) {
      throw new TypeError("The R code chunk must contain between 1 byte and 1 MiB of UTF-8 text.");
    }
    const { workingDirectory, isRequestCurrent } = options;
    if (
      workingDirectory !== undefined &&
      (!isBoundedText(workingDirectory, MAX_WORKING_DIRECTORY_BYTES) || !path.isAbsolute(workingDirectory))
    ) {
      throw new TypeError("The R chunk working directory must be an absolute path of at most 32 KiB.");
    }
    const requestId = this.createId();
    const request = Object.freeze({
      protocolVersion: INTERACTIVE_PROTOCOL_VERSION,
      requestId,
      kind: "evaluateAndDiscoverInteractiveVariables",
      code,
      ...(workingDirectory ? { workingDirectory } : {})
    });
    const payload = JSON.stringify(request);
    const scheduled = this.schedule(
      requestId,
      payload,
      MAX_DISCOVERY_BYTES,
      (response) => decodeDiscoveryResponse(response, requestId),
      false,
      isRequestCurrent
    );
    try {
      return await this.waitForScheduled(scheduled, options);
    } catch (error) {
      if (isTerminalChangedError(error)) this.publishInvalidation();
      throw error;
    }
  }

  async open(
    variableName: string,
    page: RKernelPageWindow,
    options: RKernelRequestOptions = {}
  ): Promise<RKernelOpenResult> {
    this.assertActive();
    const sessionId = options.requestedSessionId ?? this.createId();
    this.assertSessionIdentityAvailable(sessionId);
    const request = this.request("openSession", { sessionId, variableName, page });
    this.openingSessions.add(sessionId);
    const scheduled = this.scheduleKernel(request, { expectExportFormats: true });
    const tracked: ScheduledRequest<RKernelResponse> = {
      state: scheduled.state,
      completion: scheduled.completion.then((response) => {
        if (response.kind === "page" && response.sessionId === sessionId) {
          this.runtimeLoaded = true;
          this.mappedSessions.add(sessionId);
        }
        return response;
      })
    };
    try {
      const response = await this.waitForScheduled(tracked, options);
      if (response.kind === "error") throw new RKernelDiagnosticError(response);
      if (response.kind !== "page" || response.sessionId !== sessionId) {
        throw new Error("The interactive R session returned a mismatched session identity.");
      }
      if (!response.exportFormats) {
        throw new Error("The interactive R session did not report its export capabilities.");
      }
      return Object.freeze({ sessionId, exportFormats: response.exportFormats, page: response.page });
    } catch (error) {
      if (error instanceof DetachedBridgeRequestError && error.dispatched) {
        this.abandonedOpenSessions.add(sessionId);
        const cleanup = error.settlement.then(() => this.cleanupAbandonedOpen(sessionId, true));
        throw new DetachedBridgeRequestError(error.message, error.reason, true, cleanup);
      }
      await this.cleanupAbandonedOpen(sessionId, tracked.state.dispatched);
      throw error;
    } finally {
      this.openingSessions.delete(sessionId);
    }
  }

  async getPage(
    sessionId: string,
    page: RKernelPageWindow,
    options: RKernelRequestOptions = {}
  ): Promise<RFramePageContract> {
    const response = await this.executeMapped(this.request("getPage", { sessionId, page }), options);
    if (response.kind === "error") throw new RKernelDiagnosticError(response);
    if (response.kind !== "page" || response.sessionId !== sessionId) {
      throw new Error("The interactive R session returned a mismatched page identity.");
    }
    return response.page;
  }

  async getSummary(
    sessionId: string,
    columns: readonly RKernelColumnReference[],
    view: RKernelViewQuery,
    options: RKernelRequestOptions = {}
  ): Promise<readonly ColumnSummary[]> {
    const response = await this.executeMapped(this.request("getSummary", { sessionId, columns, view }), options);
    if (response.kind === "error") throw new RKernelDiagnosticError(response);
    if (response.kind !== "summary" || response.sessionId !== sessionId) {
      throw new Error("The interactive R session returned mismatched column summaries.");
    }
    return response.summaries;
  }

  async getDatasetStats(
    sessionId: string,
    view: RKernelViewQuery,
    options: RKernelRequestOptions = {}
  ): Promise<RKernelDatasetStatsResult> {
    const response = await this.executeMapped(this.request("getDatasetStats", { sessionId, view }), options);
    if (response.kind === "error") throw new RKernelDiagnosticError(response);
    if (response.kind !== "datasetStats" || response.sessionId !== sessionId) {
      throw new Error("The interactive R session returned mismatched dataset statistics.");
    }
    return Object.freeze({ totalRows: response.totalRows, stats: response.stats });
  }

  async getColumnValues(
    sessionId: string,
    column: RKernelColumnReference,
    view: RKernelViewQuery,
    search: string | undefined,
    limit: number,
    options: RKernelRequestOptions = {}
  ): Promise<Readonly<{ column: string; values: readonly ValueCount[]; hasMore: boolean; sampleSize?: number }>> {
    const response = await this.executeMapped(
      this.request("getColumnValues", { sessionId, column, view, search: search ?? null, limit }),
      options
    );
    if (response.kind === "error") throw new RKernelDiagnosticError(response);
    if (response.kind !== "columnValues" || response.sessionId !== sessionId) {
      throw new Error("The interactive R session returned mismatched column values.");
    }
    return Object.freeze({
      column: response.column,
      values: response.values,
      hasMore: response.hasMore,
      ...(response.sampleSize === undefined ? {} : { sampleSize: response.sampleSize })
    });
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
    const response = await this.executeMapped(
      this.request("previewStep", {
        sessionId,
        revision,
        step,
        page,
        ...(replaceStepId === undefined ? {} : { replaceStepId })
      }),
      options,
      { inputSchema, previewStep: step }
    );
    if (response.kind === "error") throw new RKernelDiagnosticError(response);
    if (response.kind !== "stepPreview" || response.sessionId !== sessionId || response.revision !== revision + 1) {
      this.publishInvalidation();
      throw new Error("The interactive R session returned a mismatched step preview.");
    }
    return Object.freeze({
      sessionId,
      revision: response.revision,
      page: response.page,
      diff: response.diff,
      code: response.code,
      ...(response.retainedStep === undefined ? {} : { retainedStep: response.retainedStep }),
      ...(response.effectiveView === undefined ? {} : { effectiveView: response.effectiveView }),
      ...(response.remainingMissingCells === undefined ? {} : { remainingMissingCells: response.remainingMissingCells })
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
    const startedAt = performance.now();
    const timeoutMs = requestTimeout(options.timeoutMs);
    const remainingOptions = (): RKernelRequestOptions => ({
      ...options,
      timeoutMs: Math.floor(remainingTimeout(timeoutMs, startedAt))
    });
    const info = await this.executeMapped(
      this.request("inspectStepInfo", { sessionId, revision, stepId }),
      remainingOptions()
    );
    if (info.kind === "error") throw new RKernelDiagnosticError(info);
    if (
      info.kind !== "stepInspectionInfo" ||
      info.sessionId !== sessionId ||
      info.stepId !== stepId ||
      info.revision !== revision
    ) {
      throw new Error("The interactive R session returned mismatched step inspection metadata.");
    }
    const inspectPage = async (side: "input" | "output") => {
      const response = await this.executeMapped(
        this.request("inspectStepPage", { sessionId, revision, stepId, side, page }),
        remainingOptions(),
        { inputSchema, outputSchema, inspectionSide: side }
      );
      if (response.kind === "error") throw new RKernelDiagnosticError(response);
      if (
        response.kind !== "stepInspectionPage" ||
        response.sessionId !== sessionId ||
        response.stepId !== stepId ||
        response.revision !== revision ||
        response.side !== side
      ) {
        throw new Error("The interactive R session returned a mismatched step inspection page.");
      }
      return response;
    };
    const input = await inspectPage("input");
    const output = await inspectPage("output");
    if (info.stepIndex !== input.stepIndex || info.stepIndex !== output.stepIndex) {
      throw new Error("The interactive R session returned mismatched step inspection pages.");
    }
    return Object.freeze({
      sessionId,
      revision,
      stepId,
      stepIndex: info.stepIndex,
      inputPage: input.page,
      outputPage: output.page,
      inputSchema,
      outputSchema,
      code: info.code
    });
  }

  exportData(
    sessionId: string,
    revision: number,
    format: RKernelExportFormat,
    writeChunk: (chunk: Uint8Array) => Promise<void>,
    options: RKernelRequestOptions = {}
  ): Promise<RKernelDataExportResult> {
    const work = this.exportDataOnce(sessionId, revision, format, writeChunk, options);
    return this.trackExportWork(work);
  }

  private async exportDataOnce(
    sessionId: string,
    revision: number,
    format: RKernelExportFormat,
    writeChunk: (chunk: Uint8Array) => Promise<void>,
    options: RKernelRequestOptions
  ): Promise<RKernelDataExportResult> {
    this.assertActive();
    if (typeof writeChunk !== "function") throw new TypeError("The R export chunk writer must be a function.");
    if (!this.mappedSessions.has(sessionId)) {
      throw new Error(`Open Wrangler has no live interactive R session ${sessionId}.`);
    }
    const exportId = this.createId();
    const startedAt = performance.now();
    const timeoutMs = requestTimeout(options.timeoutMs);
    const remainingOptions = (): RKernelRequestOptions => ({
      ...options,
      timeoutMs: Math.floor(remainingTimeout(timeoutMs, startedAt))
    });
    let failure: unknown;
    let result: RKernelDataExportResult | undefined;

    try {
      const ready = await this.executeMapped(
        this.request("exportData", { sessionId, revision, exportId, format }),
        remainingOptions()
      );
      if (ready.kind === "error") throw new RKernelDiagnosticError(ready);
      if (
        ready.kind !== "dataExported" ||
        ready.sessionId !== sessionId ||
        ready.revision !== revision ||
        ready.exportId !== exportId ||
        ready.format !== format
      ) {
        throw new Error("The interactive R session returned a mismatched data export.");
      }

      let offset = 0;
      while (offset < ready.bytes) {
        const limit = Math.min(R_KERNEL_EXPORT_CHUNK_BYTES, ready.bytes - offset);
        const chunk = await this.executeMapped(
          this.request("readDataExport", { sessionId, revision, exportId, offset, limit }),
          remainingOptions()
        );
        if (chunk.kind === "error") throw new RKernelDiagnosticError(chunk);
        if (
          chunk.kind !== "dataExportChunk" ||
          chunk.sessionId !== sessionId ||
          chunk.revision !== revision ||
          chunk.exportId !== exportId ||
          chunk.offset !== offset ||
          chunk.bytes < 1 ||
          chunk.bytes > limit ||
          chunk.data.byteLength !== chunk.bytes ||
          offset + chunk.bytes > ready.bytes
        ) {
          throw new Error("The interactive R session returned a mismatched data-export chunk.");
        }
        await writeChunk(chunk.data);
        offset += chunk.bytes;
      }
      if (offset !== ready.bytes) throw new Error("The interactive R session returned an incomplete data export.");
      result = Object.freeze({
        sessionId,
        revision,
        format,
        rows: ready.rows,
        columns: ready.columns
      });
    } catch (error) {
      if (error instanceof DetachedBridgeRequestError && error.dispatched) {
        const scheduledClose = this.scheduleExactDataExportClose(sessionId, revision, exportId);
        const cleanup = this.trackExportWork(
          error.settlement.then(async () => {
            try {
              await this.awaitExactDataExportClose(scheduledClose, sessionId, revision, exportId);
            } catch (cleanupError) {
              await this.recoverFromExportCleanupFailure(sessionId, cleanupError);
            }
          })
        );
        throw new DetachedBridgeRequestError(error.message, error.reason, true, cleanup);
      }
      failure = error;
    }

    try {
      const scheduledClose = this.scheduleExactDataExportClose(sessionId, revision, exportId);
      await this.awaitExactDataExportClose(scheduledClose, sessionId, revision, exportId);
    } catch (cleanupError) {
      await this.recoverFromExportCleanupFailure(sessionId, cleanupError);
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, cleanupError],
          "Interactive R export failed and its private terminal artifact could not be closed safely."
        );
      }
      throw cleanupError;
    }
    if (failure !== undefined) throw failure;
    if (!result) throw new Error("The interactive R session did not return a completed data export.");
    return result;
  }

  async close(sessionId: string, options: RKernelRequestOptions = {}): Promise<void> {
    if (this.retiredSessions.has(sessionId)) return;
    this.assertActive();
    if (!this.mappedSessions.has(sessionId)) {
      throw new Error(`Open Wrangler has no live interactive R session ${sessionId}.`);
    }
    await this.closeCandidateSession(sessionId, options);
  }

  isSessionMapped(sessionId: string): boolean {
    return this.mappedSessions.has(sessionId);
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.stopping = true;
      this.disposal = this.disposeOnce();
    }
    return this.disposal;
  }

  private async updatePlan(
    kind: "applyDraft" | "discardDraft" | "undoStep",
    action: RKernelPlanUpdatedResult["action"],
    sessionId: string,
    revision: number,
    page: RKernelPageWindow,
    options: RKernelRequestOptions
  ): Promise<RKernelPlanUpdatedResult> {
    const response = await this.executeMapped(this.request(kind, { sessionId, revision, page }), options);
    if (response.kind === "error") throw new RKernelDiagnosticError(response);
    if (
      response.kind !== "planUpdated" ||
      response.sessionId !== sessionId ||
      response.revision !== revision + 1 ||
      response.action !== action
    ) {
      this.publishInvalidation();
      throw new Error("The interactive R session returned a mismatched cleaning-plan update.");
    }
    return Object.freeze({
      sessionId,
      revision: response.revision,
      action: response.action,
      page: response.page,
      code: response.code
    });
  }

  private async executeMapped(
    request: Exclude<RKernelRequest, Extract<RKernelRequest, { kind: "openSession" | "closeSession" }>>,
    options: RKernelRequestOptions,
    decodeContext?: RKernelResponseDecodeContext
  ): Promise<RKernelResponse> {
    this.assertActive();
    const sessionId = request.payload.sessionId;
    if (!this.mappedSessions.has(sessionId)) {
      throw new Error(`Open Wrangler has no live interactive R session ${sessionId}.`);
    }
    const response = await this.waitForScheduled(this.scheduleKernel(request, decodeContext), options);
    if (response.kind === "error" && response.code === "unknown_session") {
      this.retireSession(sessionId);
      this.publishInvalidation();
    }
    return response;
  }

  private scheduleKernel(
    request: RKernelRequest,
    context?: RKernelResponseDecodeContext
  ): ScheduledRequest<RKernelResponse> {
    const payload = encodeRKernelRequest(request);
    const scheduled = this.schedule(request.requestId, payload, R_KERNEL_MAX_RESPONSE_BYTES, (response) => {
      const decoded = decodeRKernelResponseJson(response, request.requestId, context);
      if (decoded.kind === "error" && decoded.message.startsWith(TERMINAL_CHANGED_MESSAGE)) {
        this.publishInvalidation();
      }
      return decoded;
    });
    if (!isMutationRequest(request)) return scheduled;
    return {
      state: scheduled.state,
      completion: scheduled.completion.catch((error: unknown) => {
        if (scheduled.state.dispatched) this.publishInvalidation();
        throw error;
      })
    };
  }

  private schedule<T>(
    requestId: string,
    payload: string,
    maximumResponseBytes: number,
    decode: (payload: string) => T,
    allowStopping = false,
    isRequestCurrent?: () => boolean
  ): ScheduledRequest<T> {
    if (!allowStopping) this.assertActive();
    if (Buffer.byteLength(payload, "utf8") > R_KERNEL_MAX_REQUEST_BYTES) {
      throw new RangeError("The interactive R request exceeds the byte limit.");
    }
    const preceding = this.queueTail;
    const state = { dispatched: false, abandonBeforeDispatch: false };
    const completion = (async () => {
      const mailbox = await this.ensureMailbox();
      await preceding;
      if (state.abandonBeforeDispatch) throw new KernelRequestCancelledError();
      if (!allowStopping) this.assertActive();
      if (!allowStopping && !vscode.workspace.isTrusted) {
        throw new Error("Trust this workspace before Open Wrangler accesses the active R session.");
      }
      const requestPath = path.join(mailbox.requests, `${requestId}.json`);
      const responsePath = path.join(mailbox.responses, `${requestId}.json`);
      let requestCreated = false;
      try {
        await writeFile(requestPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
        requestCreated = true;
        await chmod(requestPath, 0o600);
        const expectedProcessId = await this.prepareSelectionTarget();
        if (state.abandonBeforeDispatch) throw new KernelRequestCancelledError();
        if (!allowStopping) this.assertActive();
        if (!allowStopping && !vscode.workspace.isTrusted) {
          throw new Error("Trust this workspace before Open Wrangler accesses the active R session.");
        }
        if (isRequestCurrent && !isRequestCurrent()) throw new KernelRequestCancelledError();
        const code = buildRInteractiveDispatchCode({
          runtimeRoot: this.runtimeRoot,
          ownerToken: this.ownerToken,
          bundleId: this.runtimeBundleId,
          requestPath,
          responsePath,
          notificationPath: mailbox.notificationPath,
          notificationSentinelPath: mailbox.notificationSentinelPath,
          notificationRequestId: this.notificationRequestId,
          attachmentPath: mailbox.attachmentPath,
          attachmentNonce: this.attachmentNonce,
          expectedProcessId: expectedProcessId ?? 1,
          bootstrapDispatcher: !this.dispatcherLoaded
        });
        const bootstrapping = !this.dispatcherLoaded;
        state.dispatched = true;
        const dispatch = this.dispatchSelection(code);
        await dispatch;
        const response = await waitForResponse(
          responsePath,
          maximumResponseBytes,
          () => {
            if (this.terminalUnavailable || (this.invalidationPublished && !allowStopping)) {
              return "The active R terminal changed. Reopen the dataframe from its original R session.";
            }
            if (this.disposed || (this.stopping && !allowStopping)) {
              return "The interactive R transport was disposed before its response arrived.";
            }
            return undefined;
          },
          RESPONSE_POLL_MS,
          this.artifactOperations,
          (error) => this.recordArtifactCleanupFailure(responsePath, "response", error),
          (error) => this.recordArtifactOwnershipFailure(error)
        );
        const decoded = decode(response);
        if (bootstrapping && expectedProcessId !== undefined) {
          await this.verifySelectionTarget(expectedProcessId);
          await this.verifyAttachment(mailbox, expectedProcessId);
        }
        this.dispatcherLoaded = true;
        this.terminalClaimed = true;
        this.attachmentVerified = true;
        return decoded;
      } finally {
        if (requestCreated) await this.cleanupArtifact(requestPath, "request");
      }
    })();
    void completion.catch(() => undefined);
    this.queueTail = settle(completion);
    return { completion, state };
  }

  private async waitForScheduled<T>(scheduled: ScheduledRequest<T>, options: RKernelRequestOptions): Promise<T> {
    const timeoutMs = requestTimeout(options.timeoutMs);
    let reason: DetachedBridgeRequestReason | undefined;
    try {
      return await withKernelTimeout(
        scheduled.completion,
        timeoutMs,
        () => {
          reason = "timeout";
        },
        options.cancellation,
        () => {
          reason = "cancellation";
        }
      );
    } catch (error) {
      if (!reason) throw error;
      if (!scheduled.state.dispatched) {
        scheduled.state.abandonBeforeDispatch = true;
        throw error;
      }
      throw new DetachedBridgeRequestError(
        detachedMessage(reason, timeoutMs),
        reason,
        true,
        settle(scheduled.completion)
      );
    }
  }

  private async closeCandidateSession(sessionId: string, options: RKernelRequestOptions): Promise<void> {
    const request = this.request("closeSession", { sessionId });
    const scheduled = this.scheduleKernelCleanup(request);
    const tracked: ScheduledRequest<RKernelResponse> = {
      state: scheduled.state,
      completion: scheduled.completion.then((response) => {
        if (isCorrelatedClose(response, sessionId)) this.retireSession(sessionId);
        return response;
      })
    };
    const response = await this.waitForScheduled(tracked, options);
    if (response.kind === "error") {
      if (response.code === "unknown_session") return;
      throw new RKernelDiagnosticError(response);
    }
    if (response.kind !== "closed" || response.sessionId !== sessionId) {
      throw new Error("The interactive R session returned a mismatched close identity.");
    }
  }

  private scheduleExactDataExportClose(
    sessionId: string,
    revision: number,
    exportId: string
  ): ScheduledRequest<RKernelResponse> {
    return this.scheduleKernelCleanup(this.request("closeDataExport", { sessionId, revision, exportId }));
  }

  private async awaitExactDataExportClose(
    scheduled: ScheduledRequest<RKernelResponse>,
    sessionId: string,
    revision: number,
    exportId: string
  ): Promise<void> {
    const response = await this.waitForScheduled(scheduled, {
      timeoutMs: this.dataExportCleanupTimeoutMs
    });
    if (response.kind === "error") {
      if (response.code === "unknown_session") {
        this.retireSession(sessionId);
        this.publishInvalidation();
        return;
      }
      throw new RKernelDiagnosticError(response);
    }
    if (
      response.kind !== "dataExportClosed" ||
      response.sessionId !== sessionId ||
      response.revision !== revision ||
      response.exportId !== exportId
    ) {
      throw new Error("The interactive R session returned a mismatched data-export cleanup response.");
    }
  }

  private async recoverFromExportCleanupFailure(sessionId: string, cleanupError: unknown): Promise<void> {
    const scheduledClose = this.scheduleKernelCleanup(this.request("closeSession", { sessionId }));
    try {
      if (cleanupError instanceof DetachedBridgeRequestError && cleanupError.dispatched) {
        await cleanupError.settlement;
      }
      const response = await this.waitForScheduled(scheduledClose, { timeoutMs: this.dataExportCleanupTimeoutMs });
      if (!isCorrelatedClose(response, sessionId)) {
        if (response.kind === "error") throw new RKernelDiagnosticError(response);
        throw new Error("The interactive R session returned a mismatched terminal export-cleanup response.");
      }
      this.retireSession(sessionId);
      this.publishInvalidation();
    } catch (terminalError) {
      this.exportCleanupFailures.push(
        new AggregateError(
          [cleanupError, terminalError],
          "Open Wrangler could not close a private interactive R export or its exact terminal session."
        )
      );
      this.publishInvalidation();
    }
  }

  private async cleanupAbandonedOpen(sessionId: string, candidateMayExist: boolean): Promise<void> {
    if (!candidateMayExist) {
      this.retireSession(sessionId);
      return;
    }
    this.abandonedOpenSessions.add(sessionId);
    try {
      if (!this.stopping) {
        await this.closeCandidateSession(sessionId, { timeoutMs: DISPOSAL_SETTLEMENT_MS });
      }
    } catch {
      // The caller's bridge disposal performs the final bounded cleanup pass.
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

  private ensureMailbox(): Promise<InteractiveMailbox> {
    this.mailboxPromise ??= this.createMailbox();
    return this.mailboxPromise;
  }

  private async createMailbox(): Promise<InteractiveMailbox> {
    const root = await mkdtemp(path.join(this.temporaryParent, "openwrangler-r-live-"));
    let notificationWatcher: FSWatcher | undefined;
    try {
      await chmod(root, 0o700);
      const requests = path.join(root, "requests");
      const responses = path.join(root, "responses");
      const notificationPath = path.join(root, "workspace.discovery.json");
      const notificationSentinelPath = path.join(root, "workspace.alive");
      const attachmentPath = path.join(root, "attachment.json");
      await mkdir(requests, { mode: 0o700 });
      await mkdir(responses, { mode: 0o700 });
      await writeFile(notificationPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
      await writeFile(notificationSentinelPath, "openwrangler\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
      await writeFile(attachmentPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
      await chmod(notificationPath, 0o600);
      await chmod(notificationSentinelPath, 0o600);
      await chmod(attachmentPath, 0o600);
      const identity = validatePrivateDirectory(await lstat(root, { bigint: true }), "interactive R mailbox");
      const notificationName = path.basename(notificationPath);
      const watcher = watch(root, { persistent: false }, (_eventType, filename) => {
        const changedName = Buffer.isBuffer(filename) ? filename.toString("utf8") : filename;
        if ((changedName === null || changedName === notificationName) && !this.stopping && !this.disposed) {
          this.scheduleNotificationRead();
        }
      });
      notificationWatcher = watcher;
      watcher.on("error", () => watcher.close());
      const mailbox = Object.freeze({
        root,
        requests,
        responses,
        notificationPath,
        notificationSentinelPath,
        attachmentPath,
        notificationWatcher,
        identity
      });
      this.mailbox = mailbox;
      if (this.disposed) throw new Error("The interactive R transport was disposed during mailbox creation.");
      return mailbox;
    } catch (error) {
      notificationWatcher?.close();
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  private async disposeOnce(): Promise<void> {
    const pending = Promise.all([settle(this.queueTail), this.settleActiveExportWork()]).then(() => undefined);
    if (!(await settleWithin(pending, this.disposalSettlementMs))) {
      this.deferCleanup(settle(pending).then(() => this.runTerminalCleanup()));
      throw new Error(
        "The active R request did not settle before transport cleanup. Open Wrangler will finish cleanup when that exact request returns."
      );
    }
    await this.runTerminalCleanup();
  }

  private runTerminalCleanup(): Promise<void> {
    this.terminalCleanup ??= this.runTerminalCleanupOnce();
    return this.terminalCleanup;
  }

  private async runTerminalCleanupOnce(): Promise<void> {
    const work: Promise<void>[] = [];
    const cleanupSessions = new Set([...this.mappedSessions, ...this.openingSessions, ...this.abandonedOpenSessions]);
    for (const sessionId of cleanupSessions) {
      const request = this.request("closeSession", { sessionId });
      const scheduled = this.scheduleKernelCleanup(request);
      work.push(
        scheduled.completion.then((response) => {
          if (!isCorrelatedClose(response, sessionId)) {
            if (response.kind === "error") throw new RKernelDiagnosticError(response);
            throw new Error("The interactive R session returned a mismatched cleanup response.");
          }
          this.retireSession(sessionId);
        })
      );
    }
    if (this.runtimeLoaded || this.terminalClaimed) {
      const requestId = this.createId();
      const payload = JSON.stringify({
        protocolVersion: INTERACTIVE_PROTOCOL_VERSION,
        requestId,
        kind: "teardownInteractiveRuntime"
      });
      const scheduled = this.schedule(
        requestId,
        payload,
        MAX_DISCOVERY_BYTES,
        (response) => decodeTeardownResponse(response, requestId),
        true
      );
      work.push(scheduled.completion);
    }
    const terminalSettlement = Promise.allSettled(work).then((results) =>
      results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []))
    );
    let failures: unknown[];
    try {
      failures = await boundedCompletion(terminalSettlement, this.disposalSettlementMs);
    } catch (error) {
      this.deferCleanup(
        terminalSettlement.then((lateFailures) =>
          this.finishHostCleanup([...lateFailures, ...this.takeAllCleanupFailures()])
        )
      );
      throw new Error(
        "Interactive R cleanup timed out. Open Wrangler will remove its private runtime and mailbox when the exact terminal work returns.",
        { cause: error }
      );
    }
    await this.finishHostCleanup([...failures, ...this.takeAllCleanupFailures()]);
  }

  private scheduleKernelCleanup(
    request: Extract<RKernelRequest, { kind: "closeSession" | "closeDataExport" }>
  ): ScheduledRequest<RKernelResponse> {
    const payload = encodeRKernelRequest(request);
    return this.schedule(
      request.requestId,
      payload,
      R_KERNEL_MAX_RESPONSE_BYTES,
      (response) => decodeRKernelResponseJson(response, request.requestId),
      true
    );
  }

  private async removeMailbox(): Promise<void> {
    if (!this.mailbox && this.mailboxPromise) await settle(this.mailboxPromise);
    const mailbox = this.mailbox;
    if (!mailbox) return;
    mailbox.notificationWatcher.close();
    if (this.notificationReadTimer) clearTimeout(this.notificationReadTimer);
    this.notificationReadTimer = undefined;
    await this.notificationReadTail;
    if (!this.mailboxCleanupSafe) {
      throw new Error("Open Wrangler refused to remove an interactive R mailbox with an unowned artifact path.");
    }
    const current = validatePrivateDirectory(await lstat(mailbox.root, { bigint: true }), "interactive R mailbox");
    if (!sameDirectoryIdentity(mailbox.identity, current)) {
      throw new Error("Open Wrangler refused to remove a replaced interactive R mailbox.");
    }
    await rm(mailbox.root, { recursive: true, force: false });
  }

  private scheduleNotificationRead(): void {
    if (this.stopping || this.disposed) return;
    if (this.notificationReadTimer) clearTimeout(this.notificationReadTimer);
    this.notificationReadTimer = setTimeout(() => {
      this.notificationReadTimer = undefined;
      const mailbox = this.mailbox;
      if (!mailbox || this.stopping || this.disposed) return;
      const read = this.notificationReadTail.then(() => this.readNotification(mailbox));
      this.notificationReadTail = settle(read);
    }, RESPONSE_POLL_MS);
    this.notificationReadTimer.unref();
  }

  private async readNotification(mailbox: InteractiveMailbox): Promise<void> {
    let payload: string | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        payload = await this.readPrivateMailboxArtifact(mailbox.notificationPath, MAX_DISCOVERY_BYTES);
        if (payload !== undefined) break;
      } catch {
        // A notification is replaced with unlink/rename, so a bounded retry also
        // covers the short interval in which the destination is absent.
      }
      if (attempt === 2) return;
      await delay(RESPONSE_POLL_MS);
    }
    if (
      payload === undefined ||
      !this.attachmentVerified ||
      this.mailbox !== mailbox ||
      this.stopping ||
      this.disposed
    ) {
      return;
    }
    let discovery: RProcessVariableDiscovery;
    try {
      discovery = decodeDiscoveryResponse(payload, this.notificationRequestId);
    } catch {
      this.publishInvalidation();
      return;
    }
    if (this.mailbox === mailbox && !this.stopping && !this.disposed) {
      this.variablesChangedEmitter.fire(discovery);
    }
  }

  private deferCleanup(work: Promise<void>): void {
    void work.catch((error: unknown) => {
      console.error("Open Wrangler could not finish deferred interactive R cleanup.", error);
    });
  }

  private finishHostCleanup(failures: unknown[]): Promise<void> {
    this.hostCleanup ??= this.finishHostCleanupOnce(failures);
    return this.hostCleanup;
  }

  private async finishHostCleanupOnce(failures: unknown[]): Promise<void> {
    this.disposed = true;
    this.mappedSessions.clear();
    this.openingSessions.clear();
    this.abandonedOpenSessions.clear();
    try {
      await this.removeMailbox();
    } catch (error) {
      failures.push(error);
    } finally {
      this.invalidatedEmitter.dispose();
      this.variablesChangedEmitter.dispose();
      this.terminalCloseSubscription?.dispose();
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Open Wrangler could not completely clean up its interactive R transport.");
    }
  }

  private async cleanupArtifact(filePath: string, label: "request" | "response"): Promise<void> {
    try {
      await removeIfPresent(filePath, this.removeFile);
    } catch (error) {
      this.recordArtifactCleanupFailure(filePath, label, error);
    }
  }

  private recordArtifactCleanupFailure(filePath: string, label: "request" | "response", error: unknown): void {
    this.recordArtifactOwnershipFailure(error);
    this.artifactCleanupFailures.push(
      new Error(
        `Open Wrangler could not remove its private interactive R ${label} artifact ${path.basename(filePath)}.`,
        {
          cause: error
        }
      )
    );
  }

  private takeCleanupFailures(): unknown[] {
    return this.artifactCleanupFailures.splice(0);
  }

  private takeAllCleanupFailures(): unknown[] {
    return [...this.takeCleanupFailures(), ...this.exportCleanupFailures.splice(0)];
  }

  private trackExportWork<T>(work: Promise<T>): Promise<T> {
    this.activeExportWork.add(work);
    void work
      .finally(() => {
        this.activeExportWork.delete(work);
      })
      .catch(() => undefined);
    return work;
  }

  private async settleActiveExportWork(): Promise<void> {
    while (this.activeExportWork.size > 0) {
      await Promise.allSettled([...this.activeExportWork]);
    }
  }

  private retireSession(sessionId: string): void {
    this.mappedSessions.delete(sessionId);
    this.openingSessions.delete(sessionId);
    this.abandonedOpenSessions.delete(sessionId);
    while (this.retiredSessions.size >= MAX_RETIRED_SESSION_IDS) {
      const oldest = this.retiredSessions.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.retiredSessions.delete(oldest);
    }
    this.retiredSessions.add(sessionId);
  }

  private assertSessionIdentityAvailable(sessionId: string): void {
    if (
      this.mappedSessions.has(sessionId) ||
      this.openingSessions.has(sessionId) ||
      this.abandonedOpenSessions.has(sessionId) ||
      this.retiredSessions.has(sessionId)
    ) {
      throw new Error(`Open Wrangler interactive R session ${sessionId} is already in use.`);
    }
  }

  private publishInvalidation(terminalUnavailable = false): void {
    if (terminalUnavailable) this.terminalUnavailable = true;
    if (this.invalidationPublished) return;
    this.invalidationPublished = true;
    for (const sessionId of this.mappedSessions) {
      if (!this.retiredSessions.has(sessionId)) this.abandonedOpenSessions.add(sessionId);
    }
    this.mappedSessions.clear();
    this.invalidatedEmitter.fire();
  }

  private async verifyAttachment(mailbox: InteractiveMailbox, expectedProcessId: number): Promise<void> {
    const payload = await this.readPrivateMailboxArtifact(mailbox.attachmentPath, MAX_DISCOVERY_BYTES);
    if (payload === undefined) throw new Error("Open Wrangler did not receive an R terminal attachment receipt.");
    decodeAttachmentResponse(payload, this.attachmentNonce, this.runtimeBundleId, expectedProcessId);
  }

  private async readPrivateMailboxArtifact(filePath: string, maximumBytes: number): Promise<string | undefined> {
    try {
      const bytes = await readRPrivateArtifact({
        filePath,
        maximumBytes,
        label: "interactive R response",
        missing: "returnUndefined",
        operations: this.artifactOperations
      });
      return bytes?.toString("utf8");
    } catch (error) {
      this.recordArtifactOwnershipFailure(error);
      throw error;
    }
  }

  private recordArtifactOwnershipFailure(error: unknown): void {
    if (rPrivateArtifactFailureRequiresContainerPreservation(error)) this.mailboxCleanupSafe = false;
  }

  private async ensureBoundTerminal(): Promise<number> {
    const extension = vscode.extensions.getExtension("REditorSupport.r");
    if (!extension) throw new Error("Install or enable the R extension to open a live R dataframe.");
    await extension.activate();
    if (this.boundTerminal) {
      if (!vscode.window.terminals.includes(this.boundTerminal) || !isOfficialRTerminal(this.boundTerminal)) {
        this.publishInvalidation(true);
        throw new Error("The active R terminal changed. Reopen the dataframe from its original R session.");
      }
      return await terminalProcessId(this.boundTerminal);
    }
    if (this.terminalAmbiguousAtCreation) {
      throw new Error("Select the R terminal that owns the dataframe, then try Open in Open Wrangler again.");
    }
    if (this.terminalMode === "active") {
      throw new Error("Select an active R terminal before refreshing Open Wrangler dataframes.");
    }
    const beforeCreation = new Set(vscode.window.terminals);
    await vscode.commands.executeCommand("r.createRTerm", true);
    const created = vscode.window.terminals.filter(
      (terminal) => !beforeCreation.has(terminal) && isOfficialRTerminal(terminal)
    );
    if (created.length !== 1) {
      throw new Error("Open Wrangler could not identify the R terminal it started.");
    }
    this.boundTerminal = created[0];
    return await terminalProcessId(this.boundTerminal);
  }

  private async verifyBoundTerminal(expectedProcessId: number | undefined): Promise<void> {
    if (!expectedProcessId || !this.boundTerminal) {
      throw new Error("Open Wrangler could not verify the selected R terminal process.");
    }
    const currentProcessId = await terminalProcessId(this.boundTerminal);
    if (currentProcessId !== expectedProcessId) {
      this.publishInvalidation(true);
      throw new Error("The selected R terminal process changed during attachment.");
    }
  }

  private sendSelectionToBoundTerminal(code: string): void {
    const terminal = this.boundTerminal;
    if (!terminal || !vscode.window.terminals.includes(terminal) || !isOfficialRTerminal(terminal)) {
      this.publishInvalidation(true);
      throw new Error("The active R terminal changed. Reopen the dataframe from its original R session.");
    }
    terminal.sendText(code, true);
  }

  private assertActive(): void {
    if (this.stopping || this.disposed) throw new Error("The interactive R transport is disposed.");
  }
}

function captureRSelectionTarget(
  mode: "active" | "activeOrCreate",
  expectedTerminal?: vscode.Terminal
): Readonly<{ terminal?: vscode.Terminal; ambiguous: boolean }> {
  const candidates = vscode.window.terminals.filter(isOfficialRTerminal);
  if (expectedTerminal) {
    if (!candidates.includes(expectedTerminal)) {
      throw new Error("The selected R terminal changed before Open Wrangler could connect to it.");
    }
    return Object.freeze({ terminal: expectedTerminal, ambiguous: false });
  }
  const active = vscode.window.activeTerminal;
  if (active && candidates.includes(active)) return Object.freeze({ terminal: active, ambiguous: false });
  if (mode === "active") return Object.freeze({ ambiguous: false });
  if (candidates.length === 1) return Object.freeze({ terminal: candidates[0], ambiguous: false });
  return Object.freeze({ ambiguous: candidates.length > 1 });
}

function isOfficialRTerminal(terminal: vscode.Terminal): boolean {
  return terminal.name === "R" || terminal.name === "R Interactive";
}

async function terminalProcessId(terminal: vscode.Terminal): Promise<number> {
  const processId = await terminal.processId;
  if (!Number.isSafeInteger(processId) || (processId ?? 0) < 1) {
    throw new Error("Open Wrangler could not verify the selected R terminal process.");
  }
  return processId!;
}

async function waitForResponse(
  responsePath: string,
  maximumBytes: number,
  stopReason: () => string | undefined,
  pollMs: number,
  operations: RPrivateArtifactOperations,
  onCleanupFailure: (error: unknown) => void,
  onArtifactFailure: (error: unknown) => void
): Promise<string> {
  for (;;) {
    let response: string | undefined;
    try {
      response = await tryReadResponse(responsePath, maximumBytes, operations, onCleanupFailure);
    } catch (error) {
      onArtifactFailure(error);
      throw error;
    }
    if (response !== undefined) return response;
    const stopped = stopReason();
    if (stopped !== undefined) throw new Error(stopped);
    await delay(pollMs);
  }
}

async function tryReadResponse(
  responsePath: string,
  maximumBytes: number,
  operations: RPrivateArtifactOperations,
  onCleanupFailure: (error: unknown) => void
): Promise<string | undefined> {
  const bytes = await readRPrivateArtifact({
    filePath: responsePath,
    maximumBytes,
    label: "interactive R response",
    missing: "returnUndefined",
    removeAfterRead: "success",
    operations,
    onCleanupFailure
  });
  return bytes?.toString("utf8");
}

function decodeDiscoveryResponse(payload: string, requestId: string): RProcessVariableDiscovery {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    throw new Error("Open Wrangler received malformed interactive R discovery data.");
  }
  if (isRecord(value) && value.kind === "error") {
    const diagnostic = decodeRKernelResponseJson(payload, requestId);
    if (diagnostic.kind === "error") throw new RKernelDiagnosticError(diagnostic);
  }
  if (
    !isRecord(value) ||
    value.protocolVersion !== INTERACTIVE_PROTOCOL_VERSION ||
    value.requestId !== requestId ||
    value.status !== "ready" ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.variables) ||
    value.variables.length > MAX_DISCOVERY_VARIABLES ||
    Object.keys(value).length !== 5
  ) {
    throw new Error("Open Wrangler received malformed interactive R discovery data.");
  }
  const names = new Set<string>();
  const variables = value.variables.map((candidate): RProcessVariableDescriptor => {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).length !== 2 ||
      !isBoundedText(candidate.name, MAX_VARIABLE_NAME_BYTES) ||
      !isRDataframeFlavor(candidate.dataframeFlavor) ||
      names.has(candidate.name)
    ) {
      throw new Error("Open Wrangler received malformed interactive R variable data.");
    }
    names.add(candidate.name);
    return Object.freeze({ name: candidate.name, backend: "r" as const, dataframeFlavor: candidate.dataframeFlavor });
  });
  variables.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return Object.freeze({ variables: Object.freeze(variables), truncated: value.truncated });
}

function decodeAttachmentResponse(
  payload: string,
  expectedNonce: string,
  expectedBundleId: string,
  expectedProcessId: number
): void {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    throw new Error("Open Wrangler received malformed R terminal attachment data.");
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    value.protocolVersion !== INTERACTIVE_PROTOCOL_VERSION ||
    value.nonce !== expectedNonce ||
    value.bundleId !== expectedBundleId ||
    value.processId !== expectedProcessId
  ) {
    throw new Error("Open Wrangler could not verify the selected R terminal process.");
  }
}

function decodeTeardownResponse(payload: string, requestId: string): void {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    throw new Error("Open Wrangler received malformed interactive R teardown data.");
  }
  if (isRecord(value) && value.kind === "error") {
    const diagnostic = decodeRKernelResponseJson(payload, requestId);
    if (diagnostic.kind === "error") throw new RKernelDiagnosticError(diagnostic);
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.protocolVersion !== INTERACTIVE_PROTOCOL_VERSION ||
    value.requestId !== requestId ||
    value.status !== "closed"
  ) {
    throw new Error("Open Wrangler received malformed interactive R teardown data.");
  }
}

function validatePrivateDirectory(metadata: BigIntStats, label: string): BigIntStats {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 1n) {
    throw new Error(`Open Wrangler rejected an invalid ${label}.`);
  }
  return metadata;
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function requestTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2_147_483_647) {
    throw new TypeError("Interactive R timeout is outside the supported integer range.");
  }
  return timeout;
}

function remainingTimeout(timeoutMs: number, started: number): number {
  return Math.max(0, timeoutMs - (performance.now() - started));
}

function detachedMessage(reason: DetachedBridgeRequestReason, timeoutMs: number): string {
  return reason === "timeout"
    ? `Open Wrangler stopped waiting after ${timeoutMs} ms; the interactive R request is still finishing.`
    : "Open Wrangler stopped waiting after host cancellation; the interactive R request is still finishing.";
}

function isCorrelatedClose(response: RKernelResponse, sessionId: string): boolean {
  return (
    (response.kind === "closed" && response.sessionId === sessionId) ||
    (response.kind === "error" && response.code === "unknown_session")
  );
}

function isTerminalChangedError(error: unknown): boolean {
  return error instanceof RKernelDiagnosticError && error.message.startsWith(TERMINAL_CHANGED_MESSAGE);
}

async function boundedCompletion<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Interactive R cleanup timed out.")), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settleWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  try {
    await boundedCompletion(settle(work), timeoutMs);
    return true;
  } catch {
    return false;
  }
}

function settle(work: Promise<unknown>): Promise<void> {
  return work.then(
    () => undefined,
    () => undefined
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

async function removeIfPresent(filePath: string, removeFile: (filePath: string) => Promise<void>): Promise<void> {
  try {
    await removeFile(filePath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function isMutationRequest(request: RKernelRequest): boolean {
  return (
    request.kind === "previewStep" ||
    request.kind === "applyDraft" ||
    request.kind === "discardDraft" ||
    request.kind === "undoStep"
  );
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !hasUnpairedSurrogate(value) &&
    !hasControlCharacter(value) &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function isRDataframeFlavor(value: unknown): value is RDataframeFlavor {
  return value === "r.data.frame" || value === "r.tibble" || value === "r.data.table";
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f) return true;
  }
  return false;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
