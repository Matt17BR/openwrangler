import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import type { Jupyter, Kernel, KernelStatus } from "@vscode/jupyter-extension";
import * as vscode from "vscode";
import type {
  DataBackend,
  OpenSessionRequest,
  OpenWranglerRequest,
  OpenWranglerResponse,
  RuntimeRequestEnvelope
} from "../../shared/protocol";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import { isRuntimeResponseEnvelope } from "../../shared/protocolValidation";
import type { SessionOpenProgressStage } from "../../shared/sessionOpenProgress";
import {
  DetachedBridgeRequestError,
  type BridgeRequestOptions,
  type DetachedBridgeRequestReason,
  type OpenWranglerBridge
} from "../dataBridge";
import { KernelRequestCancelledError, RestartableKernel, withKernelTimeout } from "./kernelLifecycle";
import { buildKernelBootstrapCode, readRuntimeFiles } from "./kernelRuntimeBundle";
import { getSetting, runtimeRequestTimeoutMs } from "../configuration";
import { isSoleOpenNotebookDocument } from "./notebookProvenance";
import {
  assertSupportedPySparkNotebookPreflight,
  buildPySparkNotebookPreflightCode,
  parsePySparkNotebookPreflightOutput
} from "./notebookVariableDiscovery";
import {
  copySessionSource,
  exportPythonDataSafely,
  type SafePythonDataExportOptions
} from "../files/safePythonDataExport";

const NOTEBOOK_FORMATTER_REPORTING_TIMEOUT_MS = 30_000;
const NOTEBOOK_CELL_RESULT_PROTOCOL_VERSION = 1;
const NOTEBOOK_CELL_RESULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const NOTEBOOK_CELL_RESULT_TEXT_LIMIT = 256;
const NOTEBOOK_CELL_RESULT_PROBE_TIMEOUT_MS = 10_000;

export interface CapturedNotebookCellResult {
  readonly backend: "pandas" | "polars" | "duckdb" | "pyspark";
  readonly label: string;
  readonly variableName: string;
}

export interface ExecutedNotebookCellResultBinding extends vscode.Disposable {
  readonly backend: CapturedNotebookCellResult["backend"];
  readonly kernel: Kernel;
  readonly onDidInvalidate: vscode.Event<void>;
  isValid(): boolean;
}

export interface ObservedNotebookCellResultKernel extends vscode.Disposable {
  readonly kernel: Kernel;
  readonly onDidInvalidate: vscode.Event<void>;
  isGenerationValid(): boolean;
}

export interface KernelBridgeFileOperations {
  readonly beginTransaction?: SafePythonDataExportOptions["beginTransaction"];
}

export type NotebookFormatterPreparationSettlement =
  | { readonly kind: "prepared" }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "generationChanged" };

export class NotebookFormatterPreparationPendingError extends Error {
  constructor(readonly settlement: Promise<NotebookFormatterPreparationSettlement>) {
    super(
      `Open Wrangler kernel request timed out after ${NOTEBOOK_FORMATTER_REPORTING_TIMEOUT_MS} ms; formatter preparation is still settling.`
    );
    this.name = "NotebookFormatterPreparationPendingError";
  }
}

export class KernelBridge implements OpenWranglerBridge {
  private readonly lifecycle: RestartableKernel<AcquiredKernel>;
  private readonly bootstrapCode: string;
  private readonly sessionKernels = new Map<string, Kernel>();
  private readonly sessionSources = new Map<string, OpenSessionRequest["source"]>();
  private readonly retiredSessionIds = new Set<string>();
  private cleanupAttempts = new WeakMap<Kernel, Map<string, Promise<boolean>>>();
  private kernelObservation: KernelObservation | undefined;
  private lifecycleVersion = 0;
  private idleRequested = false;
  private readonly detachedKernelOperations = new Set<Promise<unknown>>();
  private formatterPreparation: FormatterPreparation | undefined;
  private readonly notebookUri: vscode.Uri;
  private readonly kernelInvalidatedEmitter = new vscode.EventEmitter<void>();
  readonly onDidInvalidateKernel = this.kernelInvalidatedEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly notebookDocument: vscode.NotebookDocument,
    private readonly registerNotebookFormatters = true,
    private readonly fileOperations: KernelBridgeFileOperations = {}
  ) {
    this.notebookUri = notebookDocument.uri;
    this.lifecycle = new RestartableKernel(() => this.acquireKernel());
    this.bootstrapCode = buildKernelBootstrapCode(readRuntimeFiles(path.join(this.context.extensionPath, "python")));
  }

  onIdle(): void {
    this.idleRequested = true;
    // The user's kernel remains owned by Jupyter; Open Wrangler only releases
    // its cached generation and bootstrap state after its final session closes.
    // Coordinator shutdown can reach its outer deadline while an accepted
    // request is still settling. Keep exact-kernel ownership in that case so
    // the delayed terminal close cannot reacquire by notebook URI.
    this.releaseIdleStateIfSafe();
  }

  private releaseIdleStateIfSafe(): void {
    if (!this.idleRequested || this.sessionKernels.size > 0 || this.detachedKernelOperations.size > 0) return;
    this.invalidateLifecycle();
    this.sessionKernels.clear();
    this.sessionSources.clear();
    this.retiredSessionIds.clear();
    this.cleanupAttempts = new WeakMap();
  }

  async prepareNotebookFormatter(): Promise<void> {
    if (!this.registerNotebookFormatters) return;
    this.assertNotebookProvenance();
    const preparation = this.currentFormatterPreparation();
    if (preparation.reportingDeadlineExpired) {
      throw new NotebookFormatterPreparationPendingError(preparation.settlement);
    }
    // This is a reporting deadline only. RestartableKernel retains the exact
    // acquisition/bootstrap promise. Expose its settlement identity when the
    // deadline expires so the coordinator parks instead of repeatedly joining
    // one uncancelled execution and accumulating host timers/listeners.
    let reportingDeadlineExpired = false;
    try {
      await withKernelTimeout(preparation.completion, NOTEBOOK_FORMATTER_REPORTING_TIMEOUT_MS, () => {
        reportingDeadlineExpired = true;
        preparation.reportingDeadlineExpired = true;
      });
    } catch (error) {
      if (reportingDeadlineExpired) {
        throw new NotebookFormatterPreparationPendingError(preparation.settlement);
      }
      throw error;
    }
    this.assertNotebookProvenance();
  }

  async captureExecutedCellResult(
    executionOrder: number,
    sourceFingerprint: string,
    binding: ExecutedNotebookCellResultBinding
  ): Promise<CapturedNotebookCellResult> {
    if (!Number.isSafeInteger(executionOrder) || executionOrder < 1) {
      throw new Error("Open Wrangler received an invalid notebook execution order.");
    }
    if (!/^[a-f0-9]{64}$/.test(sourceFingerprint)) {
      throw new Error("Open Wrangler received an invalid notebook cell source fingerprint.");
    }
    if (!binding.isValid()) {
      throw new SelectedKernelChangedError(
        "The notebook kernel changed after this cell result was produced. Run the cell again and try again."
      );
    }
    this.idleRequested = false;
    this.assertNotebookProvenance();
    const marker = randomUUID().replaceAll("-", "");
    const operation = this.lifecycle.run(
      async (acquired) => {
        this.assertExecutedCellResultKernel(acquired, binding);
        const observation = this.observeKernelStatus(acquired);
        try {
          // The user explicitly invoked the action, so Jupyter has already
          // granted this extension kernel access. Prepare future rich outputs
          // while linking the result that was produced before preparation.
          await this.ensureKernelAgent(acquired.kernel, this.registerNotebookFormatters);
        } catch (error) {
          this.invalidateLifecycle(observation);
          throw error;
        }
      },
      async (acquired) => {
        this.assertExecutedCellResultKernel(acquired, binding);
        const observation = this.requireKernelObservation(acquired);
        try {
          await this.assertKernelStillSelected(acquired, observation);
          const tokenSource = new vscode.CancellationTokenSource();
          let output: string;
          try {
            output = await kernelOutputsToText(
              acquired.kernel.executeCode(
                buildNotebookCellResultCode(marker, executionOrder, sourceFingerprint),
                tokenSource.token
              ),
              NOTEBOOK_CELL_RESULT_OUTPUT_LIMIT_BYTES
            );
          } finally {
            tokenSource.dispose();
          }
          this.requireKernelObservation(acquired);
          await this.assertKernelStillSelected(acquired, observation);
          const result = parseNotebookCellResult(output, marker);
          if (result.backend !== binding.backend) {
            throw new Error("This notebook result changed dataframe type after it was executed. Run the cell again.");
          }
          return result;
        } catch (error) {
          this.invalidateLifecycle(observation);
          throw error;
        }
      },
      {
        retryAfterDispatch: false,
        shouldRetry: (error, phase) => phase === "bootstrap" && !(error instanceof SelectedKernelChangedError),
        beforeDispatch: (acquired) => {
          this.assertNotebookProvenance();
          this.assertExecutedCellResultKernel(acquired, binding);
        }
      }
    );
    try {
      const result = await withKernelTimeout(operation, runtimeRequestTimeoutMs({ kind: "initialize" }), () => {
        this.trackDetachedKernelOperation(operation);
      });
      this.assertNotebookProvenance();
      return result;
    } catch (error) {
      if (error instanceof KernelRequestCancelledError) this.trackDetachedKernelOperation(operation);
      throw error;
    }
  }

  private assertExecutedCellResultKernel(acquired: AcquiredKernel, binding: ExecutedNotebookCellResultBinding): void {
    if (binding.isValid() && acquired.kernel === binding.kernel) return;
    throw new SelectedKernelChangedError(
      "The notebook kernel changed after this cell result was produced. Run the cell again and try again."
    );
  }

  private currentFormatterPreparation(): FormatterPreparation {
    const existing = this.formatterPreparation;
    if (existing && existing.lifecycleVersion === this.lifecycleVersion) return existing;

    const lifecycleVersion = this.lifecycleVersion;
    let resolveGenerationChanged: () => void = () => undefined;
    const generationChanged = new Promise<NotebookFormatterPreparationSettlement>((resolve) => {
      resolveGenerationChanged = () => resolve({ kind: "generationChanged" });
    });
    const completion = (async () => {
      await this.lifecycle.run(
        async (acquired) => {
          this.observeKernelStatus(acquired);
          await this.ensureKernelAgent(acquired.kernel, true);
        },
        async () => undefined,
        {
          retryAfterDispatch: true,
          shouldRetry: (_error, phase) => phase !== "acquire" && phase !== "beforeDispatch",
          beforeDispatch: () => this.assertNotebookProvenance()
        }
      );
      this.assertNotebookProvenance();
    })();
    const settlement = Promise.race([
      completion.then<NotebookFormatterPreparationSettlement, NotebookFormatterPreparationSettlement>(
        () => ({ kind: "prepared" }),
        (error: unknown) => ({ kind: "failed", error })
      ),
      generationChanged
    ]);
    const preparation: FormatterPreparation = {
      lifecycleVersion,
      completion,
      settlement,
      resolveGenerationChanged,
      reportingDeadlineExpired: false
    };
    this.formatterPreparation = preparation;
    void completion
      .finally(() => {
        if (this.formatterPreparation === preparation) this.formatterPreparation = undefined;
      })
      .catch(() => undefined);
    return preparation;
  }

  dispose(): void {
    this.onIdle();
    this.kernelInvalidatedEmitter.dispose();
  }

  async request(request: OpenWranglerRequest, options: BridgeRequestOptions = {}): Promise<OpenWranglerResponse> {
    if (request.kind === "exportData") return this.exportData(request, options);
    return this.requestRuntime(request, options);
  }

  private async exportData(
    request: Extract<OpenWranglerRequest, { kind: "exportData" }>,
    options: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    const source = this.sessionSources.get(request.sessionId);
    if (!source) {
      return {
        kind: "error",
        code: "unknown_session",
        message: `Open Wrangler kernel session ${request.sessionId} is not available.`,
        recoverable: true,
        sessionId: request.sessionId
      };
    }
    return exportPythonDataSafely({
      request,
      source,
      beginTransaction: this.fileOperations.beginTransaction,
      dispatch: async (runtimeRequest) => {
        if (this.sessionSources.get(request.sessionId) !== source) {
          return {
            kind: "error",
            code: "unknown_session",
            message: `Open Wrangler kernel session ${request.sessionId} is not available.`,
            recoverable: true,
            sessionId: request.sessionId
          };
        }
        const response = await this.requestRuntime(runtimeRequest, options);
        if (response.kind === "dataExported" && this.sessionSources.get(request.sessionId) !== source) {
          throw new Error("The Python notebook session closed or changed before cleaned data could be published.");
        }
        return response;
      }
    });
  }

  private async requestRuntime(
    request: OpenWranglerRequest,
    options: BridgeRequestOptions = {}
  ): Promise<OpenWranglerResponse> {
    this.idleRequested = false;
    const runtimeRequest = withKernelSessionIdentity(request);
    if (runtimeRequest.kind === "closeSession") {
      const kernel = this.sessionKernels.get(runtimeRequest.sessionId);
      if (kernel) return this.closeMappedSession(runtimeRequest, kernel, options);
      if (this.retiredSessionIds.has(runtimeRequest.sessionId) || options.startRuntimeIfNeeded === false) {
        return {
          kind: "error",
          code: "unknown_session",
          message: `Open Wrangler already attempted to close kernel session ${runtimeRequest.sessionId}.`,
          recoverable: true,
          sessionId: runtimeRequest.sessionId
        };
      }
    }
    if (options.cancellation?.isCancellationRequested) {
      if (runtimeRequest.kind === "openSession") return cancelledSessionOpenResponse();
      throw new DetachedBridgeRequestError(
        detachedRequestMessage("cancellation", runtimeRequestTimeoutMs(runtimeRequest, options.timeoutMs)),
        "cancellation",
        false,
        Promise.resolve()
      );
    }
    let requiredKernel: Kernel | undefined;
    if (options.requiredKernelSessionId !== undefined) {
      if (runtimeRequest.kind !== "openSession" || options.requiredKernelSessionId.length === 0) {
        throw new Error("Exact-kernel recovery requires one live-session open and one mapped session identity.");
      }
      requiredKernel = this.sessionKernels.get(options.requiredKernelSessionId);
      if (!requiredKernel) {
        throw new Error("The originating notebook kernel is no longer mapped for live-source recovery.");
      }
    }
    const assertRequiredKernel = (acquired: AcquiredKernel): void => {
      if (requiredKernel && acquired.kernel !== requiredKernel) {
        throw new SelectedKernelChangedError(
          "The notebook kernel changed before Open Wrangler could recover the live variable on its originating kernel."
        );
      }
    };
    const assertKernelStillSelectedForRequest = async (
      acquired: AcquiredKernel,
      observation: KernelObservation
    ): Promise<void> => {
      try {
        await this.assertKernelStillSelected(acquired, observation);
      } catch (error) {
        if (requiredKernel && error instanceof SelectedKernelChangedError) {
          throw new SelectedKernelChangedError(
            "The notebook kernel changed before Open Wrangler could recover the live variable on its originating kernel."
          );
        }
        throw error;
      }
    };
    const isCleanup = runtimeRequest.kind === "closeSession";
    if (!isCleanup) this.assertNotebookProvenance();
    const reportsNotebookOpenProgress =
      runtimeRequest.kind === "openSession" && runtimeRequest.source.kind === "notebookVariable";
    if (runtimeRequest.kind === "openSession") {
      this.assertSessionIdentityAvailable(runtimeRequest.requestedSessionId);
    }
    let framed = frameKernelRequest(runtimeRequest, requestPriority(runtimeRequest, options));
    const timeoutMs = runtimeRequestTimeoutMs(runtimeRequest, options.timeoutMs);
    let requestObservation: KernelObservation | undefined;
    const requestLifecycleVersion = this.lifecycleVersion;
    let requestDispatched = false;
    let bootstrapSettlement: Promise<void> | undefined;
    let hostDetachReason: DetachedBridgeRequestReason | undefined;
    const detach = (reason: DetachedBridgeRequestReason): void => {
      hostDetachReason = reason;
      // A timed-out acquisition must not trap future cleanup requests behind the
      // same hung promise. Once this request has observed a kernel, invalidate
      // only that exact observation. Before observation, the captured lifecycle
      // version prevents a detached old acquisition from clearing a replacement.
      if (!bootstrapSettlement && !requestDispatched) {
        this.invalidateLifecycle(requestObservation, requestLifecycleVersion);
      }
    };
    let mismatchedRuntimeId: string | undefined;
    let cleanupMismatchedRuntimeId = false;
    let openKernel: Kernel | undefined;
    let operation: Promise<OpenWranglerResponse> | undefined;
    try {
      if (reportsNotebookOpenProgress) reportOpenProgress(options, "acquiringKernel");
      operation = this.lifecycle.run(
        async (acquired) => {
          assertRequiredKernel(acquired);
          const observation = this.observeKernelStatus(acquired);
          requestObservation = observation;
          try {
            if (reportsNotebookOpenProgress) reportOpenProgress(options, "bootstrappingRuntime");
            await this.ensureKernelAgent(acquired.kernel, this.registerNotebookFormatters);
          } catch (error) {
            this.invalidateLifecycle(observation);
            throw error;
          }
        },
        async (acquired) => {
          assertRequiredKernel(acquired);
          const observation = this.requireKernelObservation(acquired);
          requestObservation = observation;
          try {
            if (hostDetachReason) throw new KernelRequestCancelledError();
            if (runtimeRequest.kind === "openSession") {
              this.assertSessionIdentityAvailable(runtimeRequest.requestedSessionId);
              openKernel = acquired.kernel;
              this.sessionKernels.set(runtimeRequest.requestedSessionId, acquired.kernel);
            }
            requestDispatched = true;
            const response = await this.executeFramedRequest(acquired.kernel, framed);
            // Capture a wrong runtime identity before RestartableKernel performs
            // its post-execution generation check. A host detach can make that
            // check reject even though the kernel returned a committed open.
            if (
              runtimeRequest.kind === "openSession" &&
              response.kind === "sessionOpened" &&
              response.metadata.sessionId !== runtimeRequest.requestedSessionId
            ) {
              mismatchedRuntimeId = response.metadata.sessionId;
              const existingKernel = this.sessionKernels.get(mismatchedRuntimeId);
              cleanupMismatchedRuntimeId = existingKernel !== acquired.kernel;
              if (!existingKernel) this.sessionKernels.set(mismatchedRuntimeId, acquired.kernel);
            }
            return response;
          } catch (error) {
            this.invalidateLifecycle(observation);
            throw error;
          }
        },
        {
          retryAfterDispatch: isIdempotentKernelReadRequest(runtimeRequest),
          shouldRetry: (error, phase) =>
            hostDetachReason === undefined &&
            !(requiredKernel && error instanceof SelectedKernelChangedError) &&
            phase !== "acquire" &&
            (phase !== "beforeDispatch" || error instanceof SelectedKernelChangedError),
          onBootstrapPending: (settlement) => {
            bootstrapSettlement = settlement;
            // A rejected bootstrap may be retried on a fresh lifecycle
            // generation. Do not let the settled promise from the failed
            // generation make a later acquisition look like it still owns an
            // in-flight kernel execution. Keep the successful promise marked
            // through beforeDispatch so host detachment cannot invalidate the
            // shared, freshly bootstrapped generation in that narrow window.
            void settlement.catch(() => {
              if (bootstrapSettlement === settlement) bootstrapSettlement = undefined;
            });
          },
          beforeDispatch: async (acquired) => {
            // Qualification belongs only to this exact observed kernel. A
            // superseded attempt may have narrowed an automatic open to
            // PySpark, so always restore the caller's original framing before
            // inspecting the replacement generation.
            framed = frameKernelRequest(runtimeRequest, requestPriority(runtimeRequest, options));
            assertRequiredKernel(acquired);
            const observation = this.requireKernelObservation(acquired);
            requestObservation = observation;
            if (hostDetachReason) throw new KernelRequestCancelledError();
            if (!isCleanup) this.assertNotebookProvenance();
            if (reportsNotebookOpenProgress && runtimeRequest.kind === "openSession") {
              let isPySpark = runtimeRequest.backend === "pyspark";
              if (runtimeRequest.backend === undefined || runtimeRequest.backend === "pyspark") {
                const variableName = runtimeRequest.source.variableName;
                if (!variableName) {
                  throw new Error("Open Wrangler received a notebook-variable source without a variable name.");
                }
                await assertKernelStillSelectedForRequest(acquired, observation);
                const preflight = await this.executePySparkNotebookPreflight(
                  acquired.kernel,
                  variableName,
                  runtimeRequest.backend
                );
                this.requireKernelObservation(acquired);
                await assertKernelStillSelectedForRequest(acquired, observation);
                isPySpark = assertSupportedPySparkNotebookPreflight(preflight, runtimeRequest.backend);
                if (isPySpark && runtimeRequest.backend === undefined) {
                  framed = frameKernelRequest(
                    { ...runtimeRequest, backend: "pyspark" },
                    requestPriority(runtimeRequest, options)
                  );
                }
              }
              reportOpenProgress(options, isPySpark ? "preparingSparkView" : "openingNotebookVariable");
            }
          }
        }
      );
      // Jupyter cancellation interrupts the whole Python kernel. If PySpark
      // has installed its default SIGINT handler, that interrupt calls
      // SparkContext.cancelAllJobs() even when this request targets Pandas or
      // Polars. Host deadlines and cancellation therefore detach only the host
      // waiter; they never cancel the executeCode token or masquerade as
      // transport loss. A detached open is closed on its exact kernel below.
      const response = await withKernelTimeout(
        operation,
        timeoutMs,
        () => detach("timeout"),
        options.cancellation,
        () => detach("cancellation")
      );
      if (!isCleanup) this.assertNotebookProvenance();
      if (runtimeRequest.kind === "openSession") {
        if (response.kind !== "sessionOpened") {
          // A logical error or cancellation is not proof that the open never
          // committed. The kernel may have registered the candidate before its
          // final response was replaced, so close the host-known identity just
          // as we do for transport and parsing failures.
          const cleanupConfirmed = openKernel
            ? await this.cleanupFailedOpen(runtimeRequest.requestedSessionId, openKernel)
            : false;
          if (response.kind === "cancelled" && !cleanupConfirmed) {
            return indeterminateSessionOpenResponse("cancellation");
          }
        } else if (mismatchedRuntimeId) {
          throw new Error(
            "Open Wrangler kernel returned a session identity that did not match the requested identity."
          );
        } else {
          this.sessionSources.set(runtimeRequest.requestedSessionId, copySessionSource(runtimeRequest.source));
        }
      }
      return response;
    } catch (error) {
      // RestartableKernel already detaches failed bootstrap/execute generations.
      // Detach a surviving before-dispatch/provenance generation only when it
      // is still the exact observation used by this request. A late failure
      // must never clear a newer concurrent generation.
      if (requestObservation && (!hostDetachReason || (!bootstrapSettlement && !requestDispatched))) {
        this.invalidateLifecycle(requestObservation);
      }
      if (runtimeRequest.kind === "openSession") {
        if (hostDetachReason && !requestDispatched) {
          if (bootstrapSettlement && operation) this.trackDetachedKernelOperation(operation);
          return cancelledSessionOpenResponse();
        }
        if (hostDetachReason && requestDispatched && openKernel && operation) {
          this.cleanupFailedOpenAfterSettlement(runtimeRequest.requestedSessionId, openKernel, operation, () =>
            cleanupMismatchedRuntimeId ? mismatchedRuntimeId : undefined
          );
          return indeterminateSessionOpenResponse(hostDetachReason);
        }
        if (error instanceof KernelRequestCancelledError) {
          if (!requestDispatched) return cancelledSessionOpenResponse();
          const cleanupConfirmed = openKernel
            ? await this.cleanupFailedOpen(runtimeRequest.requestedSessionId, openKernel)
            : false;
          return cleanupConfirmed ? cancelledSessionOpenResponse() : indeterminateSessionOpenResponse("cancellation");
        }
        if (openKernel) {
          await this.cleanupFailedOpen(runtimeRequest.requestedSessionId, openKernel);
          if (mismatchedRuntimeId && cleanupMismatchedRuntimeId) {
            await this.cleanupFailedOpen(mismatchedRuntimeId, openKernel);
          }
        }
      }
      if (hostDetachReason && operation) {
        throw new DetachedBridgeRequestError(
          detachedRequestMessage(hostDetachReason, timeoutMs),
          hostDetachReason,
          requestDispatched,
          observeSettlement(operation)
        );
      }
      throw error;
    }
  }

  private cleanupFailedOpenAfterSettlement(
    sessionId: string,
    kernel: Kernel,
    settlement: Promise<OpenWranglerResponse>,
    mismatchedSessionId: () => string | undefined
  ): void {
    const cleanup = observeSettlement(settlement).then(async () => {
      await this.cleanupFailedOpen(sessionId, kernel);
      const mismatched = mismatchedSessionId();
      if (mismatched) await this.cleanupFailedOpen(mismatched, kernel);
    });
    void cleanup.catch(() => undefined);
  }

  private trackDetachedKernelOperation(operation: Promise<unknown>): void {
    if (this.detachedKernelOperations.has(operation)) return;
    this.detachedKernelOperations.add(operation);
    void observeSettlement(operation).then(() => {
      this.detachedKernelOperations.delete(operation);
      this.releaseIdleStateIfSafe();
    });
  }

  private cleanupFailedOpen(sessionId: string, kernel: Kernel): Promise<boolean> {
    const attempts = this.cleanupAttempts.get(kernel) ?? new Map<string, Promise<boolean>>();
    const existing = attempts.get(sessionId);
    if (existing) return existing;
    const attempt = this.performFailedOpenCleanup(sessionId, kernel);
    attempts.set(sessionId, attempt);
    this.cleanupAttempts.set(kernel, attempts);
    return attempt;
  }

  private async performFailedOpenCleanup(sessionId: string, kernel: Kernel): Promise<boolean> {
    const completion = this.executeExactKernelRequest(
      kernel,
      { kind: "closeSession", sessionId, revision: 0 },
      { priority: "interactive" }
    ).then((response) => {
      const confirmed = isCorrelatedSessionClose(response, sessionId);
      if (confirmed) this.retireMappedSession(sessionId, kernel);
      return confirmed;
    });
    // The host stops waiting after a bounded interval, but it must never turn
    // that bound into a Jupyter interrupt. Keep observing the exact execution
    // so a later correlated close still retires the mapped candidate.
    void completion.catch(() => undefined);
    try {
      return await withKernelTimeout(completion, 2_000, () => undefined);
    } catch {
      return false;
    }
  }

  private async closeMappedSession(
    request: Extract<OpenWranglerRequest, { kind: "closeSession" }>,
    kernel: Kernel,
    options: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    const completion = this.executeExactKernelRequest(kernel, request, options).then((response) => {
      if (isCorrelatedSessionClose(response, request.sessionId)) {
        this.retireMappedSession(request.sessionId, kernel);
      }
      return response;
    });
    // Bound only the host's wait. The kernel execution receives a fresh
    // never-cancel token below, and a correlated late response still retires
    // the mapping even after this caller has timed out.
    void completion.catch(() => undefined);
    const timeoutMs = runtimeRequestTimeoutMs(request, options.timeoutMs);
    let hostDetachReason: DetachedBridgeRequestReason | undefined;
    try {
      return await withKernelTimeout(
        completion,
        timeoutMs,
        () => {
          hostDetachReason = "timeout";
        },
        options.cancellation,
        () => {
          hostDetachReason = "cancellation";
        }
      );
    } catch (error) {
      if (!hostDetachReason) throw error;
      throw new DetachedBridgeRequestError(
        detachedRequestMessage(hostDetachReason, timeoutMs),
        hostDetachReason,
        true,
        observeSettlement(completion)
      );
    }
  }

  private retireMappedSession(sessionId: string, kernel: Kernel): void {
    if (this.sessionKernels.get(sessionId) !== kernel) return;
    this.sessionKernels.delete(sessionId);
    this.sessionSources.delete(sessionId);
    this.retiredSessionIds.add(sessionId);
    this.releaseIdleStateIfSafe();
  }

  private async executeExactKernelRequest(
    kernel: Kernel,
    request: OpenWranglerRequest,
    options: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    const framed = frameKernelRequest(request, requestPriority(request, options));
    // Exact-kernel close is the cleanup path for a detached or failed live
    // open. Interrupting this execution can target unrelated user Spark jobs,
    // so it is allowed to settle naturally on the already-mapped kernel.
    return this.executeFramedRequest(kernel, framed);
  }

  private async executeFramedRequest(kernel: Kernel, framed: FramedKernelRequest): Promise<OpenWranglerResponse> {
    return parseKernelResponse(await this.executePython(kernel, framed.code), framed.marker, framed.requestId);
  }

  private async executePySparkNotebookPreflight(
    kernel: Kernel,
    variableName: string,
    expectedBackend: DataBackend | undefined
  ) {
    const marker = randomUUID().replaceAll("-", "");
    const output = await this.executePython(
      kernel,
      buildPySparkNotebookPreflightCode(marker, variableName, expectedBackend)
    );
    return parsePySparkNotebookPreflightOutput(output, marker);
  }

  private async assertKernelStillSelected(acquired: AcquiredKernel, observation: KernelObservation): Promise<void> {
    this.requireKernelObservation(acquired);
    this.assertNotebookProvenance();
    const selected = await acquired.jupyter.kernels.getKernel(this.notebookUri);
    this.assertNotebookProvenance();
    this.requireKernelObservation(acquired);
    if (selected === acquired.kernel) return;
    this.invalidateLifecycle(observation);
    throw new SelectedKernelChangedError();
  }

  private async ensureKernelAgent(kernel: Kernel, registerNotebookFormatters: boolean): Promise<void> {
    this.assertNotebookProvenance();
    await this.executePython(
      kernel,
      `${this.bootstrapCode}
import openwrangler_runtime.kernel_agent as __ow_kernel_agent
${registerNotebookFormatters ? "import openwrangler_runtime.notebook as __ow_notebook\n__ow_notebook.register_formatters()" : ""}
`
    );
    this.assertNotebookProvenance();
  }

  private async executePython(kernel: Kernel, code: string): Promise<string> {
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      // Jupyter maps cancellation to a whole-kernel SIGINT. With PySpark's
      // default handler installed, that may call SparkContext.cancelAllJobs()
      // and stop unrelated user work even when this request targets Pandas,
      // Polars, or DuckDB. Every execution therefore owns a fresh token that
      // is never cancelled and remains alive until its output settles.
      return await kernelOutputsToText(kernel.executeCode(code, tokenSource.token));
    } finally {
      tokenSource.dispose();
    }
  }

  private async acquireKernel(): Promise<AcquiredKernel> {
    this.assertNotebookProvenance();
    if (!vscode.workspace.isTrusted) {
      throw new Error("Trust this workspace before Open Wrangler accesses a notebook kernel.");
    }

    const jupyter = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
    if (!jupyter) {
      throw new Error("Install or enable the VS Code Jupyter extension to open live notebook dataframes.");
    }
    const api = await jupyter.activate();
    this.assertNotebookProvenance();
    const kernel = await api.kernels.getKernel(this.notebookUri);
    this.assertNotebookProvenance();
    if (!kernel) {
      throw new Error(
        "Select or start a Python kernel, run the cell that defines the dataframe, and choose Open in Open Wrangler again."
      );
    }
    if (kernel.language.toLowerCase() !== "python") {
      throw new Error(`Open Wrangler requires a Python notebook kernel; the selected kernel uses ${kernel.language}.`);
    }
    return { jupyter: api, kernel };
  }

  private observeKernelStatus(acquired: AcquiredKernel): KernelObservation {
    if (acquired.observation) {
      if (this.kernelObservation !== acquired.observation) {
        throw new Error("Open Wrangler kernel generation changed before bootstrap.");
      }
      return acquired.observation;
    }
    this.disposeKernelObservation();
    const observation: KernelObservation = { kernel: acquired.kernel };
    acquired.observation = observation;
    this.kernelObservation = observation;
    try {
      const subscription = acquired.kernel.onDidChangeStatus((status) => {
        if (this.kernelObservation !== observation || !invalidatesKernelLifecycle(status)) return;
        this.invalidateLifecycle(observation);
        this.kernelInvalidatedEmitter.fire();
      });
      observation.subscription = subscription;
      // A conforming VS Code Event does not fire while a listener is registered,
      // but dispose defensively if an implementation did invalidate synchronously.
      if (this.kernelObservation !== observation) {
        subscription.dispose();
        throw new Error("Open Wrangler kernel generation changed while its status observer was registered.");
      }

      const currentStatus = acquired.kernel.status;
      if (!invalidatesKernelLifecycle(currentStatus)) return observation;
      this.invalidateLifecycle(observation);
      throw new Error(`Open Wrangler cannot use the notebook kernel while its status is ${currentStatus}.`);
    } catch (error) {
      this.invalidateLifecycle(observation);
      throw error;
    }
  }

  private requireKernelObservation(acquired: AcquiredKernel): KernelObservation {
    const observation = acquired.observation;
    if (!observation || observation.kernel !== acquired.kernel || this.kernelObservation !== observation) {
      throw new Error("Open Wrangler kernel generation changed before request dispatch.");
    }
    return observation;
  }

  private invalidateLifecycle(expected?: KernelObservation, expectedVersion?: number): void {
    if (expected) {
      if (this.kernelObservation !== expected) return;
    } else if (expectedVersion !== undefined && this.lifecycleVersion !== expectedVersion) {
      return;
    }
    const formatterPreparation = this.formatterPreparation;
    if (formatterPreparation?.lifecycleVersion === this.lifecycleVersion) {
      this.formatterPreparation = undefined;
      formatterPreparation.resolveGenerationChanged();
    }
    this.lifecycleVersion += 1;
    this.lifecycle.invalidate();
    this.disposeKernelObservation(expected);
  }

  private disposeKernelObservation(expected?: KernelObservation): void {
    const observation = this.kernelObservation;
    if (!observation || (expected && observation !== expected)) return;
    this.kernelObservation = undefined;
    observation.subscription?.dispose();
  }

  private assertNotebookProvenance(): void {
    const notebook = this.notebookDocument;
    if (!isSoleOpenNotebookDocument(notebook)) {
      throw new Error("The notebook that originated this Open Wrangler session is no longer open.");
    }
  }

  private assertSessionIdentityAvailable(sessionId: string): void {
    if (this.sessionKernels.has(sessionId)) {
      throw new Error(`Open Wrangler already has a live kernel session named ${sessionId}.`);
    }
    if (this.retiredSessionIds.has(sessionId)) {
      throw new Error(`Open Wrangler has already retired kernel session ${sessionId}.`);
    }
  }
}

class NotebookCellResultKernelBinding implements ExecutedNotebookCellResultBinding, ObservedNotebookCellResultKernel {
  private readonly invalidatedEmitter = new vscode.EventEmitter<void>();
  private readonly statusSubscription: vscode.Disposable;
  private backendValue: CapturedNotebookCellResult["backend"] | undefined;
  private valid = true;
  private disposed = false;

  readonly onDidInvalidate = this.invalidatedEmitter.event;

  constructor(readonly kernel: Kernel) {
    this.statusSubscription = kernel.onDidChangeStatus((status) => {
      if (invalidatesKernelLifecycle(status)) this.invalidate();
    });
    if (invalidatesKernelLifecycle(kernel.status)) this.invalidate();
  }

  get backend(): CapturedNotebookCellResult["backend"] {
    if (this.backendValue === undefined) {
      throw new Error("Open Wrangler inspected an incomplete notebook result binding.");
    }
    return this.backendValue;
  }

  complete(backend: CapturedNotebookCellResult["backend"]): void {
    if (!this.valid) throw new SelectedKernelChangedError();
    this.backendValue = backend;
  }

  isValid(): boolean {
    return this.valid && this.backendValue !== undefined;
  }

  isGenerationValid(): boolean {
    return this.valid;
  }

  invalidate(): void {
    if (!this.valid) return;
    this.valid = false;
    this.invalidatedEmitter.fire();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.valid = false;
    this.statusSubscription.dispose();
    this.invalidatedEmitter.dispose();
  }
}

export async function observeExecutedNotebookCellResultKernel(
  notebook: vscode.NotebookDocument
): Promise<ObservedNotebookCellResultKernel | undefined> {
  if (!vscode.workspace.isTrusted || !isSoleOpenNotebookDocument(notebook)) return undefined;
  const extension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
  if (!extension) return undefined;
  let binding: NotebookCellResultKernelBinding | undefined;
  let retained = false;
  try {
    const api = await extension.activate();
    if (!vscode.workspace.isTrusted || !isSoleOpenNotebookDocument(notebook)) return undefined;
    const kernel = await api.kernels.getKernel(notebook.uri);
    if (
      !kernel ||
      kernel.language.toLowerCase() !== "python" ||
      invalidatesKernelLifecycle(kernel.status) ||
      !isSoleOpenNotebookDocument(notebook)
    ) {
      return undefined;
    }
    binding = new NotebookCellResultKernelBinding(kernel);
    const selected = await api.kernels.getKernel(notebook.uri);
    if (
      !binding.isGenerationValid() ||
      selected !== kernel ||
      !vscode.workspace.isTrusted ||
      !isSoleOpenNotebookDocument(notebook)
    ) {
      binding.dispose();
      return undefined;
    }
    retained = true;
    return binding;
  } catch {
    return undefined;
  } finally {
    if (!retained) binding?.dispose();
  }
}

export async function inspectExecutedNotebookCellResult(
  notebook: vscode.NotebookDocument,
  executionOrder: number,
  sourceFingerprint: string,
  observed: ObservedNotebookCellResultKernel
): Promise<ExecutedNotebookCellResultBinding | undefined> {
  if (
    !Number.isSafeInteger(executionOrder) ||
    executionOrder < 1 ||
    !/^[a-f0-9]{64}$/.test(sourceFingerprint) ||
    !(observed instanceof NotebookCellResultKernelBinding) ||
    !observed.isGenerationValid()
  ) {
    observed.dispose();
    return undefined;
  }
  const tokenSource = new vscode.CancellationTokenSource();
  let detached = false;
  const operation = inspectExecutedNotebookCellResultOnKernel(
    notebook,
    executionOrder,
    sourceFingerprint,
    observed,
    tokenSource.token
  ).finally(() => tokenSource.dispose());
  try {
    return await withKernelTimeout(operation, NOTEBOOK_CELL_RESULT_PROBE_TIMEOUT_MS, () => {
      detached = true;
      observed.dispose();
    });
  } finally {
    if (detached) {
      void operation.then(
        (binding) => binding?.dispose(),
        () => undefined
      );
    }
  }
}

export async function isExecutedNotebookCellResultKernelCurrent(
  notebook: vscode.NotebookDocument,
  binding: ExecutedNotebookCellResultBinding
): Promise<boolean> {
  if (!binding.isValid() || !vscode.workspace.isTrusted || !isSoleOpenNotebookDocument(notebook)) return false;
  const extension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
  if (!extension) return false;
  try {
    const api = await extension.activate();
    if (!binding.isValid() || !isSoleOpenNotebookDocument(notebook)) return false;
    const selected = await api.kernels.getKernel(notebook.uri);
    return binding.isValid() && isSoleOpenNotebookDocument(notebook) && selected === binding.kernel;
  } catch {
    return false;
  }
}

async function inspectExecutedNotebookCellResultOnKernel(
  notebook: vscode.NotebookDocument,
  executionOrder: number,
  sourceFingerprint: string,
  binding: NotebookCellResultKernelBinding,
  token: vscode.CancellationToken
): Promise<ExecutedNotebookCellResultBinding | undefined> {
  if (!binding.isGenerationValid() || !vscode.workspace.isTrusted || !isSoleOpenNotebookDocument(notebook)) {
    binding.dispose();
    return undefined;
  }
  try {
    const extension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
    if (!extension) return undefined;
    const api = await extension.activate();
    if (!binding.isGenerationValid() || !vscode.workspace.isTrusted || !isSoleOpenNotebookDocument(notebook)) {
      return undefined;
    }
    const selectedBeforeProbe = await api.kernels.getKernel(notebook.uri);
    if (selectedBeforeProbe !== binding.kernel || !binding.isGenerationValid()) return undefined;
    const marker = randomUUID().replaceAll("-", "");
    const output = await kernelOutputsToText(
      binding.kernel.executeCode(buildNotebookCellResultProbeCode(marker, executionOrder, sourceFingerprint), token),
      NOTEBOOK_CELL_RESULT_OUTPUT_LIMIT_BYTES
    );
    if (!binding.isGenerationValid()) return undefined;
    if (!vscode.workspace.isTrusted || !isSoleOpenNotebookDocument(notebook)) return undefined;
    const selected = await api.kernels.getKernel(notebook.uri);
    if (selected !== binding.kernel || !isSoleOpenNotebookDocument(notebook)) return undefined;
    const backend = parseNotebookCellResultProbe(output, marker);
    if (backend === undefined) return undefined;
    binding.complete(backend);
    return binding;
  } finally {
    if (!binding.isValid()) binding.dispose();
  }
}

function cancelledSessionOpenResponse(): OpenWranglerResponse {
  return { kind: "cancelled", targetRequestId: "session-open" };
}

function indeterminateSessionOpenResponse(reason: DetachedBridgeRequestReason): OpenWranglerResponse {
  return {
    kind: "error",
    code: "kernel_open_indeterminate",
    message:
      `Open Wrangler stopped waiting for the notebook variable after host ${reason}, but its kernel execution may still be finishing. ` +
      "Cleanup will run only after that exact execution settles. Restart the notebook kernel before trying again if it remains busy.",
    recoverable: true
  };
}

function detachedRequestMessage(reason: DetachedBridgeRequestReason, timeoutMs: number): string {
  return reason === "timeout"
    ? `Open Wrangler stopped waiting after ${timeoutMs} ms; the kernel request is still settling.`
    : "Open Wrangler stopped waiting after host cancellation; the kernel request is still settling.";
}

function observeSettlement(work: Promise<unknown>): Promise<void> {
  return work.then(
    () => undefined,
    () => undefined
  );
}

function isCorrelatedSessionClose(response: OpenWranglerResponse, sessionId: string): boolean {
  return (
    (response.kind === "sessionClosed" && response.sessionId === sessionId) ||
    (response.kind === "error" &&
      (response.code === "unknown_session" ||
        (response.code === "session_cleanup_failed" && response.recoverable === false)) &&
      response.sessionId === sessionId)
  );
}

function reportOpenProgress(options: BridgeRequestOptions, stage: SessionOpenProgressStage): void {
  try {
    options.onOpenProgress?.(stage);
  } catch {
    // Session progress is presentational. A renderer callback must never
    // interrupt or change the outcome of a kernel request.
  }
}

interface AcquiredKernel {
  readonly jupyter: Jupyter;
  readonly kernel: Kernel;
  observation?: KernelObservation;
}

interface KernelObservation {
  readonly kernel: Kernel;
  subscription?: vscode.Disposable;
}

class SelectedKernelChangedError extends Error {
  constructor(message = "The selected notebook kernel changed before Open Wrangler could open the live variable.") {
    super(message);
    this.name = "SelectedKernelChangedError";
  }
}

interface FormatterPreparation {
  readonly lifecycleVersion: number;
  readonly completion: Promise<void>;
  readonly settlement: Promise<NotebookFormatterPreparationSettlement>;
  readonly resolveGenerationChanged: () => void;
  reportingDeadlineExpired: boolean;
}

export type NotebookPreviewProvider = "ask" | "openWrangler" | "dataWrangler" | "disabled";

export function shouldRegisterNotebookFormatters(): boolean {
  const preference = getSetting<NotebookPreviewProvider>("notebookPreviewProvider", "ask");
  if (preference === "openWrangler") return true;
  if (preference === "dataWrangler" || preference === "disabled") return false;
  return vscode.extensions.getExtension("ms-toolsai.datawrangler") === undefined;
}

function invalidatesKernelLifecycle(status: KernelStatus): boolean {
  return status === "restarting" || status === "autorestarting" || status === "terminating" || status === "dead";
}

interface FramedKernelRequest {
  requestId: string;
  marker: string;
  code: string;
}

function requestPriority(
  request: OpenWranglerRequest,
  options: BridgeRequestOptions
): RuntimeRequestEnvelope["priority"] {
  return (
    options.priority ??
    (request.kind === "getSummary" || request.kind === "getDatasetStats" ? "background" : "interactive")
  );
}

function frameKernelRequest(
  request: OpenWranglerRequest,
  priority: RuntimeRequestEnvelope["priority"]
): FramedKernelRequest {
  const requestId = randomUUID();
  const envelope: RuntimeRequestEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    priority,
    request
  };
  const marker = requestId.replace(/-/g, "");
  const payload = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
  return {
    requestId,
    marker,
    code: `
import base64 as __ow_base64
import openwrangler_runtime.kernel_agent as __ow_kernel_agent
__ow_payload = __ow_base64.b64decode("${payload}").decode("utf-8")
__ow_response = __ow_kernel_agent.dispatch_json(__ow_payload)
print("__OPEN_WRANGLER_START_${marker}__")
print(__ow_response)
print("__OPEN_WRANGLER_END_${marker}__")
`
  };
}

export function isIdempotentKernelReadRequest(request: OpenWranglerRequest): boolean {
  return (
    request.kind === "getPage" ||
    request.kind === "getSummary" ||
    request.kind === "getDatasetStats" ||
    request.kind === "getColumnValues"
  );
}

export function withKernelSessionIdentity(
  request: OpenWranglerRequest,
  createId: () => string = randomUUID
): KernelIdentifiedRequest {
  if (request.kind !== "openSession") return request;
  if (request.requestedSessionId) return { ...request, requestedSessionId: request.requestedSessionId };
  return { ...request, requestedSessionId: createId() };
}

type KernelIdentifiedRequest =
  Exclude<OpenWranglerRequest, OpenSessionRequest> | (OpenSessionRequest & { requestedSessionId: string });

export async function kernelOutputsToText(
  output: ReturnType<Kernel["executeCode"]>,
  maximumBytes = Number.POSITIVE_INFINITY
): Promise<string> {
  const chunks: string[] = [];
  let bytes = 0;
  for await (const item of output) {
    const chunk = outputItemToText(item);
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > maximumBytes) throw new Error("Open Wrangler kernel output exceeds the byte limit.");
    chunks.push(chunk);
  }
  return chunks.join("");
}

function outputItemToText(item: unknown): string {
  if (typeof item === "string") return item;
  if (typeof item !== "object" || item === null) return "";
  const output = item as {
    text?: unknown;
    data?: Record<string, unknown>;
    items?: Array<{ mime?: string; data?: unknown }>;
  };
  if (output.text) return normalizeText(output.text);
  if (output.data?.["text/plain"]) return normalizeText(output.data["text/plain"]);
  const executionError = output.items?.find((candidate) => candidate.mime === "application/vnd.code.notebook.error");
  if (executionError) throw new Error(kernelExecutionError(executionError.data));
  return (
    output.items
      ?.filter((candidate) => typeof candidate.mime === "string" && isKernelTextMime(candidate.mime))
      .map((candidate) => normalizeText(candidate.data))
      .join("") ?? ""
  );
}

function isKernelTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/x.notebook.stream.stdout" ||
    mime === "application/x.notebook.stream.stderr" ||
    mime === "application/vnd.code.notebook.stdout" ||
    mime === "application/vnd.code.notebook.stderr"
  );
}

function kernelExecutionError(value: unknown): string {
  const encoded = normalizeText(value);
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (typeof parsed === "object" && parsed !== null) {
      const error = parsed as { name?: unknown; message?: unknown };
      const name = typeof error.name === "string" ? error.name : "KernelError";
      const message = typeof error.message === "string" ? error.message : encoded;
      return `Open Wrangler kernel execution failed (${name}): ${message}`;
    }
  } catch {
    // Preserve the raw kernel error when it is not JSON encoded.
  }
  return `Open Wrangler kernel execution failed: ${encoded || "unknown kernel error"}`;
}

function normalizeText(value: unknown): string {
  if (Array.isArray(value)) return value.map(normalizeText).join("");
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  }
  return typeof value === "string" ? value : "";
}

function parseMarkedJson(output: string, marker: string): string {
  const start = `__OPEN_WRANGLER_START_${marker}__`;
  const end = `__OPEN_WRANGLER_END_${marker}__`;
  const startIndex = output.indexOf(start);
  const endIndex = output.indexOf(end);
  if (startIndex < 0 || endIndex <= startIndex) {
    throw new Error(`Open Wrangler could not parse the kernel response. Output: ${output.trim()}`);
  }
  return output.slice(startIndex + start.length, endIndex).trim();
}

export function fingerprintNotebookCellSource(source: string): string {
  return createHash("sha256").update(source.replace(/\r\n?/g, "\n").replace(/\n+$/g, ""), "utf8").digest("hex");
}

export function buildNotebookCellResultProbeCode(
  marker: string,
  executionOrder: number,
  sourceFingerprint: string
): string {
  if (!/^[a-f0-9]{32}$/.test(marker)) {
    throw new Error("Notebook cell result marker must be 32 lowercase hexadecimal characters.");
  }
  if (!Number.isSafeInteger(executionOrder) || executionOrder < 1) {
    throw new Error("Notebook cell result execution order must be a positive safe integer.");
  }
  if (!/^[a-f0-9]{64}$/.test(sourceFingerprint)) {
    throw new Error("Notebook cell result source fingerprint must be 64 lowercase hexadecimal characters.");
  }
  const probe = `
import hashlib as __ow_cell_probe_hashlib
import json as __ow_cell_probe_json
import sys as __ow_cell_probe_sys
__ow_cell_probe_shell = __ow_get_ipython()
__ow_cell_probe_namespace = getattr(__ow_cell_probe_shell, "user_ns", None)
__ow_cell_probe_history = __ow_cell_probe_namespace.get("Out") if isinstance(__ow_cell_probe_namespace, dict) else None
__ow_cell_probe_history_manager = getattr(__ow_cell_probe_shell, "history_manager", None)
__ow_cell_probe_inputs = getattr(__ow_cell_probe_history_manager, "input_hist_raw", None)
__ow_cell_probe_source = None
if isinstance(__ow_cell_probe_inputs, list) and len(__ow_cell_probe_inputs) > ${executionOrder}:
    __ow_cell_probe_source = __ow_cell_probe_inputs[${executionOrder}]
__ow_cell_probe_source_hash = None
if isinstance(__ow_cell_probe_source, str):
    __ow_cell_probe_source = __ow_cell_probe_source.replace("\\r\\n", "\\n").replace("\\r", "\\n").rstrip("\\n")
    __ow_cell_probe_source_hash = __ow_cell_probe_hashlib.sha256(__ow_cell_probe_source.encode("utf-8")).hexdigest()
def __ow_cell_probe_isinstance(value, module_name, type_names):
    module = __ow_cell_probe_sys.modules.get(module_name)
    if module is None:
        return False
    candidate_types = tuple(
        candidate_type
        for candidate_type in (getattr(module, name, None) for name in type_names)
        if isinstance(candidate_type, type)
    )
    return bool(candidate_types) and isinstance(value, candidate_types)
if __ow_cell_probe_source_hash != "${sourceFingerprint}":
    __ow_cell_probe_result = {"ok": False, "protocolVersion": ${NOTEBOOK_CELL_RESULT_PROTOCOL_VERSION}, "reason": "stale"}
elif not isinstance(__ow_cell_probe_history, dict) or ${executionOrder} not in __ow_cell_probe_history:
    __ow_cell_probe_result = {"ok": False, "protocolVersion": ${NOTEBOOK_CELL_RESULT_PROTOCOL_VERSION}, "reason": "missing"}
else:
    __ow_cell_probe_value = __ow_cell_probe_history[${executionOrder}]
    __ow_cell_probe_backend = None
    if __ow_cell_probe_isinstance(__ow_cell_probe_value, "pandas", ("DataFrame", "Series")):
        __ow_cell_probe_backend = "pandas"
    elif __ow_cell_probe_isinstance(__ow_cell_probe_value, "polars", ("DataFrame", "LazyFrame", "Series")):
        __ow_cell_probe_backend = "polars"
    elif __ow_cell_probe_isinstance(__ow_cell_probe_value, "duckdb", ("DuckDBPyRelation",)):
        __ow_cell_probe_backend = "duckdb"
    elif __ow_cell_probe_isinstance(__ow_cell_probe_value, "pyspark.sql", ("DataFrame",)):
        __ow_cell_probe_backend = "pyspark"
    __ow_cell_probe_result = {
        "ok": __ow_cell_probe_backend is not None,
        "protocolVersion": ${NOTEBOOK_CELL_RESULT_PROTOCOL_VERSION},
        "backend": __ow_cell_probe_backend,
        "reason": None if __ow_cell_probe_backend is not None else "unsupported",
    }
print("__OPEN_WRANGLER_CELL_PROBE_START_${marker}__")
print(__ow_cell_probe_json.dumps(__ow_cell_probe_result, ensure_ascii=True, allow_nan=False, separators=(",", ":"), sort_keys=True))
print("__OPEN_WRANGLER_CELL_PROBE_END_${marker}__")
`;
  return `exec(${JSON.stringify(probe)}, {"__builtins__": __builtins__, "__ow_get_ipython": get_ipython})`;
}

export function parseNotebookCellResultProbe(
  output: string,
  marker: string
): CapturedNotebookCellResult["backend"] | undefined {
  const start = `__OPEN_WRANGLER_CELL_PROBE_START_${marker}__`;
  const end = `__OPEN_WRANGLER_CELL_PROBE_END_${marker}__`;
  const startIndex = output.indexOf(start);
  const endIndex = output.indexOf(end);
  if (startIndex < 0 || endIndex <= startIndex || output.indexOf(start, startIndex + start.length) >= 0) {
    throw new Error("Open Wrangler could not inspect the executed notebook cell result.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(startIndex + start.length, endIndex).trim());
  } catch {
    throw new Error("Open Wrangler received a malformed notebook result inspection.");
  }
  if (!isPlainRecord(parsed) || parsed.protocolVersion !== NOTEBOOK_CELL_RESULT_PROTOCOL_VERSION) {
    throw new Error("Open Wrangler received an incompatible notebook result inspection.");
  }
  if (parsed.ok === false) return undefined;
  if (
    parsed.ok !== true ||
    (parsed.backend !== "pandas" &&
      parsed.backend !== "polars" &&
      parsed.backend !== "duckdb" &&
      parsed.backend !== "pyspark")
  ) {
    throw new Error("Open Wrangler received a malformed notebook result inspection.");
  }
  return parsed.backend;
}

export function buildNotebookCellResultCode(marker: string, executionOrder: number, sourceFingerprint: string): string {
  if (!/^[a-f0-9]{32}$/.test(marker)) {
    throw new Error("Notebook cell result marker must be 32 lowercase hexadecimal characters.");
  }
  if (!Number.isSafeInteger(executionOrder) || executionOrder < 1) {
    throw new Error("Notebook cell result execution order must be a positive safe integer.");
  }
  if (!/^[a-f0-9]{64}$/.test(sourceFingerprint)) {
    throw new Error("Notebook cell result source fingerprint must be 64 lowercase hexadecimal characters.");
  }
  return `
import hashlib as __ow_cell_hashlib
import json as __ow_cell_json
import openwrangler_runtime.notebook as __ow_cell_notebook
__ow_cell_shell = get_ipython()
__ow_cell_namespace = getattr(__ow_cell_shell, "user_ns", None)
__ow_cell_history = __ow_cell_namespace.get("Out") if isinstance(__ow_cell_namespace, dict) else None
__ow_cell_history_manager = getattr(__ow_cell_shell, "history_manager", None)
__ow_cell_inputs = getattr(__ow_cell_history_manager, "input_hist_raw", None)
__ow_cell_source = None
if isinstance(__ow_cell_inputs, list) and len(__ow_cell_inputs) > ${executionOrder}:
    __ow_cell_source = __ow_cell_inputs[${executionOrder}]
__ow_cell_source_hash = None
if isinstance(__ow_cell_source, str):
    __ow_cell_source = __ow_cell_source.replace("\\r\\n", "\\n").replace("\\r", "\\n").rstrip("\\n")
    __ow_cell_source_hash = __ow_cell_hashlib.sha256(__ow_cell_source.encode("utf-8")).hexdigest()
if __ow_cell_source_hash != "${sourceFingerprint}":
    __ow_cell_result = {
        "ok": False,
        "protocolVersion": ${NOTEBOOK_CELL_RESULT_PROTOCOL_VERSION},
        "reason": "stale",
    }
elif not isinstance(__ow_cell_history, dict) or ${executionOrder} not in __ow_cell_history:
    __ow_cell_result = {
        "ok": False,
        "protocolVersion": ${NOTEBOOK_CELL_RESULT_PROTOCOL_VERSION},
        "reason": "missing",
    }
else:
    try:
        __ow_cell_link = __ow_cell_notebook.link_live_result(
            __ow_cell_history[${executionOrder}],
            __ow_cell_shell,
        )
        __ow_cell_result = {
            "ok": True,
            **__ow_cell_link,
        }
    except Exception:
        __ow_cell_result = {
            "ok": False,
            "protocolVersion": ${NOTEBOOK_CELL_RESULT_PROTOCOL_VERSION},
            "reason": "unsupported",
        }
print("__OPEN_WRANGLER_CELL_RESULT_START_${marker}__")
print(__ow_cell_json.dumps(__ow_cell_result, ensure_ascii=True, allow_nan=False, separators=(",", ":"), sort_keys=True))
print("__OPEN_WRANGLER_CELL_RESULT_END_${marker}__")
del __ow_cell_result
`;
}

export function parseNotebookCellResult(output: string, marker: string): CapturedNotebookCellResult {
  const start = `__OPEN_WRANGLER_CELL_RESULT_START_${marker}__`;
  const end = `__OPEN_WRANGLER_CELL_RESULT_END_${marker}__`;
  const startIndex = output.indexOf(start);
  const endIndex = output.indexOf(end);
  if (startIndex < 0 || endIndex <= startIndex || output.indexOf(start, startIndex + start.length) >= 0) {
    throw new Error("Open Wrangler could not read the executed notebook cell result.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(startIndex + start.length, endIndex).trim());
  } catch {
    throw new Error("Open Wrangler received a malformed executed notebook cell result.");
  }
  if (!isPlainRecord(parsed) || parsed.protocolVersion !== NOTEBOOK_CELL_RESULT_PROTOCOL_VERSION) {
    throw new Error("Open Wrangler received an incompatible executed notebook cell result.");
  }
  if (parsed.ok === false) {
    if (parsed.reason === "stale") {
      throw new Error("This cell result does not belong to the currently selected kernel.");
    }
    if (parsed.reason === "missing") {
      throw new Error("This cell's executed result is no longer available in the selected kernel.");
    }
    throw new Error("This cell did not return a supported Pandas, Polars, DuckDB, or PySpark dataframe.");
  }
  if (
    parsed.ok !== true ||
    (parsed.backend !== "pandas" &&
      parsed.backend !== "polars" &&
      parsed.backend !== "duckdb" &&
      parsed.backend !== "pyspark") ||
    !isBoundedText(parsed.label) ||
    !isBoundedText(parsed.variableName) ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed.variableName)
  ) {
    throw new Error("Open Wrangler received a malformed live notebook result link.");
  }
  return { backend: parsed.backend, label: parsed.label, variableName: parsed.variableName };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= NOTEBOOK_CELL_RESULT_TEXT_LIMIT;
}

export function parseKernelResponse(output: string, marker: string, requestId: string): OpenWranglerResponse {
  const parsed: unknown = JSON.parse(parseMarkedJson(output, marker));
  if (!isRuntimeResponseEnvelope(parsed) || parsed.requestId !== requestId) {
    throw new Error("Open Wrangler kernel agent returned an invalid or stale protocol response.");
  }
  return parsed.response;
}
