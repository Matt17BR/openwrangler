import { isDeepStrictEqual } from "node:util";
import type {
  ColumnSchema,
  FilterModel,
  OpenWranglerResponse,
  PageResponse,
  SessionBoundRequest,
  SessionMetadata
} from "../shared/protocol";
import { emptyGridViewState, type GridViewState, type PersistedViewingState } from "../shared/viewState";
import {
  DetachedBridgeRequestError,
  type BridgeRequestOptions,
  type OpenWranglerBridge,
  type SessionPresentation
} from "./dataBridge";
import type { DecodedPersistedSessionState, PersistedCleaningState } from "./sessionPersistence";
import { responseMismatch } from "./sessionResponseValidation";
import type { SessionSourceProtection } from "./files/safeFileExport";

const PYSPARK_VIEWPORT_RESTORE_PAGE_LIMIT = 16;

export class RuntimeStateRestoreError extends Error {}

function cleaningRestoreError(
  message: string,
  response: OpenWranglerResponse,
  mismatch: string | undefined
): RuntimeStateRestoreError {
  if (response.kind !== "error" || mismatch !== undefined) return new RuntimeStateRestoreError(message);
  let cause = "";
  let characters = 0;
  for (const character of response.message) {
    if (characters === 1_024) {
      cause += "...[truncated]";
      break;
    }
    cause += character;
    characters += 1;
  }
  return new RuntimeStateRestoreError(cause ? `${message} ${cause}` : message);
}

export interface DraftBaseView {
  readonly filterModel: FilterModel;
  readonly schema: readonly ColumnSchema[];
  readonly viewChangeEpoch: number;
}

export interface RuntimeSessionState {
  sourceProtection?: SessionSourceProtection;
  /** Initial file source schema retained by the host before cleaning replay. */
  sourceSchema?: readonly ColumnSchema[];
  publicId: string;
  runtimeId: string;
  runtimeRevision: number;
  delegate: OpenWranglerBridge;
  metadata: SessionMetadata;
  code: string;
  draftPresentation?: SessionPresentation["draft"];
  draftBaseView?: DraftBaseView;
  viewChangeEpoch?: number;
  viewState: PersistedViewingState;
}

/** Capture the candidate's accepted view at runtime dispatch. */
export function confirmedViewOptions(
  session: Pick<RuntimeSessionState, "metadata" | "viewChangeEpoch">,
  options?: BridgeRequestOptions
): BridgeRequestOptions {
  return {
    ...options,
    confirmedView: {
      filterModel: session.metadata.filterModel,
      viewChangeEpoch: session.viewChangeEpoch ?? 0
    }
  };
}

export class SessionRuntimeStateRestorer {
  async restoreRuntimeState(
    session: RuntimeSessionState,
    state: DecodedPersistedSessionState,
    pageSize: number,
    columnOffset: number,
    columnLimit: number,
    options?: BridgeRequestOptions,
    requireExactView = false,
    assertCurrent?: () => void
  ): Promise<PageResponse> {
    await this.restoreCleaningState(session, state.cleaning, columnOffset, columnLimit, options, assertCurrent);
    if (requireExactView) {
      if (!state.view) throw new RuntimeStateRestoreError("Open Wrangler could not recover the confirmed view.");
      return this.restoreOneViewingState(
        session,
        state.view,
        pageSize,
        columnOffset,
        columnLimit,
        "saved",
        options,
        assertCurrent
      );
    }
    return this.restoreViewingState(session, state.view, pageSize, columnOffset, columnLimit, options, assertCurrent);
  }

  async restoreCleaningState(
    session: RuntimeSessionState,
    cleaning: PersistedCleaningState,
    columnOffset: number,
    columnLimit: number,
    options?: BridgeRequestOptions,
    assertCurrent?: () => void
  ): Promise<void> {
    const currentViewChangeEpoch = session.viewChangeEpoch ?? 0;
    const draftBaseViewChangeEpoch = session.draftBaseView?.viewChangeEpoch ?? currentViewChangeEpoch;
    session.draftPresentation = undefined;
    session.draftBaseView = undefined;
    for (const [index, step] of cleaning.steps.entries()) {
      assertCurrent?.();
      const previewRequest: SessionBoundRequest = {
        kind: "previewStep",
        sessionId: session.runtimeId,
        revision: session.runtimeRevision,
        step,
        offset: 0,
        limit: 1,
        columnOffset,
        columnLimit
      };
      const preview = await session.delegate.request(previewRequest, confirmedViewOptions(session, options));
      assertCurrent?.();
      const previewMismatch = responseMismatch(previewRequest, preview, session.runtimeId);
      if (preview.kind !== "stepPreview" || previewMismatch !== undefined) {
        throw cleaningRestoreError(
          `Open Wrangler could not replay cleaning step ${index + 1}.`,
          preview,
          previewMismatch
        );
      }
      session.runtimeRevision = preview.revision;
      session.metadata = preview.metadata;
      session.code = preview.code;
      const applyRequest: SessionBoundRequest = {
        kind: "applyDraft",
        sessionId: session.runtimeId,
        revision: session.runtimeRevision,
        offset: 0,
        limit: 1,
        columnOffset,
        columnLimit
      };
      const applied = await session.delegate.request(applyRequest, confirmedViewOptions(session, options));
      assertCurrent?.();
      const applyMismatch = responseMismatch(applyRequest, applied, session.runtimeId);
      if (applied.kind !== "planUpdated" || applyMismatch !== undefined) {
        throw cleaningRestoreError(
          `Open Wrangler could not apply replayed cleaning step ${index + 1}.`,
          applied,
          applyMismatch
        );
      }
      session.runtimeRevision = applied.revision;
      session.metadata = applied.metadata;
      session.code = applied.code;
    }

    if (cleaning.draftStep) {
      if (cleaning.draftBaseFilterModel) {
        await this.restoreDraftBaseFilterModel(
          session,
          cleaning.draftBaseFilterModel,
          columnOffset,
          columnLimit,
          options,
          assertCurrent
        );
      }
      assertCurrent?.();
      session.viewChangeEpoch = draftBaseViewChangeEpoch;
      const committedSchema = session.metadata.schema;
      const confirmedDraftBaseFilterModel = session.metadata.filterModel;
      const previewRequest: SessionBoundRequest = {
        kind: "previewStep",
        sessionId: session.runtimeId,
        revision: session.runtimeRevision,
        step: cleaning.draftStep,
        replaceStepId: cleaning.draftReplacesStepId,
        offset: 0,
        limit: 1,
        columnOffset,
        columnLimit
      };
      const preview = await session.delegate.request(previewRequest, confirmedViewOptions(session, options));
      assertCurrent?.();
      const previewMismatch = responseMismatch(previewRequest, preview, session.runtimeId);
      if (preview.kind !== "stepPreview" || previewMismatch !== undefined) {
        throw cleaningRestoreError(
          "Open Wrangler could not restore the draft cleaning step.",
          preview,
          previewMismatch
        );
      }
      session.runtimeRevision = preview.revision;
      session.metadata = preview.metadata;
      session.code = preview.code;
      session.draftBaseView = {
        filterModel: confirmedDraftBaseFilterModel,
        schema: committedSchema,
        viewChangeEpoch: draftBaseViewChangeEpoch
      };
      session.viewChangeEpoch = currentViewChangeEpoch;
      session.draftPresentation = {
        diff: preview.diff,
        ...(preview.remainingMissingCells === undefined
          ? {}
          : { remainingMissingCells: preview.remainingMissingCells }),
        warnings: [...(preview.warnings ?? [])],
        beforeSchema:
          preview.metadata.draftReplacesStepId === undefined
            ? committedSchema
            : (preview.metadata.latestStepInputSchema ?? committedSchema)
      };
    }
  }

  async restoreViewingState(
    session: RuntimeSessionState,
    savedView: PersistedViewingState | undefined,
    pageSize: number,
    columnOffset: number,
    columnLimit: number,
    options?: BridgeRequestOptions,
    assertCurrent?: () => void
  ): Promise<PageResponse> {
    if (!savedView)
      return this.restoreOneViewingState(
        session,
        emptyConfirmedViewingState(),
        pageSize,
        columnOffset,
        columnLimit,
        "empty",
        options,
        assertCurrent
      );
    try {
      return await this.restoreOneViewingState(
        session,
        savedView,
        pageSize,
        columnOffset,
        columnLimit,
        "saved",
        options,
        assertCurrent
      );
    } catch (error) {
      if (error instanceof DetachedBridgeRequestError) throw error;
      assertCurrent?.();
      return this.restoreOneViewingState(
        session,
        emptyConfirmedViewingState(),
        pageSize,
        columnOffset,
        columnLimit,
        "empty",
        options,
        assertCurrent
      );
    }
  }

  async restoreOneViewingState(
    session: RuntimeSessionState,
    view: PersistedViewingState,
    pageSize: number,
    columnOffset: number,
    columnLimit: number,
    label: "saved" | "empty",
    options?: BridgeRequestOptions,
    assertCurrent?: () => void
  ): Promise<PageResponse> {
    const restoredPageSize = Math.max(1, pageSize);
    let desiredOffset = Math.floor(view.viewport.firstVisibleRow / restoredPageSize) * restoredPageSize;
    let restoredView = view;
    const requestPage = async (offset: number, suffix: string = label): Promise<PageResponse> => {
      const pageRequest: SessionBoundRequest = {
        kind: "getPage",
        sessionId: session.runtimeId,
        revision: session.runtimeRevision,
        viewRequestId: `restore:${session.publicId}:${session.runtimeRevision}:${suffix}`,
        offset,
        limit: restoredPageSize,
        columnOffset,
        columnLimit,
        filterModel: view.filterModel
      };
      assertCurrent?.();
      const response = await session.delegate.request(pageRequest, options);
      assertCurrent?.();
      if (
        response.kind !== "page" ||
        responseMismatch(pageRequest, response, session.runtimeId, session.metadata.schema) !== undefined
      ) {
        throw new RuntimeStateRestoreError("Open Wrangler could not restore the confirmed view.");
      }
      return response;
    };
    let page: PageResponse;
    if (session.metadata.backend === "pyspark" && desiredOffset > 0) {
      // A recreated Spark plan has no predecessor anchors for a saved nonzero
      // viewport, so rebuild them through bounded contiguous blocks.
      page = await requestPage(0, `${label}-progressive-0`);
      if (desiredOffset / restoredPageSize >= PYSPARK_VIEWPORT_RESTORE_PAGE_LIMIT) {
        // Presentation-only recovery must not expand into thousands of Spark
        // jobs. Preserve the view contract and restart a far viewport at row 0.
        desiredOffset = 0;
        restoredView = {
          ...view,
          viewport: { ...view.viewport, firstVisibleRow: 0 }
        };
      } else {
        while (page.page.totalRows === null && page.page.offset < desiredOffset) {
          const nextOffset = Math.min(desiredOffset, page.page.offset + restoredPageSize);
          page = await requestPage(nextOffset, `${label}-progressive-${nextOffset}`);
        }
      }
    } else {
      page = await requestPage(desiredOffset);
    }
    const restoredTotal = page.page.totalRows;
    if (restoredTotal !== null && restoredTotal > 0 && desiredOffset >= restoredTotal) {
      assertCurrent?.();
      const finalOffset = Math.floor((restoredTotal - 1) / restoredPageSize) * restoredPageSize;
      if (finalOffset !== page.page.offset) page = await requestPage(finalOffset, `${label}-bounded`);
    }
    if (session.metadata.backend === "pyspark" && page.page.offset !== desiredOffset) {
      restoredView = {
        ...restoredView,
        viewport: { ...restoredView.viewport, firstVisibleRow: page.page.offset }
      };
    }
    const previousFilterModel = session.metadata.filterModel;
    session.runtimeRevision = page.revision;
    session.metadata = page.metadata;
    if (
      session.draftBaseView &&
      session.draftBaseView.viewChangeEpoch === (session.viewChangeEpoch ?? 0) &&
      !isDeepStrictEqual(previousFilterModel, page.metadata.filterModel)
    ) {
      session.viewChangeEpoch = (session.viewChangeEpoch ?? 0) + 1;
    }
    session.viewState = reconcileViewingState(
      { ...restoredView, filterModel: page.metadata.filterModel },
      page.metadata
    );
    return page;
  }

  private async restoreDraftBaseFilterModel(
    session: RuntimeSessionState,
    filterModel: FilterModel,
    columnOffset: number,
    columnLimit: number,
    options?: BridgeRequestOptions,
    assertCurrent?: () => void
  ): Promise<void> {
    const request: SessionBoundRequest = {
      kind: "getPage",
      sessionId: session.runtimeId,
      revision: session.runtimeRevision,
      viewRequestId: `restore:${session.publicId}:${session.runtimeRevision}:draft-base`,
      offset: 0,
      limit: 1,
      columnOffset,
      columnLimit,
      filterModel
    };
    assertCurrent?.();
    const response = await session.delegate.request(request, options);
    assertCurrent?.();
    const mismatch = responseMismatch(request, response, session.runtimeId, session.metadata.schema);
    if (mismatch) {
      throw new RuntimeStateRestoreError("Open Wrangler could not validate the saved draft view.");
    }
    if (response.kind === "error") return;
    if (response.kind !== "page") {
      throw new RuntimeStateRestoreError("Open Wrangler could not restore the saved draft view.");
    }
    session.runtimeRevision = response.revision;
    session.metadata = response.metadata;
    session.viewState = reconcileViewingState(
      {
        filterModel: response.metadata.filterModel,
        columnWidths: new Map(),
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      },
      response.metadata
    );
  }
}

export function initialViewingState(metadata: SessionMetadata): PersistedViewingState {
  return { ...emptyGridViewState(), filterModel: metadata.filterModel };
}

export function gridState(state: PersistedViewingState): GridViewState {
  return {
    columnWidths: new Map(state.columnWidths),
    ...(state.selectedColumnId === undefined ? {} : { selectedColumnId: state.selectedColumnId }),
    viewport: { ...state.viewport }
  };
}

export function reconcileViewingState(state: PersistedViewingState, metadata: SessionMetadata): PersistedViewingState {
  const columnIds = new Set(metadata.schema.map((column) => column.id));
  const columnWidths = new Map([...state.columnWidths].filter(([columnId]) => columnIds.has(columnId)));
  const finalRow =
    metadata.filteredShape.rows === null
      ? state.viewport.firstVisibleRow
      : Math.max(0, metadata.filteredShape.rows - 1);
  const selectedColumnId = state.selectedColumnId;
  return {
    columnWidths,
    ...(selectedColumnId !== undefined && columnIds.has(selectedColumnId) ? { selectedColumnId } : {}),
    viewport: {
      firstVisibleRow: Math.min(state.viewport.firstVisibleRow, finalRow),
      scrollLeft: state.viewport.scrollLeft
    },
    filterModel: metadata.filterModel
  };
}

function emptyConfirmedViewingState(): PersistedViewingState {
  return { ...emptyGridViewState(), filterModel: { filters: [], sort: [] } };
}
