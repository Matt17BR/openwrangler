import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type {
  CellDiff,
  CellValue,
  ColumnFilter,
  ColumnSchema,
  ColumnSummary,
  ColumnVisualization,
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
  viewCellSelectionFilter,
  viewNumericBinFilter,
  viewValueSelectionFilter
} from "../../shared/filterModel";
import type { GridViewState } from "../../shared/viewState";
import {
  createRowScrollModel,
  gridRowHeight,
  logicalRowForScrollTop,
  renderedRowSegmentSpacers,
  scrollTopForLogicalRow
} from "./rowScrollModel";
import { columnTypePresentation } from "../columnTypes";
import { numericExtremumDisplay } from "../numericSummary";
import { ProfileValueToggle } from "../ProfileValueToggle";
import { NumericHistogram } from "../visualizations/NumericHistogram";
import {
  describeProfileValue,
  formatProfileValue,
  profileDistributionDenominator,
  type ProfileValueMode
} from "../profileValueMode";

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

export interface VisibleColumnRange {
  start: number;
  end: number;
}

interface ProgrammaticViewportTarget {
  firstVisibleRow: number;
  scrollTop: number;
  scrollLeft: number;
}

interface CellFilterMenuTarget {
  row: number;
  column: number;
  columnId: string;
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

const numericRowHeaderWidth = 58;
const maximumLabeledRowHeaderWidth = 180;
const rowLabelCharacterWidth = 8;
const rowLabelHorizontalPadding = 20;
const overscanRows = 8;
const overscanColumns = 2;
const scrollQuantizationTolerance = 1;
// Chromium can publish the final horizontal grid geometry without notifying a
// ResizeObserver (notably while Cursor reveals another workbench panel). Keep
// one short, bounded post-layout watch so that silent geometry changes still
// complete a requested column reveal. Concrete wake signals remain installed
// after this budget is exhausted and may start another bounded watch.
const maximumColumnRevealLayoutFrames = 120;
const maximumRenderedCellCharacters = 4_096;
const defaultViewState: GridViewState = { columnWidths: {}, viewport: { firstVisibleRow: 0, scrollLeft: 0 } };
const ignoreViewStateChange = (): void => undefined;
const ignoreVisibleColumnRangeChange = (): void => undefined;
const ignoreColumnRevealSignal = (): void => undefined;

export function requestedGridPageOffset(
  desiredOffset: number,
  currentOffset: number,
  pageSize: number,
  contiguousOnly: boolean
): number {
  if (!contiguousOnly) return desiredOffset;
  return Math.max(0, Math.max(currentOffset - pageSize, Math.min(desiredOffset, currentOffset + pageSize)));
}

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
  const pageHasRowLabels = page.rows.some((row) => row.rowLabel !== undefined);
  const summaryByColumnId = useMemo(
    () => new Map(summaries.map((summary) => [summary.columnId, summary])),
    [summaries]
  );
  const viewColumnNameCounts = useMemo(() => countViewColumnNames(metadata.schema), [metadata.schema]);
  const diffPresentation = useMemo(
    () => buildDiffPresentation(diff, page, metadata.schema, beforePage, beforeSchema),
    [beforePage, beforeSchema, diff, metadata.schema, page]
  );
  const scrollerRef = useRef<HTMLDivElement>(null);
  const nextRowHeaderWidth = rowHeaderWidthForRows(page.rows);
  const [rowHeaderState, setRowHeaderState] = useState({
    sessionId: metadata.sessionId,
    hasLabels: pageHasRowLabels,
    width: nextRowHeaderWidth
  });
  let resolvedRowHeaderState = rowHeaderState;
  if (rowHeaderState.sessionId !== metadata.sessionId) {
    resolvedRowHeaderState = {
      sessionId: metadata.sessionId,
      hasLabels: pageHasRowLabels,
      width: nextRowHeaderWidth
    };
  } else if (pageHasRowLabels) {
    const width = Math.max(rowHeaderState.width, nextRowHeaderWidth);
    if (!rowHeaderState.hasLabels || width !== rowHeaderState.width) {
      resolvedRowHeaderState = { ...rowHeaderState, hasLabels: true, width };
    }
  }
  if (resolvedRowHeaderState !== rowHeaderState) setRowHeaderState(resolvedRowHeaderState);
  const hasRowLabels = resolvedRowHeaderState.hasLabels;
  const rowHeaderWidth = resolvedRowHeaderState.width;
  const requestedGoToColumnRequest = useRef<{ requestId: number; restoreVersion: number } | undefined>(undefined);
  const handledGoToColumnRequest = useRef<{ requestId: number; restoreVersion: number } | undefined>(undefined);
  const scheduleColumnRevealAttempt = useRef<() => void>(ignoreColumnRevealSignal);
  const stopColumnRevealWakeSources = useRef<() => void>(ignoreColumnRevealSignal);
  const goToColumnRequestRef = useRef({
    columnId: goToColumnId,
    requestId: goToColumnRequestId,
    restoreVersion: viewStateRestoreVersion,
    onHandled: onGoToColumnHandled
  });
  const visibleColumnRangeHandler = useRef(onVisibleColumnRangeChange);
  const requestedOffset = useRef(page.offset);
  const logicalViewContext = viewContextId ?? `${metadata.sessionId}:${metadata.revision}`;
  const previousViewContext = useRef(logicalViewContext);
  const appliedViewStateRestoreVersion = useRef<number | undefined>(undefined);
  const focusRequested = useRef(false);
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
  const startsWithHeaderProfilesOff = metadata.backend === "pyspark" || metadata.backend === "r";
  const [showInsights, setShowInsights] = useState(
    startsWithHeaderProfilesOff || profilesDisabled ? false : insightsOnOpen
  );
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
  const [cellFilterMenuTarget, setCellFilterMenuTarget] = useState<CellFilterMenuTarget>();

  useLayoutEffect(() => {
    if (!cellFilterMenuTarget) return;
    const cell = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-grid-row="${cellFilterMenuTarget.row}"][data-grid-column="${cellFilterMenuTarget.column}"]`
    );
    const menu = cell?.querySelector<HTMLElement>(".cellFilterMenuPopup");
    const action = menu?.querySelector<HTMLButtonElement>("button:not([disabled])");
    (action ?? menu)?.focus({ preventScroll: true });
  }, [cellFilterMenuTarget]);

  useEffect(() => {
    if (!cellFilterMenuTarget) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const activeCell = scrollerRef.current?.querySelector<HTMLElement>(
        `[data-grid-row="${cellFilterMenuTarget.row}"][data-grid-column="${cellFilterMenuTarget.column}"]`
      );
      if (!activeCell?.contains(target)) setCellFilterMenuTarget(undefined);
    };
    const dismiss = () => setCellFilterMenuTarget(undefined);
    const scroller = scrollerRef.current;
    document.addEventListener("pointerdown", dismissOutside, true);
    scroller?.addEventListener("scroll", dismiss, { passive: true });
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      scroller?.removeEventListener("scroll", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [cellFilterMenuTarget]);

  useLayoutEffect(() => {
    viewStateRef.current = viewState;
  }, [viewState]);

  useEffect(() => {
    visibleColumnRangeHandler.current = onVisibleColumnRangeChange;
  }, [onVisibleColumnRangeChange]);

  useLayoutEffect(() => {
    goToColumnRequestRef.current = {
      columnId: goToColumnId,
      requestId: goToColumnRequestId,
      restoreVersion: viewStateRestoreVersion,
      onHandled: onGoToColumnHandled
    };
  }, [goToColumnId, goToColumnRequestId, onGoToColumnHandled, viewStateRestoreVersion]);

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
    setCellFilterMenuTarget(undefined);
    requestedOffset.current = page.offset;
    focusRequested.current = false;
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
    logicalViewContext,
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
    preserveGridFocusAfterScroll.current = false;
    setFocusedCell({ row, column });
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
  }, [viewStateRestoreVersion, writeProgrammaticViewport]);

  useEffect(() => {
    requestedOffset.current = page.offset;
  }, [page.offset]);

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
      setFocusedCell((current) => ({ row, column: current.column }));
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
    const pendingColumnReveal = goToColumnRequestRef.current;
    const columnRevealIsPending =
      pendingColumnReveal.columnId !== undefined &&
      pendingColumnReveal.requestId !== undefined &&
      requestedGoToColumnRequest.current?.requestId === pendingColumnReveal.requestId &&
      requestedGoToColumnRequest.current.restoreVersion === pendingColumnReveal.restoreVersion &&
      (handledGoToColumnRequest.current?.requestId !== pendingColumnReveal.requestId ||
        handledGoToColumnRequest.current.restoreVersion !== pendingColumnReveal.restoreVersion);
    if (
      !columnRevealIsPending &&
      (currentViewState.viewport.firstVisibleRow !== row || currentViewState.viewport.scrollLeft !== next.scrollLeft)
    ) {
      reportViewState({
        ...currentViewState,
        viewport: { firstVisibleRow: row, scrollLeft: next.scrollLeft }
      });
    }
    requestBlockForRow(row);
  }, [setFocusedCell, setViewport, writeProgrammaticViewport]);

  const interruptColumnReveal = useCallback(() => {
    stopColumnRevealWakeSources.current();
    viewportUpdatesSuspended.current = false;
    programmaticViewportTarget.current = undefined;
    programmaticViewportRetryAvailable.current = false;
    const pending = goToColumnRequestRef.current;
    if (
      pending.columnId &&
      pending.requestId !== undefined &&
      requestedGoToColumnRequest.current?.requestId === pending.requestId &&
      requestedGoToColumnRequest.current.restoreVersion === pending.restoreVersion &&
      (handledGoToColumnRequest.current?.requestId !== pending.requestId ||
        handledGoToColumnRequest.current.restoreVersion !== pending.restoreVersion)
    ) {
      handledGoToColumnRequest.current = {
        requestId: pending.requestId,
        restoreVersion: pending.restoreVersion
      };
      pending.onHandled(pending.requestId, "interrupted");
    }
  }, []);

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

  const widths = useMemo(
    () => metadata.schema.map((column) => viewState.columnWidths[column.id] ?? defaultColumnWidth),
    [defaultColumnWidth, metadata.schema, viewState.columnWidths]
  );
  const visibleColumnRange = columnRange(widths, viewport.scrollLeft, viewport.width, rowHeaderWidth);
  const visibleColumns = useMemo(
    () => metadata.schema.slice(visibleColumnRange.start, visibleColumnRange.end),
    [metadata.schema, visibleColumnRange.end, visibleColumnRange.start]
  );
  const pageColumnPositionById = useMemo(
    () => new Map(page.columnIds.map((columnId, position) => [columnId, position])),
    [page.columnIds]
  );
  const loadedColumnSignature = page.columnIds.join("\u0000");
  const leftSpacerWidth = sum(widths.slice(0, visibleColumnRange.start));
  const rightSpacerWidth = sum(widths.slice(visibleColumnRange.end));
  const renderedColumnCount = 1 + visibleColumns.length + Number(leftSpacerWidth > 0) + Number(rightSpacerWidth > 0);
  const viewScope = `${metadata.sessionId}:${metadata.revision}:${JSON.stringify({
    logic: metadata.filterModel.logic ?? "and",
    filters: metadata.filterModel.filters,
    sort: metadata.filterModel.sort
  })}`;
  const rowScrollModel = createRowScrollModel(logicalRowExtent, viewport.height);
  const globalFirstRow = viewport.firstVisibleRow;
  const physicallyAvailableOverscanRows = Math.floor(viewport.scrollTop / gridRowHeight);
  const localStart = Math.max(
    0,
    globalFirstRow - page.offset - Math.min(overscanRows, physicallyAvailableOverscanRows)
  );
  const visibleRowCount = Math.ceil(viewport.height / gridRowHeight) + overscanRows * 2;
  const localEnd = Math.min(page.rows.length, localStart + visibleRowCount);
  const pageIsVisible = pageIntersectsViewport(page.offset, page.rows.length, globalFirstRow, viewport.height);
  const visibleRows = pageIsVisible ? page.rows.slice(localStart, localEnd) : [];
  const rovingRow = visibleRows.some((row) => row.rowNumber === focusedCell.row)
    ? focusedCell.row
    : visibleRows[0]?.rowNumber;
  const rovingColumn = visibleColumns.some((column) => column.position === focusedCell.column)
    ? focusedCell.column
    : visibleColumns[0]?.position;
  const rowSegmentSpacers = renderedRowSegmentSpacers(
    rowScrollModel,
    viewport.scrollTop,
    globalFirstRow,
    page.offset + localStart,
    visibleRows.length
  );
  const topSpacerHeight = rowSegmentSpacers.top;
  const bottomSpacerHeight = rowSegmentSpacers.bottom;

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
    onVisibleSummaryColumnsChange(showInsights && !profilesDisabled ? visibleColumns.map((column) => column.id) : []);
  }, [onVisibleSummaryColumnsChange, profilesDisabled, showInsights, viewScope, visibleColumns]);

  useEffect(() => {
    visibleColumnRangeHandler.current({ start: visibleColumnRange.start, end: visibleColumnRange.end });
  }, [busy, loadedColumnSignature, logicalViewContext, page.offset, visibleColumnRange.end, visibleColumnRange.start]);

  useEffect(
    () => () => {
      onVisibleSummaryColumnsChange([]);
    },
    [onVisibleSummaryColumnsChange]
  );

  useLayoutEffect(() => {
    if (
      !goToColumnId ||
      goToColumnRequestId === undefined ||
      (handledGoToColumnRequest.current?.requestId === goToColumnRequestId &&
        handledGoToColumnRequest.current.restoreVersion === viewStateRestoreVersion) ||
      (requestedGoToColumnRequest.current?.requestId === goToColumnRequestId &&
        requestedGoToColumnRequest.current.restoreVersion === viewStateRestoreVersion)
    ) {
      return;
    }
    const index = metadata.schema.findIndex((column) => column.id === goToColumnId);
    if (index < 0) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    requestedGoToColumnRequest.current = {
      requestId: goToColumnRequestId,
      restoreVersion: viewStateRestoreVersion
    };
    preserveGridFocusAfterScroll.current = false;
    focusRequested.current = document.hasFocus();
    const grid = scroller.closest<HTMLElement>(".dataGrid");
    const table = scroller.querySelector<HTMLElement>('table[role="grid"]');
    let wakeSourcesActive = true;
    let positionRevealed = false;
    let scheduledFrame: number | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let layoutFramesRemaining = 0;
    let forceRevealOnNextFrame = false;
    let lastRevealGeometry: string | undefined;
    const revealGeometry = (): string => `${scroller.clientWidth}:${scroller.scrollWidth}:${scroller.scrollLeft}`;
    const requestIsCurrent = (): boolean => {
      if (scrollerRef.current !== scroller) return false;
      const pending = goToColumnRequestRef.current;
      return (
        pending.columnId === goToColumnId &&
        pending.requestId === goToColumnRequestId &&
        pending.restoreVersion === viewStateRestoreVersion &&
        (handledGoToColumnRequest.current?.requestId !== goToColumnRequestId ||
          handledGoToColumnRequest.current.restoreVersion !== viewStateRestoreVersion)
      );
    };
    const reveal = (): "pending" | "revealed" | "stale" => {
      if (!requestIsCurrent()) return "stale";

      const columnStart = rowHeaderWidth + sum(widths.slice(0, index));
      const targetWidth = widths[index] ?? defaultColumnWidth;
      scroller.scrollLeft = centeredColumnScrollLeft(
        widths,
        index,
        scroller.clientWidth,
        rowHeaderWidth,
        defaultColumnWidth
      );
      const scrollLeft = scroller.scrollLeft;
      const firstVisibleRow = viewStateRef.current.viewport.firstVisibleRow;
      programmaticViewportTarget.current = {
        firstVisibleRow,
        scrollTop: scroller.scrollTop,
        scrollLeft
      };
      setViewport((current) => {
        const next = {
          firstVisibleRow,
          scrollLeft,
          scrollTop: scroller.scrollTop,
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

      const columnEnd = columnStart + targetWidth;
      const visibleStart = scrollLeft + rowHeaderWidth;
      const visibleEnd = scrollLeft + scroller.clientWidth;
      const requiredVisibleWidth = Math.min(targetWidth, Math.max(0, scroller.clientWidth - rowHeaderWidth));
      const actualVisibleWidth = Math.max(0, Math.min(columnEnd, visibleEnd) - Math.max(columnStart, visibleStart));
      const targetIsVisible =
        requiredVisibleWidth > 0 && actualVisibleWidth + scrollQuantizationTolerance >= requiredVisibleWidth;
      if (!targetIsVisible) return "pending";

      setFocusedCell((current) => (current.column === index ? current : { ...current, column: index }));
      const currentViewState = viewStateRef.current;
      const selectedColumnId = metadata.schema[index].id;
      reportViewState({
        ...currentViewState,
        selectedColumnId,
        viewport: {
          ...currentViewState.viewport,
          scrollLeft
        }
      });
      return "revealed";
    };

    function stopWakeSources(): void {
      if (!wakeSourcesActive) return;
      wakeSourcesActive = false;
      if (scheduledFrame !== undefined) {
        window.cancelAnimationFrame(scheduledFrame);
        scheduledFrame = undefined;
      }
      layoutFramesRemaining = 0;
      forceRevealOnNextFrame = false;
      resizeObserver?.disconnect();
      window.removeEventListener("focus", scheduleAttempt);
      window.removeEventListener("resize", scheduleAttempt);
      document.removeEventListener("visibilitychange", scheduleWhenVisible);
      grid?.removeEventListener("transitionend", scheduleAttempt);
      grid?.removeEventListener("animationend", scheduleAttempt);
      if (scheduleColumnRevealAttempt.current === scheduleAttempt) {
        scheduleColumnRevealAttempt.current = ignoreColumnRevealSignal;
      }
      if (stopColumnRevealWakeSources.current === stopWakeSources) {
        stopColumnRevealWakeSources.current = ignoreColumnRevealSignal;
      }
    }

    function runScheduledAttempt(): void {
      scheduledFrame = undefined;
      if (!wakeSourcesActive) return;
      if (!requestIsCurrent()) {
        stopWakeSources();
        return;
      }
      const geometry = revealGeometry();
      const shouldReveal = forceRevealOnNextFrame || geometry !== lastRevealGeometry;
      forceRevealOnNextFrame = false;
      const outcome = shouldReveal ? reveal() : "pending";
      lastRevealGeometry = revealGeometry();
      if (outcome !== "pending") {
        positionRevealed = outcome === "revealed";
        stopWakeSources();
        return;
      }
      layoutFramesRemaining = Math.max(0, layoutFramesRemaining - 1);
      if (layoutFramesRemaining > 0) {
        scheduledFrame = window.requestAnimationFrame(runScheduledAttempt);
      }
    }

    function scheduleAttempt(): void {
      // Concrete layout, projection, or visibility signals force one attempt
      // and, after a dormant exhaustion, start a fresh bounded geometry watch.
      if (!wakeSourcesActive) return;
      forceRevealOnNextFrame = true;
      if (layoutFramesRemaining === 0) layoutFramesRemaining = maximumColumnRevealLayoutFrames;
      if (scheduledFrame !== undefined) return;
      scheduledFrame = window.requestAnimationFrame(runScheduledAttempt);
    }

    function monitorPostLayoutGeometry(): void {
      if (!wakeSourcesActive || scheduledFrame !== undefined || layoutFramesRemaining === 0) return;
      scheduledFrame = window.requestAnimationFrame(runScheduledAttempt);
    }

    function scheduleWhenVisible(): void {
      if (document.visibilityState === "visible") scheduleAttempt();
    }

    scheduleColumnRevealAttempt.current = scheduleAttempt;
    stopColumnRevealWakeSources.current = stopWakeSources;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(scheduleAttempt);
      resizeObserver.observe(scroller);
      if (grid) resizeObserver.observe(grid);
      if (table) resizeObserver.observe(table);
    }
    window.addEventListener("focus", scheduleAttempt);
    window.addEventListener("resize", scheduleAttempt);
    document.addEventListener("visibilitychange", scheduleWhenVisible);
    grid?.addEventListener("transitionend", scheduleAttempt);
    grid?.addEventListener("animationend", scheduleAttempt);
    const initialOutcome = reveal();
    lastRevealGeometry = revealGeometry();
    if (initialOutcome !== "pending") {
      positionRevealed = initialOutcome === "revealed";
      stopWakeSources();
    } else {
      layoutFramesRemaining = maximumColumnRevealLayoutFrames;
      monitorPostLayoutGeometry();
    }

    return () => {
      stopWakeSources();
      if (
        !positionRevealed &&
        requestedGoToColumnRequest.current?.requestId === goToColumnRequestId &&
        requestedGoToColumnRequest.current.restoreVersion === viewStateRestoreVersion &&
        (handledGoToColumnRequest.current?.requestId !== goToColumnRequestId ||
          handledGoToColumnRequest.current.restoreVersion !== viewStateRestoreVersion)
      ) {
        requestedGoToColumnRequest.current = undefined;
      }
    };
  }, [
    defaultColumnWidth,
    goToColumnId,
    goToColumnRequestId,
    metadata.schema,
    reportViewState,
    rowHeaderWidth,
    viewStateRestoreVersion,
    widths
  ]);

  useLayoutEffect(() => {
    scheduleColumnRevealAttempt.current();
  }, [busy, loadedColumnSignature, logicalViewContext, page.offset, projecting]);

  useLayoutEffect(() => {
    if (!goToColumnId || goToColumnRequestId === undefined) return;
    if (
      requestedGoToColumnRequest.current?.requestId !== goToColumnRequestId ||
      requestedGoToColumnRequest.current.restoreVersion !== viewStateRestoreVersion ||
      (handledGoToColumnRequest.current?.requestId === goToColumnRequestId &&
        handledGoToColumnRequest.current.restoreVersion === viewStateRestoreVersion)
    ) {
      return;
    }
    const index = metadata.schema.findIndex((column) => column.id === goToColumnId);
    if (index < 0 || !pageColumnPositionById.has(goToColumnId)) return;
    if (index < visibleColumnRange.start || index >= visibleColumnRange.end) return;
    const scroller = scrollerRef.current;
    const target = scroller?.querySelector<HTMLElement>(`th[data-grid-column="${index}"]`);
    if (!scroller || !target) return;

    const targetWidth = widths[index] ?? defaultColumnWidth;
    const columnStart = rowHeaderWidth + sum(widths.slice(0, index));
    const columnEnd = columnStart + targetWidth;
    const visibleStart = scroller.scrollLeft + rowHeaderWidth;
    const visibleEnd = scroller.scrollLeft + scroller.clientWidth;
    const requiredVisibleWidth = Math.min(targetWidth, Math.max(0, scroller.clientWidth - rowHeaderWidth));
    const actualVisibleWidth = Math.max(0, Math.min(columnEnd, visibleEnd) - Math.max(columnStart, visibleStart));
    if (requiredVisibleWidth <= 0 || actualVisibleWidth + scrollQuantizationTolerance < requiredVisibleWidth) return;

    handledGoToColumnRequest.current = {
      requestId: goToColumnRequestId,
      restoreVersion: viewStateRestoreVersion
    };
    onGoToColumnHandled(goToColumnRequestId, "revealed");
  }, [
    goToColumnId,
    goToColumnRequestId,
    loadedColumnSignature,
    metadata.schema,
    onGoToColumnHandled,
    pageColumnPositionById,
    defaultColumnWidth,
    rowHeaderWidth,
    viewStateRestoreVersion,
    viewport.scrollLeft,
    viewport.width,
    visibleColumnRange.end,
    visibleColumnRange.start,
    widths
  ]);

  useEffect(() => {
    if (!focusRequested.current) return;
    if (!document.hasFocus()) {
      focusRequested.current = false;
      return;
    }
    const selector = `[data-grid-row="${focusedCell.row}"][data-grid-column="${focusedCell.column}"]`;
    const target = scrollerRef.current?.querySelector<HTMLElement>(selector);
    if (!target) return;
    focusRequested.current = false;
    target.focus({ preventScroll: true });
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
          style={{ width: rowHeaderWidth + sum(widths), minWidth: rowHeaderWidth + sum(widths) }}
          aria-busy={busy || projecting}
          aria-label={`Data grid for ${metadata.source.label}`}
          aria-rowcount={page.totalRows === null ? -1 : page.totalRows + 1}
          aria-colcount={metadata.schema.length + 1}
        >
          <colgroup>
            <col style={{ width: rowHeaderWidth }} />
            {leftSpacerWidth > 0 && <col style={{ width: leftSpacerWidth }} />}
            {visibleColumns.map((column) => (
              <col key={column.id} style={{ width: widths[column.position] }} />
            ))}
            {rightSpacerWidth > 0 && <col style={{ width: rightSpacerWidth }} />}
          </colgroup>
          <thead>
            <tr>
              <th
                className={`rowHeader${hasRowLabels ? " labeledRowHeader" : ""}`}
                aria-label={hasRowLabels ? "Row label" : "Row number"}
                style={{ width: rowHeaderWidth, maxWidth: rowHeaderWidth }}
              >
                {hasRowLabels ? "Row" : "#"}
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
                    added={diffPresentation?.addedColumnIds.has(column.id) ?? false}
                    showInsights={showInsights}
                    summary={summaryByColumnId.get(column.id)}
                    profileValueMode={profileValueMode}
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
                    onSelect={() => reportViewState({ ...viewStateRef.current, selectedColumnId: column.id })}
                    onApplyProfileFilter={onApplyProfileFilter}
                    onResize={(width) =>
                      reportViewState({
                        ...viewStateRef.current,
                        columnWidths: { ...viewStateRef.current.columnWidths, [column.id]: width }
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
                      : `Row ${row.rowNumber + 1}, label ${row.rowLabel}`
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
                  const closeCellMenu = (restoreFocus = false) => {
                    setCellFilterMenuTarget(undefined);
                    if (restoreFocus) {
                      scrollerRef.current
                        ?.querySelector<HTMLElement>(
                          `[data-grid-row="${row.rowNumber}"][data-grid-column="${column.position}"]`
                        )
                        ?.focus({ preventScroll: true });
                    }
                  };
                  const openCellMenu = () => {
                    reportViewState({ ...viewStateRef.current, selectedColumnId: column.id });
                    setFocusedCell({ row: row.rowNumber, column: column.position });
                    setCellFilterMenuTarget({ row: row.rowNumber, column: column.position, columnId: column.id });
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
                      aria-selected={viewState.selectedColumnId === column.id}
                      aria-label={accessibleLabel ?? renderedCell ?? ""}
                      data-diff-state={cellDiff ? "changed" : addedColumn ? "added" : undefined}
                      tabIndex={rovingRow === row.rowNumber && rovingColumn === column.position ? 0 : -1}
                      className={[
                        "gridCell",
                        cell?.isNull || cell?.isNaN ? "missingCell" : "",
                        viewState.selectedColumnId === column.id ? "selectedColumn" : "",
                        cellDiff ? "diffChangedCell" : "",
                        addedColumn ? "diffAddedColumn" : "",
                        cellMenuOpen ? "cellFilterMenuOpen" : ""
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      title={accessibleLabel ?? displayCell.title ?? renderedCell}
                      onFocus={() => {
                        focusRequested.current = false;
                        setFocusedCell({ row: row.rowNumber, column: column.position });
                        reportViewState({ ...viewStateRef.current, selectedColumnId: column.id });
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        openCellMenu();
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.target === event.currentTarget &&
                          (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
                        ) {
                          event.preventDefault();
                          openCellMenu();
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
                          aria-label={`Filter ${column.name} by this cell`}
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
        <div className="gridProfileControls">
          {!profilesDisabled && onProfileValueModeChange && (
            <ProfileValueToggle
              mode={profileValueMode}
              onChange={onProfileValueModeChange}
              ariaLabel="Header profile values"
              countAriaLabel="Show header profile counts"
              percentAriaLabel="Show header profile percentages"
              compact
            />
          )}
          <button
            type="button"
            className="headerProfilesButton"
            aria-pressed={showInsights}
            disabled={profilesDisabled}
            title={
              profilesDisabled
                ? profilesDisabledReason
                : metadata.backend === "pyspark"
                  ? "Runs Spark profiling queries for the visible columns."
                  : metadata.backend === "r"
                    ? "Runs R profiling queries for the visible columns."
                    : undefined
            }
            onClick={() => {
              if (!profilesDisabled) setShowInsights((current) => !current);
            }}
          >
            {profilesDisabled ? "Profiles unavailable" : "Header profiles"}
          </button>
        </div>
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

function terminalPageOverlapsViewport(
  pageOffset: number,
  pageRowCount: number,
  totalRows: number,
  firstVisibleRow: number,
  viewportHeight: number
): boolean {
  return (
    pageOffset + pageRowCount === totalRows &&
    firstVisibleRow < pageOffset &&
    pageIntersectsViewport(pageOffset, pageRowCount, firstVisibleRow, viewportHeight)
  );
}

function pageIntersectsViewport(
  pageOffset: number,
  pageRowCount: number,
  firstVisibleRow: number,
  viewportHeight: number
): boolean {
  const visibleRowCount = Math.max(1, Math.ceil(viewportHeight / gridRowHeight));
  return (
    pageRowCount > 0 && pageOffset < firstVisibleRow + visibleRowCount && pageOffset + pageRowCount > firstVisibleRow
  );
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
  added,
  showInsights,
  summary,
  profileValueMode,
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
  onApplyProfileFilter,
  onResize
}: {
  column: ColumnSchema;
  ariaColumnIndex: number;
  width: number;
  selected: boolean;
  added: boolean;
  showInsights: boolean;
  summary: ColumnSummary | undefined;
  profileValueMode: ProfileValueMode;
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
  onApplyProfileFilter?: (filter: ColumnFilter) => void;
  onResize(width: number): void;
}) {
  const menuRef = useRef<HTMLDetailsElement>(null);
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
  const distributionFilterAvailable =
    !filterUnavailable && !comparisonUnavailable && onApplyProfileFilter !== undefined;
  const applyProfileFilter = (filter: ColumnFilter) => {
    if (!distributionFilterAvailable || !onApplyProfileFilter) return;
    onSelect();
    onApplyProfileFilter(filter);
  };
  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (viewControlsDisabled) return;
    event.preventDefault();
    const start = event.clientX;
    const move = (moveEvent: PointerEvent) => onResize(Math.max(80, Math.min(640, width + moveEvent.clientX - start)));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
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
      aria-selected={selected}
      aria-sort={
        activeSortIndex === 0
          ? activeSort?.direction === "asc"
            ? "ascending"
            : activeSort?.direction === "desc"
              ? "descending"
              : undefined
          : undefined
      }
      aria-label={[column.name, added ? "added column" : "", activeSortLabel ? `sorted ${activeSortLabel}` : ""]
        .filter(Boolean)
        .join(", ")}
      data-diff-state={added ? "added" : undefined}
      className={[selected ? "selectedColumn" : "", added ? "diffAddedColumn" : ""].filter(Boolean).join(" ")}
      title={`${column.rawType}${column.nullable ? " nullable" : ""}${added ? ", added column" : ""}`}
      tabIndex={0}
      onClick={(event) => {
        if (columnHeaderControlTarget(event.target, event.currentTarget)) return;
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
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
            <details ref={menuRef} className="columnMenu">
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
      {showInsights &&
        (summary ? (
          <div className="columnInsight">
            <div className="exactSummaryStats">
              <HeaderProfileValue
                label="Missing"
                value={summary.nullCount + summary.nanCount}
                denominator={summary.totalCount}
                mode={profileValueMode}
              />
              <HeaderProfileValue
                label="Distinct"
                value={summary.distinctCount}
                denominator={summary.totalCount}
                mode={profileValueMode}
              />
              {summary.numeric && <CompactExtremum label="Min" summary={summary.numeric} bound="min" />}
              {summary.numeric && <CompactExtremum label="Max" summary={summary.numeric} bound="max" />}
            </div>
            <div className="summaryDistribution">
              {summary.visualization?.sampled && <span className="sampledLabel">Distribution sampled</span>}
              <MiniChart
                visualization={summary.visualization}
                column={column}
                valueMode={profileValueMode}
                denominator={profileDistributionDenominator(summary)}
                onApplyFilter={distributionFilterAvailable ? applyProfileFilter : undefined}
              />
            </div>
          </div>
        ) : (
          <span className="columnInsight emptyInsight">Profiling…</span>
        ))}
    </th>
  );
}

function HeaderProfileValue({
  label,
  value,
  denominator,
  mode
}: {
  label: string;
  value: number | undefined;
  denominator: number;
  mode: ProfileValueMode;
}) {
  if (value === undefined) {
    return (
      <span title={`${label} is unavailable`} aria-label={`${label} is unavailable`}>
        {label} n/a
      </span>
    );
  }
  const description = describeProfileValue(label, value, denominator);
  return (
    <span title={description} aria-label={description}>
      {label} {formatProfileValue(value, denominator, mode)}
    </span>
  );
}

function columnHeaderControlTarget(target: EventTarget, header: HTMLTableCellElement): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest("button, details, summary, a, input, select, textarea, [role='button']");
  return control !== null && control !== header;
}

function CompactExtremum({
  label,
  summary,
  bound
}: {
  label: "Min" | "Max";
  summary: NonNullable<ColumnSummary["numeric"]>;
  bound: "min" | "max";
}) {
  const value = numericExtremumDisplay(summary, bound);
  if (!value) return null;
  const accessibleLabel = `${label === "Min" ? "Minimum" : "Maximum"} ${value.display}`;
  return (
    <span
      className={value.exact ? "exactNumericExtremum" : undefined}
      title={accessibleLabel}
      aria-label={accessibleLabel}
    >
      {label} {value.display}
    </span>
  );
}

function MiniChart({
  visualization,
  column,
  valueMode,
  denominator,
  onApplyFilter
}: {
  visualization: ColumnVisualization | undefined;
  column: ColumnSchema;
  valueMode: ProfileValueMode;
  denominator: number;
  onApplyFilter?: (filter: ColumnFilter) => void;
}) {
  if (!visualization) return <span className="miniChart emptyInsight">No chart</span>;
  if (visualization.kind === "numeric") {
    return (
      <NumericHistogram
        visualization={visualization}
        compact
        valueMode={valueMode}
        percentDenominator={denominator}
        onSelectBin={
          onApplyFilter
            ? (bin, index) => onApplyFilter(viewNumericBinFilter(column, bin, index === visualization.bins.length - 1))
            : undefined
        }
      />
    );
  }
  if (visualization.kind === "boolean") {
    const total = Math.max(1, visualization.trueCount + visualization.falseCount);
    const trueDescription = describeProfileValue("True", visualization.trueCount, denominator);
    const falseDescription = describeProfileValue("False", visualization.falseCount, denominator);
    return (
      <span
        className="booleanMiniChart"
        role="img"
        aria-label={`${visualization.sampled ? "Sampled " : ""}boolean distribution: ${trueDescription}, ${falseDescription}.`}
      >
        <span className="miniChartLegend">
          <span title={trueDescription}>
            True {formatProfileValue(visualization.trueCount, denominator, valueMode)}
          </span>
          <span title={falseDescription}>
            False {formatProfileValue(visualization.falseCount, denominator, valueMode)}
          </span>
        </span>
        <span className="stackedMiniChart" aria-hidden="true">
          <i style={{ width: `${(visualization.trueCount / total) * 100}%` }} />
          <b style={{ width: `${(visualization.falseCount / total) * 100}%` }} />
        </span>
      </span>
    );
  }
  if (visualization.kind === "categorical") {
    const max = Math.max(1, ...visualization.categories.map((category) => category.count), visualization.otherCount);
    const visibleCategories = visualization.categories.slice(0, 3);
    const categoryLabel = [
      ...visibleCategories.map((category) => describeProfileValue(category.value, category.count, denominator)),
      ...(visualization.otherCount > 0 ? [describeProfileValue("Other", visualization.otherCount, denominator)] : [])
    ].join(", ");
    return (
      <span
        className={`categoryMiniChart${onApplyFilter ? " interactive" : ""}`}
        role={onApplyFilter ? "group" : "img"}
        aria-label={`${visualization.sampled ? "Sampled " : ""}categorical distribution${categoryLabel ? `: ${categoryLabel}` : " with no values"}.`}
      >
        {visibleCategories.map((category, index) => {
          const description = describeProfileValue(category.value || "Empty string", category.count, denominator);
          const contents = (
            <>
              <span className="categoryMiniLabel" title={category.value}>
                {category.value}
              </span>
              <i aria-hidden="true" style={{ width: `${(category.count / max) * 100}%` }} />
              <small title={description}>{formatProfileValue(category.count, denominator, valueMode)}</small>
            </>
          );
          return onApplyFilter ? (
            <button
              type="button"
              className="categoryMiniRow interactive"
              key={`${category.value}-${index}`}
              aria-label={`Filter ${column.name} to ${category.value || "empty string"}; ${description}`}
              onClick={() => onApplyFilter(viewValueSelectionFilter(column, category.selectionValue ?? category.value))}
            >
              {contents}
            </button>
          ) : (
            <span className="categoryMiniRow" key={`${category.value}-${index}`}>
              {contents}
            </span>
          );
        })}
        {visualization.otherCount > 0 && (
          <span className="categoryMiniRow">
            <span className="categoryMiniLabel">Other</span>
            <i aria-hidden="true" style={{ width: `${(visualization.otherCount / max) * 100}%` }} />
            <small title={describeProfileValue("Other", visualization.otherCount, denominator)}>
              {formatProfileValue(visualization.otherCount, denominator, valueMode)}
            </small>
          </span>
        )}
      </span>
    );
  }
  const min = visualization.min ?? "n/a";
  const max = visualization.max ?? "n/a";
  return (
    <span
      className="datetimeMiniChart"
      role="img"
      aria-label={`${visualization.sampled ? "Sampled " : ""}datetime distribution: minimum ${min}, maximum ${max}.`}
    >
      <span title={`Minimum ${min}`}>
        <b>Min</b> {min}
      </span>
      <span title={`Maximum ${max}`}>
        <b>Max</b> {max}
      </span>
    </span>
  );
}

function columnRange(
  widths: number[],
  scrollLeft: number,
  viewportWidth: number,
  rowHeaderWidth: number
): { start: number; end: number } {
  let position = 0;
  let start = 0;
  while (start < widths.length && position + widths[start] < Math.max(0, scrollLeft - rowHeaderWidth)) {
    position += widths[start];
    start += 1;
  }
  let end = start;
  let visibleWidth = position;
  while (end < widths.length && visibleWidth < scrollLeft + viewportWidth) {
    visibleWidth += widths[end];
    end += 1;
  }
  return {
    start: Math.max(0, start - overscanColumns),
    end: Math.min(widths.length, end + overscanColumns)
  };
}

function rowHeaderWidthForRows(rows: readonly { readonly rowLabel?: string }[]): number {
  const longestLabel = rows.reduce(
    (longest, row) => Math.max(longest, row.rowLabel === undefined ? 0 : Array.from(row.rowLabel).length),
    0
  );
  if (longestLabel === 0) return numericRowHeaderWidth;
  return Math.min(
    maximumLabeledRowHeaderWidth,
    Math.max(numericRowHeaderWidth, longestLabel * rowLabelCharacterWidth + rowLabelHorizontalPadding)
  );
}

function centeredColumnScrollLeft(
  widths: readonly number[],
  column: number,
  viewportWidth: number,
  rowHeaderWidth: number,
  defaultColumnWidth: number
): number {
  const columnStart = rowHeaderWidth + sum(widths.slice(0, column));
  const targetWidth = widths[column] ?? defaultColumnWidth;
  const centeredOffset = Math.max(rowHeaderWidth, (viewportWidth - targetWidth) / 2);
  return Math.max(0, columnStart - centeredOffset);
}

function selectedColumnPosition(schema: ColumnSchema[], selectedColumnId: string | undefined): number {
  if (!schema.length) return 0;
  const selected = selectedColumnId ? schema.findIndex((column) => column.id === selectedColumnId) : -1;
  return selected >= 0 ? selected : 0;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
