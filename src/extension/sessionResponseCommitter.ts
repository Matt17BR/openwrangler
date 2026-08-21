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
import {
  SessionPersistenceStore,
  type SessionPersistenceCommitResult,
  type SessionPersistenceStageResult,
  type SessionPersistenceTransaction
} from "./sessionPersistenceStore";
import { gridState, reconcileViewingState, type RuntimeSessionState } from "./sessionRuntimeStateRestorer";
import { requestViewId } from "./sessionRequestScheduler";

export interface SessionResponseState extends RuntimeSessionState {
  publicRevision: number;
  openRequest: OpenSessionRequest;
  recoveryRequired?: boolean;
  activeViewContextId?: string;
  latestRequestedViewContextId?: string;
  latestRequestedPageRequestId?: string;
  stepInspection?: StepInspectionResponse;
  latestStepInspectionKey?: string;
  viewChangeEpoch?: number;
  draftBaseViewChangeEpoch?: number;
}

export interface SessionResponseCallbacks {
  activate(registerRollback?: (rollback: () => boolean | void) => void): void;
  publishInspection(): void;
}

export class SessionResponseCommitter {
  private readonly stagedMutations = new WeakMap<SessionResponseState, SessionPersistenceTransaction>();

  constructor(private readonly persistence: SessionPersistenceStore) {}

  retainSession(session: SessionResponseState): void {
    this.persistence.retainOwner(session.publicId, session.openRequest.source, session.metadata.backend);
  }

  releaseSession(sessionId: string): void {
    void this.persistence.releaseOwner(sessionId);
  }

  async persistSession(session: SessionResponseState): Promise<SessionPersistenceCommitResult> {
    this.retainSession(session);
    const state = persistedSessionState(session.metadata, gridState(session.viewState), session.draftBaseFilterModel);
    return this.persistence.save(session.openRequest.source, state);
  }

  async stageMutation(session: SessionResponseState): Promise<SessionPersistenceStageResult> {
    if (this.stagedMutations.has(session)) throw new Error("A session persistence mutation is already staged.");
    this.retainSession(session);
    const state = persistedSessionState(session.metadata, gridState(session.viewState), session.draftBaseFilterModel);
    const result = await this.persistence.stageCurrent(session.openRequest.source, state);
    if (result.kind === "staged") this.stagedMutations.set(session, result.transaction);
    return result;
  }

  async restoreStagedMutation(session: SessionResponseState): Promise<SessionPersistenceCommitResult | undefined> {
    const transaction = this.stagedMutations.get(session);
    if (!transaction) return undefined;
    this.stagedMutations.delete(session);
    return this.persistence.restoreStagedCurrent(transaction);
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
    if (stateChanged) {
      const state = persistedSessionState(response.metadata, gridState(nextViewState), nextDraftBaseFilterModel);
      const previous = sessionPublication(session);
      let published: SessionPublication | undefined;
      const commitPublication = (): (() => boolean) => {
        let rollbackActivation: (() => boolean | void) | undefined;
        try {
          commitState();
          callbacks.activate((rollback) => {
            rollbackActivation = rollback;
          });
          published = sessionPublication(session);
        } catch (error) {
          restoreSessionPublication(session, previous);
          if (rollbackActivation) {
            try {
              rollbackActivation();
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                "Grid publication and its coordinator rollback both failed."
              );
            }
          }
          throw error;
        }
        return () => {
          if (!published || !sameSessionPublication(session, published)) return false;
          restoreSessionPublication(session, previous);
          if (rollbackActivation) return rollbackActivation() !== false;
          return true;
        };
      };
      const isCurrent = pageRequest
        ? () => isCurrentPageRequest(session, pageRequest, options)
        : () =>
            published ? sameSessionPublication(session, published) : publicRequest.revision === session.publicRevision;
      const staged = planChanged ? this.stagedMutations.get(session) : undefined;
      let persistenceResult: SessionPersistenceCommitResult;
      try {
        if (staged) {
          try {
            persistenceResult = await this.persistence.commitStagedCurrent(staged, state, isCurrent, commitPublication);
          } finally {
            this.stagedMutations.delete(session);
          }
        } else {
          persistenceResult = await this.persistence.commitCurrent(
            session.openRequest.source,
            state,
            isCurrent,
            commitPublication
          );
        }
      } catch (error) {
        if (planChanged) session.recoveryRequired = true;
        throw error;
      }
      if (persistenceResult.kind === "unavailable") {
        if (planChanged && persistenceResult.liveState === "unchanged") session.recoveryRequired = true;
        return persistenceUnavailableError(session.publicId, pageRequest?.viewRequestId, persistenceResult.liveState);
      }
      if (persistenceResult.kind === "stale") {
        if (planChanged) session.recoveryRequired = true;
        return protocolError(
          "stale_response",
          pageRequest
            ? "Ignored a page superseded while its viewing state was being saved."
            : "Ignored a mutation superseded while its session state was being saved.",
          true,
          session.publicId,
          pageRequest?.viewRequestId
        );
      }
    } else {
      commitState();
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

export function persistenceReadUnavailableError(): ErrorResponse {
  return protocolError(
    "persistence_unavailable",
    "Open Wrangler could not read workspace recovery state, so the dataframe was not opened. Retry after workspace storage is available.",
    true
  );
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

interface SessionPublication {
  readonly publicRevision: number;
  readonly runtimeRevision: number;
  readonly activeViewContextId: string | undefined;
  readonly latestRequestedViewContextId: string | undefined;
  readonly latestRequestedPageRequestId: string | undefined;
  readonly metadata: SessionResponseState["metadata"];
  readonly viewState: SessionResponseState["viewState"];
  readonly viewChangeEpoch: number | undefined;
  readonly code: string;
  readonly draftPresentation: SessionResponseState["draftPresentation"];
  readonly draftBaseFilterModel: SessionResponseState["draftBaseFilterModel"];
  readonly draftBaseViewChangeEpoch: number | undefined;
  readonly recoveryRequired: boolean | undefined;
}

function sessionPublication(session: SessionResponseState): SessionPublication {
  return {
    publicRevision: session.publicRevision,
    runtimeRevision: session.runtimeRevision,
    activeViewContextId: session.activeViewContextId,
    latestRequestedViewContextId: session.latestRequestedViewContextId,
    latestRequestedPageRequestId: session.latestRequestedPageRequestId,
    metadata: session.metadata,
    viewState: session.viewState,
    viewChangeEpoch: session.viewChangeEpoch,
    code: session.code,
    draftPresentation: session.draftPresentation,
    draftBaseFilterModel: session.draftBaseFilterModel,
    draftBaseViewChangeEpoch: session.draftBaseViewChangeEpoch,
    recoveryRequired: session.recoveryRequired
  };
}

function sameSessionPublication(session: SessionResponseState, publication: SessionPublication): boolean {
  return (
    session.publicRevision === publication.publicRevision &&
    session.runtimeRevision === publication.runtimeRevision &&
    session.activeViewContextId === publication.activeViewContextId &&
    session.latestRequestedViewContextId === publication.latestRequestedViewContextId &&
    session.latestRequestedPageRequestId === publication.latestRequestedPageRequestId &&
    session.metadata === publication.metadata &&
    session.viewState === publication.viewState &&
    session.viewChangeEpoch === publication.viewChangeEpoch &&
    session.code === publication.code &&
    session.draftPresentation === publication.draftPresentation &&
    session.draftBaseFilterModel === publication.draftBaseFilterModel &&
    session.draftBaseViewChangeEpoch === publication.draftBaseViewChangeEpoch &&
    session.recoveryRequired === publication.recoveryRequired
  );
}

function restoreSessionPublication(session: SessionResponseState, publication: SessionPublication): void {
  session.publicRevision = publication.publicRevision;
  session.runtimeRevision = publication.runtimeRevision;
  session.activeViewContextId = publication.activeViewContextId;
  session.latestRequestedViewContextId = publication.latestRequestedViewContextId;
  session.latestRequestedPageRequestId = publication.latestRequestedPageRequestId;
  session.metadata = publication.metadata;
  session.viewState = publication.viewState;
  session.viewChangeEpoch = publication.viewChangeEpoch;
  session.code = publication.code;
  session.draftPresentation = publication.draftPresentation;
  session.draftBaseFilterModel = publication.draftBaseFilterModel;
  session.draftBaseViewChangeEpoch = publication.draftBaseViewChangeEpoch;
  session.recoveryRequired = publication.recoveryRequired;
}
