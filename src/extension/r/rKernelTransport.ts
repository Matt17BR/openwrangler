import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { Jupyter, Kernel, KernelStatus } from "@vscode/jupyter-extension";
import * as vscode from "vscode";
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
  R_KERNEL_MAX_RESPONSE_BYTES,
  R_KERNEL_TRANSPORT_VERSION,
  type RKernelErrorResponse,
  type RKernelPageWindow,
  type RKernelRequest,
  type RKernelResponse
} from "./rKernelProtocol";
import {
  buildRKernelBootstrapCode,
  buildRKernelDispatchCode,
  buildRKernelTeardownCode,
  readRRuntimeFiles
} from "./rKernelRuntimeBundle";
import type { RFramePageContract } from "./rFrameContract";
import type { RNotebookKernelSelectionBinding } from "./rNotebookVariableDiscovery";

const FAILED_OPEN_CLOSE_TIMEOUT_MS = 5_000;
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
      assertDispatchAllowed(options.cancellation, remainingTimeout(timeoutMs, started));

      this.sessionKernels.set(sessionId, acquired.kernel);
      const completion = this.executeRequest(acquired.kernel, request);
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
        if (
          this.verifiedSelection &&
          response.page.dataframeFlavor !== this.verifiedSelection.variable.dataframeFlavor
        ) {
          throw new Error("The selected R dataframe changed before Open Wrangler opened it.");
        }
        return Object.freeze({ sessionId, page: response.page });
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
    this.assertActive();
    const started = performance.now();
    const timeoutMs = requestTimeout(options.timeoutMs);
    const kernel = this.requireMappedKernel(sessionId);
    const request = this.request("getPage", { sessionId, page });
    encodeRKernelRequest(request);
    const acquired = this.requireObservation(kernel);
    const preflight = this.assertKernelStillSelected(acquired);
    void preflight.catch(() => undefined);
    await withKernelTimeout(preflight, timeoutMs, () => undefined, options.cancellation);
    await this.waitForKernelSettlement(kernel, timeoutMs, started, options.cancellation);
    assertDispatchAllowed(options.cancellation, remainingTimeout(timeoutMs, started));
    const completion = this.executeRequest(kernel, request);
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
    const postflight = this.assertKernelStillSelected(acquired);
    void postflight.catch(() => undefined);
    await withKernelTimeout(postflight, remainingTimeout(timeoutMs, started), () => undefined, options.cancellation);
    if (response.kind === "error") throw new RKernelDiagnosticError(response);
    if (response.kind !== "page" || response.sessionId !== sessionId) {
      throw new Error("The R kernel returned a mismatched page session identity.");
    }
    this.assertActive();
    return response.page;
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

  private async executeRequest(kernel: Kernel, request: RKernelRequest): Promise<RKernelResponse> {
    const payload = encodeRKernelRequest(request);
    const marker = request.requestId.replaceAll("-", "");
    const output = await this.executeKernelText(kernel, buildRKernelDispatchCode(payload, marker));
    return decodeRKernelResponseJson(parseMarkedResponse(output, marker), request.requestId);
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
