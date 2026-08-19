import { isDeepStrictEqual } from "node:util";
import type { FilterModel, PageResponse, SessionBoundRequest, SessionMetadata } from "../shared/protocol";
import { emptyGridViewState, type GridViewState, type PersistedViewingState } from "../shared/viewState";
import type { BridgeRequestOptions, OpenWranglerBridge, SessionPresentation } from "./dataBridge";
import type { DecodedPersistedSessionState, PersistedCleaningState } from "./sessionPersistence";
import { responseMismatch } from "./sessionResponseValidation";

const PYSPARK_VIEWPORT_RESTORE_PAGE_LIMIT = 16;

export class RuntimeStateRestoreError extends Error {}

export interface RuntimeSessionState {
  publicId: string;
  runtimeId: string;
  runtimeRevision: number;
  delegate: OpenWranglerBridge;
  metadata: SessionMetadata;
  code: string;
  draftPresentation?: SessionPresentation["draft"];
  draftBaseFilterModel?: FilterModel;
  viewChangeEpoch?: number;
  draftBaseViewChangeEpoch?: number;
  viewState: PersistedViewingState;
}

export class SessionRuntimeStateRestorer {
  async restoreRuntimeState(
    session: RuntimeSessionState,
    state: DecodedPersistedSessionState,
    pageSize: number,
    columnOffset: number,
    columnLimit: number,
    options?: BridgeRequestOptions,
    requireExactView = false
  ): Promise<PageResponse> {
    await this.restoreCleaningState(session, state.cleaning, columnOffset, columnLimit, options);
    if (requireExactView) {
      if (!state.view) throw new RuntimeStateRestoreError("Open Wrangler could not recover the confirmed view.");
      return this.restoreOneViewingState(session, state.view, pageSize, columnOffset, columnLimit, "saved", options);
    }
    return this.restoreViewingState(session, state.view, pageSize, columnOffset, columnLimit, options);
  }

  async restoreCleaningState(
    session: RuntimeSessionState,
    cleaning: PersistedCleaningState,
    columnOffset: number,
    columnLimit: number,
    options?: BridgeRequestOptions,
    assertCurrent?: () => void
  ): Promise<void> {
    session.draftPresentation = undefined;
    session.draftBaseFilterModel = undefined;
    session.draftBaseViewChangeEpoch = undefined;
    for (const step of cleaning.steps) {
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
      const preview = await session.delegate.request(previewRequest, options);
      assertCurrent?.();
      if (
        preview.kind !== "stepPreview" ||
        responseMismatch(previewRequest, preview, session.runtimeId) !== undefined
      ) {
        throw new RuntimeStateRestoreError("Open Wrangler could not replay a cleaning step.");
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
      const applied = await session.delegate.request(applyRequest, options);
      assertCurrent?.();
      if (applied.kind !== "planUpdated" || responseMismatch(applyRequest, applied, session.runtimeId) !== undefined) {
        throw new RuntimeStateRestoreError("Open Wrangler could not apply a replayed cleaning step.");
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
      const preview = await session.delegate.request(previewRequest, options);
      assertCurrent?.();
      if (
        preview.kind !== "stepPreview" ||
        responseMismatch(previewRequest, preview, session.runtimeId) !== undefined
      ) {
        throw new RuntimeStateRestoreError("Open Wrangler could not restore the draft cleaning step.");
      }
      session.runtimeRevision = preview.revision;
      session.metadata = preview.metadata;
      session.code = preview.code;
      session.draftBaseFilterModel = confirmedDraftBaseFilterModel;
      session.draftBaseViewChangeEpoch = session.viewChangeEpoch ?? 0;
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
    options?: BridgeRequestOptions
  ): Promise<PageResponse> {
    if (!savedView)
      return this.restoreOneViewingState(
        session,
        emptyConfirmedViewingState(),
        pageSize,
        columnOffset,
        columnLimit,
        "empty",
        options
      );
    try {
      return await this.restoreOneViewingState(
        session,
        savedView,
        pageSize,
        columnOffset,
        columnLimit,
        "saved",
        options
      );
    } catch {
      return this.restoreOneViewingState(
        session,
        emptyConfirmedViewingState(),
        pageSize,
        columnOffset,
        columnLimit,
        "empty",
        options
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
    session.runtimeRevision = page.revision;
    session.metadata = page.metadata;
    if (session.draftBaseFilterModel && !isDeepStrictEqual(session.draftBaseFilterModel, page.metadata.filterModel)) {
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
      throw new RuntimeStateRestoreError(`Open Wrangler could not validate the saved draft view: ${mismatch}`);
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
