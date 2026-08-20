import { isDeepStrictEqual } from "node:util";
import type {
  ErrorResponse,
  FilterModel,
  OpenSessionRequest,
  OpenWranglerResponse,
  SessionBoundRequest,
  SessionMetadata,
  SessionSource,
  StepInspectionResponse
} from "../shared/protocol";
import type { BridgeRequestOptions, SessionPresentation } from "./dataBridge";
import { persistedSessionState } from "./sessionPersistence";
import { SessionPersistenceStore, type SessionPersistenceCommitResult } from "./sessionPersistenceStore";
import { gridState, reconcileViewingState, type RuntimeSessionState } from "./sessionRuntimeStateRestorer";
import { requestViewId } from "./sessionRequestScheduler";

export interface SessionResponseState extends RuntimeSessionState {
  publicRevision: number;
  openRequest: OpenSessionRequest;
  activeViewContextId?: string;
  latestRequestedViewContextId?: string;
  latestRequestedPageRequestId?: string;
  stepInspection?: StepInspectionResponse;
  latestStepInspectionKey?: string;
  viewChangeEpoch?: number;
  draftBaseViewChangeEpoch?: number;
}

export interface SessionResponseCallbacks {
  activate(): void;
  publishInspection(): void;
}

export class SessionResponseCommitter {
  constructor(private readonly persistence: SessionPersistenceStore) {}

  retainSession(session: SessionResponseState): void {
    this.persistence.retainOwner(session.publicId, session.openRequest.source, session.metadata.backend);
  }

  releaseSession(sessionId: string): void {
    this.persistence.releaseOwner(sessionId);
  }

  async persistSession(session: SessionResponseState): Promise<void> {
    this.retainSession(session);
    const state = persistedSessionState(session.metadata, gridState(session.viewState), session.draftBaseFilterModel);
    await this.persistence.save(session.openRequest.source, state);
  }

  async commitRuntimeReplacement(
    session: RuntimeSessionState,
    source: SessionSource,
    isCurrent: () => boolean,
    commit: () => () => void
  ): Promise<SessionPersistenceCommitResult> {
    const state = persistedSessionState(session.metadata, gridState(session.viewState), session.draftBaseFilterModel);
    const result = await this.persistence.commitRuntimeReplacement(source, state, isCurrent, commit);
    if (result.kind === "committed") this.persistence.retainOwner(session.publicId, source, state.backend);
    return result;
  }

  async commit(
    session: SessionResponseState,
    publicRequest: SessionBoundRequest,
    response: OpenWranglerResponse,
    requestRuntimeRevision: number,
    previousFilterModel: FilterModel,
    options: BridgeRequestOptions | undefined,
    callbacks: SessionResponseCallbacks
  ): Promise<OpenWranglerResponse> {
    if (publicRequest.kind === "inspectStep" && response.kind === "stepInspection") {
      const expectedIndex = session.metadata.steps.findIndex((step) => step.id === publicRequest.stepId);
      if (expectedIndex < 0 || response.stepIndex !== expectedIndex) {
        return protocolError(
          "invalid_runtime_response",
          `Ignored an invalid inspectStep response: runtime reported step index ${response.stepIndex} instead of ${expectedIndex}.`,
          true,
          session.publicId
        );
      }
      if (session.latestStepInspectionKey !== stepInspectionKey(publicRequest)) {
        return protocolError(
          "stale_response",
          "Ignored an applied-step inspection superseded by a newer selection.",
          true,
          session.publicId
        );
      }
      const inspection = { ...response, revision: session.publicRevision };
      session.stepInspection = inspection;
      callbacks.publishInspection();
      return inspection;
    }

    if (response.kind === "page" || response.kind === "stepPreview" || response.kind === "planUpdated") {
      return this.commitGridResponse(
        session,
        publicRequest,
        response,
        requestRuntimeRevision,
        previousFilterModel,
        options,
        callbacks
      );
    }
    if (response.kind === "summary" || response.kind === "columnValues") {
      if (response.revision < requestRuntimeRevision || !isCurrentLogicalView(session, options)) {
        return protocolError(
          "stale_response",
          "Ignored a stale or superseded profiling response.",
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      return { ...response, revision: session.publicRevision };
    }
    if (response.kind === "dataExported") {
      if (response.revision < requestRuntimeRevision) {
        return protocolError(
          "stale_response",
          "Ignored a stale export response.",
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      return { ...response, revision: session.publicRevision };
    }
    if (response.kind === "datasetStats") {
      if (response.revision < requestRuntimeRevision || !isCurrentLogicalView(session, options)) {
        return protocolError(
          "stale_response",
          "Ignored stale or superseded dataset statistics.",
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      if (
        publicRequest.kind === "getDatasetStats" &&
        options?.viewContextId !== undefined &&
        options.viewContextId === session.activeViewContextId
      ) {
        session.metadata = { ...session.metadata, stats: response.stats };
        callbacks.activate();
      }
      return { ...response, revision: session.publicRevision };
    }
    if (response.kind === "error" && response.sessionId) {
      return { ...response, sessionId: session.publicId };
    }
    return response;
  }

  private async commitGridResponse(
    session: SessionResponseState,
    publicRequest: SessionBoundRequest,
    response: Extract<OpenWranglerResponse, { kind: "page" | "stepPreview" | "planUpdated" }>,
    requestRuntimeRevision: number,
    previousFilterModel: FilterModel,
    options: BridgeRequestOptions | undefined,
    callbacks: SessionResponseCallbacks
  ): Promise<OpenWranglerResponse> {
    const pageRequest = response.kind === "page" && publicRequest.kind === "getPage" ? publicRequest : undefined;
    if (response.kind === "page" && (!pageRequest || response.viewRequestId !== pageRequest.viewRequestId)) {
      return protocolError(
        "stale_response",
        "Ignored a page response correlated to a different request.",
        true,
        session.publicId,
        requestViewId(publicRequest)
      );
    }
    if (pageRequest && options?.ephemeralPage === true) {
      if (!isCurrentLogicalView(session, options) || response.revision !== requestRuntimeRevision) {
        return protocolError(
          "stale_response",
          "Ignored a clipboard page from a stale or superseded logical view.",
          true,
          session.publicId,
          pageRequest.viewRequestId
        );
      }
      return {
        ...response,
        revision: session.publicRevision,
        metadata: publicMetadata(
          response.metadata,
          session.publicId,
          session.publicRevision,
          session.openRequest.source
        )
      };
    }
    if (pageRequest && !isCurrentPageRequest(session, pageRequest, options)) {
      return protocolError(
        "stale_response",
        "Ignored a page from a superseded logical view.",
        true,
        session.publicId,
        pageRequest.viewRequestId
      );
    }
    if (response.revision < requestRuntimeRevision) {
      return protocolError(
        "stale_response",
        "Ignored a stale grid response.",
        true,
        session.publicId,
        requestViewId(publicRequest)
      );
    }
    const filterChanged = !sameFilterModel(previousFilterModel, response.metadata.filterModel);
    const revisionChanged = response.revision !== requestRuntimeRevision;
    const planChanged = response.kind === "stepPreview" || response.kind === "planUpdated";
    const shapeChanged =
      !isDeepStrictEqual(session.metadata.shape, response.metadata.shape) ||
      !isDeepStrictEqual(session.metadata.filteredShape, response.metadata.filteredShape);
    const stateChanged = filterChanged || revisionChanged || planChanged || shapeChanged;
    const nextViewState = reconcileViewingState(
      {
        ...gridState(session.viewState),
        filterModel: response.metadata.filterModel,
        ...(filterChanged && response.kind === "page"
          ? {
              viewport: {
                firstVisibleRow: response.page.offset,
                scrollLeft: session.viewState.viewport.scrollLeft
              }
            }
          : {})
      },
      response.metadata
    );
    const viewContextChanged = Boolean(
      pageRequest && session.activeViewContextId !== undefined && options?.viewContextId !== session.activeViewContextId
    );
    const draftPresentation: SessionPresentation["draft"] | undefined =
      response.kind === "stepPreview"
        ? {
            diff: response.diff,
            ...(response.remainingMissingCells === undefined
              ? {}
              : { remainingMissingCells: response.remainingMissingCells }),
            warnings: [...(response.warnings ?? [])],
            beforeSchema:
              response.metadata.draftReplacesStepId === undefined
                ? session.metadata.schema
                : (response.metadata.latestStepInputSchema ?? session.metadata.schema)
          }
        : undefined;
    const nextDraftBaseFilterModel =
      response.kind === "stepPreview"
        ? previousFilterModel
        : response.kind === "planUpdated"
          ? undefined
          : session.draftBaseFilterModel;
    const currentViewChangeEpoch = session.viewChangeEpoch ?? 0;
    const nextViewChangeEpoch = currentViewChangeEpoch + (pageRequest && filterChanged ? 1 : 0);
    const nextDraftBaseViewChangeEpoch =
      response.kind === "stepPreview"
        ? currentViewChangeEpoch
        : response.kind === "planUpdated"
          ? undefined
          : session.draftBaseViewChangeEpoch;
    const commitState = (): void => {
      if (pageRequest) {
        session.activeViewContextId = options?.viewContextId;
      } else if (planChanged) {
        session.activeViewContextId = undefined;
        session.latestRequestedViewContextId = undefined;
        session.latestRequestedPageRequestId = undefined;
      }
      session.publicRevision += response.revision - requestRuntimeRevision;
      session.runtimeRevision = response.revision;
      if (stateChanged) {
        session.metadata = response.metadata;
        session.viewState = nextViewState;
      }
      session.viewChangeEpoch = nextViewChangeEpoch;
      if (viewContextChanged) session.metadata = withoutDatasetStats(session.metadata);
      if (response.kind === "stepPreview" || response.kind === "planUpdated") {
        session.code = response.code;
        session.draftPresentation = draftPresentation;
        session.draftBaseFilterModel = nextDraftBaseFilterModel;
        session.draftBaseViewChangeEpoch = nextDraftBaseViewChangeEpoch;
      }
    };
    if (pageRequest && stateChanged) {
      const state = persistedSessionState(response.metadata, gridState(nextViewState), session.draftBaseFilterModel);
      const persistenceResult = await this.persistence.commitCurrent(
        session.openRequest.source,
        state,
        () => isCurrentPageRequest(session, pageRequest, options),
        () => {
          commitState();
          callbacks.activate();
        }
      );
      if (persistenceResult.kind === "unavailable") {
        return persistenceUnavailableError(session.publicId, pageRequest.viewRequestId, persistenceResult.liveState);
      }
      if (persistenceResult.kind === "stale") {
        return protocolError(
          "stale_response",
          "Ignored a page superseded while its viewing state was being saved.",
          true,
          session.publicId,
          pageRequest.viewRequestId
        );
      }
    } else {
      commitState();
      if (stateChanged) await this.persistSession(session);
      if (stateChanged || viewContextChanged) callbacks.activate();
    }
    return {
      ...response,
      revision: session.publicRevision,
      metadata: publicMetadata(session.metadata, session.publicId, session.publicRevision, session.openRequest.source)
    };
  }
}

export function isCurrentPageRequest(
  session: SessionResponseState,
  request: Extract<SessionBoundRequest, { kind: "getPage" }>,
  options?: BridgeRequestOptions
): boolean {
  return (
    request.viewRequestId === session.latestRequestedPageRequestId &&
    (options?.viewContextId === undefined || options.viewContextId === session.latestRequestedViewContextId)
  );
}

export function isCurrentLogicalView(session: SessionResponseState, options?: BridgeRequestOptions): boolean {
  return (
    options?.viewContextId === undefined ||
    (options.viewContextId === session.activeViewContextId &&
      options.viewContextId === session.latestRequestedViewContextId)
  );
}

export function publicMetadata(
  metadata: SessionMetadata,
  publicId: string,
  publicRevision: number,
  immutableSource: SessionSource
): SessionMetadata {
  return {
    ...metadata,
    source: immutableSource,
    sessionId: publicId,
    revision: publicRevision
  };
}

export function stepInspectionKey(request: Extract<SessionBoundRequest, { kind: "inspectStep" }>): string {
  return `${request.revision}:${request.stepId}:${request.offset}:${request.limit}:${request.columnOffset}:${request.columnLimit}`;
}

export function protocolError(
  code: string,
  message: string,
  recoverable: boolean,
  sessionId?: string,
  viewRequestId?: string
): ErrorResponse {
  return {
    kind: "error",
    code,
    message,
    recoverable,
    ...(sessionId ? { sessionId } : {}),
    ...(viewRequestId ? { viewRequestId } : {})
  };
}

export function persistenceUnavailableError(
  sessionId: string,
  viewRequestId?: string,
  liveState: "committed" | "unchanged" = "unchanged"
): ErrorResponse {
  const message =
    liveState === "committed"
      ? "The page is active, but Open Wrangler could not save its workspace recovery state. Retry after workspace storage is available."
      : "Open Wrangler could not save workspace recovery state, so the active session was left unchanged. Retry after workspace storage is available.";
  return protocolError("persistence_unavailable", message, true, sessionId, viewRequestId);
}

function sameFilterModel(left: FilterModel, right: FilterModel): boolean {
  return isDeepStrictEqual(normalizeFilterModel(left), normalizeFilterModel(right));
}

function normalizeFilterModel(model: FilterModel): unknown {
  return {
    logic: model.logic ?? "and",
    filters: model.filters.map((filter) => ({ ...filter, logic: filter.logic ?? "and" })),
    sort: model.sort
  };
}

function withoutDatasetStats(metadata: SessionMetadata): SessionMetadata {
  const { stats: _stats, ...withoutStats } = metadata;
  return withoutStats;
}
