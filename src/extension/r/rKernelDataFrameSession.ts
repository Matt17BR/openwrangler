import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { KernelRequestCancelledError, withKernelTimeout } from "../notebooks/kernelLifecycle";
import type {
  RProviderConfirmedSession,
  RProviderError,
  RProviderGetPageRequest,
  RProviderOpenSessionRequest,
  RProviderRequest,
  RProviderResponseEnvelope,
  RProviderSessionIdentity,
  RProviderSessionMetadata
} from "./rProviderProtocol";
import type { GridPage } from "../../shared/protocol";

const MAX_OPERATION_DEADLINE_MS = 300_000;

export interface RKernelDataFrameDeadlines {
  readonly openMs: number;
  readonly pageMs: number;
  readonly closeMs: number;
  readonly failedOpenCleanupMs: number;
}

export const R_KERNEL_DATAFRAME_DEADLINES: RKernelDataFrameDeadlines = Object.freeze({
  openMs: 60_000,
  pageMs: 30_000,
  closeMs: 2_000,
  failedOpenCleanupMs: 2_000
});

export interface RKernelProviderDispatcher {
  dispatch(
    request: RProviderRequest,
    token: vscode.CancellationToken,
    session?: RProviderConfirmedSession | RProviderSessionIdentity
  ): Promise<RProviderResponseEnvelope>;
}

export interface RKernelDataFrameOpenOptions {
  readonly label: string;
  readonly variableName: string;
  readonly pageSize: number;
  readonly columnOffset: number;
  readonly columnLimit: number;
}

export interface RKernelDataFramePageWindow {
  readonly viewRequestId: string;
  readonly offset: number;
  readonly limit: number;
  readonly columnOffset: number;
  readonly columnLimit: number;
}

export interface RKernelDataFrameOpenResult {
  readonly session: RKernelDataFrameSession;
  readonly page: GridPage;
}

export class RProviderOperationError extends Error {
  readonly code: string;
  readonly recoverable: boolean;

  constructor(error: RProviderError) {
    super(error.message);
    this.name = "RProviderOperationError";
    this.code = error.code;
    this.recoverable = error.recoverable;
  }
}

/**
 * Owns one confirmed revision-zero session in one exact R kernel generation.
 *
 * Page reads are serialized and independently deadline-bound. Terminal close
 * cancels active and queued pages, then owns one fresh bounded close attempt;
 * once close is requested, no later read can enter the provider queue.
 */
export class RKernelDataFrameSession {
  readonly metadata: RProviderSessionMetadata;
  private readonly confirmed: RProviderConfirmedSession;
  private state: "open" | "closing" | "closed" = "open";
  private queue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private readonly terminalPageCancellation = new vscode.CancellationTokenSource();

  private constructor(
    private readonly transport: RKernelProviderDispatcher,
    metadata: RProviderSessionMetadata,
    private readonly deadlines: RKernelDataFrameDeadlines
  ) {
    const schema = Object.freeze(metadata.schema.map((column) => Object.freeze({ ...column })));
    this.metadata = Object.freeze({
      ...metadata,
      source: Object.freeze({ ...metadata.source }),
      shape: Object.freeze({ ...metadata.shape }),
      schema
    });
    this.confirmed = Object.freeze({
      sessionId: this.metadata.sessionId,
      revision: 0,
      shape: this.metadata.shape,
      schema: this.metadata.schema
    });
  }

  static async open(
    transport: RKernelProviderDispatcher,
    options: RKernelDataFrameOpenOptions,
    token: vscode.CancellationToken,
    createSessionId: () => string = randomUUID,
    deadlineOverrides: Partial<RKernelDataFrameDeadlines> = {}
  ): Promise<RKernelDataFrameOpenResult> {
    const deadlines = resolveDeadlines(deadlineOverrides);
    const requestedSessionId = createSessionId();
    const request: RProviderOpenSessionRequest = {
      kind: "openSession",
      source: { kind: "notebookVariable", label: options.label, variableName: options.variableName },
      requestedSessionId,
      backend: "r",
      mode: "viewing",
      pageSize: options.pageSize,
      columnOffset: options.columnOffset,
      columnLimit: options.columnLimit
    };

    try {
      const envelope = await dispatchWithDeadline(transport, request, deadlines.openMs, [token]);
      if (envelope.response.kind === "error") throw new RProviderOperationError(envelope.response);
      if (envelope.response.kind !== "sessionOpened") {
        throw new Error("The native R provider did not return the correlated opened session.");
      }
      return Object.freeze({
        session: new RKernelDataFrameSession(transport, envelope.response.metadata, deadlines),
        page: envelope.response.page
      });
    } catch (error) {
      await cleanupFailedOpen(transport, requestedSessionId, deadlines.failedOpenCleanupMs);
      throw error;
    }
  }

  getPage(window: RKernelDataFramePageWindow, token: vscode.CancellationToken): Promise<GridPage> {
    if (this.state !== "open") {
      return Promise.reject(new Error("The native R dataframe session is closing or already closed."));
    }
    return this.enqueue(async () => {
      const request: RProviderGetPageRequest = {
        kind: "getPage",
        sessionId: this.confirmed.sessionId,
        revision: 0,
        viewRequestId: window.viewRequestId,
        offset: window.offset,
        limit: window.limit,
        columnOffset: window.columnOffset,
        columnLimit: window.columnLimit,
        filterModel: { logic: "and", filters: [], sort: [] }
      };
      const envelope = await dispatchWithDeadline(
        this.transport,
        request,
        this.deadlines.pageMs,
        [token, this.terminalPageCancellation.token],
        this.confirmed
      );
      if (envelope.response.kind === "error") throw new RProviderOperationError(envelope.response);
      if (envelope.response.kind !== "page") {
        throw new Error("The native R provider did not return the correlated page.");
      }
      return envelope.response.page;
    });
  }

  close(_token: vscode.CancellationToken): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.state = "closing";
    this.terminalPageCancellation.cancel();
    this.closePromise = this.enqueue(async () => {
      try {
        const request = { kind: "closeSession", sessionId: this.confirmed.sessionId, revision: 0 } as const;
        // Terminal cleanup owns a fresh token and deadline. A caller may use a
        // cancelled token to stop waiting for UI work, but that must not consume
        // the session's only exact close attempt.
        const envelope = await dispatchWithDeadline(
          this.transport,
          request,
          this.deadlines.closeMs,
          [],
          this.confirmed
        );
        if (envelope.response.kind === "error") throw new RProviderOperationError(envelope.response);
        if (envelope.response.kind !== "sessionClosed") {
          throw new Error("The native R provider did not return the correlated terminal close.");
        }
      } finally {
        this.state = "closed";
        this.terminalPageCancellation.dispose();
      }
    });
    return this.closePromise;
  }

  private enqueue<TResult>(work: () => Promise<TResult>): Promise<TResult> {
    const result = this.queue.then(work, work);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

async function cleanupFailedOpen(
  transport: RKernelProviderDispatcher,
  requestedSessionId: string,
  timeoutMs: number
): Promise<void> {
  const identity: RProviderSessionIdentity = { sessionId: requestedSessionId, revision: 0 };
  try {
    await dispatchWithDeadline(
      transport,
      { kind: "closeSession", sessionId: requestedSessionId, revision: 0 },
      timeoutMs,
      [],
      identity
    );
  } catch {
    // The cleanup is bounded and best-effort. Preserve the original open error;
    // provider disposal remains the final owner-wide cleanup path.
  }
}

async function dispatchWithDeadline(
  transport: RKernelProviderDispatcher,
  request: RProviderRequest,
  timeoutMs: number,
  cancellations: readonly vscode.CancellationToken[],
  session?: RProviderConfirmedSession | RProviderSessionIdentity
): Promise<RProviderResponseEnvelope> {
  if (cancellations.some((token) => token.isCancellationRequested)) throw new KernelRequestCancelledError();
  const tokenSource = new vscode.CancellationTokenSource();
  const combinedCancellation = new vscode.CancellationTokenSource();
  const subscriptions = cancellations.map((token) =>
    token.onCancellationRequested(() => combinedCancellation.cancel())
  );
  const abort = (): void => tokenSource.cancel();
  try {
    if (cancellations.some((token) => token.isCancellationRequested)) combinedCancellation.cancel();
    if (combinedCancellation.token.isCancellationRequested) throw new KernelRequestCancelledError();
    return await withKernelTimeout(
      transport.dispatch(request, tokenSource.token, session),
      timeoutMs,
      abort,
      combinedCancellation.token,
      abort
    );
  } finally {
    for (const subscription of subscriptions) subscription.dispose();
    combinedCancellation.dispose();
    tokenSource.dispose();
  }
}

function resolveDeadlines(overrides: Partial<RKernelDataFrameDeadlines>): RKernelDataFrameDeadlines {
  const deadlines = Object.freeze({ ...R_KERNEL_DATAFRAME_DEADLINES, ...overrides });
  for (const [name, value] of Object.entries(deadlines)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OPERATION_DEADLINE_MS) {
      throw new Error(`The native R ${name} deadline is invalid.`);
    }
  }
  return deadlines;
}
