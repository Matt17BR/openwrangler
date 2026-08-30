import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEventHandler, ReactNode } from "react";
import type {
  CellDiff,
  CellValue,
  ColumnFilter,
  ColumnSchema,
  ColumnSummary,
  DataDiff,
  GridPage,
  LiveGridPage,
  SessionMetadata
} from "../../shared/protocol";
import { liveGridLogicalRowExtent, liveGridPageHasMore } from "../../shared/protocol";
import type { SortDirection, SortRule } from "../../shared/filterModel";
import {
  ambiguousViewColumnMessage,
  countViewColumnNames,
  supportsTypedViewComparison,
  viewCellSelectionFilter
} from "../../shared/filterModel";
import { setGridColumnWidth, type GridViewState } from "../../shared/viewState";
import { createRowScrollModel, gridRowHeight, logicalRowForScrollTop, scrollTopForLogicalRow } from "./rowScrollModel";
import { GridClipboardControls, useGridClipboard } from "./GridClipboardControls";
import { columnTypePresentation } from "../columnTypes";
import type { ProfileValueMode } from "../profileValueMode";
import { useGridHeaderProfiles } from "./GridHeaderProfileValues";
import { useColumnResizeLifecycle, type BeginColumnResize } from "./useColumnResizeLifecycle";
import { useCellActionMenuLifecycle } from "./useCellActionMenuLifecycle";
import { useGridPointerDragLifecycle } from "./useGridPointerDragLifecycle";
import { useGridRowHeaderLayout } from "./useGridRowHeaderLayout";
import {
  centeredColumnScrollLeft,
  useGridColumnRevealLifecycle,
  type GridColumnRevealCommit
} from "./useGridColumnRevealLifecycle";
import {
  createGridVirtualWindow,
  gridColumnWidths,
  requestedGridPageOffset,
  terminalPageOverlapsViewport,
  type VisibleColumnRange
} from "./gridVirtualWindow";

export type { VisibleColumnRange } from "./gridVirtualWindow";

interface DataGridProps {
  metadata: SessionMetadata;
  page: LiveGridPage;
  summaries: ColumnSummary[];
  pageSize: number;
  defaultColumnWidth: number;
  insightsOnOpen: boolean;
  busy?: boolean;
  projecting?: boolean;
  viewContextId?: string;
  goToColumnId?: string;
  goToColumnRequestId?: number;
  viewState?: GridViewState;
  viewStateRestoreVersion?: number;
  diff?: DataDiff;
  beforePage?: GridPage;
  beforeSchema?: ColumnSchema[];
  viewControlsDisabled?: boolean;
  viewControlsDisabledReason?: string;
  filterControlsDisabled?: boolean;
  filterControlsDisabledReason?: string;
  sortControlsDisabled?: boolean;
  sortControlsDisabledReason?: string;
  profilesDisabled?: boolean;
  profilesDisabledReason?: string;
  profileValueMode?: ProfileValueMode;
  onProfileValueModeChange?(mode: ProfileValueMode): void;
  sortRules?: SortRule[];
  onPage(offset: number): void;
  onSortColumn(column: string, direction: SortDirection): void;
  onClearSortColumn?(column: string): void;
  onApplyCellFilter?(filter: ColumnFilter): void;
  onApplyProfileFilter?(filter: ColumnFilter): void;
  onOpenFilter(column: string): void;
  onGoToColumnHandled?(requestId: number, outcome?: "revealed" | "interrupted"): void;
  onVisibleColumnRangeChange?(range: VisibleColumnRange): void;
  onVisibleSummaryColumnsChange(columnIds: string[]): void;
  onViewStateChange?(state: GridViewState): void;
}

interface ProgrammaticViewportTarget {
  firstVisibleRow: number;
  scrollTop: number;
  scrollLeft: number;
}

interface ScrollInputs {
  busy: boolean;
  contiguousOnly: boolean;
  currentOffset: number;
  currentRowCount: number;
  onPage(offset: number): void;
  pageSize: number;
  reportViewState(state: GridViewState): void;
  totalRows: number;
}

const scrollQuantizationTolerance = 1;
const maximumRenderedCellCharacters = 4_096;
const gridSelectionInstructions =
  "Drag across cells or use Shift+click or Shift+Arrow to select a rectangular range. Select a column header or press Ctrl/Cmd+Space on it to prepare the whole filtered and sorted column for copying. Ctrl/Cmd+click starts a new selection; non-contiguous selections are not supported.";
const defaultViewState: GridViewState = { columnWidths: new Map(), viewport: { firstVisibleRow: 0, scrollLeft: 0 } };
const ignoreViewStateChange = (): void => undefined;
const ignoreVisibleColumnRangeChange = (): void => undefined;

export function DataGrid({
  metadata,
  page,
  summaries,
  pageSize,
  defaultColumnWidth,
  insightsOnOpen,
  busy = false,
  projecting = false,
  viewContextId,
  goToColumnId,
  goToColumnRequestId,
  viewState = defaultViewState,
  viewStateRestoreVersion = 0,
  diff,
  beforePage,
  beforeSchema,
  viewControlsDisabled = false,
  viewControlsDisabledReason = "View controls are unavailable while inspecting an applied step.",
  filterControlsDisabled = false,
  filterControlsDisabledReason = "Filtering is unavailable for this dataframe.",
  sortControlsDisabled = false,
  sortControlsDisabledReason = "Sorting is unavailable for this dataframe.",
  profilesDisabled = false,
  profilesDisabledReason = "Column profiles are unavailable for this dataframe.",
  profileValueMode = "count",
  onProfileValueModeChange,
  sortRules = metadata.filterModel.sort,
  onPage,
  onSortColumn,
  onClearSortColumn = () => undefined,
  onApplyCellFilter,
  onApplyProfileFilter,
  onOpenFilter,
  onGoToColumnHandled = () => undefined,
  onVisibleColumnRangeChange = ignoreVisibleColumnRangeChange,
  onVisibleSummaryColumnsChange,
  onViewStateChange = ignoreViewStateChange
}: DataGridProps) {
  const logicalRowExtent = liveGridLogicalRowExtent(page);
  const hasMoreRows = liveGridPageHasMore(page);
  const { rowAxisHeader, hasRowLabels, rowHeaderWidth } = useGridRowHeaderLayout(
    metadata.sessionId,
    metadata.rowAxis,
    page.rows
  );
  const viewColumnNameCounts = useMemo(() => countViewColumnNames(metadata.schema), [metadata.schema]);
  const diffPresentation = useMemo(
    () => buildDiffPresentation(diff, page, metadata.schema, beforePage, beforeSchema),
    [beforePage, beforeSchema, diff, metadata.schema, page]
  );
  const scrollerRef = useRef<HTMLDivElement>(null);
  const {
    begin: beginPointerDrag,
    cancel: cancelPointerDrag,
    continueToRow: continuePointerDragToRow,
    isActive: pointerDragIsActive
  } = useGridPointerDragLifecycle(scrollerRef);
  const beginColumnResize = useColumnResizeLifecycle();
  const gridSelectionInstructionsId = useId();
  const visibleColumnRangeHandler = useRef(onVisibleColumnRangeChange);
  const requestedOffset = useRef(page.offset);
  const logicalViewContext = viewContextId ?? `${metadata.sessionId}:${metadata.revision}`;
  const previousViewContext = useRef(logicalViewContext);
  const appliedViewStateRestoreVersion = useRef<number | undefined>(undefined);
  const focusRequested = useRef(false);
  const pointerSelectionFocusRequest = useRef<{ row: number; column: number } | undefined>(undefined);
  const preserveGridFocusAfterScroll = useRef(false);
  const programmaticViewportTarget = useRef<ProgrammaticViewportTarget | undefined>(undefined);
  const programmaticViewportWriteInProgress = useRef(false);
  const programmaticViewportRetryAvailable = useRef(false);
  const viewportUpdatesSuspended = useRef(false);
  const viewStateRef = useRef(viewState);
  const restorationRef = useRef({ viewState, metadata, page, pageSize });
  const scrollInputsRef = useRef<ScrollInputs>({
    busy,
    contiguousOnly: metadata.backend === "pyspark",
    currentOffset: page.offset,
    currentRowCount: page.rows.length,
    onPage,
    pageSize,
    reportViewState: ignoreViewStateChange,
    totalRows: logicalRowExtent
  });
  useLayoutEffect(() => {
    restorationRef.current = { viewState, metadata, page, pageSize };
  }, [metadata, page, pageSize, viewState]);
  const [viewport, setViewport] = useState({
    firstVisibleRow: viewState.viewport.firstVisibleRow,
    scrollLeft: 0,
    scrollTop: 0,
    width: 1200,
    height: 600
  });
  const [focusedCell, setFocusedCell] = useState({
    row: viewState.viewport.firstVisibleRow,
    column: selectedColumnPosition(metadata.schema, viewState.selectedColumnId)
  });
  const cellActionMenu = useCellActionMenuLifecycle({
    prepareFocus: (coordinate) => {
      pointerSelectionFocusRequest.current = coordinate;
    },
    scrollerRef,
    viewContextId: logicalViewContext
  });
  const gridClipboard = useGridClipboard({
    contextId: logicalViewContext,
    metadata,
    pageSize,
    schema: metadata.schema,
    page,
    initialCoordinate: focusedCell,
    onSelectionWillChange: cellActionMenu.dismiss,
    viewContextId
  });
  const resetGridClipboardSelection = gridClipboard.resetSelection;
  const resetGridClipboardSelectionRef = useRef(resetGridClipboardSelection);
  const selectGridClipboardCell = gridClipboard.selectCell;
  const cellFilterMenuTarget = cellActionMenu.target;
  const dismissCellActionMenu = cellActionMenu.dismiss;

  useLayoutEffect(() => {
    viewStateRef.current = viewState;
  }, [viewState]);

  useLayoutEffect(() => {
    resetGridClipboardSelectionRef.current = resetGridClipboardSelection;
  }, [resetGridClipboardSelection]);

  useEffect(() => {
    visibleColumnRangeHandler.current = onVisibleColumnRangeChange;
  }, [onVisibleColumnRangeChange]);

  const reportViewState = useCallback(
    (next: GridViewState): void => {
      viewStateRef.current = next;
      onViewStateChange(next);
    },
    [onViewStateChange]
  );

  const writeProgrammaticViewport = useCallback(
    (scroller: HTMLDivElement, target: ProgrammaticViewportTarget): void => {
      programmaticViewportTarget.current = target;
      programmaticViewportRetryAvailable.current = true;
      programmaticViewportWriteInProgress.current = true;
      try {
        scroller.scrollTop = target.scrollTop;
        scroller.scrollLeft = target.scrollLeft;
      } finally {
        programmaticViewportWriteInProgress.current = false;
      }
    },
    []
  );

  useLayoutEffect(() => {
    scrollInputsRef.current = {
      busy,
      contiguousOnly: metadata.backend === "pyspark",
      currentOffset: page.offset,
      currentRowCount: page.rows.length,
      onPage,
      pageSize,
      reportViewState,
      totalRows: logicalRowExtent
    };
  }, [busy, logicalRowExtent, metadata.backend, onPage, page.offset, page.rows.length, pageSize, reportViewState]);

  useLayoutEffect(() => {
    if (previousViewContext.current === logicalViewContext) return;
    previousViewContext.current = logicalViewContext;
    cancelPointerDrag(undefined, false);
    requestedOffset.current = page.offset;
    focusRequested.current = false;
    pointerSelectionFocusRequest.current = undefined;
    preserveGridFocusAfterScroll.current = false;
    const column = selectedColumnPosition(metadata.schema, viewStateRef.current.selectedColumnId);
    const selectedColumnId = metadata.schema[column]?.id;
    const authoritativeRestorePending = appliedViewStateRestoreVersion.current !== viewStateRestoreVersion;
    const firstVisibleRow = authoritativeRestorePending
      ? Math.max(0, Math.min(viewStateRef.current.viewport.firstVisibleRow, Math.max(0, logicalRowExtent - 1)))
      : page.offset;
    setFocusedCell({
      row: authoritativeRestorePending ? firstVisibleRow : (page.rows[0]?.rowNumber ?? page.offset),
      column
    });
    resetGridClipboardSelection({
      row: authoritativeRestorePending ? firstVisibleRow : (page.rows[0]?.rowNumber ?? page.offset),
      column
    });
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const scrollTop = scrollTopForLogicalRow(
      createRowScrollModel(logicalRowExtent, scroller.clientHeight),
      firstVisibleRow
    );
    const scrollLeft = viewStateRef.current.viewport.scrollLeft;
    writeProgrammaticViewport(scroller, { firstVisibleRow, scrollTop, scrollLeft });
    setViewport({
      scrollLeft,
      scrollTop,
      firstVisibleRow,
      width: scroller.clientWidth,
      height: scroller.clientHeight
    });
    // A host snapshot can replace the logical view and restore its confirmed
    // viewport in the same React commit. The restore effect below owns that
    // commit; publishing the new page offset here would queue a stale renderer
    // update that can escape as soon as hydration is acknowledged.
    if (authoritativeRestorePending) return;
    reportViewState({
      ...viewStateRef.current,
      ...(selectedColumnId ? { selectedColumnId } : {}),
      viewport: { firstVisibleRow: page.offset, scrollLeft }
    });
  }, [
    cancelPointerDrag,
    logicalViewContext,
    resetGridClipboardSelection,
    metadata.schema,
    page.offset,
    page.rows,
    logicalRowExtent,
    reportViewState,
    viewStateRestoreVersion,
    writeProgrammaticViewport
  ]);

  useLayoutEffect(() => {
    const restoration = restorationRef.current;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const restorationRowExtent = liveGridLogicalRowExtent(restoration.page);
    const row = Math.max(
      0,
      Math.min(restoration.viewState.viewport.firstVisibleRow, Math.max(0, restorationRowExtent - 1))
    );
    const column = selectedColumnPosition(restoration.metadata.schema, restoration.viewState.selectedColumnId);
    requestedOffset.current = restoration.page.offset;
    focusRequested.current = false;
    pointerSelectionFocusRequest.current = undefined;
    preserveGridFocusAfterScroll.current = false;
    dismissCellActionMenu();
    cancelPointerDrag(undefined, false);
    setFocusedCell({ row, column });
    resetGridClipboardSelectionRef.current({ row, column });
    const scrollTop = scrollTopForLogicalRow(createRowScrollModel(restorationRowExtent, scroller.clientHeight), row);
    const scrollLeft = restoration.viewState.viewport.scrollLeft;
    writeProgrammaticViewport(scroller, { firstVisibleRow: row, scrollTop, scrollLeft });
    setViewport({
      scrollLeft,
      scrollTop,
      firstVisibleRow: row,
      width: scroller.clientWidth,
      height: scroller.clientHeight
    });
    appliedViewStateRestoreVersion.current = viewStateRestoreVersion;
  }, [cancelPointerDrag, dismissCellActionMenu, viewStateRestoreVersion, writeProgrammaticViewport]);

  useEffect(() => {
    requestedOffset.current = page.offset;
  }, [page.offset]);

  const widths = useMemo(
    () => gridColumnWidths(metadata.schema, viewState.columnWidths, defaultColumnWidth),
    [defaultColumnWidth, metadata.schema, viewState.columnWidths]
  );
  const gridVirtualWindow = useMemo(
    () =>
      createGridVirtualWindow({
        logicalRowExtent,
        page,
        rowHeaderWidth,
        viewport,
        widths
      }),
    [logicalRowExtent, page, rowHeaderWidth, viewport, widths]
  );
  const {
    bottomSpacerHeight,
    leftSpacerWidth,
    localRowStart: localStart,
    pageColumnPositionById,
    renderedColumnCount,
    rightSpacerWidth,
    topSpacerHeight,
    totalColumnWidth,
    visibleColumnRange,
    visibleRows
  } = gridVirtualWindow;
  const visibleColumns = useMemo(
    () => metadata.schema.slice(visibleColumnRange.start, visibleColumnRange.end),
    [metadata.schema, visibleColumnRange.end, visibleColumnRange.start]
  );
  const loadedColumnSignature = page.columnIds.join("\u0000");
  const commitColumnReveal = useCallback(
    ({
      columnId,
      columnIndex,
      firstVisibleRow,
      height,
      prepareFocus,
      scrollLeft,
      scrollTop,
      targetIsVisible,
      width
    }: GridColumnRevealCommit): void => {
      if (prepareFocus) {
        preserveGridFocusAfterScroll.current = false;
        focusRequested.current = document.hasFocus();
      }
      programmaticViewportTarget.current = { firstVisibleRow, scrollTop, scrollLeft };
      setViewport((current) => {
        const next = { firstVisibleRow, scrollLeft, scrollTop, width, height };
        return current.firstVisibleRow === next.firstVisibleRow &&
          current.scrollLeft === next.scrollLeft &&
          current.scrollTop === next.scrollTop &&
          current.width === next.width &&
          current.height === next.height
          ? current
          : next;
      });
      if (!targetIsVisible) return;
      setFocusedCell((current) => (current.column === columnIndex ? current : { ...current, column: columnIndex }));
      const currentViewState = viewStateRef.current;
      reportViewState({
        ...currentViewState,
        selectedColumnId: columnId,
        viewport: { ...currentViewState.viewport, scrollLeft }
      });
    },
    [reportViewState]
  );
  const { interrupt: interruptPendingColumnReveal, isPending: columnRevealIsPending } = useGridColumnRevealLifecycle({
    busy,
    columnId: goToColumnId,
    defaultColumnWidth,
    loadedColumnIds: page.columnIds,
    loadedColumnSignature,
    logicalViewContext,
    onCommit: commitColumnReveal,
    onHandled: onGoToColumnHandled,
    pageOffset: page.offset,
    projecting,
    requestId: goToColumnRequestId,
    restoreVersion: viewStateRestoreVersion,
    rowHeaderWidth,
    schema: metadata.schema,
    scrollTolerance: scrollQuantizationTolerance,
    scrollerRef,
    viewStateRef,
    viewportScrollLeft: viewport.scrollLeft,
    viewportWidth: viewport.width,
    visibleColumnRange,
    widths
  });
  const interruptColumnReveal = useCallback(() => {
    viewportUpdatesSuspended.current = false;
    programmaticViewportTarget.current = undefined;
    programmaticViewportRetryAvailable.current = false;
    interruptPendingColumnReveal();
  }, [interruptPendingColumnReveal]);

  const updateViewportFromScroller = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const {
      busy: scrollBusy,
      contiguousOnly,
      currentOffset,
      currentRowCount,
      onPage: requestPage,
      pageSize: blockSize,
      reportViewState,
      totalRows
    } = scrollInputsRef.current;
    const target = programmaticViewportTarget.current;
    if (viewportUpdatesSuspended.current) {
      const firstVisibleRow = Math.max(
        0,
        Math.min(target?.firstVisibleRow ?? viewStateRef.current.viewport.firstVisibleRow, Math.max(0, totalRows - 1))
      );
      const scrollTop = scrollTopForLogicalRow(createRowScrollModel(totalRows, scroller.clientHeight), firstVisibleRow);
      const scrollLeft = target?.scrollLeft ?? viewStateRef.current.viewport.scrollLeft;
      programmaticViewportTarget.current = { firstVisibleRow, scrollTop, scrollLeft };
      scroller.scrollTop = scrollTop;
      scroller.scrollLeft = scrollLeft;
      setViewport((current) => {
        const next = {
          firstVisibleRow,
          scrollLeft,
          scrollTop,
          width: scroller.clientWidth,
          height: scroller.clientHeight
        };
        return current.firstVisibleRow === next.firstVisibleRow &&
          current.scrollLeft === next.scrollLeft &&
          current.scrollTop === next.scrollTop &&
          current.width === next.width &&
          current.height === next.height
          ? current
          : next;
      });
      return;
    }
    const gridOwnsFocus = document.hasFocus() && scroller.contains(document.activeElement);
    preserveGridFocusAfterScroll.current = !focusRequested.current && gridOwnsFocus;
    const requestBlockForRow = (row: number): void => {
      if (terminalPageOverlapsViewport(currentOffset, currentRowCount, totalRows, row, scroller.clientHeight)) {
        return;
      }
      const desiredOffset = Math.floor(row / blockSize) * blockSize;
      const offset = requestedGridPageOffset(desiredOffset, currentOffset, blockSize, contiguousOnly);
      if (scrollBusy || offset === requestedOffset.current || offset >= totalRows) return;
      requestedOffset.current = offset;
      preserveGridFocusAfterScroll.current = false;
      focusRequested.current = gridOwnsFocus;
      const nextFocus = gridOwnsFocus ? continuePointerDragToRow(row) : undefined;
      if (nextFocus) {
        pointerSelectionFocusRequest.current = nextFocus;
        selectGridClipboardCell(nextFocus, true);
        setFocusedCell(nextFocus);
      } else {
        pointerSelectionFocusRequest.current = undefined;
        setFocusedCell((current) => ({ row, column: current.column }));
      }
      requestPage(offset);
    };
    let targetStillQuantized =
      target !== undefined &&
      Math.abs(scroller.scrollTop - target.scrollTop) <= scrollQuantizationTolerance &&
      Math.abs(scroller.scrollLeft - target.scrollLeft) <= scrollQuantizationTolerance;
    const verticalTargetTemporarilyUnavailable =
      target !== undefined &&
      target.scrollTop > 0 &&
      Math.abs(scroller.scrollTop - target.scrollTop) > scrollQuantizationTolerance &&
      (!scroller.isConnected || scroller.clientHeight <= 0 || scroller.scrollHeight <= scroller.clientHeight);
    const horizontalTargetTemporarilyUnavailable =
      target !== undefined &&
      target.scrollLeft > 0 &&
      Math.abs(scroller.scrollLeft - target.scrollLeft) > scrollQuantizationTolerance &&
      (!scroller.isConnected || scroller.clientWidth <= 0 || scroller.scrollWidth <= scroller.clientWidth);
    const targetFitsCurrentGeometry =
      target !== undefined &&
      target.scrollTop <= Math.max(0, scroller.scrollHeight - scroller.clientHeight) + scrollQuantizationTolerance &&
      target.scrollLeft <= Math.max(0, scroller.scrollWidth - scroller.clientWidth) + scrollQuantizationTolerance;
    let restorationRetried = false;
    if (
      target &&
      !targetStillQuantized &&
      (target.firstVisibleRow > 0 || target.scrollLeft > 0) &&
      programmaticViewportRetryAvailable.current &&
      !verticalTargetTemporarilyUnavailable &&
      !horizontalTargetTemporarilyUnavailable &&
      targetFitsCurrentGeometry
    ) {
      // Chromium can publish a delayed scroll-collapse after a renderer or
      // workbench layout transition. Pointer, wheel, and touch input clear the
      // target before this handler runs, so a retained target is still the
      // host-authoritative restoration rather than a user scroll. Reapply it
      // once against the now-available geometry instead of persisting the
      // collapse. A later unexplained divergence is accepted so native or
      // assistive scrolling can never become trapped behind restoration.
      restorationRetried = true;
      programmaticViewportRetryAvailable.current = false;
      writeProgrammaticViewport(scroller, target);
      programmaticViewportRetryAvailable.current = false;
      targetStillQuantized =
        Math.abs(scroller.scrollTop - target.scrollTop) <= scrollQuantizationTolerance &&
        Math.abs(scroller.scrollLeft - target.scrollLeft) <= scrollQuantizationTolerance;
    }
    if (
      target &&
      !targetStillQuantized &&
      (programmaticViewportWriteInProgress.current ||
        restorationRetried ||
        verticalTargetTemporarilyUnavailable ||
        horizontalTargetTemporarilyUnavailable)
    ) {
      if (verticalTargetTemporarilyUnavailable || horizontalTargetTemporarilyUnavailable) {
        requestBlockForRow(target.firstVisibleRow);
      }
      setViewport((current) => {
        const next = {
          firstVisibleRow: target.firstVisibleRow,
          scrollLeft: target.scrollLeft,
          scrollTop: target.scrollTop,
          width: scroller.clientWidth,
          height: scroller.clientHeight
        };
        return current.firstVisibleRow === next.firstVisibleRow &&
          current.scrollLeft === next.scrollLeft &&
          current.scrollTop === next.scrollTop &&
          current.width === next.width &&
          current.height === next.height
          ? current
          : next;
      });
      return;
    }
    if (target && !targetStillQuantized) programmaticViewportTarget.current = undefined;
    const confirmedTarget = target && targetStillQuantized ? target : undefined;
    const scrollTop = confirmedTarget?.scrollTop ?? scroller.scrollTop;
    const scrollLeft = confirmedTarget?.scrollLeft ?? scroller.scrollLeft;
    const next = {
      firstVisibleRow: 0,
      scrollLeft,
      scrollTop,
      width: scroller.clientWidth,
      height: scroller.clientHeight
    };
    const row = confirmedTarget
      ? confirmedTarget.firstVisibleRow
      : logicalRowForScrollTop(createRowScrollModel(totalRows, next.height), next.scrollTop);
    next.firstVisibleRow = row;
    setViewport((current) =>
      current.firstVisibleRow === next.firstVisibleRow &&
      current.scrollLeft === next.scrollLeft &&
      current.scrollTop === next.scrollTop &&
      current.width === next.width &&
      current.height === next.height
        ? current
        : next
    );
    const currentViewState = viewStateRef.current;
    if (
      !columnRevealIsPending() &&
      (currentViewState.viewport.firstVisibleRow !== row || currentViewState.viewport.scrollLeft !== next.scrollLeft)
    ) {
      reportViewState({
        ...currentViewState,
        viewport: { firstVisibleRow: row, scrollLeft: next.scrollLeft }
      });
    }
    requestBlockForRow(row);
  }, [
    columnRevealIsPending,
    continuePointerDragToRow,
    selectGridClipboardCell,
    setFocusedCell,
    setViewport,
    writeProgrammaticViewport
  ]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const update = () => updateViewportFromScroller();
    const suspendViewportUpdates = () => {
      viewportUpdatesSuspended.current = true;
      const firstVisibleRow =
        programmaticViewportTarget.current?.firstVisibleRow ?? viewStateRef.current.viewport.firstVisibleRow;
      const scrollTop = scrollTopForLogicalRow(
        createRowScrollModel(scrollInputsRef.current.totalRows, scroller.clientHeight),
        firstVisibleRow
      );
      const scrollLeft = programmaticViewportTarget.current?.scrollLeft ?? viewStateRef.current.viewport.scrollLeft;
      programmaticViewportTarget.current = { firstVisibleRow, scrollTop, scrollLeft };
    };
    const resumeViewportUpdates = () => {
      if (!viewportUpdatesSuspended.current) return;
      const target = programmaticViewportTarget.current;
      if (target) {
        const scrollTop = scrollTopForLogicalRow(
          createRowScrollModel(scrollInputsRef.current.totalRows, scroller.clientHeight),
          target.firstVisibleRow
        );
        programmaticViewportTarget.current = { ...target, scrollTop };
        scroller.scrollTop = scrollTop;
        scroller.scrollLeft = target.scrollLeft;
      }
      viewportUpdatesSuspended.current = false;
      update();
    };
    const rebaseAfterResize = () => {
      const logicalRow =
        programmaticViewportTarget.current?.firstVisibleRow ?? viewStateRef.current.viewport.firstVisibleRow;
      const scrollTop = scrollTopForLogicalRow(
        createRowScrollModel(scrollInputsRef.current.totalRows, scroller.clientHeight),
        logicalRow
      );
      programmaticViewportTarget.current = {
        firstVisibleRow: logicalRow,
        scrollTop,
        scrollLeft: viewportUpdatesSuspended.current
          ? (programmaticViewportTarget.current?.scrollLeft ?? viewStateRef.current.viewport.scrollLeft)
          : scroller.scrollLeft
      };
      scroller.scrollTop = scrollTop;
      update();
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    scroller.addEventListener("wheel", interruptColumnReveal, { passive: true });
    scroller.addEventListener("pointerdown", interruptColumnReveal, { passive: true });
    scroller.addEventListener("touchstart", interruptColumnReveal, { passive: true });
    window.addEventListener("blur", suspendViewportUpdates);
    window.addEventListener("focus", resumeViewportUpdates);
    window.addEventListener("resize", rebaseAfterResize);
    return () => {
      scroller.removeEventListener("scroll", update);
      scroller.removeEventListener("wheel", interruptColumnReveal);
      scroller.removeEventListener("pointerdown", interruptColumnReveal);
      scroller.removeEventListener("touchstart", interruptColumnReveal);
      window.removeEventListener("blur", suspendViewportUpdates);
      window.removeEventListener("focus", resumeViewportUpdates);
      window.removeEventListener("resize", rebaseAfterResize);
    };
  }, [interruptColumnReveal, updateViewportFromScroller]);

  useEffect(() => {
    updateViewportFromScroller();
  }, [busy, logicalRowExtent, pageSize, updateViewportFromScroller, viewStateRestoreVersion]);

  const viewScope = `${metadata.sessionId}:${metadata.revision}:${JSON.stringify({
    logic: metadata.filterModel.logic ?? "and",
    filters: metadata.filterModel.filters,
    sort: metadata.filterModel.sort
  })}`;
  const applyHeaderProfileFilter = useCallback(
    (column: ColumnSchema, filter: ColumnFilter): void => {
      reportViewState({ ...viewStateRef.current, selectedColumnId: column.id });
      onApplyProfileFilter?.(filter);
    },
    [onApplyProfileFilter, reportViewState]
  );
  const {
    controls: headerProfileControls,
    headerRef: headerProfilesRef,
    renderColumnProfile
  } = useGridHeaderProfiles({
    backend: metadata.backend,
    sessionId: metadata.sessionId,
    scrollerRef,
    visibleColumns,
    summaries,
    visibleSummaryOwner: viewScope,
    insightsOnOpen,
    disabled: profilesDisabled,
    disabledReason: profilesDisabledReason,
    valueMode: profileValueMode,
    onValueModeChange: onProfileValueModeChange,
    onApplyFilter: onApplyProfileFilter ? applyHeaderProfileFilter : undefined,
    onVisibleSummaryColumnsChange
  });
  const rovingRow = visibleRows.some((row) => row.rowNumber === focusedCell.row)
    ? focusedCell.row
    : visibleRows[0]?.rowNumber;
  const rovingColumn = visibleColumns.some((column) => column.position === focusedCell.column)
    ? focusedCell.column
    : visibleColumns[0]?.position;
  useLayoutEffect(() => {
    if (!preserveGridFocusAfterScroll.current) return;
    preserveGridFocusAfterScroll.current = false;
    if (focusRequested.current) return;
    if (!document.hasFocus()) return;
    if (rovingRow === undefined || rovingColumn === undefined) return;
    const selector = `[data-grid-row="${rovingRow}"][data-grid-column="${rovingColumn}"]`;
    scrollerRef.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }, [rovingColumn, rovingRow]);

  useEffect(() => {
    visibleColumnRangeHandler.current({ start: visibleColumnRange.start, end: visibleColumnRange.end });
  }, [busy, loadedColumnSignature, logicalViewContext, page.offset, visibleColumnRange.end, visibleColumnRange.start]);

  useEffect(() => {
    if (!focusRequested.current) return;
    if (!document.hasFocus()) {
      focusRequested.current = false;
      pointerSelectionFocusRequest.current = undefined;
      return;
    }
    const selector = `[data-grid-row="${focusedCell.row}"][data-grid-column="${focusedCell.column}"]`;
    const target = scrollerRef.current?.querySelector<HTMLElement>(selector);
    if (!target) return;
    focusRequested.current = false;
    target.focus({ preventScroll: true });
    pointerSelectionFocusRequest.current = undefined;
  }, [focusedCell, page.offset, visibleColumnRange.start, localStart]);

  const goToPage = (offset: number, restoreFocus = false) => {
    if (busy) return;
    interruptColumnReveal();
    const bounded = Math.max(0, Math.min(offset, Math.max(0, logicalRowExtent - 1)));
    const desiredBlock = Math.floor(bounded / pageSize) * pageSize;
    const block = requestedGridPageOffset(desiredBlock, page.offset, pageSize, metadata.backend === "pyspark");
    requestedOffset.current = block;
    if (restoreFocus) {
      preserveGridFocusAfterScroll.current = false;
      focusRequested.current = document.hasFocus();
    }
    setFocusedCell((current) => ({ row: bounded, column: current.column }));
    const scroller = scrollerRef.current;
    if (scroller) {
      const scrollTop = scrollTopForLogicalRow(createRowScrollModel(logicalRowExtent, scroller.clientHeight), bounded);
      const scrollLeft = scroller.scrollLeft;
      programmaticViewportTarget.current = { firstVisibleRow: bounded, scrollTop, scrollLeft };
      scroller.scrollTop = scrollTop;
      setViewport({
        firstVisibleRow: bounded,
        scrollLeft,
        scrollTop,
        width: scroller.clientWidth,
        height: scroller.clientHeight
      });
      const currentViewState = viewStateRef.current;
      reportViewState({
        ...currentViewState,
        viewport: { firstVisibleRow: bounded, scrollLeft }
      });
    }
    onPage(block);
  };

  return (
    <div className="dataGrid">
      {page.totalRows === 0 && metadata.schema.length === 0 && (
        <div className="emptyState" role="status">
          <strong>Empty dataset</strong>
          <br />
          <span>This source contains 0 rows × 0 columns.</span>
        </div>
      )}

      {diffPresentation && (diffPresentation.addedColumns.length > 0 || diffPresentation.removedColumns.length > 0) && (
        <section className="gridColumnChanges" aria-label="Column changes">
          <strong>Column changes</strong>
          <ul>
            {diffPresentation.addedColumns.map((column, index) => (
              <li
                key={`added-${column.name}-${index}`}
                className="gridColumnChange"
                data-diff-state="added"
                aria-label={`Added column ${column.name}${column.rawType ? `, type ${column.rawType}` : ""}`}
              >
                <span className="codicon codicon-add" aria-hidden="true" />
                <span>Added: {column.name}</span>
              </li>
            ))}
            {diffPresentation.removedColumns.map((column, index) => (
              <li
                key={`removed-${column.name}-${index}`}
                className="gridColumnChange"
                data-diff-state="removed"
                aria-label={`Removed column ${column.name}${column.rawType ? `, previous type ${column.rawType}` : ""}`}
              >
                <span className="codicon codicon-remove" aria-hidden="true" />
                <span>Removed: {column.name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="tableScroller" ref={scrollerRef} data-testid="data-grid-scroller">
        <table
          role="grid"
          style={{
            width: rowHeaderWidth + totalColumnWidth,
            minWidth: rowHeaderWidth + totalColumnWidth,
            userSelect: "none",
            WebkitUserSelect: "none"
          }}
          aria-busy={busy || projecting}
          aria-label={`Data grid for ${metadata.source.label}`}
          aria-describedby={gridSelectionInstructionsId}
          aria-multiselectable="true"
          aria-rowcount={page.totalRows === null ? -1 : page.totalRows + 1}
          aria-colcount={metadata.schema.length + 1}
          title={gridSelectionInstructions}
        >
          <colgroup>
            <col style={{ width: rowHeaderWidth }} />
            {leftSpacerWidth > 0 && <col style={{ width: leftSpacerWidth }} />}
            {visibleColumns.map((column) => (
              <col key={column.id} style={{ width: widths[column.position] }} />
            ))}
            {rightSpacerWidth > 0 && <col style={{ width: rightSpacerWidth }} />}
          </colgroup>
          <thead ref={headerProfilesRef}>
            <tr>
              <th
                className={`rowHeader${hasRowLabels ? " labeledRowHeader" : ""}`}
                aria-label={rowAxisHeader ? `${rowAxisHeader} row labels` : hasRowLabels ? "Row label" : "Row number"}
                style={{ width: rowHeaderWidth, maxWidth: rowHeaderWidth }}
              >
                {rowAxisHeader ?? (hasRowLabels ? "Row" : "#")}
              </th>
              {leftSpacerWidth > 0 && <th className="virtualSpacer" aria-hidden="true" />}
              {visibleColumns.map((column) => {
                const activeSortIndex = sortRules.findIndex((rule) => rule.column === column.name);
                return (
                  <ColumnHeader
                    key={column.id}
                    column={column}
                    ariaColumnIndex={column.position + 2}
                    width={widths[column.position]}
                    selected={viewState.selectedColumnId === column.id}
                    clipboardSelected={gridClipboard.isColumnSelected(column.id)}
                    clipboardAction={gridClipboard.columnCopyAction(column)}
                    logicalViewOwner={logicalViewContext}
                    added={diffPresentation?.addedColumnIds.has(column.id) ?? false}
                    headerProfile={(filterAvailable) => renderColumnProfile(column, filterAvailable)}
                    viewControlsDisabled={viewControlsDisabled}
                    viewControlsDisabledReason={viewControlsDisabledReason}
                    filterControlsDisabled={filterControlsDisabled}
                    filterControlsDisabledReason={filterControlsDisabledReason}
                    sortControlsDisabled={sortControlsDisabled}
                    sortControlsDisabledReason={sortControlsDisabledReason}
                    viewColumnNameCount={viewColumnNameCounts.get(column.name) ?? 0}
                    activeSort={activeSortIndex < 0 ? undefined : sortRules[activeSortIndex]}
                    activeSortIndex={activeSortIndex < 0 ? undefined : activeSortIndex}
                    sortCount={sortRules.length}
                    onOpenFilter={(name) => {
                      reportViewState({ ...viewStateRef.current, selectedColumnId: column.id });
                      onOpenFilter(name);
                    }}
                    onSortColumn={onSortColumn}
                    onClearSortColumn={onClearSortColumn}
                    onSelect={() => {
                      reportViewState({ ...viewStateRef.current, selectedColumnId: column.id });
                      gridClipboard.selectColumn(column);
                    }}
                    onCopy={() => gridClipboard.copyColumn(column)}
                    onBeginResize={beginColumnResize}
                    onResize={(width) =>
                      reportViewState({
                        ...viewStateRef.current,
                        columnWidths: setGridColumnWidth(viewStateRef.current.columnWidths, column.id, width)
                      })
                    }
                  />
                );
              })}
              {rightSpacerWidth > 0 && <th className="virtualSpacer" aria-hidden="true" />}
            </tr>
          </thead>
          <tbody>
            {topSpacerHeight > 0 && (
              <tr className="virtualRowSpacer" aria-hidden="true">
                <td colSpan={renderedColumnCount} style={{ height: topSpacerHeight }} />
              </tr>
            )}
            {visibleRows.map((row) => (
              <tr key={row.id} aria-rowindex={row.rowNumber + 2} style={{ height: gridRowHeight }}>
                <td
                  className={`rowHeader${hasRowLabels ? " labeledRowHeader" : ""}`}
                  role="rowheader"
                  aria-colindex={1}
                  aria-label={
                    row.rowLabel === undefined
                      ? `Row ${row.rowNumber + 1}`
                      : `Row ${row.rowNumber + 1}, ${rowAxisHeader ?? "label"} ${row.rowLabel}`
                  }
                  title={
                    row.rowLabel === undefined
                      ? `Row ${row.rowNumber + 1}`
                      : `${row.rowLabel} (row ${row.rowNumber + 1})`
                  }
                  style={{ width: rowHeaderWidth, maxWidth: rowHeaderWidth }}
                >
                  <span className="rowHeaderText">{row.rowLabel ?? row.rowNumber + 1}</span>
                </td>
                {leftSpacerWidth > 0 && <td className="virtualSpacer" aria-hidden="true" />}
                {visibleColumns.map((column) => {
                  const localColumnPosition = pageColumnPositionById.get(column.id);
                  const cell = localColumnPosition === undefined ? undefined : row.values[localColumnPosition];
                  const cellUnavailable = localColumnPosition === undefined;
                  const clipboardSelected = gridClipboard.isSelected({
                    row: row.rowNumber,
                    column: column.position
                  });
                  const clipboardMenuSelection = gridClipboard.isColumnSelected(column.id)
                    ? "column"
                    : gridClipboard.isRangeSelected({
                          row: row.rowNumber,
                          column: column.position
                        })
                      ? "range"
                      : undefined;
                  const cellDiff = diffPresentation?.changedCells.get(diffCellKey(row.rowNumber, column.id));
                  const addedColumn = diffPresentation?.addedColumnIds.has(column.id) ?? false;
                  const displayCell = gridCellPresentation(cell);
                  const renderedCell = boundedGridText(displayCell.text);
                  const diffLabel = cellDiff
                    ? changedCellLabel(column.name, row.rowNumber, cellDiff)
                    : addedColumn
                      ? addedCellLabel(column.name, row.rowNumber, cell)
                      : undefined;
                  const accessibleLabel =
                    diffLabel ?? (cellUnavailable ? `Loading ${column.name}, row ${row.rowNumber + 1}` : undefined);
                  const ambiguityReason =
                    (viewColumnNameCounts.get(column.name) ?? 0) > 1
                      ? ambiguousViewColumnMessage(column.name, viewColumnNameCounts.get(column.name) ?? 0)
                      : undefined;
                  const cellFilterUnavailableReason = viewControlsDisabled
                    ? viewControlsDisabledReason
                    : filterControlsDisabled
                      ? filterControlsDisabledReason
                      : ambiguityReason
                        ? ambiguityReason
                        : projecting || cellUnavailable
                          ? "Wait for this cell to finish loading before filtering by value."
                          : !cell || !supportsTypedViewComparison(column.type)
                            ? `Filtering by individual ${column.rawType} values is unavailable.`
                            : onApplyCellFilter === undefined
                              ? "Filtering by individual cell values is unavailable for this dataframe."
                              : undefined;
                  const cellMenuOpen =
                    cellFilterMenuTarget?.row === row.rowNumber && cellFilterMenuTarget.columnId === column.id;
                  const cellMenuOpensAbove =
                    row.rowNumber >=
                    viewport.firstVisibleRow + Math.max(2, Math.floor(viewport.height / gridRowHeight) - 4);
                  const cellMenuId = `cell-filter-menu-${row.rowNumber}-${column.position}`;
                  const closeCellMenu = (restoreFocus = false) =>
                    cellActionMenu.close(cellFilterMenuTarget, restoreFocus);
                  const openCellMenu = (clipboardSelection?: "column" | "range") => {
                    reportViewState({ ...viewStateRef.current, selectedColumnId: column.id });
                    const target = { row: row.rowNumber, column: column.position };
                    if (!clipboardSelection) {
                      setFocusedCell(target);
                      gridClipboard.resetSelection(target);
                    }
                    cellActionMenu.open({
                      ...target,
                      columnId: column.id,
                      clipboardSelection,
                      returnFocus: clipboardSelection === "range" ? focusedCell : target,
                      selectionGeneration: gridClipboard.getSelectionGeneration()
                    });
                  };
                  const copySelection = async () => {
                    const operation = cellActionMenu.beginOperation(
                      cellFilterMenuTarget,
                      gridClipboard.getSelectionGeneration()
                    );
                    if (!operation || operation.owner.row !== row.rowNumber || operation.owner.columnId !== column.id) {
                      return;
                    }
                    const completed =
                      operation.owner.clipboardSelection === "column"
                        ? await gridClipboard.copyColumn(operation.ownsResult)
                        : await gridClipboard.copy("range", operation.ownsResult);
                    if (completed) cellActionMenu.completeOperation(operation, true);
                  };
                  const filterAction = (action: "include" | "exclude") => {
                    if (cellFilterUnavailableReason || !cell || !onApplyCellFilter) return;
                    closeCellMenu(true);
                    onApplyCellFilter(viewCellSelectionFilter(column, cell, action));
                  };
                  return (
                    <td
                      key={`${row.id}-${column.id}`}
                      data-grid-row={row.rowNumber}
                      data-grid-column={column.position}
                      aria-colindex={column.position + 2}
                      aria-selected={clipboardSelected}
                      aria-label={accessibleLabel ?? renderedCell ?? ""}
                      data-diff-state={cellDiff ? "changed" : addedColumn ? "added" : undefined}
                      data-clipboard-selected={clipboardSelected ? "true" : undefined}
                      tabIndex={rovingRow === row.rowNumber && rovingColumn === column.position ? 0 : -1}
                      className={[
                        "gridCell",
                        cell?.isNull || cell?.isNaN ? "missingCell" : "",
                        viewState.selectedColumnId === column.id ? "selectedColumn" : "",
                        clipboardSelected ? "gridClipboardSelected" : "",
                        cellDiff ? "diffChangedCell" : "",
                        addedColumn ? "diffAddedColumn" : "",
                        cellMenuOpen ? "cellFilterMenuOpen" : ""
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      title={accessibleLabel ?? displayCell.title ?? renderedCell}
                      onFocus={(event) => {
                        if (event.target !== event.currentTarget) return;
                        const pointerFocusRequest = pointerSelectionFocusRequest.current;
                        const preserveClipboardSelection =
                          pointerDragIsActive() ||
                          (pointerFocusRequest?.row === row.rowNumber &&
                            pointerFocusRequest.column === column.position);
                        focusRequested.current = false;
                        pointerSelectionFocusRequest.current = undefined;
                        setFocusedCell({ row: row.rowNumber, column: column.position });
                        if (!preserveClipboardSelection) {
                          gridClipboard.focusCell({ row: row.rowNumber, column: column.position });
                        }
                        reportViewState({ ...viewStateRef.current, selectedColumnId: column.id });
                      }}
                      onPointerDown={(event) => {
                        if (event.button === 2 && clipboardMenuSelection) {
                          event.preventDefault();
                          return;
                        }
                        if (event.button !== 0 || gridCellControlTarget(event.target, event.currentTarget)) return;
                        dismissCellActionMenu();
                        cancelPointerDrag(undefined, false);
                        pointerSelectionFocusRequest.current = undefined;
                        const start = { row: row.rowNumber, column: column.position };
                        const modifierStartsNewSelection = event.ctrlKey || event.metaKey;
                        gridClipboard.selectCell(start, event.shiftKey && !modifierStartsNewSelection);
                        setFocusedCell(start);
                        reportViewState({ ...viewStateRef.current, selectedColumnId: column.id });
                        if (event.pointerType === "touch") return;

                        beginPointerDrag(event, start, {
                          columnCount: metadata.schema.length,
                          rowCount: logicalRowExtent,
                          onMove: (coordinate) => {
                            gridClipboard.selectCell(coordinate, true);
                            setFocusedCell(coordinate);
                            const selectedColumnId = metadata.schema[coordinate.column]?.id;
                            if (selectedColumnId) {
                              reportViewState({ ...viewStateRef.current, selectedColumnId });
                            }
                          }
                        });
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        openCellMenu(clipboardMenuSelection);
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.target === event.currentTarget &&
                          (event.ctrlKey || event.metaKey) &&
                          event.key.toLowerCase() === "c"
                        ) {
                          event.preventDefault();
                          if (gridClipboard.isColumnSelected(column.id)) void gridClipboard.copyColumn();
                          else void gridClipboard.copy("range");
                          return;
                        }
                        if (
                          event.target === event.currentTarget &&
                          (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
                        ) {
                          event.preventDefault();
                          openCellMenu(clipboardMenuSelection);
                          return;
                        }
                        if (event.target !== event.currentTarget) return;
                        navigateGrid(event, row.rowNumber, column.position, metadata.schema.length, logicalRowExtent);
                      }}
                    >
                      <span className="gridCellText" title={displayCell.title ?? renderedCell}>
                        {renderedCell}
                      </span>
                      <button
                        type="button"
                        className="cellFilterButton codicon codicon-filter"
                        tabIndex={-1}
                        aria-label={`Filter ${column.name} by this cell`}
                        aria-haspopup="menu"
                        aria-expanded={cellMenuOpen}
                        aria-controls={cellMenuOpen ? cellMenuId : undefined}
                        title={cellFilterUnavailableReason ?? `Filter ${column.name} by this cell`}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (cellMenuOpen) closeCellMenu(true);
                          else openCellMenu();
                        }}
                      />
                      {cellMenuOpen && (
                        <div
                          id={cellMenuId}
                          className={`cellFilterMenuPopup${cellMenuOpensAbove ? " openAbove" : ""}`}
                          role="menu"
                          tabIndex={-1}
                          aria-label={
                            cellFilterMenuTarget?.clipboardSelection === "range"
                              ? `Cell and range actions for ${column.name}`
                              : cellFilterMenuTarget?.clipboardSelection === "column"
                                ? `Cell and column actions for ${column.name}`
                                : `Filter ${column.name} by this cell`
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              event.stopPropagation();
                              closeCellMenu(true);
                              return;
                            }
                            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                            const actions = [
                              ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")
                            ].filter((button) => !button.disabled);
                            if (actions.length === 0) return;
                            const current = actions.indexOf(document.activeElement as HTMLButtonElement);
                            const next =
                              event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? actions.length - 1
                                  : event.key === "ArrowDown"
                                    ? (current + 1) % actions.length
                                    : (current - 1 + actions.length) % actions.length;
                            event.preventDefault();
                            event.stopPropagation();
                            actions[next]?.focus({ preventScroll: true });
                          }}
                        >
                          {cellFilterUnavailableReason && (
                            <span className="cellFilterMenuNotice">{cellFilterUnavailableReason}</span>
                          )}
                          <button
                            type="button"
                            role="menuitem"
                            disabled={cellFilterUnavailableReason !== undefined}
                            title={cellFilterUnavailableReason}
                            onClick={() => filterAction("include")}
                          >
                            {cellFilterActionLabel(cell, "include")}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            disabled={cellFilterUnavailableReason !== undefined}
                            title={cellFilterUnavailableReason}
                            onClick={() => filterAction("exclude")}
                          >
                            {cellFilterActionLabel(cell, "exclude")}
                          </button>
                          {cellFilterMenuTarget?.clipboardSelection && (
                            <button
                              type="button"
                              role="menuitem"
                              disabled={
                                cellFilterMenuTarget.clipboardSelection === "column"
                                  ? !gridClipboard.wholeColumnResult.ok
                                  : !gridClipboard.results.range.ok
                              }
                              title={
                                cellFilterMenuTarget.clipboardSelection === "column"
                                  ? gridClipboard.wholeColumnResult.ok
                                    ? "Copy column"
                                    : gridClipboard.wholeColumnResult.reason
                                  : gridClipboard.results.range.ok
                                    ? "Copy selected cells"
                                    : gridClipboard.results.range.reason
                              }
                              onClick={() => void copySelection()}
                            >
                              {cellFilterMenuTarget.clipboardSelection === "column" ? "Copy column" : "Copy selection"}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}
                {rightSpacerWidth > 0 && <td className="virtualSpacer" aria-hidden="true" />}
              </tr>
            ))}
            {bottomSpacerHeight > 0 && (
              <tr className="virtualRowSpacer" aria-hidden="true">
                <td colSpan={renderedColumnCount} style={{ height: bottomSpacerHeight }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="gridStatusBar">
        <button
          type="button"
          className="gridNavigationButton"
          aria-label="Previous block"
          disabled={busy || page.offset === 0}
          onClick={() => goToPage(page.offset - pageSize)}
        >
          <span className="codicon codicon-chevron-left" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="gridNavigationButton"
          aria-label="Next block"
          disabled={busy || !hasMoreRows}
          onClick={() => goToPage(page.offset + pageSize)}
        >
          <span className="codicon codicon-chevron-right" aria-hidden="true" />
        </button>
        <span
          className="visibleRowsStatus"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label="Visible rows"
        >
          {page.totalRows === 0
            ? "No rows"
            : page.totalRows === null
              ? `Rows ${(page.offset + 1).toLocaleString()}\u2013${(
                  page.offset + page.rows.length
                ).toLocaleString()} · total appears after the last page`
              : `Rows ${(page.offset + 1).toLocaleString()}\u2013${Math.min(
                  page.offset + page.rows.length,
                  page.totalRows
                ).toLocaleString()} of ${page.totalRows.toLocaleString()}`}
        </span>
        <span id={gridSelectionInstructionsId} className="gridClipboardAnnouncement">
          {gridSelectionInstructions}
        </span>
        <GridClipboardControls controller={gridClipboard} />
        {headerProfileControls}
      </div>
    </div>
  );

  function navigateGrid(
    event: ReactKeyboardEvent<HTMLTableCellElement>,
    row: number,
    column: number,
    columnCount: number,
    rowCount: number
  ): void {
    let nextRow = row;
    let nextColumn = column;
    const measuredViewportHeight = scrollerRef.current?.clientHeight ?? viewport.height;
    const pageRowCount = Math.max(1, Math.floor(measuredViewportHeight / gridRowHeight));
    if ((event.ctrlKey || event.metaKey) && event.key === "Home") {
      nextRow = 0;
      nextColumn = 0;
    } else if ((event.ctrlKey || event.metaKey) && event.key === "End") {
      nextRow = rowCount - 1;
      nextColumn = columnCount - 1;
    } else if (event.key === "ArrowRight") nextColumn += 1;
    else if (event.key === "ArrowLeft") nextColumn -= 1;
    else if (event.key === "ArrowDown") nextRow += 1;
    else if (event.key === "ArrowUp") nextRow -= 1;
    else if (event.key === "Home") nextColumn = 0;
    else if (event.key === "End") nextColumn = columnCount - 1;
    else if (event.key === "PageDown") nextRow += pageRowCount;
    else if (event.key === "PageUp") nextRow -= pageRowCount;
    else return;
    nextRow = Math.max(0, Math.min(nextRow, rowCount - 1));
    nextColumn = Math.max(0, Math.min(nextColumn, columnCount - 1));
    const block = Math.floor(nextRow / pageSize) * pageSize;
    if (busy && block !== page.offset) return;
    interruptColumnReveal();
    event.preventDefault();
    preserveGridFocusAfterScroll.current = false;
    focusRequested.current = document.hasFocus();
    setFocusedCell({ row: nextRow, column: nextColumn });
    gridClipboard.selectCell({ row: nextRow, column: nextColumn }, event.shiftKey);
    const scroller = scrollerRef.current;
    let firstVisibleRow = viewStateRef.current.viewport.firstVisibleRow;
    if (scroller) {
      firstVisibleRow = Math.max(0, nextRow - Math.floor(pageRowCount / 2));
      const scrollTop = scrollTopForLogicalRow(
        createRowScrollModel(logicalRowExtent, scroller.clientHeight),
        firstVisibleRow
      );
      const scrollLeft = centeredColumnScrollLeft(
        widths,
        nextColumn,
        scroller.clientWidth,
        rowHeaderWidth,
        defaultColumnWidth
      );
      programmaticViewportTarget.current = {
        firstVisibleRow,
        scrollTop,
        scrollLeft
      };
      scroller.scrollTop = scrollTop;
      scroller.scrollLeft = scrollLeft;
    }
    const currentViewState = viewStateRef.current;
    reportViewState({
      ...currentViewState,
      selectedColumnId: metadata.schema[nextColumn]?.id,
      viewport: {
        firstVisibleRow,
        scrollLeft: scroller?.scrollLeft ?? currentViewState.viewport.scrollLeft
      }
    });
    if (block !== page.offset) goToPage(nextRow, true);
  }
}

function boundedGridText(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= maximumRenderedCellCharacters) return value;
  let end = maximumRenderedCellCharacters;
  const finalCodeUnit = value.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

const maximumGridNumberSignificantDigits = 12;

function gridCellPresentation(cell: CellValue | undefined): { text: string | undefined; title?: string } {
  if (
    cell?.kind !== "number" ||
    typeof cell.raw !== "number" ||
    !Number.isFinite(cell.raw) ||
    cell.display !== String(cell.raw)
  ) {
    return { text: cell?.display };
  }

  const text = Object.is(cell.raw, -0)
    ? "-0"
    : String(Number.parseFloat(cell.raw.toPrecision(maximumGridNumberSignificantDigits)));
  return text === cell.display ? { text } : { text, title: cell.display };
}

interface GridDiffPresentation {
  addedColumnIds: Set<string>;
  addedColumns: Array<{ name: string; rawType: string | undefined }>;
  removedColumns: Array<{ name: string; rawType: string | undefined }>;
  changedCells: Map<string, CellDiff>;
}

function buildDiffPresentation(
  diff: DataDiff | undefined,
  page: LiveGridPage,
  schema: ColumnSchema[],
  beforePage: GridPage | undefined,
  beforeSchema: ColumnSchema[] | undefined
): GridDiffPresentation | undefined {
  if (!diff) return undefined;

  const addedColumnIds = resolveAddedColumnIds(diff.addedColumns, schema, beforeSchema);
  const changedCells = new Map<string, CellDiff>();
  const rowsByNumber = new Map(page.rows.map((row) => [row.rowNumber, row]));
  const beforeRowsById = new Map(beforePage?.rows.map((row) => [row.id, row]) ?? []);
  const pagePositionById = new Map(page.columnIds.map((columnId, position) => [columnId, position]));
  const beforePositionById = new Map(beforePage?.columnIds.map((columnId, position) => [columnId, position]) ?? []);
  const schemaById = new Map(schema.map((column) => [column.id, column]));
  const comparableColumns = page.columnIds.flatMap((columnId, afterPosition) => {
    const column = schemaById.get(columnId);
    const beforePosition = beforePositionById.get(columnId);
    return column && beforePosition !== undefined ? [{ column, beforePosition, afterPosition }] : [];
  });
  const rememberChangedCell = (columnId: string, cellDiff: CellDiff) => {
    changedCells.set(diffCellKey(cellDiff.rowNumber, columnId), cellDiff);
  };

  if (beforePage && beforeSchema) {
    for (const row of page.rows) {
      const beforeRow = beforeRowsById.get(row.id);
      if (!beforeRow) continue;
      for (const { column, beforePosition, afterPosition } of comparableColumns) {
        const before = beforeRow.values[beforePosition];
        const after = row.values[afterPosition];
        if (!before || !after || sameCellValue(before, after)) continue;
        rememberChangedCell(column.id, {
          rowNumber: row.rowNumber,
          columnId: column.id,
          column: column.name,
          before,
          after
        });
      }
    }
  }

  for (const cellDiff of diff.cells) {
    const key = diffCellKey(cellDiff.rowNumber, cellDiff.columnId);
    if (changedCells.has(key)) continue;
    const row = rowsByNumber.get(cellDiff.rowNumber);
    if (!row) continue;
    const afterPosition = pagePositionById.get(cellDiff.columnId);
    if (afterPosition === undefined || !sameCellValue(row.values[afterPosition], cellDiff.after)) continue;
    rememberChangedCell(cellDiff.columnId, cellDiff);
  }

  return {
    addedColumnIds,
    addedColumns: diff.addedColumns.map((name) => ({
      name,
      rawType: schema.find((column) => column.name === name)?.rawType
    })),
    removedColumns: diff.removedColumns.map((name) => ({
      name,
      rawType: beforeSchema?.find((column) => column.name === name)?.rawType
    })),
    changedCells
  };
}

function resolveAddedColumnIds(
  addedColumnNames: string[],
  schema: ColumnSchema[],
  beforeSchema: ColumnSchema[] | undefined
): Set<string> {
  const remainingByName = countNames(addedColumnNames);
  const beforeIds = new Set(beforeSchema?.map((column) => column.id) ?? []);
  const addedIds = new Set<string>();
  const takeMatchingColumns = (columns: ColumnSchema[]) => {
    for (const column of columns) {
      const remaining = remainingByName.get(column.name) ?? 0;
      if (remaining <= 0 || addedIds.has(column.id)) continue;
      addedIds.add(column.id);
      remainingByName.set(column.name, remaining - 1);
    }
  };
  if (beforeSchema) takeMatchingColumns(schema.filter((column) => !beforeIds.has(column.id)));
  takeMatchingColumns(schema);
  return addedIds;
}

function countNames(names: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

function sameCellValue(left: CellValue | null | undefined, right: CellValue | null | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.kind === right.kind &&
    left.display === right.display &&
    left.isNull === right.isNull &&
    left.isNaN === right.isNaN &&
    left.sign === right.sign &&
    sameJsonValue(left.raw, right.raw)
  );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key]))
  );
}

function diffCellKey(rowNumber: number, columnId: string): string {
  return `${rowNumber}\u0000${columnId}`;
}

function changedCellLabel(column: string, rowNumber: number, diff: CellDiff): string {
  return `${column}, row ${rowNumber + 1}: changed from ${describeCellValue(diff.before)} to ${describeCellValue(diff.after)}`;
}

function addedCellLabel(column: string, rowNumber: number, value: CellValue | undefined): string {
  return `${column}, row ${rowNumber + 1}: added column; before column absent; after ${describeCellValue(value)}`;
}

function describeCellValue(value: CellValue | null | undefined): string {
  if (!value) return "no value";
  if (value.isNull) return "null";
  if (value.isNaN) return "NaN";
  if (value.display.length === 0) return value.kind === "string" ? "empty string" : "empty value";
  const normalized = value.display.replace(/\s+/gu, " ");
  return normalized.length > 160 ? `${normalized.slice(0, 159)}…` : normalized;
}

function cellFilterActionLabel(cell: CellValue | undefined, action: "include" | "exclude"): string {
  if (cell?.isNull) return action === "include" ? "Keep only null values" : "Exclude null values";
  if (cell?.isNaN) return action === "include" ? "Keep only NaN values" : "Exclude NaN values";
  return action === "include" ? "Keep only this value" : "Exclude this value";
}

function ColumnHeader({
  column,
  ariaColumnIndex,
  width,
  selected,
  clipboardSelected,
  clipboardAction,
  logicalViewOwner,
  added,
  headerProfile,
  viewControlsDisabled,
  viewControlsDisabledReason,
  filterControlsDisabled,
  filterControlsDisabledReason,
  sortControlsDisabled,
  sortControlsDisabledReason,
  viewColumnNameCount,
  activeSort,
  activeSortIndex,
  sortCount,
  onOpenFilter,
  onSortColumn,
  onClearSortColumn,
  onSelect,
  onCopy,
  onBeginResize,
  onResize
}: {
  column: ColumnSchema;
  ariaColumnIndex: number;
  width: number;
  selected: boolean;
  clipboardSelected: boolean;
  clipboardAction: {
    ariaLabel: string;
    disabled: boolean;
    menuLabel: string;
    title: string;
  };
  logicalViewOwner: string;
  added: boolean;
  headerProfile(filterAvailable: boolean): ReactNode;
  viewControlsDisabled: boolean;
  viewControlsDisabledReason: string;
  filterControlsDisabled: boolean;
  filterControlsDisabledReason: string;
  sortControlsDisabled: boolean;
  sortControlsDisabledReason: string;
  viewColumnNameCount: number;
  activeSort: SortRule | undefined;
  activeSortIndex: number | undefined;
  sortCount: number;
  onOpenFilter(column: string): void;
  onSortColumn(column: string, direction: SortDirection): void;
  onClearSortColumn(column: string): void;
  onSelect(): void;
  onCopy(): Promise<boolean>;
  onBeginResize: BeginColumnResize;
  onResize(width: number): void;
}) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const logicalViewOwnerRef = useRef(logicalViewOwner);
  useLayoutEffect(() => {
    logicalViewOwnerRef.current = logicalViewOwner;
  }, [logicalViewOwner]);
  const menuGenerationRef = useRef(0);
  const menuOperationGenerationRef = useRef(0);
  const clipboardOperationGenerationRef = useRef(0);
  const pendingClipboardOperationCountRef = useRef(0);
  const mountedRef = useRef(true);
  const [clipboardOperationState, setClipboardOperationState] = useState({ generation: 0, pending: 0 });
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const disabledDescriptionId = `column-view-controls-disabled-${column.position}`;
  const filterDisabledDescriptionId = `column-filter-disabled-${column.position}`;
  const sortDisabledDescriptionId = `column-sort-disabled-${column.position}`;
  const comparisonUnavailable = !supportsTypedViewComparison(column.type);
  const ambiguityReason =
    viewColumnNameCount > 1 ? ambiguousViewColumnMessage(column.name, viewColumnNameCount) : undefined;
  const filterUnavailable = viewControlsDisabled || filterControlsDisabled || ambiguityReason !== undefined;
  const filterUnavailableReason = viewControlsDisabled
    ? viewControlsDisabledReason
    : filterControlsDisabled
      ? filterControlsDisabledReason
      : ambiguityReason;
  const sortUnavailable = viewControlsDisabled || sortControlsDisabled || ambiguityReason !== undefined;
  const sortUnavailableReason = viewControlsDisabled
    ? viewControlsDisabledReason
    : sortControlsDisabled
      ? sortControlsDisabledReason
      : ambiguityReason;
  const beginResize: PointerEventHandler<HTMLButtonElement> = (event) => {
    if (viewControlsDisabled) return;
    onBeginResize(event, width, onResize);
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (viewControlsDisabled) return;
    if (event.key === "ArrowLeft") onResize(Math.max(80, width - 10));
    else if (event.key === "ArrowRight") onResize(Math.min(640, width + 10));
    else if (event.key === "Home") onResize(80);
    else if (event.key === "End") onResize(640);
    else return;
    event.preventDefault();
  };
  const closeMenu = () => {
    if (menuRef.current) menuRef.current.open = false;
  };
  const runMenuAction = (action: () => void) => {
    closeMenu();
    action();
  };
  const runClipboardAction = async (): Promise<boolean> => {
    clipboardOperationGenerationRef.current += 1;
    pendingClipboardOperationCountRef.current += 1;
    setClipboardOperationState({
      generation: clipboardOperationGenerationRef.current,
      pending: pendingClipboardOperationCountRef.current
    });
    try {
      return await onCopy();
    } finally {
      pendingClipboardOperationCountRef.current -= 1;
      if (mountedRef.current) {
        setClipboardOperationState({
          generation: clipboardOperationGenerationRef.current,
          pending: pendingClipboardOperationCountRef.current
        });
      }
    }
  };
  const runClipboardMenuAction = async () => {
    const menu = menuRef.current;
    const menuGeneration = menuGenerationRef.current;
    const operationViewOwner = logicalViewOwner;
    const operationGeneration = ++menuOperationGenerationRef.current;
    if (
      (await runClipboardAction()) &&
      menuRef.current === menu &&
      menu?.open === true &&
      logicalViewOwnerRef.current === operationViewOwner &&
      menuGenerationRef.current === menuGeneration &&
      menuOperationGenerationRef.current === operationGeneration
    ) {
      closeMenu();
    }
  };
  const activeSortLabel =
    activeSort &&
    `${activeSort.direction === "asc" ? "ascending" : "descending"}${
      sortCount > 1 && activeSortIndex !== undefined ? `, priority ${activeSortIndex + 1} of ${sortCount}` : ""
    }`;

  return (
    <th
      data-column={column.name}
      data-grid-column={column.position}
      aria-colindex={ariaColumnIndex}
      aria-selected={selected || clipboardSelected}
      aria-sort={
        activeSortIndex === 0
          ? activeSort?.direction === "asc"
            ? "ascending"
            : activeSort?.direction === "desc"
              ? "descending"
              : undefined
          : undefined
      }
      aria-label={[
        column.name,
        clipboardSelected ? "whole filtered and sorted column selected" : "",
        added ? "added column" : "",
        activeSortLabel ? `sorted ${activeSortLabel}` : ""
      ]
        .filter(Boolean)
        .join(", ")}
      data-diff-state={added ? "added" : undefined}
      data-clipboard-selected={clipboardSelected ? "true" : undefined}
      data-clipboard-operation-generation={clipboardOperationState.generation}
      data-clipboard-operation-pending={clipboardOperationState.pending > 0 ? "true" : "false"}
      className={[
        selected ? "selectedColumn" : "",
        clipboardSelected ? "gridClipboardSelected" : "",
        added ? "diffAddedColumn" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      title={`${column.rawType}${column.nullable ? " nullable" : ""}${added ? ", added column" : ""}`}
      tabIndex={0}
      onClick={(event) => {
        if (columnHeaderControlTarget(event.target, event.currentTarget)) return;
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
          event.preventDefault();
          void runClipboardAction();
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect();
      }}
    >
      <div className="columnHeader">
        <span className="columnTitle" title={column.name}>
          {column.name}
        </span>
        <div className="columnMetaRow">
          <span className="columnType" title={column.rawType}>
            <span className={`typeIcon codicon ${columnTypePresentation(column).icon}`} aria-hidden="true" />
            <small>{column.rawType}</small>
          </span>
          <div className="columnHeaderActions">
            {activeSort && (
              <button
                type="button"
                className={`columnSortIndicator codicon ${
                  activeSort.direction === "asc" ? "codicon-arrow-up" : "codicon-arrow-down"
                }`}
                aria-label={`Clear sort for ${column.name}; currently ${activeSortLabel}`}
                disabled={sortUnavailable}
                title={sortUnavailable ? sortUnavailableReason : `Sorted ${activeSortLabel}. Clear sort`}
                onClick={() => onClearSortColumn(column.name)}
              >
                {sortCount > 1 && activeSortIndex !== undefined && (
                  <span className="sortPriority" aria-hidden="true">
                    {activeSortIndex + 1}
                  </span>
                )}
              </button>
            )}
            <details
              ref={menuRef}
              className="columnMenu"
              onToggle={() => {
                menuGenerationRef.current += 1;
              }}
            >
              <summary aria-label={`Column actions for ${column.name}`} className="codicon codicon-ellipsis" />
              <div className="columnMenuContent">
                {viewControlsDisabled && (
                  <span id={disabledDescriptionId} className="columnMenuNotice">
                    {viewControlsDisabledReason}
                  </span>
                )}
                {!viewControlsDisabled && filterControlsDisabled && (
                  <span id={filterDisabledDescriptionId} className="columnMenuNotice">
                    {filterControlsDisabledReason}
                  </span>
                )}
                {!viewControlsDisabled && sortControlsDisabled && (
                  <span id={sortDisabledDescriptionId} className="columnMenuNotice">
                    {sortControlsDisabledReason}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={clipboardAction.ariaLabel}
                  disabled={clipboardAction.disabled}
                  title={clipboardAction.title}
                  onClick={() => void runClipboardMenuAction()}
                >
                  {clipboardAction.menuLabel}
                </button>
                <button
                  type="button"
                  disabled={filterUnavailable}
                  aria-describedby={
                    filterUnavailable
                      ? viewControlsDisabled
                        ? disabledDescriptionId
                        : filterControlsDisabled
                          ? filterDisabledDescriptionId
                          : undefined
                      : undefined
                  }
                  title={filterUnavailableReason}
                  onClick={() => runMenuAction(() => onOpenFilter(column.name))}
                >
                  Filter…
                </button>
                <button
                  type="button"
                  disabled={sortUnavailable || comparisonUnavailable}
                  aria-describedby={
                    sortUnavailable
                      ? viewControlsDisabled
                        ? disabledDescriptionId
                        : sortControlsDisabled
                          ? sortDisabledDescriptionId
                          : undefined
                      : undefined
                  }
                  title={
                    sortUnavailable
                      ? sortUnavailableReason
                      : comparisonUnavailable
                        ? `Sorting is unavailable for ${column.type} columns`
                        : undefined
                  }
                  onClick={() => runMenuAction(() => onSortColumn(column.name, "asc"))}
                >
                  Sort ascending
                </button>
                <button
                  type="button"
                  disabled={sortUnavailable || comparisonUnavailable}
                  aria-describedby={
                    sortUnavailable
                      ? viewControlsDisabled
                        ? disabledDescriptionId
                        : sortControlsDisabled
                          ? sortDisabledDescriptionId
                          : undefined
                      : undefined
                  }
                  title={
                    sortUnavailable
                      ? sortUnavailableReason
                      : comparisonUnavailable
                        ? `Sorting is unavailable for ${column.type} columns`
                        : undefined
                  }
                  onClick={() => runMenuAction(() => onSortColumn(column.name, "desc"))}
                >
                  Sort descending
                </button>
                {activeSort && (
                  <button
                    type="button"
                    disabled={sortUnavailable}
                    title={sortUnavailableReason}
                    onClick={() => runMenuAction(() => onClearSortColumn(column.name))}
                  >
                    Clear sort
                  </button>
                )}
              </div>
            </details>
          </div>
        </div>
        <button
          type="button"
          className="columnResizeHandle codicon codicon-gripper"
          aria-label={`Resize ${column.name} column`}
          disabled={viewControlsDisabled}
          aria-describedby={viewControlsDisabled ? disabledDescriptionId : undefined}
          title={viewControlsDisabled ? viewControlsDisabledReason : undefined}
          onPointerDown={beginResize}
          onKeyDown={resizeWithKeyboard}
        />
      </div>
      {headerProfile(!filterUnavailable && !comparisonUnavailable)}
    </th>
  );
}

function columnHeaderControlTarget(target: EventTarget, header: HTMLTableCellElement): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest("button, details, summary, a, input, select, textarea, [role='button']");
  return control !== null && control !== header;
}

function gridCellControlTarget(target: EventTarget, cell: HTMLTableCellElement): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest("button, [role='menu'], [role='menuitem']");
  return control !== null && control !== cell;
}

function selectedColumnPosition(schema: ColumnSchema[], selectedColumnId: string | undefined): number {
  if (!schema.length) return 0;
  const selected = selectedColumnId ? schema.findIndex((column) => column.id === selectedColumnId) : -1;
  return selected >= 0 ? selected : 0;
}
