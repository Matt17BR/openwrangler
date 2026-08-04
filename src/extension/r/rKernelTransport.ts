import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { Jupyter, Kernel, KernelStatus } from "@vscode/jupyter-extension";
import * as vscode from "vscode";
import { DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS } from "../configuration";
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
import { buildRKernelBootstrapCode, buildRKernelDispatchCode, readRRuntimeFiles } from "./rKernelRuntimeBundle";
import type { RFramePageContract } from "./rFrameContract";

const FAILED_OPEN_CLOSE_TIMEOUT_MS = 5_000;
const MAX_RETIRED_SESSION_IDS = 1_024;
const MAX_PENDING_CLEANUP_ATTEMPTS = 64;

export interface RKernelRequestOptions {
  readonly cancellation?: KernelCancellationLike;
  readonly timeoutMs?: number;
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

export class RKernelOpenDetachedError extends Error {
  constructor(readonly reason: "cancelled" | "timeout") {
    super(
      reason === "cancelled"
        ? "Open Wrangler stopped waiting for the R dataframe after host cancellation. Its exact-kernel cleanup will run when that request settles."
        : "Open Wrangler stopped waiting for the R dataframe after the host deadline. Its exact-kernel cleanup will run when that request settles."
    );
    this.name = "RKernelOpenDetachedError";
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
  private readonly sessionKernels = new Map<string, Kernel>();
  private readonly retiredSessionIds = new Set<string>();
  private readonly cleanupAttempts = new WeakMap<Kernel, Map<string, Promise<boolean>>>();
  private readonly bootstrapPromises = new WeakMap<Kernel, Promise<void>>();
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
    private readonly createId: () => string = randomUUID
  ) {
    this.notebookUri = notebookDocument.uri;
    this.bootstrapCode = buildRKernelBootstrapCode(readRRuntimeFiles(path.join(context.extensionPath, "r")));
  }

  async open(
    variableName: string,
    page: RKernelPageWindow,
    options: RKernelRequestOptions = {}
  ): Promise<RKernelOpenResult> {
    this.assertActive();
    this.beginOpen();
    try {
      const started = performance.now();
      const timeoutMs = requestTimeout(options.timeoutMs);
      const sessionId = this.createId();
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
      const acquired = await withKernelTimeout(preparation, timeoutMs, () => undefined, options.cancellation);
      this.assertActive();
      this.assertSessionIdentityAvailable(sessionId);
      assertDispatchAllowed(options.cancellation, remainingTimeout(timeoutMs, started));

      this.sessionKernels.set(sessionId, acquired.kernel);
      const completion = this.executeRequest(acquired.kernel, request);
      void completion.catch(() => undefined);
      let detachedReason: "cancelled" | "timeout" | undefined;
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
            detachedReason = "cancelled";
          }
        );
      } catch (error) {
        if (detachedReason) {
          this.cleanupAfterOpenSettlement(sessionId, acquired.kernel, completion);
          throw new RKernelOpenDetachedError(detachedReason);
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
        return Object.freeze({ sessionId, page: response.page });
      } catch (error) {
        await this.cleanupFailedOpen(sessionId, acquired.kernel);
        throw error;
      }
    } finally {
      this.endOpen();
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
    assertDispatchAllowed(options.cancellation, remainingTimeout(timeoutMs, started));
    const completion = this.executeRequest(kernel, request);
    void completion.catch(() => undefined);
    const response = await withKernelTimeout(
      completion,
      remainingTimeout(timeoutMs, started),
      () => undefined,
      options.cancellation
    );
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

  async close(sessionId: string, options: Readonly<{ timeoutMs?: number }> = {}): Promise<void> {
    this.assertActive();
    const kernel = this.requireMappedKernel(sessionId);
    await this.closeMappedSession(sessionId, kernel, requestTimeout(options.timeoutMs));
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

  private async closeMappedSession(sessionId: string, kernel: Kernel, timeoutMs: number): Promise<void> {
    const completion = this.executeRequest(kernel, this.request("closeSession", { sessionId })).then((response) => {
      if (isCorrelatedClose(response, sessionId)) this.retireSession(sessionId, kernel);
      return response;
    });
    void completion.catch(() => undefined);
    const response = await withKernelTimeout(completion, timeoutMs, () => undefined);
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
        if (kernel) await this.closeMappedSession(sessionId, kernel, DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Open Wrangler could not close every R kernel session.");
  }

  private async disposeOnce(): Promise<void> {
    try {
      await this.openIdle;
      await this.closeMappedSessions();
    } finally {
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

  private cleanupAfterOpenSettlement(sessionId: string, kernel: Kernel, completion: Promise<RKernelResponse>): void {
    void completion
      .catch(() => undefined)
      .then(() => this.cleanupFailedOpen(sessionId, kernel))
      .catch(() => undefined);
  }

  private cleanupFailedOpen(sessionId: string, kernel: Kernel): Promise<boolean> {
    let completion = this.cleanupAttempts.get(kernel)?.get(sessionId);
    if (!completion) {
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
    for (const [sessionId, kernel] of this.sessionKernels) {
      if (kernel === observation.kernel) {
        this.sessionKernels.delete(sessionId);
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
