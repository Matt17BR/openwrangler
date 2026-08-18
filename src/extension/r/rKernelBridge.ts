import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import {
  PROTOCOL_VERSION,
  type OpenSessionRequest,
  type OpenWranglerRequest,
  type OpenWranglerResponse
} from "../../shared/protocol";
import { DetachedBridgeRequestError, type BridgeRequestOptions, type OpenWranglerBridge } from "../dataBridge";
import { beginAtomicFileTransaction } from "../files/safeFileExport";
import { RKernelDiagnosticError, RKernelSessionTransport } from "./rKernelTransport";
import type { RKernelBridgeTransport } from "./rKernelBridgeTransport";
import { RKernelDataExport, type RKernelBridgeFileOperations } from "./rKernelDataExport";
import { RKernelMutationLifecycle } from "./rKernelMutationLifecycle";
import { RKernelStepInspection } from "./rKernelStepInspection";
import {
  R_BRIDGE_CAPABILITIES,
  diagnosticResponse,
  errorResponse,
  isExportableRSource,
  kernelChangedError,
  metadataFor,
  sessionFromContract,
  transportOptions,
  unknownSessionError,
  unsupportedRequest,
  validateOpenRequest,
  withHostSessionIdentity,
  type RBridgeSession
} from "./rKernelBridgeContract";
import {
  emptyRViewQuery,
  gridPageFromRContract as gridPageFromContract,
  rPageWindow as pageWindow
} from "./rKernelFrameMapping";
import { RKernelReadQueries } from "./rKernelReadQueries";
import {
  claimVerifiedRNotebookVariableSelection,
  type RNotebookVariableDescriptor,
  type VerifiedRNotebookVariableSelection
} from "./rNotebookVariableDiscovery";

const CLOSED_SESSION_LIMIT = 1_024;

/**
 * Adapts the native-R kernel contract to protocol v2 without converting the
 * dataframe through Python.
 */
export class RKernelBridge implements OpenWranglerBridge {
  private readonly transport: RKernelBridgeTransport;
  private readonly readQueries: RKernelReadQueries;
  private readonly dataExport: RKernelDataExport;
  private readonly mutations: RKernelMutationLifecycle;
  private readonly stepInspection: RKernelStepInspection;
  private readonly invalidationSubscription: vscode.Disposable;
  private readonly sessions = new Map<string, RBridgeSession>();
  private readonly openingSessionIds = new Set<string>();
  private readonly closeOperations = new Map<string, Promise<OpenWranglerResponse>>();
  private readonly closedSessionIds = new Set<string>();
  private readonly diagnosticSink: (message: string) => void;
  private readonly runtimeVersion: string;
  private kernelGeneration = 0;
  private idleRequested = false;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  static fromVerifiedSelection(
    context: vscode.ExtensionContext,
    notebookDocument: vscode.NotebookDocument,
    verifiedSelection: VerifiedRNotebookVariableSelection,
    diagnosticSink?: (message: string) => void
  ): RKernelBridge {
    const binding = claimVerifiedRNotebookVariableSelection(notebookDocument, verifiedSelection);
    try {
      const transport = new RKernelSessionTransport(context, notebookDocument, randomUUID, randomUUID(), binding);
      return new RKernelBridge(context, transport, randomUUID, diagnosticSink, binding.variable);
    } catch (error) {
      binding.dispose();
      throw error;
    }
  }

  constructor(
    context: vscode.ExtensionContext,
    transport: RKernelBridgeTransport,
    private readonly createSessionId: () => string = randomUUID,
    diagnosticSink?: (message: string) => void,
    private readonly verifiedVariable?: RNotebookVariableDescriptor,
    fileOperations: RKernelBridgeFileOperations = {}
  ) {
    this.transport = transport;
    this.readQueries = new RKernelReadQueries(transport, this.sessions);
    this.mutations = new RKernelMutationLifecycle(transport, this.sessions);
    this.dataExport = new RKernelDataExport(
      transport,
      this.sessions,
      fileOperations.beginTransaction ?? beginAtomicFileTransaction,
      () => this.disposed,
      () => this.kernelGeneration
    );
    this.stepInspection = new RKernelStepInspection(transport, this.sessions);
    this.diagnosticSink = diagnosticSink ?? ((message) => appendRDiagnostic(context, message));
    const version = context.extension?.packageJSON?.version;
    this.runtimeVersion = typeof version === "string" && version.length > 0 ? version : "0.0.0";
    this.invalidationSubscription = transport.onDidInvalidateKernel(() => {
      this.kernelGeneration += 1;
      for (const session of this.sessions.values()) session.invalidated = true;
    });
  }

  async request(request: OpenWranglerRequest, options: BridgeRequestOptions = {}): Promise<OpenWranglerResponse> {
    if (this.disposed) throw new Error("The Open Wrangler R bridge has been disposed.");
    this.idleRequested = false;

    switch (request.kind) {
      case "initialize":
        return {
          kind: "initialized",
          protocolVersion: PROTOCOL_VERSION,
          runtimeVersion: this.runtimeVersion,
          capabilities: R_BRIDGE_CAPABILITIES
        };
      case "openSession":
        return this.openSession(withHostSessionIdentity(request, this.createSessionId), options);
      case "getPage":
        return this.readQueries.getPage(request, options);
      case "getSummary":
        return this.readQueries.getSummary(request, options);
      case "getDatasetStats":
        return this.readQueries.getDatasetStats(request, options);
      case "getColumnValues":
        return this.readQueries.getColumnValues(request, options);
      case "previewStep":
        return this.mutations.previewStep(request, options);
      case "applyDraft":
      case "discardDraft":
      case "undoStep":
        return this.mutations.updatePlan(request, options);
      case "inspectStep":
        return this.stepInspection.inspectStep(request, options);
      case "exportData":
        return this.dataExport.exportData(request, options);
      case "closeSession":
        return this.closeSession(request.sessionId, options);
      default:
        return unsupportedRequest(request);
    }
  }

  onIdle(): void {
    this.idleRequested = true;
    this.releaseIdleStateIfSafe();
  }

  reportDiagnostic(message: string): void {
    try {
      this.diagnosticSink(message);
    } catch {
      // Diagnostics must not change a request or cleanup outcome.
    }
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true;
      this.invalidationSubscription.dispose();
      this.disposal = this.disposeOnce();
    }
    return this.disposal;
  }

  private async openSession(request: OpenSessionRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const invalid = validateOpenRequest(request);
    if (invalid) return invalid;
    const sessionId = request.requestedSessionId as string;
    const cloneSource = request.cloneFrom ? this.sessions.get(request.cloneFrom.sessionId) : undefined;
    if (
      request.cloneFrom &&
      (!cloneSource ||
        cloneSource.revision !== request.cloneFrom.revision ||
        cloneSource.invalidated ||
        cloneSource.mode !== (request.mode ?? cloneSource.mode) ||
        !isDeepStrictEqual(cloneSource.source, request.source))
    ) {
      return errorResponse(
        "stale_clone_source",
        "The confirmed R source session changed before its private replay candidate could open.",
        true,
        sessionId
      );
    }
    if (this.verifiedVariable && request.source.variableName !== this.verifiedVariable.name) {
      return errorResponse(
        "r_variable_changed",
        "The R variable no longer matches the selected dataframe.",
        true,
        sessionId
      );
    }
    if (
      this.sessions.has(sessionId) ||
      this.openingSessionIds.has(sessionId) ||
      this.closeOperations.has(sessionId) ||
      this.closedSessionIds.has(sessionId)
    ) {
      return errorResponse("duplicate_session", `R session ${sessionId} is already in use.`, false, sessionId);
    }

    this.openingSessionIds.add(sessionId);
    const generation = this.kernelGeneration;
    try {
      const result = await this.transport.open(
        request.source.variableName as string,
        pageWindow(0, request.pageSize, request.columnOffset, request.columnLimit, emptyRViewQuery()),
        transportOptions(options, sessionId, request.cloneFrom)
      );
      if (generation !== this.kernelGeneration) {
        return kernelChangedError(sessionId);
      }
      if (result.sessionId !== sessionId) {
        throw new Error("The R kernel returned a different session identity from the host-owned identity.");
      }
      if (this.verifiedVariable && result.page.dataframeFlavor !== this.verifiedVariable.dataframeFlavor) {
        throw new Error("The selected R dataframe changed before Open Wrangler opened it.");
      }
      const session = sessionFromContract(
        sessionId,
        request.source,
        request.mode ?? "viewing",
        result.page,
        isExportableRSource(request.source) && this.transport.exportData !== undefined ? result.exportFormats : []
      );
      this.sessions.set(sessionId, session);
      return {
        kind: "sessionOpened",
        metadata: metadataFor(session),
        page: gridPageFromContract(result.page),
        summaries: []
      };
    } catch (error) {
      if (generation !== this.kernelGeneration) return kernelChangedError(sessionId);
      if (error instanceof RKernelDiagnosticError) return diagnosticResponse(error, sessionId);
      throw error;
    } finally {
      this.openingSessionIds.delete(sessionId);
    }
  }

  private async closeSession(sessionId: string, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const existingClose = this.closeOperations.get(sessionId);
    if (existingClose) return existingClose;
    if (this.closedSessionIds.has(sessionId)) return { kind: "sessionClosed", sessionId };
    const session = this.sessions.get(sessionId);
    if (!session) return unknownSessionError(sessionId);

    const completion = this.closeSessionOnce(session, options);
    this.closeOperations.set(sessionId, completion);
    try {
      return await completion;
    } finally {
      this.closeOperations.delete(sessionId);
    }
  }

  private async closeSessionOnce(
    session: RBridgeSession,
    options: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    const sessionId = session.sessionId;
    // A kernel restart retires its process-local mapping, but a detached
    // mutation only invalidates the bridge view while the transport still
    // owns the live session. The latter must receive a real terminal close.
    if (session.invalidated && !this.transport.isSessionMapped(sessionId)) {
      this.sessions.delete(sessionId);
      this.rememberClosedSession(sessionId);
      return { kind: "sessionClosed", sessionId };
    }

    try {
      await this.transport.close(sessionId, {
        timeoutMs: options.timeoutMs,
        cancellation: options.cancellation
      });
      this.sessions.delete(sessionId);
      this.rememberClosedSession(sessionId);
      return { kind: "sessionClosed", sessionId };
    } catch (error) {
      if (error instanceof DetachedBridgeRequestError) this.observeDetachedClose(sessionId, error);
      if (error instanceof RKernelDiagnosticError) return diagnosticResponse(error, sessionId);
      throw error;
    }
  }

  private observeDetachedClose(sessionId: string, detached: DetachedBridgeRequestError): void {
    void detached.settlement.then(() => {
      if (this.disposed || !this.sessions.has(sessionId)) return;
      if (this.transport.isSessionMapped(sessionId)) {
        this.reportDiagnostic(
          `Open Wrangler could not confirm the late R kernel close for session ${sessionId}; the exact kernel mapping remains retained.`
        );
        return;
      }
      this.sessions.delete(sessionId);
      this.rememberClosedSession(sessionId);
      this.releaseIdleStateIfSafe();
    });
  }

  private rememberClosedSession(sessionId: string): void {
    this.closedSessionIds.add(sessionId);
    while (this.closedSessionIds.size > CLOSED_SESSION_LIMIT) {
      const oldest = this.closedSessionIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.closedSessionIds.delete(oldest);
    }
  }

  private async disposeOnce(): Promise<void> {
    await Promise.allSettled([...this.closeOperations.values()]);
    this.sessions.clear();
    this.openingSessionIds.clear();
    await this.transport.dispose();
  }

  private releaseIdleStateIfSafe(): void {
    if (
      !this.idleRequested ||
      this.disposed ||
      this.sessions.size > 0 ||
      this.openingSessionIds.size > 0 ||
      this.closeOperations.size > 0
    ) {
      return;
    }
    // Transport disposal waits for accepted work and owns its exact-kernel
    // terminal cleanup. Keep failures visible in the R diagnostics channel.
    void this.dispose().catch((error: unknown) => {
      this.reportDiagnostic(
        `Open Wrangler could not finish R kernel cleanup: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
}

let rDiagnosticOutput: vscode.OutputChannel | undefined;

function appendRDiagnostic(context: vscode.ExtensionContext, message: string): void {
  if (!rDiagnosticOutput) {
    rDiagnosticOutput = vscode.window.createOutputChannel("Open Wrangler R");
    context.subscriptions.push(rDiagnosticOutput);
  }
  rDiagnosticOutput.appendLine(message);
}
