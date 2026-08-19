import type { OpenWranglerResponse, SessionOpenedResponse } from "../shared/protocol";
import { encodeGridViewState, type GridViewState } from "../shared/viewState";
import type { SessionPresentation } from "./dataBridge";

const DEFAULT_IMPORT_PREPARATION_TIMEOUT_MS = 1_500;
const DEFAULT_STARTUP_RECOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STARTUP_RECOVERY_ATTEMPTS = 2;
const DEFAULT_PUBLICATION_TIMEOUT_MS = 5_000;
const DEFAULT_SYNCHRONIZATION_ACK_TIMEOUT_MS = 5_000;

export interface RendererSynchronizationIdentity {
  readonly syncId: string;
  readonly sessionId: string | null;
  readonly revision: number | null;
  readonly layoutTransitionPending: boolean;
}

export interface RendererSynchronizationReceipt {
  readonly syncId: string;
  readonly sessionId: string | null;
  readonly revision: number | null;
}

export interface RendererImportPreparation {
  readonly task: Promise<void>;
}

export interface RendererSynchronizationCallbacks {
  readonly postMessage: (message: unknown) => PromiseLike<boolean>;
  readonly replaceRenderer: () => void;
  readonly isVisible: () => boolean;
  readonly getSnapshot: () => SessionOpenedResponse | undefined;
  readonly getOpenResponse: () => OpenWranglerResponse | undefined;
  readonly getSessionPresentation: () => SessionPresentation | undefined;
  readonly getViewState: () => GridViewState | undefined;
  readonly isImportBusy: () => boolean;
  readonly ensureSessionOpen: () => Promise<void>;
  readonly clearStepInspection: () => void;
  readonly layoutTransitionPending: () => boolean;
  readonly didSynchronize: (synchronization: RendererSynchronizationIdentity) => void;
  readonly didPublishAuthoritativeSnapshot: () => void;
  readonly reportDiagnostic: (message: string) => void;
}

export interface RendererSynchronizationOptions {
  readonly createId?: () => string;
  readonly importPreparationTimeoutMs?: number;
  readonly startupRecoveryTimeoutMs?: number;
  readonly maxStartupRecoveryAttempts?: number;
  readonly publicationTimeoutMs?: number;
  readonly synchronizationAcknowledgementTimeoutMs?: number;
}

interface PendingAcknowledgement {
  readonly syncId: string;
  readonly promise: Promise<boolean>;
  readonly resolve: (hydrated: boolean) => void;
}

interface PendingImportAction {
  readonly actionId: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (preparation: RendererImportPreparation | undefined) => void;
}

/**
 * Owns the finite host/renderer replay handshake. Runtime and panel lifecycle
 * orchestration stay behind typed callbacks so renderer recovery cannot reopen
 * a confirmed session or replay a mutation.
 */
export class RendererSynchronizationCoordinator {
  private readonly createId: () => string;
  private readonly importPreparationTimeoutMs: number;
  private readonly startupRecoveryTimeoutMs: number;
  private readonly maxStartupRecoveryAttempts: number;
  private readonly publicationTimeoutMs: number;
  private readonly synchronizationAcknowledgementTimeoutMs: number;
  private ready = false;
  private generation = 0;
  private synchronizationIdentity: RendererSynchronizationIdentity | undefined;
  private hydratedSyncId: string | undefined;
  private viewStateLocked = true;
  private acknowledgement: PendingAcknowledgement | undefined;
  private synchronizationRun: Promise<void> | undefined;
  private synchronizationRequested = false;
  private synchronizationNeedsInspectionClear = false;
  private pendingImportAction: PendingImportAction | undefined;
  private pendingPreReadyImportResponse: OpenWranglerResponse | undefined;
  private startupRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private startupRecoveryAttempts = 0;
  private disposed = false;

  constructor(
    private readonly callbacks: RendererSynchronizationCallbacks,
    options: RendererSynchronizationOptions = {}
  ) {
    this.createId = options.createId ?? randomNonce;
    this.importPreparationTimeoutMs = options.importPreparationTimeoutMs ?? DEFAULT_IMPORT_PREPARATION_TIMEOUT_MS;
    this.startupRecoveryTimeoutMs = options.startupRecoveryTimeoutMs ?? DEFAULT_STARTUP_RECOVERY_TIMEOUT_MS;
    this.maxStartupRecoveryAttempts = options.maxStartupRecoveryAttempts ?? DEFAULT_MAX_STARTUP_RECOVERY_ATTEMPTS;
    this.publicationTimeoutMs = options.publicationTimeoutMs ?? DEFAULT_PUBLICATION_TIMEOUT_MS;
    this.synchronizationAcknowledgementTimeoutMs =
      options.synchronizationAcknowledgementTimeoutMs ?? DEFAULT_SYNCHRONIZATION_ACK_TIMEOUT_MS;
  }

  get rendererReady(): boolean {
    return this.ready;
  }

  get rendererViewStateLocked(): boolean {
    return this.viewStateLocked;
  }

  get currentSynchronization(): RendererSynchronizationIdentity | undefined {
    return this.synchronizationIdentity;
  }

  replaceRenderer(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.ready = false;
    this.invalidate();
    this.callbacks.replaceRenderer();
  }

  rendererStarted(): void {
    if (this.disposed) return;
    this.clearStartupRecoveryTimer();
    this.ready = true;
    this.invalidate();
  }

  acknowledge(receipt: RendererSynchronizationReceipt): RendererSynchronizationIdentity | undefined {
    const synchronization = this.synchronizationIdentity;
    if (
      this.disposed ||
      !synchronization ||
      synchronization.syncId !== receipt.syncId ||
      synchronization.sessionId !== receipt.sessionId ||
      synchronization.revision !== receipt.revision
    ) {
      return undefined;
    }
    this.hydratedSyncId = receipt.syncId;
    this.viewStateLocked = false;
    this.pendingPreReadyImportResponse = undefined;
    this.clearStartupRecoveryTimer();
    this.startupRecoveryAttempts = 0;
    this.settleAcknowledgement(receipt.syncId, true);
    this.callbacks.didSynchronize(synchronization);
    return synchronization;
  }

  retire(receipt: RendererSynchronizationReceipt): boolean {
    const synchronization = this.synchronizationIdentity;
    if (
      this.disposed ||
      !this.hasHydratedRenderer() ||
      !synchronization ||
      synchronization.syncId !== receipt.syncId ||
      synchronization.sessionId !== receipt.sessionId ||
      synchronization.revision !== receipt.revision
    ) {
      return false;
    }
    this.clearStartupRecoveryTimer();
    this.ready = false;
    this.invalidate();
    this.scheduleStartupRecovery();
    return true;
  }

  hasHydratedRenderer(): boolean {
    const synchronization = this.synchronizationIdentity;
    const snapshot = this.callbacks.getSnapshot();
    return Boolean(
      this.hasSynchronizedRenderer() &&
      snapshot &&
      synchronization &&
      synchronization.sessionId === snapshot.metadata.sessionId &&
      synchronization.revision === snapshot.metadata.revision
    );
  }

  hasSynchronizedRenderer(): boolean {
    const synchronization = this.synchronizationIdentity;
    return Boolean(this.ready && synchronization && this.hydratedSyncId === synchronization.syncId);
  }

  invalidate(): void {
    if (this.disposed) return;
    this.settleAcknowledgement(undefined, false);
    this.synchronizationIdentity = undefined;
    this.hydratedSyncId = undefined;
    this.viewStateLocked = true;
    this.settleImportAction(undefined, undefined);
  }

  waitForAcknowledgement(syncId: string, deadlineMs = Number.POSITIVE_INFINITY): Promise<boolean> {
    if (this.hasHydratedRenderer() && this.hydratedSyncId === syncId) return Promise.resolve(true);
    const acknowledgement = this.acknowledgement;
    if (!acknowledgement || acknowledgement.syncId !== syncId) return Promise.resolve(false);
    const timeoutMs = Math.min(this.synchronizationAcknowledgementTimeoutMs, Math.max(0, deadlineMs - Date.now()));
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (hydrated: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(hydrated);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      void acknowledgement.promise.then(finish);
    });
  }

  scheduleStartupRecovery(): void {
    if (
      this.disposed ||
      this.hasSynchronizedRenderer() ||
      this.startupRecoveryAttempts >= this.maxStartupRecoveryAttempts ||
      this.startupRecoveryTimer ||
      !this.callbacks.getOpenResponse() ||
      !this.callbacks.isVisible()
    ) {
      return;
    }
    this.startupRecoveryTimer = setTimeout(() => {
      this.startupRecoveryTimer = undefined;
      this.recoverAfterStartupStall();
    }, this.startupRecoveryTimeoutMs);
  }

  clearStartupRecoveryTimer(): void {
    if (!this.startupRecoveryTimer) return;
    clearTimeout(this.startupRecoveryTimer);
    this.startupRecoveryTimer = undefined;
  }

  scheduleSynchronization(clearInspection: boolean): void {
    void this.enqueueSynchronization(clearInspection).catch(() => {
      this.callbacks.reportDiagnostic("Open Wrangler could not synchronize the active editor renderer.");
    });
  }

  enqueueSynchronization(clearInspection: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.synchronizationRequested = true;
    this.synchronizationNeedsInspectionClear ||= clearInspection;
    if (this.synchronizationRun) return this.synchronizationRun;

    const synchronization = (async () => {
      try {
        do {
          this.synchronizationRequested = false;
          const shouldClearInspection = this.synchronizationNeedsInspectionClear;
          this.synchronizationNeedsInspectionClear = false;
          await this.synchronize(shouldClearInspection);
        } while (!this.disposed && this.synchronizationRequested);
      } finally {
        this.synchronizationRun = undefined;
      }
    })();
    this.synchronizationRun = synchronization;
    return synchronization;
  }

  async postMessage(message: unknown): Promise<boolean> {
    if (this.disposed) return false;
    const generation = this.generation;
    const rendererReadyAtPublication = this.ready;
    const hydratedSyncIdAtPublication = this.hasHydratedRenderer() ? this.hydratedSyncId : undefined;
    let publication: PromiseLike<boolean>;
    try {
      publication = this.callbacks.postMessage(message);
    } catch {
      this.handlePublicationFailure(generation, rendererReadyAtPublication, hydratedSyncIdAtPublication);
      return false;
    }

    const posted = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (delivered: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(delivered);
      };
      const timer = setTimeout(() => finish(false), this.publicationTimeoutMs);
      void Promise.resolve(publication).then(
        (delivered) => finish(delivered),
        () => finish(false)
      );
    });
    if (!posted) {
      this.handlePublicationFailure(generation, rendererReadyAtPublication, hydratedSyncIdAtPublication);
    }
    return posted && !this.disposed && generation === this.generation;
  }

  async postImportResponse(response: OpenWranglerResponse): Promise<void> {
    if (response.kind === "sessionOpened") {
      if (this.pendingPreReadyImportResponse) this.invalidate();
      this.pendingPreReadyImportResponse = undefined;
    } else {
      this.pendingPreReadyImportResponse = response;
      this.invalidate();
    }
    await this.postMessage(response);
  }

  requestImportOptionsChange(): Promise<RendererImportPreparation | undefined> {
    if (!this.hasHydratedRenderer()) return Promise.resolve(undefined);
    this.settleImportAction(undefined, undefined);
    const actionId = this.createId();
    return new Promise<RendererImportPreparation | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.settleImportAction(actionId, undefined);
      }, this.importPreparationTimeoutMs);
      this.pendingImportAction = { actionId, timer, resolve };
      void Promise.resolve(this.callbacks.postMessage({ kind: "requestImportOptionsChange", actionId })).then(
        (posted) => {
          if (!posted) this.settleImportAction(actionId, undefined);
        },
        () => this.settleImportAction(actionId, undefined)
      );
    });
  }

  expectsImportAction(actionId: string): boolean {
    return this.pendingImportAction?.actionId === actionId;
  }

  settleImportAction(actionId: string | undefined, preparation: RendererImportPreparation | undefined): boolean {
    const pending = this.pendingImportAction;
    if (!pending || (actionId !== undefined && pending.actionId !== actionId)) return false;
    this.pendingImportAction = undefined;
    clearTimeout(pending.timer);
    pending.resolve(preparation);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.clearStartupRecoveryTimer();
    this.settleImportAction(undefined, undefined);
    this.settleAcknowledgement(undefined, false);
    this.disposed = true;
    this.ready = false;
    this.synchronizationIdentity = undefined;
    this.hydratedSyncId = undefined;
    this.viewStateLocked = true;
  }

  private settleAcknowledgement(syncId: string | undefined, hydrated: boolean): boolean {
    const acknowledgement = this.acknowledgement;
    if (!acknowledgement || (syncId !== undefined && acknowledgement.syncId !== syncId)) return false;
    this.acknowledgement = undefined;
    acknowledgement.resolve(hydrated);
    return true;
  }

  private recoverAfterStartupStall(): boolean {
    if (
      this.disposed ||
      this.hasSynchronizedRenderer() ||
      this.startupRecoveryAttempts >= this.maxStartupRecoveryAttempts ||
      !this.callbacks.getOpenResponse() ||
      !this.callbacks.isVisible()
    ) {
      return false;
    }
    this.clearStartupRecoveryTimer();
    this.startupRecoveryAttempts += 1;
    this.replaceRenderer();
    this.scheduleStartupRecovery();
    this.callbacks.reportDiagnostic("Open Wrangler reloaded a renderer that did not complete its startup handshake.");
    return true;
  }

  private handlePublicationFailure(
    generation: number,
    rendererReadyAtPublication: boolean,
    hydratedSyncIdAtPublication: string | undefined
  ): void {
    if (this.disposed || generation !== this.generation) return;
    if (this.hasHydratedRenderer() && this.hydratedSyncId !== hydratedSyncIdAtPublication) return;
    if (!rendererReadyAtPublication) {
      this.scheduleStartupRecovery();
      return;
    }
    this.ready = false;
    this.invalidate();
    if (this.recoverAfterStartupStall()) return;
    this.scheduleStartupRecovery();
  }

  private async synchronize(clearInspection: boolean): Promise<void> {
    if (this.disposed || !this.ready) return;
    const generation = this.generation;
    this.viewStateLocked = true;
    if (clearInspection) {
      this.callbacks.clearStepInspection();
      if (!(await this.postMessage({ kind: "stepInspectionCleared", resumeProfiling: false }))) return;
    }
    if (!this.callbacks.getSnapshot() && !this.callbacks.getOpenResponse()) {
      await this.callbacks.ensureSessionOpen();
    }
    if (this.disposed || !this.ready || generation !== this.generation) return;
    const snapshot = this.callbacks.getSnapshot();
    const openResponse = this.callbacks.getOpenResponse();
    const synchronization: RendererSynchronizationIdentity = snapshot
      ? {
          syncId: this.createId(),
          sessionId: snapshot.metadata.sessionId,
          revision: snapshot.metadata.revision,
          layoutTransitionPending: this.callbacks.layoutTransitionPending()
        }
      : {
          syncId: this.createId(),
          sessionId: null,
          revision: null,
          layoutTransitionPending: false
        };
    this.settleImportAction(undefined, undefined);
    this.settleAcknowledgement(undefined, false);
    this.synchronizationIdentity = synchronization;
    this.hydratedSyncId = undefined;
    let resolveAcknowledgement!: (hydrated: boolean) => void;
    const acknowledgement = new Promise<boolean>((resolve) => {
      resolveAcknowledgement = resolve;
    });
    this.acknowledgement = {
      syncId: synchronization.syncId,
      promise: acknowledgement,
      resolve: resolveAcknowledgement
    };
    if (snapshot) {
      if (!(await this.postMessage(snapshot))) return;
      const presentation = this.callbacks.getSessionPresentation();
      if (presentation && !(await this.postMessage({ kind: "sessionPresentation", presentation }))) return;
      const state = this.callbacks.getViewState();
      const serialized = state ? encodeGridViewState(state) : undefined;
      if (state && (!serialized || !(await this.postMessage({ kind: "viewState", state: serialized })))) return;
      this.callbacks.didPublishAuthoritativeSnapshot();
    } else if (openResponse) {
      if (!(await this.postMessage(openResponse))) return;
    }
    if (this.pendingPreReadyImportResponse) {
      if (!(await this.postMessage(this.pendingPreReadyImportResponse))) return;
    }
    if (!(await this.postMessage({ kind: "importOptionsState", busy: this.callbacks.isImportBusy() }))) return;
    if (this.synchronizationIdentity !== synchronization) {
      this.synchronizationRequested = true;
      return;
    }
    if (await this.postMessage({ kind: "rendererSynchronization", ...synchronization })) {
      this.scheduleStartupRecovery();
    }
  }
}

const randomNonce = (): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
};
