import { randomUUID } from "node:crypto";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, rm, unlink, writeFile } from "node:fs/promises";
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

const PROCESS_PROTOCOL_VERSION = 1;
const MAX_READY_BYTES = 64 * 1_024;
const MAX_DOCUMENT_BYTES = 64 * 1_024 * 1_024;
const MAX_DOCUMENT_UNITS = 1_024;
const MAX_DISCOVERY_VARIABLES = 256;
const MAX_VARIABLE_NAME_BYTES = 1_024;
const RESPONSE_POLL_MS = 10;
const GRACEFUL_STOP_MS = 2_000;
const TERMINATION_STOP_MS = 1_000;
const FORCED_STOP_MS = 2_000;
const PROCESS_GROUP_POLL_MS = 25;
const MAX_RETIRED_SESSION_IDS = 1_024;
const EXPORT_CHUNK_BYTES = 1 * 1_024 * 1_024;
const PRIVATE_READ_FLAGS =
  fsConstants.O_RDONLY |
  (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0) |
  (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0);

export interface RProcessVariableDescriptor {
  readonly name: string;
  readonly backend: "r";
  readonly dataframeFlavor: RDataframeFlavor;
}

export interface RProcessVariableDiscovery {
  readonly variables: readonly RProcessVariableDescriptor[];
  readonly truncated: boolean;
}

export interface RProcessSessionTransportOptions {
  /** Directory containing frame_contract.R, kernel_agent.R, and process_agent.R. */
  readonly runtimeRoot: string;
  /** Exact plain-R source, or separately parsed literate-document R cells. */
  readonly documentText: string | readonly string[];
  /** Absolute resolver-confirmed executable; never searched relative to the workspace. */
  readonly rscriptPath: string;
  /** Origin directory used for the document's relative file references. */
  readonly workingDirectory: string;
  readonly temporaryParent?: string;
  readonly createId?: () => string;
}

interface OwnedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly root: string;
  readonly responseRoot: string;
  readonly exportRoot: string;
  readonly closed: Promise<ProcessClose>;
  closeState?: ProcessClose;
  spawnError?: Error;
  stopPromise?: Promise<void>;
}

interface ProcessClose {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface StartedProcess {
  readonly owned: OwnedProcess;
  readonly discovery: RProcessVariableDiscovery;
}

interface ScheduledRequest {
  readonly completion: Promise<RKernelResponse>;
  readonly state: {
    dispatched: boolean;
    abandonBeforeDispatch: boolean;
  };
}

/**
 * Long-lived native-R transport for one immutable plain-R document capture.
 *
 * Protocol responses are atomically published in a private mailbox rather than
 * written to stdout. User code can therefore print freely, spawn noisy child
 * commands, or emit messages without ever becoming protocol input.
 */
export class RProcessSessionTransport implements RKernelBridgeTransport {
  private readonly createId: () => string;
  private readonly documentTexts: readonly string[];
  private readonly invalidatedEmitter = new vscode.EventEmitter<void>();
  readonly onDidInvalidateKernel = this.invalidatedEmitter.event;

  private startPromise: Promise<StartedProcess> | undefined;
  private owned: OwnedProcess | undefined;
  private queueTail: Promise<void> = Promise.resolve();
  private readonly mappedSessions = new Set<string>();
  private readonly openingSessions = new Set<string>();
  private readonly abandonedOpenSessions = new Set<string>();
  private readonly retiredSessions = new Set<string>();
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private stopping = false;
  private invalidationPublished = false;

  constructor(private readonly options: RProcessSessionTransportOptions) {
    this.createId = options.createId ?? randomUUID;
    const documentTexts = typeof options.documentText === "string" ? [options.documentText] : options.documentText;
    if (!path.isAbsolute(options.runtimeRoot)) {
      throw new TypeError("The R process runtime root must be absolute.");
    }
    if (options.temporaryParent !== undefined && !path.isAbsolute(options.temporaryParent)) {
      throw new TypeError("The R process temporary parent must be absolute.");
    }
    if (!path.isAbsolute(options.workingDirectory)) {
      throw new TypeError("The R document working directory must be absolute.");
    }
    if (!Array.isArray(documentTexts) || documentTexts.length === 0 || documentTexts.length > MAX_DOCUMENT_UNITS) {
      throw new RangeError(`The R document must contain between 1 and ${MAX_DOCUMENT_UNITS} source units.`);
    }
    let documentBytes = 0;
    for (const text of documentTexts) {
      if (typeof text !== "string" || hasUnpairedSurrogate(text)) {
        throw new TypeError("The R document must be valid Unicode text.");
      }
      documentBytes += Buffer.byteLength(text, "utf8");
    }
    if (documentBytes > MAX_DOCUMENT_BYTES) {
      throw new RangeError("The R document exceeds the supported 64 MiB source limit.");
    }
    this.documentTexts = Object.freeze([...documentTexts]);
    if (!path.isAbsolute(options.rscriptPath)) {
      throw new TypeError("The Rscript path must be absolute.");
    }
  }

  async discoverVariables(options: RKernelRequestOptions = {}): Promise<RProcessVariableDiscovery> {
    this.assertActive();
    const timeoutMs = requestTimeout(options.timeoutMs);
    const startup = this.ensureStarted();
    void startup.catch(() => undefined);
    let reason: DetachedBridgeRequestReason | undefined;
    try {
      const started = await withKernelTimeout(
        startup,
        timeoutMs,
        () => {
          reason = "timeout";
        },
        options.cancellation,
        () => {
          reason = "cancellation";
        }
      );
      this.assertActive();
      return started.discovery;
    } catch (error) {
      if (!reason) throw error;
      throw new DetachedBridgeRequestError(startupDetachedMessage(reason, timeoutMs), reason, true, settle(startup));
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
    encodeRKernelRequest(request);
    this.openingSessions.add(sessionId);

    const scheduled = this.schedule(request, { expectExportFormats: true });
    const tracked: ScheduledRequest = {
      state: scheduled.state,
      completion: scheduled.completion.then((response) => {
        if (response.kind === "page" && response.sessionId === sessionId) this.mappedSessions.add(sessionId);
        return response;
      })
    };

    try {
      const response = await this.waitForScheduled(tracked, options);
      if (response.kind === "error") throw new RKernelDiagnosticError(response);
      if (response.kind !== "page" || response.sessionId !== sessionId) {
        throw new Error("The R process returned a mismatched session identity.");
      }
      if (!response.exportFormats) {
        throw new Error("The R process did not report its data-export capabilities.");
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
      await this.disposeIfIdle();
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
      throw new Error("The R process returned a mismatched page session identity.");
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
      throw new Error("The R process returned mismatched column summaries.");
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
      throw new Error("The R process returned mismatched dataset statistics.");
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
  ): Promise<Readonly<{ column: string; values: readonly ValueCount[]; hasMore: boolean }>> {
    const response = await this.executeMapped(
      this.request("getColumnValues", { sessionId, column, view, search: search ?? null, limit }),
      options
    );
    if (response.kind === "error") throw new RKernelDiagnosticError(response);
    if (response.kind !== "columnValues" || response.sessionId !== sessionId) {
      throw new Error("The R process returned mismatched column values.");
    }
    return Object.freeze({ column: response.column, values: response.values, hasMore: response.hasMore });
  }

  async exportData(
    sessionId: string,
    revision: number,
    format: RKernelExportFormat,
    writeChunk: (chunk: Uint8Array) => Promise<void>,
    options: RKernelRequestOptions = {}
  ): Promise<RKernelDataExportResult> {
    this.assertActive();
    if (typeof writeChunk !== "function") throw new TypeError("The R export chunk writer must be a function.");
    if (!this.mappedSessions.has(sessionId) || !this.owned) {
      throw new Error(`Open Wrangler has no live R process session ${sessionId}.`);
    }
    const exportId = this.createId();
    const artifactPath = path.join(this.owned.exportRoot, `${exportId}.${format}`);
    const request = this.request("exportData", { sessionId, revision, exportId, format });
    encodeRKernelRequest(request);
    let deferredCleanup = false;
    try {
      const response = await this.executeMapped(request, options);
      if (response.kind === "error") throw new RKernelDiagnosticError(response);
      if (
        response.kind !== "dataExported" ||
        response.sessionId !== sessionId ||
        response.revision !== revision ||
        response.exportId !== exportId ||
        response.format !== format
      ) {
        throw new Error("The R process returned a mismatched data export.");
      }
      await streamPrivateExportArtifact(artifactPath, response.bytes, writeChunk);
      return Object.freeze({
        sessionId,
        revision,
        format: response.format,
        rows: response.rows,
        columns: response.columns
      });
    } catch (error) {
      if (error instanceof DetachedBridgeRequestError && error.dispatched) {
        deferredCleanup = true;
        const cleanup = error.settlement.then(() => this.removePrivateExportArtifactOrDispose(artifactPath));
        throw new DetachedBridgeRequestError(error.message, error.reason, true, cleanup);
      }
      throw error;
    } finally {
      if (!deferredCleanup) await this.removePrivateExportArtifactOrDispose(artifactPath);
    }
  }

  private async removePrivateExportArtifactOrDispose(artifactPath: string): Promise<void> {
    try {
      await removePrivateExportArtifact(artifactPath);
    } catch (error) {
      const cleanupError = error instanceof Error ? error : new Error(String(error));
      this.publishInvalidation(cleanupError);
      try {
        await this.dispose();
      } catch (disposeError) {
        throw new AggregateError(
          [cleanupError, disposeError],
          "Open Wrangler could not remove a private R export artifact or dispose its owning process."
        );
      }
      throw cleanupError;
    }
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
      { inputSchema }
    );
    if (response.kind === "error") throw new RKernelDiagnosticError(response);
    if (response.kind !== "stepPreview" || response.sessionId !== sessionId || response.revision !== revision + 1) {
      throw new Error("The R process returned a mismatched step preview.");
    }
    return Object.freeze({
      sessionId,
      revision: response.revision,
      page: response.page,
      diff: response.diff,
      code: response.code,
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
      throw new Error("The R process returned mismatched step inspection metadata.");
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
        throw new Error("The R process returned a mismatched step inspection page.");
      }
      return response;
    };

    const input = await inspectPage("input");
    const output = await inspectPage("output");
    if (info.stepIndex !== input.stepIndex || info.stepIndex !== output.stepIndex) {
      throw new Error("The R process returned mismatched step inspection pages.");
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

  async close(sessionId: string, options: RKernelRequestOptions = {}): Promise<void> {
    if (this.retiredSessions.has(sessionId)) return;
    this.assertActive();
    if (!this.mappedSessions.has(sessionId)) {
      throw new Error(`Open Wrangler has no live R process session ${sessionId}.`);
    }
    await this.closeCandidateSession(sessionId, options);
    await this.disposeIfIdle();
  }

  private async closeCandidateSession(sessionId: string, options: RKernelRequestOptions): Promise<void> {
    const request = this.request("closeSession", { sessionId });
    const scheduled = this.schedule(request);
    const tracked: ScheduledRequest = {
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
      throw new Error("The R process returned a mismatched close session identity.");
    }
  }

  isSessionMapped(sessionId: string): boolean {
    return this.mappedSessions.has(sessionId);
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true;
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
      throw new Error("The R process returned a mismatched cleaning-plan update.");
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
    if (!this.mappedSessions.has(request.payload.sessionId)) {
      throw new Error(`Open Wrangler has no live R process session ${request.payload.sessionId}.`);
    }
    encodeRKernelRequest(request);
    return this.waitForScheduled(this.schedule(request, decodeContext), options);
  }

  private schedule(request: RKernelRequest, decodeContext?: RKernelResponseDecodeContext): ScheduledRequest {
    this.assertActive();
    const payload = encodeRKernelRequest(request);
    const preceding = this.queueTail;
    const state = { dispatched: false, abandonBeforeDispatch: false };
    const completion = (async () => {
      const started = await this.ensureStarted();
      await preceding;
      if (state.abandonBeforeDispatch) throw new KernelRequestCancelledError();
      this.assertActive();
      if (started.owned.closeState) throw processClosedError(started.owned);
      state.dispatched = true;
      await writeRequestFrame(started.owned.child, request.requestId, payload);
      const responsePath = path.join(started.owned.responseRoot, `${request.requestId}.json`);
      const responsePayload = await waitForResponse(started.owned, responsePath, R_KERNEL_MAX_RESPONSE_BYTES);
      return decodeRKernelResponseJson(responsePayload, request.requestId, decodeContext);
    })();
    void completion.catch(() => undefined);
    this.queueTail = settle(completion);
    return { completion, state };
  }

  private async waitForScheduled(
    scheduled: ScheduledRequest,
    options: RKernelRequestOptions
  ): Promise<RKernelResponse> {
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
        requestDetachedMessage(reason, timeoutMs),
        reason,
        true,
        settle(scheduled.completion)
      );
    }
  }

  private ensureStarted(): Promise<StartedProcess> {
    this.assertActive();
    this.startPromise ??= this.startOnce();
    return this.startPromise;
  }

  private async startOnce(): Promise<StartedProcess> {
    const runtimeRoot = path.resolve(this.options.runtimeRoot);
    const processAgent = path.join(runtimeRoot, "process_agent.R");
    await Promise.all([
      access(path.join(runtimeRoot, "frame_contract.R"), fsConstants.R_OK),
      access(path.join(runtimeRoot, "kernel_agent.R"), fsConstants.R_OK),
      access(processAgent, fsConstants.R_OK)
    ]);
    this.assertActive();

    const parent = this.options.temporaryParent ?? tmpdir();
    const root = await mkdtemp(path.join(parent, "openwrangler-r-"));
    const responseRoot = path.join(root, "responses");
    const documentRoot = path.join(root, "documents");
    const exportRoot = path.join(root, "exports");
    let owned: OwnedProcess | undefined;
    try {
      await chmod(root, 0o700);
      await mkdir(documentRoot, { mode: 0o700 });
      for (let index = 0; index < this.documentTexts.length; index += 1) {
        const documentPath = path.join(documentRoot, `${index.toString().padStart(8, "0")}.R`);
        await writeFile(documentPath, this.documentTexts[index]!, { encoding: "utf8", flag: "wx", mode: 0o400 });
      }
      await mkdir(responseRoot, { mode: 0o700 });
      await mkdir(exportRoot, { mode: 0o700 });
      this.assertActive();

      const child = spawn(this.options.rscriptPath, ["--vanilla", processAgent], {
        cwd: this.options.workingDirectory,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          OPEN_WRANGLER_R_RUNTIME_ROOT: runtimeRoot,
          OPEN_WRANGLER_R_DOCUMENT_ROOT: documentRoot,
          OPEN_WRANGLER_R_RESPONSE_ROOT: responseRoot,
          OPEN_WRANGLER_R_EXPORT_ROOT: exportRoot
        }
      });
      child.stdout.on("data", () => undefined);
      child.stderr.on("data", () => undefined);

      owned = createOwnedProcess(child, root, responseRoot, exportRoot, (error) => {
        if (!this.stopping) {
          this.publishInvalidation(error);
          void stopOwnedProcess(owned as OwnedProcess).catch(() => undefined);
        }
      });
      this.owned = owned;
      const readyPayload = await waitForResponse(owned, path.join(responseRoot, "ready.json"), MAX_READY_BYTES);
      const discovery = decodeReadyPayload(readyPayload);
      this.assertActive();
      return Object.freeze({ owned, discovery });
    } catch (error) {
      this.stopping = true;
      let cleanupError: unknown;
      if (owned) {
        try {
          await stopOwnedProcess(owned);
        } catch (stopError) {
          cleanupError = stopError;
        }
      }
      if (!owned || owned.closeState) {
        try {
          await rm(root, { recursive: true, force: true });
        } catch (removeError) {
          cleanupError = cleanupError
            ? new AggregateError([cleanupError, removeError], "Open Wrangler could not clean up failed R startup.")
            : removeError;
        }
      }
      if (cleanupError) throw new AggregateError([error, cleanupError], "Open Wrangler could not start its R process.");
      throw error;
    }
  }

  private async cleanupAbandonedOpen(sessionId: string, candidateMayExist: boolean): Promise<void> {
    try {
      if (candidateMayExist && !this.disposed) {
        // The host chooses the session ID before dispatch. A malformed,
        // mismatched, or diagnostic open response may hide a session that R
        // already created, so cleanup must address that candidate directly
        // even when no successful response established the host mapping.
        await this.closeCandidateSession(sessionId, { timeoutMs: 5_000 });
      }
    } catch {
      // The process itself is the final ownership boundary. If a correlated
      // close cannot finish, dispose still terminates the exact owned child.
    } finally {
      this.abandonedOpenSessions.delete(sessionId);
      this.retireSession(sessionId);
      await this.disposeIfIdle();
    }
  }

  private async disposeIfIdle(): Promise<void> {
    if (
      this.disposed ||
      this.mappedSessions.size > 0 ||
      this.openingSessions.size > 0 ||
      this.abandonedOpenSessions.size > 0
    ) {
      return;
    }
    await this.dispose();
  }

  private retireSession(sessionId: string): void {
    this.mappedSessions.delete(sessionId);
    this.openingSessions.delete(sessionId);
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
      throw new Error(`Open Wrangler R process session ${sessionId} is already in use.`);
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

  private async disposeOnce(): Promise<void> {
    this.stopping = true;
    const failures: unknown[] = [];
    // If disposal wins before spawn, let startup observe `disposed` and remove
    // the root it may already have created. Once spawn returns, `owned` is
    // assigned synchronously, so an absent owner cannot hide a running child.
    if (!this.owned && this.startPromise) await settle(this.startPromise);
    const owned = this.owned;
    if (owned) {
      try {
        await stopOwnedProcess(owned);
      } catch (error) {
        failures.push(error);
      }
      if (owned.closeState) {
        try {
          await rm(owned.root, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
      }
    }
    this.mappedSessions.clear();
    this.openingSessions.clear();
    this.abandonedOpenSessions.clear();
    this.invalidatedEmitter.dispose();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Open Wrangler could not dispose its R process.");
  }

  private publishInvalidation(_error: Error): void {
    if (this.invalidationPublished) return;
    this.invalidationPublished = true;
    this.mappedSessions.clear();
    this.invalidatedEmitter.fire();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("The R process transport is disposed.");
  }
}

function createOwnedProcess(
  child: ChildProcessWithoutNullStreams,
  root: string,
  responseRoot: string,
  exportRoot: string,
  onUnexpectedClose: (error: Error) => void
): OwnedProcess {
  let resolveClosed!: (value: ProcessClose) => void;
  const closed = new Promise<ProcessClose>((resolve) => {
    resolveClosed = resolve;
  });
  const owned: OwnedProcess = { child, root, responseRoot, exportRoot, closed };
  child.on("error", (error) => {
    owned.spawnError = error;
    if (child.pid === undefined && !owned.closeState) {
      const state = Object.freeze({ code: null, signal: null });
      owned.closeState = state;
      resolveClosed(state);
      onUnexpectedClose(processClosedError(owned));
    }
  });
  child.once("exit", (code, signal) => {
    if (owned.closeState) return;
    const state = Object.freeze({ code, signal });
    owned.closeState = state;
    resolveClosed(state);
    child.stdout.destroy();
    child.stderr.destroy();
    onUnexpectedClose(processClosedError(owned));
  });
  return owned;
}

async function writeRequestFrame(
  child: ChildProcessWithoutNullStreams,
  requestId: string,
  payload: string
): Promise<void> {
  const envelope = Buffer.from(`${requestId}\n${payload}`, "utf8");
  if (envelope.byteLength > R_KERNEL_MAX_REQUEST_BYTES + 37) {
    throw new RangeError("The R process request frame exceeds the byte limit.");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(envelope.byteLength, 0);
  const frame = Buffer.concat([header, envelope]);
  await new Promise<void>((resolve, reject) => {
    child.stdin.write(frame, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function waitForResponse(owned: OwnedProcess, responsePath: string, maximumBytes: number): Promise<string> {
  for (;;) {
    const response = await tryReadResponse(responsePath, maximumBytes);
    if (response !== undefined) return response;
    if (owned.closeState) throw processClosedError(owned);
    await Promise.race([delay(RESPONSE_POLL_MS), owned.closed]);
  }
}

async function tryReadResponse(responsePath: string, maximumBytes: number): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(responsePath, PRIVATE_READ_FLAGS);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  let bytes: Buffer;
  try {
    const opened = privateArtifactSnapshot(
      await handle.stat({ bigint: true }),
      BigInt(maximumBytes),
      "R process response"
    );
    const namedBefore = privateArtifactSnapshot(
      await lstat(responsePath, { bigint: true }),
      BigInt(maximumBytes),
      "R process response"
    );
    if (!samePrivateArtifactSnapshot(opened, namedBefore)) {
      throw new Error("Open Wrangler rejected a changing R process response artifact.");
    }
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0) {
        throw new Error("Open Wrangler received a truncated R process response artifact.");
      }
      offset += bytesRead;
    }
    const completed = privateArtifactSnapshot(
      await handle.stat({ bigint: true }),
      BigInt(maximumBytes),
      "R process response"
    );
    const namedAfter = privateArtifactSnapshot(
      await lstat(responsePath, { bigint: true }),
      BigInt(maximumBytes),
      "R process response"
    );
    if (!samePrivateArtifactSnapshot(opened, completed) || !samePrivateArtifactSnapshot(opened, namedAfter)) {
      throw new Error("Open Wrangler rejected a changing R process response artifact.");
    }
  } finally {
    await handle.close();
  }
  await unlink(responsePath);
  return bytes.toString("utf8");
}

async function streamPrivateExportArtifact(
  artifactPath: string,
  expectedBytes: number,
  writeChunk: (chunk: Uint8Array) => Promise<void>
): Promise<void> {
  const expectedSize = BigInt(expectedBytes);
  const handle = await open(artifactPath, PRIVATE_READ_FLAGS);
  try {
    const opened = privateArtifactSnapshot(
      await handle.stat({ bigint: true }),
      expectedSize,
      "private R export",
      expectedSize
    );
    const namedBefore = privateArtifactSnapshot(
      await lstat(artifactPath, { bigint: true }),
      expectedSize,
      "private R export",
      expectedSize
    );
    if (!samePrivateArtifactSnapshot(opened, namedBefore)) {
      throw new Error("Open Wrangler rejected a changing private R export artifact.");
    }
    let offset = 0;
    while (offset < expectedBytes) {
      const length = Math.min(EXPORT_CHUNK_BYTES, expectedBytes - offset);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (bytesRead <= 0) throw new Error("Open Wrangler received a truncated private R export artifact.");
      await writeChunk(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const afterRead = privateArtifactSnapshot(
      await handle.stat({ bigint: true }),
      expectedSize,
      "private R export",
      expectedSize
    );
    const namedAfter = privateArtifactSnapshot(
      await lstat(artifactPath, { bigint: true }),
      expectedSize,
      "private R export",
      expectedSize
    );
    if (!samePrivateArtifactSnapshot(opened, afterRead) || !samePrivateArtifactSnapshot(opened, namedAfter)) {
      throw new Error("Open Wrangler rejected a changing private R export artifact.");
    }
  } finally {
    await handle.close();
  }
}

function privateArtifactSnapshot(
  metadata: BigIntStats,
  maximumBytes: bigint,
  label: string,
  expectedBytes?: bigint
): BigIntStats {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size < 0n ||
    metadata.size > maximumBytes ||
    metadata.size > BigInt(Number.MAX_SAFE_INTEGER) ||
    (expectedBytes !== undefined && metadata.size !== expectedBytes)
  ) {
    throw new Error(`Open Wrangler rejected an invalid ${label} artifact.`);
  }
  return metadata;
}

function samePrivateArtifactSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

async function removePrivateExportArtifact(artifactPath: string): Promise<void> {
  try {
    await unlink(artifactPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function decodeReadyPayload(payload: string): RProcessVariableDiscovery {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    throw new Error("Open Wrangler received malformed R process startup data.");
  }
  if (!isRecord(value) || value.protocolVersion !== PROCESS_PROTOCOL_VERSION || typeof value.status !== "string") {
    throw new Error("Open Wrangler received malformed R process startup data.");
  }
  if (value.status === "error") {
    if (Object.keys(value).length !== 3 || !isBoundedText(value.message, 4_096)) {
      throw new Error("Open Wrangler received malformed R process startup data.");
    }
    throw new Error(value.message);
  }
  if (
    value.status !== "ready" ||
    Object.keys(value).length !== 4 ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.variables) ||
    value.variables.length > MAX_DISCOVERY_VARIABLES
  ) {
    throw new Error("Open Wrangler received malformed R process startup data.");
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
      throw new Error("Open Wrangler received malformed R process variable data.");
    }
    names.add(candidate.name);
    return Object.freeze({ name: candidate.name, backend: "r" as const, dataframeFlavor: candidate.dataframeFlavor });
  });
  variables.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return Object.freeze({ variables: Object.freeze(variables), truncated: value.truncated });
}

async function stopOwnedProcess(owned: OwnedProcess): Promise<void> {
  owned.stopPromise ??= stopOwnedProcessOnce(owned);
  return owned.stopPromise;
}

async function stopOwnedProcessOnce(owned: OwnedProcess): Promise<void> {
  try {
    if (!owned.child.stdin.destroyed && owned.child.stdin.writable) owned.child.stdin.end();
  } catch {
    // Forced termination below still targets only this exact ChildProcess.
  }
  if (process.platform !== "win32") {
    await stopOwnedPosixProcessGroup(owned);
    return;
  }
  // Node does not expose a Job Object for ordinary extension-host children.
  // On Windows this confirms the exact Rscript child. stdout/stderr are
  // destroyed on exit so an independently backgrounded user process cannot
  // keep the extension-host pipe alive.
  if (owned.closeState) return;
  if (await waitForClose(owned, GRACEFUL_STOP_MS)) return;
  let killError: unknown;
  try {
    if (!owned.child.kill("SIGKILL")) killError = new Error("the operating system rejected forced termination");
  } catch (error) {
    killError = error;
  }
  if (await waitForClose(owned, FORCED_STOP_MS)) return;
  throw new Error(
    `Open Wrangler could not confirm that its R process exited${killError ? ` (${String(killError)})` : ""}.`
  );
}

async function stopOwnedPosixProcessGroup(owned: OwnedProcess): Promise<void> {
  const pid = owned.child.pid;
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) {
    if (owned.closeState) return;
    throw new Error("The R process did not expose its owned POSIX process group.");
  }
  if (await waitForProcessGroupExit(pid, GRACEFUL_STOP_MS)) return confirmOwnedMainExit(owned);
  signalProcessGroup(pid, "SIGTERM");
  if (await waitForProcessGroupExit(pid, TERMINATION_STOP_MS)) return confirmOwnedMainExit(owned);
  signalProcessGroup(pid, "SIGKILL");
  if (await waitForProcessGroupExit(pid, FORCED_STOP_MS)) return confirmOwnedMainExit(owned);
  throw new Error("Open Wrangler could not confirm that its R process group exited.");
}

async function confirmOwnedMainExit(owned: OwnedProcess): Promise<void> {
  if (await waitForClose(owned, FORCED_STOP_MS)) return;
  throw new Error("Open Wrangler could not confirm that its owned Rscript process exited.");
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error;
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(PROCESS_GROUP_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return true;
}

async function waitForClose(owned: OwnedProcess, timeoutMs: number): Promise<boolean> {
  if (owned.closeState) return true;
  await Promise.race([owned.closed, delay(timeoutMs)]);
  return owned.closeState !== undefined;
}

function processClosedError(owned: OwnedProcess): Error {
  if (owned.spawnError) return new Error(`Open Wrangler could not start Rscript: ${owned.spawnError.message}`);
  const detail = owned.closeState?.signal
    ? `signal ${owned.closeState.signal}`
    : `exit ${owned.closeState?.code ?? "unknown"}`;
  return new Error(`The Open Wrangler R process stopped unexpectedly (${detail}).`);
}

function isCorrelatedClose(response: RKernelResponse, sessionId: string): boolean {
  return (
    (response.kind === "closed" && response.sessionId === sessionId) ||
    (response.kind === "error" && response.code === "unknown_session")
  );
}

function requestTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2_147_483_647) {
    throw new TypeError("R process timeout is outside the supported integer range.");
  }
  return timeout;
}

function remainingTimeout(timeoutMs: number, started: number): number {
  return Math.max(0, timeoutMs - (performance.now() - started));
}

function requestDetachedMessage(reason: DetachedBridgeRequestReason, timeoutMs: number): string {
  return reason === "timeout"
    ? `Open Wrangler stopped waiting after ${timeoutMs} ms; the R request is still finishing.`
    : "Open Wrangler stopped waiting after host cancellation; the R request is still finishing.";
}

function startupDetachedMessage(reason: DetachedBridgeRequestReason, timeoutMs: number): string {
  return reason === "timeout"
    ? `Open Wrangler stopped waiting after ${timeoutMs} ms; the R document is still loading.`
    : "Open Wrangler stopped waiting after host cancellation; the R document is still loading.";
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

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isNoSuchProcess(error: unknown): boolean {
  return isRecord(error) && error.code === "ESRCH";
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
