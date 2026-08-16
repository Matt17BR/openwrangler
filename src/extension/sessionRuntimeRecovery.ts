import { isDeepStrictEqual } from "node:util";
import type { ColumnSchema, OpenSessionRequest, OpenWranglerResponse, PageResponse } from "../shared/protocol";
import type { BridgeRequestOptions } from "./dataBridge";
import { persistedSessionState } from "./sessionPersistence";
import { sessionOpenedResponseMismatch } from "./sessionResponseValidation";
import { protocolError, publicMetadata, type SessionResponseState } from "./sessionResponseCommitter";
import type { SessionRequestScheduler } from "./sessionRequestScheduler";
import { SessionRuntimeCleanup } from "./sessionRuntimeCleanup";
import { automaticRecoveryOptions, recoveryFollowupOptions } from "./sessionRuntimeRequestExecutor";
import {
  gridState,
  initialViewingState,
  reconcileViewingState,
  SessionRuntimeStateRestorer,
  type RuntimeSessionState
} from "./sessionRuntimeStateRestorer";

export interface RuntimeRecoverySession extends SessionResponseState {
  scheduler: SessionRequestScheduler;
  closing: boolean;
  reconfiguring: boolean;
  reconnecting: boolean;
  liveReconnectRequired: boolean;
}

export interface RuntimeRecoveryHooks {
  isCurrent(): boolean;
  originMismatch(request: OpenSessionRequest): string | undefined;
  clearPublishedStepInspection(): void;
  publishActive(): void;
  replayAfterRuntimeLoss(
    failedRuntimeId: string,
    options: BridgeRequestOptions,
    requiredSchema: readonly ColumnSchema[],
    onRestoredPage: (page: PageResponse) => void
  ): Promise<boolean>;
}

export class SessionRuntimeRecovery {
  constructor(
    private readonly runtimeCleanup: SessionRuntimeCleanup,
    private readonly runtimeStateRestorer: SessionRuntimeStateRestorer
  ) {}

  async reconnect(
    session: RuntimeRecoverySession,
    revision: number,
    options: BridgeRequestOptions | undefined,
    hooks: RuntimeRecoveryHooks
  ): Promise<OpenWranglerResponse> {
    const unavailable = (message: string): OpenWranglerResponse =>
      protocolError("pyspark_connect_state_lost", message, true, session.publicId);
    if (revision !== session.publicRevision) {
      return unavailable(
        "The Open Wrangler view changed before reconnecting. Try Reconnect again from the current view."
      );
    }
    if (!session.liveReconnectRequired) {
      return protocolError(
        "pyspark_connect_reconnect_not_required",
        "This live PySpark dataframe does not need to reconnect.",
        true,
        session.publicId
      );
    }
    if (session.closing || session.reconfiguring || session.reconnecting) {
      return unavailable("Open Wrangler is already closing or reconnecting this dataframe.");
    }

    session.reconnecting = true;
    session.scheduler.cancelBackground();
    try {
      await session.scheduler.waitForIdle();
      if (!hooks.isCurrent() || session.publicRevision !== revision || !session.liveReconnectRequired) {
        return unavailable("The Open Wrangler view changed before the dataframe could reconnect.");
      }

      const failedRuntimeId = session.runtimeId;
      let restoredPage: PageResponse | undefined;
      const recovered = await hooks.replayAfterRuntimeLoss(
        failedRuntimeId,
        automaticRecoveryOptions(options, failedRuntimeId),
        session.metadata.schema,
        (page) => {
          restoredPage = page;
        }
      );
      if (!recovered || !restoredPage) {
        const variableName =
          session.openRequest.source.kind === "notebookVariable"
            ? session.openRequest.source.variableName
            : session.openRequest.source.label;
        return unavailable(
          `Open Wrangler could not reconnect ${variableName}. ` +
            "Run the cell that creates it, then choose Reconnect again."
        );
      }

      session.liveReconnectRequired = false;
      return {
        kind: "sessionOpened",
        metadata: publicMetadata(
          session.metadata,
          session.publicId,
          session.publicRevision,
          session.openRequest.source
        ),
        page: restoredPage.page,
        summaries: []
      };
    } finally {
      session.reconnecting = false;
    }
  }

  async replay(
    session: RuntimeRecoverySession,
    options: BridgeRequestOptions | undefined,
    hooks: RuntimeRecoveryHooks,
    publishActive = true,
    requiredSchema?: readonly ColumnSchema[],
    isStillCurrent?: () => boolean,
    onRestoredPage?: (page: PageResponse) => void
  ): Promise<boolean> {
    if (!hooks.isCurrent() || (isStillCurrent && !isStillCurrent())) return false;
    if (hooks.originMismatch(session.openRequest)) return false;
    const persisted = persistedSessionState(
      session.metadata,
      gridState(session.viewState),
      session.draftBaseFilterModel
    );
    const previous: RuntimeSessionState = {
      publicId: session.publicId,
      runtimeId: session.runtimeId,
      runtimeRevision: session.runtimeRevision,
      delegate: session.delegate,
      metadata: session.metadata,
      code: session.code,
      draftBaseFilterModel: session.draftBaseFilterModel,
      viewState: session.viewState
    };
    let candidate: RuntimeSessionState | undefined;
    let restoredPage: PageResponse | undefined;
    try {
      const response = await session.delegate.request(session.openRequest, options);
      if (isStillCurrent && !isStillCurrent()) throw new Error("The recovery request was superseded.");
      if (response.kind !== "sessionOpened") return false;
      candidate = {
        publicId: session.publicId,
        runtimeId: response.metadata.sessionId,
        runtimeRevision: response.metadata.revision,
        delegate: session.delegate,
        metadata: response.metadata,
        code: "",
        viewState: initialViewingState(response.metadata)
      };
      if (hooks.originMismatch(session.openRequest)) {
        throw new Error("The originating source changed while recovery was opening its runtime session.");
      }
      const openedMismatch = sessionOpenedResponseMismatch(session.openRequest, response, true);
      if (openedMismatch) throw new Error(openedMismatch);
      if (requiredSchema && !isDeepStrictEqual(response.metadata.schema, requiredSchema)) {
        throw new Error("The recreated live dataframe schema no longer matches the confirmed Open Wrangler view.");
      }
      restoredPage = await this.runtimeStateRestorer.restoreRuntimeState(
        candidate,
        persisted,
        session.metadata.backend === "pyspark" ? session.openRequest.pageSize : 1,
        session.openRequest.columnOffset,
        session.openRequest.columnLimit,
        recoveryFollowupOptions(options),
        requiredSchema !== undefined
      );
      if (isStillCurrent && !isStillCurrent()) throw new Error("The recovery request was superseded.");
      if (hooks.originMismatch(session.openRequest)) {
        throw new Error("The originating source changed while recovery was restoring its runtime session.");
      }
    } catch {
      if (candidate) await this.runtimeCleanup.close(candidate, "recovery candidate");
      return false;
    }

    if (!hooks.isCurrent() || (isStillCurrent && !isStillCurrent())) {
      await this.runtimeCleanup.close(candidate, "recovery candidate");
      return false;
    }

    const latestGridPresentation = gridState(session.viewState);
    const restoredPySparkViewportWasBound =
      candidate.metadata.backend === "pyspark" &&
      persisted.view !== undefined &&
      !isDeepStrictEqual(candidate.viewState.viewport, persisted.view.viewport);
    session.runtimeId = candidate.runtimeId;
    session.runtimeRevision = candidate.runtimeRevision;
    session.metadata = candidate.metadata;
    session.code = candidate.code;
    session.draftPresentation = candidate.draftPresentation;
    session.draftBaseFilterModel = candidate.draftBaseFilterModel;
    session.viewState = reconcileViewingState(
      {
        ...latestGridPresentation,
        ...(restoredPySparkViewportWasBound ? { viewport: candidate.viewState.viewport } : {}),
        filterModel: candidate.metadata.filterModel
      },
      candidate.metadata
    );
    hooks.clearPublishedStepInspection();
    if (publishActive) hooks.publishActive();
    if (restoredPage) onRestoredPage?.(restoredPage);
    this.runtimeCleanup.track(previous, "retired runtime");
    return true;
  }
}
